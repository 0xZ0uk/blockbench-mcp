---
version: alpha
name: Hytale Look
description: Modern stylized voxel game with retro pixel-art textures — primitive-only models, consistent pixel ratio, readable personalities. Simplicity is key, and simplicity is not low quality.
colors:
  primary: "#6A8A3A"
  secondary: "#4A6A8A"
  tertiary: "#B05A2E"
  neutral: "#D8CCB0"
  shadow: "#2E2833"
  highlight: "#FFF2D8"
texture:
  resolution: 64px
  resolutionMax: 128px
  filtering: point
  paletteMax: 24
geometry:
  triBudgetProp: 300
  triBudgetCharacter: 1500
  shading: flat
  gridSnap: true
treatments:
  cubesAndQuadsOnly: true
  consistentPixelRatio: true
  personalityFirst: true
---

## Overview

Hytale's official line: "a modern, stylized voxel game, with retro pixel-art textures," judged
against four pillars — immersive, fantasy, stylized, flexible. Models are primitive shapes
anyone can read and remake (empowering creator creativity is the point), textures carry the
retro charm, and every character gets a unique personality twist on its archetype. Takes many
iterations to look this simple.

## Colors

- **Carefully selected palette.** Fewer, more deliberate colors than the subject suggests;
  players must read the world regardless of clutter.
- **Pixel-art warmth.** Retro-flavored ramps with hand-painted variation inside each step —
  the intersection of low-definition pixel art and hand-painted 3D.
- **Per-character accent.** Each character owns one twist color or marking; archetypes are
  reimagined, not repeated.

## Geometry

- **Cubes and quads ONLY.** No triangles, no edge loops, no special topology, no spheres —
  hard engine constraint, not taste. Pyramids are out; approximate with rotated cubes.
- **Primitive-composed.** Anyone looking at the model should understand how it was made;
  technical structure stays simple enough to iterate.
- **Iconic proportions.** Readable, slightly exaggerated archetype shapes; personality via
  proportion twists (big brows, long ears, hunched shoulders), not surface noise.
- **Lively by construction.** Models are built to move — eyes that express, limbs that wander.
  Keep pivots clean and parts separated with animation in mind.

## Textures

- **Resolution.** Multiples of 32px only (32 / 64 / 96 / 128…); non-square allowed.
- **Filtering.** Point; pixel ratio consistent across every texture in the set (the Hytale
  plugin enforces this — keep it that way).
- **Retro pixel-art treatment.** Visible texels, hand-painted ramps, crisp features. Detail
  density higher than Minecraft (modern engine budget) but the same pixel honesty.
- **Eyes with intent.** Faces carry expression — eyes are a feature pass of their own, not
  two dark pixels.

## Shading & Rendering

- **Flat shading** on cubes; quads for soft transitions (foliage layers, cloth, hair sheets).
- **Modern engine, retro surface.** Lighting does more work than in Minecraft, but textures
  never go smooth-bake — pixel structure stays visible up close.
- **Readable in clutter.** Check the model inside a busy scene mock, not on empty grey;
  "reads regardless of clutter" is a pillar, so test it.

## Blockbench Mapping

- Hytale format via the official Hytale Blockbench plugin (handles pixel ratio + correct
  model/animation export); keep the plugin updated (early access).
- `add_cubes` + `add_plane` (quads) only; `add_mesh` is banned — verify format rejects nothing
  by never creating meshes in the first place.
- `pack_uv` after every batch at 32px-multiple canvas sizes; keep pixel ratio uniform.
- `paint_faces` for features incl. expressive eyes; flat base coats via `detail_cubes`.
- Exports: model + animation JSON through the Hytale plugin's codec, PNG alongside.

## Do's and Don'ts

- Do: cubes + quads, 32px-multiple textures, consistent pixel ratio, personality twists,
  expressive eyes, test in clutter.
- Don't: triangles/meshes/spheres, non-multiple-of-32 canvases, drifting pixel ratios,
  archetype clones, smooth-baked surfaces, dead eyes.

## Review Checklist

- [ ] Cubes and quads only — zero triangles/meshes?
- [ ] Textures multiples of 32px, pixel ratio consistent across the set?
- [ ] Archetype readable + one personality twist present?
- [ ] Eyes expressive, not placeholder?
- [ ] Reads inside a cluttered scene, not just solo?
- [ ] Animated parts separated with clean pivots?
