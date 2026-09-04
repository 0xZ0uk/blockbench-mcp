---
description: Export a Blockbench model — done-gate check first, refuse to save past a failing gate
---

Load the `blockbench-mcp` core skill, which owns the done-gate statement, then run the
pre-save check for $ARGUMENTS. This command is the gate: it refuses the export when the
model is not done.

Run `check_model` and read its machine-readable gate field: require zero errors and a
passing gate before any write. Separately capture blueprint side, front, and top via
`screenshot_views` with ortho pinned and the same `px_per_unit` value, and confirm UVs
do not overlap. Optionally run `compare_views` against the pinned reference with the
same camera, scale, and image size, and address every differ.

Gate — refuse to proceed until it passes: while the gate fails, do NOT call
`save_project`, `export_project`, or `export_textures`. `save_project` only attaches an
advisory warning on a failing gate — that warning is the backstop, not permission.
Route findings through the fix loop (`query_elements` to locate, `measure` against the
plan ratios, `edit_elements` plus the `check_model` fix patches to patch), re-run
`check_model`, and only write when the gate passes.
