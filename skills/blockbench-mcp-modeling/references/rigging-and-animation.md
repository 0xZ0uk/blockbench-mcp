# Rigging & animation

## Rig basics

- Make bones with `add_groups`; put each bone's `origin` at the real JOINT (shoulder/hip/neck)
  so rotation pivots correctly. Parents may reference siblings created earlier in the same call.
- Parent cubes to the bone that should move them. Decorative cubes parent to body/head.
- For animation formats (GeckoLib/Bedrock) every animated cube must live under a bone.

## Rotation sign (VERIFIED — don't guess)

A bone's **`+X` rotation tilts its FRONT (`-Z` side) UP** (and the back down). Consequences:
- To make a head/snout point DOWN, use a NEGATIVE neck rotation. (A common bug: a positive
  neck rest rotation already tilts the head up, so a "head-down" pose needs a clearly negative
  delta.) Always preview the pose (workflow-and-scripts.md snippet 6) and confirm visually.
- Legs swing on `X` to move along `Z` (the walking axis). Phase relationships matter more than
  the absolute sign for a looping cycle.

## Keyframes

Use `add_keyframes` (bulk). Each: `{bone, channel:'rotation'|'position'|'scale', time, value:[x,y,z],
interpolation:'catmullrom'|'linear'|'step'|'bezier'}`. Use `catmullrom` for smooth motion,
`linear` for snappy beats (e.g. a jaw snap).

## Quadruped recipes (bone names: leg_front_left/right, leg_back_left/right + lowerleg_* + body + neck + tail)

**Walk (loop ~1.0s, diagonal gait).** Diagonal pairs in phase: FL+BR vs FR+BL (opposite).
Upper legs swing ±25° on X (FL/BR: +25 @0, -25 @0.5, +25 @1; FR/BL opposite). Lower legs add a
~22° knee bend offset by a quarter cycle (peak at 0.75 for phase A, 0.25 for phase B). Body Y
bobs twice (+0.5 @0.25 and 0.75). Slight neck nod, tail sway.

**Run (loop ~0.46s).** A FASTER version of the diagonal walk gait + body Y HOPS — not a "front
pair then back pair" bound (that reads as a march, users dislike it). Bigger swing (±40°),
deeper knee bend, body Y bounce (+1.8) twice per cycle, slight body pitch and neck bob.

**Attack (once/hold ~0.85s).** Windup then lunge: t0 neutral; ~0.15 wind back (body/neck back,
jaw starts open); ~0.4 strike (body pitch + position forward, neck thrusts, jaw wide ~46°, front
legs swipe/raise); ~0.55 contact (jaw snaps ~6°, hold); ~0.85 return to neutral. Use `linear`
on the jaw for a punchy snap.

**Sleep (loop ~4s).** Lying pose + slow breathing. Lower the body via `body` position (e.g.
[0,-4,0]); fold legs under (front legs ~ +85°, lower front ~ -75°; back legs ~ +80° with a
slight Z splay, lower back ~ +58°); bring the head DOWN to rest (NEGATIVE neck, e.g. -46°, head
~ -20°). Breathing = small body-Y / head oscillation between two/three keyframes. VERIFY the
head actually rests down (see rotation-sign note above) — a wrong sign leaves it craned up.

## Humanoid recipes (body, head, arm_left/right, leg_left/right, decorative bones)

- **Idle**: tiny body-Y breathe + slight arm/decoration sway; if there are hanging lanterns,
  give their bones a gentle pendulum on X (±3-5°) offset from the body.
- **Walk**: arms and legs swing opposite on X (left arm with right leg), ±25-35°, body bob.
- **Attack (melee)**: wind one arm back then swing forward/down (rotation on X, maybe a little
  Y), step + torso twist (body Y), brief.
- **Cast (channel)**: raise both arms forward/up (arm rotation), tilt head up slightly, hold;
  pulse any glow with a `scale` keyframe on the `*_core` bones if separated.

## Save/export reminders

- Before saving, reset to rest: `Modes.options.edit.select(); Timeline.setTime(0);`.
- Export geometry with `export_project`; texture PNG + animation JSON via execute_script
  (`Blockbench.writeFile`, `Animator.buildFile`) — see workflow-and-scripts.md snippet 7.
- If you delete & recreate an animated bone, its UUID changes and existing animators break;
  prefer `edit_element` to reposition bones so animations keep working.
