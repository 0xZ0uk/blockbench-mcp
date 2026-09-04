/**
 * Contract suite entry — one command runs the whole table green.
 *
 * Exercises only external tool-contract behavior:
 *  (1) schemas offered to clients (args vs. inputSchema), and
 *  (2) handler results returned over the bridge (ContentBlocks clients see),
 * with the bridge stubbed — never helper or serializer internals, never a
 * live Blockbench.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tools } from "../../dist/tools.js";
import { contractCases } from "./cases.mjs";
import { runContractCases, formatSummary } from "./runner.mjs";

test("contract table: good payloads pass, bad payloads name the field", () => {
  const summary = runContractCases(tools, contractCases);
  assert.equal(
    summary.issue_count,
    0,
    `contract issues:\n${formatSummary(summary)}`
  );
  assert.equal(summary.case_count, contractCases.length);
  assert.equal(summary.pass_count, contractCases.length);
});

test("catalogue invariants: every tool offers an object schema", () => {
  for (const tool of tools) {
    assert.equal(typeof tool.name, "string", "tool.name must be a string");
    assert.equal(typeof tool.description, "string", `${tool.name}: description must be a string`);
    assert.equal(
      typeof tool.inputSchema,
      "object",
      `${tool.name}: inputSchema must be an object`
    );
    assert.equal(
      tool.inputSchema?.type,
      "object",
      `${tool.name}: inputSchema.type must be "object"`
    );
    assert.equal(typeof tool.handler, "function", `${tool.name}: handler must be a function`);
  }
});

test("handler result: forward tools return the bridge JSON as text", async () => {
  const addCube = tools.find((t) => t.name === "add_cube");
  assert.ok(addCube, "add_cube must exist");
  const bridgeCube = { uuid: "cube-1", name: "slide", from: [-12, 0, 0], to: [12, 4, 4] };
  await withFakeBridge({ add_cube: { result: bridgeCube } }, async () => {
    const blocks = await addCube.handler({ from: [-12, 0, 0], to: [12, 4, 4] });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "text");
    assert.deepEqual(JSON.parse(blocks[0].text), bridgeCube);
  });
});

test("handler result: check_model keeps its grouped per-issue list shape", async () => {
  const checkModel = tools.find((t) => t.name === "check_model");
  assert.ok(checkModel, "check_model must exist");
  const bridgeAudit = {
    cubes: 2,
    groups: 1,
    textures: 0,
    issue_count: 1,
    by_type: { coplanar_overlap: 1 },
    issues: [
      { issue: "coplanar_overlap", cubes: ["a", "b"], axis: "y", plane: 4, hint: "nudge one cube by >=0.1" },
    ],
  };
  await withFakeBridge({ check_model: { result: bridgeAudit } }, async () => {
    const blocks = await checkModel.handler({});
    assert.equal(blocks[0].type, "text");
    const parsed = JSON.parse(blocks[0].text);
    assert.equal(parsed.issue_count, 1);
    assert.deepEqual(parsed.by_type, { coplanar_overlap: 1 });
    assert.ok(Array.isArray(parsed.issues));
    assert.equal(parsed.issues[0].issue, "coplanar_overlap");
  });
});

test("handler result: bridge errors surface with the offending field named", async () => {
  const addGroups = tools.find((t) => t.name === "add_groups");
  assert.ok(addGroups, "add_groups must exist");
  await withFakeBridge({ add_groups: { error: 'Field "groups" (array) is required.' } }, async () => {
    await assert.rejects(() => addGroups.handler({}), /groups/);
  });
});

test("handler result: edit_elements keeps per-item ok/error (partial failure safe)", async () => {
  const editElements = tools.find((t) => t.name === "edit_elements");
  assert.ok(editElements, "edit_elements must exist");
  const bridgeResult = {
    edited: 1,
    failed: 1,
    results: [
      { element: "slide", ok: true, result: { uuid: "cube-1", name: "slide" } },
      { element: "missing-part", ok: false, error: "Element not found: missing-part" },
    ],
  };
  await withFakeBridge({ edit_elements: { result: bridgeResult } }, async () => {
    const blocks = await editElements.handler({
      edits: [
        { element: "slide", patch: { to: [24, 4, 4] } },
        { element: "missing-part", patch: { rotation: [0, 0, 0] } },
      ],
    });
    assert.equal(blocks[0].type, "text");
    const parsed = JSON.parse(blocks[0].text);
    assert.equal(parsed.edited, 1);
    assert.equal(parsed.failed, 1);
    assert.ok(Array.isArray(parsed.results));
    assert.equal(parsed.results.length, 2);
    assert.equal(parsed.results[0].ok, true);
    assert.equal(parsed.results[1].ok, false);
    assert.match(parsed.results[1].error, /missing-part/);
  });
});

test("handler result: delete_elements keeps per-item ok/error (partial failure safe)", async () => {
  const deleteElements = tools.find((t) => t.name === "delete_elements");
  assert.ok(deleteElements, "delete_elements must exist");
  const bridgeResult = {
    deleted: 1,
    failed: 1,
    results: [
      { element: "slide", ok: true, deleted: true },
      { element: "nope", ok: false, error: "Element not found: nope" },
    ],
  };
  await withFakeBridge({ delete_elements: { result: bridgeResult } }, async () => {
    const blocks = await deleteElements.handler({ elements: ["slide", "nope"] });
    assert.equal(blocks[0].type, "text");
    const parsed = JSON.parse(blocks[0].text);
    assert.equal(parsed.deleted, 1);
    assert.equal(parsed.failed, 1);
    assert.equal(parsed.results[0].ok, true);
    assert.equal(parsed.results[1].ok, false);
  });
});

test("handler result: measure keeps named-axes dims for element, group, and model", async () => {
  const measure = tools.find((t) => t.name === "measure");
  assert.ok(measure, "measure must exist");
  const elementBox = {
    mode: "element", units: "model", element: { name: "slide", uuid: "cube-1" }, cube_count: 1,
    min: { x: -12, y: 0, z: 0 }, max: { x: 12, y: 4, z: 4 },
    size: { x: 24, y: 4, z: 4 }, center: { x: 0, y: 2, z: 2 },
  };
  const groupBox = {
    mode: "group", units: "model", group: { name: "slide", uuid: "group-1" },
    cube_count: 2, cubes: [{ name: "slide-a", uuid: "cube-a" }, { name: "slide-b", uuid: "cube-b" }],
    min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 2, z: 8 },
    size: { x: 4, y: 2, z: 8 }, center: { x: 2, y: 1, z: 4 },
  };
  const modelBox = {
    mode: "model", units: "model", cube_count: 2, group_count: 1,
    min: { x: -12, y: 0, z: 0 }, max: { x: 12, y: 4, z: 8 },
    size: { x: 24, y: 4, z: 8 }, center: { x: 0, y: 2, z: 4 },
  };
  await withFakeBridge({ measure: { result: elementBox } }, async () => {
    const blocks = await measure.handler({ mode: "element", element: "slide" });
    const parsed = JSON.parse(blocks[0].text);
    assert.equal(parsed.units, "model");
    assert.deepEqual(parsed.size, { x: 24, y: 4, z: 4 });
    assert.deepEqual(Object.keys(parsed.min).sort(), ["x", "y", "z"]);
  });
  await withFakeBridge({ measure: { result: groupBox } }, async () => {
    const blocks = await measure.handler({ mode: "group", group: "slide" });
    const parsed = JSON.parse(blocks[0].text);
    assert.equal(parsed.cube_count, 2);
    assert.deepEqual(parsed.size, { x: 4, y: 2, z: 8 });
    assert.deepEqual(parsed.cubes, [{ name: "slide-a", uuid: "cube-a" }, { name: "slide-b", uuid: "cube-b" }]);
  });
  await withFakeBridge({ measure: { result: modelBox } }, async () => {
    const blocks = await measure.handler({ mode: "model" });
    const parsed = JSON.parse(blocks[0].text);
    assert.equal(parsed.cube_count, 2);
    assert.deepEqual(parsed.size, { x: 24, y: 4, z: 8 });
  });
});

test("handler result: measure distance returns a number with named axes", async () => {
  const measure = tools.find((t) => t.name === "measure");
  assert.ok(measure, "measure must exist");
  const bridgeDistance = {
    mode: "distance", units: "model",
    a: { name: "slide-a", uuid: "cube-a", kind: "element" },
    b: { name: "slide-b", uuid: "cube-b", kind: "element" },
    a_box: { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 2, z: 4 } },
    b_box: { min: { x: 6, y: 0, z: 0 }, max: { x: 10, y: 2, z: 4 } },
    gap: { x: 2, y: 0, z: 0 }, delta: { x: 6, y: 0, z: 0 },
    distance: 2, overlapping: false,
  };
  await withFakeBridge({ measure: { result: bridgeDistance } }, async () => {
    const blocks = await measure.handler({ mode: "distance", a: "slide-a", b: "slide-b" });
    assert.equal(blocks[0].type, "text");
    const parsed = JSON.parse(blocks[0].text);
    assert.equal(parsed.mode, "distance");
    assert.equal(parsed.units, "model");
    assert.equal(parsed.distance, 2);
    assert.deepEqual(parsed.gap, { x: 2, y: 0, z: 0 });
    assert.deepEqual(Object.keys(parsed.gap).sort(), ["x", "y", "z"]);
    assert.deepEqual(Object.keys(parsed.delta).sort(), ["x", "y", "z"]);
    assert.equal(parsed.overlapping, false);
  });
});

test("handler result: measure clearance hit echoes epsilon with overlap extent", async () => {
  const measure = tools.find((t) => t.name === "measure");
  assert.ok(measure, "measure must exist");
  const bridgeHit = {
    mode: "clearance", units: "model",
    coplanar_epsilon: 0.02, overlap_min: 0.1,
    scanned_cubes: 2, overlap_count: 1,
    overlaps: [
      {
        cubes: ["slide-a", "slide-b"], axis: "y", plane: 4, gap: 0,
        overlap: { x: 4, z: 4 },
        hint: "faces coplanar -> z-fight; offset one cube by >=0.1 on this axis",
      },
    ],
  };
  await withFakeBridge({ measure: { result: bridgeHit } }, async () => {
    const blocks = await measure.handler({ mode: "clearance" });
    const parsed = JSON.parse(blocks[0].text);
    assert.equal(parsed.overlap_count, 1);
    assert.equal(parsed.coplanar_epsilon, 0.02);
    assert.equal(parsed.overlap_min, 0.1);
    assert.ok(Array.isArray(parsed.overlaps));
    assert.deepEqual(parsed.overlaps[0].cubes, ["slide-a", "slide-b"]);
    assert.equal(parsed.overlaps[0].axis, "y");
    assert.ok(typeof parsed.overlaps[0].overlap === "object");
  });
});

test("handler result: measure clearance clean reports zero overlaps", async () => {
  const measure = tools.find((t) => t.name === "measure");
  assert.ok(measure, "measure must exist");
  const bridgeClean = {
    mode: "clearance", units: "model",
    coplanar_epsilon: 0.02, overlap_min: 0.1,
    scanned_cubes: 2, overlap_count: 0, overlaps: [],
  };
  await withFakeBridge({ measure: { result: bridgeClean } }, async () => {
    const blocks = await measure.handler({ mode: "clearance" });
    const parsed = JSON.parse(blocks[0].text);
    assert.equal(parsed.overlap_count, 0);
    assert.deepEqual(parsed.overlaps, []);
    assert.equal(parsed.coplanar_epsilon, 0.02);
  });
});

test("handler result: measure distance/clearance bridge errors name the field", async () => {
  const measure = tools.find((t) => t.name === "measure");
  assert.ok(measure, "measure must exist");
  await withFakeBridge({ measure: { error: 'Field "a" (name|uuid) is required for mode "distance".' } }, async () => {
    await assert.rejects(() => measure.handler({ mode: "distance", b: "slide-b" }), /a/);
  });
  await withFakeBridge({ measure: { error: 'Field "b" not found: nope' } }, async () => {
    await assert.rejects(() => measure.handler({ mode: "distance", a: "slide-a", b: "nope" }), /nope/);
  });
});

test("handler result: measure bridge errors name the offending field", async () => {
  const measure = tools.find((t) => t.name === "measure");
  assert.ok(measure, "measure must exist");
  await withFakeBridge({ measure: { error: 'Field "element" (name|uuid) is required for mode "element".' } }, async () => {
    await assert.rejects(() => measure.handler({ mode: "element" }), /element/);
  });
});

test("handler result: scope+elements forward to the bridge unchanged", async () => {
  const packUv = tools.find((t) => t.name === "pack_uv");
  assert.ok(packUv, "pack_uv must exist");
  await withFakeBridge({}, async () => {
    const blocks = await packUv.handler({ scope: "selected", elements: ["slide-a", "slide-b"] });
    assert.equal(blocks[0].type, "text");
    assert.deepEqual(JSON.parse(blocks[0].text), {
      echo: { scope: "selected", elements: ["slide-a", "slide-b"] },
    });
  });
});

test("handler result: screenshot_views keeps blueprint metadata and restore flag", async () => {
  const shot = tools.find((t) => t.name === "screenshot_views");
  assert.ok(shot, "screenshot_views must exist");
  const bridgeResult = {
    count: 2,
    projection_restored: true,
    shots: [
      { view: "front", base64: "AAA", ortho: true, px_per_unit: 8, wireframe: false, projection_restored: true },
      { view: "top", base64: "BBB", ortho: true, px_per_unit: 8, wireframe: true, projection_restored: true },
    ],
  };
  await withFakeBridge({ screenshot_views: { result: bridgeResult } }, async () => {
    const blocks = await shot.handler({ views: ["front", "top"], ortho: true, px_per_unit: 8 });
    assert.equal(blocks[0].type, "text");
    assert.match(blocks[0].text, /Captured 2 view\(s\): front, top/);
    assert.match(blocks[0].text, /projection restored/);
    const viewLines = blocks.filter((b) => b.type === "text" && b.text.startsWith("View:")).map((b) => b.text);
    assert.deepEqual(viewLines, ["View: front (ortho, 8 px/unit)", "View: top (ortho, 8 px/unit, wireframe)"]);
    const images = blocks.filter((b) => b.type === "image");
    assert.equal(images.length, 2);
    assert.deepEqual(images.map((b) => b.data), ["AAA", "BBB"]);
  });
});

test("handler result: screenshot_views warns when projection was not restored", async () => {
  const shot = tools.find((t) => t.name === "screenshot_views");
  assert.ok(shot, "screenshot_views must exist");
  const bridgeResult = {
    count: 1,
    projection_restored: false,
    shots: [
      { view: "front", base64: "AAA", ortho: true, px_per_unit: 8, wireframe: false, projection_restored: false },
    ],
  };
  await withFakeBridge({ screenshot_views: { result: bridgeResult } }, async () => {
    const blocks = await shot.handler({ views: ["front"], ortho: true, px_per_unit: 8 });
    assert.match(blocks[0].text, /WARNING: projection NOT restored/);
    assert.deepEqual(
      blocks.filter((b) => b.type === "text" && b.text.startsWith("View:")).map((b) => b.text),
      ["View: front (ortho, 8 px/unit)"]
    );
  });
});

test("handler result: screenshot_views keeps legacy text for plain shots", async () => {
  const shot = tools.find((t) => t.name === "screenshot_views");
  assert.ok(shot, "screenshot_views must exist");
  // Older plugin builds omit blueprint fields; legacy lines stay flag-free.
  const bridgeResult = {
    count: 2,
    shots: [
      { view: "front", base64: "AAA" },
      { view: "custom", base64: "BBB" },
    ],
  };
  await withFakeBridge({ screenshot_views: { result: bridgeResult } }, async () => {
    const blocks = await shot.handler({ views: ["front"] });
    assert.match(blocks[0].text, /Captured 2 view\(s\): front, custom \(projection restored\)/);
    assert.deepEqual(
      blocks.filter((b) => b.type === "text" && b.text.startsWith("View:")).map((b) => b.text),
      ["View: front", "View: custom"]
    );
  });
});

/**
 * Stub the bridge transport (global fetch) so handlers return canned
 * results without a live Blockbench. Restores the real fetch afterwards.
 * @param {Record<string, {result?: unknown, error?: string}>} byAction
 * @param {() => Promise<void>} fn
 */
async function withFakeBridge(byAction, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts?.body ?? "{}");
    const entry = byAction[body.action];
    if (entry?.error) {
      return { json: async () => ({ ok: false, id: body.id, error: entry.error }) };
    }
    const result = entry?.result ?? { echo: body.params };
    return { json: async () => ({ ok: true, id: body.id, result }) };
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}
