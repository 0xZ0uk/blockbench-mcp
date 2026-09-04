/**
 * Measure math tests — drive the REAL bridge handlers (plugin/blockbench_mcp.js)
 * with stubbed Blockbench globals, no live Blockbench, no ports.
 *
 * The contract table + withFakeBridge tests pin the schemas clients see and
 * the handler pass-through; these tests pin the numbers: gap math, epsilon
 * semantics, overlap extents, and agreement between `measure clearance` and
 * the `check_model` audit (same shared scan, same thresholds).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

class Cube {
  constructor({ name, uuid, from, to, rotation = [0, 0, 0] }) {
    this.name = name;
    this.uuid = uuid ?? `uuid-${name}`;
    this.from = from;
    this.to = to;
    this.rotation = rotation;
    this.faces = {};
    this.parent = "root";
  }
}
class Group {
  constructor({ name, uuid, children = [] }) {
    this.name = name;
    this.uuid = uuid ?? `uuid-${name}`;
    this.children = children;
  }
}

const pluginPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../plugin/blockbench_mcp.js");
let src = fs.readFileSync(pluginPath, "utf8");
const cutAt = src.indexOf("// Plugin registration");
assert.ok(cutAt > 0, "plugin must contain the registration marker");
src = `${src.slice(0, cutAt)}\nglobalThis.__COMMANDS__ = commands;\n})();\n`;

const sb = {
  console, Buffer, JSON, Math, Object, Array, Number, String, Boolean, Infinity,
  Project: { texture_width: 16, texture_height: 16 },
  Format: { animation_mode: false },
  Formats: {},
  Group, Cube,
  Outliner: { elements: [] },
  Texture: { all: [] },
  Animation: { all: [] },
  Undo: { initEdit() {}, finishEdit() {} },
  Canvas: { updateAll() {} },
  Plugin: { register() {} },
  MenuBar: { addAction() {} },
  require: () => { throw new Error("net unavailable in tests"); },
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src, sb, { filename: "blockbench_mcp.js" });
const commands = sb.__COMMANDS__;
assert.ok(commands?.measure && commands?.check_model, "plugin must expose measure and check_model");

/** Seed stub Blockbench state. Cubes are plain {name, from, to} specs. */
function reset(cubeSpecs, groups = []) {
  const cubes = cubeSpecs.map((s) => new Cube(s));
  sb.Cube.all = cubes;
  sb.Group.all = groups;
  sb.Outliner.elements = [...cubes];
  return { cubes, groups };
}
/** vm-realm objects carry a different prototype: compare via JSON round-trip. */
const plain = (v) => JSON.parse(JSON.stringify(v));

test("measure distance: separated cubes return gap, delta, and distance with named axes", () => {
  reset([
    { name: "slide-a", from: [0, 0, 0], to: [4, 2, 4] },
    { name: "slide-b", from: [6, 0, 0], to: [10, 2, 4] },
  ]);
  const d = commands.measure({ mode: "distance", a: "slide-a", b: "slide-b" });
  assert.equal(d.mode, "distance");
  assert.equal(d.units, "model");
  assert.deepEqual(plain(d.gap), { x: 2, y: 0, z: 0 });
  assert.deepEqual(plain(d.delta), { x: 6, y: 0, z: 0 });
  assert.equal(d.distance, 2);
  assert.equal(d.overlapping, false);
  assert.deepEqual(Object.keys(plain(d.gap)).sort(), ["x", "y", "z"]);
});

test("measure distance: overlapping cubes report distance 0 and overlapping true", () => {
  reset([
    { name: "a", from: [0, 0, 0], to: [4, 2, 4] },
    { name: "b", from: [2, 1, 2], to: [6, 3, 6] },
  ]);
  const d = commands.measure({ mode: "distance", a: "a", b: "b" });
  assert.deepEqual(plain(d.gap), { x: 0, y: 0, z: 0 });
  assert.equal(d.distance, 0);
  assert.equal(d.overlapping, true);
});

test("measure distance: group refs resolve to the union box of descendant cubes", () => {
  reset([
    { name: "g1-cube", from: [0, 0, 0], to: [2, 2, 2] },
    { name: "slide", from: [10, 0, 0], to: [14, 2, 2] },
  ]);
  const grip = new Group({
    name: "grip",
    children: sb.Cube.all.filter((c) => c.name === "g1-cube"),
  });
  sb.Group.all = [grip];
  const d = commands.measure({ mode: "distance", a: "grip", b: "slide" });
  assert.equal(d.a.kind, "group");
  assert.equal(d.b.kind, "element");
  assert.deepEqual(plain(d.gap), { x: 8, y: 0, z: 0 });
  assert.equal(d.distance, 8);
});

test("measure clearance: hit echoes epsilon with overlap extent and agrees with check_model", () => {
  reset([
    { name: "slide-a", from: [0, 0, 0], to: [4, 4, 4] },
    { name: "slide-b", from: [0, 1, 1], to: [2, 5, 5] },
  ]);
  const c = commands.measure({ mode: "clearance" });
  assert.equal(c.mode, "clearance");
  assert.equal(c.units, "model");
  assert.equal(c.coplanar_epsilon, 0.02);
  assert.equal(c.overlap_min, 0.1);
  assert.equal(c.overlap_count, 1);
  assert.equal(plain(c.overlaps).length, 1);
  assert.deepEqual(plain(c.overlaps[0].cubes), ["slide-a", "slide-b"]);
  assert.equal(c.overlaps[0].axis, "x");
  assert.equal(c.overlaps[0].plane, 0);
  assert.deepEqual(plain(c.overlaps[0].overlap), { y: 3, z: 3 });
  const audit = commands.check_model();
  const cop = audit.issues.filter((i) => i.issue === "coplanar_overlap");
  assert.equal(cop.length, c.overlap_count, "clearance must agree with check_model");
  assert.deepEqual(plain(cop[0].cubes), ["slide-a", "slide-b"]);
  assert.equal(cop[0].axis, c.overlaps[0].axis);
  assert.equal(cop[0].plane, c.overlaps[0].plane);
});

test("measure clearance: clean model reports zero overlaps and the audit agrees", () => {
  reset([
    { name: "a", from: [0, 0, 0], to: [2, 2, 2] },
    { name: "b", from: [10, 10, 10], to: [12, 12, 12] },
  ]);
  const c = commands.measure({ mode: "clearance" });
  assert.equal(c.overlap_count, 0);
  assert.deepEqual(plain(c.overlaps), []);
  assert.equal(c.coplanar_epsilon, 0.02);
  assert.equal(
    commands.check_model().issues.filter((i) => i.issue === "coplanar_overlap").length,
    0
  );
});

test("measure clearance: rotated cubes are excluded like the audit", () => {
  reset([
    { name: "a", from: [0, 0, 0], to: [4, 4, 4] },
    { name: "b", from: [0, 1, 1], to: [2, 5, 5], rotation: [45, 0, 0] },
  ]);
  const c = commands.measure({ mode: "clearance" });
  assert.equal(c.overlap_count, 0, "rotated pair must not flag");
  assert.equal(c.scanned_cubes, 1);
});

test("measure clearance: overlap list is capped at 80 pairs", () => {
  const specs = [];
  for (let i = 0; i < 85; i++) {
    specs.push({ name: `c${i}`, from: [0, i * 0.2, 0], to: [4, i * 0.2 + 4, 4] });
  }
  reset(specs);
  const c = commands.measure({ mode: "clearance" });
  assert.ok(c.overlap_count <= 80, `cap 80 respected (got ${c.overlap_count})`);
  assert.ok(c.overlap_count > 0, "seeded scene must flag overlaps");
});

test("measure distance/clearance: errors name the offending field", () => {
  reset([{ name: "a", from: [0, 0, 0], to: [1, 1, 1] }]);
  assert.throws(() => commands.measure({ mode: "distance", b: "a" }), /Field "a"/);
  assert.throws(() => commands.measure({ mode: "distance", a: "a" }), /Field "b"/);
  assert.throws(() => commands.measure({ mode: "distance", a: "a", b: "nope" }), /Field "b" not found: nope/);
  assert.throws(() => commands.measure({ mode: "bogus" }), /Field "mode"/);
});
