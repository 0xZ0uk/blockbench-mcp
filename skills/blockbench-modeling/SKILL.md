---
name: blockbench-modeling
description: Build well-proportioned 3D geometry in Blockbench through gated plan-to-silhouette phases. Use when planning or building a model's shape — reference intake and written plans, skeleton and mass-blocking passes, segmentation rules, mesh primitives, detail gating, rest areas, and the locate-measure-patch fix loop. Load with the blockbench-mcp core skill.
---

# Blockbench modeling — plan to silhouette in gated phases

Build the SHAPE before spending anything on texture or animation. A great texture cannot rescue
wrong proportions. Beginners spend about 5% of time on proportions, pros about 60% — that ratio
is the quality gap. Silhouette is the whole game: an unrecognizable outline is an unsalvageable
model, no matter how much detail follows.

## How to use this skill (do not skip phases)

Walk the reference image to a finished grey silhouette in gated phases. Every phase names its
entry condition, its exact tools, and its exit gate. Each gate checks exactly one thing, so a
failure points at exactly one phase. Do not start the next phase until the current gate passes.

1. Reference intake — proportions on paper before the first project call.
2. Skeleton pass — joint pivots only, no geometry.
3. Mass blocking — one box per primary mass, grey-silhouette gate.
4. Segmentation — decomposition rules, not guesswork.
5. Detail and meshes — green/red gating, rest areas, density caps.
6. Fix loop — locate, measure, patch as one loop.
7. Review gate — reference compare plus the core skill done-gate.

Read the blockbench-mcp core skill first. It owns the done-gate statement, the query-first
discipline, and the retry contract. This skill owns the modeling methodology. Undo-wrapped helper
bodies live in `skills/blockbench-modeling/references/modeling-scripts.md`.

## Phase 1 — reference intake

Entry: reference image or images in hand; no geometry built yet.

Tools: `get_status`, `get_guide`, `list_formats`, `set_reference_image`.

Extract facing, stance, 3–5 primary masses, head/body ratio, and limb landmarks into a short
written plan BEFORE the first project or geometry call. Proportions exist on paper first, not
after the third screenshot. Reading calls (`get_status`, `get_guide` with topic modeling or
reference, `list_formats` to pick the format) and pinning the reference with
`set_reference_image` are part of intake — the ban is on project and geometry calls
(`new_project`, `add_groups`, `add_cubes`, `add_mesh`, and friends) before the plan exists.

Write the plan down in this shape:

```text
facing: -Z (or the target engine forward)
stance: standing quadruped, weight low, head carried low at front
masses (3-5): torso / head+snout / 4x legs / shoulder hump
head/body ratio: head top clearly below body top, head small vs torso
limb landmarks: shoulder and hip pivots, elbow/knee splits, paw blocks
scale: 1 unit = 1 m, humanoid about 1.8 tall, ground at y = 0
```

Annotate relative body-part sizes while you write it — big dominant torso with everything else
small reads compact; a tall hump plus long neck plus high forward head plus long thin legs reads
camel, and no texture pass fixes that later.

Exit gate: the written plan exists with all five items plus the scale line, and the project
format is chosen (generic game models default to free, which supports cubes and meshes;
cube-only formats need rotated-cube approximations instead — confirm with `list_formats`).
No project or geometry call has happened yet.

## Phase 2 — skeleton pass

Entry: written plan and chosen format from Phase 1.

Tools: `new_project`, `add_groups`, `query_elements`, `list_outliner`.

Rig early: build the whole hierarchy in ONE `add_groups` call — root, body, head, limbs,
decorations — with every group origin at the real JOINT (shoulder, hip, neck) so rotation
pivots correctly. Parents may reference siblings created earlier in the same call. Always set
`dedupe_by_name:true` on the bulk call so a timed-out call retried once never duplicates
bones. No cubes, no meshes, no decoration in this phase — pivots only.

Exit gate: the hierarchy is complete with zero geometry — the project reports groups but no
cubes (confirm with `get_status` counts or a `query_elements` lookup). A misplaced pivot here
is one bulk edit to fix; after detailing it is a rebuild.

## Phase 3 — mass blocking

Entry: skeleton gate passed — pivots placed, zero geometry.

Tools: `add_cubes`, `mirror_element`, `edit_elements`, `screenshot_views`.

Place exactly one box per primary mass from the written plan in bulk `add_cubes` calls (always
with `dedupe_by_name:true`), every cube parented to its bone — unparented cubes fail
`check_model` and break animation later. Build symmetric parts by emitting both sides in the
same array (negate X, flip the off-axis rotation signs) or mirror one side with
`mirror_element`. Where cubes overlap, make one clearly penetrate the other and never align
two faces to the exact same plane, or the faces z-fight. Small nudges go through
`edit_elements`.

Exit gate — the grey-silhouette gate: screenshot the UNTEXTURED silhouette from 4 or more
angles with `screenshot_views`, including the reference's exact angle, and compare against the
written plan. Same stance, same masses, same head size and position. An unrecognizable outline
stops the line here — never detail a silhouette that does not read.

## Phase 4 — segmentation

Entry: grey-silhouette gate passed.

Tools: `add_cubes`, `add_mesh`, `add_plane`, `mirror_element`.

Decompose by rule, not by feel:

- Segment a limb into upper, lower, and paw or foot when the reference shows a visible joint
  bend, or the limb will animate (rigging-early discipline: every animated joint gets its own
  segment on its own bone with the origin at the joint), or a single box would span two
  different directions. Split upper from lower at the limb landmark from the written plan, and
  separate the paw or foot block whenever the reference shows a distinct foot mass.
- A mesh primitive beats five cubes when the shape is round, sharp, or organic and the format
  is mesh-capable. Crystal, gem, shard, diamond, and octahedron cover cores, gems, and shards
  (give shard a tall height); pyramid, wedge, and prism cover beaks, blades, fins, roofs, and
  teeth; cone and cylinder cover horns, pillars, trunks, and tails (radial segments default 8);
  plane, optionally crossed for volume, covers thin fins, leaves, and paper. One primitive wins
  as soon as five axis-aligned boxes still read boxy. In cube-only formats approximate the same
  shapes with cubes rotated 45 degrees instead.
- Cap detail-cube size: no detail cube longer than about one third of its parent mass's longest
  axis. Small cubes parent to the mass's bone, penetrate rather than touch, and stagger depths
  so no two faces share a plane.
- Rotation discipline: a single cube rotates cleanly on one axis only. Compound angles go on a
  rotated group — nest groups for multi-axis angles.

Exit gate: every primary mass is decomposed per the three rules above — no single stretched
box left where the reference bends, joints, or tapers.

## Phase 5 — detail and meshes

Entry: segmentation gate passed.

Tools: `add_cubes`, `add_mesh`, `add_plane`, `edit_element`, `edit_elements`,
`screenshot_views`, `pack_uv`.

Gate detail by what it does to the silhouette. Green detail affects the outline — horns, ears,
spikes, tail shape, snout length — and lands BEFORE the silhouette locks. Red detail is
surface sharpness — scales, fur tufts, trim, panel lines — and lands AFTER the lock. Knowing
when to move on is the skill: endless tweaking is the failure mode, detail everywhere is
detail nowhere.

Keep rest areas: roughly 70% of the surface stays detail-free so the 30% focus zones read.
Cap density per mass — a few accent cubes each, not dozens — and respect triangle budgets:
cubes cost 12 tris each and primitives scale with segments, so keep props in the hundreds to
low thousands and characters in the low tens of thousands. Re-run `pack_uv` after decoration
passes so every new cube owns texture space before the texturing skill takes over. Bright
emissive parts (eyes, lanterns, gems) are named with a core suffix and hung clear of other
geometry; the texturing skill fills them bright in the bake.

Exit gate: re-screenshot the silhouette — it still reads as the reference — with rest areas
visible and budgets respected.

## Phase 6 — fix loop (locate, measure, patch — one loop)

Entry: any screenshot, `check_model`, or `compare_views` finding.

Tools: `query_elements`, `measure`, `get_element`, `edit_elements`, `edit_element`,
`check_model`, `set_cube_uv`.

Run locate, measure, patch as ONE loop, not five isolated tools:

1. Locate with `query_elements` — filtered, paged lookup by name pattern or direct-parent
   group, paging honestly until the returned refs cover the reported total. It returns refs
   usable verbatim in `get_element`, `edit_elements`, and `measure`. Never lead with a full
   `list_outliner` dump on a large model; the full tree is the fallback for tiny models only.
2. Measure with `measure` — element, group, whole-model, distance, or clearance modes with
   named axes — and check the numbers against the written plan's ratios, not against vibes.
3. Patch with `edit_elements` in bulk plus the `check_model` fix patches: each patch names its
   tool (`edit_element`, `edit_elements`, or `set_cube_uv`) and its fix arguments feed that
   tool directly. Patches are proposals only — the agent applies them — and some issues carry
   no patch and need hand fixes. Re-measure and re-screenshot after patching.

Exit gate: `measure` matches the plan ratios and the finding is gone, with `check_model`
errors at zero for the touched area.

## Phase 7 — review gate

Entry: detail complete and the fix loop clean.

Tools: `set_reference_image`, `compare_views`, `screenshot_views`, `check_model`,
`save_project`.

Pin the reference with `set_reference_image` under the same view and camera as the compare,
then run `compare_views` with the same camera, scale, and image size. Proportion drift arrives
as delta text per view — address every differ, never rationalize a screenshot you can see is
wrong. Capture blueprint side, front, and top at the pinned scale as the measurable
confirmation, then apply the core skill done-gate: `check_model` shows zero errors with a
passing gate, and UVs do not overlap. Saving never blocks on gate state — a failing gate only
adds an advisory warning to `save_project` — so this checklist, not the save call, is what
enforces done. Hand finished grey models to the texturing skill for the bake, or save and
export the silhouette.

Exit gate: compare deltas addressed and the done-gate passes — then `save_project` and export.

## Appendix — conventions that survive every phase

Choosing the format, before the first group: generic game models take the free format (cubes
and meshes); cube-only formats export cubes only, so build crystals and wedges from rotated
cubes there. Switching formats after building is painful — choose in Phase 1.

Scale convention, stated in the written plan and kept all model: suggested 1 unit = 1 m,
humanoid about 1.8 units tall, ground at y = 0, same convention across every entity in a
project so exports align in-engine.

Orientation: models conventionally face -Z (Unreal-style +X forward is the common exception —
confirm the target). Camera presets mirror accordingly: the back preset shows a -Z-facing
model's face, so use explicit camera position and target for the reference's exact angle.

## Appendix — proportion templates (starting points, tune to the reference)

Quadruped, compact and body-dominant: the torso is a big dominant box and everything else is
small relative to it. The head sits small and LOW at the front with its top clearly below the
body top, almost no neck, a short broad snout nub. A hump, if any, is a subtle rise over the
shoulders, blended — never a tall block. Legs are short, thick, stubby; the body sits low.

Verified starting numbers (ground at 1 unit, facing -Z): body from -7,7,-10 to 7,17,10;
subtle hump from -6.5,16.5,-9 to 6.5,18.5,-1; head from -4,8,-15 to 4,15,-9 (top 15 below body
top 17); snout from -3,8,-17.5 to 3,12,-15; front legs upper y 4–9.5 and lower y 0–4.5 at about
4 wide.

Humanoid: body pivot at 0,12,0, head pivot at 0,23,0, arms at shoulders about 5 out and 22 up,
legs at hips about 2.2 out and 12 up, decorations under head and body as designed. Split upper
and lower limbs for bending and scale heights to the unit convention.

Capes, cloaks, and skirts: shingled rows of small panels, long at the back, open at the front
when a chest detail should stay visible. Never blanket the torso unless the reference does.

## Appendix — worked lessons

- A first grizzly read as a camel-bear: tall hump, long neck, high forward head, long thin
  legs. Rebuilding compact — small low head, subtle hump, stubby legs, big body — fixed it.
  That is why the silhouette gate precedes all detail.
- Decorative panels z-fight when many overlap coplanar — fewer pieces, each with a unique
  staggered outer depth.
- Bodies and limbs usually share the head's base colour with darker accents only at the
  extremities — do not default everything to brown.
