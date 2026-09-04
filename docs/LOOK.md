---
version: alpha
name: PS1 Look
description: Mid-90s console aesthetic — chunky low-poly geometry, tiny point-filtered pixel textures, limited palettes, dithered shading. Celebrate the grid, never hide it.
colors:
  primary: "#8B5A2B"
  secondary: "#5A7A3A"
  tertiary: "#B03A2E"
  neutral: "#C8BCA0"
  shadow: "#2A2030"
  highlight: "#F0E8D8"
texture:
  resolution: 64px
  resolutionMax: 128px
  filtering: point
  paletteMax: 16
geometry:
  triBudgetProp: 300
  triBudgetCharacter: 1200
  shading: flat
  gridSnap: true
treatments:
  dithering: true
  unlitBrightFaces: true
  affineWobble: emulate
components:
  texture-hero:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.highlight}"
  texture-shadow:
    backgroundColor: "{colors.shadow}"
---

## Overview

Mid-90s console look: the hardware couldn't hide anything, so the style doesn't try to. Chunky readable masses, pixel-grid textures at 64–128px with point filtering, tight palettes, dithered gradients. Both the polygon edges and the texels stay visible — they reinforce each other. Anything that smooths, blurs, or hides resolution fights the look.

## Colors

- **Palette-first.** Max ~16 colors per model, drawn from the tokens above. New hues need justification, not the other way round.
- **High-contrast readability.** PS1 scenes were dark with hot accents — deep shadow token for cavities/undersides, highlight token for emissive bits, eyes, pickups.
- **Dither, don't gradient.** Any tonal transition (shadow falloff, glow fade) is ordered dithering between two palette colors, never a smooth blend.

## Geometry

- **Chunky primitives.** Boxes first, low-segment cylinders/cones (default 5–6 sides, not 8+) where round. Every edge visible under flat shading.
- **Budgets.** Props under ~300 tris, characters under ~1200. Consistency across assets matters more than the exact number.
- **Grid snap.** Vertex positions snapped to whole/half units where possible — echoes the era's missing subpixel precision and keeps the wobble coherent.
- **Silhouette over surface.** Readable outline from front/side/three-quarter; surface detail only where the silhouette already reads.

## Textures

- **Resolution.** 64px default, 128px luxury, never above. Each face gets few texels — paint accordingly.
- **Filtering.** Point (nearest-neighbor) always. Bilinear is the single fastest way to break the look.
- **Hand-painted pixels.** Limited colors, crisp 1px features, no noise, no blur, no per-island smoothing. The smooth-bake is *banned* under this look — flat fills + deliberate dither instead.
- **UVs.** Box UV packed tight; texel density roughly uniform. Pixel grid aligned to face edges where it matters.

## Shading & Rendering

- **Flat shading.** Every face its own light value; the polygon grid is the aesthetic.
- **Unlit-bright accents.** Emissive bits (eyes, runes, pickups) painted near-full-bright, readable in the dark.
- **Fog-friendly contrast.** Models must read against dark backgrounds at distance — check screenshots on dark, not terv-neutral grey.

## Blockbench Mapping

- `new_project { format: "free" }`, flat shading on, ground y=0.
- `create_texture` at 64 (props) or 128 (characters), point filtering assumed downstream.
- `pack_uv` after every geometry batch; keep islands pixel-aligned.
- `paint_faces` for crisp 1–2px features; `detail_cubes` for flat base coats only.
- Meshes: 5–6 segment cones/cylinders; crystals/shards sparingly (they skew fantasy, not retro).
- Exports: model JSON + PNG; engine applies point filtering + optional vertex-snap/wobble shader.

## Do's and Don'ts

- Do: celebrate texels, dither transitions, snap to grid, check on dark backgrounds.
- Don't: bilinear filter, blur/bake smooth gradients, exceed 128px, add noise/grain, hide polygon edges, texture what a flat palette color already says.

## Review Checklist

- [ ] Outline readable from front / side / three-quarter at distance?
- [ ] All textures ≤128px, point-filtered, palette-only?
- [ ] Transitions dithered, never blended?
- [ ] Tri count within budget and consistent with sibling assets?
- [ ] Reads against a dark background?
