---
version: alpha
name: Minecraft Look
description: Vanilla Minecraft aesthetic — minimal cubes, one texel per unit, pixel-true UVs, detail in the texture not the geometry. Simplicity is the style.
colors:
  primary: "#7A5A38"
  secondary: "#5A7A3A"
  tertiary: "#6A6A6A"
  neutral: "#C8BCA0"
  shadow: "#3A3230"
  highlight: "#F0E8D8"
texture:
  resolution: 16px
  resolutionMax: 64px
  filtering: point
  paletteMax: 24
geometry:
  triBudgetProp: 100
  triBudgetCharacter: 800
  shading: flat
  gridSnap: true
treatments:
  unitTexelParity: true
  planesOverPieces: true
  stairSlants: false
---

## Overview

Vanilla Minecraft: the model defines the shape, the texture carries the detail. Element counts
stay minimal, one texture pixel maps to one model unit, and nothing ever stretches. Round things
become single elements, small parts become planes with strategic transparency — never staircases
of tiny cubes. The look reads as intentional simplicity, not missing effort.

## Colors

- **Ramps, not blends.** Shading runs through short HSV color ramps (3–5 steps per material);
  neighboring ramp colors stay close in hue, stepping in value/saturation.
- **Consistent texel density (no mixels).** Every visible face shares the same pixels-per-unit;
  mixing resolutions on one model breaks the look instantly.
- **Palette per asset family.** Blocks sit at 16px; entities get 64x64 canvases but the same
  ramp discipline.

## Geometry

- **Cubes only (+ planes).** No meshes, no triangles, no cylinders. A barrel, a pumpkin, a log:
  each is a single element.
- **Minimal elements.** Fewest cubes that still depict the object recognizably. Small details
  become one large element with transparent pixels, not clusters of small cubes.
- **Slants by rotation, never stairs.** Depicting curves as stair-steps is banned; a justified
  single rotated element is the move, and even that sparingly.
- **Grid discipline.** Integer positions and sizes; 1 unit = 1 texel, always.

## Textures

- **Resolution.** 16px for blocks/items, up to 64x64 for entities. Never above.
- **Filtering.** Point. UVs on integer pixel boundaries — floating-point UVs round down in
  downstream renderers and smear detail.
- **UV parity.** Box UV unwraps automatically and preserves the 1:1 ratio; per-face UV uses
  Auto UV so faces never squash or stretch. Check the ratio on every element.
- **Detail lives here.** Faces, shading, panel lines, wood grain — all painted texels. If you're
  adding geometry to say what a pixel could say, delete the geometry.

## Shading & Rendering

- **Flat shading**, hard edges, no smoothing groups.
- **Face-shading convention.** Top faces brightest, sides mid, bottom darkest — painted into the
  texture ramps, consistent across the whole asset family.
- **North is front.** Character faces, doors, fronts sit on the north face; keep the convention
  or every downstream user misreads the model.

## Blockbench Mapping

- Java block/entity or Bedrock format as the target demands; `box_uv` on for entities.
- `add_cubes` with integer from/to; `add_plane` for transparency-detail pieces.
- `pack_uv` after every batch; verify no stretched faces (footprint math: w,h,d in units =
  texels 1:1).
- `paint_faces` / `paint_texture` at exact pixels; no blur, no bake, no mottle.
- Exports: model JSON + PNG through the format codec.

## Do's and Don'ts

- Do: fewest elements, 1:1 texel parity, ramps, planes with transparency, rotate (don't stair).
- Don't: stair-step curves, stretched UVs, floating-point UV placement, mixels, mesh
  primitives, geometry that a pixel could have said.

## Review Checklist

- [ ] Fewest elements that still depict the object?
- [ ] 1 texture pixel = 1 model unit on every face, no stretch?
- [ ] UVs on integer boundaries?
- [ ] Single texel density across the model (no mixels)?
- [ ] Round objects as single elements; small parts as planes, not cube clusters?
- [ ] Face-shading convention consistent with the family?
