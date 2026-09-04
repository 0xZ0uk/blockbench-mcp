---
name: blockbench-mcp
description: Core operating guide for driving Blockbench through the BlockbenchMCP server (the mcp__blockbench__* tools). Load whenever Blockbench MCP is mentioned or you are about to build, texture, or animate any 3D model in Blockbench. Covers the connection check, the golden build-review loop, tool-category map, and cross-cutting rules (review critically, iterate 2-3x, save hygiene). Pair with the domain skills (blockbench-modeling, blockbench-texturing, blockbench-animation) for craft rules.
---

# Blockbench MCP — core operator guide

This skill makes you good at driving Blockbench through the **BlockbenchMCP** bridge
(`mcp__blockbench__*` tools). It captures the workflow and cross-cutting rules so models come out
detailed, smoothly textured, and close to the reference — not a pile of flat boxes.

For craft specifics, also load the domain skill you need:
- **blockbench-modeling** — proportions, hierarchy, meshes, silhouette review (before building)
- **blockbench-texturing** — UV packing, the smooth bake, palettes, features
- **blockbench-animation** — rigs, rotation signs, keyframe recipes, export

## Connection check (do this first)

The tools talk to a local server **inside** Blockbench. If a tool returns
`Cannot reach Blockbench on http://127.0.0.1:8787`:
- The desktop Blockbench app must be **open** and the **MCP server started**: in Blockbench,
  `Tools ▸ Start MCP Server`. The server stops when Blockbench is closed.
- Then call `get_status` to confirm. Before building/texturing/animating, also call `get_guide`
  once with the matching `topic` (`modeling`, `texturing`, `vfx`, `animation`, or `reference`) —
  it returns the server's own playbook for that domain. Read it; do not skip it.

## The golden workflow (always loop)

```
get_status / get_guide
 -> plan shape + hierarchy    (silhouette sketch, bone/joint pivots)
 -> add_groups                (bulk: whole hierarchy in one call)
 -> add_cubes + add_mesh      (bulk: 20-100 cubes; segments; mirror L/R in the same call)
 -> pack_uv                   (REQUIRED before texturing box-UV cubes)
 -> create_texture            (mid-tone fill; 64-192 px depending on cube count)
 -> bake                      (execute_script smooth bake — see blockbench-texturing)
 -> paint features            (eyes, claws, runes, glow cores — AFTER the bake)
 -> screenshot_views          (front / side / back / iso AND the reference's exact angle)
 -> check_model               (fix untextured faces, bad UVs, unparented cubes)
 -> COMPARE to the reference, fix what is wrong, screenshot again. Repeat 2-4x.
 -> save_project + export     (project file, texture PNG, model JSON through the format codec)
```

Iterate at least 2-3 passes. The first pass is never good enough.

## Hard rules (these are the difference between good and bad)

1. **Proportions first.** Before texturing, screenshot the grey silhouette from the reference's
   angle and fix the shape. A great texture cannot rescue wrong proportions.
2. **Bulk over single.** Prefer `add_groups` / `add_cubes` / `add_keyframes` (bulk) over their
   single-item forms.
3. **Rotation discipline.** A single cube only rotates cleanly on one axis; for compound angles or
   posable parts, put cubes in a GROUP and rotate the group. Verify pose direction by screenshot,
   never by assumption.
4. **REVIEW CRITICALLY.** When a screenshot looks off, FIX it — never write "good enough" about a
   flaw you can see. Compare against the reference, not your own lowered bar. The most common
   self-deception is rationalising a wrong pose or proportion after seeing it.

## Tool cheat-sheet

- Discover/plan: `get_status`, `get_guide`, `list_outliner`, `get_element`, `list_formats`.
- Project: `new_project` (pick the format first), `set_project_meta`, `save_project`,
  `load_project`, `close_project`, `export_project`.
- Build: `add_groups`, `add_cubes`, `add_mesh` (crystals/cones/cylinders/wedges — mesh-capable
  formats only), `add_plane` (VFX/particles), `mirror_element`, `edit_element(s)`,
  `delete_element(s)`, `measure`, `check_model`.
- Texture: `pack_uv`, `set_cube_uv`, `create_texture`, `detail_cubes` (quick base coat),
  `paint_faces` (features, face-relative coords), `paint_texture`, `apply_texture`,
  `import_texture`, `resize_texture`, `list_textures`, `get_texture`,
  `create_vfx_texture`, `set_texture_render_mode`.
- Review: `screenshot`, `screenshot_views` (multi-angle), `check_model`.
- Animate: `create_animation`, `add_keyframe(s)`, `list_animations`, `remove_animation`.
- Plugins: `list_plugins`, `install_plugin`, `uninstall_plugin`.
- Escape hatch: `execute_script` — full Blockbench API (undo-wrapped snippets live in the
  domain skills' references). Use it when a dedicated tool cannot express the edit.

## Choosing the project format

Run `list_formats` to see what this install supports, then pick by target:

- **Generic game models** → `free` (the generic format): full cube AND mesh support. This is the
  default choice unless the target engine demands otherwise.
- Cube-only formats (e.g. Java block/entity and other cube-only animated-entity formats): meshes
  do NOT export — approximate cones/crystals with rotated cubes instead, and check the format's
  bone requirements before rigging.
- Switching formats after building is painful; choose before the first `add_group`.

## Cross-cutting gotchas (verified)

- **`require` is NOT available inside `execute_script`.** Write files with
  `Blockbench.writeFile(path, { content, savetype })` — `savetype:'image'` with a dataURL for PNG,
  `savetype:'text'` for JSON.
- **Camera presets are mirrored vs the model.** Models usually face `-Z`, so Blockbench's `back`
  preset shows the model's FACE. Use `screenshot_views` with explicit `{position,target}` for the
  exact reference angle.
- **Array arguments may arrive as a string** on some tools whose schema lacks a strict type. If a
  bulk-array tool errors, pass a single value, or do the work in `execute_script`.
- **Reset before saving**: `Modes.options.edit.select()` + `Timeline.setTime(0)` so the saved file
  shows the rest pose, not a mid-animation frame.
- Deleting and recreating an animated bone changes its UUID and breaks existing animations —
  prefer `edit_element` to reposition bones.
- `Undo.initEdit(...)` / `Undo.finishEdit('label')` must wrap every scripted mutation, otherwise
  history and canvas state desync. All reference snippets already do this — keep the pattern.

## Review hygiene

Every build session ends with: `check_model` clean, screenshots from the reference's angle
compared honestly against it, project saved, exports written. If a flaw is visible, the session
is not done.
