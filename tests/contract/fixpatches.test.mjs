/**
 * Fix-patch tests — drive the REAL bridge handler (plugin/blockbench_mcp.js
 * check_model) with stubbed Blockbench globals, no live Blockbench, no ports.
 *
 * Table-driven per ticket #21: every issue kind that can emit a structured
 * `fix` patch does, with `tool` + `fix` directly usable as arguments to the
 * named tool (replayed against the published tool input schema from
 * dist/tools.js). Invalid/undecidable cases omit `fix` entirely.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { tools } from "../../dist/tools.js";
import { validateAgainstSchema } from "./validator.mjs";

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
assert.ok(commands?.check_model, "plugin must expose check_model");

/** vm-realm objects carry a different prototype: compare via JSON round-trip. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Seed stub Blockbench state; textures/groups are plain {name,uuid} specs.
 *  NOTE: schema replay imports dist/tools.js — run `npm test` (builds first)
 *  or `pnpm build` before running this file standalone. */
function reset(cubeSpecs, { textures = [], groups = [], animMode = false } = {}) {
  const cubes = cubeSpecs.map((s) => new Cube(s));
  sb.Cube.all = cubes;
  sb.Group.all = groups.map((g) => new Group(g));
  sb.Outliner.elements = [...cubes];
  sb.Texture.all = textures.map((t) => ({ name: t.name ?? null, uuid: t.uuid ?? `uuid-${t.name}` }));
  sb.Format.animation_mode = animMode;
  return { cubes };
}

/** Find the first issue of a kind in the audit result. */
const issueOf = (audit, kind) => audit.issues.find((i) => i.issue === kind);
const toolSchema = (name) => {
  const t = tools.find((t) => t.name === name);
  assert.ok(t, `published tool must exist: ${name}`);
  return t.inputSchema;
};

// ---- table-driven fix-patch cases -----------------------------------------
// `expect` is the issue-kind matcher; `present` asserts the fix shape (or its
// absence). Every present fix is replayed against the named tool's schema.
const cases = [
  {
    id: "coplanar-overlap-nudge",
    kind: "coplanar_overlap",
    cubes: [
      { name: "slide-a", from: [0, 0, 0], to: [4, 4, 4] },
      { name: "slide-b", from: [0, 1, 1], to: [2, 5, 5] },
    ],
    assert(audit) {
      const issue = issueOf(audit, "coplanar_overlap");
      assert.ok(issue, "coplanar_overlap must be reported");
      assert.equal(issue.fix.tool, "edit_elements");
      assert.equal(issue.fix.element, "slide-b");
      assert.equal(issue.fix.issue, "coplanar_overlap");
      const edits = issue.fix.fix.edits;
      assert.equal(edits.length, 1);
      assert.equal(edits[0].element, "slide-b");
      // Nudge must be >= OVERLAP_MIN (0.1) on the reported axis (x here).
      assert.equal(edits[0].patch.from[0], 0.1);
      assert.equal(edits[0].patch.to[0], 2.1);
      assert.deepEqual(plain(edits[0].patch.from.slice(1)), [1, 1]);
      assert.deepEqual(plain(edits[0].patch.to.slice(1)), [5, 5]);
      return issue;
    },
  },
  {
    id: "no-texture-single-texture-assigns-flagged-face",
    kind: "no_texture",
    cubes: [
      {
        name: "head",
        from: [0, 0, 0],
        to: [2, 2, 2],
        faces: { up: { texture: false, uv: [0, 0, 2, 2] }, down: { texture: "uuid-skin", uv: [0, 0, 2, 2] } },
      },
    ],
    setup: { textures: [{ name: "skin" }] },
    assert(audit) {
      const issue = issueOf(audit, "no_texture");
      assert.ok(issue, "no_texture must be reported");
      assert.equal(issue.cube, "head");
      assert.equal(issue.face, "up");
      assert.equal(issue.fix.tool, "set_cube_uv");
      assert.equal(issue.fix.element, "head");
      assert.deepEqual(plain(issue.fix.fix), { cube: "head", faces: { up: { texture: "skin" } } });
      return issue;
    },
  },
  {
    id: "no-texture-two-textures-undecidable-omit",
    kind: "no_texture",
    cubes: [{ name: "head", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: false, uv: [0, 0, 2, 2] } } }],
    setup: { textures: [{ name: "skin" }, { name: "eyes" }] },
    assert(audit) {
      const issue = issueOf(audit, "no_texture");
      assert.ok(issue, "no_texture must be reported");
      assert.equal(issue.fix, undefined, "ambiguous texture choice must omit fix");
      return issue;
    },
  },
  {
    id: "no-texture-no-textures-omit",
    kind: "no_texture",
    cubes: [{ name: "head", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: false, uv: [0, 0, 2, 2] } } }],
    assert(audit) {
      const issue = issueOf(audit, "no_texture");
      assert.ok(issue, "no_texture must be reported");
      assert.equal(issue.fix, undefined, "no texture to assign must omit fix");
      return issue;
    },
  },
  {
    id: "zero-uv-omit",
    kind: "zero_uv",
    cubes: [{ name: "head", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: "uuid-skin", uv: [3, 3, 3, 5] } } }],
    setup: { textures: [{ name: "skin" }] },
    assert(audit) {
      const issue = issueOf(audit, "zero_uv");
      assert.ok(issue, "zero_uv must be reported");
      assert.equal(issue.fix, undefined, "zero-area UV has no safe region to derive; fix must be omitted");
      return issue;
    },
  },
  {
    id: "uv-out-of-bounds-clamps-into-bounds",
    kind: "uv_out_of_bounds",
    cubes: [{ name: "head", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: "uuid-skin", uv: [12, 0, 20, 8] } } }],
    setup: { textures: [{ name: "skin" }] },
    assert(audit) {
      const issue = issueOf(audit, "uv_out_of_bounds");
      assert.ok(issue, "uv_out_of_bounds must be reported");
      assert.equal(issue.fix.tool, "set_cube_uv");
      assert.equal(issue.fix.element, "head");
      assert.deepEqual(plain(issue.fix.fix), { cube: "head", faces: { up: { uv: [12, 0, 16, 8] } } });
      return issue;
    },
  },
  {
    id: "uv-out-of-bounds-degenerate-clamp-omits",
    kind: "uv_out_of_bounds",
    cubes: [{ name: "head", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: "uuid-skin", uv: [20, 0, 24, 8] } } }],
    setup: { textures: [{ name: "skin" }] },
    assert(audit) {
      const issue = issueOf(audit, "uv_out_of_bounds");
      assert.ok(issue, "uv_out_of_bounds must be reported");
      assert.equal(issue.fix, undefined, "clamp that degenerates the UV must omit fix");
      return issue;
    },
  },
  {
    id: "degenerate-size-restore-1-unit-extent",
    kind: "degenerate_size",
    cubes: [{ name: "fin", from: [3, 4, 5], to: [3, 8, 9] }],
    assert(audit) {
      const issue = issueOf(audit, "degenerate_size");
      assert.ok(issue, "degenerate_size must be reported");
      assert.deepEqual(plain(issue.size), [0, 4, 4]);
      assert.equal(issue.fix.tool, "edit_element");
      assert.equal(issue.fix.element, "fin");
      assert.deepEqual(plain(issue.fix.fix), { element: "fin", from: [3, 4, 5], to: [4, 8, 9] });
      return issue;
    },
  },
  {
    id: "no-bone-parent-single-bone-attach",
    kind: "no_bone_parent",
    cubes: [{ name: "arm", from: [0, 0, 0], to: [2, 2, 2] }],
    setup: { groups: [{ name: "body" }], animMode: true },
    assert(audit) {
      const issue = issueOf(audit, "no_bone_parent");
      assert.ok(issue, "no_bone_parent must be reported");
      assert.equal(issue.fix.tool, "edit_element");
      assert.equal(issue.fix.element, "arm");
      assert.deepEqual(plain(issue.fix.fix), { element: "arm", parent: "body" });
      return issue;
    },
  },
  {
    id: "no-bone-parent-multiple-bones-undecidable-omit",
    kind: "no_bone_parent",
    cubes: [{ name: "arm", from: [0, 0, 0], to: [2, 2, 2] }],
    setup: { groups: [{ name: "body" }, { name: "head-bone" }], animMode: true },
    assert(audit) {
      const issue = issueOf(audit, "no_bone_parent");
      assert.ok(issue, "no_bone_parent must be reported");
      assert.equal(issue.fix, undefined, "ambiguous bone choice must omit fix");
      return issue;
    },
  },
  {
    id: "no-texture-unnamed-texture-falls-back-to-uuid",
    kind: "no_texture",
    cubes: [{ name: "head", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: false, uv: [0, 0, 2, 2] } } }],
    setup: { textures: [{ uuid: "uuid-anon" }] },
    assert(audit) {
      const issue = issueOf(audit, "no_texture");
      assert.ok(issue, "no_texture must be reported");
      assert.equal(issue.fix.tool, "set_cube_uv");
      assert.deepEqual(plain(issue.fix.fix), { cube: "head", faces: { up: { texture: "uuid-anon" } } });
      return issue;
    },
  },
  {
    id: "no-bone-parent-zero-bones-omit",
    kind: "no_bone_parent",
    cubes: [{ name: "arm", from: [0, 0, 0], to: [2, 2, 2] }],
    setup: { animMode: true },
    assert(audit) {
      const issue = issueOf(audit, "no_bone_parent");
      assert.ok(issue, "no_bone_parent must be reported");
      assert.equal(issue.fix, undefined, "no bone to attach to must omit fix");
      return issue;
    },
  },
];

for (const c of cases) {
  test(`fix patch: ${c.id}`, () => {
    reset(c.cubes, c.setup ?? {});
    const audit = plain(commands.check_model({}));
    const issue = c.assert(audit);
    if (issue.fix) {
      const result = validateAgainstSchema(toolSchema(issue.fix.tool), issue.fix.fix, "");
      assert.ok(result.ok, `fix payload must satisfy ${issue.fix.tool} schema: ${result.message ?? ""}`);
    }
  });
}

test("fix patch: backward-compatible result shape (issue_count, by_type, issues unchanged; fix optional)", () => {
  reset([
    { name: "slide-a", from: [0, 0, 0], to: [4, 4, 4] },
    { name: "slide-b", from: [0, 1, 1], to: [2, 5, 5] },
    { name: "fin", from: [3, 4, 5], to: [3, 8, 9] },
  ]);
  const audit = plain(commands.check_model({}));
  assert.equal(audit.issue_count, audit.issues.length);
  assert.equal(audit.issue_count, 2);
  assert.deepEqual(plain(audit.by_type), { coplanar_overlap: 1, degenerate_size: 1 });
  assert.deepEqual(plain(audit.texture_size), [16, 16]);
  assert.equal(audit.animation_format, false);
  for (const issue of audit.issues) {
    if (!("fix" in issue)) continue;
    assert.ok(typeof issue.fix.tool === "string", "fix.tool must name a tool");
    assert.ok(issue.fix.element, "fix.element must name the target element");
    assert.equal(issue.fix.issue, issue.issue, "fix.issue must match the parent issue");
    assert.ok(issue.fix.fix && typeof issue.fix.fix === "object", "fix.fix must be an object");
  }
});

test("fix patch: clean model emits zero issues and no fix anywhere", () => {
  reset([
    {
      name: "cube",
      from: [0, 0, 0],
      to: [2, 2, 2],
      faces: { up: { texture: "uuid-skin", uv: [0, 0, 2, 2] } },
    },
  ], { textures: [{ name: "skin" }] });
  const audit = plain(commands.check_model({}));
  assert.equal(audit.issue_count, 0);
  assert.deepEqual(plain(audit.issues), []);
  assert.deepEqual(plain(audit.by_type), {});
});
