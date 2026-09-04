/**
 * set_reference_image tests — drive the REAL bridge handler
 * (plugin/blockbench_mcp.js) with stubbed Blockbench globals, no live
 * Blockbench, no ports (ticket #25).
 *
 * The contract table pins the schema clients see; these tests pin the
 * pinning behavior: pin -> stored state is readable from the result,
 * re-pin replaces, empty source unpins (idempotent), and invalid sources
 * or views throw errors naming the field.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// 1x1 PNG (70 bytes) + the same bytes with one trailing byte (71 bytes).
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");
const PNG_BIG_B64 = Buffer.concat([PNG_BYTES, Buffer.from([0])]).toString("base64");
const NOT_IMAGE_B64 = Buffer.from(
  "not an image, just text long enough to reach the base64 branch........"
).toString("base64");

const fakeFiles = {
  "/ref/front.png": PNG_BYTES,
  "/ref/notes.txt": Buffer.from("plain text, not an image"),
};
const fakeDirs = new Set(["/ref/a-directory"]);
const fakeFs = {
  statSync(p) {
    if (Object.hasOwn(fakeFiles, p)) return { isFile: () => true, size: fakeFiles[p].length };
    if (fakeDirs.has(p)) return { isFile: () => false, size: 0 };
    const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
    err.code = "ENOENT";
    throw err;
  },
  readFileSync(p) {
    if (Object.hasOwn(fakeFiles, p)) return fakeFiles[p];
    if (fakeDirs.has(p)) {
      const err = new Error(`EISDIR: illegal operation on a directory, read '${p}'`);
      err.code = "EISDIR";
      throw err;
    }
    const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
    err.code = "ENOENT";
    throw err;
  },
};

const pluginPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../plugin/blockbench_mcp.js");
let src = fs.readFileSync(pluginPath, "utf8");
const cutAt = src.indexOf("// Plugin registration");
assert.ok(cutAt > 0, "plugin must contain the registration marker");
src = `${src.slice(0, cutAt)}\nglobalThis.__COMMANDS__ = commands;\n})();\n`;

const sb = {
  console, Buffer, JSON, Math, Object, Array, Number, String, Boolean, Infinity,
  RegExp, Error, Map, Set, Uint8Array,
  Project: { texture_width: 16, texture_height: 16 },
  Format: { animation_mode: false },
  Formats: {},
  Group: class {},
  Cube: class {},
  Outliner: { elements: [], root: [] },
  Texture: { all: [] },
  Animation: { all: [] },
  Undo: { initEdit() {}, finishEdit() {} },
  Canvas: { updateAll() {} },
  Plugin: { register() {} },
  MenuBar: { addAction() {} },
  require: (mod) => {
    if (mod === "fs") return fakeFs;
    throw new Error(`net unavailable in tests (asked for ${mod})`);
  },
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src, sb, { filename: "blockbench_mcp.js" });
const commands = sb.__COMMANDS__;
assert.ok(commands?.set_reference_image, "plugin must expose set_reference_image");

// One shared vm store across tests: reset before each so tests stay
// independent (only the deliberate pin->replace->unpin test shares a key).
beforeEach(() => {
  sb.__BLOCKBENCH_MCP__.reference_images = {};
});

/** vm-realm objects carry a different prototype: compare via JSON round-trip. */
const plain = (v) => JSON.parse(JSON.stringify(v));

test("set_reference_image: pin inline data URL -> readable stored state", () => {
  const res = commands.set_reference_image({ view: "front", source: `data:image/png;base64,${PNG_B64}` });
  assert.deepEqual(plain(res), { view: "preset:front", pinned: true, mime: "image/png", bytes: PNG_BYTES.length });
});

test("set_reference_image: pinning again replaces the stored reference", () => {
  commands.set_reference_image({ view: "front", source: `data:image/png;base64,${PNG_B64}` });
  const res = commands.set_reference_image({ view: "front", source: PNG_BIG_B64 });
  assert.equal(res.view, "preset:front");
  assert.equal(res.pinned, true);
  assert.equal(res.bytes, PNG_BYTES.length + 1);
});

test("set_reference_image: empty source unpins; unpin is idempotent", () => {
  commands.set_reference_image({ view: "front", source: `data:image/png;base64,${PNG_B64}` });
  assert.deepEqual(plain(commands.set_reference_image({ view: "front", source: "" })), {
    view: "preset:front", pinned: false,
  });
  assert.deepEqual(plain(commands.set_reference_image({ view: "front", source: "   " })), {
    view: "preset:front", pinned: false,
  });
});

test("set_reference_image: preset keys ignore surrounding whitespace", () => {
  const res = commands.set_reference_image({ view: "  front  ", source: `data:image/png;base64,${PNG_B64}` });
  assert.equal(res.view, "preset:front");
  assert.equal(res.pinned, true);
});

test("set_reference_image: explicit {position,target} keys by camera", () => {
  const res = commands.set_reference_image({
    view: { position: [0, 8, 32], target: [0, 8, 0] },
    source: `data:image/png;base64,${PNG_B64}`,
  });
  assert.equal(res.view, "pos(0,8,32)->tgt(0,8,0)");
  assert.equal(res.pinned, true);
  // Same camera, different spec order of operations -> same key (replace, not a second slot).
  const again = commands.set_reference_image({
    view: { position: [0, 8, 32], target: [0, 8, 0] },
    source: "",
  });
  assert.deepEqual(plain(again), { view: "pos(0,8,32)->tgt(0,8,0)", pinned: false });
});

test("set_reference_image: file path pins (desktop fs)", () => {
  const res = commands.set_reference_image({ view: "top", source: "/ref/front.png" });
  assert.deepEqual(plain(res), { view: "preset:top", pinned: true, mime: "image/png", bytes: PNG_BYTES.length });
  commands.set_reference_image({ view: "top", source: "" });
});

test("set_reference_image: errors name the offending field", () => {
  // Missing file.
  assert.throws(
    () => commands.set_reference_image({ view: "left", source: "/ref/missing.png" }),
    /Field "source" file not found: \/ref\/missing\.png/
  );
  // Garbage string: neither an existing path nor image data.
  assert.throws(
    () => commands.set_reference_image({ view: "left", source: "!!!" }),
    /Field "source" (file not found|must be an existing image file path)/
  );
  // Valid base64 but not image bytes.
  assert.throws(
    () => commands.set_reference_image({ view: "left", source: NOT_IMAGE_B64 }),
    /Field "source"/
  );
  // Existing file with non-image bytes.
  assert.throws(
    () => commands.set_reference_image({ view: "left", source: "/ref/notes.txt" }),
    /Field "source" is not a decodable image/
  );
  // Malformed inline data URL.
  assert.throws(
    () => commands.set_reference_image({ view: "left", source: "data:image/png,AAAA" }),
    /Field "source" inline image must be a data:image\/\.\.\.;base64/
  );
  // Bad views.
  assert.throws(() => commands.set_reference_image({ view: 42, source: "" }), /Field "view"/);
  assert.throws(() => commands.set_reference_image({ view: {}, source: "" }), /Field "view"/);
  assert.throws(() => commands.set_reference_image({ source: "" }), /Field "view"/);
  assert.throws(() => commands.set_reference_image({ view: "", source: "" }), /Field "view"/);
  assert.throws(
    () => commands.set_reference_image({ view: { position: [0, "x", 0] }, source: "" }),
    /Field "view"/
  );
  // Bad sources.
  assert.throws(() => commands.set_reference_image({ view: "left" }), /Field "source"/);
  assert.throws(() => commands.set_reference_image({ view: "left", source: 42 }), /Field "source"/);
  // A directory is not a file.
  assert.throws(
    () => commands.set_reference_image({ view: "left", source: "/ref/a-directory" }),
    /Field "source" is not a file: \/ref\/a-directory/
  );
});

test("set_reference_image: no project open names the remedy", () => {
  const had = sb.Project;
  sb.Project = undefined;
  try {
    assert.throws(() => commands.set_reference_image({ view: "front", source: "" }), /No project is open/);
  } finally {
    sb.Project = had;
  }
});
