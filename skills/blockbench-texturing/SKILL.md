---
name: blockbench-texturing
description: Texture models in Blockbench through the BlockbenchMCP tools. Use when packing UVs, creating or resizing textures, baking a smooth stylised base, painting features (eyes/claws/runes), building palettes, or making emissive/glow accents read as glow. Covers box-UV facts, the smooth-bake philosophy, palette discipline, and feature-after-blur ordering. Load with the blockbench-mcp core skill.
---

# Blockbench texturing — smooth, stylised, readable

The house look is **smooth, not noisy**: soft gradients, directional face shading, subtle mottle,
per-island blur. No harsh per-pixel noise, no dark 1px outlines on every face — that reads as a
dirty grid. Think stylised low-poly (Synty-style), not retro pixel art.

## Flat-first rule (texture as exception)

Default to flat colors and materials. Bake a texture only when it does something visible a flat
color cannot: a soft vertical gradient plus directional shading per face, a subtle mottle that
reads as material rather than noise, crisp painted features (eyes, runes, trim), or a bright
emissive core that must read as glow. If the model already reads at the review gate with flat
fills from `create_texture` plus `apply_texture`, stop — do not bake. When the bake earns its
keep, it is the native bake path below and nothing else.

Single seam: the ONLY bake path is `smooth_bake` (palette-first base coat) and its variant
`detail_cubes` (same recipe plus grain and edge-darkening knobs); the ONLY export path is
`export_textures`. No raw-JS equivalent remains — the retired `execute_script` bodies are
intentionally not kept in `skills/blockbench-texturing/references/texturing-scripts.md`. One
seam: the tools are the recipe now.

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
Call the `smooth_bake` tool — the parameterised recipe. No `execute_script` version of this
exists anymore; `smooth_bake` and `detail_cubes` are the only bake path. Structure:

1. Assign texture to all faces (no gaps — `check_model` catches orphans).
2. Per face: soft vertical gradient in the base colour + directional shading (up lighter ×~1.1,
   down darker ×~0.8, sides between).
3. Subtle low-contrast mottle (~10% of pixels, ±10-15%) — texture, not noise.
4. 3x3 box blur per UV island (the "smooth brush"). Skip glow cores and hard parts for crisp
   edges.
5. Paint crisp features AFTER the blur (next section).

Tuning: pale/smooth surfaces → less mottle (`noise` ~0.06); fur/foliage → more; grizzled
backs → `detail_cubes` with `streaks:true` (grain lands before its blur) or paint streaks
with `paint_faces` after the bake.

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
with face-relative coordinates — via the `paint_faces` tool ONLY. No raw-JS feature-painting
script remains; tool examples live in `skills/blockbench-texturing/references/texturing-scripts.md`.
Faces are usually small: 1-4 px features, plus a 1px darker
socket/outline around an eye if it needs separation (that's design, not the dirty grid outline).

## Texture lifecycle

- Create mid-tone fill (`create_texture`, size by cube count; 64 for props, 128+ for characters,
  192 when decoration-dense).
- `resize_texture` when packing overflows — the only resize path, no script form
  (`pack_uv` auto-grows for box-UV layouts, so usually you won't need this).
- `import_texture` for external art; `set_texture_render_mode` if the engine needs a specific
  alpha/render mode.
- Export the PNG via `export_textures` (texture selection + optional destination;
  defaults to alongside the project). No raw-JS export script remains.

## Texture review pass (reference-compare)

Pin the reference BEFORE the bake, then compare after each pass with the same camera, scale,
and image size — drift arrives as delta text to address, not a screenshot to rationalize:

1. During intake, pin the reference with `set_reference_image` under the view you will compare
   (the reference's exact angle, plus front/side for palette reads).
2. After the bake, run `compare_views` with the same camera + `px_per_unit` + width/height, and
   `screenshot_views` for the visual read. Fix palette misses the delta names (wrong base,
   shading outside the palette, glow cores reading flat).
3. After features, compare again — crisp details must survive at the pinned scale without
   reintroducing the dirty grid. Address every differ before export.
4. Confirm `check_model` shows zero errors (no untextured-face gaps) before `export_textures`.
