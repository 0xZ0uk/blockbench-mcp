/**
 * smooth_bake tests — drive the REAL bridge handler (plugin/blockbench_mcp.js)
 * with stubbed Blockbench globals, no live Blockbench, no ports (ticket #27).
 *
 * The contract table pins the schema clients see; these tests pin parity
 * with the promoted skill snippet (gradient + mottle + per-island blur):
 * the structured result shape, face texture assignment, the snippet's
 * gradient stops and directional shading, ~10% mottle density, the 0.55
 * smooth-brush blend, glow + hard-part crispness, palette routing, scope
 * narrowing, and errors that name the remedy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

/** Parse the CSS colours the bake uses (#rrggbb, #rgb, rgb()) into [r,g,b,a]. */
function parseCss(s) {
  s = String(s).trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 255];
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [m[1][0] + m[1][0], m[1][1] + m[1][1], m[1][2] + m[1][2]].map((h) => parseInt(h, 16)).concat([255]);
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(s);
  if (m) return [+m[1], +m[2], +m[3], 255];
  return [0, 0, 0, 255];
}

class Cube {
  constructor({ name, uuid, faces }) {
    this.name = name;
    this.uuid = uuid ?? `uuid-${name}`;
    this.faces = faces;
    this.type = "cube";
  }
}
class Group {}

/** Per-call paint log: gradients (with stops), rect fills, blur blits. */
function makeLog() {
  return { gradients: [], fillRects: [], blits: [], editCalls: 0 };
}

/** Stub 2d context recording everything the bake does to the texture. */
function makeCtx(log, imagePattern) {
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
      const data = new Array(w * h * 4).fill(0);
      // First pixel hot, rest empty: pins the blur blend amount exactly.
      data[0] = imagePattern[0]; data[1] = imagePattern[1]; data[2] = imagePattern[2]; data[3] = 255;
      return { data, width: w, height: h };
    },
    createImageData(w, h) { return { data: new Array(w * h * 4).fill(0), width: w, height: h }; },
    putImageData(img, rx, ry) { log.blits.push({ x: rx, y: ry, data: img.data }); },
    clearRect() {},
  };
}

/** Stub document (parseColor's 1px canvas) + bake canvas sharing one log. */
function makeDocument(log) {
  const bakeCanvas = { getContext: () => makeCtx(log, [255, 0, 0]) };
  return {
    createElement() {
      let fill = "#000";
      return {
        width: 0, height: 0,
        getContext() {
          return {
            clearRect() {},
            fillRect() {},
            get fillStyle() { return fill; },
            set fillStyle(v) { fill = String(v); },
            getImageData() { return { data: parseCss(fill) }; },
          };
        },
      };
    },
    __bakeCanvas: bakeCanvas,
  };
}

const pluginPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../plugin/blockbench_mcp.js");
let src = fs.readFileSync(pluginPath, "utf8");
const cutAt = src.indexOf("// Plugin registration");
assert.ok(cutAt > 0, "plugin must contain the registration marker");
src = `${src.slice(0, cutAt)}\nglobalThis.__COMMANDS__ = commands;\n})();\n`;

const log = makeLog();
let documentStub = makeDocument(log);
let undoCalls = [];
let canvasUpdated = 0;

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
  Undo: {
    initEdit(a) { undoCalls.push(["init", a]); },
    finishEdit(a) { undoCalls.push(["finish", a]); },
  },
  Canvas: { updateAll() { canvasUpdated++; } },
  Plugin: { register() {} },
  MenuBar: { addAction() {} },
  require: () => { throw new Error("net unavailable in tests"); },
};
Object.defineProperty(sb, "document", { get: () => documentStub, configurable: true });
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src, sb, { filename: "blockbench_mcp.js" });
const commands = sb.__COMMANDS__;
assert.ok(commands?.smooth_bake, "plugin must expose smooth_bake");

/** vm-realm objects carry a different prototype: compare via JSON round-trip. */
const plain = (v) => JSON.parse(JSON.stringify(v));

const face = (x1, y1, x2, y2) => ({ uv: [x1, y1, x2, y2], texture: null });

/** Fixture model: one plain body cube, one glow core, one hard-surface cap. */
function seed() {
  log.gradients.length = 0;
  log.fillRects.length = 0;
  log.blits.length = 0;
  log.editCalls = 0;
  undoCalls = [];
  canvasUpdated = 0;
  documentStub = makeDocument(log);
  const tex = {
    uuid: "tex-1", name: "tex", width: 64, height: 64,
    edit(fn) { log.editCalls++; fn(documentStub.__bakeCanvas); },
  };
  sb.Texture.all = [tex];
  sb.Project = { texture_width: 64, texture_height: 64 };
  const cubes = [
    new Cube({ name: "body", faces: { north: face(0, 0, 8, 8), up: face(8, 0, 16, 8) } }),
    new Cube({ name: "eye_core", faces: { north: face(16, 0, 20, 4) } }),
    new Cube({ name: "helm_cap", faces: { north: face(20, 0, 24, 4) } }),
  ];
  sb.Outliner.elements = cubes;
  sb.Cube.all = cubes;
  return { tex, cubes };
}

test("smooth_bake: bakes every face and reports the snippet result shape", () => {
  const { tex, cubes } = seed();
  const res = plain(commands.smooth_bake({}));
  assert.deepEqual(Object.keys(res).sort(), ["baked", "cubes", "faces", "texture"]);
  assert.equal(res.baked, true);
  assert.equal(res.cubes, 3);
  assert.equal(res.faces, 4);
  assert.equal(res.texture.uuid, "tex-1");
  // Observable state effect through the existing seams: every face assigned,
  // exactly one texture edit, undo-wrapped, canvas refreshed.
  for (const c of cubes) for (const d in c.faces) assert.equal(c.faces[d].texture, tex.uuid);
  assert.equal(log.editCalls, 1);
  assert.deepEqual(undoCalls.map(([k]) => k), ["init", "finish"]);
  assert.equal(canvasUpdated, 1);
});

test("smooth_bake: gradient matches the snippet recipe (stops, shading, default base)", () => {
  seed();
  commands.smooth_bake({});
  // Job order: body north, body up, eye_core north, helm_cap north.
  assert.deepEqual(log.gradients.map((g) => g.stops.length), [2, 2, 3, 2]);
  const [bodyNorth, bodyUp, core] = log.gradients;
  // Snippet stops on the default brown base (#6e4f30): north mul 0.95.
  assert.deepEqual(plain(bodyNorth.stops), [[0, "rgb(114,82,50)"], [1, "rgb(88,63,38)"]]);
  // Directional shading: up faces bake brighter than north faces.
  assert.equal(plain(bodyUp.stops)[0][1], "rgb(135,97,59)");
  // Glow cores get the bright 3-stop fill with no dark shading.
  assert.deepEqual(plain(core.stops).map(([o]) => o), [0, 0.5, 1]);
  assert.equal(plain(core.stops)[0][1], "rgb(123,88,53)");
});

test("smooth_bake: mottle density matches the snippet (~10%) and skips glow + hard parts", () => {
  seed();
  commands.smooth_bake({});
  // Mottle paints 1px-wide rects; gradient coats are island-sized.
  const dots = log.fillRects.filter((r) => r.w === 1);
  const inside = (r, x, y, w, h) => r.x >= x && r.y >= y && r.x < x + w && r.y < y + h;
  // 8x8 islands -> floor(64 * 0.10) = 6 dots each; glow + hard parts get none.
  assert.equal(dots.filter((r) => inside(r, 0, 0, 8, 8)).length, 6);
  assert.equal(dots.filter((r) => inside(r, 8, 0, 8, 8)).length, 6);
  assert.equal(dots.filter((r) => inside(r, 16, 0, 4, 4)).length, 0);
  assert.equal(dots.filter((r) => inside(r, 20, 0, 4, 4)).length, 0);
});

test("smooth_bake: per-island blur matches the snippet brush (0.55) and skips glow + hard parts", () => {
  seed();
  commands.smooth_bake({});
  assert.deepEqual(log.blits.map((b) => [b.x, b.y]).sort(), [[0, 0], [8, 0]]);
  // Hot corner (255) blended 0.55 toward its 4-neighbour mean (63.75): pins amt 0.55.
  assert.equal(log.blits.find((b) => b.x === 0).data[0], 149);
  // 0 disables the smooth brush entirely.
  seed();
  commands.smooth_bake({ blur: 0 });
  assert.equal(log.blits.length, 0);
});

test("smooth_bake: colors map is first-hit-wins with base fallback; glow_regex is overridable", () => {
  seed();
  commands.smooth_bake({ colors: [{ match: "body", color: "#ff0000" }, { match: "body", color: "#00ff00" }] });
  assert.equal(plain(log.gradients[0].stops)[0][1], "rgb(255,0,0)");
  // Overriding the glow pattern reclassifies islands: cap glows, core bakes flat.
  seed();
  commands.smooth_bake({ glow_regex: "cap$" });
  assert.deepEqual(log.gradients.map((g) => g.stops.length), [2, 2, 2, 3]);
});

test("smooth_bake: scope + legacy selectors narrow the bake", () => {
  seed();
  let res = plain(commands.smooth_bake({ scope: "selected", elements: ["body"] }));
  assert.deepEqual([res.cubes, res.faces], [1, 2]);
  seed();
  res = plain(commands.smooth_bake({ cubes: ["eye_core"] }));
  assert.deepEqual([res.cubes, res.faces], [1, 1]);
  seed();
  assert.throws(() => commands.smooth_bake({ scope: "selected", elements: [] }), /Field "elements"/);
});

test("smooth_bake: errors name the remedy", () => {
  seed();
  sb.Texture.all = [];
  assert.throws(() => commands.smooth_bake({}), /No texture to paint on/);
  seed();
  assert.throws(() => commands.smooth_bake({ scope: "selected", elements: ["nope"] }), /No matching cubes/);
  seed();
  const had = sb.Project;
  sb.Project = undefined;
  try {
    assert.throws(() => commands.smooth_bake({}), /No project is open/);
  } finally {
    sb.Project = had;
  }
});
