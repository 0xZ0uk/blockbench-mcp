---
name: blockbench-mcp-modeling
description: Build high-quality Minecraft / GeckoLib / Bedrock models, textures and animations in Blockbench through the BlockbenchMCP server (the mcp__blockbench__* tools). Use whenever the user asks to create, model, texture, rig, retexture or animate a creature, character, mob or item in Blockbench, wants to match a reference image, or mentions the blockbench MCP. Encodes the proven workflow and ready-to-paste execute_script snippets so models come out detailed and reference-accurate instead of blocky/flat.
---

# Blockbench MCP Modeling Operator Guide

This skill makes you good at driving Blockbench through the **BlockbenchMCP** bridge
(`mcp__blockbench__*` tools). It captures a workflow and a set of scripts that have been
verified live against Blockbench 5.1.4 + GeckoLib. Follow it and models come out detailed,
smoothly textured and close to the reference — not a pile of flat boxes.

## Connection check (do this first)

The tools talk to a local server **inside** Blockbench. If a tool returns
`Cannot reach Blockbench on http://127.0.0.1:8787`:
- The desktop Blockbench app must be **open** and the **MCP server started**: in Blockbench,
  `Tools ▸ Start MCP Server`. The server stops when Blockbench is closed.
- Then call `get_status` to confirm. If a model is requested, also call `get_guide` once.

## The golden workflow (always loop)

```
get_status / get_guide
 -> plan bones        (sketch the skeleton + joint pivots)
 -> add_groups        (bulk: whole posed bone hierarchy in one call)
 -> add_cubes         (bulk: 20-100 cubes; segment limbs; mirror L/R in the same call)
 -> PACK BOX UV       (execute_script shelf packer — see references/workflow-and-scripts.md)
 -> create_texture    (mid-tone fill, size 64-192 depending on cube count)
 -> BAKE TEXTURE      (execute_script smooth bake — gradients + soft mottle + per-island blur)
 -> paint features    (eyes, nose, claws, runes, glow cores)
 -> screenshot_views  (front / side / back / iso AND the reference's exact angle)
 -> check_model       (fix untextured faces, bad UVs, unparented cubes)
 -> COMPARE to the reference, fix what is wrong, screenshot again. Repeat 2-4x.
 -> save_project + export (geo.json, texture png, animation json)
```

Iterate at least 2-3 passes. The first pass is never good enough.

## Hard rules (these are the difference between good and bad)

1. **Box UV does NOT auto-pack.** Newly created cubes all get `uv_offset [0,0]` and overlap.
   You MUST run the shelf-packer script (sets `uv_offset` + calls `cube.mapAutoUV()`) before
   texturing, or every face shares the top-left pixels. Re-pack whenever you add/resize cubes.

2. **Texture SMOOTH, not noisy.** Per face: a soft vertical gradient in the base colour +
   directional face shading (up lighter, down darker) + *subtle* low-contrast mottle, then a
   **3x3 box blur per UV island** (the "smooth brush"). Do NOT use harsh per-pixel noise and do
   NOT draw a dark 1px outline on every cube face — that reads as a dirty grid. Paint crisp
   features (eyes/claws) AFTER the blur. See references/workflow-and-scripts.md.

3. **Proportions first; match the silhouette to a real reference.** Break limbs into segments
   (upper/lower/paw), give heads a separate snout, use 20-50+ cubes for a creature. Before
   texturing, screenshot the GREY silhouette from the reference's angle and fix shape. See
   references/proportions-and-review.md (includes the "don't make a camel" lesson).

4. **Use rotation; a single cube only rotates cleanly on one axis.** For compound angles or
   posable parts, put cubes in a GROUP and rotate the group, or nest groups. A bone's `+X`
   rotation tilts its FRONT (-Z side) UP — verify pose direction by screenshot, don't assume.
   See references/rigging-and-animation.md.

5. **Glow / emissive** (lanterns, eyes, gems): name those cubes `*_core`; in the bake fill them
   BRIGHT (colour x1.1–1.4, lighter centre, NO dark shading, NO blur) so they read as glowing.
   For real in-game glow, also produce an emissive texture layer later.

6. **REVIEW CRITICALLY.** When a screenshot looks off, FIX it — never write "good enough" about
   a flaw you can see. Compare against the reference, not your own lowered bar. The most common
   self-deception is rationalising a wrong pose or proportion after seeing it.

## Tool cheat-sheet

- Discover/plan: `get_status`, `get_guide`, `list_outliner`, `get_element`, `list_formats`.
- Build: `add_groups`, `add_cubes` (bulk; prefer over single `add_group`/`add_cube`),
  `edit_element`, `delete_element`.
- Texture: `create_texture`, `detail_cubes` (quick base coat), `paint_faces` (features in
  face-relative coords), `paint_texture`, `get_texture`, `apply_texture`.
- Review: `screenshot`, `screenshot_views` (multi-angle), `check_model`.
- Animate: `create_animation`, `add_keyframes` (bulk), `list_animations`.
- Export: `save_project`, `export_project`, plus `execute_script` for texture PNG / animation JSON.
- Escape hatch: `execute_script` — full Blockbench API. This is where the packer, the smooth
  bake, procedural decoration, and animation-pose previews run.

## Reference files (read the one you need before acting)

- **references/workflow-and-scripts.md** — the exact execute_script snippets: UV shelf-packer,
  the parameterised smooth-bake (with colour map, glow, face/eyes, blur), procedural decoration
  generator (leaves/scales), animation-pose preview, and texture/animation export.
- **references/proportions-and-review.md** — how to size animals & humanoids, reference-matching
  discipline, and worked lessons (grizzly de-camel, forest-spirit cape/face fixes).
- **references/rigging-and-animation.md** — humanoid & quadruped rigs, rotation-sign facts, and
  keyframe recipes for idle / walk / run / attack / sleep.

## Gotchas (verified)

- **`require` is NOT available inside `execute_script`.** To write files use
  `Blockbench.writeFile(path, { content, savetype })` — `savetype:'image'` with a dataURL for
  PNG, `savetype:'text'` for JSON. (`fs` works only inside the plugin, not the script sandbox.)
- **Camera presets are mirrored vs the creature.** Models usually face `-Z`, so Blockbench's
  `back` preset shows the creature's FACE. Use `screenshot_views` with explicit
  `{position,target}` for the exact reference angle.
- **Array arguments may arrive as a string** on some tools whose schema lacks a strict type
  (e.g. `detail_cubes.cubes`). If a bulk-array tool errors, pass a single value, or just do the
  work in `execute_script`.
- **Animation export**: `Animator.buildFile(undefined, false)` returns the bedrock/GeckoLib
  animation object — stringify and `Blockbench.writeFile` it. Geometry exports via `export_project`.
- **Reset before saving**: `Modes.options.edit.select()` + `Timeline.setTime(0)` so the saved
  file shows the rest pose, not a mid-animation frame.
- **GeckoLib**: store plugin id `geckolib`, format id `geckolib_model` (box_uv, animation_mode).
  `install_plugin {id:'geckolib'}` is idempotent.
