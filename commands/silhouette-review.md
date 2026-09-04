---
description: Review a grey silhouette — 4+ angle screenshots plus reference compare before detailing
---

Load the `blockbench-mcp` core skill and the `blockbench-modeling` skill, then run the
grey-silhouette gate (modeling Phase 3 exit) and the compare step of the review gate
(Phase 7) for $ARGUMENTS.

Capture the UNTEXTURED silhouette from 4 or more angles with `screenshot_views`,
including the reference's exact angle. Pin the reference with `set_reference_image`
under the same view and camera, then run `compare_views` with the same camera, scale,
and image size — drift arrives as delta text to address, not a screenshot to
rationalize. Methodology (masses, ratios, green/red gating) lives in the modeling
skill; this command only drives its gates.

Gate — refuse to proceed until it passes: same stance, same masses, same head size
and position as the written plan. An unrecognizable outline stops the line here —
never detail a silhouette that does not read. Route every finding through the fix
loop (`query_elements` to locate, `measure` against the plan ratios, `edit_elements`
plus the `check_model` fix patches to patch), then re-screenshot.
