/**
 * query_elements tests — drive the REAL bridge handler (plugin/blockbench_mcp.js)
 * with stubbed Blockbench globals, no live Blockbench, no ports (ticket #24).
 *
 * The contract table pins the schema clients see; these tests pin the lookup
 * math: regex/parent filtering, honest `total` (matches BEFORE pagination),
 * limit/offset paging, the empty result shape, and errors that name the field.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

class Cube {
  constructor({ name, uuid, from = [0, 0, 0], to = [1, 1, 1] }) {
    this.name = name;
    this.uuid = uuid ?? `uuid-${name}`;
    this.from = from;
    this.to = to;
    this.parent = "root";
    this.type = "cube";
  }
}
class Group {
  constructor({ name, uuid, children = [], parent = "root" }) {
    this.name = name;
    this.uuid = uuid ?? `uuid-${name}`;
    this.children = children;
    this.parent = parent;
    this.type = "group";
    for (const c of children) c.parent = this;
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
  Outliner: { elements: [], root: [] },
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
assert.ok(commands?.query_elements, "plugin must expose query_elements");

/** vm-realm objects carry a different prototype: compare via JSON round-trip. */
const plain = (v) => JSON.parse(JSON.stringify(v));
const names = (q) => plain(q.refs).map((r) => r.name);

/** Seed a small hierarchy: two bones, one with a nested child bone and cubes. */
function seed() {
  const cubes = [
    new Cube({ name: "Left leg" }),
    new Cube({ name: "Right Leg" }),
    new Cube({ name: "arm_upper" }),
    new Cube({ name: "torso" }),
    new Cube({ name: "ear_tip" }),
    new Cube({ name: "head" }),
  ];
  const lowerLeg = new Group({ name: "lower_leg", children: [cubes[0]] });
  const legs = new Group({ name: "legs", children: [lowerLeg, cubes[1]] });
  const arms = new Group({ name: "arms", children: [cubes[2]] });
  const head = new Group({ name: "head_bone", children: [cubes[4], cubes[5]] });
  sb.Group.all = [legs, lowerLeg, arms, head];
  sb.Outliner.elements = [...cubes];
  sb.Outliner.root = [legs, arms, head];
  return { cubes, groups: sb.Group.all };
}

test("query_elements: no filters returns every node (groups AND elements) in tree order", () => {
  seed();
  const q = commands.query_elements({});
  assert.deepEqual(Object.keys(plain(q)).sort(), ["offset", "refs", "total"]);
  assert.equal(q.total, q.refs.length);
  assert.equal(q.offset, 0);
  assert.deepEqual(names(q), [
    "legs", "lower_leg", "Left leg", "Right Leg", "arms", "arm_upper", "head_bone", "ear_tip", "head",
  ]);
  // Refs are {name, uuid} only — directly addressable into edit/measure.
  assert.deepEqual(plain(q.refs[0]), { name: "legs", uuid: "uuid-legs" });
});

test("query_elements: regex filters by name case-insensitively", () => {
  seed();
  assert.deepEqual(names(commands.query_elements({ regex: "^leg" })), ["legs"]);
  assert.deepEqual(names(commands.query_elements({ regex: "LEG$" })), ["lower_leg", "Left leg", "Right Leg"]);
  assert.deepEqual(names(commands.query_elements({ regex: "ARM|EAR" })), ["arms", "arm_upper", "ear_tip"]);
  // Honest empty shape.
  const none = commands.query_elements({ regex: "no-such-part" });
  assert.deepEqual(plain(none), { refs: [], total: 0, offset: 0 });
});

test("query_elements: parent filters to DIRECT children only (name or uuid)", () => {
  seed();
  const legs = sb.Group.all.find((g) => g.name === "legs");
  assert.deepEqual(names(commands.query_elements({ parent: "legs" })), ["lower_leg", "Right Leg"]);
  assert.deepEqual(names(commands.query_elements({ parent: legs.uuid })), ["lower_leg", "Right Leg"]);
  // The nested grandchild "Left leg" is NOT a direct child of "legs".
  assert.ok(!names(commands.query_elements({ parent: "legs" })).includes("Left leg"));
  // No matching child: empty result shape, honest total.
  const empty = commands.query_elements({ parent: "arms", regex: "nope" });
  assert.deepEqual(plain(empty), { refs: [], total: 0, offset: 0 });
});

test("query_elements: regex + parent compose (filter-first, then paging)", () => {
  seed();
  assert.deepEqual(names(commands.query_elements({ parent: "legs", regex: "leg" })), [
    "lower_leg", "Right Leg",
  ]);
  assert.deepEqual(names(commands.query_elements({ parent: "head_bone", regex: "^EAR" })), ["ear_tip"]);
});

test("query_elements: limit/offset page through with honest total", () => {
  seed();
  const all = commands.query_elements({});
  const page1 = commands.query_elements({ limit: 3 });
  const page2 = commands.query_elements({ limit: 3, offset: 3 });
  const page3 = commands.query_elements({ limit: 3, offset: 6 });
  const page4 = commands.query_elements({ limit: 3, offset: 9 });
  assert.equal(page1.total, all.total);
  assert.equal(page2.total, all.total);
  assert.deepEqual(names(page1), ["legs", "lower_leg", "Left leg"]);
  assert.deepEqual(names(page2), ["Right Leg", "arms", "arm_upper"]);
  assert.deepEqual(names(page3), ["head_bone", "ear_tip", "head"]);
  assert.deepEqual(names(page4), []);
  assert.equal(page2.offset, 3);
  assert.equal(page3.offset, 6);
  assert.equal(page4.offset, 9);
  // offset beyond total: empty page, total stays honest.
  const past = commands.query_elements({ limit: 3, offset: 99 });
  assert.deepEqual(plain(past), { refs: [], total: all.total, offset: 99 });
});

test("query_elements: total counts matches BEFORE pagination", () => {
  seed();
  const q = commands.query_elements({ regex: "leg", limit: 1, offset: 2 });
  assert.equal(q.refs.length, 1);
  assert.equal(q.total, 4, "matches: legs, lower_leg, Left leg, Right Leg");
  assert.equal(q.offset, 2);
});

test("query_elements: errors name the offending field", () => {
  seed();
  assert.throws(() => commands.query_elements({ regex: "(unclosed" }), /Field "regex"/);
  assert.throws(() => commands.query_elements({ parent: "no-such-bone" }), /Field "parent" not found: no-such-bone/);
  assert.throws(() => commands.query_elements({ limit: 0 }), /Field "limit"/);
  assert.throws(() => commands.query_elements({ limit: -2 }), /Field "limit"/);
  assert.throws(() => commands.query_elements({ limit: 1.5 }), /Field "limit"/);
  assert.throws(() => commands.query_elements({ offset: -1 }), /Field "offset"/);
  assert.throws(() => commands.query_elements({ offset: 2.5 }), /Field "offset"/);
});

test("query_elements: no project open names the remedy", () => {
  const had = sb.Project;
  sb.Project = undefined;
  try {
    assert.throws(() => commands.query_elements({}), /No project is open/);
  } finally {
    sb.Project = had;
  }
});
