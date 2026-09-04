/**
 * execute_script structured errors (ticket #30) — drive the REAL bridge
 * handler (plugin/blockbench_mcp.js) with stubbed Blockbench globals plus
 * the REAL bridge client (dist/client.js) with a stubbed fetch, no live
 * Blockbench, no ports.
 *
 * Pins the escape-hatch contract: compile vs runtime phase, a 1-based line
 * hint into the user's `code` (wrapper-offset compensated, never the
 * Function wrapper), a truncated message, async rejections as runtime, and
 * a bounded MCP payload with no raw multi-kilobyte stack.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { callBlockbench, formatBridgeError, MAX_BRIDGE_ERROR_CHARS } from "../../dist/client.js";
import { tools } from "../../dist/tools.js";

const pluginPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../plugin/blockbench_mcp.js");
let src = fs.readFileSync(pluginPath, "utf8");
const cutAt = src.indexOf("// Plugin registration");
assert.ok(cutAt > 0, "plugin must contain the registration marker");
src = `${src.slice(0, cutAt)}\nglobalThis.__COMMANDS__ = commands;\n})();\n`;

const sb = {
  console, Buffer, JSON, Math, Object, Array, Number, String, Boolean, Infinity,
  RegExp, Error, SyntaxError, ReferenceError, Uint8Array, Promise, Function,
  Project: undefined,
  Format: {},
  Formats: {},
  Group: class {},
  Cube: class {},
  Outliner: { elements: [], root: [] },
  Texture: { all: [] },
  Animation: { all: [] },
  Blockbench: { version: "test" },
  Undo: { initEdit() {}, finishEdit() {} },
  Canvas: { updateAll() {} },
  Plugin: { register() {} },
  MenuBar: { addAction() {} },
  document: {},
  require: () => { throw new Error("net unavailable in tests"); },
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src, sb, { filename: "blockbench_mcp.js" });
const commands = sb.__COMMANDS__;
assert.ok(commands?.execute_script, "plugin must expose execute_script");

test("execute_script: syntax error reports compile phase with user line (not wrapper)", () => {
  // Line 1 is valid; the syntax error is on user line 2.
  assert.throws(
    () => commands.execute_script({ code: "const a = 1;\nconst b = ;" }),
    (err) => {
      assert.equal(err.phase, "compile");
      assert.equal(err.line, 2);
      assert.match(err.message, /execute_script compile error at line 2:/);
      assert.ok(err.message.length <= 2000, `bounded payload, got ${err.message.length}`);
      return true;
    }
  );
});

test("execute_script: single-line syntax error hints line 1", () => {
  assert.throws(
    () => commands.execute_script({ code: "return (;" }),
    (err) => {
      assert.equal(err.phase, "compile");
      assert.equal(err.line, 1);
      assert.match(err.message, /execute_script compile error at line 1:/);
      return true;
    }
  );
});

test("execute_script: runtime throw reports runtime phase with user line", () => {
  assert.throws(
    () => commands.execute_script({ code: "const a = 1;\nthrow new Error(\"boom-line2\");" }),
    (err) => {
      assert.equal(err.phase, "runtime");
      assert.equal(err.line, 2);
      assert.match(err.message, /execute_script runtime error at line 2:/);
      assert.match(err.message, /boom-line2/);
      return true;
    }
  );
});

test("execute_script: async rejection reports runtime phase", async () => {
  await assert.rejects(
    commands.execute_script({ code: "return Promise.reject(new Error(\"async boom\"))" }),
    (err) => {
      assert.equal(err.phase, "runtime");
      assert.equal(typeof err.line, "number");
      assert.match(err.message, /execute_script runtime error at line \d+:/);
      assert.match(err.message, /async boom/);
      return true;
    }
  );
});

test("execute_script: huge messages are truncated to a bounded payload", () => {
  assert.throws(
    () => commands.execute_script({ code: "throw new Error(\"x\".repeat(10000))" }),
    (err) => {
      assert.equal(err.phase, "runtime");
      assert.ok(err.message.length <= 2000, `bounded payload, got ${err.message.length}`);
      assert.ok(!err.message.includes("x".repeat(5000)), "raw multi-KB message must not survive");
      return true;
    }
  );
});

test("execute_script: success path still returns the value", async () => {
  const result = await commands.execute_script({ code: "return 1 + 1;" });
  assert.equal(result, 2);
});

test("client: structured bridge failure passes phase/line through truncated", async () => {
  const realFetch = globalThis.fetch;
  const bigStack = `Error: boom\n${"    at foo:1:1\n".repeat(2000)}`;
  globalThis.fetch = async () => ({
    json: async () => ({
      ok: false,
      error: "execute_script runtime error at line 2: boom",
      phase: "runtime",
      line: 2,
      stack: bigStack,
    }),
  });
  try {
    await assert.rejects(
      callBlockbench("execute_script", { code: "x" }),
      (err) => {
        assert.match(err.message, /execute_script runtime error at line 2:/);
        assert.match(err.message, /boom/);
        assert.ok(err.message.length <= MAX_BRIDGE_ERROR_CHARS, `bounded, got ${err.message.length}`);
        assert.ok(!err.message.includes("at foo:1:1"), "raw stack must not leak into the MCP result");
        return true;
      }
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("client: multi-kilobyte bridge error is truncated", () => {
  const err = formatBridgeError("execute_script", {
    ok: false,
    error: "y".repeat(10000),
    phase: "runtime",
    line: 1,
    stack: "z".repeat(10000),
  });
  assert.match(err.message, /execute_script runtime error at line 1:/);
  assert.ok(err.message.length <= MAX_BRIDGE_ERROR_CHARS, `bounded, got ${err.message.length}`);
  assert.ok(!err.message.includes("y".repeat(5000)));
});

test("client: legacy bridge error without phase passes through truncated", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ ok: false, error: "plain failure" }) });
  try {
    await assert.rejects(callBlockbench("add_cube", {}), /plain failure/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("tools handler: execute_script bridge failure surfaces phase + line", async () => {
  const tool = tools.find((t) => t.name === "execute_script");
  assert.ok(tool, "execute_script must exist");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts?.body ?? "{}");
    assert.equal(body.action, "execute_script");
    return {
      json: async () => ({
        ok: false,
        id: body.id,
        error: "execute_script compile error at line 2: Unexpected token ';'",
        phase: "compile",
        line: 2,
      }),
    };
  };
  try {
    await assert.rejects(() => tool.handler({ code: "const a = 1;\nconst b = ;" }), /execute_script compile error at line 2/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
