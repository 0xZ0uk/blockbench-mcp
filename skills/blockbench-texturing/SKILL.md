---
name: blockbench-texturing
description: Texture models in Blockbench through the BlockbenchMCP tools. Use when packing UVs, creating or resizing textures, baking a smooth stylised base, painting features (eyes/claws/runes), building palettes, or making emissive/glow accents read as glow. Covers box-UV facts, the smooth-bake philosophy, palette discipline, and feature-after-blur ordering. Load with the blockbench-mcp core skill.
---

# Blockbench texturing — smooth, stylised, readable

The house look is **smooth, not noisy**: soft gradients, directional face shading, subtle mottle,
per-island blur. No harsh per-pixel noise, no dark 1px outlines on every face — that reads as a
dirty grid. Think stylised low-poly (Synty-style), not retro pixel art.

## Box-UV facts (the #1 failure source)

- Box UV does NOT auto-pack: every new cube sits at `uv_offset [0,0]` and all faces share the
  top-left pixels. **Call `pack_uv` after every batch of `add_cubes`, resize, or decoration
  pass.** It shelf-packs, recomputes face UVs, and auto-grows the texture if it overflows.
- Cube footprint: a cube of size (w,h,d) unwraps to `2*(w+d)` wide × `(h+d)` tall. Budget the
  texture accordingly: 64-192 px on the long side depending on cube count.
- Mesh primitives don't use box UV — give each a `uv` rect at creation, or map via
  `set_cube_uv`/script. Otherwise every face maps the whole texture.

## The smooth bake (the core of good textures)

Assign the texture to every face, then bake a smooth shaded base per face and blur each island.
Call the `smooth_bake` tool (parameterised recipe: bake + blur + rescale/export helpers live
there and in `references/texturing-scripts.md`). Structure:

1. Assign texture to all faces (no gaps — `check_model` catches orphans).
2. Per face: soft vertical gradient in the base colour + directional shading (up lighter ×~1.1,
   down darker ×~0.8, sides between).
3. Subtle low-contrast mottle (~10% of pixels, ±10-15%) — texture, not noise.
4. 3x3 box blur per UV island (the "smooth brush"). Skip glow cores and hard parts for crisp
   edges.
5. Paint crisp features AFTER the blur (next section).

Tuning: pale/smooth surfaces → less mottle; fur/foliage → more; grizzled backs → a few darker
vertical streaks on `up` faces before the blur.

## Palette discipline

- Pick a small palette up front: 2-4 tones per material, one accent for glow. Name the mapping
  in the bake's `colors` (cube-name regex → colour) so it's reproducible and editable.
- Bodies/limbs often share the head's base colour; darker accents only at extremities. Don't
  default everything to brown.
- Directional shading stays within the palette: derive light/dark tones from the base colour
  (×1.1 / ×0.85), don't introduce new hues per face.

## Glow / emissive (`*_core` cubes)

- Name emissive cubes `*_core` (eyes, lanterns, gems, runes).
- In the bake fill them BRIGHT: base colour ×1.1-1.4, brighter centre, NO dark shading, NO blur.
- Crisp features (eye hotspots) painted after the bake.
- For real in-engine glow, produce an emissive layer later (`create_vfx_texture` for
  pixel-VFX looks; or export a second PNG with only the emissive islands filled).

## Feature painting (after the bake)

Eyes, noses, claws, runes go on crisp AFTER the blur, on a specific cube face using its UV rect
with face-relative coordinates — via `paint_faces`, or the script in
`references/texturing-scripts.md`. Faces are usually small: 1-4 px features, plus a 1px darker
socket/outline around an eye if it needs separation (that's design, not the dirty grid outline).

## Texture lifecycle

- Create mid-tone fill (`create_texture`, size by cube count; 64 for props, 128+ for characters,
  192 when decoration-dense).
- `resize_texture` / the rescale script when packing overflows — preserve paint when growing
  (`pack_uv` auto-grows for box-UV layouts).
- `import_texture` for external art; `set_texture_render_mode` if the engine needs a specific
  alpha/render mode.
- Export the PNG via `export_project`/script (`Blockbench.writeFile`, `savetype:'image'`).
