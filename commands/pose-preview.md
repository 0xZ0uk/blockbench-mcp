---
description: Preview a Blockbench animation pose against the pinned stance reference (provisional)
---

Provisional command: it ships for the live acceptance run to judge — keep or drop is
decided there, not here.

Load the `blockbench-mcp` core skill and the `blockbench-animation` skill, then preview
the pose at $ARGUMENTS (animation name plus time in seconds). The animation skill owns
the recipe (rotation signs, keyframe tables, save and export hygiene); this command
only drives its review step.

Call `preview_pose` at the keyframe time, then `screenshot_views` for the visual read.
Pin the stance reference with `set_reference_image` under the view you compare, then run
`compare_views` with the same camera, scale, and image size — drift arrives as delta
text to address, especially head and neck signs. Use `list_animations` to inventory
before exporting.

Gate — refuse to proceed until it passes: address every compare differ before saving or
exporting, and reset to the rest pose before `save_project` (no native reset tool
exists; use the reset snippet in skills/blockbench-animation/references/animation-scripts.md)
so the file shows the rest pose, not a mid-animation frame.
