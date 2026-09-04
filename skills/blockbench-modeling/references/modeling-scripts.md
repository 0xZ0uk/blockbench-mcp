# Modeling scripts (execute_script bodies)

Snippets are the **body** of an `execute_script` call (the `code` argument). They run inside
Blockbench with the full API. Adapt names/colours, then run. Wrap every mutation in
`Undo.initEdit` / `Undo.finishEdit`.

## 1. Pack box UVs — use the `pack_uv` tool instead

The server ships a first-class `pack_uv` tool: it shelf-packs all cubes (or a `scope` subset),
recomputes face UVs, and auto-grows the texture if the layout overflows. **Call it after every
batch of `add_cubes` or resize. Re-run after decoration passes too.**

```jsonc
pack_uv {
  "padding": 1,
  "auto_resize": true
}
```

Narrow to a subset with scope plus an elements array; tune spacing with padding. (The retired
`execute_script` body this replaces is intentionally not kept here — one seam: the tool is the
recipe now.)

Footprint math: a cube of size (w,h,d) unwraps to `2*(w+d)` wide and `(h+d)` tall, in texture
pixels (1 unit = 1 px when the UV width equals the texture width). NOTE: mesh primitives don't
use box UV — give them a `uv` rect at creation, or UV them via `set_cube_uv`.

## 2. Procedural decoration (leaves / scales / fur tufts / cloaks)

Generate many small decorative cubes around a body. KEEP CLIPPING LOW: few overlaps + stagger
each piece's outer depth so faces don't z-fight. No native tool covers scatter generation, so
the script stays.

```js
const body=Group.all.find(g=>g.name==='body');
Undo.initEdit({outliner:true, elements:[]});
let n=0; const made=[]; const j=a=>(Math.random()*2-1)*a;
const mk=(p,x,y,z,w,h,d)=>{ const c=new Cube({name:'leaf'+(n++),from:[x,y,z],to:[x+w,y+h,z+d],box_uv:true,autouv:0}).init(); c.addTo(p); made.push(c); return c; };
// shingled rows on the BACK face (z=3), staggered depth avoids z-fighting:
[20,16.5,13,9.5,6].forEach((y,ri)=>{ const off=(ri%2)*1.2, prot=(ri%2)?1.7:1.3;
  for(let i=0;i<5;i++) mk(body, -5.8+off+i*2.45, y+j(0.12), 2.9, 2.9, 4.0, prot + i*0.07); });
Undo.finishEdit('decorate'); Canvas.updateAll();
return {added:made.length};
```

Anti-clip checklist: step about one width (small overlap only), unique outer depth per piece,
don't stack two pieces at identical x,y,z. **Re-run `pack_uv` and the `smooth_bake` tool after
decorating.**

## 3. Geometry sanity — use `query_elements`, `measure`, and `check_model` instead

The server ships first-class native tools for everything the old sanity-probe script
hand-rolled, so the probe body is intentionally not kept here — one seam: the tools are the
recipe now.

- Counts: `get_status` reports cube, group, texture, and animation counts plus the open
  project and format — the headliner numbers with no script.
- Locate offenders: `query_elements` finds cubes or groups by name pattern or direct-parent
  group with honest paging, returning refs usable verbatim in `get_element`,
  `edit_elements`, and `measure`. Never lead with a `list_outliner` dump on a large model.
- Verify size: `measure` in element, group, or whole-model mode returns the bounding box with
  named axes — check it against the written plan's ratios. Distance and clearance modes cover
  gaps and coplanar-overlap scans.
- Verify correctness: `check_model` audits untextured faces, bad UVs, degenerate sizes,
  unparented cubes, and coplanar overlap, attaching fix patches that feed `edit_element`,
  `edit_elements`, or `set_cube_uv` directly.

Feed anything suspicious straight into the Phase 6 fix loop in SKILL.md.
