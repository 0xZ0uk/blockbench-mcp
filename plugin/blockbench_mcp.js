/**
 * BlockbenchMCP — bridge plugin
 *
 * Runs a small local HTTP server inside Blockbench that the BlockbenchMCP server
 * (a separate Node process spoken to by an AI via the Model Context Protocol)
 * connects to. Every request is a JSON command that is executed against the
 * Blockbench API on the renderer thread and answered with a JSON result.
 *
 * Nothing here is exposed to the public internet: the server binds to 127.0.0.1
 * only. Stop it any time from Tools ▸ MCP Server.
 */
(function () {

const PLUGIN_ID = 'blockbench_mcp';
const DEFAULT_PORT = 8787;
const PROTOCOL_VERSION = 1;

// Survive plugin reloads: keep the running server on a global handle.
const G = (globalThis.__BLOCKBENCH_MCP__ = globalThis.__BLOCKBENCH_MCP__ || {
	server: null,
	port: null,
});

// Blockbench gives plugins a permission-scoped `require`. The 'http' module is
// NOT on its allow-list, but 'net' is (it grants full network access). So we
// build a tiny HTTP/1.1 server on top of a raw TCP server. `require('net')` is
// called lazily from startServer() so the permission dialog appears when the
// user actually starts the server, and any error is surfaced instead of swallowed.
let net = null;
function getNet() {
	if (net) return net;
	net = require('net'); // may show a permission dialog or throw if denied
	if (!net || !net.createServer) {
		throw new Error('Network access (net module) was denied. Allow it to start the MCP server.');
	}
	return net;
}

let deletables = [];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function requireProject() {
	if (!Project || typeof Project !== 'object') {
		throw new Error('No project is open. Create one first with new_project.');
	}
}

function requireApp() {
	if (typeof isApp === 'undefined' || !isApp) {
		throw new Error('This action is only available in the Blockbench desktop app.');
	}
}

/** Resolve a Format from an id, a name, or a fuzzy match. */
function resolveFormat(id) {
	if (!id) return null;
	if (Formats[id]) return Formats[id];
	const key = String(id).toLowerCase().replace(/[\s\-]+/g, '_');
	if (Formats[key]) return Formats[key];
	for (const fid in Formats) {
		const f = Formats[fid];
		if (!f) continue;
		if (fid.toLowerCase() === key) return f;
		if (f.name && f.name.toLowerCase().replace(/[\s\-]+/g, '_') === key) return f;
		if (f.name && f.name.toLowerCase().includes(String(id).toLowerCase())) return f;
	}
	return null;
}

/** Find a group (bone) by uuid or name. */
function findGroup(ref) {
	if (!ref) return null;
	let g = Group.all.find((x) => x.uuid === ref);
	if (!g) g = Group.all.find((x) => x.name === ref);
	return g || null;
}

/** Find any outliner element (cube, mesh, locator, …) by uuid or name. */
function findElement(ref) {
	if (!ref) return null;
	let e = Outliner.elements.find((x) => x.uuid === ref);
	if (!e) e = Outliner.elements.find((x) => x.name === ref);
	return e || null;
}

/** Find a group OR an element by uuid or name. */
function findNode(ref) {
	return findGroup(ref) || findElement(ref);
}

function findTexture(ref) {
	if (!ref && ref !== 0) return null;
	let t = Texture.all.find((x) => x.uuid === ref);
	if (!t) t = Texture.all.find((x) => x.name === ref);
	if (!t && typeof ref === 'number') t = Texture.all[ref];
	return t || null;
}

function findAnimation(ref) {
	if (!ref) return null;
	const list = Animation.all || [];
	let a = list.find((x) => x.uuid === ref);
	if (!a) a = list.find((x) => x.name === ref);
	return a || null;
}

function num3(v, fallback) {
	if (!Array.isArray(v)) return fallback;
	return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
}

/**
 * Coerce a value into an array. Some MCP clients serialize array arguments as a
 * JSON string when the tool schema doesn't pin `type: array`, so accept that too.
 */
function toList(v) {
	if (Array.isArray(v)) return v;
	if (typeof v === 'string') {
		const s = v.trim();
		if (s[0] === '[') {
			try { const parsed = JSON.parse(s); if (Array.isArray(parsed)) return parsed; } catch (e) {}
		}
		return [v];
	}
	return v == null ? [] : [v];
}

// ---------------------------------------------------------------------------
// Serializers (strip THREE.js / circular data, keep what an AI can reason about)
// ---------------------------------------------------------------------------

function serializeElement(el) {
	if (!el) return null;
	const out = {
		uuid: el.uuid,
		name: el.name,
		type: el.type,
		parent: el.parent && el.parent !== 'root' ? el.parent.uuid : 'root',
	};
	if (el instanceof Cube) {
		Object.assign(out, {
			from: el.from,
			to: el.to,
			origin: el.origin,
			rotation: el.rotation,
			inflate: el.inflate,
			box_uv: el.box_uv,
			uv_offset: el.uv_offset,
			autouv: el.autouv,
			faces: serializeFaces(el),
		});
	}
	return out;
}

function serializeFaces(cube) {
	const faces = {};
	for (const dir in cube.faces) {
		const f = cube.faces[dir];
		faces[dir] = {
			uv: f.uv,
			rotation: f.rotation,
			texture: f.texture ? (Texture.all.find((t) => t.uuid === f.texture) || {}).name || f.texture : null,
		};
	}
	return faces;
}

function serializeGroup(g, deep) {
	if (!g) return null;
	const out = {
		uuid: g.uuid,
		name: g.name,
		type: 'group',
		origin: g.origin,
		rotation: g.rotation,
		visibility: g.visibility,
		parent: g.parent && g.parent !== 'root' ? g.parent.uuid : 'root',
	};
	if (deep) {
		out.children = g.children.map((c) =>
			c instanceof Group ? serializeGroup(c, true) : serializeElement(c)
		);
	}
	return out;
}

function serializeTexture(t) {
	if (!t) return null;
	return {
		uuid: t.uuid,
		name: t.name,
		width: t.width,
		height: t.height,
		uv_width: t.uv_width,
		uv_height: t.uv_height,
		particle: t.particle,
		render_mode: t.render_mode,
		path: t.path || null,
	};
}

function serializeAnimation(a) {
	if (!a) return null;
	return {
		uuid: a.uuid,
		name: a.name,
		loop: a.loop,
		length: a.length,
		snapping: a.snapping,
		bones: Object.values(a.animators || {})
			.filter((an) => an && an.keyframes)
			.map((an) => ({
				name: an.name,
				uuid: an.uuid,
				keyframe_count: an.keyframes.length,
			})),
	};
}

function outlinerTree() {
	return Outliner.root.map((n) =>
		n instanceof Group ? serializeGroup(n, true) : serializeElement(n)
	);
}

// ---------------------------------------------------------------------------
// Texture utilities
// ---------------------------------------------------------------------------

function blankTextureDataURL(width, height, fill) {
	const c = document.createElement('canvas');
	c.width = width;
	c.height = height;
	const ctx = c.getContext('2d');
	if (fill) {
		ctx.fillStyle = fill;
		ctx.fillRect(0, 0, width, height);
	}
	return c.toDataURL('image/png');
}

// --- colour helpers ---------------------------------------------------------
let _colorCanvas = null;
/** Parse any CSS colour ('#abc', 'rgb(...)', 'red', ...) into {r,g,b,a}. */
function parseColor(col) {
	if (!_colorCanvas) _colorCanvas = document.createElement('canvas');
	_colorCanvas.width = _colorCanvas.height = 1;
	const x = _colorCanvas.getContext('2d');
	x.clearRect(0, 0, 1, 1);
	x.fillStyle = '#000';
	x.fillStyle = col;
	x.fillRect(0, 0, 1, 1);
	const d = x.getImageData(0, 0, 1, 1).data;
	return { r: d[0], g: d[1], b: d[2], a: d[3] };
}
function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }
/** Multiply a colour's brightness by `factor` (1 = unchanged). Returns 'rgb(...)'. */
function shadeHex(col, factor) {
	const c = parseColor(col);
	return `rgb(${clamp8(c.r * factor)},${clamp8(c.g * factor)},${clamp8(c.b * factor)})`;
}

/** A cube face's UV as an axis-aligned pixel rect on the texture canvas. */
function faceRect(face, scale) {
	const u = (face && face.uv) || [0, 0, 0, 0];
	const x1 = u[0] * scale, y1 = u[1] * scale, x2 = u[2] * scale, y2 = u[3] * scale;
	return {
		x: Math.round(Math.min(x1, x2)),
		y: Math.round(Math.min(y1, y2)),
		w: Math.round(Math.abs(x2 - x1)),
		h: Math.round(Math.abs(y2 - y1)),
	};
}

/** Shift paint ops by (ox,oy) so callers can use coordinates relative to a face. */
function offsetOps(ops, ox, oy, rectW, rectH) {
	return (ops || []).map((op) => {
		const o = Object.assign({}, op);
		['x', 'y', 'x1', 'y1', 'x2', 'y2'].forEach((k) => {
			if (typeof o[k] === 'number') o[k] += (k[0] === 'x' ? ox : oy);
		});
		if (Array.isArray(o.points)) o.points = o.points.map((p) => [p[0] + ox, p[1] + oy]);
		// Region-style ops default to the whole face when no explicit box is given.
		if ((o.type === 'noise' || o.type === 'dither' || o.type === 'clear') && o.width == null) {
			o.x = ox; o.y = oy; o.width = rectW; o.height = rectH;
		}
		if (o.type === 'fill_all') { o.type = 'rect'; o.x = ox; o.y = oy; o.width = rectW; o.height = rectH; }
		return o;
	});
}

/** Bounding box of all cubes, with a sensible fallback when the model is empty. */
function sceneBounds() {
	let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	Cube.all.forEach((c) => {
		for (let i = 0; i < 3; i++) {
			min[i] = Math.min(min[i], c.from[i], c.to[i]);
			max[i] = Math.max(max[i], c.from[i], c.to[i]);
		}
	});
	if (!isFinite(min[0])) { min = [-8, 0, -8]; max = [8, 16, 8]; }
	const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
	const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);
	return { center, size };
}

/** Fallback camera placement by angle name when no matching preset exists. */
function applyAngleName(preview, name) {
	const { center, size } = sceneBounds();
	const dist = size * 2.2 + 12;
	const dirs = {
		front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0],
		top: [0, 1, 0.001], bottom: [0, -1, 0.001],
		iso: [1, 0.8, 1], isometric: [1, 0.8, 1],
		isometric_right_front: [1, 0.8, 1], isometric_left_front: [-1, 0.8, 1],
	};
	const v = dirs[name] || dirs.iso;
	const len = Math.hypot(v[0], v[1], v[2]) || 1;
	preview.camera.position.set(
		center[0] + (v[0] / len) * dist,
		center[1] + (v[1] / len) * dist,
		center[2] + (v[2] / len) * dist
	);
	if (preview.controls) preview.controls.target.set(center[0], center[1], center[2]);
}

/** Run a list of drawing operations against a 2D canvas context. */
function applyPaintOps(ctx, ops) {
	for (const op of ops) {
		const color = op.color || '#000000';
		ctx.fillStyle = color;
		ctx.strokeStyle = color;
		switch (op.type) {
			case 'pixel':
				ctx.fillRect(op.x | 0, op.y | 0, 1, 1);
				break;
			case 'rect':
				if (op.fill === false) {
					ctx.lineWidth = op.line_width || 1;
					ctx.strokeRect(op.x + 0.5, op.y + 0.5, op.width - 1, op.height - 1);
				} else {
					ctx.fillRect(op.x | 0, op.y | 0, op.width | 0, op.height | 0);
				}
				break;
			case 'line':
				ctx.lineWidth = op.line_width || 1;
				ctx.beginPath();
				ctx.moveTo(op.x1 + 0.5, op.y1 + 0.5);
				ctx.lineTo(op.x2 + 0.5, op.y2 + 0.5);
				ctx.stroke();
				break;
			case 'circle': {
				ctx.beginPath();
				ctx.arc(op.x, op.y, op.radius, 0, Math.PI * 2);
				if (op.fill === false) {
					ctx.lineWidth = op.line_width || 1;
					ctx.stroke();
				} else {
					ctx.fill();
				}
				break;
			}
			case 'fill_all':
				ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
				break;
			case 'clear':
				ctx.clearRect(op.x | 0, op.y | 0, (op.width | 0) || ctx.canvas.width, (op.height | 0) || ctx.canvas.height);
				break;
			case 'gradient': {
				const grad = ctx.createLinearGradient(op.x1 || 0, op.y1 || 0, op.x2 || 0, op.y2 || (ctx.canvas.height));
				(op.stops || [[0, '#000'], [1, '#fff']]).forEach((s) => grad.addColorStop(s[0], s[1]));
				ctx.fillStyle = grad;
				ctx.fillRect(op.x | 0, op.y | 0, (op.width | 0) || ctx.canvas.width, (op.height | 0) || ctx.canvas.height);
				break;
			}
			case 'ellipse': {
				const w = op.width || (op.radius ? op.radius * 2 : 2);
				const h = op.height || (op.radius ? op.radius * 2 : 2);
				const cx = (op.x || 0) + w / 2, cy = (op.y || 0) + h / 2;
				ctx.beginPath();
				ctx.ellipse(cx, cy, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
				if (op.fill === false) { ctx.lineWidth = op.line_width || 1; ctx.stroke(); }
				else ctx.fill();
				break;
			}
			case 'polygon': {
				const pts = op.points || [];
				if (pts.length < 2) break;
				ctx.beginPath();
				ctx.moveTo(pts[0][0] + 0.5, pts[0][1] + 0.5);
				for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] + 0.5, pts[i][1] + 0.5);
				ctx.closePath();
				if (op.fill === false) { ctx.lineWidth = op.line_width || 1; ctx.stroke(); }
				else ctx.fill();
				break;
			}
			case 'dither': {
				const x = op.x | 0, y = op.y | 0, w = (op.width | 0) || ctx.canvas.width, h = (op.height | 0) || ctx.canvas.height;
				const c1 = op.color || '#000000', c2 = op.color2 || op.color || '#ffffff';
				const dens = op.density != null ? Number(op.density) : 1;
				for (let yy = 0; yy < h; yy++) {
					for (let xx = 0; xx < w; xx++) {
						const on = ((xx + yy) & 1) === 0;
						if (on && dens < 1 && Math.random() > dens) continue;
						ctx.fillStyle = on ? c1 : c2;
						if (on || op.color2) ctx.fillRect(x + xx, y + yy, 1, 1);
					}
				}
				break;
			}
			case 'noise': {
				const x = op.x | 0, y = op.y | 0;
				const w = (op.width | 0) || ctx.canvas.width, h = (op.height | 0) || ctx.canvas.height;
				const amt = op.amount != null ? Number(op.amount) : 0.12;
				const seed = op.color ? parseColor(op.color) : null;
				const img = ctx.getImageData(x, y, w, h);
				const d = img.data;
				const mono = op.mono !== false;
				for (let i = 0; i < d.length; i += 4) {
					if (seed) { d[i] = seed.r; d[i + 1] = seed.g; d[i + 2] = seed.b; d[i + 3] = 255; }
					else if (d[i + 3] === 0) continue;
					if (mono) {
						const j = (Math.random() * 2 - 1) * amt * 255;
						d[i] = clamp8(d[i] + j); d[i + 1] = clamp8(d[i + 1] + j); d[i + 2] = clamp8(d[i + 2] + j);
					} else {
						d[i] = clamp8(d[i] + (Math.random() * 2 - 1) * amt * 255);
						d[i + 1] = clamp8(d[i + 1] + (Math.random() * 2 - 1) * amt * 255);
						d[i + 2] = clamp8(d[i + 2] + (Math.random() * 2 - 1) * amt * 255);
					}
				}
				ctx.putImageData(img, x, y);
				break;
			}
			default:
				throw new Error('Unknown paint op: ' + op.type);
		}
	}
}

// ---------------------------------------------------------------------------
// Modeling playbook (returned by get_guide / referenced by tool descriptions)
// ---------------------------------------------------------------------------

const MODELING_GUIDE = [
	'BLOCKBENCH MODELING PLAYBOOK — read before building a creature/character.',
	'',
	'WORKFLOW (always loop): plan bones -> add_groups -> add_cubes -> create_texture',
	'-> detail_cubes -> paint_faces -> screenshot_views -> check_model -> fix -> repeat.',
	'Iterate at least 2-3 times; the first pass is never good enough.',
	'',
	'1. PROPORTIONS & PART COUNT. A good creature is 20-50+ cubes, not 6-8 boxes.',
	'   Break every limb into segments (upper leg / lower leg / paw), give the head a',
	'   separate snout/muzzle, ears, brow. More, smaller cubes = less blocky.',
	'',
	'2. ROTATION IS ALLOWED — USE IT. Cubes AND bones take a `rotation:[x,y,z]` in',
	'   degrees. Flat axis-aligned boxes look like a robot. For natural shapes:',
	'   - Angle the snout down, ears back, legs splayed, tail curved, jaw open.',
	'   - A single cube only rotates cleanly on ONE axis (esp. Java format). For a',
	'     compound 3-axis angle, put the cube in a GROUP and rotate the group, or nest',
	'     groups (bone rotated on Y, child bone rotated on X). This is exactly how the',
	'     detailed hand-made models do it: many small bones, each rotated a little.',
	'   - Build a limb as a bone at the joint origin, rotate the BONE to pose it.',
	'',
	'3. ROUNDING & TAPER. Use `inflate` (small +/- values) to round or shrink a cube',
	'   without moving it. Taper a limb by making each segment slightly smaller than',
	'   the one above. Overlap cubes a little so there are no seams.',
	'',
	'4. SYMMETRY. Build the left side, then add the mirrored right side in the same',
	'   add_cubes call: negate X of from/to (swap so from<to) and negate the Y/Z',
	'   rotation signs. Keep paired bones named *_left / *_right.',
	'',
	'5. TEXTURING. Never leave faces flat or untextured.',
	'   a) create_texture with a mid-tone base fill.',
	'   b) detail_cubes {base} to give EVERY face a shaded, noisy base coat (kills the',
	'      flat look and guarantees no untextured gaps). Tune base/noise/top_light.',
	'   c) paint_faces to add features with FACE-RELATIVE coords: eyes, nose, mouth,',
	'      claws, fur tufts, stripes, scars, bandages, armour trim. Use ops: rect,',
	'      ellipse, polygon, line, dither (patterns), noise (texture), gradient.',
	'   d) Shade by hand too: darker near the belly/underside, lighter on top.',
	'',
	'6. REVIEW LOOP. Call screenshot_views (front/side/back/iso) to judge the whole',
	'   model, and check_model to list untextured faces / bad UVs / unparented cubes.',
	'   Fix what you see, then screenshot again. Do not stop after one screenshot.',
	'',
	'For animation formats (GeckoLib/Bedrock): every cube must live under a bone, and',
	'pivots (group origin) must sit at the real joint so rotation looks right.',
].join('\n');

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const commands = {

	// ---- status & info ----------------------------------------------------
	ping() {
		return {
			protocol: PROTOCOL_VERSION,
			blockbench_version: Blockbench.version,
			is_app: isApp,
			has_project: !!Project,
		};
	},

	get_status() {
		const status = {
			blockbench_version: Blockbench.version,
			has_project: !!Project,
		};
		if (Project) {
			status.project = {
				name: Project.name,
				format: Format ? Format.id : null,
				format_name: Format ? Format.name : null,
				texture_width: Project.texture_width,
				texture_height: Project.texture_height,
				cubes: Cube.all.length,
				groups: Group.all.length,
				textures: Texture.all.length,
				animations: (Animation.all || []).length,
				mode: Mode.selected ? Mode.selected.id : null,
			};
		}
		return status;
	},

	list_formats() {
		return Object.keys(Formats).map((id) => ({
			id,
			name: Formats[id].name,
			description: Formats[id].description,
			animation_mode: !!Formats[id].animation_mode,
			box_uv: !!Formats[id].box_uv,
		}));
	},

	// ---- project lifecycle ------------------------------------------------
	new_project(p) {
		const fmt = resolveFormat(p.format || 'free');
		if (!fmt) {
			throw new Error(
				`Unknown format "${p.format}". Use list_formats to see available ids. ` +
				`(GeckoLib/Bedrock formats require the matching plugin to be installed first.)`
			);
		}
		const created = newProject(fmt);
		if (!created) throw new Error('Failed to create project (a dialog may have been cancelled).');
		if (p.name) {
			Project.name = p.name;
			Project.geometry_name = p.geometry_name || p.name;
		}
		if (p.texture_width) Project.texture_width = p.texture_width | 0;
		if (p.texture_height) Project.texture_height = p.texture_height | 0;
		Canvas.updateAll();
		return commands.get_status().project;
	},

	close_project() {
		requireProject();
		if (Project.close) Project.close(true);
		return { closed: true };
	},

	set_project_meta(p) {
		requireProject();
		if (p.name !== undefined) Project.name = p.name;
		if (p.geometry_name !== undefined) Project.geometry_name = p.geometry_name;
		if (p.texture_width) Project.texture_width = p.texture_width | 0;
		if (p.texture_height) Project.texture_height = p.texture_height | 0;
		updateProjectResolution && updateProjectResolution();
		Canvas.updateAll();
		return commands.get_status().project;
	},

	save_project(p) {
		requireProject();
		return new Promise((resolve, reject) => {
			try {
				if (p && p.path && isApp) {
					Project.save_path = p.path;
				}
				BarItems.save_project.trigger();
				resolve({ saved: true, path: Project.save_path || null });
			} catch (e) {
				reject(e);
			}
		});
	},

	export_project(p) {
		requireProject();
		// Export through the format's own codec.
		const codec = Format.codec;
		if (!codec) throw new Error('Current format has no export codec.');
		if (p && p.path && isApp) {
			const content = codec.compile();
			require('fs').writeFileSync(p.path, typeof content === 'string' ? content : JSON.stringify(content));
			return { exported: true, path: p.path };
		}
		codec.export();
		return { exported: true, note: 'Export dialog opened in Blockbench.' };
	},

	load_project(p) {
		requireApp();
		if (!p.path) throw new Error('path is required');
		const fs = require('fs');
		const content = fs.readFileSync(p.path, 'utf-8');
		Codecs.project.parse(JSON.parse(content), p.path);
		Canvas.updateAll();
		return commands.get_status().project;
	},

	// ---- outliner / geometry ---------------------------------------------
	add_group(p) {
		requireProject();
		const parent = p.parent ? findGroup(p.parent) : null;
		if (p.parent && !parent) throw new Error('Parent group not found: ' + p.parent);
		Undo.initEdit({ outliner: true });
		const group = new Group({
			name: p.name || 'group',
			origin: num3(p.origin, [0, 0, 0]),
			rotation: num3(p.rotation, [0, 0, 0]),
		}).init();
		group.addTo(parent || 'root');
		Undo.finishEdit('MCP: add group');
		Canvas.updateAll();
		return serializeGroup(group);
	},

	add_cube(p) {
		requireProject();
		const parent = p.parent ? findGroup(p.parent) : null;
		if (p.parent && !parent) throw new Error('Parent group not found: ' + p.parent);
		const from = num3(p.from, [0, 0, 0]);
		const to = num3(p.to, [from[0] + 1, from[1] + 1, from[2] + 1]);
		Undo.initEdit({ outliner: true, elements: [] });
		const cube = new Cube({
			name: p.name || 'cube',
			from,
			to,
			origin: num3(p.origin, from),
			rotation: num3(p.rotation, [0, 0, 0]),
			inflate: Number(p.inflate) || 0,
			autouv: typeof p.autouv === 'number' ? p.autouv : (Format.box_uv ? 0 : 1),
			box_uv: p.box_uv !== undefined ? !!p.box_uv : !!Format.box_uv,
			uv_offset: Array.isArray(p.uv_offset) ? p.uv_offset : undefined,
		}).init();
		cube.addTo(parent || 'root');
		if (p.faces) applyFaces(cube, p.faces);
		else if (Texture.all.length) cube.applyTexture(Texture.getDefault(), true);
		Undo.finishEdit('MCP: add cube');
		Canvas.updateAll();
		return serializeElement(cube);
	},

	// Build many bones at once. Parents may reference bones created earlier in
	// the same batch by name, so a whole skeleton can be authored in one call.
	add_groups(p) {
		requireProject();
		if (!Array.isArray(p.groups) || !p.groups.length) throw new Error('groups (array) is required');
		Undo.initEdit({ outliner: true });
		const created = {};
		const out = [];
		for (const spec of p.groups) {
			let parent = null;
			if (spec.parent) {
				parent = created[spec.parent] || findGroup(spec.parent);
				if (!parent) throw new Error('Parent group not found: ' + spec.parent);
			}
			const group = new Group({
				name: spec.name || 'group',
				origin: num3(spec.origin, [0, 0, 0]),
				rotation: num3(spec.rotation, [0, 0, 0]),
			}).init();
			group.addTo(parent || 'root');
			created[group.name] = group;
			out.push(serializeGroup(group));
		}
		Undo.finishEdit('MCP: add groups');
		Canvas.updateAll();
		return { created: out.length, groups: out };
	},

	// Build many cubes at once — the efficient way to author a detailed model.
	add_cubes(p) {
		requireProject();
		if (!Array.isArray(p.cubes) || !p.cubes.length) throw new Error('cubes (array) is required');
		Undo.initEdit({ outliner: true, elements: [] });
		const out = [];
		for (const spec of p.cubes) {
			const parent = spec.parent ? findGroup(spec.parent) : null;
			if (spec.parent && !parent) throw new Error('Parent group not found: ' + spec.parent);
			const from = num3(spec.from, [0, 0, 0]);
			const to = num3(spec.to, [from[0] + 1, from[1] + 1, from[2] + 1]);
			const cube = new Cube({
				name: spec.name || 'cube',
				from,
				to,
				origin: num3(spec.origin, from),
				rotation: num3(spec.rotation, [0, 0, 0]),
				inflate: Number(spec.inflate) || 0,
				autouv: typeof spec.autouv === 'number' ? spec.autouv : (Format.box_uv ? 0 : 1),
				box_uv: spec.box_uv !== undefined ? !!spec.box_uv : !!Format.box_uv,
				uv_offset: Array.isArray(spec.uv_offset) ? spec.uv_offset : undefined,
			}).init();
			cube.addTo(parent || 'root');
			if (spec.faces) applyFaces(cube, spec.faces);
			else if (Texture.all.length) cube.applyTexture(Texture.getDefault(), true);
			out.push(serializeElement(cube));
		}
		Undo.finishEdit('MCP: add cubes');
		Canvas.updateAll();
		return { created: out.length, cubes: out };
	},

	edit_element(p) {
		requireProject();
		const el = findNode(p.element || p.uuid || p.name);
		if (!el) throw new Error('Element not found: ' + (p.element || p.uuid || p.name));
		const isGroup = el instanceof Group;
		Undo.initEdit(isGroup ? { group: el } : { elements: [el] });
		if (p.new_name !== undefined) el.name = p.new_name;
		if (p.origin) el.origin = num3(p.origin, el.origin);
		if (p.rotation) el.rotation = num3(p.rotation, el.rotation);
		if (!isGroup) {
			if (p.from) el.from = num3(p.from, el.from);
			if (p.to) el.to = num3(p.to, el.to);
			if (p.inflate !== undefined) el.inflate = Number(p.inflate);
		}
		if (p.visibility !== undefined) el.visibility = !!p.visibility;
		if (p.parent !== undefined) {
			const parent = p.parent === 'root' ? 'root' : findGroup(p.parent);
			if (p.parent !== 'root' && !parent) throw new Error('Parent group not found: ' + p.parent);
			el.addTo(parent);
		}
		Undo.finishEdit('MCP: edit element');
		Canvas.updateAll();
		return isGroup ? serializeGroup(el) : serializeElement(el);
	},

	delete_element(p) {
		requireProject();
		const el = findNode(p.element || p.uuid || p.name);
		if (!el) throw new Error('Element not found: ' + (p.element || p.uuid || p.name));
		Undo.initEdit({ outliner: true, elements: el instanceof Group ? [] : [el] });
		el.remove(false);
		Undo.finishEdit('MCP: delete element');
		Canvas.updateAll();
		return { deleted: true };
	},

	list_outliner() {
		requireProject();
		return outlinerTree();
	},

	get_element(p) {
		requireProject();
		const el = findNode(p.element || p.uuid || p.name);
		if (!el) throw new Error('Element not found: ' + (p.element || p.uuid || p.name));
		return el instanceof Group ? serializeGroup(el, true) : serializeElement(el);
	},

	// Audit the model for common problems that make results look broken: faces
	// with no texture (the untextured "gaps"), zero-area or out-of-bounds UVs,
	// degenerate cube sizes, and (for animated formats) cubes not parented to a
	// bone. Run this before screenshotting to fix issues proactively.
	check_model() {
		requireProject();
		const tw = Project.texture_width, th = Project.texture_height;
		const animMode = !!(Format && Format.animation_mode);
		const issues = [];
		Cube.all.forEach((cube) => {
			for (const dir in cube.faces) {
				const f = cube.faces[dir];
				if (!f) continue;
				if (!f.texture) issues.push({ cube: cube.name, face: dir, issue: 'no_texture' });
				const u = f.uv || [0, 0, 0, 0];
				const w = Math.abs(u[2] - u[0]), h = Math.abs(u[3] - u[1]);
				if (w <= 0 || h <= 0) issues.push({ cube: cube.name, face: dir, issue: 'zero_uv', uv: u });
				else if (Math.max(u[0], u[2]) > tw + 0.01 || Math.max(u[1], u[3]) > th + 0.01 ||
					Math.min(u[0], u[1], u[2], u[3]) < -0.01)
					issues.push({ cube: cube.name, face: dir, issue: 'uv_out_of_bounds', uv: u });
			}
			const s = [cube.to[0] - cube.from[0], cube.to[1] - cube.from[1], cube.to[2] - cube.from[2]];
			if (s[0] <= 0 || s[1] <= 0 || s[2] <= 0) issues.push({ cube: cube.name, issue: 'degenerate_size', size: s });
			if (animMode && (!cube.parent || cube.parent === 'root'))
				issues.push({ cube: cube.name, issue: 'no_bone_parent' });
		});
		const byType = {};
		issues.forEach((i) => { byType[i.issue] = (byType[i.issue] || 0) + 1; });
		return {
			cubes: Cube.all.length, groups: Group.all.length, textures: Texture.all.length,
			texture_size: [tw, th], animation_format: animMode,
			issue_count: issues.length, by_type: byType, issues,
		};
	},

	// ---- UV / textures on faces ------------------------------------------
	set_cube_uv(p) {
		requireProject();
		const cube = findElement(p.cube || p.uuid || p.name);
		if (!cube || !(cube instanceof Cube)) throw new Error('Cube not found: ' + (p.cube || p.uuid || p.name));
		Undo.initEdit({ elements: [cube], uv_only: true });
		for (const dir in p.faces || {}) {
			const face = cube.faces[dir];
			if (!face) continue;
			const fd = p.faces[dir];
			if (fd.uv) face.uv = fd.uv;
			if (fd.rotation !== undefined) face.rotation = fd.rotation;
			if (fd.texture !== undefined) {
				const tex = findTexture(fd.texture);
				face.texture = tex ? tex.uuid : false;
			}
		}
		Undo.finishEdit('MCP: set UV');
		Canvas.updateAll();
		return serializeElement(cube);
	},

	apply_texture(p) {
		requireProject();
		const tex = findTexture(p.texture);
		if (!tex) throw new Error('Texture not found: ' + p.texture);
		let targets;
		if (p.element) {
			const el = findElement(p.element);
			if (!el) throw new Error('Element not found: ' + p.element);
			targets = [el];
		} else {
			targets = Cube.all;
		}
		Undo.initEdit({ elements: targets });
		targets.forEach((el) => el.applyTexture && el.applyTexture(tex, true));
		Undo.finishEdit('MCP: apply texture');
		Canvas.updateAll();
		return { applied_to: targets.length };
	},

	// ---- textures ---------------------------------------------------------
	create_texture(p) {
		requireProject();
		const width = p.width || Project.texture_width || 16;
		const height = p.height || Project.texture_height || 16;
		const dataURL = p.data_url || blankTextureDataURL(width, height, p.fill || null);
		Undo.initEdit({ textures: [] });
		const tex = new Texture({ name: p.name || 'texture', width, height }).fromDataURL(dataURL).add(false);
		if (p.particle) tex.enableParticle();
		Undo.finishEdit('MCP: create texture');
		return serializeTexture(tex);
	},

	import_texture(p) {
		requireProject();
		requireApp();
		if (!p.path) throw new Error('path is required');
		Undo.initEdit({ textures: [] });
		const tex = new Texture({ name: p.name }).fromPath(p.path).add(false);
		Undo.finishEdit('MCP: import texture');
		return serializeTexture(tex);
	},

	list_textures() {
		requireProject();
		return Texture.all.map(serializeTexture);
	},

	get_texture(p) {
		requireProject();
		const tex = findTexture(p.texture);
		if (!tex) throw new Error('Texture not found: ' + p.texture);
		return {
			texture: serializeTexture(tex),
			data_url: tex.getDataURL(),
		};
	},

	paint_texture(p) {
		requireProject();
		const tex = findTexture(p.texture);
		if (!tex) throw new Error('Texture not found: ' + p.texture);
		if (!Array.isArray(p.ops) || !p.ops.length) throw new Error('ops (array) is required');
		tex.edit((canvas) => {
			const ctx = canvas.getContext('2d');
			ctx.imageSmoothingEnabled = false;
			applyPaintOps(ctx, p.ops);
		}, { edit_name: p.edit_name || 'MCP: paint texture', no_undo: false });
		return { painted: true, ops: p.ops.length, texture: serializeTexture(tex) };
	},

	// High-level: give every face of the chosen cubes a shaded base coat so the
	// model is never flat or untextured. Assigns `texture` to the faces first
	// (no gaps), then bakes per-face directional shading + a vertical gradient +
	// subtle noise onto each face's UV rect. Great starting point before detail.
	detail_cubes(p) {
		requireProject();
		let tex = p.texture ? findTexture(p.texture) : null;
		if (!tex && Texture.getDefault) tex = Texture.getDefault();
		if (!tex) tex = Texture.all[0];
		if (!tex) throw new Error('No texture to paint on. Create one first with create_texture.');

		let cubes;
		if (!p.cubes || p.cubes === 'all') cubes = Cube.all.slice();
		else cubes = toList(p.cubes).map(findElement).filter((c) => c instanceof Cube);
		if (!cubes.length) throw new Error('No matching cubes.');

		const base = p.base || '#9c9c9c';
		const noiseAmt = p.noise != null ? Number(p.noise) : 0.10;
		const topLight = p.top_light != null ? Number(p.top_light) : 0.22;
		const bottomDark = p.bottom_dark != null ? Number(p.bottom_dark) : 0.28;
		const edgeDark = p.edge_darken != null ? Number(p.edge_darken) : 0.16;
		const faceMul = {
			up: 1 + topLight, down: 1 - bottomDark,
			north: 0.94, south: 1.02, east: 1.06, west: 0.9,
		};
		const scale = tex.width / (Project.texture_width || tex.width);

		const jobs = [];
		Undo.initEdit({ elements: cubes });
		cubes.forEach((cube) => {
			cube.applyTexture(tex, true);
			for (const dir in cube.faces) {
				const face = cube.faces[dir];
				if (!face) continue;
				const r = faceRect(face, scale);
				if (r.w <= 0 || r.h <= 0) continue;
				jobs.push({ r, mul: faceMul[dir] != null ? faceMul[dir] : 1 });
			}
		});
		Undo.finishEdit('MCP: assign texture');

		tex.edit((canvas) => {
			const ctx = canvas.getContext('2d');
			ctx.imageSmoothingEnabled = false;
			jobs.forEach(({ r, mul }) => {
				ctx.fillStyle = shadeHex(base, mul);
				ctx.fillRect(r.x, r.y, r.w, r.h);
				const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
				g.addColorStop(0, shadeHex(base, mul * 1.08));
				g.addColorStop(1, shadeHex(base, mul * 0.9));
				ctx.fillStyle = g;
				ctx.globalAlpha = 0.5;
				ctx.fillRect(r.x, r.y, r.w, r.h);
				ctx.globalAlpha = 1;
				if (edgeDark > 0 && r.w > 2 && r.h > 2) {
					ctx.fillStyle = shadeHex(base, mul * (1 - edgeDark));
					ctx.fillRect(r.x, r.y, r.w, 1);
					ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
					ctx.fillRect(r.x, r.y, 1, r.h);
					ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
				}
				if (noiseAmt > 0) {
					const img = ctx.getImageData(r.x, r.y, r.w, r.h);
					const d = img.data;
					for (let i = 0; i < d.length; i += 4) {
						const j = (Math.random() * 2 - 1) * noiseAmt * 255;
						d[i] = clamp8(d[i] + j); d[i + 1] = clamp8(d[i + 1] + j); d[i + 2] = clamp8(d[i + 2] + j); d[i + 3] = 255;
					}
					ctx.putImageData(img, r.x, r.y);
				}
			});
		}, { edit_name: 'MCP: detail cubes', no_undo: false });

		return { textured: cubes.length, faces: jobs.length, texture: serializeTexture(tex) };
	},

	// Paint specific cube faces using coordinates RELATIVE to each face's UV
	// rect (so [0,0] is the top-left of that face). No need to compute absolute
	// UVs by hand — this is how you place eyes, nostrils, stripes, patterns, etc.
	paint_faces(p) {
		requireProject();
		const items = p.faces
			? toList(p.faces)
			: [{ cube: p.cube, face: p.face, base: p.base, ops: p.ops, texture: p.texture }];
		const byTex = new Map();
		for (const it of items) {
			const cube = findElement(it.cube);
			if (!cube || !(cube instanceof Cube)) throw new Error('Cube not found: ' + it.cube);
			const dirs = (!it.face || it.face === 'all') ? Object.keys(cube.faces) : toList(it.face);
			for (const dir of dirs) {
				const face = cube.faces[dir];
				if (!face) continue;
				let tex = it.texture ? findTexture(it.texture) : (p.texture ? findTexture(p.texture) : null);
				if (!tex && face.texture) tex = findTexture(face.texture);
				if (!tex && Texture.getDefault) tex = Texture.getDefault();
				if (!tex) tex = Texture.all[0];
				if (!tex) throw new Error('No texture available; create one first with create_texture.');
				if (face.texture !== tex.uuid) face.texture = tex.uuid;
				if (!byTex.has(tex)) byTex.set(tex, []);
				byTex.get(tex).push({ face, base: it.base, ops: it.ops || [] });
			}
		}
		let painted = 0;
		byTex.forEach((list, tex) => {
			const scale = tex.width / (Project.texture_width || tex.width);
			tex.edit((canvas) => {
				const ctx = canvas.getContext('2d');
				ctx.imageSmoothingEnabled = false;
				for (const { face, base, ops } of list) {
					const r = faceRect(face, scale);
					if (r.w <= 0 || r.h <= 0) continue;
					if (base) { ctx.fillStyle = base; ctx.fillRect(r.x, r.y, r.w, r.h); }
					if (ops && ops.length) applyPaintOps(ctx, offsetOps(ops, r.x, r.y, r.w, r.h));
					painted++;
				}
			}, { edit_name: 'MCP: paint faces', no_undo: false });
		});
		Canvas.updateAll();
		return { painted };
	},

	resize_texture(p) {
		requireProject();
		const tex = findTexture(p.texture);
		if (!tex) throw new Error('Texture not found: ' + p.texture);
		const w = p.width | 0, h = p.height | 0;
		if (!w || !h) throw new Error('width and height are required');
		Undo.initEdit({ textures: [tex], bitmap: true });
		const c = document.createElement('canvas');
		c.width = w; c.height = h;
		const ctx = c.getContext('2d');
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(tex.img, 0, 0, w, h);
		tex.updateSource(c.toDataURL());
		tex.width = w; tex.height = h;
		Undo.finishEdit('MCP: resize texture');
		return serializeTexture(tex);
	},

	// ---- animations -------------------------------------------------------
	create_animation(p) {
		requireProject();
		if (typeof Animation === 'undefined') throw new Error('Animations are not supported in this format.');
		Undo.initEdit({ animations: [] });
		const anim = new Animation({
			name: p.name || 'animation',
			loop: p.loop || 'loop',
			length: p.length || 0,
		}).add();
		if (p.length) anim.setLength(p.length);
		Undo.finishEdit('MCP: create animation');
		anim.select();
		return serializeAnimation(anim);
	},

	list_animations() {
		requireProject();
		return (Animation.all || []).map(serializeAnimation);
	},

	add_keyframe(p) {
		requireProject();
		const anim = findAnimation(p.animation);
		if (!anim) throw new Error('Animation not found: ' + p.animation);
		const group = findGroup(p.bone);
		if (!group) throw new Error('Bone (group) not found: ' + p.bone);
		const channel = p.channel || 'rotation';
		anim.select();
		const animator = anim.getBoneAnimator(group);
		if (!animator) throw new Error('Cannot animate bone in this animation scope: ' + p.bone);
		Undo.initEdit({ keyframes: [] });
		const value = p.value || [0, 0, 0];
		const kf = animator.addKeyframe({
			channel,
			time: Number(p.time) || 0,
			interpolation: p.interpolation || 'linear',
			data_points: [{ x: value[0], y: value[1], z: value[2] }],
		});
		if (anim.length < (Number(p.time) || 0)) anim.setLength(Number(p.time));
		Undo.finishEdit('MCP: add keyframe');
		updateKeyframeSelection && updateKeyframeSelection();
		return { uuid: kf && kf.uuid, channel, time: kf && kf.time };
	},

	add_keyframes(p) {
		// Bulk variant: [{bone, channel, time, value, interpolation}, ...]
		requireProject();
		const anim = findAnimation(p.animation);
		if (!anim) throw new Error('Animation not found: ' + p.animation);
		anim.select();
		Undo.initEdit({ keyframes: [] });
		let maxTime = anim.length;
		const created = [];
		for (const k of p.keyframes || []) {
			const group = findGroup(k.bone);
			if (!group) throw new Error('Bone (group) not found: ' + k.bone);
			const animator = anim.getBoneAnimator(group);
			if (!animator) throw new Error('Cannot animate bone: ' + k.bone);
			const value = k.value || [0, 0, 0];
			const kf = animator.addKeyframe({
				channel: k.channel || 'rotation',
				time: Number(k.time) || 0,
				interpolation: k.interpolation || 'linear',
				data_points: [{ x: value[0], y: value[1], z: value[2] }],
			});
			created.push({ uuid: kf && kf.uuid, bone: k.bone, channel: k.channel || 'rotation', time: kf && kf.time });
			maxTime = Math.max(maxTime, Number(k.time) || 0);
		}
		anim.setLength(maxTime);
		Undo.finishEdit('MCP: add keyframes');
		updateKeyframeSelection && updateKeyframeSelection();
		return { created: created.length, keyframes: created, animation: serializeAnimation(anim) };
	},

	remove_animation(p) {
		requireProject();
		const anim = findAnimation(p.animation);
		if (!anim) throw new Error('Animation not found: ' + p.animation);
		anim.remove(true);
		return { removed: true };
	},

	// ---- view / camera / screenshot --------------------------------------
	set_camera_angle(p) {
		requireProject();
		const preview = Preview.selected;
		if (p.angle && typeof preview.setProjectionMode === 'function' && p.angle === 'ortho') {
			preview.setProjectionMode(true);
		}
		if (Array.isArray(p.position)) preview.camera.position.set(p.position[0], p.position[1], p.position[2]);
		if (Array.isArray(p.target) && preview.controls) preview.controls.target.set(p.target[0], p.target[1], p.target[2]);
		if (p.preset && preview.loadAnglePreset && DefaultCameraPresets) {
			const preset = DefaultCameraPresets.find((x) => x.id === p.preset);
			if (preset) preview.loadAnglePreset(preset);
		}
		preview.controls.updateSceneScale && preview.controls.updateSceneScale();
		preview.render();
		return { camera: preview.camera.position.toArray() };
	},

	screenshot(p) {
		requireProject();
		const preview = Preview.selected;
		const options = {};
		if (p && p.width) options.width = p.width;
		if (p && p.height) options.height = p.height;
		return new Promise((resolve) => {
			Screencam.screenshotPreview(preview, options, (dataUrl) => {
				resolve({
					mime: 'image/png',
					data_url: dataUrl,
					base64: dataUrl.replace(/^data:image\/png;base64,/, ''),
				});
			});
		});
	},

	// Capture several camera angles in one call so you can see the whole model
	// at once and spot problems (gaps, wrong rotations, missing detail) from
	// every side. `views` is a list of preset ids ('front','back','left',
	// 'right','top','bottom','isometric_right_front',...) or {position,target}.
	screenshot_views(p) {
		requireProject();
		const preview = Preview.selected;
		const views = (p && Array.isArray(p.views) && p.views.length)
			? p.views
			: ['isometric_right_front', 'front', 'left', 'back'];
		const options = {};
		if (p && p.width) options.width = p.width;
		if (p && p.height) options.height = p.height;
		const shotOne = () => new Promise((res) =>
			Screencam.screenshotPreview(preview, options, (d) => res(d)));
		return (async () => {
			const shots = [];
			for (const v of views) {
				if (typeof v === 'string') {
					const preset = (typeof DefaultCameraPresets !== 'undefined' && DefaultCameraPresets)
						? DefaultCameraPresets.find((x) => x.id === v || x.name === v) : null;
					if (preset && preview.loadAnglePreset) preview.loadAnglePreset(preset);
					else applyAngleName(preview, v);
				} else if (v && typeof v === 'object') {
					if (Array.isArray(v.position)) preview.camera.position.set(v.position[0], v.position[1], v.position[2]);
					if (Array.isArray(v.target) && preview.controls) preview.controls.target.set(v.target[0], v.target[1], v.target[2]);
				}
				if (preview.controls && preview.controls.updateSceneScale) preview.controls.updateSceneScale();
				preview.render();
				const dataUrl = await shotOne();
				shots.push({
					view: typeof v === 'string' ? v : 'custom',
					data_url: dataUrl,
					base64: dataUrl.replace(/^data:image\/png;base64,/, ''),
				});
			}
			return { count: shots.length, shots };
		})();
	},

	// A compact playbook the AI can read before building, so models come out
	// detailed and rotated rather than a few flat axis-aligned boxes.
	get_guide() {
		return { guide: MODELING_GUIDE };
	},

	// ---- plugins ----------------------------------------------------------
	list_plugins(p) {
		const list = (Plugins.all || []).map((pl) => ({
			id: pl.id,
			title: pl.title,
			author: pl.author,
			version: pl.version,
			installed: pl.installed,
			disabled: pl.disabled,
			tags: pl.tags,
			description: pl.description,
		}));
		if (p && p.installed_only) return list.filter((x) => x.installed);
		if (p && p.query) {
			const q = String(p.query).toLowerCase();
			return list.filter(
				(x) =>
					x.id.toLowerCase().includes(q) ||
					(x.title || '').toLowerCase().includes(q) ||
					(x.description || '').toLowerCase().includes(q)
			);
		}
		return list;
	},

	async install_plugin(p) {
		if (Plugins.loading_promise) await Plugins.loading_promise;
		if (p.url) {
			await new Plugin().loadFromURL(p.url, true);
			return { installed: true, source: 'url', url: p.url };
		}
		if (p.path) {
			requireApp();
			await new Plugin().loadFromFile({ path: p.path, name: p.path, content: '' }, true);
			return { installed: true, source: 'file', path: p.path };
		}
		if (!p.id) throw new Error('Provide a plugin id, url, or path.');
		let plugin = Plugins.all.find((x) => x.id === p.id);
		if (!plugin) {
			// The store list may still be loading; give it one shot.
			if (typeof loadInstalledPlugins === 'function') await loadInstalledPlugins().catch(() => {});
			plugin = Plugins.all.find((x) => x.id === p.id);
		}
		if (!plugin) throw new Error(`Plugin "${p.id}" not found in the store. Use list_plugins query to search.`);
		if (plugin.installed) return { installed: true, already: true, id: p.id };
		await plugin.install();
		return { installed: !!plugin.installed, id: p.id, title: plugin.title };
	},

	async uninstall_plugin(p) {
		if (!p.id) throw new Error('id is required');
		const plugin = Plugins.all.find((x) => x.id === p.id);
		if (!plugin || !plugin.installed) throw new Error('Plugin not installed: ' + p.id);
		plugin.uninstall();
		return { uninstalled: true, id: p.id };
	},

	// ---- escape hatch -----------------------------------------------------
	execute_script(p) {
		if (!p.code) throw new Error('code is required');
		const fn = new Function('params', 'Blockbench', '"use strict";\n' + p.code);
		const result = fn(p.params || {}, Blockbench);
		return Promise.resolve(result).then((r) => {
			// Best-effort safe serialization.
			try {
				JSON.stringify(r);
				return r;
			} catch (e) {
				return { value: String(r) };
			}
		});
	},
};

function applyFaces(cube, faces) {
	for (const dir in faces) {
		const face = cube.faces[dir];
		if (!face) continue;
		const fd = faces[dir];
		if (fd.uv) face.uv = fd.uv;
		if (fd.rotation !== undefined) face.rotation = fd.rotation;
		if (fd.texture !== undefined) {
			const tex = findTexture(fd.texture);
			face.texture = tex ? tex.uuid : false;
		}
	}
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

async function dispatch(action, params) {
	const handler = commands[action];
	if (!handler) throw new Error('Unknown command: ' + action);
	return await handler(params || {});
}

const MAX_BODY = 96 * 1024 * 1024; // 96 MB guard (textures/screenshots can be large)

function statusText(code) {
	return {
		200: 'OK', 204: 'No Content', 400: 'Bad Request',
		404: 'Not Found', 405: 'Method Not Allowed', 500: 'Internal Server Error',
	}[code] || 'OK';
}

/** Write a minimal HTTP/1.1 response to a raw TCP socket, then close it. */
function writeResponse(socket, status, obj, extraHeaders) {
	if (socket.destroyed) return;
	const body = Buffer.from(obj === undefined ? '' : JSON.stringify(obj), 'utf8');
	let head =
		`HTTP/1.1 ${status} ${statusText(status)}\r\n` +
		`Content-Type: application/json\r\n` +
		`Content-Length: ${body.length}\r\n` +
		`Access-Control-Allow-Origin: *\r\n` +
		`Connection: close\r\n`;
	if (extraHeaders) head += extraHeaders;
	head += '\r\n';
	try {
		socket.write(head);
		if (body.length) socket.write(body);
		socket.end();
	} catch (e) {
		try { socket.destroy(); } catch (_) {}
	}
}

async function handleRequest(socket, method, path, body) {
	try {
		if (method === 'OPTIONS') {
			writeResponse(socket, 204, undefined,
				'Access-Control-Allow-Methods: POST, GET, OPTIONS\r\n' +
				'Access-Control-Allow-Headers: Content-Type\r\n');
			return;
		}
		if (method === 'GET' && (path === '/' || path === '/ping' || path.startsWith('/ping?'))) {
			writeResponse(socket, 200, { ok: true, ...commands.ping() });
			return;
		}
		if (method !== 'POST') {
			writeResponse(socket, 405, { ok: false, error: 'Use POST /command' });
			return;
		}
		let payload;
		try {
			payload = JSON.parse(body || '{}');
		} catch (e) {
			writeResponse(socket, 400, { ok: false, error: 'Invalid JSON body' });
			return;
		}
		try {
			const result = await dispatch(payload.action, payload.params);
			writeResponse(socket, 200, { ok: true, id: payload.id, result });
		} catch (err) {
			console.error('[BlockbenchMCP] command failed:', payload && payload.action, err);
			writeResponse(socket, 200, {
				ok: false,
				id: payload && payload.id,
				error: err && err.message ? err.message : String(err),
				stack: err && err.stack ? String(err.stack) : undefined,
			});
		}
	} catch (e) {
		try { writeResponse(socket, 500, { ok: false, error: String(e) }); } catch (_) {}
	}
}

/** Accumulate bytes on a socket, parse one HTTP request, then dispatch it. */
function handleConnection(socket) {
	let chunks = [];
	let received = 0;
	let headersDone = false;
	let method, path, headerLength, contentLength = 0, expectContinue = false;

	socket.on('data', (chunk) => {
		received += chunk.length;
		if (received > MAX_BODY) { socket.destroy(); return; }
		chunks.push(chunk);
		const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
		chunks = [buffer];

		if (!headersDone) {
			const sep = buffer.indexOf('\r\n\r\n');
			if (sep === -1) return;
			headerLength = sep + 4;
			const headerText = buffer.slice(0, sep).toString('utf8');
			const lines = headerText.split('\r\n');
			const reqLine = (lines[0] || '').split(' ');
			method = reqLine[0];
			path = reqLine[1] || '/';
			for (let i = 1; i < lines.length; i++) {
				const c = lines[i].indexOf(':');
				if (c <= 0) continue;
				const key = lines[i].slice(0, c).trim().toLowerCase();
				const val = lines[i].slice(c + 1).trim();
				if (key === 'content-length') contentLength = parseInt(val, 10) || 0;
				if (key === 'expect' && /100-continue/i.test(val)) expectContinue = true;
			}
			headersDone = true;
			if (expectContinue) {
				try { socket.write('HTTP/1.1 100 Continue\r\n\r\n'); } catch (e) {}
			}
		}

		if (headersDone && buffer.length >= headerLength + contentLength) {
			const bodyText = buffer.slice(headerLength, headerLength + contentLength).toString('utf8');
			handleRequest(socket, method, path, bodyText);
		}
	});
	socket.on('error', () => { try { socket.destroy(); } catch (e) {} });
	socket.setTimeout(120000, () => { try { socket.destroy(); } catch (e) {} });
}

function startServer(port) {
	requireApp();
	if (G.server) {
		return { running: true, port: G.port, already: true };
	}
	const netModule = getNet(); // triggers the Blockbench permission dialog on first use
	port = port || getPort();
	const server = netModule.createServer(handleConnection);
	server.on('error', (err) => {
		console.error('[BlockbenchMCP] server error:', err);
		Blockbench.showQuickMessage('MCP server error: ' + err.message, 3000);
		G.server = null;
		G.port = null;
		updateMenuLabel();
	});
	server.listen(port, '127.0.0.1', () => {
		G.server = server;
		G.port = port;
		console.log(`[BlockbenchMCP] listening on http://127.0.0.1:${port}`);
		Blockbench.showQuickMessage(`MCP server started on port ${port}`, 2000);
		updateMenuLabel();
	});
	return { running: true, port };
}

function stopServer() {
	if (G.server) {
		G.server.close();
		G.server = null;
		G.port = null;
		console.log('[BlockbenchMCP] server stopped');
		Blockbench.showQuickMessage('MCP server stopped', 1500);
		updateMenuLabel();
		return { running: false };
	}
	return { running: false, already: true };
}

function getPort() {
	const setting = settings && settings[PLUGIN_ID + '_port'];
	return (setting && setting.value) || DEFAULT_PORT;
}

// ---------------------------------------------------------------------------
// UI: settings + menu actions
// ---------------------------------------------------------------------------

let toggleAction = null;

function updateMenuLabel() {
	if (!toggleAction) return;
	const running = !!G.server;
	toggleAction.setName(running ? `Stop MCP Server (:${G.port})` : 'Start MCP Server');
	if (toggleAction.setIcon) toggleAction.setIcon(running ? 'wifi' : 'wifi_off');
}

function buildUI() {
	const portSetting = new Setting(PLUGIN_ID + '_port', {
		name: 'MCP Server Port',
		description: 'Local port the BlockbenchMCP bridge listens on (127.0.0.1).',
		category: 'general',
		value: DEFAULT_PORT,
		type: 'number',
	});
	const autostartSetting = new Setting(PLUGIN_ID + '_autostart', {
		name: 'Start MCP Server automatically',
		description: 'Launch the BlockbenchMCP bridge when Blockbench opens.',
		category: 'general',
		value: true,
		type: 'toggle',
	});

	toggleAction = new Action(PLUGIN_ID + '_toggle', {
		name: 'Start MCP Server',
		description: 'Start or stop the local BlockbenchMCP bridge server.',
		icon: 'wifi_off',
		click() {
			if (G.server) stopServer();
			else startServer(getPort());
		},
	});

	const statusAction = new Action(PLUGIN_ID + '_status', {
		name: 'MCP Server Status',
		description: 'Show the current BlockbenchMCP bridge status.',
		icon: 'info',
		click() {
			const running = !!G.server;
			Blockbench.showMessageBox({
				title: 'BlockbenchMCP',
				message: running
					? `Server is running on http://127.0.0.1:${G.port}\n\nConnect your MCP client / AI to this port.`
					: 'Server is stopped. Use "Start MCP Server" to launch it.',
			});
		},
	});

	deletables.push(portSetting, autostartSetting, toggleAction, statusAction);

	try {
		MenuBar.addAction(toggleAction, 'tools');
		MenuBar.addAction(statusAction, 'tools');
	} catch (e) {
		console.warn('[BlockbenchMCP] could not add menu entries:', e);
	}

	if (autostartSetting.value && isApp) {
		try {
			startServer(getPort());
		} catch (e) {
			console.error('[BlockbenchMCP] autostart failed:', e);
		}
	}
	updateMenuLabel();
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

Plugin.register(PLUGIN_ID, {
	title: 'BlockbenchMCP',
	author: 'sosadly',
	icon: 'smart_toy',
	description:
		'Bridge that lets an AI (via the Model Context Protocol) create models, ' +
		'textures and animations, take screenshots and install plugins inside Blockbench.',
	tags: ['AI', 'Automation', 'MCP'],
	version: '0.1.0',
	min_version: '4.8.0',
	variant: 'desktop',
	onload() {
		// Reload safety: kill any server left over from a previous load.
		if (G.server) {
			try { G.server.close(); } catch (e) {}
			G.server = null;
		}
		buildUI();
	},
	onunload() {
		stopServer();
		deletables.forEach((d) => {
			try { d.delete(); } catch (e) {}
		});
		deletables = [];
		toggleAction = null;
	},
});

})();
