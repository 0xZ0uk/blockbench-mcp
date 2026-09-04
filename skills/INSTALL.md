# Installing the Blockbench MCP skills

Four skills ship in `skills/`. Install the ones your agents need — most sessions want the core
plus the domain skill for the task at hand:

| Folder | Load it when |
|--------|--------------|
| `blockbench-mcp/` | Always — core: connection check, golden loop, tool map, gotchas |
| `blockbench-modeling/` | Building shape/geometry (proportions, meshes, hierarchy) |
| `blockbench-texturing/` | UV packing, baking, palettes, features, glow |
| `blockbench-animation/` | Rigging and animating |

These skills teach the workflow. They do NOT replace the MCP — you still need the MCP connected
(Blockbench open with `Tools ▸ Start MCP Server`, and the `blockbench` MCP server configured in
your client).

## Updating

Edit the files in `skills/<name>/`, then:

- re-copy to your agent's skill directory (Code & friends), and/or

## What's inside

- `blockbench-mcp/SKILL.md` — connection check, golden workflow, hard rules, tool cheat-sheet,
  format choice, cross-cutting gotchas.
- `blockbench-modeling/` — silhouette-first discipline, proportion templates (quadruped /
  humanoid), mesh primitives (`add_mesh`), scale/orientation conventions,
  `references/modeling-scripts.md` (UV-pack fallback, procedural decoration, geometry probe).
- `blockbench-texturing/` — box-UV discipline (`pack_uv`), the smooth bake, palette rules, glow
  cores, feature painting, `references/texturing-scripts.md` (bake, features, resize, PNG export).
- `blockbench-animation/` — joint pivots, rotation-sign conventions, walk/run/attack/sleep +
  humanoid recipes, pose preview, `references/animation-scripts.md` (preview, rest reset,
  animation export).
