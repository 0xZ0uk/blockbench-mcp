---
description: Bake a Blockbench texture — flat-first justification, smooth bake, feature pass, export
---

Load the `blockbench-mcp` core skill and the `blockbench-texturing` skill, then run the
bake path for $ARGUMENTS. The texturing skill owns the recipe (box-UV discipline,
smooth-bake philosophy, palette discipline, feature-after-blur ordering); this command
only drives its gates.

Flat-first gate — refuse to bake until it passes: default to flat colors and materials
(`create_texture` fills plus `apply_texture`). Bake only when it does something visible
a flat color cannot (gradient plus directional shading, material mottle, crisp painted
features, emissive glow). If the model already reads with flat fills, stop — do not bake.

Bake gate, in order: `pack_uv` after every batch of new or resized cubes (no bake on
unpacked UVs), then the native bake path only — `smooth_bake`, or `detail_cubes` for
grain and edge-darkening knobs — then crisp features with `paint_faces` AFTER the blur.
Pin the reference with `set_reference_image` before the bake and run `compare_views`
after each pass with the same camera, scale, and image size.

Export gate: run `check_model` and require zero errors (no untextured-face gaps)
before `export_textures`. Address every compare differ before exporting.
