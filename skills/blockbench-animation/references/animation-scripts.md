# Animation scripts (execute_script bodies)

Snippets are the **body** of an `execute_script` call (the `code` argument). They run inside
Blockbench with the full API. Adapt names/colours, then run. Every mutation is wrapped in
`Undo.initEdit` / `Undo.finishEdit` — keep that pattern.

Promoted operations are NOT duplicated here: pose preview is the `preview_pose` tool (§1).
What remains below is genuinely uncovered by native tools — see the auditable list at the end.

## 1. Preview an animation pose — use the `preview_pose` tool instead

The server ships a first-class `preview_pose` tool: it selects the animation
(uuid or name), sets the timeline to `time` seconds, and drives the pose
preview — the exact recipe the old snippet used to hand-roll.
**Call it after `create_animation` / `add_keyframes`, before `screenshot_views`.**

```jsonc
preview_pose {
  "animation": "<animation name>",
  "time": 0.25
}
```

Returns `{animation, uuid, time}`. To return to the rest pose for saving, use §3
below (no native reset tool exists). Pair the preview with `set_reference_image`
+ `compare_views` per SKILL.md — pin the stance reference, then compare the
previewed pose with the same camera, scale, and image size.
(The retired `execute_script` body this replaces is intentionally not kept
here — one seam: the tool is the recipe now.)

## 2. Bulk keyframes from a compact table — planning helper (no Blockbench edit)

No native tool expands a gait recipe into keyframe items: `add_keyframes` takes
the finished items. So this helper stays — it is pure planning (no Blockbench
globals, no `Undo`, no mutations) that returns the item list to feed into
`add_keyframes` verbatim:

```js
// params.rows: [{bone, channel, time, value, interpolation?}, ...]
// Returns {keyframes: [...]} — pass it as the keyframes argument of add_keyframes.
return {
  keyframes: params.rows.map(f => ({
    bone: f.bone, channel: f.channel || 'rotation', time: f.time,
    value: f.value, interpolation: f.interpolation || 'catmullrom',
  })),
};
```

Usually you don't need this: `add_keyframes` (bulk) accepts the same items directly —
write them inline when the recipe is short. Reach for the helper only when
translating a long gait recipe (see SKILL.md) into one call is too error-prone
to do by hand.

## 3. Reset to rest pose (before save/export)

No native tool covers the reset: `preview_pose` drives the pose preview but
leaves the preview active, while saving needs edit mode at time 0. So the
script stays.

```js
Modes.options.edit.select(); Timeline.setTime(0); Canvas.updateAll();
return { reset: true };
```

## 4. Export animation JSON (format-agnostic, no `require`!)

No native tool covers format-agnostic animation-JSON export: `export_project`
writes geometry through the format codec and `export_textures` writes PNGs. So
the script stays.

```js
const built=Animator.buildFile(undefined,false);
const content=typeof built==='string'?built:JSON.stringify(built,null,2);
Blockbench.writeFile(params.anim, { content, savetype:'text' });
return { anim:params.anim };
```

Pass `params:{anim:'<your-export-dir>/model.animation.json'}` with an absolute path on the
machine running Blockbench. The structure follows the project format's animation codec. Geometry
exports via the `export_project` tool; texture PNGs via the `export_textures` tool.

## Auditable list — what this file still hand-rolls

- Preview (§1): `preview_pose` (native) — no script body remains.
- Table generator (§2): pure planning helper returning `add_keyframes` items — no
  Blockbench globals, no native tool generates tables from recipes.
- Reset (§3): `execute_script` only — no native reset tool; `preview_pose` leaves
  the preview active.
- Animation-JSON export (§4): `execute_script` only — `export_project` is
  geometry, `export_textures` is PNG, neither writes animation JSON.

Remaining `execute_script` bodies: §2 (planning only, no Blockbench edit), §3
(reset), §4 (animation-JSON export). Each covers an operation no native tool provides.
