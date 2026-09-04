# Texturing scripts (native-tool references)

Every bake, paint, resize, and export operation in the texturing loop is a native
tool now. This file keeps ZERO `execute_script` bodies — each section names its
tool and shows its call shape. The retired script bodies are intentionally not
kept here — one seam: the tools are the recipe now.

## 1. Smooth texture bake — use the `smooth_bake` tool instead

The server ships a first-class `smooth_bake` tool: it assigns the texture to every
chosen face (no gaps), then bakes the smooth shaded base per face (soft vertical
gradient + directional shading + subtle mottle) and blurs each island — the exact
recipe the old script used to hand-roll. **Call it after `pack_uv`, before
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
shading), `glow_regex`, and `scope` + `elements[]` to bake a subset.

Tuning: pale/smooth surfaces -> lower mottle (`noise` ~0.06); fur/foliage -> higher.
For grizzled backs, bake first, then add a few darker vertical streaks on `up` faces
with `paint_faces` — or use `detail_cubes` with `streaks:true`, which shares this
recipe and adds grain/edge-darkening knobs.

## 2. Paint crisp features (eyes / nose / claws) — use the `paint_faces` tool instead

Features go on AFTER the bake, on a specific cube face with face-relative
coordinates (no manual UV math). The server ships a first-class `paint_faces`
tool for exactly this — eyes, nostrils, mouths, claws, stripes, trim. There is
no script form anymore.

```jsonc
paint_faces {
  "faces": [
    {
      "cube": "head",
      "face": "north",
      "ops": [{ "type": "rect", "x": 1, "y": 4, "width": 2, "height": 4, "color": "#29bdb4" }]
    }
  ]
}
```

Pass one face (cube + face + ops) or a faces array for several; ops use
the same paint operations as `paint_texture` but in face-relative coordinates.
Keep features to 1-4 px plus a 1px darker socket where the design needs
separation.

## 3. Resize the texture — use the `resize_texture` tool instead

The server ships a first-class `resize_texture` tool (nearest-neighbour, paint
preserved on growth). There is no script form anymore — for a custom fill, resize
first, then paint the new area with `paint_texture`.

```jsonc
resize_texture {
  "texture": "<texture name>",
  "width": 160,
  "height": 160
}
```

(`pack_uv` auto-grows the texture for box-UV layouts while preserving paint — usually you won't
need this.)

## 4. Export the texture PNG — use the `export_textures` tool instead

The server ships a first-class `export_textures` tool: it writes the selected
project textures to disk via the same data-URL bytes the old snippet hand-rolled.
**Call it at the end of the texture lifecycle, after the bake + features.**

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
`{exported, failed, results:[{texture, ok, path|error}]}`.

Geometry exports via the `export_project` tool.

## Auditable list — what this file still hand-rolls

- Bake (§1): `smooth_bake` / `detail_cubes` (native) — no script body remains.
- Features (§2): `paint_faces` (native) — no script body remains.
- Resize (§3): `resize_texture` (native) — no script body remains.
- Export (§4): `export_textures` (native) — no script body remains.

Remaining `execute_script` bodies in this file: none. Anything the bake, paint,
resize, or export loop needs is a native tool above.
