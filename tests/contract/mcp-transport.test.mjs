/**
 * MCP transport contract — asserts what clients actually receive.
 *
 * Unlike contract.test.mjs (which validates published inputSchemas and
 * handler ContentBlocks), this file drives the production ListTools/CallTool
 * wiring from dist/index.js over an in-memory MCP transport with the bridge
 * stubbed, and asserts the real CallToolResults including isError.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../dist/index.js";

test("mcp tools/list publishes the catalogue clients validate against", async () => {
  await withClient({}, async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const core of ["get_status", "add_cube", "add_cubes", "check_model", "pack_uv"]) {
      assert.ok(names.includes(core), `catalogue must include ${core}`);
    }
    for (const tool of tools) {
      assert.equal(typeof tool.name, "string");
      assert.equal(typeof tool.description, "string", `${tool.name}: description`);
      assert.equal(tool.inputSchema?.type, "object", `${tool.name}: inputSchema.type`);
    }
  });
});

test("mcp tools/call success returns bridge JSON as text content", async () => {
  const bridgeCube = { uuid: "cube-1", name: "slide", from: [-12, 0, 0], to: [12, 4, 4] };
  await withClient({ add_cube: { result: bridgeCube } }, async (client) => {
    const result = await client.callTool({
      name: "add_cube",
      arguments: { from: [-12, 0, 0], to: [12, 4, 4] },
    });
    assert.equal(result.isError ?? false, false);
    assert.equal(result.content[0].type, "text");
    assert.deepEqual(JSON.parse(result.content[0].text), bridgeCube);
  });
});

test("mcp tools/call unknown tool returns isError (what clients see)", async () => {
  await withClient({}, async (client) => {
    const result = await client.callTool({ name: "nope_not_a_tool", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown tool/);
  });
});

test("mcp tools/call bridge error returns isError naming the field", async () => {
  await withClient({ add_groups: { error: 'Field "groups" (array) is required.' } }, async (client) => {
    const result = await client.callTool({ name: "add_groups", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /groups/);
  });
});

test("mcp tools/call compare_views renders per-view MATCH/MISSING lines", async () => {
  const bridge = {
    count: 2,
    matched: 1,
    differed: 0,
    missing: ["preset:top"],
    projection_restored: true,
    comparisons: [
      {
        view: "preset:front",
        match: true,
        compared: true,
        delta: "identical to pinned reference (image/png 70 bytes 1x1)",
        reference: { mime: "image/png", bytes: 70, width: 1, height: 1 },
        shot: { mime: "image/png", bytes: 70, width: 1, height: 1, ortho: true, px_per_unit: 8, wireframe: false },
        projection_restored: true,
      },
      {
        view: "preset:top",
        match: false,
        compared: false,
        error: 'Field "view" "preset:top" has no pinned reference. Pin one with set_reference_image first.',
        projection_restored: true,
      },
    ],
  };
  await withClient({ compare_views: { result: bridge } }, async (client) => {
    const result = await client.callTool({
      name: "compare_views",
      arguments: { views: ["front", "top"] },
    });
    assert.equal(result.isError ?? false, false);
    const texts = result.content.filter((c) => c.type === "text").map((c) => c.text);
    assert.equal(texts.length, 3);
    assert.match(texts[0], /Compared 2 view\(s\): 1 match, 0 differ, 1 missing reference/);
    assert.match(texts[1], /View preset:front: MATCH/);
    assert.match(texts[2], /View preset:top: MISSING REFERENCE.*Field "view"/);
  });
});

/**
 * Connect a real Client to the production server over an in-memory
 * transport with the bridge (global fetch) stubbed. No ports, no projects.
 * @param {Record<string, {result?: unknown, error?: string}>} byAction
 * @param {(client: import("@modelcontextprotocol/sdk/client/index.js").Client) => Promise<void>} fn
 */
async function withClient(byAction, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    const body = JSON.parse(opts?.body ?? "{}");
    const entry = byAction[body.action];
    if (entry?.error) {
      return { json: async () => ({ ok: false, id: body.id, error: entry.error }) };
    }
    return { json: async () => ({ ok: true, id: body.id, result: entry?.result ?? { echo: body.params } }) };
  };
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await fn(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    globalThis.fetch = realFetch;
  }
}
