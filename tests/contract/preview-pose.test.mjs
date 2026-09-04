/**
 * preview_pose tests — drive the REAL bridge handler (plugin/blockbench_mcp.js)
 * with stubbed Blockbench globals, no live Blockbench, no ports (ticket #29).
 *
 * The contract table pins the schema clients see; these tests pin parity
 * with the promoted skill snippet
 * (`anim.select(); Timeline.setTime(t); Animator.preview();`): the structured
 * result naming the animation/time applied, selection by name or uuid, and
 * errors that name the offending field.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const pluginPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../plugin/blockbench_mcp.js");
let src = fs.readFileSync(pluginPath, "utf8");
const cutAt = src.indexOf("// Plugin registration");
assert.ok(cutAt > 0, "plugin must contain the registration marker");
src = `${src.slice(0, cutAt)}\nglobalThis.__COMMANDS__ = commands;\n})();\n`;

let project;
let calls;

const anim = (name, uuid) => ({
  name,
  uuid: uuid ?? `uuid-${name}`,
  select() {
    calls.select.push(this.name);
  },
});

function seed() {
  calls = { select: [], setTime: [], preview: 0 };
  project = { texture_width: 64, texture_height: 64 };
  sb.Animation.all = [anim("walk"), anim("animation.bear.walk", "uuid-bear-walk")];
}

const sb = {
  console, Buffer, JSON, Math, Object, Array, Number, String, Boolean, Infinity,
  RegExp, Error, Uint8Array, Uint8ClampedArray,
  Project: undefined,
  Format: { animation_mode: true },
  Formats: {},
  Group: class {},
  Cube: class {},
  Outliner: { elements: [], root: [] },
  Texture: { all: [] },
  Animation: { all: [] },
  Timeline: { setTime(t) { calls.setTime.push(t); } },
  Animator: { preview() { calls.preview++; } },
  Blockbench: {},
  Undo: { initEdit() {}, finishEdit() {} },
  Canvas: { updateAll() {} },
  Plugin: { register() {} },
  MenuBar: { addAction() {} },
  document: { createElement() { throw new Error("no canvas in this test"); } },
  require: () => { throw new Error("net unavailable in tests"); },
};
sb.globalThis = sb;
Object.defineProperty(sb, "Project", { get: () => project, configurable: true });
vm.createContext(sb);
vm.runInContext(src, sb, { filename: "blockbench_mcp.js" });
const commands = sb.__COMMANDS__;
assert.ok(commands?.preview_pose, "plugin must expose preview_pose");

/** vm-realm objects carry a different prototype: compare via JSON round-trip. */
const plain = (v) => JSON.parse(JSON.stringify(v));

test("preview_pose: matches the snippet (select + setTime + preview) and names animation/time", () => {
  seed();
  const res = plain(commands.preview_pose({ animation: "walk", time: 0.25 }));
  assert.deepEqual(Object.keys(res).sort(), ["animation", "time", "uuid"]);
  assert.equal(res.animation, "walk");
  assert.equal(res.uuid, "uuid-walk");
  assert.equal(res.time, 0.25);
  // Observable snippet behavior through the existing seams.
  assert.deepEqual(calls.select, ["walk"]);
  assert.deepEqual(calls.setTime, [0.25]);
  assert.equal(calls.preview, 1);
});

test("preview_pose: resolves by uuid as well as name", () => {
  seed();
  const res = plain(commands.preview_pose({ animation: "uuid-bear-walk", time: 0 }));
  assert.equal(res.animation, "animation.bear.walk");
  assert.equal(res.time, 0);
  assert.deepEqual(calls.select, ["animation.bear.walk"]);
  assert.deepEqual(calls.setTime, [0]);
});

test("preview_pose: unknown animation names the field", () => {
  seed();
  assert.throws(() => commands.preview_pose({ animation: "nope", time: 0.25 }), /Field "animation" not found: nope/);
  assert.equal(calls.select.length, 0);
  assert.equal(calls.preview, 0);
});

test("preview_pose: missing/invalid args name the field", () => {
  seed();
  assert.throws(() => commands.preview_pose({ time: 0.25 }), /Field "animation"/);
  assert.throws(() => commands.preview_pose({ animation: "walk" }), /Field "time"/);
  assert.throws(() => commands.preview_pose({ animation: "walk", time: "0.25" }), /Field "time"/);
  assert.throws(() => commands.preview_pose({ animation: "", time: 0.25 }), /Field "animation"/);
});

test("preview_pose: errors name the remedy", () => {
  seed();
  const had = project;
  project = undefined;
  try {
    assert.throws(() => commands.preview_pose({ animation: "walk", time: 0.25 }), /No project is open/);
  } finally {
    project = had;
  }
});
