/**
 * Done-gate tests — drive the REAL bridge handlers (plugin/blockbench_mcp.js
 * check_model + save_project) with stubbed Blockbench globals, no live
 * Blockbench, no ports.
 *
 * Table-driven per ticket #23: save_project never blocks on gate state, but
 * carries an advisory `warning` when the most recent check_model gate did not
 * pass (gate_pass false). No warning when the gate passed or when no check
 * has run yet. Each test loads a FRESH plugin instance so the remembered
 * gate state never leaks between cases.
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
const pluginSrc = fs.readFileSync(pluginPath, "utf8");
const cutAt = pluginSrc.indexOf("// Plugin registration");
assert.ok(cutAt > 0, "plugin must contain the registration marker");

/** Load a fresh plugin instance: fresh vm realm, fresh remembered gate (none). */
function loadPlugin() {
  const src = `${pluginSrc.slice(0, cutAt)}\nglobalThis.__COMMANDS__ = commands;\n})();\n`;
  let saveTriggers = 0;
  const sb = {
    console, Buffer, JSON, Math, Object, Array, Number, String, Boolean, Infinity,
    Project: { texture_width: 16, texture_height: 16 },
    Format: { animation_mode: false },
    Formats: { free: { id: "free", name: "Free", animation_mode: false, box_uv: false } },
    Blockbench: { version: "test" },
    Mode: { selected: null },
    newProject: () => true,
    Codecs: { project: { load() {} } },
    Group, Cube,
    Outliner: { elements: [] },
    Texture: { all: [] },
    Animation: { all: [] },
    Undo: { initEdit() {}, finishEdit() {} },
    Canvas: { updateAll() {} },
    Plugin: { register() {} },
    MenuBar: { addAction() {} },
    BarItems: { save_project: { trigger() { saveTriggers++; } } },
    isApp: false,
    require: (name) => {
      if (name === "fs") return { readFileSync: () => '{"meta":{}}', writeFileSync() {} };
      throw new Error("net unavailable in tests");
    },
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(src, sb, { filename: "blockbench_mcp.js" });
  const commands = sb.__COMMANDS__;
  assert.ok(commands?.check_model, "plugin must expose check_model");
  assert.ok(commands?.save_project, "plugin must expose save_project");
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
  return { commands, plain, reset, sb, saveCount: () => saveTriggers };
}

test("done-gate: save with no prior check carries no warning", async () => {
  const { commands, plain } = loadPlugin();
  const saved = plain(await commands.save_project({}));
  assert.equal(saved.saved, true);
  assert.ok(!("warning" in saved), "no check has run, so no warning is expected");
});

test("done-gate: failing gate warns but save still succeeds", async () => {
  const { commands, plain, reset, saveCount } = loadPlugin();
  reset([{ name: "fin", from: [3, 4, 5], to: [3, 8, 9] }]);
  const audit = plain(commands.check_model({}));
  assert.equal(audit.gate.gate_pass, false);
  const saved = plain(await commands.save_project({}));
  assert.equal(saved.saved, true);
  assert.equal(saveCount(), 1);
  assert.equal(typeof saved.warning, "string");
  assert.ok(saved.warning.includes("gate"), "warning must name the done-gate");
  assert.ok(saved.warning.includes("1 error"), "warning must carry the error count");
});

test("done-gate: passing gate saves without warning", async () => {
  const { commands, plain, reset } = loadPlugin();
  reset(
    [{ name: "cube", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: "uuid-skin", uv: [0, 0, 2, 2] } } }],
    { textures: [{ name: "skin" }] },
  );
  const audit = plain(commands.check_model({}));
  assert.equal(audit.gate.gate_pass, true);
  const saved = plain(await commands.save_project({}));
  assert.equal(saved.saved, true);
  assert.ok(!("warning" in saved), "passed gate must not warn");
});

test("done-gate: warnings-only gate still passes, so no warning", async () => {
  const { commands, plain, reset } = loadPlugin();
  reset([{ name: "head", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: false, uv: [0, 0, 2, 2] } } }]);
  const audit = plain(commands.check_model({}));
  assert.deepEqual(audit.gate, { errors: 0, warnings: 1, gate_pass: true });
  const saved = plain(await commands.save_project({}));
  assert.equal(saved.saved, true);
  assert.ok(!("warning" in saved), "warnings do not fail the gate, so no warning is expected");
});

test("done-gate: project lifecycle forgets the remembered gate", async () => {
  const { commands, plain, reset, sb } = loadPlugin();
  const failing = [{ name: "fin", from: [3, 4, 5], to: [3, 8, 9] }];

  // A failing gate warns…
  reset(failing);
  assert.equal(plain(commands.check_model({})).gate.gate_pass, false);
  assert.ok("warning" in plain(await commands.save_project({})));

  // …but a new project starts unchecked: no stale warning.
  assert.ok(plain(commands.new_project({ format: "free" })));
  assert.ok(!("warning" in plain(await commands.save_project({}))));

  // Same for a freshly loaded project (desktop-app path).
  reset(failing);
  assert.equal(plain(commands.check_model({})).gate.gate_pass, false);
  sb.isApp = true;
  assert.ok(plain(commands.load_project({ path: "/tmp/model.bbmodel" })));
  assert.ok(!("warning" in plain(await commands.save_project({}))));

  // And after closing the project there is no gate left to warn about.
  reset(failing);
  assert.equal(plain(commands.check_model({})).gate.gate_pass, false);
  assert.deepEqual(plain(commands.close_project()), { closed: true });
  assert.ok(!("warning" in plain(await commands.save_project({}))));
});

test("done-gate: latest check wins and saving never rejects on gate state", async () => {
  const { commands, plain, reset } = loadPlugin();
  // Fail first: the warning is remembered across saves.
  reset([{ name: "fin", from: [3, 4, 5], to: [3, 8, 9] }]);
  assert.equal(plain(commands.check_model({})).gate.gate_pass, false);
  assert.ok("warning" in plain(await commands.save_project({})));
  assert.ok("warning" in plain(await commands.save_project({})));
  // A later passing check clears the warning.
  reset(
    [{ name: "cube", from: [0, 0, 0], to: [2, 2, 2], faces: { up: { texture: "uuid-skin", uv: [0, 0, 2, 2] } } }],
    { textures: [{ name: "skin" }] },
  );
  assert.equal(plain(commands.check_model({})).gate.gate_pass, true);
  assert.ok(!("warning" in plain(await commands.save_project({}))));
});
