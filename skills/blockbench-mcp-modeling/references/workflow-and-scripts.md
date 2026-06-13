# Workflow & ready-to-paste execute_script snippets

All snippets below are the **body** of an `execute_script` call (the `code` argument). They run
inside Blockbench with the full API (`Project, Cube, Group, Texture, Animation, Undo, Canvas,
Outliner, Format, Blockbench, Modes, Timeline, Animator`, ...). Adapt names/colours, then run.

---

## 1. Pack box UVs (REQUIRED before texturing)

New box-UV cubes all overlap at `[0,0]`. This shelf-packs them and updates each cube's faces.
Run it after every batch of `add_cubes` / resize. If `used_height` exceeds the texture height,
raise the texture size (see snippet 5) and re-run.

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
pixels (1 unit = 1 px when `uv_width == texture_width`).

---

## 2. Smooth texture bake (the core of "good textures")

Assigns the texture to every face (no gaps), then bakes a smooth, shaded base per face and
blurs each island. Edit `baseFor(name)` to map cube-name → colour. Cubes named `*_core` are
treated as emissive/glow. Paint crisp features AFTER this (snippet 3).

```js
const tex = Texture.all[0];
Undo.initEdit({elements:Cube.all});
Cube.all.forEach(c=>{ for(const d in c.faces){ if(c.faces[d]) c.faces[d].texture = tex.uuid; } });
Undo.finishEdit('assign tex');

const hexToRgb=h=>{h=h.replace('#','');return{r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16)};};
const cl=v=>v<0?0:v>255?255:v|0;
const shade=(hex,f)=>{const c=hexToRgb(hex);return 'rgb('+cl(c.r*f)+','+cl(c.g*f)+','+cl(c.b*f)+')';};
const rectOf=f=>{const u=f.uv;return{x:Math.round(Math.min(u[0],u[2])),y:Math.round(Math.min(u[1],u[3])),w:Math.round(Math.abs(u[2]-u[0])),h:Math.round(Math.abs(u[3]-u[1]))};};

// ---- EDIT THIS: cube-name -> base colour ----
const GREENS=['#5f7a2e','#6d8a38','#7c9442','#56702a','#849a48'];
const isGlow = n => /_core$/.test(n);
function baseFor(n){
  if(isGlow(n))                 return '#3fe0d6';   // teal glow
  if(/_cap$|_base$|chain|cord/.test(n)) return '#2a2620'; // dark frame/links
  if(/antler|branch/.test(n))   return '#6b4a2e';   // wood brown
  if(/leaf|moss/.test(n))       return GREENS[(Math.random()*GREENS.length)|0];
  if(/head|torso|body|limb|leg|arm/.test(n)) return '#c8bca0'; // pale body
  return '#6e4f30';                                  // default brown
}
// up brighter, down darker, slight side variation -> soft 3D form
const faceMul={up:1.12,down:0.78,north:0.95,south:1.0,east:1.06,west:0.88};

tex.edit((canvas)=>{
  const ctx=canvas.getContext('2d'); ctx.imageSmoothingEnabled=false;
  ctx.fillStyle='#3a3530'; ctx.fillRect(0,0,canvas.width,canvas.height); // backdrop
  const jobs=[];
  Cube.all.forEach(cube=>{ const base=baseFor(cube.name), glow=isGlow(cube.name);
    for(const dir in cube.faces){ const f=cube.faces[dir]; if(!f) continue;
      const r=rectOf(f); if(r.w<=0||r.h<=0) continue;
      const mul = glow?1:(faceMul[dir]??1);
      const g=ctx.createLinearGradient(0,r.y,0,r.y+r.h);
      if(glow){ g.addColorStop(0,shade(base,1.12)); g.addColorStop(.5,shade(base,1.42)); g.addColorStop(1,shade(base,1.05)); }
      else    { g.addColorStop(0,shade(base,mul*1.1)); g.addColorStop(1,shade(base,mul*0.85)); }
      ctx.fillStyle=g; ctx.fillRect(r.x,r.y,r.w,r.h);
      jobs.push({cube,dir,r,base,mul,glow});
    }});
  // subtle low-contrast mottle (skip glow + hard parts)
  jobs.forEach(({cube,r,base,mul,glow})=>{ if(glow||/_cap$|_base$|chain|cord/.test(cube.name)) return;
    const n=Math.max(1,Math.floor(r.w*r.h*0.10));
    for(let i=0;i<n;i++){ const px=r.x+(Math.random()*r.w|0), py=r.y+(Math.random()*r.h|0);
      ctx.fillStyle=shade(base,mul*(0.86+Math.random()*0.26)); ctx.fillRect(px,py,1,Math.random()<.5?2:1); } });
  // 3x3 box blur per island (the "smooth brush"); skip glow + hard parts for crisp edges
  const blur=(rx,ry,rw,rh,amt)=>{ if(rw<2||rh<2) return;
    const s=ctx.getImageData(rx,ry,rw,rh).data, out=ctx.createImageData(rw,rh), d=out.data;
    for(let y=0;y<rh;y++)for(let x=0;x<rw;x++){ let R=0,G=0,B=0,N=0;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){ const xx=x+dx,yy=y+dy; if(xx<0||yy<0||xx>=rw||yy>=rh)continue;
        const i=(yy*rw+xx)*4; R+=s[i];G+=s[i+1];B+=s[i+2];N++; }
      const o=(y*rw+x)*4; d[o]=cl(s[o]*(1-amt)+R/N*amt); d[o+1]=cl(s[o+1]*(1-amt)+G/N*amt); d[o+2]=cl(s[o+2]*(1-amt)+B/N*amt); d[o+3]=255; }
    ctx.putImageData(out,rx,ry); };
  jobs.forEach(({cube,r,glow})=>{ if(!glow && !/_cap$|_base$|chain|cord/.test(cube.name)) blur(r.x,r.y,r.w,r.h,0.55); });
}, {edit_name:'smooth bake', no_undo:false});
Canvas.updateAll();
return {baked:true, cubes:Cube.all.length};
```

Tuning: pale/smooth surfaces -> lower mottle (`*0.06`, amplitude `0.10`); fur/foliage -> higher.
For grizzled backs add a few darker vertical streaks on `up` faces before the blur.

---

## 3. Paint crisp features (eyes / nose / claws) — run AFTER the bake

Operate on a specific cube face using its UV rect; coordinates are face-relative.

```js
const tex=Texture.all[0];
const rectOf=f=>{const u=f.uv;return{x:Math.round(Math.min(u[0],u[2])),y:Math.round(Math.min(u[1],u[3])),w:Math.round(Math.abs(u[2]-u[0])),h:Math.round(Math.abs(u[3]-u[1]))};};
const head=Cube.all.find(c=>c.name==='head'); const r=rectOf(head.faces.north);
tex.edit((canvas)=>{ const ctx=canvas.getContext('2d'); ctx.imageSmoothingEnabled=false;
  const X=r.x,Y=r.y,W=r.w;
  ctx.fillStyle='rgba(0,0,0,0)';
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

The `mcp__blockbench__paint_faces` tool does the same with face-relative coords if you prefer
not to script it.

---

## 4. Procedural decoration (leaves / scales / fur tufts)

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

Then re-run snippet 1 (pack) and snippet 2 (bake). Anti-clip checklist: step ≈ width (small
overlap only), unique outer depth per piece, don't stack two pieces at identical x,y,z.

---

## 5. Resize the texture (when packing overflows)

```js
const TW=160; Project.texture_width=TW; Project.texture_height=TW;
const tex=Texture.all[0];
const c=document.createElement('canvas'); c.width=TW;c.height=TW;
const x=c.getContext('2d'); x.fillStyle='#3a3530'; x.fillRect(0,0,TW,TW);
tex.width=TW; tex.height=TW; tex.updateSource(c.toDataURL());
return {size:TW};
```

---

## 6. Preview an animation pose (then screenshot it)

```js
const a=Animation.all.find(x=>x.name===params.name);
a.select(); Timeline.setTime(params.t); Animator.preview();
return {animation:a.name, t:params.t};
```
Pass `params:{name:'animation.x.walk', t:0.25}`. Then call `screenshot_views`. To return to the
rest pose for saving: `Modes.options.edit.select(); Timeline.setTime(0); Canvas.updateAll();`

---

## 7. Export texture PNG + animation JSON (no `require`!)

```js
const tex=Texture.all[0];
Blockbench.writeFile(params.png, { content: tex.getDataURL(), savetype:'image' });
const built=Animator.buildFile(undefined,false);
const content=typeof built==='string'?built:JSON.stringify(built,null,2);
Blockbench.writeFile(params.anim, { content, savetype:'text' });
return { png:params.png, anim:params.anim };
```
Pass `params:{png:'D:/.../model.png', anim:'D:/.../model.animation.json'}`. Geometry itself is
exported with the `export_project` tool.
