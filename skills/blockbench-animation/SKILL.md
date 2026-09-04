---
name: blockbench-animation
description: Rig and animate Blockbench models through the BlockbenchMCP tools. Use when creating bones, setting joint pivots, adding keyframes, building gaits (walk/run), idle/breathing loops, attack or cast sequences, or previewing and exporting animations. Covers rotation-sign conventions, keyframe recipes, and save/export hygiene. Load with the blockbench-mcp core skill.
---

# Blockbench animation — rigs, signs, recipes

## Rig basics

- Make bones with `add_groups` (bulk); put each bone's `origin` at the real JOINT
  (shoulder/hip/neck) so rotation pivots correctly. Parents may reference siblings created
  earlier in the same call.
- Parent every cube to the bone that should move it. Unparented cubes never animate and fail
  `check_model`.
- Deleting and recreating an animated bone changes its UUID and breaks existing animations —
  prefer `edit_element` to reposition bones.

## Rotation sign (VERIFIED — don't guess)

A bone's **`+X` rotation tilts its FRONT (`-Z` side) UP** (and the back down). Consequences:

- To make a head/snout point DOWN, use a NEGATIVE neck rotation. A common bug: a positive neck
  rest rotation already tilts the head up, so a "head-down" pose needs a clearly negative delta.
- Legs swing on `X` to move along `Z` (the walking axis, for -Z-facing models).
- Phase relationships matter more than absolute signs for a looping cycle — but VERIFY head/neck
  poses visually (preview a keyframe and screenshot) every time.

## Keyframes

Use `add_keyframes` (bulk). Each: `{bone, channel:'rotation'|'position'|'scale', time,
value:[x,y,z], interpolation:'catmullrom'|'linear'|'step'|'bezier'}`. `catmullrom` for organic
motion, `linear` for snappy beats (a jaw snap, an impact).

## Gait recipes (quadruped)

Bone names assumed: `leg_front_left/right`, `leg_back_left/right`, `lowerleg_*`, `body`, `neck`,
`tail`.

**Walk (loop ~1.0s, diagonal gait).** Diagonal pairs in phase: FL+BR vs FR+BL (opposite). Upper
legs swing ±25° on X (FL/BR: +25 @0, -25 @0.5, +25 @1; FR/BL opposite). Lower legs add a ~22°
knee bend offset a quarter cycle (peak at 0.75 for phase A, 0.25 for phase B). Body Y bobs twice
(+0.5 @0.25 and 0.75). Slight neck nod, tail sway.

**Run (loop ~0.46s).** A faster diagonal gait + body Y HOPS — not a "front pair then back pair"
bound (that reads as a march). Bigger swing (±40°), deeper knee bend, body Y bounce (+1.8) twice
per cycle, slight body pitch and neck bob.

**Attack (once/hold ~0.85s).** Windup then lunge: t0 neutral; ~0.15 wind back (body/neck back,
jaw starts open); ~0.4 strike (body pitch + position forward, neck thrusts, jaw wide ~46°, front
legs swipe/raise); ~0.55 contact (jaw snaps ~6°, hold); ~0.85 return to neutral. Use `linear` on
the jaw for a punchy snap.

**Sleep (loop ~4s).** Lying pose + slow breathing: lower the body via `body` position
(e.g. [0,-4,0]); fold legs under (front ~+85°, lower front ~-75°; back ~+80° with slight Z splay,
lower back ~+58°); bring the head DOWN to rest (NEGATIVE neck, e.g. -46°, head ~-20°). Breathing
= small body-Y / head oscillation. VERIFY the head actually rests down — a wrong sign leaves it
craned up.

## Humanoid recipes

Bones: `body`, `head`, `arm_left/right`, `leg_left/right`, decorative bones.

- **Idle**: tiny body-Y breathe + slight arm/decoration sway; hanging lanterns/baubles get a
  gentle pendulum on X (±3-5°) offset from the body.
- **Walk**: arms and legs swing opposite on X (left arm with right leg), ±25-35°, body bob.
- **Attack (melee)**: wind one arm back, swing forward/down (X rotation, a little Y), step +
  torso twist (body Y), brief.
- **Cast (channel)**: raise both arms forward/up, tilt head up slightly, hold; pulse any glow
  with a `scale` keyframe on the `*_core` bones if separated.

## Previewing poses

```js
const a=Animation.all.find(x=>x.name===params.name);
a.select(); Timeline.setTime(params.t); Animator.preview();
return {animation:a.name, t:params.t};
```

Pass `params:{name:'<animation name>', t:0.25}`, then `screenshot_views`. Confirm the pose reads
correctly — especially head/neck signs — before exporting.

## Save/export reminders

- Before saving, reset to rest: `Modes.options.edit.select(); Timeline.setTime(0);` so the saved
  file shows the rest pose, not a mid-animation frame.
- Export the model via `export_project` (the project format's codec). Animation JSON + texture
  PNG export via `execute_script` with `Blockbench.writeFile` — snippet in
  `references/animation-scripts.md`.
- Animation channels are rotation/position/scale per bone; `list_animations` to inventory before
  exporting.
