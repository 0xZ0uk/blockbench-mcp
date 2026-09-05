/**
 * Gate-summary tests — drive the REAL bridge handler (plugin/blockbench_mcp.js
 * check_model) with stubbed Blockbench globals, no live Blockbench, no ports.
 *
 * Table-driven per ticket #22: the top-level `gate: {errors, warnings,
 * gate_pass}` classifies each issue kind explicitly (errors =
 * degenerate_size + zero_uv + uv_out_of_bounds + coplanar_overlap; warnings
 * = no_texture + no_bone_parent), gate_pass is true iff errors == 0, and the
 * existing issue list shape is unchanged (gate is purely additive).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

class Cube {
  constructor({ name, uuid, from, to, rotation = [0, 0, 0], faces = {} }) {
    this.name = name;
    this.uuid = uuid ?? `uuid-${name}`;
    this.from = from;
    this.to = to;
    this.rotation = rotation;
    this.faces = faces;
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
src = `${src.slice(0, cutAt)}\nglobalThis.__COMMANDS__ = commands;\nglobalThis.__GATE__ = { GATE_SEVERITY, summarizeGate };\n})();\n`;

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
assert.ok(commands?.check_model, "plugin must expose check_model");
const { GATE_SEVERITY, summarizeGate } = sb.__GATE__;
assert.ok(GATE_SEVERITY && summarizeGate, "plugin must expose gate classification for tests");

/** vm-realm objects carry a different prototype: compare via JSON round-trip. */
const plain = (v) => JSON.parse(JSON.stringify(v));

function reset(cubeSpecs, { textures = [], groups = [], animMode = false } = {}) {
  const cubes = cubeSpecs.map((s) => new Cube(s));
  sb.Cube.all = cubes;
  sb.Group.all = groups.map((g) => new Group(g));
  sb.Outliner.elements = [...cubes];
  sb.Texture.all = textures.map((t) => ({ name: t.name ?? null, uuid: t.uuid ?? `uuid-${t.name}` }));
  sb.Format.animation_mode = animMode;
  return { cubes };
}

// ---- table-driven gate cases -------------------------------------------
// Each fixture isolates (as far as possible) the named kind(s); `gate` is
// the asserted {errors, warnings, gate_pass} triple.
const cases = [
  {
    id: "clean-model-passes",
    cubes: [
      { name: "cube", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: "uuid-skin", uv: [0, 0, 2, 2] } } },
    ],
    setup: { textures: [{ name: "skin" }] },
    gate: { errors: 0, warnings: 0, gate_pass: true },
  },
  {
    id: "only-no-texture-warning-passes",
    cubes: [
      { name: "head", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: false, uv: [0, 0, 2, 2] } } },
    ],
    gate: { errors: 0, warnings: 1, gate_pass: true },
  },
  {
    id: "only-no-bone-parent-warning-passes",
    cubes: [{ name: "arm", from: [0, 0, 0], to: [2, 2, 2] }],
    setup: { groups: [{ name: "body" }], animMode: true },
    gate: { errors: 0, warnings: 1, gate_pass: true },
  },
  {
    id: "warnings-only-mixed-still-passes",
    cubes: [
      { name: "arm", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: false, uv: [0, 0, 2, 2] } } },
    ],
    setup: { groups: [{ name: "body" }], animMode: true },
    gate: { errors: 0, warnings: 2, gate_pass: true },
  },
  {
    id: "degenerate-size-error-fails",
    cubes: [{ name: "fin", from: [3, 4, 5], to: [3, 8, 9] }],
    gate: { errors: 1, warnings: 0, gate_pass: false },
  },
  {
    id: "zero-uv-error-fails",
    cubes: [
      { name: "head", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: "uuid-skin", uv: [3, 3, 3, 5] } } },
    ],
    setup: { textures: [{ name: "skin" }] },
    gate: { errors: 1, warnings: 0, gate_pass: false },
  },
  {
    id: "uv-out-of-bounds-error-fails",
    cubes: [
      { name: "head", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: "uuid-skin", uv: [12, 0, 20, 8] } } },
    ],
    setup: { textures: [{ name: "skin" }] },
    gate: { errors: 1, warnings: 0, gate_pass: false },
  },
  {
    id: "coplanar-overlap-error-fails",
    cubes: [
      { name: "slide-a", from: [0, 0, 0], to: [4, 4, 4] },
      { name: "slide-b", from: [0, 1, 1], to: [2, 5, 5] },
    ],
    gate: { errors: 1, warnings: 0, gate_pass: false },
  },
  {
    id: "two-degenerate-cubes-count-per-issue",
    cubes: [
      { name: "fin-a", from: [3, 4, 5], to: [3, 8, 9] },
      { name: "fin-b", from: [10, 10, 10], to: [10, 12, 14] },
    ],
    gate: { errors: 2, warnings: 0, gate_pass: false },
  },
  {
    id: "error-plus-warning-mixed-fails-with-counts",
    cubes: [
      { name: "fin", from: [3, 4, 5], to: [3, 8, 9], faces: { up: { texture: false, uv: [0, 0, 2, 2] } } },
    ],
    gate: { errors: 1, warnings: 1, gate_pass: false },
  },
];

for (const c of cases) {
  test(`gate summary: ${c.id}`, () => {
    reset(c.cubes, c.setup ?? {});
    const audit = plain(commands.check_model({}));
    assert.ok(audit.gate, "check_model result must include gate");
    assert.deepEqual(audit.gate, c.gate);
    assert.equal(audit.gate.errors + audit.gate.warnings, audit.issue_count);
  });
}

test("gate summary: additive — issue list shape unchanged", () => {
  reset([
    { name: "slide-a", from: [0, 0, 0], to: [4, 4, 4] },
    { name: "slide-b", from: [0, 1, 1], to: [2, 5, 5] },
    { name: "fin", from: [3, 4, 5], to: [3, 8, 9] },
  ]);
  const audit = plain(commands.check_model({}));
  assert.equal(audit.issue_count, audit.issues.length);
  assert.equal(audit.issue_count, 2);
  assert.deepEqual(audit.by_type, { coplanar_overlap: 1, degenerate_size: 1 });
  assert.deepEqual(audit.gate, { errors: 2, warnings: 0, gate_pass: false });
  assert.equal(typeof audit.gate.errors, "number");
  assert.equal(typeof audit.gate.warnings, "number");
  assert.equal(typeof audit.gate.gate_pass, "boolean");
});

test("gate summary: classification map is explicit and fail-closed", () => {
  assert.deepEqual(plain(GATE_SEVERITY), {
    degenerate_size: "error",
    zero_uv: "error",
    uv_out_of_bounds: "error",
    coplanar_overlap: "error",
    gap_slit: "error",
    see_through_opening: "warning",
    floating_piece: "warning",
    no_texture: "warning",
    no_bone_parent: "warning",
  });
  // Unknown future kinds default to error so the gate never silently passes
  // an unclassified problem — including names inherited from Object.prototype.
  assert.deepEqual(plain(summarizeGate([{ issue: "future_kind" }])), { errors: 1, warnings: 0, gate_pass: false });
  assert.deepEqual(plain(summarizeGate([{ issue: "toString" }])), { errors: 1, warnings: 0, gate_pass: false });
  assert.deepEqual(plain(summarizeGate([{ issue: "constructor" }])), { errors: 1, warnings: 0, gate_pass: false });
  assert.deepEqual(plain(summarizeGate([])), { errors: 0, warnings: 0, gate_pass: true });
  assert.deepEqual(plain(summarizeGate()), { errors: 0, warnings: 0, gate_pass: true });
});

test("gate summary: summarizeGate is pure (no input mutation)", () => {
  const issues = [{ issue: "no_texture" }, { issue: "degenerate_size" }];
  const gate = plain(summarizeGate(issues));
  assert.deepEqual(gate, { errors: 1, warnings: 1, gate_pass: false });
  assert.deepEqual(plain(issues), [{ issue: "no_texture" }, { issue: "degenerate_size" }]);
});
