# Checklist — blockbench-mcp user-facing features

One entry per feature: how to reach it, how to drive it, the observable end
state that proves it works. Fix or delete a stale line when the app changes;
never leave it to lie.

- [ ] **MCP catalogue (`tools/list`)** — Reach: spawn `node dist/index.js`
  (stdio), send `initialize` then `tools/list`. Drive: helper `doctor.mjs`
   or a one-off stdio script. Proved when: response lists 53 tools including
   `get_status`, `add_cube`, `add_cubes`, `check_model`, `screenshot_views`,
   `edit_elements`, `delete_elements`, `measure`, `query_elements`, `set_reference_image`,
   `compare_views`, `smooth_bake`.
- [ ] **Contract suite gate (`pnpm test`)** — Reach: repo root after
  `pnpm install`. Drive: `pnpm test`. Proved when: `tsc` build succeeds and
   `node --test tests/contract/*.test.mjs` reports fail 0 with all tests
   passing (tallies grow as cases are added; at ticket #23:
   105 tests / 0 fail, 108 contract cases; at ticket #26:
   115 tests / 0 fail, 118 contract cases; at ticket #27:
   122 tests / 0 fail, 124 contract cases).
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
  (`no_texture`, `coplanar_overlap`, …). Each issue may carry an optional
  `fix` patch `{element, issue, tool, fix}` whose `fix` is directly usable
  as args to the named tool (table-driven + schema-replayed by
  `tests/contract/fixpatches.test.mjs`); `fix` is omitted when no safe
  patch can be derived. The top level carries the machine-readable
  done-gate `gate: {errors, warnings, gate_pass}` — errors =
  degenerate_size + zero_uv + uv_out_of_bounds + coplanar_overlap,
  warnings = no_texture + no_bone_parent, `gate_pass` true iff errors == 0
   (table-driven by `tests/contract/gate-summary.test.mjs`).
- [ ] **Done-gate advisory on save (`save_project` warning, ticket #23)** —
  Reach: MCP `tools/call save_project` (mutating — owned instance only for
  live drive; pinned headless). Drive: `check_model` on a failing model,
  then `save_project`. Proved when: the save result parses to
  `{saved:true, path, warning}` with `warning` naming the error count and
  the gate; after a passing check (or with no prior check) the same call
  returns `{saved:true, path}` with no `warning` key — saving never fails
  or blocks on gate state (pinned by
  `tests/contract/done-gate.test.mjs`, which drives the real bridge
  handlers with stubbed Blockbench globals). Live-Blockbench drive on an
  owned instance is optional.
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
- [ ] **Paged element lookup (`query_elements`, read-only)** — Reach: MCP
  `tools/call query_elements` (shared-safe against any open project; the
  bridge handler is also pinned headless). Drive: call `{}` (all nodes),
  `{regex:"^leg"}`, `{parent:"<bone>"}`, `{limit:5, offset:5}`. Proved when:
  the result parses to `{refs:[{name,uuid}], total, offset}` with `total`
  the match count BEFORE pagination (page while `offset + refs.length <
  total`), refs resolve verbatim in `edit_element`/`edit_elements`/
  `measure`, and errors name the field (bad `regex`, unknown `parent`,
  non-positive-integer `limit` / `offset`) — pinned by
  `tests/contract/query-elements.test.mjs`, which drives the real bridge
  handler with stubbed Blockbench globals. Live-Blockbench drive on an
  owned instance is optional: a live `tools/call` against a real project
  (e.g. bone regex + follow-up `measure`) was recorded `untested` at
  ticket #24 (no Blockbench running on :8787 at verify time).
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
- [ ] **Smooth bake (`smooth_bake`, ticket #27)** — Reach: MCP
  `tools/call smooth_bake` (needs an open project with a texture; the bridge
  handler is also pinned headless). Drive: call `{}` (all cubes, snippet
  defaults), `{base, colors, noise, blur}` (palette bake),
  `{scope:"selected", elements:["<cube>"]}` (subset). Proved when: the result
  parses to `{baked:true, cubes, faces, texture}` with every chosen face
  assigned, per-face gradient + mottle + per-island blur on the canvas, glow
  (`*_core`) and hard parts (`*_cap`/`*_base`/chains/cords) crisp (no
  mottle/blur), and errors naming the remedy (no texture, no matching cubes)
  — pinned headless by `tests/contract/smooth-bake.test.mjs`, which drives
  the real bridge handler with stubbed Blockbench globals. Live-Blockbench
  drive on an owned instance is optional.
- [ ] **Pinned reference (`set_reference_image`, ticket #25)** — Reach: MCP
  `tools/call set_reference_image` (needs an open project; file paths need
  the desktop app, inline images work anywhere). Drive: pin `{view:"front",
  source:"data:image/png;base64,..."}` (or a file path), re-pin the same
  view, then unpin with `{view:"front", source:""}`. Proved when: pin
  returns `{view:"preset:front", pinned:true, mime, bytes}`, re-pin
  replaces (new `bytes`), and unpin returns `{view, pinned:false}`
  (idempotent); missing files / undecodable images / bad views error
  naming `source` / `view` — pinned headless by
   `tests/contract/set-reference-image.test.mjs`, which drives the real
   bridge handler with stubbed Blockbench globals. Live-Blockbench drive on
   an owned instance is optional.
- [ ] **Structured view comparison (`compare_views`, ticket #26)** — Reach:
  MCP `tools/call compare_views` (needs an open project plus references
  pinned with `set_reference_image`). Drive: compare with an empty store,
  then pin `{view:"front", source:"data:image/png;base64,..."}` and compare
  again with the same camera + `px_per_unit`, then change the model and
  compare once more. Proved when: the empty-store call reports
  `0 match, 0 differ, 1 missing reference` with a per-view error naming
  `view`; the unchanged call reports `MATCH — identical to pinned
  reference (...)`; the edited call reports `DIFFER` with differing-byte
  counts, first-diff offset, and both sizes; every call ends
  `(projection restored)` — pinned headless by
  `tests/contract/compare-views.test.mjs`, which drives the real bridge
  handler with stubbed Blockbench globals. Live-Blockbench drive on an
  owned instance is optional.
