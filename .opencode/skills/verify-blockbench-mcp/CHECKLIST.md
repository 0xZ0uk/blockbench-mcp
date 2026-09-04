# Checklist — blockbench-mcp user-facing features

One entry per feature: how to reach it, how to drive it, the observable end
state that proves it works. Fix or delete a stale line when the app changes;
never leave it to lie.

- [ ] **MCP catalogue (`tools/list`)** — Reach: spawn `node dist/index.js`
  (stdio), send `initialize` then `tools/list`. Drive: helper `doctor.mjs`
  or a one-off stdio script. Proved when: response lists 49 tools including
  `get_status`, `add_cube`, `add_cubes`, `check_model`, `screenshot_views`,
  `edit_elements`, `delete_elements`, `measure`.
- [ ] **Contract suite gate (`pnpm test`)** — Reach: repo root after
  `pnpm install`. Drive: `pnpm test`. Proved when: `tsc` build succeeds and
  `node --test tests/contract/*.test.mjs` reports fail 0 with all tests
  passing (tallies grow as cases are added; currently 48 pass / 0 fail).
- [ ] **Version consistency + shipped-config portability** — Reach: MCP
  stdio `initialize` handshake, plus `tests/contract/version.test.mjs`.
  Drive: spawn `node dist/index.js`, send `initialize`, read
  `serverInfo.version`; run the drift guard via `pnpm test`. Proved when:
  `serverInfo.version` equals `package.json` `version` and the plugin's
  declared `version:` literal (v0.2.0 at time of writing), and the
  `.mcp.json` test confirms `args` are the repo-relative `dist/index.js`
  with the `BLOCKBENCH_MCP_PORT` override. Stdout/stderr evidence: ready
  line names the same version.
- [ ] **Retry-safe bulk creation (`add_cubes`/`add_groups` `dedupe_by_name`,
  ticket #19)** — Reach: MCP `tools/list` shows the boolean option on both
  tools' published schemas; handler behavior pinned headless by
  `tests/contract/dedupe.test.mjs` (drives the real bridge handlers with
  stubbed Blockbench globals). Drive: retried call with
  `dedupe_by_name:true` where a name matches. Proved when: the element count
  does not grow, per-item result carries `updated:true`, and top level
  reports `{created, updated}`; without the flag the same call duplicates
  with the legacy `{created, cubes|groups}` shape. Live-Blockbench mutation
  stays owned-instance only — record `untested + reason` without one.
- [ ] **Bridge status (read-only, shared-safe)** — Reach:
  `curl -s http://127.0.0.1:8787/ping` plus `get_status` over the bridge.
  Drive: curl, or MCP `tools/call get_status` with an owned stdio server.
  Proved when: `{"ok":true,"protocol":1,...}` with `has_project` boolean and
  a `get_status` payload naming open project/format/counts.
- [ ] **Model audit (`check_model`, read-only)** — Reach: MCP `tools/call
  check_model` (needs an open project for real data; stubbed in the
  contract suite). Drive: call with `{}`. Proved when: result parses to
  `{issue_count, by_type, issues[]}` with per-issue `issue` names
  (`no_texture`, `coplanar_overlap`, …).
- [ ] **Bulk edit/delete (`edit_elements` / `delete_elements`, stubbed)** — Reach: MCP
  `tools/call edit_elements` / `delete_elements` with the bridge stubbed (contract suite)
  or an owned stdio server over in-memory transport. Drive: call with
  `{edits:[{element, patch}]}` / `{elements:[...]}` including one bad reference.
  Proved when: result parses to `{edited|deleted, failed, results[]}` with per-item
  `{element, ok:true, result|deleted}` vs `{element, ok:false, error}` and `isError` false.
  Live-Blockbench mutation stays owned-instance only — record `untested + reason` without one.
- [ ] **Measure dims (`measure`, read-only)** — Reach: MCP `tools/call
  measure` (needs an open project for live numbers; stubbed in the
  contract suite). Drive: call `{mode:"element",element:"<name>"}`,
  `{mode:"group",group:"<name>"}`, `{mode:"model"}`,
  `{mode:"distance",a:"<name>",b:"<name>"}`, `{mode:"clearance"}`. Proved when: each
  result parses to `{mode, units:"model", min/max/size/center with {x,y,z}}`
  plus the resolved ref and `cube_count` (group adds `cubes[]` of
  `{name, uuid}`, model adds `group_count`); distance parses to
  `{distance, gap:{x,y,z}, delta:{x,y,z}, overlapping}` with both boxes;
  clearance parses to `{overlaps[], overlap_count, scanned_cubes,
  coplanar_epsilon:0.02, overlap_min:0.1}` agreeing with `check_model`
  coplanar pairs (pinned headless by `tests/contract/measure-math.test.mjs`,
  which drives the real bridge handlers with stubbed Blockbench globals). Empty model returns `min`/`max`/`center` null with
  `size` `{x:0,y:0,z:0}` and `cube_count` 0; empty group errors naming
  `group`; missing/unknown distance refs error naming `a`/`b`. On an owned instance also cover: a cube with swapped `from`/`to`,
  a nested group (grandchild cubes included), an empty group, and an empty
  model.
- [ ] **Visual review (`screenshot_views`, owned-instance only)** — Reach:
  MCP `tools/call screenshot_views` against a Blockbench you started with
  an open project. Drive: call with default views, save returned PNGs to
  `.artifacts/<task>/`. Blueprint variant: `{views:[{view:"front",
  ortho:true, px_per_unit:8}], ortho:true, wireframe:false}` — per-view
  `{view, ortho?, px_per_unit?, wireframe?}` overrides call-level flags.
  Proved when: one PNG per requested view exists on
  disk and each is a non-empty image; summary text ends
  `(projection restored)` and each `View:` line names its blueprint flags.
  Untested without an owned instance —
  record `untested + reason`, never silent.
