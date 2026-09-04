# Checklist — blockbench-mcp user-facing features

One entry per feature: how to reach it, how to drive it, the observable end
state that proves it works. Fix or delete a stale line when the app changes;
never leave it to lie.

- [ ] **MCP catalogue (`tools/list`)** — Reach: spawn `node dist/index.js`
  (stdio), send `initialize` then `tools/list`. Drive: helper `doctor.mjs`
  or a one-off stdio script. Proved when: response lists 48 tools including
  `get_status`, `add_cube`, `add_cubes`, `check_model`, `screenshot_views`,
  `edit_elements`, `delete_elements`.
- [ ] **Contract suite gate (`pnpm test`)** — Reach: repo root after
  `pnpm install`. Drive: `pnpm test`. Proved when: `tsc` build succeeds and
  `node --test tests/contract/*.test.mjs` reports fail 0 with all tests
  passing (tallies grow as cases are added; currently 11 pass / 0 fail).
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
- [ ] **Visual review (`screenshot_views`, owned-instance only)** — Reach:
  MCP `tools/call screenshot_views` against a Blockbench you started with
  an open project. Drive: call with default views, save returned PNGs to
  `.artifacts/<task>/`. Proved when: one PNG per requested view exists on
  disk and each is a non-empty image. Untested without an owned instance —
  record `untested + reason`, never silent.
