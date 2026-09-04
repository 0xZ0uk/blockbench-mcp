---
name: verify-blockbench-mcp
description: Verify blockbench-mcp (MCP stdio server + Blockbench bridge plugin). Use before any push, PR, or "done" to run the doctor, drive the changed behavior through the real user path, and capture evidence.
---

# Verify blockbench-mcp

Surface: **MCP server over stdio** (`node dist/index.js`, owns the tool
catalogue in `src/tools.ts`) plus the **bridge plugin** inside Blockbench
desktop (`plugin/blockbench_mcp.js`, HTTP `127.0.0.1:8787`). The stdio
server is the primary verifiable surface headless; anything that mutates a
Blockbench project requires an owned Blockbench instance (see Isolate).

## Launch

Build first (the server ships from `dist/`):

```bash
pnpm run build   # or: npm run build  (runs tsc -> dist/)
node dist/index.js   # stdio transport; logs go to stderr, never stdout
```

Ready signal on stderr: `BlockbenchMCP server ready. Bridging to Blockbench at http://127.0.0.1:8787`.
Stdio servers are per-process: each `node dist/index.js` you spawn is yours.
Track its PID and kill exactly that PID on teardown — never `pkill`
blockbench, never kill by port.

Bridge (only if you need live Blockbench behavior): open Blockbench
desktop ≥4.8, load `plugin/blockbench_mcp.js` via File ▸ Plugins ▸ Load
Plugin from File, allow the `net` module, confirm the toast
"MCP server started on port 8787". Verify with:

```bash
curl -s http://127.0.0.1:8787/ping
```

Teardown: stop what you started. For stdio servers, kill the PID you
spawned. For the bridge, use Tools ▸ Stop MCP Server inside the Blockbench
instance you started. Evidence in `.artifacts/<task>/` survives teardown.

## Doctor

One read-only check, run first whenever anything looks off:

```bash
node .opencode/skills/verify-blockbench-mcp/helpers/doctor.mjs
```

It asserts: `dist/` is newer than `src/` (you built your code), the stdio
server answers `tools/list` on a pipe you own, and reports who owns port
8787 (`ss -ltnp 'sport = :8787'` + `ps -p <pid> -o args=`). Exit 0 = healthy.

## Drive

No Playwright/Cypress specs exist in this repo. Drive paths, in order of
preference:

1. **Contract suite (headless, no Blockbench):** `pnpm test`
   (builds, then `node --test tests/contract/*.test.mjs`). Table-driven
   cases assert schemas offered to clients plus handler results with the
   bridge stubbed. This is the gate for precision-ticket changes.
2. **MCP stdio (your code, your process):** spawn `node dist/index.js`,
   send JSON-RPC `initialize` then `tools/list`, assert the catalogue
   (currently 49 tools). Example drive script pattern: spawn with piped
   stdio, write `{"jsonrpc":"2.0","id":1,"method":"initialize",...}` then
   `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`, read the
   `tools` array on stdout. Kill your PID after.
3. **Bridge read-only (shared-safe):** `get_status`, `list_formats`,
   `check_model`, `list_outliner`, `measure` change nothing and may run
   against a shared instance for observation only.
4. **Bridge mutating (owned-instance only):** `new_project`, `add_cube(s)`,
   `paint_*`, `screenshot*`, `execute_script` — only against a Blockbench
   you started. Never against PID 3107511-style shared renderers.

## Evidence

What to capture, where: `.artifacts/<task>/` (gitignored — cited or
uploaded, never committed).

- The action AND the resulting state: the exact command, its exit code,
  plus the observable end state (tool count + names, test tallies,
  response bodies, screenshots for visual tools).
- Side effects alongside visibility: files written, rows inserted,
  project state (`has_project`, counts) next to what you saw.
- Proof standards: drive the real user path (stdio `tools/list` /
  `tools/call`, not internal setters or test-only endpoints); verify the
  listener is yours before trusting it (`ss` + `ps` per Doctor).

## Cleanup

Kill only PIDs you spawned (stdio server, helper scripts). Never kill by
process name or port. Leave shared Blockbench instances running. Confirm
evidence still exists at `.artifacts/<task>/` after teardown.

## Isolate

Worktrees do not isolate shared resources. Port 8787 is global: if
`ss -ltnp 'sport = :8787'` shows a PID whose `ps -o args=` is a Blockbench
renderer you did not start (e.g. `/app/bin/Blockbench/blockbench ...`),
treat that instance as **shared**: read-only observation only, no mutating
calls, no schema experiments. Run `pnpm test` freely — it stubs the
bridge and touches no ports or projects.
