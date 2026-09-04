# Modeling scripts (execute_script bodies)

Snippets are the **body** of an `execute_script` call (the `code` argument). They run inside
Blockbench with the full API. Adapt names/colours, then run. Wrap every mutation in
`Undo.initEdit` / `Undo.finishEdit`.

## 1. Pack box UVs — use the `pack_uv` tool instead

The server ships a first-class `pack_uv` tool: it shelf-packs all cubes (or a `scope` subset),
recomputes face UVs, and auto-grows the texture if the layout overflows. **Call it after every
batch of `add_cubes` / resize. Re-run after decoration passes too.**

Only if the tool is unavailable or you need custom behaviour, fall back to the script:

```js
const TW = Project.texture_width, pad = 1;
const items = Cube.all.map(c => {
  const w=Math.ceil(Math.abs(c.to[0]-c.from[0])),
        h=Math.ceil(Math.abs(c.to[1]-c.from[1])),
        d=Math.ceil(Math.abs(c.to[2]-c.from[2]));
  return { c, fw: 2*(w+d), fh: (h+d) };           // box-UV footprint
}).sort((a,b)=> b.fh-a.fh);                         // tallest first = tighter packing
Undo.initEdit({ elements: Cube.all, uv_only: true });
let x=0,y=0,rowH=0,maxX=0;
for (const it of items){
  if (x+it.fw+pad > TW){ x=0; y+=rowH+pad; rowH=0; }
  it.c.box_uv = true; it.c.uv_offset = [x,y];
  if (it.c.mapAutoUV) it.c.mapAutoUV();             // recompute the 6 face UVs from uv_offset
  x += it.fw+pad; rowH = Math.max(rowH, it.fh); maxX = Math.max(maxX, x);
}
Undo.finishEdit('pack uv'); Canvas.updateAll();
return { packed: items.length, used: [maxX, y+rowH], tex: [TW, Project.texture_height] };
```

Footprint math: a cube of size (w,h,d) unwraps to `2*(w+d)` wide and `(h+d)` tall, in texture
pixels (1 unit = 1 px when `uv_width == texture_width`). NOTE: mesh primitives don't use box UV —
give them a `uv` rect at creation, or UV them via `set_cube_uv`/script.

## 2. Procedural decoration (leaves / scales / fur tufts / cloaks)

Generate many small decorative cubes around a body. KEEP CLIPPING LOW: few overlaps + stagger
each piece's outer depth so faces don't z-fight.

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

Anti-clip checklist: step ≈ width (small overlap only), unique outer depth per piece, don't stack
two pieces at identical x,y,z. **Re-run `pack_uv` and the smooth bake after decorating.**

## 3. Quick symmetry / geometry sanity probe

Fast readouts to sanity-check a build without screenshots:

```js
const cubes = Cube.all;
const b = cubes.reduce((a,c)=>a.map((v,i)=>Math.min(v,c.from[i])),[1e9,1e9,1e9])
  .map((v,i)=>Math.min(v,cubes.reduce((a,c)=>Math.min(a,c.to[i]),1e9)));
return {
  cubes: cubes.length, meshes: typeof Mesh!=='undefined' ? Mesh.all.length : 0,
  groups: Group.all.length,
  unparented: cubes.filter(c=>!c.parent||c.parent==='root').map(c=>c.name),
  bounds: b
};
```

Feed anything suspicious straight into `check_model`.
