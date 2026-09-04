#!/usr/bin/env node
/**
 * Doctor — read-only health check for blockbench-mcp.
 * Exit 0 = healthy. Never mutates projects, never kills processes.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
let failures = 0;
const note = (ok, label, detail = "") => {
  console.log(`${ok ? "ok" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// 1. dist newer than src (you built your code)
const newest = (dir, ext) => {
  let latest = 0;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(ext)) {
      latest = Math.max(latest, fs.statSync(path.join(dir, f)).mtimeMs);
    }
  }
  return latest;
};
try {
  const srcTs = newest(path.join(repoRoot, "src"), ".ts");
  const distJs = newest(path.join(repoRoot, "dist"), ".js");
  note(distJs > 0 && distJs >= srcTs, "dist built from src", `src=${Math.round(srcTs)} dist=${Math.round(distJs)}`);
} catch (e) {
  note(false, "dist built from src", String(e?.message ?? e));
}

// 2. stdio server answers tools/list on a pipe we own
const stdioTools = await new Promise((resolve) => {
  const child = spawn("node", [path.join(repoRoot, "dist/index.js")], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let settled = false;
  const done = (value) => {
    if (!settled) {
      settled = true;
      try {
        child.kill();
      } catch {}
      resolve(value);
    }
  };
  const timer = setTimeout(() => done({ ok: false, detail: "timeout waiting for tools/list" }), 10000);
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "doctor", version: "0.0.0" } } };
  const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  let initializedSent = false;
  const origDone = done;
  child.stdout.on("data", (d) => {
    stdout += String(d);
    const lines = stdout.split("\n");
    for (const line of lines) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === 1 && msg.result && !initializedSent) {
          initializedSent = true;
          child.stdin.write(JSON.stringify(initialized) + "\n");
          child.stdin.write(JSON.stringify(list) + "\n");
        }
        if (msg.id === 2 && msg.result?.tools) {
          clearTimeout(timer);
          origDone({ ok: true, count: msg.result.tools.length, names: msg.result.tools.map((t) => t.name) });
          return;
        }
      } catch {}
    }
  });
  child.on("error", (e) => {
    clearTimeout(timer);
    origDone({ ok: false, detail: String(e?.message ?? e) });
  });
  child.stdin.write(JSON.stringify(init) + "\n");
});
if (stdioTools.ok) {
  const hasCore = ["get_status", "add_cube", "check_model"].every((n) => stdioTools.names.includes(n));
  note(hasCore, "stdio tools/list", `${stdioTools.count} tools`);
} else {
  note(false, "stdio tools/list", stdioTools.detail);
}

// 3. who owns port 8787 (informational, never a failure by itself)
try {
  const { stdout } = await run("ss", ["-ltnp", "sport = :8787"]);
  const m = stdout.match(/pid=(\d+)/);
  if (!m) {
    note(true, "bridge :8787", "nothing listening (headless ok — contract suite stubs the bridge)");
  } else {
    const pid = m[1];
    let args = "";
    try {
      args = (await run("ps", ["-p", pid, "-o", "args="])).stdout.trim();
    } catch {}
    // Never infer ownership from command text: default to shared/unknown
    // unless the caller explicitly names a PID it spawned via
    // BLOCKBENCH_MCP_OWNER_PID.
    const ownerPid = process.env.BLOCKBENCH_MCP_OWNER_PID ?? "";
    const mine = ownerPid !== "" && pid === ownerPid;
    note(true, "bridge :8787", `pid=${pid} owned-by-${mine ? "me" : "someone-else"} (${args.slice(0, 80)})`);
    if (!mine) console.log("     shared instance: read-only observation only, no mutating calls");
  }
} catch (e) {
  note(true, "bridge :8787", `ownership check unavailable (${String(e?.message ?? e).slice(0, 80)})`);
}

process.exit(failures === 0 ? 0 : 1);
