---
name: blockbench-modeling
description: Build well-proportioned 3D geometry in Blockbench through the BlockbenchMCP tools. Use when planning or building a model's shape — proportions, group hierarchies, bulk cubes, mesh primitives (crystals/cones/cylinders/wedges), mirroring, or fixing a silhouette that reads wrong. Covers silhouette-first discipline, animal/humanoid proportion templates, mesh-vs-cube strategy, and the review checklist. Load with the blockbench-mcp core skill.
---

# Blockbench modeling — shape, hierarchy, meshes

Build the SHAPE before spending anything on texture or animation. A great texture cannot rescue
wrong proportions.

## Silhouette first, always

Screenshot the **grey (untextured) silhouette** from the reference's exact angle before investing
in texture. Use `screenshot_views` with explicit `{position,target}` to match the reference
camera. Fix the shape until it reads correctly; only then texture.

## Choosing the format (before the first add_group)

- Generic game models → `new_project { format: "free" }`: cubes AND meshes supported.
- Cube-only formats (e.g. Java entity or other cube-only animated-entity formats): no mesh export
  — build crystals/wedges from cubes rotated 45° instead. Confirm with `list_formats`.

## Hierarchy (bones & groups)

- Build the whole hierarchy in ONE `add_groups` call: root → body → head, limbs, decorations.
  Put every group's `origin` at the real JOINT (shoulder/hip/neck) so it pivots correctly.
- Parent every cube to a group — unparented cubes are a `check_model` failure and break
  animation later.
- Decorative mass (cloaks, armour, leaves) is many small cubes parented to body/head. Watch
  clipping: stagger each piece's outer depth, keep overlap low (see the decoration snippet in
  `references/modeling-scripts.md`).

## Cube strategy

- Use `add_cubes` in bulk (20-100 cubes per call); segment limbs (upper/lower/paw), give heads a
  separate snout, use 20-50+ cubes for a creature.
- Mirror L/R inside the same call, or build one side and use `mirror_element` (it flips geometry,
  off-axis rotation signs, and renames left<->right).
- A single cube only rotates cleanly on ONE axis. Compound angles → group + rotate the group.
- Break silhouette monotony with proportion, not random detail.

## Mesh primitives (`add_mesh`)

Meshes break the axis-aligned-box look — use them wherever the shape is round, sharp, or organic:

- `crystal` / `gem` / `shard` / `diamond` / `octahedron` — crystal cores, gems, shards. For
  `shard`, make h large.
- `pyramid`, `wedge`, `prism` — roofs, beaks, blades, fins, teeth.
- `cone`, `cylinder` (segments default 8) — horns, pillars, trunks, tails.
- `plane` (+ optional `crossed: true`) — VFX: flames, auras, particles; pair with
  `create_vfx_texture`.
- Args: `size [w,h,d]`, `from` (lower corner), `origin` (pivot), `rotation`, `segments`,
  `texture`, `uv` rect, `parent`.
- Only in mesh-capable formats (`free`); in cube-only formats approximate with rotated cubes.

Triangle cost: cubes are 12 tris; primitives scale with `segments`. Keep props in the hundreds to
low thousands of tris, characters low-tens-of-thousands — roughly Synty-style stylised budgets.

## Scale convention (state it before building)

There's no block-based reference to inherit units from, so pick a convention and stay consistent
for the whole model:

- Suggested: 1 unit = 1 m; humanoid ≈ 1.8 units tall, ground at y=0.
- Keep every entity on the same convention across a project so exports align in-engine.
- Record the choice in the project (e.g. project name or a root group note) so a later session
  doesn't re-derive it.

## Orientation

Models conventionally face **-Z** (matches most engines; Unreal's +X forward is the common
exception — confirm your target). Camera presets are mirrored accordingly: Blockbench's `back`
preset shows a -Z-facing model's FACE.

## Proportion templates (starting points, tune to the reference)

### Quadruped (bear/boar/cat) — compact, body-dominant

The biggest failure mode is the **"camel" silhouette**: tall hump + long neck with a high/forward
head + long thin legs. Fix by copying compact-animal proportions:

- **Body** is a big dominant box; everything else small relative to it.
- **Head** small and LOW at the front, head-top clearly BELOW body top, almost no neck, short
  broad snout nub.
- **Hump** (if any) is a subtle rise over the shoulders, blended — not a tall block.
- **Legs** short, thick, stubby; body sits low to the ground.

Verified starting numbers (1-unit ground, facing -Z): body `[-7,7,-10]→[7,17,10]`; subtle hump
`[-6.5,16.5,-9]→[6.5,18.5,-1]`; head `[-4,8,-15]→[4,15,-9]` (top 15 < body top 17); snout
`[-3,8,-17.5]→[3,12,-15]`; front legs upper y4-9.5 / lower y0-4.5 (width ~4).

### Humanoid

- Groups: `body[0,12,0]`, `head[0,23,0]`, `arm_left/right` at shoulders `[±5,22]`,
  `leg_left/right` at hips `[±2.2,12]`, decorations under head/body as designed.
- Split limbs upper/lower for bending; scale heights to your unit convention.

### Capes / cloaks / skirts

Shingled rows of small panels, long at the back, open at the front if a chest detail should stay
visible. Don't blanket the torso unless the reference does.

## Glow / accents

Bright emissive parts (eyes, lanterns, gems) are named `*_core` and kept clear of other geometry
(hang lanterns OUTSIDE the head silhouette). The texturing skill fills them bright in the bake.

## Review checklist (every pass, be honest)

- Did I screenshot the SAME angle as the reference? Overlay them mentally.
- Silhouette: same overall shape/stance? Head size & position? Limb length/thickness?
- `check_model`: zero untextured faces / bad UVs / unparented cubes?
- **If anything looks wrong in the screenshot, FIX it now.** Never call a visible flaw
  "acceptable" — that is the #1 mistake. Match the reference, not a lowered bar.

## Worked lessons

- A first "grizzly" got roasted as a "camel bear thing" — caused entirely by the proportions
  above. Rebuilding compact (small low head, subtle hump, stubby legs, big body) fixed it.
- Decorative panels z-fight when many overlap coplanar — reduce count and stagger each panel's
  outer depth.
- Bodies/limbs often share the head's base colour, with darker accents only at extremities —
  don't default everything to brown.
