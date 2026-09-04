# Animation scripts (execute_script bodies)

## 1. Preview an animation pose (then screenshot it)

```js
const a=Animation.all.find(x=>x.name===params.name);
a.select(); Timeline.setTime(params.t); Animator.preview();
return {animation:a.name, t:params.t};
```

Pass `params:{name:'<animation name>', t:0.25}`. Then call `screenshot_views`. To return to the
rest pose for saving: `Modes.options.edit.select(); Timeline.setTime(0); Canvas.updateAll();`

## 2. Bulk keyframes from a compact table

Handy when translating a gait recipe (see SKILL.md) into one `add_keyframes` call is too
error-prone — generate the keyframe list here instead, or apply directly:

```js
// params.frames: [{bone, channel, time, value, interpolation?}, ...]
Undo.initEdit({animations: Animation.all});
const a = Animation.all.find(x=>x.name===params.animation) || params.animation;
const mk = f => ({
  bone: f.bone, channel: f.channel||'rotation', time: f.time,
  values: f.value, interpolation: f.interpolation||'catmullrom',
});
// Prefer the add_keyframes tool with this exact shape; this script is the fallback
// for when a single call must mix creation + edits across many bones.
return { planned: params.frames.map(mk) };
```

Usually you don't need this: `add_keyframes` (bulk) accepts the same items directly.

## 3. Reset to rest pose (before save/export)

```js
Modes.options.edit.select(); Timeline.setTime(0); Canvas.updateAll();
return { reset: true };
```

## 4. Export animation JSON (format-agnostic, no `require`!)

```js
const built=Animator.buildFile(undefined,false);
const content=typeof built==='string'?built:JSON.stringify(built,null,2);
Blockbench.writeFile(params.anim, { content, savetype:'text' });
return { anim:params.anim };
```

Pass `params:{anim:'<your-export-dir>/model.animation.json'}` with an absolute path on the
machine running Blockbench. The structure follows the project format's animation codec. Geometry
exports via the `export_project` tool; texture PNGs via the `export_textures` tool.
