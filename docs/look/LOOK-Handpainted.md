---
version: alpha
name: Handpainted Look
description: Stylized hand-painted game art in the WoW/LoL lineage — smooth gradient bases, directional face shading, deliberate brushwork, rest areas. The texture is a painting that happens to wrap a model.
colors:
  primary: "#7A6A3A"
  secondary: "#3A6A7A"
  tertiary: "#A03A30"
  neutral: "#C8BCA0"
  shadow: "#2A2430"
  highlight: "#FFE8B0"
texture:
  resolution: 128px
  resolutionMax: 256px
  filtering: bilinear
  paletteMax: 32
geometry:
  triBudgetProp: 800
  triBudgetCharacter: 8000
  shading: smooth
  gridSnap: false
treatments:
  smoothBake: true
  restAreas: true
  materialRatio: "70-20-10"
---

## Overview

The hand-painted lineage (World of Warcraft, League of Legends, Wayfinder and its
descendants): low-poly models wearing fully painted textures — gradients, grain, edge
highlights, all brushed by hand (or baked to look it). The texture does the heavy lifting:
form, light, material story. Geometry stays simple so the painting reads. Warm, saturated,
slightly exaggerated — realism is never the reference.

## Colors

- **Saturated and warm.** Push chroma past realism; wood glows amber, metals hum blue-grey.
  Muted palettes read as unfinished in this look.
- **70-20-10 material ratio.** ~70% dominant material, ~20% secondary, ~10% accent/metal —
  keeps scenes balanced no matter how much you paint.
- **Ramps with air.** Each material gets a full value ramp (deep shadow → mid → hot edge
  highlight); transitions are smooth blends, dithering is banned here.

## Geometry

- **Simple supports the paint.** Clean low-poly masses; save the budget for silhouette and
  deformation, not surface detail the texture will say better.
- **Break the straight lines.** Slightly irregular, hand-placed feel — soften perfect edges
  with bevels or nudged verts so nothing looks CAD-made.
- **Rest areas.** Deliberate quiet zones with minimal detail; they make the detailed passages
  sing and keep the eye from exhausting.
- **Built to deform.** Clean topology flow around joints for animation; painting follows the
  bend, never fights it.

## Textures

- **Resolution.** 128px default, up to 256 for heroes. Big enough to hold brushwork, small
  enough to stay stylized.
- **Filtering.** Bilinear — the one look in this folder where smoothing is correct.
- **The smooth bake is home here.** Gradient base per face + directional shading (top light,
  bottom dark) + soft low-contrast mottle + per-island blur, features painted crisp after.
  This is the treatment PS1 and Minecraft ban; here it's the foundation.
- **Painted light.** Edge highlights, occlusion in crevices, grain along wood, wear on metal
  edges — light the form in the texture, don't wait for the engine.

## Shading & Rendering

- **Smooth shading** where the paint flows; flat accents only as deliberate style breaks.
- **Unlit-readable.** Textures carry their own light, so models hold up under flat lighting —
  check with neutral lights, not dramatic ones.
- **Review at distance and up close.** Brushwork must survive both: silhouette at range,
  painting under inspection.

## Blockbench Mapping

- `free`/generic format; meshes welcome where the shape wants them (horns, blades, organic
  accents).
- `pack_uv` after every batch; islands get room to breathe — blur needs pixel margins.
- Native `smooth_bake` for the base coat; `paint_faces` for crisp
  features after the blur; `resize_texture` when packing overflows.
- Exports: model JSON + PNG; engine uses bilinear filtering.

## Do's and Don'ts

- Do: saturated ramps, smooth blends, painted light, rest areas, 70-20-10, bevel the
  CAD-edges, review near and far.
- Don't: dither, point-filter, go muted, detail every surface equally, let geometry say
  what paint should say, trust dramatic lighting to carry a flat texture.

## Review Checklist

- [ ] 70-20-10 material balance present?
- [ ] Full value ramp per material, smooth transitions?
- [ ] Painted light (highlights, occlusion, wear) visible with neutral lighting?
- [ ] Rest areas preserved — not every surface detailed?
- [ ] No CAD-straight edges left unbroken?
- [ ] Features crisp, painted after the blur?
- [ ] Reads both at distance and up close?
