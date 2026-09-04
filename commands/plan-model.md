---
description: Plan a Blockbench model — write the reference-intake plan before any geometry call
---

Load the `blockbench-mcp` core skill and the `blockbench-modeling` skill, then run
reference intake (modeling Phase 1) for $ARGUMENTS.

Intake tools only: `get_status`, `get_guide`, `list_formats`, `set_reference_image`.
Read the playbook (`get_guide` with topic modeling or reference), pick the format
(`list_formats`; generic game models default to free), and pin the reference with
`set_reference_image`.

Write the plan down with all five items plus the scale line (facing, stance, 3-5
primary masses, head/body ratio, limb landmarks, scale) — proportions exist on paper
first, per the modeling skill. Do not restate methodology here; the skill owns it.

Gate — refuse to proceed until it passes: no project or geometry call
(`new_project`, `add_groups`, `add_cubes`, `add_mesh`) happens before the written
plan exists. If the reference is missing or unreadable, stop and ask for it instead
of inventing proportions.
