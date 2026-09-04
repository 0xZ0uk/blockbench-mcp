# Look verification procedures

Measurable checklist items, checked with MCP tools before `save_project`. Judgment items
(silhouette, transitions, "reads as the look") stay screenshot-based — see SKILL.md.

## 1. Texture dimensions (list_textures)

Every texture at or under the look's `resolutionMax`, defaulting to `resolution`:

```
list_textures
-> for each texture: width/height <= resolutionMax, else resize_texture or rebuild
```

Hytale additionally requires multiples of 32px — check `width % 32 == 0` per texture.

## 2. Palette membership (get_texture + sampling script)

Pull each texture and confirm sampled colors sit in the look's `colors` set (plus the look's
declared transition pairs, e.g. dither partners). Snippet body for `execute_script`:

```js
const tex = Texture.all.find(t => t.name === params.texture) || Texture.all[0];
const allowed = params.palette.map(h => h.toLowerCase());   // look's color tokens
const img = tex.getDataURL ? tex.getDataURL() : null;
return { texture: tex.name, size: [tex.width, tex.height], palette: allowed, dataUrl: !!img };
// Sample the pixels off-box: load dataUrl in the review step and diff its unique
// colors against `palette`. Any color outside the set (+ declared dither pairs)
// is a checklist failure naming the texture.
```

Keep the allowed-set exact: undeclared "close enough" colors are how palettes drift.

## 3. Tri counts (outliner query)

Budget class comes from the plan (prop vs character). Count before gating:

```js
const tris = (typeof Mesh !== 'undefined' ? Mesh.all.length * 12 : 0) + Cube.all.length * 12;
return { cubes: Cube.all.length, approxTris: tris, budget: params.budget };
```

(Cube faces triangulate 1:2; mesh primitives scale with segments — refine per model when
meshes dominate.) Over budget → cut decoration density or split the asset, never silently
reclassify it.

## 4. Shading + filtering assumptions

- Shading mode (`flat` vs `smooth`) is a project/format setting — confirm it matches the look
  before the first screenshot, not at the gate.
- Filtering (point vs bilinear) is downstream of Blockbench; confirm the export target
  applies the look's mode and note it in the review. A point-filtered look verified only on
  bilinear previews is unverified.

## 5. Gate order (every model, every time)

```
machine done-gate (check_model: zero errors)
  -> look measurable checks (1-4 above)
    -> look judgment checks (screenshots per the look's backgrounds)
      -> save_project + export
```

Any failure at any level stops the sequence. Fix, re-verify from the failed level down —
never skip a level because an earlier one passed.
