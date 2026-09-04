# Texturing scripts (execute_script bodies)

Snippets are the **body** of an `execute_script` call (the `code` argument). They run inside
Blockbench with the full API. Adapt names/colours, then run. Every mutation is wrapped in
`Undo.initEdit` / `Undo.finishEdit` — keep that pattern.

## 1. Smooth texture bake (the core of "good textures")

Assigns the texture to every face (no gaps), then bakes a smooth, shaded base per face and blurs
each island. Edit `baseFor(name)` to map cube-name → colour. Cubes named `*_core` are treated as
emissive/glow. Paint crisp features AFTER this (snippet 2). Run `pack_uv` BEFORE this so islands
don't overlap.

```js
const tex = Texture.all[0];
Undo.initEdit({elements:Cube.all});
Cube.all.forEach(c=>{ for(const d in c.faces){ if(c.faces[d]) c.faces[d].texture = tex.uuid; } });
Undo.finishEdit('assign tex');

const hexToRgb=h=>{h=h.replace('#','');return{r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16)};};
const cl=v=>v<0?0:v>255?255:v|0;
const shade=(hex,f)=>{const c=hexToRgb(hex);return 'rgb('+cl(c.r*f)+','+cl(c.g*f)+','+cl(c.b*f)+')';};
const rectOf=f=>{const u=f.uv;return{x:Math.round(Math.min(u[0],u[2])),y:Math.round(Math.min(u[1],u[3])),w:Math.round(Math.abs(u[2]-u[0])),h:Math.round(Math.abs(u[3]-u[1]))};};

// ---- EDIT THIS: cube-name -> base colour (your palette) ----
const GREENS=['#5f7a2e','#6d8a38','#7c9442','#56702a','#849a48'];
const isGlow = n => /_core$/.test(n);
function baseFor(n){
  if(isGlow(n))                 return '#3fe0d6';   // teal glow accent
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

## 4. Export the texture PNG (no `require`!)

```js
const tex=Texture.all[0];
Blockbench.writeFile(params.png, { content: tex.getDataURL(), savetype:'image' });
return { png:params.png };
```

Pass `params:{png:'<your-export-dir>/model.png'}` with an absolute path that exists on the
machine running Blockbench. Geometry exports via the `export_project` tool.
