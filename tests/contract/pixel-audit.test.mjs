/**
 * Pixel-bake + audit_texture + arc-handler tests — the surfaces the initial
 * PR shipped without pins (per the pullfrog review: the no-op dither, dead
 * sweep, and inverted caps all lived in exactly this gap).
 *
 * Harness follows smooth-bake.test.mjs: vm-load the REAL plugin with a
 * per-call paint log; audit_texture gets a controlled getImageData bitmap.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

class Cube {
  constructor({ name, uuid, faces }) {
    this.name = name;
    this.uuid = uuid ?? `uuid-${name}`;
    this.faces = faces;
    this.type = "cube";
  }
}
class Group {}

/** Paint log: rect fills with their fillStyle, gradients, blits. */
function makeLog() {
  return { gradients: [], fillRects: [], blits: [], editCalls: 0 };
}

/** The bitmap audit_texture reads: island A mostly red + 2 green, island B blue. */
function auditBitmap(w, h) {
  const data = new Array(w * h * 4).fill(0);
  const px = (x, y, r, g, b) => {
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  };
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px(x, y, 255, 0, 0);   // island A: red
  px(0, 0, 0, 255, 0); px(1, 0, 0, 255, 0);                                      // +2 green
  for (let y = 0; y < 4; y++) for (let x = 8; x < 12; x++) px(x, y, 0, 0, 255);  // island B: blue
  return { data, width: w, height: h };
}

function makeCtx(log, bitmap) {
  return {
    imageSmoothingEnabled: false,
    createLinearGradient(x0, y0, x1, y1) {
      const g = { args: [x0, y0, x1, y1], stops: [], addColorStop(o, c) { this.stops.push([o, c]); } };
      log.gradients.push(g);
      return g;
    },
    set fillStyle(v) { this._fill = v; },
    get fillStyle() { return this._fill; },
    fillRect(x, y, w, h) { log.fillRects.push({ x, y, w, h, fill: this._fill }); },
    getImageData(x, y, w, h) {
      if (bitmap) return { data: bitmap.data, width: bitmap.width, height: bitmap.height };
      const d = new Array(w * h * 4).fill(0);
      d[0] = 255; d[3] = 255;
      return { data: d, width: w, height: h };
    },
    createImageData(w, h) { return { data: new Array(w * h * 4).fill(0), width: w, height: h }; },
    putImageData(img, rx, ry) { log.blits.push({ x: rx, y: ry, data: img.data }); },
    clearRect() {},
  };
}

function makeDocument(log, bitmap) {
  const bakeCanvas = { getContext: () => makeCtx(log, bitmap) };
  return {
    createElement() {
      let fill = "#000";
      return {
        width: 0, height: 0,
        getContext() {
          return {
            clearRect() {}, fillRect() {},
            get fillStyle() { return fill; },
            set fillStyle(v) { fill = String(v); },
            getImageData() { return { data: [...parseCss(fill), 255] }; },
          };
        },
      };
    },
    __bakeCanvas: bakeCanvas,
  };
}

function parseCss(s) {
  s = String(s).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  return [0, 0, 0];
}

const pluginPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../plugin/blockbench_mcp.js");
let src = fs.readFileSync(pluginPath, "utf8");
const cutAt = src.indexOf("// Plugin registration");
assert.ok(cutAt > 0, "plugin must contain the registration marker");
src = `${src.slice(0, cutAt)}\nglobalThis.__COMMANDS__ = commands;\nglobalThis.__MESH__ = meshPrimitive;\n})();\n`;

const log = makeLog();
let documentStub = makeDocument(log);
let auditBitmapData = null;

const sb = {
  console, Buffer, JSON, Math, Object, Array, Number, String, Boolean, Infinity,
  RegExp, Error, Uint8Array, Uint8ClampedArray,
  Project: { texture_width: 64, texture_height: 64 },
  Format: { animation_mode: false },
  Formats: {},
  Group, Cube,
  Outliner: { elements: [], root: [] },
  Texture: { all: [] },
  Animation: { all: [] },
  Undo: { initEdit() {}, finishEdit() {} },
  Canvas: { updateAll() {} },
  Plugin: { register() {} },
  MenuBar: { addAction() {} },
  require: () => { throw new Error("net unavailable in tests"); },
};
Object.defineProperty(sb, "document", { get: () => documentStub, configurable: true });
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src, sb, { filename: "blockbench_mcp.js" });
const commands = sb.__COMMANDS__;
const mp = sb.__MESH__;
assert.ok(commands?.smooth_bake && commands?.audit_texture, "plugin must expose smooth_bake + audit_texture");

const plain = (v) => JSON.parse(JSON.stringify(v));
const face = (x1, y1, x2, y2) => ({ uv: [x1, y1, x2, y2], texture: null });

function seed({ bitmap = null } = {}) {
  log.gradients.length = 0;
  log.fillRects.length = 0;
  log.blits.length = 0;
  log.editCalls = 0;
  auditBitmapData = bitmap;
  documentStub = makeDocument(log, bitmap);
  const tex = {
    uuid: "tex-1", name: "tex", width: 64, height: 64,
    edit(fn) { log.editCalls++; fn(documentStub.__bakeCanvas); },
    canvas: documentStub.__bakeCanvas,
    getDataURL() { return "data:image/png;base64,AAAA"; },
  };
  sb.Texture.all = [tex];
  sb.Texture.getDefault = () => tex;
  sb.Project = { texture_width: 64, texture_height: 64 };
  const cubes = [
    new Cube({ name: "body", faces: { north: face(0, 0, 8, 8) } }),
    new Cube({ name: "helm_cap", faces: { north: face(8, 0, 12, 4) } }),
    new Cube({ name: "eye_core", faces: { north: face(12, 0, 16, 4) } }),
  ];
  // audit_texture groups faces by ASSIGNED texture — assign them up front
  // (the bake path does this itself; the audit path is read-only).
  for (const c of cubes) for (const d in c.faces) c.faces[d].texture = "tex-1";
  sb.Outliner.elements = cubes;
  sb.Cube.all = cubes;
  return { tex, cubes };
}

// ---- pixel mode ------------------------------------------------------------

test("pixel bake: exact band rows and colours (base #ffffff, bands 2)", () => {
  seed();
  const res = plain(commands.smooth_bake({ base: "#ffffff", style: "pixel", bands: 2, cubes: ["body"] }));
  assert.equal(res.style, "pixel");
  assert.equal(res.bands, 2);
  // 8px-tall face, 2 bands -> two 4px rows. north mul 0.95: top=0.95*1.12
  // ->1.064->clamp 255... actually clamp applies at 255 max; bot=0.95*0.78
  // ->0.741->189*0.95... verified empirically: 188. (Object-gradient coat
  // underneath is filtered out by the typeof check.)
  const body = log.fillRects.filter((r) => r.y < 8 && r.h > 1 && typeof r.fill === "string");
  assert.deepEqual(body.map((r) => [r.y, r.h, r.fill]), [
    [0, 4, "rgb(255,255,255)"],
    [4, 4, "rgb(188,188,188)"],
  ]);
});

test("pixel bake: boundary dither paints PREVIOUS band's tone on alternating pixels", () => {
  seed();
  commands.smooth_bake({ base: "#ffffff", style: "pixel", bands: 2, cubes: ["body"] });
  // Boundary row is y=4 (band 1). Dither pixels are 1x1 rects there.
  const dots = log.fillRects.filter((r) => r.w === 1 && r.h === 1 && r.y === 4);
  assert.equal(dots.length, 4, `expected 4 dither pixels on the 8px row, got ${dots.length}`);
  // (dx + row) % 2 === 0 with row=1 -> odd dx: 1,3,5,7
  assert.deepEqual(dots.map((d) => d.x), [1, 3, 5, 7]);
  // THE no-op-dither pin: dither colour must be the PREVIOUS (lighter) band,
  // not the row's own colour — if both are rgb(198,...) the dither is dead.
  assert.equal(dots[0].fill, "rgb(255,255,255)");
  assert.notEqual(dots[0].fill, "rgb(198,198,198)");
});

test("pixel bake: hard parts skip the dither; glow cores keep their gradient", () => {
  seed();
  commands.smooth_bake({ base: "#ffffff", style: "pixel", bands: 2 });
  const capDots = log.fillRects.filter((r) => r.w === 1 && r.h === 1 && r.x >= 8 && r.x < 12);
  assert.equal(capDots.length, 0, "hard parts get no dither");
  const core = log.gradients.find((g) => g.stops.length === 3);
  assert.ok(core, "glow core keeps the 3-stop bright gradient");
  const coreDots = log.fillRects.filter((r) => r.w === 1 && r.h === 1 && r.x >= 12);
  assert.equal(coreDots.length, 0, "glow core gets no bands/dither");
});

test("pixel bake: bands 1 is a single flat fill", () => {
  seed();
  commands.smooth_bake({ base: "#ffffff", style: "pixel", bands: 1, cubes: ["body"] });
  const body = log.fillRects.filter((r) => r.y < 8 && r.h > 1 && typeof r.fill === "string");
  assert.equal(body.length, 1);
  assert.equal(body[0].h, 8);
});

// ---- audit_texture ---------------------------------------------------------

test("audit_texture: unique/quantized counts, per-island grouping, share rounding", () => {
  seed({ bitmap: auditBitmap(64, 64) });
  const tex = sb.Texture.all[0];
  const res = plain(commands.audit_texture({}));
  assert.equal(res.texture, "tex");
  assert.deepEqual(res.size, [64, 64]);
  // red + green + blue = 3 unique colours overall; unused sheet area is
  // transparency, counted separately — not a colour
  assert.equal(res.unique_total, 3);
  assert.equal(res.quantized_unique_total, 3);
  assert.equal(res.transparent_pixels, 4016);
  const islA = res.islands.find((i) => i.rect[0] === 0);
  const islB = res.islands.find((i) => i.rect[0] === 8);
  assert.ok(islA && islB, `both islands present: ${JSON.stringify(res.islands.map((i) => i.rect))}`);
  assert.equal(islA.unique, 2);
  assert.equal(islB.unique, 1);
  // 62 red of 64 -> 97%; dominant share rounding pinned
  assert.equal(islA.dominant[0].color, "#ff0000");
  assert.equal(islA.dominant[0].share, 97);
  assert.equal(islB.dominant[0].color, "#0000ff");
  assert.equal(islB.dominant[0].share, 100);
  // top_colors overall: red 62, blue 16, green 2
  assert.deepEqual(res.top_colors.map((c) => c.color), ["#ff0000", "#0000ff", "#00ff00"]);
  // unused sheet area reports as transparency, not as a colour
  assert.equal(res.transparent_pixels, 4016);
});

test("audit_texture: per_island=false skips islands; islands sort by unique desc", () => {
  seed({ bitmap: auditBitmap(64, 64) });
  let res = plain(commands.audit_texture({ per_island: false }));
  assert.deepEqual(res.islands, []);
  seed({ bitmap: auditBitmap(64, 64) });
  res = plain(commands.audit_texture({}));
  assert.ok(res.islands.length >= 2, "both islands present");
  assert.ok(res.islands[0].unique >= res.islands[res.islands.length - 1].unique, "islands sorted by unique desc");
});

test("audit_texture: faces of other textures are not audited as islands", () => {
  seed({ bitmap: auditBitmap(64, 64) });
  const other = { uuid: "tex-2", name: "other", width: 64, height: 64, canvas: documentStub.__bakeCanvas };
  sb.Texture.all.push(other);
  const c = new Cube({ name: "foreign", faces: { north: { uv: [16, 0, 24, 8], texture: "tex-2" } } });
  sb.Cube.all.push(c);
  const res = plain(commands.audit_texture({ texture: "tex" }));
  assert.equal(res.islands.find((i) => i.rect[0] === 16), undefined, "other-texture face excluded");
});

// ---- arc handler + sweep + cap winding -------------------------------------

const cross = (a, b, c) => [
  (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
  (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
];

test("arc: sweep is actually forwarded (default 60 vs explicit 90 vs mirrored -90)", () => {
  // THE dead-sweep pin: if the handler ignored `sweep`, 90 would equal default.
  const d = plain(mp("arc", 20, 4, 2, 8));
  const p90 = plain(mp("arc", 20, 4, 2, 8, 90));
  const m90 = plain(mp("arc", 20, 4, 2, 8, -90));
  // default 60deg: last ring's first corner x = cos(60)*10 + nx*1 = 4.5
  const lastD = d.verts[(d.verts.length / 4 - 1) * 4];
  assert.ok(Math.abs(lastD[0] - 4.5) < 1e-6, `default sweep 60: last ring x ~4.5, got ${lastD[0]}`);
  // 90deg: last ring x ~0
  const last90 = p90.verts[(p90.verts.length / 4 - 1) * 4];
  assert.ok(Math.abs(last90[0]) < 1e-6, `sweep 90: last ring x ~0, got ${last90[0]}`);
  // mirrored -90: same x but z flips sign vs +90
  const lastM = m90.verts[(m90.verts.length / 4 - 1) * 4];
  assert.ok(Math.abs(last90[0] - lastM[0]) < 1e-6, "mirror keeps |x|");
  assert.ok(last90[2] * lastM[2] < 0, `mirror flips z: ${last90[2]} vs ${lastM[2]}`);
});

test("arc: end caps wind OUTWARD for both sweep signs (single-sided render safe)", () => {
  for (const sweep of [90, -90]) {
    const prim = plain(mp("arc", 20, 4, 2, 8, sweep));
    const s = Math.sign(sweep);
    // Start ring (i=0): travel dir T=(0,0,s) -> outward = -T = (0,0,-s).
    // End ring (i=nseg): T=(-s,0,0) -> outward = +T = (-s,0,0).
    // Cap corner 0->3 spans the cross-section z; the cap normal's x/z
    // components are computed from the actual vertex ring, no hand-math.
    const rings = prim.verts.length / 4;
    const capFaces = prim.faces.slice(-2);
    const n0 = cross(prim.verts[capFaces[0][0]], prim.verts[capFaces[0][1]], prim.verts[capFaces[0][2]]);
    const nN = cross(prim.verts[capFaces[1][0]], prim.verts[capFaces[1][1]], prim.verts[capFaces[1][2]]);
    // start cap: normal must oppose travel (travel z-comp = +s -> outward z = -s)
    assert.ok(n0[2] * -s > 0, `start cap must oppose travel, n=${n0} sweep=${sweep}`);
    // end cap: the sweep starts at +x and rotates toward +/-z, so travel at
    // the end ring is ALWAYS -x and outward follows it (nN[0] < 0 for both signs)
    assert.ok(nN[0] < 0, `end cap must point -x (travel direction), n=${nN} sweep=${sweep}`);
  }
});
