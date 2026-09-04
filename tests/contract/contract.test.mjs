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
