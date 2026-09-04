/**
 * Version-consistency + shipped-config portability guard (ticket #18).
 *
 * Proves the single source of truth holds: the MCP server's reported
 * version, the bridge plugin's declared version, and `package.json` all
 * agree — and the shipped `.mcp.json` launches the built server via a
 * relative path with the port override, so a fresh clone works on any OS.
 *
 * Runs from the built `dist/` output (same seam as the contract suite):
 * what is asserted is exactly what ships and what clients read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SERVER_VERSION } from "../../dist/version.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

test("version: server, plugin, and package.json share one source", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const pluginSrc = readFileSync(
    join(repoRoot, "plugin", "blockbench_mcp.js"),
    "utf8"
  );

  const pluginVersion = pluginSrc.match(
    /^(\s*)version:\s*(['"])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\2/m
  )?.[3];
  assert.ok(pluginVersion, "plugin must declare a semver `version:` literal");

  assert.equal(SERVER_VERSION, pkg.version, "server version must come from package.json");
  assert.equal(pluginVersion, pkg.version, "plugin version must match package.json");
});

test("version: server handshake reports the package version", async () => {
  const { createServer } = await import("../../dist/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "drift-guard", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const serverInfo = client.getServerVersion();
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.equal(serverInfo?.version, pkg.version);
  await Promise.all([client.close(), server.close()]);
});

test("config: shipped .mcp.json is portable (relative path, port override)", () => {
  const config = JSON.parse(readFileSync(join(repoRoot, ".mcp.json"), "utf8"));
  const entry = config.mcpServers?.blockbench;
  assert.ok(entry, ".mcp.json must ship a `blockbench` server entry");

  assert.equal(entry.command, "node");
  assert.deepEqual(entry.args, ["dist/index.js"], "args must use the repo-relative build output");
  assert.equal(
    entry.env?.BLOCKBENCH_MCP_PORT,
    "8787",
    "entry must carry the BLOCKBENCH_MCP_PORT override"
  );

  const raw = JSON.stringify(entry);
  assert.doesNotMatch(raw, /\b[A-Za-z]:[\\/]/, "no drive-letter absolute paths");
  assert.doesNotMatch(raw, /(^|["\s])\/(?!\/)/, "no leading-slash absolute paths");
});

test("docs: README setup instructions carry no machine-specific paths", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const stale = readme.match(/\b[A-Za-z]:[\\/].*/g);
  assert.deepEqual(
    stale,
    null,
    `no drive-letter paths in README (fresh-clone setup must work on any OS), found: ${stale}`
  );
});
