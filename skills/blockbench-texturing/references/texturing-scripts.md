# Texturing scripts (execute_script bodies)

Snippets are the **body** of an `execute_script` call (the `code` argument). They run inside
Blockbench with the full API. Adapt names/colours, then run. Every mutation is wrapped in
`Undo.initEdit` / `Undo.finishEdit` — keep that pattern.

## 1. Smooth texture bake — use the `smooth_bake` tool instead

The server ships a first-class `smooth_bake` tool: it assigns the texture to every
chosen face (no gaps), then bakes the smooth shaded base per face (soft vertical
gradient + directional shading + subtle mottle) and blurs each island — the exact
recipe the old script below used to hand-roll. **Call it after `pack_uv`, before
painting features.** Cubes named `*_core` bake bright (emissive read); hard parts
(`*_cap`, `*_base`, chains/cords) keep crisp edges.

```jsonc
smooth_bake {
  "base": "#6e4f30",
  "colors": [
    { "match": "_core$", "color": "#3fe0d6" },
    { "match": "_cap$|_base$|chain|cord", "color": "#2a2620" },
    { "match": "antler|branch", "color": "#6b4a2e" },
    { "match": "leaf|moss", "color": "#7c9442" },
    { "match": "head|torso|body|limb|leg|arm", "color": "#c8bca0" }
  ],
  "noise": 0.13, "blur": 0.55
}
```

Map your palette in `colors` (cube-name regex → colour, first hit wins; `base` is the
fallback) instead of editing a `baseFor` function. Tune with `noise` (mottle),
`blur` (smooth brush, 0 disables), `top_light` / `bottom_dark` (directional
shading), `glow_regex`, and `scope` + `elements[]` to bake a subset. (The retired
`execute_script` body this replaces is intentionally not kept here — one seam:
the tool is the recipe now.)

Tuning: pale/smooth surfaces -> lower mottle (`noise` ~0.06); fur/foliage -> higher.
For grizzled backs, bake first, then add a few darker vertical streaks on `up` faces
with `paint_faces` — or use `detail_cubes` with `streaks:true`, which shares this
recipe and adds grain/edge-darkening knobs.

## 2. Paint crisp features (eyes / nose / claws) — run AFTER the bake

Operate on a specific cube face using its UV rect; coordinates are face-relative. (The
`mcp__blockbench__paint_faces` tool does the same without a script.)

```js
const tex=Texture.all[0];
const rectOf=f=>{const u=f.uv;return{x:Math.round(Math.min(u[0],u[2])),y:Math.round(Math.min(u[1],u[3])),w:Math.round(Math.abs(u[2]-u[0])),h:Math.round(Math.abs(u[3]-u[1]))};};
const head=Cube.all.find(c=>c.name==='head'); const r=rectOf(head.faces.north);
tex.edit((canvas)=>{ const ctx=canvas.getContext('2d'); ctx.imageSmoothingEnabled=false;
  const X=r.x,Y=r.y,W=r.w;
  // glowing teal almond eyes
  const eye=cx=>{ const cy=4;
    ctx.fillStyle='#0c1817'; ctx.fillRect(X+cx-1,Y+cy-1,4,6);   // dark socket
    ctx.fillStyle='#29bdb4'; ctx.fillRect(X+cx,Y+cy,2,4);        // teal
    ctx.fillStyle='#63e7dd'; ctx.fillRect(X+cx,Y+cy+1,2,2);      // brighter
    ctx.fillStyle='#ccfff9'; ctx.fillRect(X+cx,Y+cy+1,1,1); };   // hotspot
  eye(1); eye(W-3);
}, {edit_name:'features', no_undo:false});
Canvas.updateAll(); return {ok:true};
```

## 3. Resize the texture (when packing overflows — preserves paint)

Prefer the `resize_texture` tool. Script form when you need custom fill:

```js
const TW=160; Project.texture_width=TW; Project.texture_height=TW;
const tex=Texture.all[0];
const c=document.createElement('canvas'); c.width=TW;c.height=TW;
const x=c.getContext('2d'); x.fillStyle='#3a3530'; x.fillRect(0,0,TW,TW);
tex.width=TW; tex.height=TW; tex.updateSource(c.toDataURL());
return {size:TW};
```

(`pack_uv` auto-grows the texture for box-UV layouts while preserving paint — usually you won't
need this.)

## 4. Export the texture PNG — use the `export_textures` tool instead

The server ships a first-class `export_textures` tool: it writes the selected
project textures to disk via the same `tex.getDataURL()` + `Blockbench.writeFile`
(`savetype:'image'`) bytes the old snippet hand-rolled. **Call it at the end of
the texture lifecycle, after the bake + features.**

```jsonc
export_textures {
  "directory": "<your-export-dir>"
}
```

Select with `texture` (one uuid/name) or `textures[]` (several); omit both to
export every project texture. Destination: `path` (absolute file, single
texture only) or `directory` (each texture lands as `<texture-name>.png`); omit
both to write alongside the project (its save-path directory — save first or
pass an explicit destination). Returns per-texture
`{exported, failed, results:[{texture, ok, path|error}]}`. (The retired
`execute_script` body this replaces is intentionally not kept here — one seam:
the tool is the export now.)

Geometry exports via the `export_project` tool.
