# Installing the Blockbench MCP skills

Five skills ship in `skills/`. Install the ones your agents need — most sessions want the core
plus the domain skill for the task at hand:

| Folder | Load it when |
|--------|--------------|
| `blockbench-mcp/` | Always — core: connection check, golden loop, tool map, gotchas |
| `blockbench-modeling/` | Building shape/geometry (proportions, meshes, hierarchy) |
| `blockbench-texturing/` | UV packing, baking, palettes, features, glow |
| `blockbench-animation/` | Rigging and animating |
| `blockbench-look/` | Any project with a LOOK.md (discover, plan + gate against it) |

These skills teach the workflow. They do NOT replace the MCP — you still need the MCP connected
(Blockbench open with `Tools ▸ Start MCP Server`, and the `blockbench` MCP server configured in
your client).

Each folder is self-contained (`SKILL.md` plus `references/` where listed) — copy folders,
never single files.

## Installing

### OpenCode — no copying

`opencode.json` already points its `skills/` path at `skills/`, so all five skills resolve from
a fresh clone with no manual step:

1. Clone, install, and build the server, then open Blockbench with the bridge running.
2. Confirm your skill listing shows `blockbench-mcp`, `blockbench-modeling`,
   `blockbench-texturing`, `blockbench-animation`, and `blockbench-look`.
3. Invoke one (it loads its `SKILL.md`, e.g. `skills/blockbench-mcp/SKILL.md`) and let it
   drive a real tool call such as `get_status`.

If the listing is empty, check you opened OpenCode at the repo root so it reads `opencode.json`.

### Other clients — folder copy

Copy the folder(s) into your client's skill directory:

```bash
cp -r skills/blockbench-mcp <your-skills-dir>/
cp -r skills/blockbench-modeling <your-skills-dir>/
cp -r skills/blockbench-texturing <your-skills-dir>/
cp -r skills/blockbench-animation <your-skills-dir>/
cp -r skills/blockbench-look <your-skills-dir>/
```

Copy the whole folder — each one carries its `SKILL.md` plus its `references/` directory
where listed (`skills/blockbench-modeling/references/modeling-scripts.md`,
`skills/blockbench-texturing/references/texturing-scripts.md`,
`skills/blockbench-animation/references/animation-scripts.md`).

## Updating

1. Pull the latest tree so `skills/` is current.
2. OpenCode: done — skills resolve from the tree, nothing to re-copy.
3. Other clients: re-run the `cp -r` copy above and overwrite the installed folders.
4. Commands (if installed below): re-run the commands copy so the drivers match the skills.

## Custom commands (OpenCode)

`commands/` ships `/plan-model`, `/silhouette-review`, `/bake-texture`,
`/export-model`, and `/pose-preview` (provisional) — thin drivers over these skills
that enforce the methodology gates. Install by copying the files into
`.opencode/commands/` (project) or `~/.config/opencode/commands/` (global):

```bash
mkdir -p .opencode/commands
cp commands/plan-model.md commands/silhouette-review.md commands/bake-texture.md commands/export-model.md commands/pose-preview.md .opencode/commands/
```

The commands reference the skills, they do not restate them. Re-run the copy on update.

## What's inside

- `skills/blockbench-mcp/SKILL.md` — connection check, golden workflow, hard rules, tool cheat-sheet,
  format choice, cross-cutting gotchas.
- `skills/blockbench-modeling/SKILL.md` — silhouette-first discipline, proportion templates (quadruped /
  humanoid), mesh primitives (`add_mesh`), scale/orientation conventions, plus
  `skills/blockbench-modeling/references/modeling-scripts.md` (UV-pack fallback, procedural decoration, geometry probe).
- `skills/blockbench-texturing/SKILL.md` — box-UV discipline (`pack_uv`), the smooth bake, palette rules, glow
  cores, feature painting, plus `skills/blockbench-texturing/references/texturing-scripts.md` (bake, features, resize, PNG export).
- `skills/blockbench-animation/SKILL.md` — joint pivots, rotation-sign conventions, walk/run/attack/sleep +
  humanoid recipes, pose preview, plus `skills/blockbench-animation/references/animation-scripts.md` (preview, rest reset,
  animation export).
- `skills/blockbench-look/SKILL.md` — look discovery, planning against tokens, gating the pre-save
  review on the look checklist, plus `skills/blockbench-look/references/look-checks.md` (texture
  sizes, palette sampling, tri counts, gate order).
