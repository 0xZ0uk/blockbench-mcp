/**
 * compare_views tests — drive the REAL bridge handler
 * (plugin/blockbench_mcp.js) with stubbed Blockbench globals, no live
 * Blockbench, no ports (ticket #26).
 *
 * The contract table pins the schema clients see; these tests pin the
 * comparison behavior: missing reference is a per-view error naming `view`
 * while other views still compare, an unchanged model yields a stable
 * deterministic delta, pin -> edit -> compare reports a structured diff,
 * and camera/projection state is restored after the sequence.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// 1x1 PNG (70 bytes) + the same bytes with one trailing byte (71 bytes:
// the "edit" fixture — IHDR stays intact so dimensions still parse).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");
const PNG_BIG_B64 = Buffer.concat([PNG_BYTES, Buffer.from([0])]).toString("base64");
const PNG_URL = (b64) => `data:image/png;base64,${b64}`;

// What the stubbed Screencam returns for every capture; tests mutate this
// to simulate model edits between pin and compare.
let currentShot = PNG_URL(PNG_B64);

const pluginPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../plugin/blockbench_mcp.js");
let src = fs.readFileSync(pluginPath, "utf8");
const cutAt = src.indexOf("// Plugin registration");
assert.ok(cutAt > 0, "plugin must contain the registration marker");
src = `${src.slice(0, cutAt)}\nglobalThis.__COMMANDS__ = commands;\n})();\n`;

function makeVec(x = 0, y = 0, z = 0) {
  return {
    x, y, z,
    clone() { return makeVec(this.x, this.y, this.z); },
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; },
    set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; },
  };
}

function makePreview() {
  return {
    camera: {
      position: makeVec(1, 2, 3),
      zoom: 1,
      updateProjectionMatrix() {},
    },
    controls: {
      target: makeVec(4, 5, 6),
      updateSceneScale() {},
    },
    isOrtho: false,
    angle: null,
    camPers: { fov: 40 },
    setProjectionMode(ortho) { this.isOrtho = !!ortho; },
    setLockedAngle(a) { this.angle = a; },
    setFOV(f) { this.camPers.fov = f; },
    loadAnglePreset(preset) { this._preset = preset.id; },
    render() {},
  };
}

const sb = {
  console, Buffer, JSON, Math, Object, Array, Number, String, Boolean, Infinity,
  RegExp, Error, Map, Set, Uint8Array,
  Project: { texture_width: 16, texture_height: 16, view_mode: "textured" },
  Format: { animation_mode: false },
  Formats: {},
  Group: class {},
  Cube: class {},
  Outliner: { elements: [], root: [] },
  Texture: { all: [] },
  Animation: { all: [] },
  Undo: { initEdit() {}, finishEdit() {} },
  Canvas: { updateAll() {}, updateViewMode() {} },
  Plugin: { register() {} },
  MenuBar: { addAction() {} },
  Preview: { selected: makePreview() },
  Screencam: {
    screenshotPreview(_preview, _options, cb) { cb(currentShot); },
  },
  DefaultCameraPresets: [
    { id: "front", name: "Front" },
    { id: "top", name: "Top" },
    { id: "left", name: "Left" },
  ],
  require: (mod) => {
    throw new Error(`net unavailable in tests (asked for ${mod})`);
  },
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src, sb, { filename: "blockbench_mcp.js" });
const commands = sb.__COMMANDS__;
assert.ok(commands?.compare_views, "plugin must expose compare_views");
assert.ok(commands?.set_reference_image, "plugin must expose set_reference_image");

beforeEach(() => {
  sb.__BLOCKBENCH_MCP__.reference_images = {};
  currentShot = PNG_URL(PNG_B64);
  sb.Preview.selected = makePreview();
  sb.Project.view_mode = "textured";
});

/** vm-realm objects carry a different prototype: compare via JSON round-trip. */
const plain = (v) => JSON.parse(JSON.stringify(v));

test("compare_views: missing reference is a per-view error naming view; other views still compare", async () => {
  commands.set_reference_image({ view: "front", source: PNG_URL(PNG_B64) });
  const res = plain(await commands.compare_views({ views: ["front", "top"] }));
  assert.equal(res.count, 2);
  assert.equal(res.matched, 1);
  assert.equal(res.differed, 0);
  assert.deepEqual(res.missing, ["preset:top"]);
  assert.equal(res.projection_restored, true);
  const [front, top] = res.comparisons;
  assert.equal(front.view, "preset:front");
  assert.equal(front.compared, true);
  assert.equal(front.match, true);
  assert.match(front.delta, /identical to pinned reference/);
  assert.equal(top.view, "preset:top");
  assert.equal(top.compared, false);
  assert.equal(top.match, false);
  assert.match(top.error, /Field "view".*preset:top/);
});

test("compare_views: unchanged model yields a stable deterministic delta", async () => {
  commands.set_reference_image({ view: "front", source: PNG_URL(PNG_BIG_B64) });
  currentShot = PNG_URL(PNG_BIG_B64);
  const args = { views: [{ view: "front", ortho: true, px_per_unit: 8 }] };
  const a = plain(await commands.compare_views(args));
  const b = plain(await commands.compare_views(args));
  assert.equal(a.comparisons[0].match, true);
  assert.match(a.comparisons[0].delta, /identical to pinned reference \(image\/png 71 bytes 1x1\)/);
  assert.deepEqual(a, b);
});

test("compare_views: pin -> edit -> compare reports a structured diff", async () => {
  commands.set_reference_image({ view: "front", source: PNG_URL(PNG_B64) });
  currentShot = PNG_URL(PNG_BIG_B64); // the "edit": one appended byte
  const res = plain(await commands.compare_views({ views: ["front"] }));
  assert.equal(res.count, 1);
  assert.equal(res.matched, 0);
  assert.equal(res.differed, 1);
  assert.deepEqual(res.missing, []);
  const [c] = res.comparisons;
  assert.equal(c.view, "preset:front");
  assert.equal(c.compared, true);
  assert.equal(c.match, false);
  assert.match(c.delta, /differs from pinned reference: 1\/71 bytes differ/);
  assert.match(c.delta, /first diff at byte 70/);
  assert.match(c.delta, /shot image\/png 71 bytes 1x1 vs reference image\/png 70 bytes 1x1/);
  assert.deepEqual(c.reference, { mime: "image/png", bytes: 70, width: 1, height: 1 });
  assert.equal(c.shot.bytes, 71);
});

test("compare_views: camera and projection state is restored after the sequence", async () => {
  commands.set_reference_image({ view: "front", source: PNG_URL(PNG_B64) });
  const preview = sb.Preview.selected;
  const res = plain(
    await commands.compare_views({ views: [{ view: "front", ortho: true, px_per_unit: 8, wireframe: true }] })
  );
  assert.equal(res.projection_restored, true);
  assert.equal(res.comparisons[0].projection_restored, true);
  // Entry state comes back: perspective projection, default zoom/FOV,
  // textured view mode, untouched camera position/target.
  assert.equal(preview.isOrtho, false);
  assert.equal(preview.camera.zoom, 1);
  assert.equal(preview.camPers.fov, 40);
  assert.equal(sb.Project.view_mode, "textured");
  assert.deepEqual([preview.camera.position.x, preview.camera.position.y, preview.camera.position.z], [1, 2, 3]);
  assert.deepEqual([preview.controls.target.x, preview.controls.target.y, preview.controls.target.z], [4, 5, 6]);
  // ... while the shot reports the applied blueprint flags, not the restored ones.
  assert.equal(res.comparisons[0].shot.ortho, true);
  assert.equal(res.comparisons[0].shot.px_per_unit, 8);
  assert.equal(res.comparisons[0].shot.wireframe, true);
});

test("compare_views: empty store compares nothing but still reports every view", async () => {
  let captures = 0;
  const realShot = sb.Screencam.screenshotPreview;
  sb.Screencam.screenshotPreview = (...a) => { captures++; return realShot(...a); };
  try {
    const res = plain(await commands.compare_views({ views: ["front", "top"] }));
    assert.equal(res.count, 2);
    assert.equal(res.matched, 0);
    assert.equal(res.differed, 0);
    assert.deepEqual(res.missing, ["preset:front", "preset:top"]);
    assert.equal(res.projection_restored, true);
    for (const c of res.comparisons) {
      assert.equal(c.compared, false);
      assert.match(c.error, /Field "view"/);
    }
    assert.equal(captures, 0);
  } finally {
    sb.Screencam.screenshotPreview = realShot;
  }
});

test("compare_views: mid-sequence capture failure still restores entry state", async () => {
  commands.set_reference_image({ view: "front", source: PNG_URL(PNG_B64) });
  commands.set_reference_image({ view: "top", source: PNG_URL(PNG_B64) });
  const preview = sb.Preview.selected;
  let calls = 0;
  const realShot = sb.Screencam.screenshotPreview;
  sb.Screencam.screenshotPreview = (...a) => {
    if (++calls === 2) throw new Error("renderer blew up mid-sequence");
    return realShot(...a);
  };
  try {
    await assert.rejects(
      async () => commands.compare_views({ views: ["front", "top"] }),
      /renderer blew up mid-sequence/
    );
  } finally {
    sb.Screencam.screenshotPreview = realShot;
  }
  assert.equal(preview.isOrtho, false);
  assert.equal(sb.Project.view_mode, "textured");
  assert.deepEqual([preview.camera.position.x, preview.camera.position.y, preview.camera.position.z], [1, 2, 3]);
});

test("compare_views: explicit {position,target} keys by camera", async () => {
  const cam = { position: [0, 8, 32], target: [0, 8, 0] };
  commands.set_reference_image({ view: cam, source: PNG_URL(PNG_B64) });
  const hit = plain(await commands.compare_views({ views: [cam] }));
  assert.equal(hit.comparisons[0].view, "pos(0,8,32)->tgt(0,8,0)");
  assert.equal(hit.comparisons[0].match, true);
  const miss = plain(
    await commands.compare_views({ views: [{ position: [0, 8, 33], target: [0, 8, 0] }] })
  );
  assert.equal(miss.comparisons[0].compared, false);
  assert.match(miss.comparisons[0].error, /Field "view"/);
});

test("compare_views: bad views and flags throw naming the field", async () => {
  await assert.rejects(async () => commands.compare_views({}), /Field "views"/);
  await assert.rejects(async () => commands.compare_views({ views: [] }), /Field "views"/);
  await assert.rejects(async () => commands.compare_views({ views: "front" }), /Field "views"/);
  await assert.rejects(async () => commands.compare_views({ views: [42] }), /Field "view"/);
  await assert.rejects(async () => commands.compare_views({ views: [{}] }), /Field "view"/);
  await assert.rejects(async () => commands.compare_views({ views: ["front"], px_per_unit: 0 }), /Field "px_per_unit"/);
  await assert.rejects(
    async () => commands.compare_views({ views: [{ view: "front", px_per_unit: -2 }] }),
    /Field "px_per_unit"/
  );
});

test("compare_views: no project open names the remedy", async () => {
  const had = sb.Project;
  sb.Project = undefined;
  try {
    await assert.rejects(async () => commands.compare_views({ views: ["front"] }), /No project is open/);
  } finally {
    sb.Project = had;
  }
});
