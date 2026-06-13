# Proportions & reference-matching discipline

## Build the silhouette FIRST, texture later

Always screenshot the **grey (untextured) silhouette** from the reference's exact angle before
investing in texture. Fix the shape until it reads correctly; a great texture cannot rescue
wrong proportions. Use `screenshot_views` with explicit `{position,target}` to match the
reference camera.

## Quadruped (e.g. bear) — compact, body-dominant

The single biggest failure mode is the **"camel" silhouette**: a tall hump + long neck with a
high/forward head + long thin legs. Fix by copying real compact-animal proportions:

- **Body** is a big dominant box; everything else is small relative to it.
- **Head** small and LOW at the front, head-top clearly BELOW the body top, almost no neck
  (neck rest rotation ~0, head right against the body front). Short broad snout nub.
- **Hump** (if any) is a subtle +1.5–2 rise over the shoulders, blended — not a tall block.
- **Legs** short, thick, stubby; body sits low to the ground.

Verified bear numbers (geckolib, ground y=0): body `[-7,7,-10]→[7,17,10]`; subtle hump
`[-6.5,16.5,-9]→[6.5,18.5,-1]`; head `[-4,8,-15]→[4,15,-9]` (top 15 < body top 17); snout
`[-3,8,-17.5]→[3,12,-15]`; front legs upper y4–9.5 / lower y0–4.5 (width ~4).

## Humanoid (e.g. spirit / character)

Steve-like rig, but tune to the reference:
- bones: `body[0,12,0]`, `head[0,23,0]`, `arm_left/right` at shoulders `[±5,22]`,
  `leg_left/right` at hips `[±2.2,12]`, plus decorative bones (antlers, lanterns) under head.
- Split limbs upper/lower for bending. Make the head as tall/large as the design wants.
- Decorative mass (cloak, leaves, armour) is many small cubes parented to body/head — but watch
  clipping (see workflow-and-scripts.md snippet 4: stagger depths, low overlap).

## Capes / cloaks / skirts

Build them as shingled rows of small panels. Match the design intent: a back cape should be
**long at the back** and may be **open at the front** (e.g. only a neck collar) so a chest
pendant/talisman is visible. Don't blanket the whole torso unless the reference does.

## Glow / accents

Bright teal (or whatever accent) emissive parts (eyes, lanterns, gems) are named `*_core` and
filled bright in the bake. Place them where the reference shows them; keep them clear of other
geometry (e.g. lanterns hang OUTSIDE the head silhouette, not clipping into it).

## Review checklist each pass (be honest)

- Did I screenshot the SAME angle as the reference? Overlay them mentally.
- Silhouette: same overall shape/stance? Head size & position right? Limb length/thickness?
- Texture: smooth (no harsh noise, no per-cube grid outlines)? Colours match the palette?
- Features: eyes/face crisp and placed like the reference? Glow reads as glow?
- `check_model`: zero untextured faces / bad UVs / unparented cubes?
- **If anything looks wrong in the screenshot, FIX it now.** Never call a visible flaw
  "acceptable" — that is the #1 mistake. Match the reference, not a lowered bar.

## Worked lessons (what real feedback taught)

- A first "grizzly" got roasted as a "camel bear thing" — caused entirely by the proportions
  above. Rebuilding compact (small low head, subtle hump, stubby legs, big body) fixed it.
- Harsh per-pixel noise + a dark 1px outline on every face looks "dirty/sharp". Smooth
  gradients + soft mottle + per-island blur (and NO per-face outline) is the look people want.
- Decorative leaf cloaks z-fight badly when many panels overlap coplanar — reduce count and
  stagger each panel's outer depth.
- Bodies/limbs are often the SAME pale wood/stone colour as the head, with darker accents only
  at the extremities (ankles/wrists) — don't default everything to brown.
