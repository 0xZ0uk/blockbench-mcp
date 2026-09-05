/**
 * compare_views silhouette metrics (compare v2) — drive the REAL bridge
 * handler (plugin/blockbench_mcp.js) with stubbed Blockbench globals and
 * REAL PNG fixtures, no live Blockbench, no ports.
 *
 * Pins: PIL-generated fixtures (committed) decoded by the plugin's own PNG
 * decoder give the same metrics Python computes directly from the bitmaps —
 * cross-implementation validation. Identity ⇒ identical (byte path). Same
 * pixels, re-encoded ⇒ IoU 1.0. Distortion ⇒ structured FAIL with the
 * failing check named (aspect for wide, area for small, centroid for
 * shift) and pass with a permissive gate. Threshold moves the mask (annulus
 * only enters at low alpha cutoff). JPEG vs PNG never crashes — byte-only
 * fallback. Corner-keyed RGB fixtures route through the corner path
 * (mask = "far from backdrop") and center the verdict text on the
 * subjective signal: the readable, line-per-check verdict.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const FX = path.resolve(path.dirname(new URL(import.meta.url).pathname), "fixtures/compare");
const read64 = (f) => `data:image/png;base64,${fs.readFileSync(path.join(FX, f)).toString("base64")}`;

// What the stubbed Screencam returns for every capture; tests mutate this
// to simulate model edits between pin and compare.
let currentShot = read64("blob_a.png");

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
  RegExp, Error, Map, Set, Uint8Array, Uint8ClampedArray,
  Project: { texture_width: 16, texture_height: 16, view_mode: "textured" },
  Format: { animation_mode: false, meshes: true },
  Formats: {},
  Group: class {},
  Cube: class {},
  Outliner: { elements: [], root: [] },
  Texture: { all: [] },
  Animation: { all: [] },
  Undo: { initEdit() {}, finishEdit() {} },
  Canvas: { updateAll() {}, updateViewMode() {} },
  Plugin: { register() {} },
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
    if (mod === "zlib") return { inflateSync: (b) => globalZlibSync(b) };
    throw new Error(`module unavailable in tests (asked for ${mod})`);
  },
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src, sb, { filename: "blockbench_mcp.js" });
const commands = sb.__COMMANDS__;
assert.ok(commands?.compare_views, "plugin must expose compare_views");
assert.ok(commands?.set_reference_image, "plugin must expose set_reference_image");

// node:zlib in the vm realm: the plugin calls inflateSync(Buffer) and wants a
// Buffer back; Buffer concat across realms works via toBuffer().
import { inflateSync as nodeInflate } from "node:zlib";
function globalZlibSync(b) {
  return Buffer.from(nodeInflate(b));
}

beforeEach(() => {
  sb.__BLOCKBENCH_MCP__.reference_images = {};
  currentShot = read64("blob_a.png");
  sb.Preview.selected = makePreview();
  sb.Project.view_mode = "textured";
});

/** vm-realm objects carry a different prototype: compare via JSON round-trip. */
const plain = (v) => JSON.parse(JSON.stringify(v));

test("metrics: re-encoded same pixels still verdict PASS at IoU 1.0 (the false-DIFFER fix)", async () => {
  commands.set_reference_image({ view: "front", source: read64("blob_a.png") });
  currentShot = read64("blob_a_recoded.png");
  const res = plain(await commands.compare_views({ views: ["front"] }));
  const c = res.comparisons[0];
  assert.equal(c.match, false, "bytes differ by design — this is the regression byte-compare false-alarms on");
  assert.equal(c.identical, false);
  assert.ok(c.metrics, "metrics must be computed");
  assert.equal(c.metrics.iou, 1.0);
  assert.equal(c.verdict.pass, true);
  assert.equal(res.metrics_failed, 0);
});

test("metrics: shifted copy FAILs naming centroid, PASSes under permissive gate", async () => {
  commands.set_reference_image({ view: "front", source: read64("blob_a.png") });
  currentShot = read64("blob_a_shift12.png");
  const res = plain(await commands.compare_views({ views: ["front"] }));
  const c = res.comparisons[0];
  assert.equal(c.match, false);
  assert.equal(c.verdict.pass, false);
  assert.equal(res.metrics_failed, 1);
  const names = c.verdict.checks.filter((k) => !k.pass).map((k) => k.name);
  assert.deepEqual(names, ["iou", "centroid"]);
  assert.match(c.verdict.checks.find((k) => k.name === "centroid").detail, /centroid shifted/);
  assert.ok(c.metrics.iou < 0.5, `shifted IoU should be low, got ${c.metrics.iou}`);
  assert.equal(c.metrics.centroid_delta_px?.[0], 12);
  // fully permissive gate: same metrics, everything passes
  const res2 = plain(await commands.compare_views({
    views: [{ view: "front", gate: "iou<=0.3,area<=0.25,aspect<=0.1,centroid<=0.3" }],
  }));
  assert.equal(res2.comparisons[0].verdict.pass, true, "IoU 0.37 clears iou<=0.3; centroid 12/64=18.75% clears 0.3");
  assert.equal(res2.comparisons[0].verdict.checks.find((k) => k.name === "iou").pass, true);
});

test("metrics: stretched copy FAILs naming aspect; squeezed copy FAILs naming area", async () => {
  commands.set_reference_image({ view: "front", source: read64("blob_a.png") });
  currentShot = read64("blob_a_wide.png");
  const res = plain(await commands.compare_views({ views: ["front"] }));
  const c = res.comparisons[0];
  const failedNames = c.verdict.checks.filter((k) => !k.pass).map((k) => k.name);
  assert.ok(failedNames.includes("aspect"), `wide must fail aspect, got ${failedNames}`);
  assert.equal(c.metrics.aspect_delta_pct, 36);
  assert.equal(c.metrics.area_ratio, 1.374);

  currentShot = read64("blob_a_small.png");
  const res2 = plain(await commands.compare_views({
    views: [{ view: "front", gate: "area<=0.2" }],
  }));
  const failed2 = res2.comparisons[0].verdict.checks.filter((k) => !k.pass).map((k) => k.name);
  assert.ok(failed2.includes("area"), `−22% squeeze must fail an area<=0.2 gate, got ${failed2}`);
  assert.equal(res2.comparisons[0].metrics.area_ratio, 0.778);
});

test("metrics: threshold moves the mask (annulus only at low cutoff)", async () => {
  commands.set_reference_image({ view: "front", source: read64("blob_a.png") });
  currentShot = read64("blob_plain.png");
  const res = plain(await commands.compare_views({ views: ["front"] }));
  const c = res.comparisons[0];
  assert.equal(c.metrics.iou, 1.0, "identical masks at default threshold: core matches core");
  assert.equal(c.metrics.ref_area, 845);
  const res2 = plain(await commands.compare_views({ views: [{ view: "front", threshold: 50 }] }));
  const c2 = res2.comparisons[0];
  assert.equal(c2.metrics.ref_area, 1185, "annulus joins the pinned reference's mask at threshold 50");
  assert.equal(c2.metrics.iou, 0.7131, "shot stays core-only (845) vs ref-with-annulus (1185): 845/1185 (PIL-verified)");
});

test("metrics: near-miss at default gate; 2px real shift clearly detected", async () => {
  commands.set_reference_image({ view: "front", source: read64("blob_a.png") });
  currentShot = read64("blob_a_shift2.png");
  const res = plain(await commands.compare_views({ views: ["front"] }));
  const c = res.comparisons[0];
  assert.ok(c.metrics, "metrics must be computed");
  assert.equal(c.metrics.ref_area, 845);
  assert.equal(c.metrics.shot_area, 845);
  assert.equal(c.metrics.iou, 0.8551, "2px shift on a 33px blob: IoU 0.8551 (cross-validated with PIL)");
  assert.equal(c.metrics.centroid_delta_px?.[0], 2);
  assert.equal(c.verdict.pass, true, "default gate: 2px is a near-miss (IoU 0.855 ≥ 0.85)");
  // Same defect under a tighter gate is caught: IoU 0.8551 < 0.95.
  const tight = plain(await commands.compare_views({ views: [{ view: "front", gate: "iou<=0.95" }] }));
  assert.equal(tight.comparisons[0].verdict.pass, false, "tight gate catches the 2px shift");
  assert.ok(tight.comparisons[0].verdict.checks.some((k) => !k.pass && k.name === "iou"));
});

test("metrics: identical comparison short-circuits on byte equality with no metrics", async () => {
  commands.set_reference_image({ view: "front", source: read64("blob_a.png") });
  const res = plain(await commands.compare_views({ views: ["front"] }));
  const c = res.comparisons[0];
  assert.equal(c.match, true);
  assert.equal(c.identical, true);
  assert.equal(c.metrics, null);
  assert.equal(c.verdict, null);
  assert.equal(res.metrics_passed, 0);
  assert.equal(res.fallback_byte_only, 0);
});

test("metrics: corner-keyed RGB references route through the corner path", async () => {
  commands.set_reference_image({ view: "front", source: read64("corner_ref.png") });
  currentShot = read64("corner_ref_shift12.png");
  const res = plain(await commands.compare_views({ views: ["front"] }));
  const c = res.comparisons[0];
  assert.ok(c.metrics, "corner path must produce metrics");
  // White bg, black square shifted +12: PIL alpha-of-RGBA conversion can't
  // express "far from white", so expectations are computed by replicating
  // the corner rule (|r-255|+|g-255|+|b-255| > 96) directly on the bitmaps
  // — cross-validated in Python: IoU 0.3514, ref=shot=625px, cdx=12.
  assert.equal(c.metrics.iou, 0.3514);
  assert.equal(c.metrics.ref_area, 625);
  assert.equal(c.metrics.shot_area, 625);
  assert.equal(c.metrics.area_ratio, 1.0);
  assert.equal(c.metrics.centroid_delta_px?.[0], 12);
  assert.equal(c.verdict.pass, false);
  assert.ok(c.verdict.checks.some((k) => !k.pass && k.name === "centroid"));
});

test("metrics: jpeg/undecodable shot falls back to byte-only without crashing", async () => {
  commands.set_reference_image({ view: "front", source: read64("blob_a.png") });
  currentShot = "data:image/jpeg;base64," + fs.readFileSync(path.join(FX, "junk.jpg")).toString("base64");
  const res = plain(await commands.compare_views({ views: ["front"] }));
  const c = res.comparisons[0];
  assert.equal(c.match, false);
  assert.equal(c.metrics, null, "non-PNG shot: no metrics");
  assert.equal(c.verdict, null);
  assert.equal(res.fallback_byte_only, 1);
  assert.match(c.delta, /differs from pinned reference/);
});

test("metrics: gate syntax — custom values parse; malformed gate names the field", async () => {
  commands.set_reference_image({ view: "front", source: read64("blob_a.png") });
  currentShot = read64("blob_a_shift12.png");
  await assert.rejects(
    async () => commands.compare_views({ views: ["front"], gate: "iou<=banana" }),
    /Field "gate"/
  );
  await assert.rejects(
    async () => commands.compare_views({ views: ["front"], gate: "banana<=1" }),
    /Field "gate"/
  );
  // shorthand and subset keys both parse
  const ok1 = plain(await commands.compare_views({ views: ["front"], gate: "@iou<=0.3" }));
  assert.ok(ok1.comparisons[0].verdict.checks.find((k) => k.name === "iou"));
  const ok2 = plain(await commands.compare_views({ views: ["front"], gate: "area<=0.9" }));
  assert.ok(ok2.comparisons[0].verdict.checks.find((k) => k.name === "area"));
});
