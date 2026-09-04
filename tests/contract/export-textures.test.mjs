/**
 * export_textures tests — drive the REAL bridge handler (plugin/blockbench_mcp.js)
 * with stubbed Blockbench globals, no live Blockbench, no ports (ticket #28).
 *
 * The contract table pins the schema clients see; these tests pin parity
 * with the promoted skill snippet (`tex.getDataURL()` + `Blockbench.writeFile`
 * with `savetype:'image'`): the structured per-texture result shape,
 * selection narrowing, destination defaults, and errors that name the remedy.
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

let writes;
let project;

const sb = {
  console, Buffer, JSON, Math, Object, Array, Number, String, Boolean, Infinity,
  RegExp, Error, Uint8Array, Uint8ClampedArray,
  Project: undefined,
  Format: { animation_mode: false },
  Formats: {},
  Group: class {},
  Cube: class {},
  Outliner: { elements: [], root: [] },
  Texture: { all: [] },
  Animation: { all: [] },
  Blockbench: {
    writeFile(dest, opts) {
      writes.push({ dest, opts });
    },
  },
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
assert.ok(commands?.export_textures, "plugin must expose export_textures");

/** vm-realm objects carry a different prototype: compare via JSON round-trip. */
const plain = (v) => JSON.parse(JSON.stringify(v));

const tex = (name, uuid) => ({
  name,
  uuid: uuid ?? `uuid-${name}`,
  getDataURL: () => `data:image/png;base64,${name}`,
});

/** Fixture project: two textures, saved alongside /proj/model.bbmodel. */
function seed() {
  writes = [];
  project = { save_path: "/proj/model.bbmodel", texture_width: 64, texture_height: 64 };
  sb.Texture.all = [tex("a"), tex("b")];
}

test("export_textures: writes every texture by default alongside the project", () => {
  seed();
  const res = plain(commands.export_textures({}));
  assert.deepEqual(Object.keys(res).sort(), ["exported", "failed", "results"]);
  assert.deepEqual([res.exported, res.failed], [2, 0]);
  assert.deepEqual(res.results.map((r) => [r.texture, r.ok, r.path]), [
    ["a", true, "/proj/a.png"],
    ["b", true, "/proj/b.png"],
  ]);
  // Snippet parity: same data-URL bytes through Blockbench.writeFile as image.
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map((w) => w.dest), ["/proj/a.png", "/proj/b.png"]);
  for (const w of writes) {
    assert.equal(w.opts.savetype, "image");
    assert.match(w.opts.content, /^data:image\/png;base64,/);
  }
  assert.equal(writes[0].opts.content, "data:image/png;base64,a");
});

test("export_textures: texture / textures narrow the selection", () => {
  seed();
  let res = plain(commands.export_textures({ texture: "b" }));
  assert.deepEqual([res.exported, res.results.length], [1, 1]);
  assert.equal(res.results[0].texture, "b");
  assert.equal(writes.length, 1);
  seed();
  res = plain(commands.export_textures({ textures: ["a"], directory: "/tmp/out" }));
  assert.deepEqual([res.exported, res.results[0].path], [1, "/tmp/out/a.png"]);
  seed();
  res = plain(commands.export_textures({ texture: "a", path: "/tmp/out/custom.png" }));
  assert.equal(res.results[0].path, "/tmp/out/custom.png");
  assert.throws(
    () => commands.export_textures({ texture: "a", textures: ["a"] }),
    /either "texture" or "textures"/
  );
});

test("export_textures: one bad ref never voids the batch", () => {
  seed();
  const res = plain(commands.export_textures({ textures: ["a", "nope"], directory: "/tmp/out" }));
  assert.deepEqual([res.exported, res.failed], [1, 1]);
  assert.deepEqual(res.results.map((r) => [r.texture, r.ok]), [["a", true], ["nope", false]]);
  assert.match(res.results[1].error, /Texture not found: nope/);
  assert.equal(writes.length, 1);
});

test("export_textures: destination rules name the field", () => {
  seed();
  assert.throws(
    () => commands.export_textures({ textures: ["a", "b"], path: "/tmp/out.png" }),
    /Field "path"/
  );
  assert.throws(
    () => commands.export_textures({ texture: "a", path: "/tmp/a.png", directory: "/tmp" }),
    /either "path" or "directory"/
  );
  assert.throws(() => commands.export_textures({ textures: [] }), /Field "textures"/);
  // No save path yet: the error names the destination field and the remedy.
  seed();
  project = { texture_width: 64, texture_height: 64 };
  assert.throws(() => commands.export_textures({}), /Field "path".*save the project/);
});

test("export_textures: errors name the remedy", () => {
  seed();
  sb.Texture.all = [];
  assert.throws(() => commands.export_textures({}), /No textures to export/);
  seed();
  const had = project;
  project = undefined;
  try {
    assert.throws(() => commands.export_textures({}), /No project is open/);
  } finally {
    project = had;
  }
});
