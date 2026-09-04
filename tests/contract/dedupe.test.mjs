/**
 * Dedupe contract tests (ticket #19) — drive the REAL bridge handlers
 * (plugin/blockbench_mcp.js) with stubbed Blockbench globals, no live
 * Blockbench, no ports.
 *
 * Pins retry-safe bulk creation: with `dedupe_by_name`, a name match is
 * updated in place and flagged `updated: true` (no duplicate geometry);
 * without the flag, the legacy create-always path and result shape are
 * preserved exactly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

class Cube {
  constructor({ name, uuid, from, to, origin, rotation, inflate, autouv, box_uv, uv_offset }) {
    this.name = name;
    this.uuid = uuid ?? `uuid-${name}`;
    this.from = from;
    this.to = to;
    this.origin = origin;
    this.rotation = rotation;
    this.inflate = inflate;
    this.autouv = autouv;
    this.box_uv = box_uv;
    this.uv_offset = uv_offset;
    this.faces = {};
    this.parent = "root";
    this.type = "cube";
  }
  init() {
    sb.Outliner.elements.push(this);
    sb.Cube.all.push(this);
    return this;
  }
  addTo(parent) {
    this.parent = parent;
  }
}

class Group {
  constructor({ name, uuid, origin, rotation }) {
    this.name = name;
    this.uuid = uuid ?? `uuid-${name}`;
    this.origin = origin;
    this.rotation = rotation;
    this.children = [];
    this.parent = "root";
  }
  init() {
    sb.Group.all.push(this);
    return this;
  }
  addTo(parent) {
    if (parent && parent !== "root" && parent.children) parent.children.push(this);
    this.parent = parent || "root";
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
  Format: { box_uv: false },
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
assert.ok(commands?.add_cubes && commands?.add_groups, "plugin must expose add_cubes and add_groups");

/** Seed stub Blockbench state. */
function reset(cubeSpecs = [], groupNames = []) {
  sb.Cube.all = [];
  sb.Group.all = [];
  sb.Outliner.elements = [];
  for (const s of cubeSpecs) new Cube(s).init();
  for (const name of groupNames) new Group({ name }).init();
}

/** vm-realm objects carry a different prototype: compare via JSON round-trip. */
const plain = (v) => JSON.parse(JSON.stringify(v));

test("add_cubes dedupe: retried name matches update in place and flag updated:true", () => {
  reset([{ name: "slide-a", from: [0, 0, 0], to: [4, 2, 4] }]);
  const existing = sb.Cube.all[0];
  const res = commands.add_cubes({
    dedupe_by_name: true,
    cubes: [{ name: "slide-a", from: [10, 0, 0], to: [14, 4, 4] }],
  });
  assert.equal(res.created, 0);
  assert.equal(res.updated, 1);
  assert.equal(res.cubes.length, 1);
  assert.equal(res.cubes[0].updated, true);
  assert.equal(res.cubes[0].uuid, existing.uuid, "same element, not a duplicate");
  assert.equal(sb.Outliner.elements.length, 1, "no duplicate geometry");
  assert.deepEqual(plain(existing.from), [10, 0, 0]);
  assert.deepEqual(plain(existing.to), [14, 4, 4]);
});

test("add_cubes legacy (no flag): same retry duplicates exactly as before", () => {
  reset([{ name: "slide-a", from: [0, 0, 0], to: [4, 2, 4] }]);
  const res = commands.add_cubes({
    cubes: [{ name: "slide-a", from: [10, 0, 0], to: [14, 4, 4] }],
  });
  assert.equal(res.created, 1);
  assert.equal(res.updated, undefined);
  assert.equal(res.cubes.length, 1);
  assert.deepEqual(Object.keys(res).sort(), ["created", "cubes"], "legacy result shape");
  assert.equal(res.cubes.every((c) => c.updated === undefined), true);
  assert.equal(sb.Outliner.elements.length, 2, "legacy duplicate preserved");
});

test("add_cubes dedupe: duplicate names within one call collapse to one element", () => {
  reset([]);
  const res = commands.add_cubes({
    dedupe_by_name: true,
    cubes: [
      { name: "slide-a", from: [0, 0, 0], to: [4, 2, 4] },
      { name: "slide-a", from: [8, 0, 0], to: [12, 2, 4] },
    ],
  });
  assert.equal(res.created, 1);
  assert.equal(res.updated, 1);
  assert.equal(sb.Outliner.elements.length, 1);
  assert.deepEqual(plain(sb.Cube.all[0].from), [8, 0, 0], "last spec wins in place");
});

test("add_cubes dedupe: fresh names still create, without an updated flag", () => {
  reset([]);
  const res = commands.add_cubes({
    dedupe_by_name: true,
    cubes: [{ name: "fresh", from: [0, 0, 0], to: [4, 2, 4] }],
  });
  assert.equal(res.created, 1);
  assert.equal(res.updated, 0);
  assert.equal(res.cubes[0].updated, undefined);
  assert.equal(res.cubes[0].name, "fresh");
});

test("add_cubes dedupe: partial spec patches only provided fields", () => {
  reset([{ name: "slide-a", from: [0, 0, 0], to: [4, 2, 4] }]);
  const res = commands.add_cubes({
    dedupe_by_name: true,
    cubes: [{ name: "slide-a", from: [10, 0, 0] }],
  });
  assert.equal(res.updated, 1);
  assert.equal(sb.Outliner.elements.length, 1);
  assert.deepEqual(plain(sb.Cube.all[0].from), [10, 0, 0]);
  assert.deepEqual(plain(sb.Cube.all[0].to), [4, 2, 4], "missing `to` must not reset geometry");
});

test("add_cubes dedupe: only same-kind matches update (group name does not block a cube)", () => {
  reset([], ["slide-a"]);
  const res = commands.add_cubes({
    dedupe_by_name: true,
    cubes: [{ name: "slide-a", from: [0, 0, 0], to: [4, 2, 4] }],
  });
  assert.equal(res.created, 1);
  assert.equal(res.updated, 0);
  assert.equal(res.cubes[0].type, "cube");
});

test("add_groups dedupe: retried name matches update in place and flag updated:true", () => {
  reset([], ["body"]);
  const existing = sb.Group.all[0];
  const res = commands.add_groups({
    dedupe_by_name: true,
    groups: [{ name: "body", origin: [1, 2, 3], rotation: [0, 45, 0] }],
  });
  assert.equal(res.created, 0);
  assert.equal(res.updated, 1);
  assert.equal(res.groups.length, 1);
  assert.equal(res.groups[0].updated, true);
  assert.equal(res.groups[0].uuid, existing.uuid);
  assert.equal(sb.Group.all.length, 1, "no duplicate bone");
  assert.deepEqual(plain(existing.origin), [1, 2, 3]);
  assert.deepEqual(plain(existing.rotation), [0, 45, 0]);
});

test("add_groups legacy (no flag): same retry duplicates exactly as before", () => {
  reset([], ["body"]);
  const res = commands.add_groups({
    groups: [{ name: "body", origin: [1, 2, 3] }],
  });
  assert.equal(res.created, 1);
  assert.equal(res.updated, undefined);
  assert.deepEqual(Object.keys(res).sort(), ["created", "groups"], "legacy result shape");
  assert.equal(sb.Group.all.length, 2, "legacy duplicate preserved");
});

test("add_cubes dedupe: only the strict boolean true enables dedupe at the bridge", () => {
  reset([{ name: "slide-a", from: [0, 0, 0], to: [4, 2, 4] }]);
  const res = commands.add_cubes({
    dedupe_by_name: "yes",
    cubes: [{ name: "slide-a", from: [10, 0, 0], to: [14, 4, 4] }],
  });
  assert.equal(res.updated, undefined, "non-boolean truthy stays legacy");
  assert.equal(sb.Outliner.elements.length, 2);
});

test("add_groups dedupe: fresh names still create, without an updated flag", () => {
  reset([]);
  const res = commands.add_groups({
    dedupe_by_name: true,
    groups: [{ name: "arm" }],
  });
  assert.equal(res.created, 1);
  assert.equal(res.updated, 0);
  assert.equal(res.groups[0].updated, undefined);
  assert.equal(res.groups[0].name, "arm");
});

test("add_groups dedupe: duplicate names within one call collapse to one group", () => {
  reset([]);
  const res = commands.add_groups({
    dedupe_by_name: true,
    groups: [
      { name: "body", origin: [0, 0, 0] },
      { name: "body", origin: [5, 5, 5] },
    ],
  });
  assert.equal(res.created, 1);
  assert.equal(res.updated, 1);
  assert.equal(sb.Group.all.length, 1);
  assert.deepEqual(plain(sb.Group.all[0].origin), [5, 5, 5], "last spec wins in place");
});

test("add_cubes dedupe: mixed batch reports created and updated separately", () => {
  reset([{ name: "existing", from: [0, 0, 0], to: [4, 2, 4] }]);
  const res = commands.add_cubes({
    dedupe_by_name: true,
    cubes: [
      { name: "existing", from: [1, 1, 1], to: [5, 3, 5] },
      { name: "brand-new", from: [0, 0, 8], to: [4, 2, 12] },
    ],
  });
  assert.equal(res.created, 1);
  assert.equal(res.updated, 1);
  assert.equal(sb.Outliner.elements.length, 2);
  assert.equal(res.cubes[0].updated, true);
  assert.equal(res.cubes[1].updated, undefined);
});

test("add_cubes dedupe: existing item is reparented when spec.parent is given", () => {
  reset([{ name: "part", from: [0, 0, 0], to: [4, 2, 4] }]);
  const arm = new Group({ name: "arm" }).init();
  const part = sb.Cube.all[0];
  const res = commands.add_cubes({
    dedupe_by_name: true,
    cubes: [{ name: "part", from: [0, 0, 0], to: [4, 2, 4], parent: "arm" }],
  });
  assert.equal(res.updated, 1);
  assert.equal(sb.Outliner.elements.length, 1);
  assert.equal(part.parent, arm, "reparented in place, not duplicated");
});

test("add_groups dedupe: existing item is reparented when spec.parent is given", () => {
  reset([], ["body"]);
  const root = new Group({ name: "root" }).init();
  const body = sb.Group.all.find((g) => g.name === "body");
  const res = commands.add_groups({
    dedupe_by_name: true,
    groups: [{ name: "body", parent: "root" }],
  });
  assert.equal(res.updated, 1);
  assert.equal(sb.Group.all.length, 2, "seeded body + root; no duplicate of body");
  assert.equal(body.parent, root, "reparented in place, not duplicated");
});
