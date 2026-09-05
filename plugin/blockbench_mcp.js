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
// lastGate remembers the most recent check_model gate summary (ticket #23)
// so save_project can warn (advisory only, never blocking) when the gate
// did not pass. null/undefined means no check has run yet → no warning.
const G = (globalThis.__BLOCKBENCH_MCP__ = globalThis.__BLOCKBENCH_MCP__ || {
	server: null,
	port: null,
	lastGate: null,
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

/**
 * Valid Blockbench face directions. The wire contract carries these as an
 * explicit enum; anything else is ignored so unknown keys (including
 * prototype names on direct HTTP calls) can never touch cube faces.
 */
const FACE_DIRS = ['north', 'south', 'east', 'west', 'up', 'down'];

/**
 * Explicit scope convention (ticket #8): `{ scope: 'all'|'selected', elements[] }`.
 *
 * Returns { mode: 'all' } (every cube) or { mode: 'selected', refs } (the
 * `elements[]` refs), or { mode: 'legacy' } when neither `scope` nor
 * `elements` is present — the caller then falls back to its legacy `cubes` /
 * `'all'` handling, which stays tolerated during the deprecation window.
 * An explicit `scope` always wins; `elements` without `scope` implies
 * 'selected'. Errors name the offending field.
 */
function resolveScope(p) {
	if (p.scope != null) {
		if (p.scope !== 'all' && p.scope !== 'selected') {
			throw new Error('Field "scope" must be "all" or "selected".');
		}
		if (p.scope === 'selected') {
			const refs = toList(p.elements);
			if (!refs.length) throw new Error('Field "elements" (array of cube names/uuids) is required when scope is "selected".');
			return { mode: 'selected', refs };
		}
		return { mode: 'all' };
	}
	if (p.elements != null) {
		const refs = toList(p.elements);
		if (!refs.length) throw new Error('Field "elements" (array of cube names/uuids) must not be empty.');
		return { mode: 'selected', refs };
	}
	return { mode: 'legacy' };
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
		render_sides: t.render_sides,
		frame_count: (() => { try { return t.frameCount; } catch (e) { return undefined; } })(),
		frame_time: t.frame_time,
		frame_interpolate: t.frame_interpolate,
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

/** Name a [x,y,z] triple so axes are unambiguous over the bridge. */
function namedVec(v) {
	return { x: v[0], y: v[1], z: v[2] };
}

/**
 * Axis-aligned bounding box over cubes with from/to, in model units.
 * Shared mechanics for measure element/group/model modes: callers own
 * ref resolution and error classification, this owns only the union math.
 * Returns null when there is nothing to measure; otherwise
 * {min, max, size, center} with named {x,y,z} axes.
 */
function bboxOfCubes(cubes) {
	const list = (cubes || []).filter((c) => c && Array.isArray(c.from) && Array.isArray(c.to));
	if (!list.length) return null;
	let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	list.forEach((c) => {
		for (let i = 0; i < 3; i++) {
			min[i] = Math.min(min[i], c.from[i], c.to[i]);
			max[i] = Math.max(max[i], c.from[i], c.to[i]);
		}
	});
	const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
	const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
	return { min: namedVec(min), max: namedVec(max), size: namedVec(size), center: namedVec(center) };
}

/** All descendant cubes of a group/bone, including nested groups. */
function collectGroupCubes(group) {
	const out = [];
	(function walk(node) {
		(node.children || []).forEach((child) => {
			if (typeof Group !== 'undefined' && child instanceof Group) walk(child);
			else if (child && Array.isArray(child.from) && Array.isArray(child.to)) out.push(child);
			else if (child && Array.isArray(child.children)) walk(child);
		});
	})(group);
	return out;
}

/**
 * Audit thresholds shared by check_model and measure clearance so results
 * agree: callers own error classification, this owns only the numbers.
 * COPLANAR_EPS (0.02): two faces are coplanar when their plane coords differ
 * by less than this. OVERLAP_MIN (0.1): overlap length on BOTH other axes
 * must exceed this, else the pair is skipped (same 0.1 as the documented
 * nudge-one-cube fix).
 */
const COPLANAR_EPS = 0.02;
const OVERLAP_MIN = 0.1;
const AXES = ['x', 'y', 'z'];
function isUnrotatedCube(c) {
	return c && c.rotation && c.rotation.every((r) => Math.abs(r) < 0.001);
}
function axisOverlap(a1, a2, b1, b2) {
	return Math.min(a2, b2) - Math.max(a1, b1);
}

/**
 * Structured fix patches for check_model issues (proposals only, never
 * auto-applied). FIX_MIN_SIZE (1): the extent restored on a degenerate axis
 * so `to - from > 0` without inventing an arbitrary dimension.
 */
const FIX_MIN_SIZE = 1;
const r4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Machine-readable done-gate for check_model (ticket #22).
 * Classification (explicit, documented here and in src/tools.ts):
 * - error (fails the gate): degenerate_size, zero_uv, uv_out_of_bounds,
 *   coplanar_overlap, gap_slit — geometry/UV defects that break the render.
 * - warning (gate still passes): no_texture, no_bone_parent,
 *   see_through_opening, floating_piece — missing assignments recoverable
 *   without geometry changes, and space findings that need a reference
 *   check (designed window vs missing face; orphan vs sub-assembly).
 * Unknown future kinds default to error (fail-closed) so the gate never
 * silently passes an unclassified problem.
 * Returns {errors, warnings, gate_pass} with gate_pass true iff errors == 0.
 */
const GATE_SEVERITY = Object.assign(Object.create(null), {
	degenerate_size: 'error',
	zero_uv: 'error',
	uv_out_of_bounds: 'error',
	coplanar_overlap: 'error',
	gap_slit: 'error',
	see_through_opening: 'warning',
	floating_piece: 'warning',
	no_texture: 'warning',
	no_bone_parent: 'warning',
});
function summarizeGate(issues) {
	let errors = 0, warnings = 0;
	for (const i of issues || []) {
		if ((GATE_SEVERITY[i && i.issue] || 'error') === 'error') errors++;
		else warnings++;
	}
	return { errors, warnings, gate_pass: errors === 0 };
}

/**
 * Coplanar-overlap scan over unrotated cubes (the z-fight audit).
 * Returns [{a, b, axis, plane, gap, overlap:{<o1>:n, <o2>:n}}] capped at 80
 * pairs, one entry per pair on the first coplanar axis found.
 */
function clearanceOverlaps() {
	const ortho = Cube.all.filter(isUnrotatedCube);
	const out = [];
	for (let i = 0; i < ortho.length && out.length < 80; i++) {
		for (let j = i + 1; j < ortho.length && out.length < 80; j++) {
			const a = ortho[i], b = ortho[j];
			for (let ax = 0; ax < 3; ax++) {
				const o1 = (ax + 1) % 3, o2 = (ax + 2) % 3;
				const ov1 = axisOverlap(a.from[o1], a.to[o1], b.from[o1], b.to[o1]);
				if (ov1 <= OVERLAP_MIN) continue;
				const ov2 = axisOverlap(a.from[o2], a.to[o2], b.from[o2], b.to[o2]);
				if (ov2 <= OVERLAP_MIN) continue;
				const gapMin = Math.abs(a.from[ax] - b.from[ax]);
				const gapMax = Math.abs(a.to[ax] - b.to[ax]);
				const sameMin = gapMin < COPLANAR_EPS;
				const sameMax = gapMax < COPLANAR_EPS;
				if (sameMin || sameMax) {
					const overlap = {};
					overlap[AXES[o1]] = ov1;
					overlap[AXES[o2]] = ov2;
					out.push({
						a, b, axis: AXES[ax],
						plane: sameMin ? a.from[ax] : a.to[ax],
						gap: sameMin ? gapMin : gapMax,
						overlap,
					});
					break;
				}
			}
		}
	}
	return out;
}

/**
 * Space audit — the see-through-gap detector (screenshot review in data).
 *
 * Motivation: edge-to-edge cube chains (handguards, magazine segments,
 * guard loops) routinely leave 1px-wide slits you can see the background
 * through, and buttplates/caps stop short of the surface they should cover.
 * None of that trips coplanar_overlap — the cubes never share a plane —
 * so it used to surface only as a human "there is a hole in your model".
 * This audit makes the same finding machine-readable.
 *
 * Method: project unrotated cubes onto a unit grid in each of the three
 * view axes, flood the region OUTSIDE the model's footprint, then classify
 * each remaining empty cell: touching the projection border = detached (a
 * piece floating off the main mass); fully surrounded = enclosed hole
 * (daylight visible through the model in that projection). A hole in ONE
 * projection can still be legitimately open in 3D (a picture frame reads
 * as an enclosed hole from the front and as an annulus from the side) — so
 * enclosed_hole requires the gap to persist in ALL THREE projections;
 * single/two-projection voids are legal 3D openings, not defects.
 */
const AUDIT_GRID_MAX = 160;          // cap cells per axis before scaling down
const AUDIT_MIN_AREA_UNITS = 0.25;   // ignore sub-quarter-unit gaps (precision overlaps)
const AUDIT_MIN_CELLS = 1;           // report any enclosed hole of >= this many cells
const AUDIT_SLIT_FRAC = 0.02;        // crack-thin: min dim <= 2% of longest span
const AUDIT_SLIT_ASPECT = 3;         // ...and aspect (long/short) >= 3
const AUDIT_MAX_REPORT = 40;         // cap per kind so the issue list stays readable

function auditProjectFootprint(cubes, axis) {
	// Project onto the plane spanned by the two axes that are NOT `axis`.
	const a = (axis + 1) % 3, b = (axis + 2) % 3;
	let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity;
	for (const c of cubes) {
		if (c.from[a] < lo0) lo0 = c.from[a];
		if (c.to[a] > hi0) hi0 = c.to[a];
		if (c.from[b] < lo1) lo1 = c.from[b];
		if (c.to[b] > hi1) hi1 = c.to[b];
	}
	// Degenerate extent on either spanned axis -> nothing to audit.
	if (!(hi0 > lo0) || !(hi1 > lo1)) return null;
	const w0 = hi0 - lo0, w1 = hi1 - lo1;
	// Unit grid, scaled down (never up) when the model exceeds AUDIT_GRID_MAX.
	const scale = Math.max(1, Math.ceil(Math.max(w0, w1) / AUDIT_GRID_MAX));
	const nx = Math.min(AUDIT_GRID_MAX, Math.ceil(w0 / scale) + 1);
	const ny = Math.min(AUDIT_GRID_MAX, Math.ceil(w1 / scale) + 1);
	const cell = (v, lo) => Math.min(nx - 1, Math.max(0, Math.floor((v - lo) / scale)));
	const solid = new Uint8Array(nx * ny);
	for (const c of cubes) {
		const x0 = cell(c.from[a], lo0), x1 = cell(c.to[a] - 1e-6, lo0);
		const y0 = cell(c.from[b], lo1), y1 = cell(c.to[b] - 1e-6, lo1);
		for (let y = y0; y <= y1; y++) {
			const row = y * nx;
			for (let x = x0; x <= x1; x++) solid[row + x] = 1;
		}
	}
	return { nx, ny, scale, solid, lo0, lo1, area: w0 * w1 };
}

function floodOutside(solid, nx, ny) {
	const outside = new Uint8Array(nx * ny);
	const stack = [];
	for (let x = 0; x < nx; x++) {
		if (!solid[x]) { outside[x] = 1; stack.push(x); }
		const i2 = (ny - 1) * nx + x;
		if (!solid[i2]) { outside[i2] = 1; stack.push(i2); }
	}
	for (let y = 0; y < ny; y++) {
		const i1 = y * nx;
		if (!solid[i1]) { outside[i1] = 1; stack.push(i1); }
		const i2 = i1 + nx - 1;
		if (!solid[i2]) { outside[i2] = 1; stack.push(i2); }
	}
	while (stack.length) {
		const i = stack.pop();
		const x = i % nx, y = (i / nx) | 0;
		if (x > 0 && !outside[i - 1] && !solid[i - 1]) { outside[i - 1] = 1; stack.push(i - 1); }
		if (x < nx - 1 && !outside[i + 1] && !solid[i + 1]) { outside[i + 1] = 1; stack.push(i + 1); }
		if (y > 0 && !outside[i - nx] && !solid[i - nx]) { outside[i - nx] = 1; stack.push(i - nx); }
		if (y < ny - 1 && !outside[i + nx] && !solid[i + nx]) { outside[i + nx] = 1; stack.push(i + nx); }
	}
	return outside;
}

/** Connected components of empty, non-outside cells (4-connectivity). */
function emptyRegions(solid, outside, nx, ny) {
	const seen = new Uint8Array(nx * ny);
	const out = [];
	for (let start = 0; start < nx * ny; start++) {
		if (solid[start] || outside[start] || seen[start]) continue;
		let area = 0, minx = nx, maxx = -1, miny = ny, maxy = -1, touchesBorder = false;
		const stack = [start];
		seen[start] = 1;
		while (stack.length) {
			const i = stack.pop();
			const x = i % nx, y = (i / nx) | 0;
			area++;
			if (x < minx) minx = x;
			if (x > maxx) maxx = x;
			if (y < miny) miny = y;
			if (y > maxy) maxy = y;
			if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) touchesBorder = true;
			if (x > 0 && !solid[i - 1] && !outside[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
			if (x < nx - 1 && !solid[i + 1] && !outside[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
			if (y > 0 && !solid[i - nx] && !outside[i - nx] && !seen[i - nx]) { seen[i - nx] = 1; stack.push(i - nx); }
			if (y < ny - 1 && !solid[i + nx] && !outside[i + nx] && !seen[i + nx]) { seen[i + nx] = 1; stack.push(i + nx); }
		}
		out.push({ area, minx, maxx, miny, maxy, touchesBorder });
	}
	return out;
}

/** Connected components of OCCUPIED cells (4-connectivity), same shape as
 * emptyRegions — used to detect pieces disconnected from the main mass. */
function solidIslands(solid, nx, ny) {
	const seen = new Uint8Array(nx * ny);
	const out = [];
	for (let start = 0; start < nx * ny; start++) {
		if (!solid[start] || seen[start]) continue;
		let area = 0, minx = nx, maxx = -1, miny = ny, maxy = -1;
		const stack = [start];
		seen[start] = 1;
		while (stack.length) {
			const i = stack.pop();
			const x = i % nx, y = (i / nx) | 0;
			area++;
			if (x < minx) minx = x;
			if (x > maxx) maxx = x;
			if (y < miny) miny = y;
			if (y > maxy) maxy = y;
			if (x > 0 && solid[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
			if (x < nx - 1 && solid[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
			if (y > 0 && solid[i - nx] && !seen[i - nx]) { seen[i - nx] = 1; stack.push(i - nx); }
			if (y < ny - 1 && solid[i + nx] && !seen[i + nx]) { seen[i + nx] = 1; stack.push(i + nx); }
		}
		out.push({ area, minx, maxx, miny, maxy });
	}
	return out;
}

/**
 * The full space audit. Returns { slits, openings, detached } in model units.
 *
 * Union-projection semantics: a void cell in a projection means NO cube
 * occupies that sightline — i.e. you can see background through the model
 * along that axis. A void fully sealed in 3D (interior cavity) is hidden
 * behind its own shell in EVERY projection and correctly stays silent.
 * Classes:
 * - slits: crack-thin voids enclosed in >=1 projection — the edge-to-edge
 *   junction class (handguard meets barrel, buttplate short of the stock).
 *   Thinness = dim_min <= max(1 unit, 0.5% of the longest projection span),
 *   so a hairline means the same on a pistol as on a building. Gate ERROR.
 * - openings: see-through voids that are NOT crack-thin (windows, ports,
 *   guard loops) — legal design OR a missing face; gate WARNING with a
 *   verify-against-reference hint. Voids open to the outside (notches,
 *   C-shapes, gaps between separate masses) are NOT see-through and are
 *   never reported.
 * - detached: pieces disconnected from the main mass in 3D (cube-graph
 *   connectivity: two cubes connect iff no axis positively separates their
 *   boxes — touching counts, any real gap splits). Gate WARNING.
 */
function auditSpaceGaps(cubeList, opts) {
	const o = opts || {};
	const minCells = o.min_cells != null ? Number(o.min_cells) : AUDIT_MIN_CELLS;
	const slitFrac = o.slit_frac != null ? Number(o.slit_frac) : AUDIT_SLIT_FRAC;
	const perAxis = [];
	let maxSpan = 0;
	for (let axis = 0; axis < 3; axis++) {
		const proj = auditProjectFootprint(cubeList, axis);
		if (!proj) continue;
		const spanX = proj.nx * proj.scale, spanY = proj.ny * proj.scale;
		if (spanX > maxSpan) maxSpan = spanX;
		if (spanY > maxSpan) maxSpan = spanY;
		const outside = floodOutside(proj.solid, proj.nx, proj.ny);
		const voids = emptyRegions(proj.solid, outside, proj.nx, proj.ny)
			.filter((r) => r.area >= minCells)
			.map((r) => {
				const s = proj.scale;
				const c0 = proj.lo0 + r.minx * s, c1 = proj.lo0 + (r.maxx + 1) * s;
				const d0 = proj.lo1 + r.miny * s, d1 = proj.lo1 + (r.maxy + 1) * s;
				const wU = Math.abs(c1 - c0), hU = Math.abs(d1 - d0);
				return {
					axis: AXES[axis],
					area_units: Math.round(r.area * s * s * 100) / 100,
					dim_min: Math.round(Math.min(wU, hU) * 100) / 100,
					dim_max: Math.round(Math.max(wU, hU) * 100) / 100,
					rect: {
						min: [r4(Math.min(c0, c1)), r4(Math.min(d0, d1))],
						max: [r4(Math.max(c0, c1)), r4(Math.max(d0, d1))],
					},
				};
			});
		perAxis.push({ axis: AXES[axis], voids });
	}
	// Crack-thin threshold scales with the model's longest projection span
	// (floor 1 unit — anything a unit wide can read as a hairline crack).
	const slitMaxDim = o.slit_max_dim != null
		? Number(o.slit_max_dim)
		: Math.max(1, slitFrac * maxSpan);
	const minArea = Math.max(AUDIT_MIN_AREA_UNITS, maxSpan * maxSpan * 0.0001);
	const slits = [];
	const openings = [];
	const seenKeys = new Set();
	for (const pa of perAxis) {
		for (const r of pa.voids) {
			if (r.area_units < minArea) continue;
			const k = pa.axis + ':' + r.rect.min.join(',') + '|' + r.rect.max.join(',');
			if (seenKeys.has(k)) continue;
			seenKeys.add(k);
			if (r.dim_min <= slitMaxDim) {
				slits.push({
					axis: pa.axis, at: r.rect, area_units: r.area_units,
					dim_min: r.dim_min, dim_max: r.dim_max,
					hint: 'crack-thin see-through gap enclosed in the ' + pa.axis + ' projection — parts meet edge-to-edge instead of overlapping',
				});
			} else {
				openings.push({
					axis: pa.axis, at: r.rect, area_units: r.area_units,
					dim_min: r.dim_min, dim_max: r.dim_max,
				});
			}
		}
	}
	// Floating pieces: O(n^2) cube-graph connectivity. Two cubes connect when
	// NO axis positively separates their boxes (touching = connected; any real
	// gap on any axis = separate). Degenerate (zero-extent) cubes have no
	// volume — they are already reported by degenerate_size and excluded.
	const solid = cubeList.filter((c) =>
		c.to[0] - c.from[0] > 1e-9 && c.to[1] - c.from[1] > 1e-9 && c.to[2] - c.from[2] > 1e-9);
	const n = solid.length;
	const parent = new Int32Array(n).map((_, i) => i);
	const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
	const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
	const axisGap = (a, b, ax) => Math.max(a.from[ax] - b.to[ax], b.from[ax] - a.to[ax]);
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			if (axisGap(solid[i], solid[j], 0) <= 1e-6 &&
				axisGap(solid[i], solid[j], 1) <= 1e-6 &&
				axisGap(solid[i], solid[j], 2) <= 1e-6) union(i, j);
		}
	}
	const compSize = new Map();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		compSize.set(r, (compSize.get(r) || 0) + 1);
	}
	let primary = -1, primarySize = 0;
	compSize.forEach((sz, r) => { if (sz > primarySize) { primarySize = sz; primary = r; } });
	const detached = [];
	if (compSize.size > 1) {
		const seenRoots = new Set();
		for (let i = 0; i < n; i++) {
			const r = find(i);
			if (r === primary || seenRoots.has(r)) continue;
			seenRoots.add(r);
			let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
			for (let j = 0; j < n; j++) {
				if (find(j) !== r) continue;
				for (let ax = 0; ax < 3; ax++) {
					if (solid[j].from[ax] < min[ax]) min[ax] = solid[j].from[ax];
					if (solid[j].to[ax] > max[ax]) max[ax] = solid[j].to[ax];
				}
			}
			detached.push({
				at: { min: min.map(r4), max: max.map(r4) },
				cubes: solid.filter((c, j) => find(j) === r).map((c) => c.name).slice(0, 6),
			});
		}
	}
	return {
		slits: slits.slice(0, AUDIT_MAX_REPORT),
		openings: openings.slice(0, AUDIT_MAX_REPORT),
		detached: detached.slice(0, AUDIT_MAX_REPORT),
	};
}

/**
 * Measurable box for one distance ref (cube OR group incl. children).
 * Returns {node, kind, box, cubes} or throws a field-named error for `field`.
 */
function measurableBox(ref, field) {
	if (!ref) throw new Error('Field "' + field + '" (name|uuid) is required for mode "distance".');
	const g = typeof Group !== 'undefined' ? findGroup(ref) : null;
	if (g) {
		const cubes = collectGroupCubes(g);
		if (!cubes.length) throw new Error('Field "' + field + '" has no measurable cubes: ' + ref);
		const box = bboxOfCubes(cubes);
		return { node: g, kind: 'group', box, cubes };
	}
	const el = findElement(ref);
	if (!el) throw new Error('Field "' + field + '" not found: ' + ref);
	if (!Array.isArray(el.from) || !Array.isArray(el.to))
		throw new Error('Field "' + field + '" has no bounding box: ' + ref);
	return { node: el, kind: 'element', box: bboxOfCubes([el]), cubes: [el] };
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

/**
 * Blueprint capture mechanics (ticket #7 service layer).
 * Orthographic side/front/top shots with a pixels-per-unit guarantee and an
 * optional wireframe overlay. Callers own which view to shoot; these helpers
 * own only the pin/scale/overlay/restore mechanics so every shot behaves
 * identically. Blockbench ortho frustum is CSS-pixel based (40 x zoom CSS
 * px per unit) while the captured canvas renders at device resolution, so
 * the zoom pin compensates for devicePixelRatio to hold the PNG-level
 * guarantee on connected previews.
 */
const BLUEPRINT_PX_PER_UNIT_K = 40;

/** Normalize one `views` item + call-level defaults into explicit blueprint params. */
function normalizeBlueprintView(v, defaults) {
	const d = defaults || {};
	const bp = {
		label: 'custom', presetName: null, position: null, target: null,
		ortho: d.ortho, px_per_unit: d.px_per_unit, wireframe: d.wireframe,
	};
	const takeOverrides = (o) => {
		if (!o || typeof o !== 'object') return;
		if (typeof o.ortho === 'boolean') bp.ortho = o.ortho;
		if (typeof o.px_per_unit === 'number') bp.px_per_unit = o.px_per_unit;
		if (typeof o.wireframe === 'boolean') bp.wireframe = o.wireframe;
	};
	if (typeof v === 'string') {
		bp.label = v;
		bp.presetName = v;
	} else if (v && typeof v === 'object' && !Array.isArray(v)) {
		if (v.view !== undefined) {
			// Per-view blueprint object: {view: string|{position,target}, ortho?, px_per_unit?, wireframe?}
			takeOverrides(v);
			const inner = v.view;
			if (typeof inner === 'string') {
				bp.label = inner;
				bp.presetName = inner;
			} else if (inner && typeof inner === 'object') {
				if (Array.isArray(inner.position)) bp.position = inner.position;
				if (Array.isArray(inner.target)) bp.target = inner.target;
			}
		} else {
			// Legacy {position,target} object; call-level blueprint flags apply.
			if (Array.isArray(v.position)) bp.position = v.position;
			if (Array.isArray(v.target)) bp.target = v.target;
		}
	}
	// px_per_unit is only meaningful in ortho: requesting a scale pins ortho
	// unless the view explicitly opts out (then the scale is dropped, never
	// faked onto a perspective shot).
	if (typeof bp.px_per_unit === 'number' && bp.ortho === undefined) bp.ortho = true;
	return bp;
}

/** Snapshot preview + view-mode state so a blueprint shot can restore it afterward. */
function savePreviewState(preview) {
	return {
		ortho: !!(preview && preview.isOrtho),
		angle: preview ? preview.angle : null,
		zoom: preview && preview.camera ? preview.camera.zoom : null,
		fov: (preview && preview.camPers && typeof preview.camPers.fov === 'number') ? preview.camPers.fov : null,
		pos: preview && preview.camera ? preview.camera.position.clone() : null,
		target: preview && preview.controls ? preview.controls.target.clone() : null,
		viewMode: (typeof Project !== 'undefined' && Project) ? Project.view_mode : null,
	};
}

/** Restore state saved by savePreviewState. Returns {projection_restored}. */
function restorePreviewState(preview, state) {
	try {
		if (state.viewMode !== null && typeof Project !== 'undefined' && Project &&
			Project.view_mode !== state.viewMode) {
			Project.view_mode = state.viewMode;
			if (typeof Canvas !== 'undefined' && Canvas && typeof Canvas.updateViewMode === 'function') Canvas.updateViewMode();
		}
		if (preview && typeof preview.setProjectionMode === 'function') preview.setProjectionMode(!!state.ortho);
		if (preview && typeof preview.setLockedAngle === 'function' && state.angle !== undefined) {
			try { preview.setLockedAngle(state.angle || undefined); } catch (e) { /* older builds */ }
		}
		if (preview && preview.camera && state.pos) preview.camera.position.copy(state.pos);
		if (preview && preview.controls && state.target) preview.controls.target.set(state.target.x, state.target.y, state.target.z);
		if (preview && preview.camera && typeof state.zoom === 'number') {
			preview.camera.zoom = state.zoom;
			if (typeof preview.camera.updateProjectionMatrix === 'function') preview.camera.updateProjectionMatrix();
		}
		if (!state.ortho && preview && typeof preview.setFOV === 'function' && typeof state.fov === 'number') {
			try { preview.setFOV(state.fov); } catch (e) { /* ignore */ }
		}
		if (preview && typeof preview.render === 'function') preview.render();
	} catch (e) { /* restore best-effort; report below */ }
	const restored = preview && typeof preview.isOrtho === 'boolean' ? preview.isOrtho === !!state.ortho : true;
	return { projection_restored: !!restored };
}

/** Pin projection/scale/overlay for one blueprint shot (after camera is placed). */
function applyBlueprintSettings(preview, bp) {
	if (bp.ortho && preview && typeof preview.setProjectionMode === 'function') preview.setProjectionMode(true);
	// Scale guarantee holds only for ortho shots; never bend a perspective
	// camera's zoom and report it as px-per-unit.
	if (bp.ortho && typeof bp.px_per_unit === 'number' && preview && preview.camera) {
		// Ortho frustum is CSS-pixel based but screenshotPreview returns the
		// device-resolution canvas: divide out devicePixelRatio so the PNG
		// carries px_per_unit device px per model unit at any display scaling.
		const dpr = (typeof window !== 'undefined' && window && window.devicePixelRatio) ? window.devicePixelRatio : 1;
		preview.camera.zoom = bp.px_per_unit / (BLUEPRINT_PX_PER_UNIT_K * (dpr || 1));
		if (typeof preview.camera.updateProjectionMatrix === 'function') preview.camera.updateProjectionMatrix();
	}
	if (bp.wireframe && typeof Project !== 'undefined' && Project) {
		Project.view_mode = 'wireframe';
		if (typeof Canvas !== 'undefined' && Canvas && typeof Canvas.updateViewMode === 'function') Canvas.updateViewMode();
	}
}

/** Place the preview camera from normalized blueprint params (shared by screenshot/compare). */
function placeCameraOnPreview(preview, bp) {
	if (bp.position || bp.target) {
		if (Array.isArray(bp.position)) preview.camera.position.set(bp.position[0], bp.position[1], bp.position[2]);
		if (Array.isArray(bp.target) && preview.controls) preview.controls.target.set(bp.target[0], bp.target[1], bp.target[2]);
	} else if (bp.presetName) {
		const preset = (typeof DefaultCameraPresets !== 'undefined' && DefaultCameraPresets)
			? DefaultCameraPresets.find((x) => x.id === bp.presetName || x.name === bp.presetName) : null;
		if (preset && preview.loadAnglePreset) preview.loadAnglePreset(preset);
		else applyAngleName(preview, bp.presetName);
	}
}

/**
 * Capture one blueprint shot per requested view with the screenshot_views
 * plumbing (normalize → place → pin → render → shot → per-shot restore,
 * entry-state restore in finally). Returns {shots, projection_restored} in
 * the screenshot_views shot shape. Throws naming "px_per_unit" for
 * non-positive scales.
 */
async function captureBlueprintViews(preview, views, defaults, options) {
	const opts = options || {};
	const shotOne = () => new Promise((res) =>
		Screencam.screenshotPreview(preview, opts, (d) => res(d)));
	const entryState = savePreviewState(preview);
	const shots = [];
	try {
		for (const v of views) {
			const bp = normalizeBlueprintView(v, defaults);
			if (bp.px_per_unit !== undefined && !(bp.px_per_unit > 0)) {
				throw new Error('Field "px_per_unit" must be a positive number.');
			}
			const saved = savePreviewState(preview);
			try {
				placeCameraOnPreview(preview, bp);
				if (preview.controls && preview.controls.updateSceneScale) preview.controls.updateSceneScale();
				applyBlueprintSettings(preview, bp);
				preview.render();
				const dataUrl = await shotOne();
				// Report applied state, not just requested flags, so a
				// build missing the projection/wireframe APIs cannot
				// silently claim a guarantee it did not deliver.
				const heldOrtho = (preview && typeof preview.isOrtho === 'boolean') ? preview.isOrtho : !!bp.ortho;
				const heldWire = (typeof Project !== 'undefined' && Project)
					? Project.view_mode === 'wireframe' : !!bp.wireframe;
				const shotOrtho = !!bp.ortho && heldOrtho;
				const shotWire = !!bp.wireframe && heldWire;
				const { projection_restored } = restorePreviewState(preview, saved);
				shots.push({
					view: bp.label,
					data_url: dataUrl,
					base64: dataUrl.replace(/^data:image\/png;base64,/, ''),
					ortho: shotOrtho,
					px_per_unit: shotOrtho && typeof bp.px_per_unit === 'number' ? bp.px_per_unit : null,
					wireframe: shotWire,
					projection_restored,
				});
			} catch (err) {
				restorePreviewState(preview, saved);
				throw err;
			}
		}
	} finally {
		restorePreviewState(preview, entryState);
	}
	return { shots, projection_restored: shots.every((s) => s.projection_restored) };
}

/**
 * Structured image comparison mechanics (ticket #26 service layer). The
 * bridge has no native pixel-diff library, so deltas are computed from
 * decoded bytes: byte equality decides match (deterministic for the same
 * model + camera + px_per_unit), while PNG IHDR dimensions plus byte counts
 * make the delta text structured enough to drive a fix and textual enough
 * to read. Callers own when to capture/pin; these helpers own only decoding
 * and delta text.
 */

/** Split a data:...;base64,... URL into {mime, bytes}; null when undecodable. */
function dataUrlToBytes(dataUrl) {
	if (typeof dataUrl !== 'string') return null;
	const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
	if (!m) return null;
	try {
		const buf = Buffer.from(m[2], 'base64');
		if (!buf || !buf.length) return null;
		return { mime: m[1], bytes: buf };
	} catch (e) { return null; }
}

/** Read PNG IHDR width/height; null unless the buffer is a parseable PNG. */
function parsePngDimensions(buf) {
	try {
		if (!buf || buf.length < 24) return null;
		if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
			buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A)) return null;
		if (!(buf[12] === 0x49 && buf[13] === 0x48 && buf[14] === 0x44 && buf[15] === 0x52)) return null;
		return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	} catch (e) { return null; }
}

/** One-line shape for a decoded image: `image/png 70 bytes 1x1` (dims only when parseable). */
function describeImageBits(mime, buf) {
	const dim = parsePngDimensions(buf);
	return `${mime} ${buf.length} bytes${dim ? ` ${dim.width}x${dim.height}` : ''}`;
}

/**
 * Compare a fresh shot against its pinned reference. Returns {match, delta,
 * reference, shot} where reference/shot carry {mime, bytes, width, height}
 * (width/height null when not PNG-parseable) and delta is stable text:
 * identical bytes → `identical ...`, otherwise differing-byte counts plus
 * first-diff offset plus both sizes. Deterministic: the same model + camera
 * + px_per_unit yields the same bytes, hence the same delta shape.
 */
function describeImageDelta(refDataUrl, shotDataUrl) {
	const ref = dataUrlToBytes(refDataUrl);
	const shot = dataUrlToBytes(shotDataUrl);
	if (!ref || !shot) {
		const refDim = ref ? parsePngDimensions(ref.bytes) : null;
		const shotDim = shot ? parsePngDimensions(shot.bytes) : null;
		return {
			match: false,
			delta: 'could not decode the pinned reference or the fresh capture for comparison.',
			reference: ref ? { mime: ref.mime, bytes: ref.bytes.length, width: refDim ? refDim.width : null, height: refDim ? refDim.height : null } : null,
			shot: shot ? { mime: shot.mime, bytes: shot.bytes.length, width: shotDim ? shotDim.width : null, height: shotDim ? shotDim.height : null } : null,
		};
	}
	const refDim = parsePngDimensions(ref.bytes);
	const shotDim = parsePngDimensions(shot.bytes);
	const meta = (m, b, d) => ({ mime: m, bytes: b.length, width: d ? d.width : null, height: d ? d.height : null });
	if (ref.bytes.equals(shot.bytes)) {
		return {
			match: true,
			delta: `identical to pinned reference (${describeImageBits(shot.mime, shot.bytes)})`,
			reference: meta(ref.mime, ref.bytes, refDim),
			shot: meta(shot.mime, shot.bytes, shotDim),
		};
	}
	const n = Math.min(ref.bytes.length, shot.bytes.length);
	const big = Math.max(ref.bytes.length, shot.bytes.length);
	let differing = Math.abs(ref.bytes.length - shot.bytes.length);
	let firstDiff = -1;
	for (let i = 0; i < n; i++) {
		if (ref.bytes[i] !== shot.bytes[i]) {
			differing++;
			if (firstDiff < 0) firstDiff = i;
		}
	}
	if (firstDiff < 0) firstDiff = n;
	return {
		match: false,
		delta: `differs from pinned reference: ${differing}/${big} bytes differ (first diff at byte ${firstDiff}); ` +
			`shot ${describeImageBits(shot.mime, shot.bytes)} vs reference ${describeImageBits(ref.mime, ref.bytes)}`,
		reference: meta(ref.mime, ref.bytes, refDim),
		shot: meta(shot.mime, shot.bytes, shotDim),
	};
}

// ---- silhouette metrics (compare v2) ---------------------------------------

let zlibModule = null;
/** Lazy zlib for PNG IDAT inflate (mirrors getNet: lazy require, explicit error). */
function getZlib() {
	if (zlibModule) return zlibModule;
	zlibModule = require('zlib'); // may show a permission dialog or throw if denied
	if (!zlibModule || !zlibModule.inflateSync) {
		throw new Error('zlib module was denied. Allow it so compare_views can measure silhouettes.');
	}
	return zlibModule;
}

/**
 * Decode a PNG (8-bit, non-interlaced) into {width, height, data:Uint8Array RGBA}.
 * Covers the color types Blockbench and reference tools emit (0 gray, 2 RGB,
 * 3 palette, 4 gray+alpha, 6 RGBA). Returns null for anything unsupported
 * (callers fall back to byte deltas); never throws.
 */
function decodePngRgba(buf) {
	try {
		if (!buf || buf.length < 57 || !parsePngDimensions(buf)) return null;
		const u32 = (o) => buf.readUInt32BE(o);
		const idat = [];
		let palette = null, trns = null;
		let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
		let off = 8;
		while (off + 8 <= buf.length) {
			const len = u32(off);
			const type = buf.toString('ascii', off + 4, off + 8);
			const ds = off + 8;
			if (type === 'IHDR') {
				width = u32(ds); height = u32(ds + 4);
				bitDepth = buf[ds + 8]; colorType = buf[ds + 9]; interlace = buf[ds + 12];
			} else if (type === 'PLTE') {
				palette = buf.slice(ds, ds + len);
			} else if (type === 'tRNS') {
				trns = buf.slice(ds, ds + len);
			} else if (type === 'IDAT') {
				idat.push(buf.slice(ds, ds + len));
			} else if (type === 'IEND') {
				break;
			}
			off = ds + len + 4; // skip CRC
		}
		const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
		if (!width || !height || !channels || interlace !== 0 || bitDepth !== 8) return null;
		const raw = getZlib().inflateSync(Buffer.concat(idat));
		const stride = width * channels;
		if (raw.length < (stride + 1) * height) return null;
		const out = new Uint8Array(width * height * 4);
		const row = Buffer.alloc(stride);
		const prev = Buffer.alloc(stride);
		let p = 0;
		for (let y = 0; y < height; y++) {
			const ft = raw[p++];
			for (let i = 0; i < stride; i++) row[i] = raw[p++];
			if (ft === 1) {
				for (let i = channels; i < stride; i++) row[i] = (row[i] + row[i - channels]) & 0xff;
			} else if (ft === 2) {
				for (let i = 0; i < stride; i++) row[i] = (row[i] + prev[i]) & 0xff;
			} else if (ft === 3) {
				for (let i = 0; i < stride; i++) {
					const a = i >= channels ? row[i - channels] : 0;
					row[i] = (row[i] + ((a + prev[i]) >> 1)) & 0xff;
				}
			} else if (ft === 4) {
				for (let i = 0; i < stride; i++) {
					const a = i >= channels ? row[i - channels] : 0;
					const b = prev[i];
					const c = i >= channels ? prev[i - channels] : 0;
					const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
					row[i] = (row[i] + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 0xff;
				}
			} else if (ft !== 0) {
				return null;
			}
			for (let x = 0; x < width; x++) {
				const o = (y * width + x) * 4;
				if (colorType === 6) {
					out[o] = row[x * 4]; out[o + 1] = row[x * 4 + 1]; out[o + 2] = row[x * 4 + 2]; out[o + 3] = row[x * 4 + 3];
				} else if (colorType === 2) {
					out[o] = row[x * 3]; out[o + 1] = row[x * 3 + 1]; out[o + 2] = row[x * 3 + 2]; out[o + 3] = 255;
				} else if (colorType === 0) {
					out[o] = out[o + 1] = out[o + 2] = row[x]; out[o + 3] = 255;
				} else if (colorType === 4) {
					out[o] = out[o + 1] = out[o + 2] = row[x * 2]; out[o + 3] = row[x * 2 + 1];
				} else {
					const idx = row[x];
					if (palette && idx * 3 + 2 < palette.length) {
						out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2];
					}
					out[o + 3] = (trns && idx < trns.length) ? trns[idx] : 255;
				}
			}
			prev.set(row);
		}
		return { width, height, data: out };
	} catch (e) {
		return null;
	}
}

/**
 * Build a boolean silhouette mask from decoded RGBA pixels. Alpha keying
 * first (bridge shots render on transparent backgrounds); when the image is
 * effectively opaque, corner keying (four corners must agree on a backdrop
 * color — product photos on flat backgrounds); when neither yields a usable
 * mask, returns {mask: null} and the caller falls back to byte deltas.
 */
function buildSilhouetteMask(img, threshold) {
	const w = img.width, h = img.height, data = img.data;
	const total = w * h;
	const mask = new Uint8Array(total);
	let hit = 0;
	for (let i = 0; i < total; i++) {
		if (data[i * 4 + 3] >= threshold) { mask[i] = 1; hit++; }
	}
	const coverage = hit / total;
	if (coverage >= 0.01 && coverage <= 0.99) return { mask, method: 'alpha', coverage };
	if (coverage > 0.99) {
		// Opaque: corner keying. Corners must agree within tolerance, else no mask.
		const px = (x, y) => { const o = (y * w + x) * 4; return [data[o], data[o + 1], data[o + 2]]; };
		const c00 = px(0, 0), c10 = px(w - 1, 0), c01 = px(0, h - 1), c11 = px(w - 1, h - 1);
		const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
		if (dist(c00, c10) <= 48 && dist(c00, c01) <= 48 && dist(c00, c11) <= 48) {
			const bg = [
				(c00[0] + c10[0] + c01[0] + c11[0]) >> 2,
				(c00[1] + c10[1] + c01[1] + c11[1]) >> 2,
				(c00[2] + c10[2] + c01[2] + c11[2]) >> 2,
			];
			mask.fill(0);
			let hit2 = 0;
			for (let i = 0; i < total; i++) {
				const d = Math.abs(data[i * 4] - bg[0]) + Math.abs(data[i * 4 + 1] - bg[1]) + Math.abs(data[i * 4 + 2] - bg[2]);
				if (d > 96) { mask[i] = 1; hit2++; }
			}
			const cov2 = hit2 / total;
			if (cov2 >= 0.005 && cov2 <= 0.995) return { mask, method: 'corners', coverage: cov2 };
		}
	}
	return { mask: null, method: 'alpha', coverage: 0 };
}

/** Nearest-neighbor scale of a mask into new dimensions (returns same array when equal). */
function scaleMask(mask, sw, sh, dw, dh) {
	if (sw === dw && sh === dh) return mask;
	const out = new Uint8Array(dw * dh);
	for (let y = 0; y < dh; y++) {
		const sy = Math.min(sh - 1, (y * sh / dh) | 0);
		const srow = sy * sw, drow = y * dw;
		for (let x = 0; x < dw; x++) out[drow + x] = mask[srow + Math.min(sw - 1, (x * sw / dw) | 0)];
	}
	return out;
}

/**
 * Silhouette metrics between two masks of identical dimensions. IoU overall
 * plus per-region (3x3 grid over the combined bounding box, empty∩empty
 * counts as 1), aspect ratios from per-mask bboxes, and centroids in px and
 * — when the blueprint scale is known — model units.
 */
function silhouetteMetrics(refMask, shotMask, w, h, pxPerUnit) {
	let inter = 0, refArea = 0, shotArea = 0;
	let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
	let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
	let rcx = 0, rcy = 0, scx = 0, scy = 0;
	for (let y = 0; y < h; y++) {
		const rowOff = y * w;
		for (let x = 0; x < w; x++) {
			const i = rowOff + x;
			const r = refMask[i], s = shotMask[i];
			if (r) {
				refArea++; rcx += x; rcy += y;
				if (x < rx0) rx0 = x; if (x > rx1) rx1 = x;
				if (y < ry0) ry0 = y; if (y > ry1) ry1 = y;
			}
			if (s) {
				shotArea++; scx += x; scy += y;
				if (x < sx0) sx0 = x; if (x > sx1) sx1 = x;
				if (y < sy0) sy0 = y; if (y > sy1) sy1 = y;
			}
			if (r && s) inter++;
		}
	}
	const union = refArea + shotArea - inter;
	const iou = union > 0 ? inter / union : 1;
	const regionIou = () => {
		const bx0 = Math.min(rx0, sx0), by0 = Math.min(ry0, sy0);
		const bx1 = Math.max(rx1, sx1), by1 = Math.max(ry1, sy1);
		const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
		const regions = [];
		for (let gy = 0; gy < 3; gy++) {
			for (let gx = 0; gx < 3; gx++) {
				const cx0 = bx0 + Math.floor(gx * bw / 3), cx1 = bx0 + Math.ceil((gx + 1) * bw / 3);
				const cy0 = by0 + Math.floor(gy * bh / 3), cy1 = by0 + Math.ceil((gy + 1) * bh / 3);
				let ri = 0, ru = 0;
				for (let y = cy0; y < cy1 && y <= by1; y++) {
					for (let x = cx0; x < cx1 && x <= bx1; x++) {
						const r = refMask[y * w + x], s = shotMask[y * w + x];
						if (r && s) ri++;
						if (r || s) ru++;
					}
				}
				regions.push(ru > 0 ? ri / ru : 1);
			}
		}
		return regions;
	};
	const aspectOf = (x0, y0, x1, y1) => {
		const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
		return bh > 0 ? bw / bh : 0;
	};
	const u = (v) => (pxPerUnit && pxPerUnit > 0 ? +(v / pxPerUnit).toFixed(3) : null);
	const round2 = (v) => Math.round(v * 100) / 100;
	const aspectRef = aspectOf(rx0, ry0, rx1, ry1);
	const aspectShot = aspectOf(sx0, sy0, sx1, sy1);
	const refCentroid = refArea ? [rcx / refArea, rcy / refArea] : null;
	const shotCentroid = shotArea ? [scx / shotArea, scy / shotArea] : null;
	return {
		iou: +iou.toFixed(4),
		intersection: inter,
		union,
		ref_area: refArea,
		shot_area: shotArea,
		ref_area_units: u(Math.sqrt(refArea)),
		shot_area_units: u(Math.sqrt(shotArea)),
		ref_bbox: refArea ? [rx0, ry0, rx1, ry1] : null,
		shot_bbox: shotArea ? [sx0, sy0, sx1, sy1] : null,
		aspect_ref: round2(aspectRef),
		aspect_shot: round2(aspectShot),
		aspect_delta_pct: aspectRef > 0 ? Math.round((aspectShot - aspectRef) / aspectRef * 100) : null,
		centroid_ref_px: refCentroid ? [Math.round(refCentroid[0]), Math.round(refCentroid[1])] : null,
		centroid_shot_px: shotCentroid ? [Math.round(shotCentroid[0]), Math.round(shotCentroid[1])] : null,
		centroid_delta_px: (refCentroid && shotCentroid)
			? [Math.round(shotCentroid[0] - refCentroid[0]), Math.round(shotCentroid[1] - refCentroid[1])]
			: null,
		centroid_delta_units: (refCentroid && shotCentroid && pxPerUnit > 0)
			? [u(shotCentroid[0] - refCentroid[0]), u(shotCentroid[1] - refCentroid[1])]
			: null,
		regions: regionIou().map(round2),
	};
}

/** Format a metrics object into one compact, readable line. */
function describeMetrics(m) {
	if (!m) return '';
	const parts = [`iou ${m.iou}`];
	parts.push(`aspect ${m.aspect_ref}→${m.aspect_shot} (${m.aspect_delta_pct >= 0 ? '+' : ''}${m.aspect_delta_pct}%)`);
	if (m.centroid_delta_units) {
		parts.push(`centroid Δ[${m.centroid_delta_units[0]},${m.centroid_delta_units[1]}]u`);
	} else if (m.centroid_delta_px) {
		parts.push(`centroid Δ[${m.centroid_delta_px[0]},${m.centroid_delta_px[1]}]px`);
	}
	const worst = Math.min.apply(null, m.regions);
	parts.push(`weakest region ${worst}`);
	return parts.join(', ');
}

/**
 * Reference-image pinning mechanics (ticket #25 service layer). One image
 * per blueprint view, keyed by camera identity (preset id or explicit
 * position/target — the same camera semantics as screenshot_views). Stored
 * on the reload-surviving global handle so pins outlive a plugin reload;
 * the follow-on compare_views ticket reads this store. Callers own when to
 * pin/unpin; these helpers own only keying, decoding, and validation.
 */
function referenceStore() {
	if (!G.reference_images || typeof G.reference_images !== 'object') G.reference_images = {};
	return G.reference_images;
}

/** Canonical store key for one `view` (preset id string or {position,target}). */
function referenceViewKey(view) {
	const bp = normalizeBlueprintView(view, {});
	// Both halves are required: a one-sided object would pin under a
	// malformed key (pos(..)->tgt()), and the schema advertises the pair —
	// the bridge is the enforcement point (args are forwarded raw).
	if (bp.position && bp.target) {
		const fmt = (a) => (Array.isArray(a) ? a.map((n) => {
			if (typeof n !== 'number' || !isFinite(n)) throw new Error('Field "view" position/target must be finite numbers [x,y,z].');
			return String(n);
		}).join(',') : '');
		return `pos(${fmt(bp.position)})->tgt(${fmt(bp.target)})`;
	}
	if (typeof bp.presetName === 'string' && bp.presetName.trim() !== '') return `preset:${bp.presetName.trim()}`;
	throw new Error('Field "view" must be a camera preset id string or {position, target}.');
}

/** Sniff image bytes for a known container; returns the mime or null. */
function sniffImageMime(buf) {
	if (!buf || buf.length < 12) return null;
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
		buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return 'image/png';
	if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
	if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
	if (buf[0] === 0x42 && buf[1] === 0x4D) return 'image/bmp';
	if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
		buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
	return null;
}

const REFERENCE_MAX_BYTES = 32 * 1024 * 1024;
// Base64 expands 3 bytes into 4 chars: reject absurd payloads before decode.
const REFERENCE_MAX_B64 = 4 * Math.ceil(REFERENCE_MAX_BYTES / 3) + 8;

/** Normalize decoded bytes into a stored reference; throws naming "source" when undecodable. */
function toReferenceImage(buf, origin) {
	if (!buf || !buf.length) throw new Error(`Field "source" is not a decodable image${origin}: expected PNG/JPEG/GIF/BMP/WebP bytes.`);
	if (buf.length > REFERENCE_MAX_BYTES) throw new Error(`Field "source" image is too large${origin} (${buf.length} bytes, max ${REFERENCE_MAX_BYTES}).`);
	const mime = sniffImageMime(buf);
	if (!mime) throw new Error(`Field "source" is not a decodable image${origin}: expected PNG/JPEG/GIF/BMP/WebP bytes.`);
	const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
	return { data_url: `data:${mime};base64,${bytes.toString('base64')}`, mime, bytes: bytes.length };
}

/** Decode a base64 payload with a pre-decode length cap; null when not decodable. */
function decodeBase64Capped(b64) {
	const clean = String(b64).replace(/\s+/g, '');
	if (clean.length > REFERENCE_MAX_B64) {
		throw new Error(`Field "source" image is too large (inline image, max ${REFERENCE_MAX_BYTES} bytes).`);
	}
	// Buffer.from(str, 'base64') never throws (it skips invalid chars), so an
	// empty result is the only failure signal.
	const buf = Buffer.from(clean, 'base64');
	return buf.length ? buf : null;
}

/**
 * Resolve a `source` string into a stored reference. Accepts an inline
 * `data:image/...;base64,...` URL, raw base64, or (desktop app) a file path.
 * Returns null for an empty source (the unpin signal). Throws naming "source".
 */
function resolveReferenceSource(source) {
	if (typeof source !== 'string') throw new Error('Field "source" must be a string: an image file path, inline image data, or "" to unpin.');
	const src = source.trim();
	if (src === '') return null;
	if (/^data:/i.test(src)) {
		const m = src.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
		if (!m) throw new Error('Field "source" inline image must be a data:image/...;base64,... URL, raw base64, or a file path.');
		return toReferenceImage(decodeBase64Capped(m[2]), ' (inline image)');
	}
	// File path (desktop app): stat first so an oversized file fails before
	// it is read into memory; fall back to raw base64 below so a non-path
	// string still gets a precise undecodable error instead of ENOENT.
	let fileBytes = null, fileError = null;
	try {
		const fs = require('fs');
		const st = fs.statSync(src);
		if (!st.isFile()) throw Object.assign(new Error(`EISDIR: not a file, stat '${src}'`), { code: 'EISDIR' });
		if (st.size > REFERENCE_MAX_BYTES) throw new Error(`Field "source" image is too large (file ${src}, ${st.size} bytes, max ${REFERENCE_MAX_BYTES}).`);
		fileBytes = fs.readFileSync(src);
	} catch (e) { fileError = e; }
	if (fileError && /^Field "source" image is too large/.test(fileError.message)) throw fileError;
	if (fileBytes) return toReferenceImage(fileBytes, ` (file ${src})`);
	if (/^[A-Za-z0-9+/=\s]+$/.test(src) && src.replace(/\s+/g, '').length >= 16) {
		const buf = decodeBase64Capped(src);
		// A decodable-but-not-an-image payload keeps its precise error.
		if (buf) return toReferenceImage(buf, ' (inline image)');
	}
	const code = String((fileError && fileError.code) || (fileError && fileError.message) || '');
	if (/ENOENT|ENOTDIR/i.test(code)) {
		throw new Error(`Field "source" file not found: ${src}. Pass an existing image path or inline image data.`);
	}
	if (/EISDIR/i.test(code)) {
		throw new Error(`Field "source" is not a file: ${src}. Pass an image file path or inline image data.`);
	}
	if (/EACCES|EPERM/i.test(code)) {
		throw new Error(`Field "source" file is not readable: ${src}. Check permissions or pass inline image data.`);
	}
	throw new Error('Field "source" must be an existing image file path or inline image data (data:image/...;base64,... or raw base64).');
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
// Quality helpers: UV packing, box blur, region colours
// ---------------------------------------------------------------------------

/** Box-UV footprint of a cube in texture pixels: 2*(w+d) wide, (h+d) tall. */
function boxUVFootprint(cube) {
	const w = Math.ceil(Math.abs(cube.to[0] - cube.from[0]) + (cube.inflate ? 0 : 0));
	const h = Math.ceil(Math.abs(cube.to[1] - cube.from[1]));
	const d = Math.ceil(Math.abs(cube.to[2] - cube.from[2]));
	return { w: Math.max(1, 2 * (w + d)), h: Math.max(1, h + d) };
}

/**
 * Shelf-pack the box UV of the given cubes so no two share the same pixels.
 * Sets each cube's uv_offset and recomputes its 6 face UVs. Returns the used
 * extent so the caller can grow the texture if it overflowed.
 */
function packBoxUV(cubes, texW, pad) {
	pad = pad == null ? 1 : pad;
	const items = cubes
		.filter((c) => c instanceof Cube)
		.map((c) => ({ c, f: boxUVFootprint(c) }))
		.sort((a, b) => b.f.h - a.f.h); // tallest first packs tighter
	let x = 0, y = 0, rowH = 0, maxX = 0;
	for (const it of items) {
		if (x + it.f.w + pad > texW && x > 0) { x = 0; y += rowH + pad; rowH = 0; }
		it.c.box_uv = true;
		it.c.uv_offset = [x, y];
		if (it.c.mapAutoUV) it.c.mapAutoUV();
		x += it.f.w + pad;
		rowH = Math.max(rowH, it.f.h);
		maxX = Math.max(maxX, x);
	}
	return { packed: items.length, used: [maxX, y + rowH] };
}

/** In-place 3x3 box blur of a texture rect, blended by `amt` (0..1). The "smooth brush". */
function blurRect(ctx, rx, ry, rw, rh, amt) {
	if (rw < 2 || rh < 2 || amt <= 0) return;
	const src = ctx.getImageData(rx, ry, rw, rh);
	const s = src.data;
	const out = ctx.createImageData(rw, rh);
	const d = out.data;
	for (let y = 0; y < rh; y++) {
		for (let x = 0; x < rw; x++) {
			let R = 0, G = 0, B = 0, A = 0, N = 0;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx, yy = y + dy;
					if (xx < 0 || yy < 0 || xx >= rw || yy >= rh) continue;
					const i = (yy * rw + xx) * 4;
					R += s[i]; G += s[i + 1]; B += s[i + 2]; A += s[i + 3]; N++;
				}
			}
			const o = (y * rw + x) * 4;
			d[o] = clamp8(s[o] * (1 - amt) + (R / N) * amt);
			d[o + 1] = clamp8(s[o + 1] * (1 - amt) + (G / N) * amt);
			d[o + 2] = clamp8(s[o + 2] * (1 - amt) + (B / N) * amt);
			d[o + 3] = clamp8(s[o + 3] * (1 - amt) + (A / N) * amt);
		}
	}
	ctx.putImageData(out, rx, ry);
}

/**
 * Pick a base colour for a cube by name. `colorMap` is an array of
 * { match, color } where `match` is a regex source tested (case-insensitively)
 * against the cube name; first hit wins, else `base`.
 */
function regionColorFor(name, colorMap, base) {
	if (Array.isArray(colorMap)) {
		for (const rule of colorMap) {
			if (!rule || !rule.match || !rule.color) continue;
			try { if (new RegExp(rule.match, 'i').test(name)) return rule.color; } catch (e) {}
		}
	} else if (colorMap && typeof colorMap === 'object') {
		for (const key in colorMap) {
			try { if (new RegExp(key, 'i').test(name)) return colorMap[key]; } catch (e) {}
		}
	}
	return base;
}

// ---------------------------------------------------------------------------
// VFX texture generation — pixelated flames / energy / crystals / smoke, with
// optional multi-frame flipbook animation. The look: a bright hot core fading
// to cool edges in QUANTIZED colour bands (the pixel-art step look), jagged
// transparent edges, animated by scrolling/flickering value noise per frame.
// ---------------------------------------------------------------------------

const VFX_PALETTES = {
	fire:   ['#fff7da', '#ffe24a', '#ff9d2f', '#ff5a1f', '#b81e0c'],
	ember:  ['#fff0c0', '#ffb43a', '#ff6a1f', '#9c2a0c'],
	ice:    ['#ffffff', '#dcf4ff', '#8cd8ff', '#3aa6ff', '#1546c8'],
	frost:  ['#ffffff', '#e2f7ff', '#a6e2ff', '#5fb6ff'],
	energy: ['#ffffff', '#ccffff', '#5ff0ff', '#22b6ff', '#0a5fd6'],
	arcane: ['#ffffff', '#f0d0ff', '#c07bff', '#7a1fd0', '#380a66'],
	poison: ['#f2ffd6', '#b6ff5a', '#46c41e', '#176b12'],
	shadow: ['#cfa6ff', '#8a4af0', '#4a14a0', '#16052e'],
	holy:   ['#ffffff', '#fff4c0', '#ffd24a', '#ff9e1f'],
	smoke:  ['#e8e8e8', '#acacac', '#6c6c6c', '#343434'],
	blood:  ['#ff7a7a', '#e02020', '#9c0c0c', '#4a0606'],
	nature: ['#eaffc8', '#9fe05a', '#4faa2e', '#1f6b1a'],
};

function vfxHash(x, y, seed) {
	const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
	return n - Math.floor(n);
}
function vfxNoise(x, y, seed) {
	const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
	const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
	const a = vfxHash(xi, yi, seed), b = vfxHash(xi + 1, yi, seed);
	const c = vfxHash(xi, yi + 1, seed), e = vfxHash(xi + 1, yi + 1, seed);
	return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + e * u * v;
}
function vfxFractal(x, y, seed) {
	return vfxNoise(x, y, seed) * 0.6 + vfxNoise(x * 2.1, y * 2.1, seed + 5) * 0.3 + vfxNoise(x * 4.3, y * 4.3, seed + 11) * 0.1;
}

/**
 * Intensity field for a VFX style at pixel (px,py) in a w x h frame, at phase
 * t (0..1 across the flipbook) and a noise `seed`. Returns intensity 0..1, or
 * < 0 for a hard-transparent pixel (outside the shape).
 */
function vfxField(style, px, py, w, h, t, seed) {
	const u = w > 1 ? px / (w - 1) : 0.5;     // 0..1 left->right
	const v = h > 1 ? py / (h - 1) : 0.5;     // 0..1 top->bottom
	const xc = (u - 0.5) * 2;                  // -1..1
	const yc = (v - 0.5) * 2;                  // -1..1
	const r = Math.hypot(xc, yc);
	switch (style) {
		case 'flame': case 'fire': {
			const sway = (vfxFractal(t * 1.5 + 3, (1 - v) * 3, seed) - 0.5) * (1 - v) * 0.8;
			const cx = xc - sway;
			const halfW = 0.16 + v * 0.74;                 // narrow at top, wide at base
			const body = 1 - Math.abs(cx) / halfW;
			if (body <= 0) return -1;
			const turb = vfxFractal(u * 4, (1 - v) * 4 - t * 6, seed);
			const inten = body * (0.32 + 0.68 * v) * (0.55 + 0.8 * turb);
			if (inten < 0.2 + (1 - v) * 0.32) return -1;   // erode top into tongues
			return Math.min(1, inten);
		}
		case 'orb': case 'glow': {
			const inten = 1 - r;
			return inten <= 0 ? -1 : inten;
		}
		case 'energy': case 'plasma': {
			const ang = Math.atan2(yc, xc);
			const spikes = vfxFractal(ang / Math.PI * 7 + t * 4, r * 3 + t * 2, seed);
			const edge = 0.5 + spikes * 0.5;
			let inten = (edge - r) / edge;
			inten += Math.max(0, 0.35 - r) * 1.6;          // hot core
			return inten <= 0.06 ? -1 : Math.min(1, inten);
		}
		case 'spark': case 'star': {
			const ax = Math.abs(xc), ay = Math.abs(yc);
			const horiz = (1 - ax) * Math.max(0, 1 - ay * 6);
			const vert = (1 - ay) * Math.max(0, 1 - ax * 6);
			const diag = Math.max(0, 0.5 - r) * 0.8;
			const inten = Math.max(horiz, vert) + diag;
			return inten <= 0.08 ? -1 : Math.min(1, inten);
		}
		case 'smoke': case 'cloud': {
			const cloud = vfxFractal(u * 3 + t * 1.5, v * 3 - t, seed);
			const inten = cloud * (1 - r * 0.9) * 1.3;
			return inten <= 0.28 ? -1 : Math.min(1, inten);
		}
		case 'trail': case 'streak': {
			// head bright at the RIGHT (u=1), tapering to the left tail
			const widen = 0.12 + (1 - u) * 0.5;
			const line = 1 - Math.abs(yc) / widen;
			if (line <= 0) return -1;
			const dash = vfxFractal(u * 6 - t * 5, v * 2, seed);
			const inten = line * (0.2 + 0.9 * u) * (0.5 + dash);
			return inten <= 0.16 ? -1 : Math.min(1, inten);
		}
		case 'beam': case 'beam_v': {
			const dx = Math.abs(xc);
			const flick = 0.7 + vfxFractal(0, v * 5 - t * 6, seed) * 0.6;
			const inten = (1 - dx / 0.55) * flick;
			return inten <= 0.12 ? -1 : Math.min(1, inten);
		}
		case 'beam_h': {
			const dy = Math.abs(yc);
			const flick = 0.7 + vfxFractal(u * 5 - t * 6, 0, seed) * 0.6;
			const inten = (1 - dy / 0.55) * flick;
			return inten <= 0.12 ? -1 : Math.min(1, inten);
		}
		case 'bolt': case 'lightning': {
			const path = (vfxFractal(0, v * 6 + t * 4, seed) - 0.5) * 1.1;
			const dx = Math.abs(xc - path);
			const inten = 1 - dx / 0.16;
			return inten <= 0.15 ? -1 : Math.min(1, inten);
		}
		case 'rune': case 'ring': {
			const ringR = 0.7;
			const d = Math.abs(r - ringR);
			const inten = 1 - d / 0.18;
			return inten <= 0.12 ? -1 : Math.min(1, inten);
		}
		case 'crystal': case 'gem': {
			// opaque faceted diamond — for the body of an ice shard / gem
			const dist = Math.abs(xc) + Math.abs(yc);     // diamond
			if (dist > 1) return -1;
			const facet = Math.floor((1 - dist) * 4) / 4;
			const streak = (vfxFractal(u * 3, v * 4, seed) - 0.5) * 0.18;
			return Math.max(0, Math.min(1, 0.25 + facet * 0.85 + streak));
		}
		case 'shockwave': {
			const ringR = t * 0.95 + 0.05;
			const d = Math.abs(r - ringR);
			const inten = (1 - d / (0.12 + t * 0.1)) * (1 - t * 0.6);
			return inten <= 0.12 ? -1 : Math.min(1, inten);
		}
		default: {
			const inten = 1 - r;
			return inten <= 0 ? -1 : inten;
		}
	}
}

const VFX_OPAQUE = { crystal: true, gem: true };

/** Map intensity (1 = hottest core) to a quantized palette colour. */
function vfxColorAt(palette, inten) {
	const n = palette.length;
	let idx = Math.floor((1 - inten) * n);
	if (idx < 0) idx = 0; else if (idx >= n) idx = n - 1;
	return parseColor(palette[idx]);
}

/** Render one VFX frame into an existing ctx at (ox,oy), size w x h. */
function drawVfxFrame(ctx, ox, oy, w, h, style, palette, t, seed, opaque, softEdge) {
	const img = ctx.createImageData(w, h);
	const d = img.data;
	for (let py = 0; py < h; py++) {
		for (let px = 0; px < w; px++) {
			const inten = vfxField(style, px, py, w, h, t, seed);
			const o = (py * w + px) * 4;
			if (inten < 0) { d[o + 3] = 0; continue; }
			const c = vfxColorAt(palette, inten);
			d[o] = c.r; d[o + 1] = c.g; d[o + 2] = c.b;
			// Crisp pixel alpha by default; optionally fade the coolest band a little.
			d[o + 3] = opaque ? 255 : (softEdge && inten < 0.25 ? 150 : 255);
		}
	}
	ctx.putImageData(img, ox, oy);
}

/**
 * Build a VFX canvas. With frames>1 it stacks the frames vertically into a
 * Blockbench flipbook (height = h*frames; Blockbench shows one h-tall frame and
 * animates through them when TextureAnimator is running).
 */
function buildVfxCanvas(w, h, frames, style, palette, seed, softEdge) {
	const opaque = !!VFX_OPAQUE[style];
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h * Math.max(1, frames);
	const ctx = c.getContext('2d');
	ctx.imageSmoothingEnabled = false;
	for (let i = 0; i < Math.max(1, frames); i++) {
		const t = frames > 1 ? i / frames : 0;
		drawVfxFrame(ctx, 0, i * h, w, h, style, palette, t, seed, opaque, softEdge);
	}
	return c;
}

// ---------------------------------------------------------------------------
// Mesh primitives — non-cuboid geometry (crystals, blades, cones, prisms…) so
// models aren't limited to axis-aligned boxes. Faces come back as arrays of
// vertex indices (3 or 4 per face). Most shapes fill a [0..w/h/d] box; arc
// sweeps about the model origin instead (ring centres on a circle of radius
// w/2, cross-section spanning y 0..h and z 0..d), so from/origin do not box
// it the way they box the others.
// ---------------------------------------------------------------------------

function meshPrimitive(shape, w, h, d, segments, sweepDeg) {
	const n = Math.max(3, segments || 8);
	const verts = [];
	const faces = [];
	const V = (x, y, z) => { verts.push([x, y, z]); return verts.length - 1; };
	const cx = w / 2, cz = d / 2, rx = w / 2, rz = d / 2;
	switch (shape) {
		case 'plane': {
			const a = V(0, 0, 0), b = V(w, 0, 0), c = V(w, h, 0), e = V(0, h, 0);
			faces.push([a, b, c, e]);
			break;
		}
		case 'pyramid': {
			const b0 = V(0, 0, 0), b1 = V(w, 0, 0), b2 = V(w, 0, d), b3 = V(0, 0, d);
			const ap = V(cx, h, cz);
			faces.push([b3, b2, b1, b0]);                 // base (downward)
			faces.push([b0, b1, ap], [b1, b2, ap], [b2, b3, ap], [b3, b0, ap]);
			break;
		}
		case 'wedge': case 'prism': {
			const b0 = V(0, 0, 0), b1 = V(w, 0, 0), b2 = V(w, 0, d), b3 = V(0, 0, d);
			const t0 = V(0, h, cz), t1 = V(w, h, cz);
			faces.push([b3, b2, b1, b0]);                 // bottom
			faces.push([b0, b1, t1, t0]);                 // front slope (z=0)
			faces.push([b2, b3, t0, t1]);                 // back slope (z=d)
			faces.push([b0, b3, t0], [b2, b1, t1]);       // triangular end caps (x=0, x=w)
			break;
		}
		case 'octahedron': case 'crystal': case 'gem': case 'shard': case 'diamond': {
			const my = h * (shape === 'shard' ? 0.4 : 0.5);  // longer top point for a shard
			const top = V(cx, h, cz), bot = V(cx, 0, cz);
			const m0 = V(0, my, cz), m1 = V(cx, my, d), m2 = V(w, my, cz), m3 = V(cx, my, 0);
			faces.push([top, m0, m1], [top, m1, m2], [top, m2, m3], [top, m3, m0]);
			faces.push([bot, m1, m0], [bot, m2, m1], [bot, m3, m2], [bot, m0, m3]);
			break;
		}
		case 'cone': {
			const ap = V(cx, h, cz), center = V(cx, 0, cz);
			const ring = [];
			for (let i = 0; i < n; i++) {
				const a = (i / n) * Math.PI * 2;
				ring.push(V(cx + Math.cos(a) * rx, 0, cz + Math.sin(a) * rz));
			}
			for (let i = 0; i < n; i++) {
				const a = ring[i], b = ring[(i + 1) % n];
				faces.push([a, b, ap]);
				faces.push([b, a, center]);
			}
			break;
		}
		case 'cylinder': {
			const topC = V(cx, h, cz), botC = V(cx, 0, cz);
			const top = [], bot = [];
			for (let i = 0; i < n; i++) {
				const a = (i / n) * Math.PI * 2;
				const x = cx + Math.cos(a) * rx, z = cz + Math.sin(a) * rz;
				top.push(V(x, h, z)); bot.push(V(x, 0, z));
			}
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n;
				faces.push([bot[i], bot[j], top[j], top[i]]);  // side
				faces.push([top[j], top[i], topC]);            // top cap
				faces.push([bot[i], bot[j], botC]);            // bottom cap
			}
			break;
		}
		case 'arc': case 'sweep': case 'banana': case 'tube': {
			// Swept rectangle along a circular arc in the XZ plane — curved long
			// parts (banana magazines, curved swords, serpentine tubes, ram horns)
			// as ONE mesh instead of N edge-to-edge cubes (edge-to-edge segment
			// chains leave see-through slits; check_model's enclosed_hole catches
			// the leftover kind). Cross-section spans y=0..h and z=0..d, centred
			// on x; the sweep runs about the model origin. `segments` = arc
			// segments (default 8). Sweep direction: default +x start, positive
			// sweep turns towards +z; give a negative sweep (or rotate the mesh)
			// for the mirrored bend.
			const sweep = (sweepDeg == null ? 60 : Number(sweepDeg));
			const nseg = Math.max(1, n);
			const r = cx;                                   // sweep radius = half width
			const tube = Math.max(0.001, d / 2);            // half thickness (z span)
			const a0 = 0;                                   // start at +x
			const da = (sweep * Math.PI * 2) / 360 / nseg;
			const centerAt = (i) => [Math.cos(a0 + da * i) * r, Math.sin(a0 + da * i) * r];
			const ringAt = (i) => {
				const [px, py] = centerAt(i);
				const tx = -Math.sin(a0 + da * i), ty = Math.cos(a0 + da * i); // tangent
				const nx = -ty, nz = tx;                    // in-plane normal (xz plane: y here is z)
				return [
					V(px + nx * tube, 0, py + nz * tube),
					V(px - nx * tube, 0, py - nz * tube),
					V(px - nx * tube, h, py - nz * tube),
					V(px + nx * tube, h, py + nz * tube),
				];
			};
			const rings = [];
			for (let i = 0; i <= nseg; i++) rings.push(ringAt(i));
			const N = rings.length;
			// tube sides (winding verified via cross products at ring 0: underside
			// normal -y, topside +y, this one is the OUTER (convex) wall, the
			// next one the INNER (concave) wall)
			for (let i = 0; i < N - 1; i++) {
				const A = rings[i], B = rings[i + 1];
				faces.push([A[0], A[1], B[1], B[0]]);       // underside
				faces.push([A[3], B[3], B[2], A[2]]);       // topside
				faces.push([A[1], A[2], B[2], B[1]]);       // outer wall (convex side)
				faces.push([A[0], B[0], B[3], A[3]]);       // inner wall (concave side)
			}
			// flat end caps — sign-aware winding. The natural corner order
			// [0,1,2,3] always produces a normal along +tangent (verified by cross
			// product at ring 0), so for a POSITIVE sweep the natural order faces
			// INTO the tube at the start cap (outward = -travel) and the reversed
			// order faces INTO it at the end cap (outward = +travel). Without this
			// both caps render inside-out under single-sided rendering.
			const c0 = rings[0], cN = rings[N - 1];
			if (sweep >= 0) {
				faces.push([c0[3], c0[2], c0[1], c0[0]]);   // start: outward = -travel
				faces.push([cN[0], cN[1], cN[2], cN[3]]);   // end: outward = +travel
			} else {
				faces.push([c0[0], c0[1], c0[2], c0[3]]);   // start: outward = +travel
				faces.push([cN[3], cN[2], cN[1], cN[0]]);   // end: outward = -travel
			}
			break;
		}
		default:
			throw new Error('Unknown mesh shape: ' + shape + ' (plane|pyramid|wedge|prism|crystal|shard|cone|cylinder|arc)');
	}
	return { verts, faces };
}

/**
 * Planar-project a mesh face's UVs into a texture rect [x1,y1,x2,y2] (uv units).
 * Each face fills the rect by mapping its two dominant in-plane axes to u,v —
 * good enough for solid / gradient VFX skins without manual unwrapping.
 */
function setMeshFaceUV(mesh, face, rect) {
	const vk = face.vertices;
	const pos = vk.map((k) => mesh.vertices[k]);
	const e1 = [pos[1][0] - pos[0][0], pos[1][1] - pos[0][1], pos[1][2] - pos[0][2]];
	const p2 = pos[2] || pos[0];
	const e2 = [p2[0] - pos[0][0], p2[1] - pos[0][1], p2[2] - pos[0][2]];
	const nrm = [
		Math.abs(e1[1] * e2[2] - e1[2] * e2[1]),
		Math.abs(e1[2] * e2[0] - e1[0] * e2[2]),
		Math.abs(e1[0] * e2[1] - e1[1] * e2[0]),
	];
	let a = 0, b = 1;
	if (nrm[0] >= nrm[1] && nrm[0] >= nrm[2]) { a = 2; b = 1; }
	else if (nrm[1] >= nrm[0] && nrm[1] >= nrm[2]) { a = 0; b = 2; }
	else { a = 0; b = 1; }
	let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
	pos.forEach((pp) => {
		minA = Math.min(minA, pp[a]); maxA = Math.max(maxA, pp[a]);
		minB = Math.min(minB, pp[b]); maxB = Math.max(maxB, pp[b]);
	});
	const spanA = (maxA - minA) || 1, spanB = (maxB - minB) || 1;
	const uv = {};
	vk.forEach((k, i) => {
		uv[k] = [
			rect[0] + ((pos[i][a] - minA) / spanA) * (rect[2] - rect[0]),
			rect[1] + ((pos[i][b] - minB) / spanB) * (rect[3] - rect[1]),
		];
	});
	face.uv = uv;
}

// ---------------------------------------------------------------------------
// Modeling playbook (returned by get_guide / referenced by tool descriptions)
// ---------------------------------------------------------------------------

const MODELING_GUIDE = [
	'BLOCKBENCH MODELING PLAYBOOK — read before building any model. Other topics:',
	'get_guide {topic:"texturing"|"vfx"|"animation"|"reference"} for those workflows.',
	'',
	'GOLDEN WORKFLOW (loop it, do not one-shot):',
	'  get_status -> plan bones & proportions -> add_groups -> add_cubes',
	'  -> pack_uv -> create_texture -> detail_cubes -> paint_faces',
	'  -> screenshot_views (incl. the REFERENCE angle) -> check_model -> FIX -> repeat.',
	'Do at least 2-3 passes. The first pass is NEVER good enough — plan to redo it.',
	'',
	'1. SILHOUETTE FIRST. Build the grey shape and screenshot it from the reference',
	'   angle BEFORE texturing. A great texture cannot rescue wrong proportions. Match',
	'   the reference silhouette: overall stance, head size/position, limb length.',
	'',
	'2. PART COUNT & DETAIL. A good creature is 25-60+ cubes, not 6-8 boxes. Break',
	'   every limb into segments (upper/lower/foot), give the head a separate snout,',
	'   ears, brow, jaw. Add secondary forms (claws, teeth, tufts, plates). More,',
	'   smaller, overlapping parts = less blocky. Use add_cubes in bulk.',
	'',
	'3. ROTATION & TAPER make shapes organic. Cubes AND bones take rotation:[x,y,z].',
	'   - A single cube rotates cleanly on ONE axis; for a compound angle put it in a',
	'     GROUP and rotate the group, or nest groups. Build each limb as a bone at the',
	'     JOINT origin and rotate the bone to pose it.',
	'   - inflate (small +/-) rounds/shrinks a cube in place. Taper limbs by shrinking',
	'     each segment.',
	'   - A cube rotated 45° reads as a crystal/diamond/blade — use this for non-boxy',
	'     shapes in cube formats. For true non-cuboid shapes use add_mesh.',
	'',
	'3b. AVOID Z-FIGHTING / CLIPPING (the flickering "two squares inside one another").',
	'   It happens when two faces sit on the SAME plane at the same depth. Rules:',
	'   - When two cubes overlap, make one clearly PENETRATE the other (by >=0.1, ideally',
	'     ~0.5) so no faces are coplanar — never align two faces to the exact same coord.',
	'   - Decorative pieces (leaves, scales, plates, fur, trim) must NOT sit flush on a',
	'     surface: push each out by a small UNIQUE amount and stagger neighbours\' depths',
	'     so no two share a plane. Vary by 0.05-0.2 between adjacent pieces.',
	'   - Two billboard PLANES must never share the exact same position — offset by >=0.1.',
	'   - check_model reports `coplanar_overlap` pairs; fix every one by nudging a cube.',
	'',
	'3c. NO SEE-THROUGH GAPS. Adjacent parts must OVERLAP, never just touch. The classic',
	'   killers: handguard/fore-end meeting the barrel line edge-to-edge, a buttplate',
	'   short of the surface it caps, segmented curves (magazines, horns, tubes) built',
	'   as N cubes that meet at their edges, guard loops 1px thin. Rules:',
	'   - Segments of a curved long part: overlap each junction by >=0.5 units, or build',
	'     the whole part as ONE mesh — add_mesh {shape:"arc"} sweeps a rectangular',
	'     cross-section along a curve (banana magazines, curved swords, serpentine',
	'     tubes, horns) with `segments` for arc smoothness and negative sweep to mirror',
	'     the bend. One mesh > a chain of touching cubes.',
	'   - Caps and plates (buttplates, mag bases, iron sights) must extend past the',
	'     surface they cap on every side, not stop short of it.',
	'   - check_model reports `enclosed_hole` (background visible THROUGH the model —',
	'     gate error) and `detached_mass` (large empty region beside the main mass —',
	'     verify floating piece vs a legal opening like a trigger-guard window).',
	'',
	'4. SYMMETRY. Build one side, then mirror_element {axis:"x"} (or emit the mirror in',
	'   the same add_cubes call: negate X of from/to, swap so from<to, negate Y/Z',
	'   rotation signs). Keep paired bones named *_left / *_right.',
	'',
	'5. TEXTURE SMOOTH, not flat. pack_uv FIRST (box UV does not auto-pack), then',
	'   detail_cubes for a smooth shaded base on every face (no gaps), then paint_faces',
	'   for crisp features. See get_guide {topic:"texturing"}.',
	'',
	'6. REVIEW HONESTLY. screenshot_views every pass; check_model for untextured faces /',
	'   bad UVs / unparented cubes. If a screenshot looks wrong, FIX it — never call a',
	'   visible flaw "acceptable" or "close enough". See get_guide {topic:"reference"}.',
	'',
	'Animation formats (GeckoLib/Bedrock): every cube must live under a bone; bone',
	'origins must sit at the real joint. GeckoLib store id "geckolib", format',
	'"geckolib_model". Meshes do NOT export to GeckoLib/Java — use rotated cubes there.',
].join('\n');

const TEXTURING_GUIDE = [
	'BLOCKBENCH TEXTURING PLAYBOOK — the smooth, Hytale/@volmur look (not dirty/noisy).',
	'',
	'ORDER: pack_uv -> create_texture -> detail_cubes (smooth base) -> paint_faces',
	'(crisp features) -> get_texture to inspect -> fix.',
	'',
	'1. PACK UV FIRST. New box-UV cubes all sit at uv_offset [0,0] and share the same',
	'   pixels. Call pack_uv before painting and again after adding/resizing cubes, or',
	'   every face paints onto the same spot. It auto-grows the texture if needed.',
	'',
	'2. SIZE. 64px for simple, 128px typical, 256px for very detailed. Square.',
	'',
	'3. SMOOTH BASE COAT — detail_cubes. It bakes, per face: a soft vertical gradient in',
	'   the base colour + gentle directional shading (top lighter, underside darker) +',
	'   a SUBTLE low-contrast mottle, then a 3x3 box blur per UV island (the "smooth',
	'   brush"). This is the difference between good and bad textures. Tips:',
	'   - `smooth_bake` is the same recipe with snippet-faithful defaults (palette-first,',
	'     hard parts stay crisp) — prefer it for the standard bake; detail_cubes adds',
	'     streaks/edge-darkening knobs.',
	'   - Use the `colors` map to colour regions by cube name, e.g.',
	'     colors:[{match:"leg|paw",color:"#5a3d22"},{match:"belly",color:"#3a2a18"}].',
	'     Bodies/limbs are often the SAME tone as the head with darker extremities —',
	'     do not default everything to one brown.',
	'   - Keep noise LOW (0.04-0.08). Do NOT raise edge_darken (a dark outline on every',
	'     face reads as a dirty grid — the look to avoid). streaks:true adds fur/wood/',
	'     stone grain on top/back faces.',
	'   - Glow parts (eyes cores, gems, lanterns, runes): name them *_core or *_glow —',
	'     detail_cubes fills them bright with no shading/blur. Mark the texture emissive',
	'     with set_texture_render_mode for real in-engine glow.',
	'',
	'4. CRISP FEATURES — paint_faces, AFTER the bake (so blur does not soften them).',
	'   Coords are RELATIVE to each face ([0,0] = its top-left). Eyes are the #1 thing',
	'   that makes a creature read as alive: dark socket rect, bright iris, 1px hotspot.',
	'   Also nose, mouth, claws, stripes, scars, armour trim, rune lines. Ops: rect,',
	'   ellipse, polygon, line, gradient, dither (patterns), noise.',
	'',
	'5. INSPECT. get_texture shows the sheet; screenshot_views shows it on the model.',
	'   Compare to the reference palette. Recolour with detail_cubes `colors` and repeat.',
	'',
	'6. PIXEL-ART LOOK (flat quantized colour bands, no gradients) — smooth_bake',
	'   {style:"pixel"}: bakes flat brightness bands per face (bands: 1-8, default 3)',
	'   between the top-light and bottom-dark extremes, checkerboard-dithers band',
	'   boundaries, and SKIPS the mottle + blur that would smear the pixel grid. Use',
	'   bands:1 for pure flat fills; hard parts (*_cap/_base) skip the dither. Paint',
	'   features with paint_faces after, same as the smooth look.',
	'',
	'7. AUDIT THE PALETTE — audit_texture counts the SOURCE bitmap\'s unique colours',
	'   overall and per UV island (plus `quantized_unique`, a 16-level bucket count).',
	'   A clean sheet has few; a gradient/filter-smeared one has dozens of one-off',
	'   shades per face. Numbers, not vibes — if an island shows more colours than',
	'   your palette allows, re-bake it flat instead of eyeballing the screenshot.',
	].join('\n');

const VFX_GUIDE = [
	'BLOCKBENCH PIXEL-VFX PLAYBOOK — flames, energy, projectiles, slashes, trails, auras.',
	'The look: layered emissive PIXEL shapes, a bright hot core fading to cool edges,',
	'jagged stepped silhouettes, animated. Built from PLANES + emissive textures, posed',
	'and animated with bones. (Think the homegaddiel magma fire / a glowing ice shard.)',
	'',
	'CORE IDEA: a VFX is a few flat 2-sided PLANES carrying transparent emissive pixel',
	'textures, layered and crossed for volume, then animated (scale/position/rotation/',
	'flipbook). Bright additive layers stack into a glow.',
	'',
	'1. BUILD THE PLANES — add_plane {from,width,height,facing,crossed}. Make a flame/',
	'   energy sheet as 2-3 stacked planes at slightly different depths, or crossed:true',
	'   for a volumetric particle. Parent them to a bone so you can animate them.',
	'   For a solid glowing core (orb, gem, shard) use a small cube or add_mesh',
	'   {shape:"crystal"|"shard"} (or, in GeckoLib, a cube rotated 45°).',
	'',
	'2. MAKE THE TEXTURE — create_vfx_texture {style,preset,frames}. Styles: flame,',
	'   energy, orb/glow, spark/star, smoke, trail/streak, beam, bolt/lightning, ring,',
	'   shockwave, crystal. Presets (palettes): fire, ember, ice, frost, energy, arcane,',
	'   poison, shadow, holy, smoke, blood, nature. It defaults to ADDITIVE (flames/',
	'   energy) or EMISSIVE (crystals) render mode + 2-sided, so it glows. For a looping',
	'   animated effect set frames:4-8 — it bakes a vertical flipbook and starts the',
	'   animation player. Tune speed with frame_time (lower=faster).',
	'',
	'3. LAYER FOR DEPTH. Stack a wide dim outer glow + a brighter narrower mid + a small',
	'   white-hot core (3 planes, additive). Cooler/darker = bigger & behind; hotter =',
	'   smaller & in front. This is what makes pixel fire/energy look rich, not flat.',
	'',
	'4. EMISSIVE/ADDITIVE — set_texture_render_mode {render_mode:"additive"|"emissive",',
	'   render_sides:"double"}. additive = bright pixels add light & dark vanishes (best',
	'   for fire/energy on planes); emissive = full-bright, ignores scene light (solid',
	'   gems/runes). Always render_sides:"double" for planes.',
	'',
	'5. ANIMATE (the life of a VFX). Use create_animation + add_keyframes on the planes/',
	'   bones:',
	'   - FLICKER: small fast scale Y (1.0->1.15->0.95) + tiny position jitter, looped.',
	'   - PROJECTILE (ice shard / fireball): a solid core + a TRAIL. Trail = a row of',
	'     planes/cubes behind the core, each scaling down and fading (scale->0) on a',
	'     staggered delay so it streaks; or one "trail" plane stretched on the travel',
	'     axis. The whole group flies via position; spin the core (rotation) for energy.',
	'   - SLASH: an arc plane that sweeps (rotation) and quickly scales up then fades.',
	'   - BURST/IMPACT: a shockwave ring (style:"shockwave", or a ring plane scaling out',
	'     while fading) + outward spark planes.',
	'   Fade by scaling to 0 (GeckoLib has no opacity channel); flipbook frames also',
	'   carry motion. Use linear for snappy pops, catmullrom for smooth pulses.',
	'',
	'6. REVIEW with screenshot_views from a few angles and against the reference. Check',
	'   the core reads hottest, edges are jagged pixels (not smooth), and it glows.',
].join('\n');

const ANIMATION_GUIDE = [
	'BLOCKBENCH ANIMATION PLAYBOOK (GeckoLib/Bedrock).',
	'',
	'SETUP: create_animation {name,loop,length} then add_keyframes (bulk). Each keyframe:',
	'{bone, channel:"rotation"|"position"|"scale", time, value:[x,y,z], interpolation}.',
	'catmullrom = smooth; linear = snappy beats (a jaw snap, a slash); step = instant.',
	'',
	'ROTATION SIGN (verified): a bone +X rotation tilts its FRONT (-Z side) UP. To point',
	'a head/snout DOWN you need a NEGATIVE delta. Always preview the pose and confirm:',
	'  preview_pose {animation, time} then screenshot_views. Reset before saving:',
	'  Modes.options.edit.select(); Timeline.setTime(0).',
	'',
	'PRINCIPLES: overlap & follow-through (limbs lag the body), anticipation before a',
	'strike, ease in/out (catmullrom), and a held contact frame on impacts. Keep loops',
	'seamless: first and last keyframe identical.',
	'',
	'QUADRUPED walk (~1s, diagonal gait): FL+BR in phase, opposite FR+BL; upper legs ±25°',
	'on X; lower legs add a ~22° knee bend offset a quarter cycle; body Y bobs twice;',
	'slight neck nod & tail sway. Run = faster, bigger swing (±40°), body Y hops — NOT a',
	'front-pair/back-pair bound (reads as a march).',
	'',
	'HUMANOID: idle = small body-Y breathe + sway; walk = arms/legs swing opposite on X',
	'(left arm with right leg) ±25-35° + body bob; attack = wind one arm back then swing',
	'through with a torso twist; cast = raise arms, pulse glow *_core bones with scale.',
	'',
	'VFX animation: see get_guide {topic:"vfx"} — scale/position pulses, trails that',
	'scale to 0, spinning cores, sweeping slashes, expanding shockwaves.',
].join('\n');

const REFERENCE_GUIDE = [
	'MATCHING A REFERENCE — how to actually hit it, not "almost".',
	'',
	'Why models miss the reference: building too few/too boxy parts, skipping the',
	'silhouette check, and (the big one) RATIONALISING flaws after a screenshot instead',
	'of fixing them. Beat all three with discipline:',
	'',
	'1. READ THE REFERENCE FIRST. List concretely, in words: overall shape/stance;',
	'   head size & position; number and shape of limbs/appendages; key features (eyes,',
	'   horns, fins, runes); the colour palette (name ~5 colours); proportions (what is',
	'   biggest?). Build a part list from this BEFORE touching Blockbench.',
	'',
	'2. SILHOUETTE TO THE SAME ANGLE. Screenshot the grey model from the reference',
	'   camera (screenshot_views with explicit {position,target} if needed) and overlay',
	'   mentally. NOTE: models usually face -Z, so the "back" preset shows the FACE. Fix',
	'   shape until the silhouette matches. Only then texture.',
	'',
	'3. MATCH THE PALETTE. Pull the actual colours from the reference into detail_cubes',
	'   `colors` and paint_faces. Wrong hue/saturation is the most obvious miss.',
	'',
	'4. CRITICAL SELF-REVIEW EACH PASS — be your own harshest critic. For every',
	'   screenshot ask: does THIS specifically match the reference? Head too big? Neck',
	'   too long? Pose wrong? Colour off? Eyes misplaced? Write the differences down and',
	'   FIX them next pass. Do NOT write "looks great / close enough / acceptable" about',
	'   something you can see is off — that is the #1 cause of bad results.',
	'',
	'5. ITERATE 3-4 PASSES minimum. Compare to the reference, not to your last attempt.',
	'   Stop only when a side-by-side would convince the user, not just you.',
].join('\n');

const GUIDES = {
	modeling: MODELING_GUIDE,
	texturing: TEXTURING_GUIDE,
	vfx: VFX_GUIDE,
	animation: ANIMATION_GUIDE,
	reference: REFERENCE_GUIDE,
};

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

/**
 * execute_script structured errors (ticket #30 service layer).
 * The escape hatch stays debuggable: failures name the phase (compile vs
 * runtime), a 1-based line hint into the USER's `code` (offset-compensated
 * for the Function wrapper), and a truncated message. The raw multi-KB
 * stack never leaves the bridge payload — full diagnostics stay in the
 * Blockbench console via console.error at the throw site.
 *
 * Wrapper layout (hence EXEC_SCRIPT_LINE_OFFSET = 3):
 *   1: function anonymous(params,Blockbench
 *   2: ) {
 *   3: "use strict";
 *   4: <user line 1> ...
 * so userLine = reportedLine - 3 (clamped to >= 1).
 */
const EXEC_SCRIPT_MAX_CHARS = 2000;
const EXEC_SCRIPT_MAX_MESSAGE = 1000;
const EXEC_SCRIPT_LINE_OFFSET = 3;

function truncateText(s, max) {
	if (typeof s !== 'string') s = String(s == null ? '' : s);
	if (s.length <= max) return s;
	return s.slice(0, Math.max(0, max - 3)) + '...';
}

/**
 * First <anonymous>:LINE frame mapped into user lines. Returns null when
 * the stack carries no user frame (notably SyntaxError from `new Function`,
 * which V8 reports without a line).
 */
function executeScriptLineFromStack(stack) {
	if (typeof stack !== 'string' || !stack) return null;
	const re = /<anonymous>:(\d+):\d+/g;
	let m;
	while ((m = re.exec(stack)) !== null) {
		const reported = parseInt(m[1], 10);
		if (isNaN(reported)) continue;
		if (reported > EXEC_SCRIPT_LINE_OFFSET) return reported - EXEC_SCRIPT_LINE_OFFSET;
	}
	return null;
}

/**
 * Best-effort compile line: first 1-based prefix of `code` that fails to
 * compile. Works for localized errors (e.g. `const b = ;` on line 2 with a
 * valid line 1). Falls back to 1 when every prefix compiles (should not
 * happen for a real SyntaxError) or nothing compiles.
 */
function executeScriptCompileLine(code) {
	const lines = String(code == null ? '' : code).split('\n');
	// Bound the prefix scan so a huge script cannot turn one compile error
	// into thousands of extra compilations; beyond the cap fall back to 1.
	const capped = Math.min(lines.length, 500);
	for (let i = 1; i <= capped; i++) {
		const prefix = lines.slice(0, i).join('\n');
		try {
			new Function('params', 'Blockbench', '"use strict";\n' + prefix);
		} catch (e) {
			return i;
		}
	}
	return 1;
}

/**
 * Build the structured Error thrown for an execute_script failure.
 * Message shape (also the MCP-visible text): `execute_script <phase> error
 * at line <line>: <truncated message>`. Carries `.phase` / `.line` so the
 * HTTP layer can forward them as fields without the raw stack.
 */
function formatExecuteScriptError(err, phase, code) {
	const rawMessage = err && err.message != null ? String(err.message) : String(err);
	let line = executeScriptLineFromStack(err && err.stack);
	if (line == null && phase === 'compile') {
		try { line = executeScriptCompileLine(code); } catch (e) { line = 1; }
	}
	if (line == null) line = 1;
	if (!(line >= 1)) line = 1;
	const message = truncateText(rawMessage, EXEC_SCRIPT_MAX_MESSAGE);
	const out = new Error(
		truncateText('execute_script ' + phase + ' error at line ' + line + ': ' + message, EXEC_SCRIPT_MAX_CHARS)
	);
	out.phase = phase;
	out.line = line;
	return out;
}

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
		// A new project has never been checked: drop any gate remembered
		// from the previous project so save_project can't warn stale (ticket #23).
		G.lastGate = null;
		return commands.get_status().project;
	},

	close_project() {
		requireProject();
		if (Project.close) Project.close(true);
		// No open project left to vouch for: forget the last gate (ticket #23).
		G.lastGate = null;
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
				const result = { saved: true, path: Project.save_path || null };
				// Advisory done-gate warning (ticket #23): saving never blocks
				// on gate state. Warn only when a check has run and its most
				// recent gate did not pass; a passed gate or no prior check
				// yields no warning.
				if (G.lastGate && G.lastGate.gate_pass === false) {
					result.warning = `Done-gate failing: the most recent check_model reported ${G.lastGate.errors} error(s) (gate.gate_pass is false) — fix the reported errors before treating the model as done. The project was still saved.`;
				}
				resolve(result);
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
		const data = JSON.parse(content);
		// Codecs.project.load(model, file) sets up a fresh project from a .bbmodel
		// (the older .parse signature is what previously failed).
		Codecs.project.load(data, { path: p.path, content, name: p.path.split(/[\\/]/).pop() });
		Canvas.updateAll();
		// A freshly loaded project has never been checked: forget the gate
		// remembered from whatever was open before (ticket #23).
		G.lastGate = null;
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
	// With `dedupe_by_name`, a spec whose name matches an existing group (from
	// the project or earlier in the same batch) is updated in place instead of
	// creating a duplicate — retry-safe bulk creation; per-item results carry
	// `updated: true`. Without the flag, the legacy create-always path runs
	// exactly as before.
	add_groups(p) {
		requireProject();
		if (!Array.isArray(p.groups) || !p.groups.length) throw new Error('groups (array) is required');
		const dedupe = p.dedupe_by_name === true;
		// Pre-existing name matches get a property snapshot for Undo (the
		// outliner snapshot only covers tree structure + batch-created nodes).
		const undoGroups = dedupe
			? p.groups.map((s) => (s && typeof s === 'object') ? findGroup(s.name || 'group') : null).filter(Boolean)
			: [];
		Undo.initEdit(undoGroups.length ? { outliner: true, groups: undoGroups } : { outliner: true });
		const created = {};
		const out = [];
		let updatedCount = 0;
		for (const spec of p.groups) {
			let parent = null;
			if (spec.parent) {
				parent = created[spec.parent] || findGroup(spec.parent);
				if (!parent) throw new Error('Parent group not found: ' + spec.parent);
			}
			if (dedupe) {
				const name = spec.name || 'group';
				const existing = created[name] || findGroup(name);
				if (existing) {
					if (spec.origin) existing.origin = num3(spec.origin, existing.origin);
					if (spec.rotation) existing.rotation = num3(spec.rotation, existing.rotation);
					if (spec.parent !== undefined) existing.addTo(parent || 'root');
					created[name] = existing;
					const ser = serializeGroup(existing);
					ser.updated = true;
					out.push(ser);
					updatedCount++;
					continue;
				}
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
		if (!dedupe) return { created: out.length, groups: out };
		return { created: out.length - updatedCount, updated: updatedCount, groups: out };
	},

	// Build many cubes at once — the efficient way to author a detailed model.
	// With `dedupe_by_name`, a spec whose name matches an existing cube (from
	// the project or earlier in the same batch) is updated in place instead of
	// creating a duplicate — retry-safe bulk creation; per-item results carry
	// `updated: true`. Without the flag, the legacy create-always path runs
	// exactly as before.
	add_cubes(p) {
		requireProject();
		if (!Array.isArray(p.cubes) || !p.cubes.length) throw new Error('cubes (array) is required');
		const dedupe = p.dedupe_by_name === true;
		// Pre-existing name matches get a property snapshot for Undo (the
		// outliner snapshot only covers tree structure + batch-created cubes).
		const undoCubes = dedupe
			? p.cubes.map((s) => {
					if (!s || typeof s !== 'object') return null;
					const el = findElement(s.name || 'cube');
					return el instanceof Cube ? el : null;
				}).filter(Boolean)
			: [];
		Undo.initEdit(undoCubes.length ? { outliner: true, elements: undoCubes } : { outliner: true, elements: [] });
		const out = [];
		let updatedCount = 0;
		for (const spec of p.cubes) {
			const parent = spec.parent ? findGroup(spec.parent) : null;
			if (spec.parent && !parent) throw new Error('Parent group not found: ' + spec.parent);
			const from = num3(spec.from, [0, 0, 0]);
			const to = num3(spec.to, [from[0] + 1, from[1] + 1, from[2] + 1]);
			if (dedupe) {
				const name = spec.name || 'cube';
				const existing = findElement(name);
				if (existing && existing instanceof Cube) {
					if (spec.from !== undefined) existing.from = from;
					if (spec.to !== undefined) existing.to = to;
					if (spec.origin) existing.origin = num3(spec.origin, existing.origin);
					if (spec.rotation) existing.rotation = num3(spec.rotation, existing.rotation);
					if (spec.inflate !== undefined) existing.inflate = Number(spec.inflate);
					if (typeof spec.autouv === 'number') existing.autouv = spec.autouv;
					if (spec.box_uv !== undefined) existing.box_uv = !!spec.box_uv;
					if (Array.isArray(spec.uv_offset)) existing.uv_offset = spec.uv_offset;
					if (spec.parent !== undefined) existing.addTo(parent || 'root');
					if (spec.faces) applyFaces(existing, spec.faces);
					const ser = serializeElement(existing);
					ser.updated = true;
					out.push(ser);
					updatedCount++;
					continue;
				}
			}
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
		if (!dedupe) return { created: out.length, cubes: out };
		return { created: out.length - updatedCount, updated: updatedCount, cubes: out };
	},

	// Shelf-pack box UVs so every cube gets its own region (box-UV cubes are all
	// created at uv_offset [0,0] and otherwise share the same pixels). REQUIRED
	// before texturing a box_uv model, and re-run after adding/resizing cubes.
	// Grows the texture (preserving any paint) if the layout overflows.
	pack_uv(p) {
		requireProject();
		let cubes;
		const sel = resolveScope(p);
		if (sel.mode === 'all') cubes = Cube.all.slice();
		else if (sel.mode === 'selected') cubes = sel.refs.map(findElement).filter((c) => c instanceof Cube);
		else if (!p.cubes || p.cubes === 'all') cubes = Cube.all.slice();
		else cubes = toList(p.cubes).map(findElement).filter((c) => c instanceof Cube);
		if (!cubes.length) throw new Error('No cubes to pack.');
		const pad = p.padding != null ? p.padding | 0 : 1;
		Undo.initEdit({ elements: cubes, uv_only: true });
		let res = packBoxUV(cubes, Project.texture_width, pad);
		if (p.auto_resize !== false && res.used[1] > Project.texture_height) {
			let newH = Project.texture_height || 16;
			while (newH < res.used[1]) newH *= 2;
			const newW = Project.texture_width;
			Project.texture_height = newH;
			Texture.all.forEach((t) => {
				const c = document.createElement('canvas');
				c.width = newW; c.height = newH;
				const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
				if (t.img) { try { x.drawImage(t.img, 0, 0); } catch (e) {} }
				t.updateSource(c.toDataURL()); t.width = newW; t.height = newH;
			});
			res = packBoxUV(cubes, newW, pad);
			updateProjectResolution && updateProjectResolution();
		}
		Undo.finishEdit('MCP: pack UV');
		Canvas.updateAll();
		return { packed: res.packed, used: res.used, texture_size: [Project.texture_width, Project.texture_height] };
	},

	// Create a flat 2-sided plane (billboard) — the building block of pixel VFX:
	// flames, energy sheets, slashes, motion trails. Implemented as a zero-depth
	// cube whose two large faces share the texture; set the VFX texture's
	// render_sides to 'double' so it shows from both sides. `crossed` makes an
	// X of two perpendicular planes for a volumetric particle look.
	add_plane(p) {
		requireProject();
		const parent = p.parent ? findGroup(p.parent) : null;
		if (p.parent && !parent) throw new Error('Parent group not found: ' + p.parent);
		const from = num3(p.from, [0, 0, 0]);
		const facing = (p.facing || 'z').toLowerCase();
		const W = p.width != null ? Number(p.width) : 16;
		const H = p.height != null ? Number(p.height) : 16;
		const tex = p.texture ? findTexture(p.texture) : (Texture.getDefault ? Texture.getDefault() : Texture.all[0]);
		const bigFaces = facing === 'x' ? ['east', 'west'] : facing === 'y' ? ['up', 'down'] : ['north', 'south'];
		const dims = () => {
			if (facing === 'z') return [from[0] + W, from[1] + H, from[2]];
			if (facing === 'x') return [from[0], from[1] + H, from[2] + W];
			return [from[0] + W, from[1], from[2] + H]; // y-facing (flat horizontal): W x H on x/z
		};
		const buildOne = (f, t, name, rot) => {
			const cube = new Cube({
				name: name || (p.name || 'plane'),
				from: f, to: t,
				origin: num3(p.origin, [(f[0] + t[0]) / 2, (f[1] + t[1]) / 2, (f[2] + t[2]) / 2]),
				rotation: num3(rot || p.rotation, [0, 0, 0]),
				box_uv: false, autouv: 1,
			}).init();
			cube.addTo(parent || 'root');
			if (tex) {
				for (const dir in cube.faces) {
					const face = cube.faces[dir];
					if (!face) continue;
					if (bigFaces.indexOf(dir) >= 0) { face.texture = tex.uuid; face.uv = [0, 0, Project.texture_width, Project.texture_height]; }
					else { face.texture = null; face.uv = [0, 0, 0, 0]; }
				}
			}
			return cube;
		};
		Undo.initEdit({ outliner: true, elements: [] });
		const made = [];
		const to = dims();
		made.push(buildOne(from, to, p.name || 'plane'));
		if (p.crossed) {
			// second plane perpendicular to the first, same centre
			const cxv = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
			let f2, t2, big2;
			if (facing === 'z') { f2 = [cxv[0], from[1], from[2] - W / 2]; t2 = [cxv[0], to[1], from[2] + W / 2]; }
			else if (facing === 'x') { f2 = [from[0] - W / 2, from[1], cxv[2]]; t2 = [from[0] + W / 2, to[1], cxv[2]]; }
			else { f2 = [cxv[0], from[1], from[2]]; t2 = [cxv[0], to[1], to[2]]; }
			const c2 = buildOne(f2, t2, (p.name || 'plane') + '_x');
			made.push(c2);
		}
		Undo.finishEdit('MCP: add plane');
		Canvas.updateAll();
		return { created: made.length, planes: made.map(serializeElement) };
	},

	// Create a non-cuboid MESH primitive (crystal/gem/shard, pyramid, wedge,
	// cone, cylinder, plane) so models aren't limited to axis-aligned boxes —
	// great for crystals, blades, horns, teeth, gems and stylised VFX cores.
	// Requires a mesh-capable format (free/generic/bedrock); GeckoLib/Java export
	// cubes only, so for those build crystals from rotated cubes instead.
	add_mesh(p) {
		requireProject();
		if (typeof Mesh === 'undefined') throw new Error('Meshes are not available in this Blockbench build.');
		if (Format && Format.meshes === false) throw new Error('Current format does not support meshes. Use a free/generic project, or build the shape from rotated cubes.');
		const parent = p.parent ? findGroup(p.parent) : null;
		if (p.parent && !parent) throw new Error('Parent group not found: ' + p.parent);
		const shape = (p.shape || 'crystal').toLowerCase();
		const size = num3(p.size, [8, 8, 8]);
		const from = num3(p.from, [-size[0] / 2, 0, -size[2] / 2]);
		const prim = meshPrimitive(shape, size[0], size[1], size[2], p.segments, p.sweep);
		const tex = p.texture ? findTexture(p.texture) : (Texture.getDefault ? Texture.getDefault() : Texture.all[0]);
		const uvRect = Array.isArray(p.uv) ? p.uv : [0, 0, Project.texture_width, Project.texture_height];
		Undo.initEdit({ outliner: true, elements: [] });
		const mesh = new Mesh({
			name: p.name || shape,
			origin: num3(p.origin, [from[0] + size[0] / 2, from[1] + size[1] / 2, from[2] + size[2] / 2]),
			rotation: num3(p.rotation, [0, 0, 0]),
		});
		const keys = prim.verts.map((v) => mesh.addVertices([from[0] + v[0], from[1] + v[1], from[2] + v[2]])[0]);
		prim.faces.forEach((face) => {
			const f = new MeshFace(mesh, { vertices: face.map((i) => keys[i]) });
			if (tex) f.texture = tex.uuid;
			mesh.addFaces(f);
			setMeshFaceUV(mesh, f, uvRect);
		});
		mesh.init().addTo(parent || 'root');
		Undo.finishEdit('MCP: add mesh');
		Canvas.updateAll();
		return { uuid: mesh.uuid, name: mesh.name, type: 'mesh', shape, vertices: Object.keys(mesh.vertices).length, faces: Object.keys(mesh.faces).length };
	},

	// Mirror a cube or group across an axis about a pivot (default x=0) — build
	// one side, then mirror it for perfect symmetry. Returns the clones.
	mirror_element(p) {
		requireProject();
		const axis = ({ x: 0, y: 1, z: 2 })[(p.axis || 'x').toLowerCase()];
		const pivot = p.pivot != null ? Number(p.pivot) : 0;
		const targets = (p.elements ? toList(p.elements) : [p.element]).map(findNode).filter(Boolean);
		if (!targets.length) throw new Error('No element(s) found to mirror.');
		Undo.initEdit({ outliner: true, elements: [] });
		const out = [];
		const reflect = (v) => { const r = v.slice(); r[axis] = 2 * pivot - r[axis]; return r; };
		const cloneCube = (cube, parent) => {
			const f = reflect(cube.from), t = reflect(cube.to);
			const lo = f.slice(), hi = t.slice();
			if (lo[axis] > hi[axis]) { const tmp = lo[axis]; lo[axis] = hi[axis]; hi[axis] = tmp; }
			const rot = cube.rotation.slice();
			// flip the two rotation components not on the mirror axis
			[0, 1, 2].forEach((i) => { if (i !== axis) rot[i] = -rot[i]; });
			const c = new Cube({
				name: cube.name.replace(/left/i, 'right').replace(/_l$/i, '_r') + (/(left|_l$|right|_r$)/i.test(cube.name) ? '' : '_m'),
				from: lo, to: hi, origin: reflect(cube.origin), rotation: rot,
				inflate: cube.inflate, box_uv: cube.box_uv, uv_offset: cube.uv_offset ? cube.uv_offset.slice() : undefined,
			}).init();
			c.addTo(parent || 'root');
			for (const dir in cube.faces) { if (c.faces[dir] && cube.faces[dir]) c.faces[dir].texture = cube.faces[dir].texture; }
			return c;
		};
		targets.forEach((el) => {
			if (el instanceof Group) {
				const ng = new Group({ name: el.name.replace(/left/i, 'right'), origin: reflect(el.origin), rotation: el.rotation.map((r, i) => i === axis ? r : -r) }).init();
				ng.addTo(el.parent && el.parent !== 'root' ? el.parent : 'root');
				el.children.forEach((ch) => { if (ch instanceof Cube) cloneCube(ch, ng); });
				out.push(serializeGroup(ng));
			} else if (el instanceof Cube) {
				out.push(serializeElement(cloneCube(el, el.parent && el.parent !== 'root' ? el.parent : 'root')));
			}
		});
		Undo.finishEdit('MCP: mirror');
		Canvas.updateAll();
		return { created: out.length, elements: out };
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

	// Bulk edit: one call applies a batch of element patches. Each item
	// resolves by name-or-UUID exactly like edit_element (including 'root'
	// parent semantics) and reports its own ok/error so one bad reference
	// never voids the batch.
	edit_elements(p) {
		requireProject();
		if (!Array.isArray(p.edits) || !p.edits.length) throw new Error('edits (array) is required');
		// Snapshot cubes upfront so Undo restores geometry/property changes
		// (outliner:true alone only covers tree structure; mirrors the
		// single-form {elements:[el]}/{group:el} coverage for bulk).
		const undoCubes = [];
		for (const item of p.edits) {
			const ref = item && (item.element || item.uuid || item.name);
			const el = ref ? findNode(ref) : null;
			if (el && !(el instanceof Group) && undoCubes.indexOf(el) < 0) undoCubes.push(el);
		}
		Undo.initEdit({ outliner: true, elements: undoCubes });
		const results = [];
		let edited = 0;
		for (const item of p.edits) {
			const ref = item && (item.element || item.uuid || item.name);
			try {
				if (!ref) throw new Error('Each edit needs `element` (uuid or name).');
				const el = findNode(ref);
				if (!el) throw new Error('Element not found: ' + ref);
				const patch = (item.patch && typeof item.patch === 'object') ? item.patch : {};
				// Validate parent existence BEFORE mutating, so a not-found
				// parent leaves the element untouched (per-item isolation).
				let parent = null, reparent = false;
				if (patch.parent !== undefined) {
					reparent = true;
					parent = patch.parent === 'root' ? 'root' : findGroup(patch.parent);
					if (patch.parent !== 'root' && !parent) throw new Error('Parent group not found: ' + patch.parent);
				}
				const isGroup = el instanceof Group;
				if (patch.new_name !== undefined) el.name = patch.new_name;
				if (patch.origin) el.origin = num3(patch.origin, el.origin);
				if (patch.rotation) el.rotation = num3(patch.rotation, el.rotation);
				if (!isGroup) {
					if (patch.from) el.from = num3(patch.from, el.from);
					if (patch.to) el.to = num3(patch.to, el.to);
					if (patch.inflate !== undefined) el.inflate = Number(patch.inflate);
				}
				if (patch.visibility !== undefined) el.visibility = !!patch.visibility;
				if (reparent) el.addTo(parent);
				edited++;
				results.push({ element: ref, ok: true, result: isGroup ? serializeGroup(el) : serializeElement(el) });
			} catch (e) {
				results.push({ element: ref || null, ok: false, error: e && e.message ? e.message : String(e) });
			}
		}
		Undo.finishEdit('MCP: edit elements');
		Canvas.updateAll();
		return { edited, failed: results.length - edited, results };
	},

	// Bulk delete: one call deletes a batch of elements. Each reference
	// resolves by name-or-UUID exactly like delete_element and reports its
	// own ok/error so one bad reference never voids the batch.
	delete_elements(p) {
		requireProject();
		const refs = Array.isArray(p.elements) ? p.elements : null;
		if (!refs || !refs.length) throw new Error('elements (array) is required');
		// Snapshot cubes upfront so Undo restores deleted cubes (mirrors the
		// single-form {elements:[el]} coverage for bulk; outliner:true covers groups/tree).
		const undoCubes = [];
		for (const ref of refs) {
			const el = ref ? findNode(ref) : null;
			if (el && !(el instanceof Group) && undoCubes.indexOf(el) < 0) undoCubes.push(el);
		}
		Undo.initEdit({ outliner: true, elements: undoCubes });
		const results = [];
		let deleted = 0;
		for (const ref of refs) {
			try {
				if (!ref) throw new Error('Each entry needs an element uuid or name.');
				const el = findNode(ref);
				if (!el) throw new Error('Element not found: ' + ref);
				el.remove(false);
				deleted++;
				results.push({ element: ref, ok: true, deleted: true });
			} catch (e) {
				results.push({ element: ref || null, ok: false, error: e && e.message ? e.message : String(e) });
			}
		}
		Undo.finishEdit('MCP: delete elements');
		Canvas.updateAll();
		return { deleted, failed: results.length - deleted, results };
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

	// Filtered, paged element lookup (ticket #24): find edit/measure targets on
	// large models without dumping the whole outliner. Filters apply first
	// (regex on name, direct-parent group), then pagination slices the matches;
	// `total` is always the pre-pagination match count so clients can page
	// honestly. Refs are {name, uuid} usable verbatim as element refs in
	// edit_element/edit_elements/delete_element(s)/measure. list_outliner stays
	// untouched as the legacy full dump.
	query_elements(p) {
		requireProject();
		// Universe: every outliner node (groups AND elements) in tree order.
		const nodes = [];
		if (Array.isArray(Outliner.root) && Outliner.root.length) {
			(function walk(list) {
				for (const n of list || []) {
					if (!n) continue;
					nodes.push(n);
					if (typeof Group !== 'undefined' && n instanceof Group) walk(n.children);
				}
			})(Outliner.root);
		} else {
			// Fallback for runtimes without Outliner.root: flat union, no recursion
			// (Group.all already contains nested groups).
			for (const g of (typeof Group !== 'undefined' && Group.all ? Group.all : [])) nodes.push(g);
			for (const e of (Outliner.elements || [])) nodes.push(e);
		}
		let matches = nodes;
		if (p.regex != null) {
			if (typeof p.regex !== 'string') throw new Error('Field "regex" must be a string.');
			let re;
			try {
				re = new RegExp(p.regex, 'i');
			} catch (e) {
				throw new Error('Field "regex" is not a valid regular expression: ' + (e && e.message ? e.message : e));
			}
			matches = matches.filter((n) => re.test(n.name || ''));
		}
		if (p.parent != null) {
			if (typeof p.parent !== 'string') throw new Error('Field "parent" must be a string.');
			const g = findGroup(p.parent);
			if (!g) throw new Error('Field "parent" not found: ' + p.parent);
			// Identity match covers live Blockbench; the uuid fallback covers
			// cross-realm/stub copies of the same group object.
			matches = matches.filter((n) => n.parent === g || (n.parent && n.parent !== 'root' && n.parent.uuid === g.uuid));
		}
		const total = matches.length;
		let offset = 0;
		if (p.offset != null) {
			offset = p.offset;
			if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw new Error('Field "offset" must be a non-negative integer.');
		}
		let limit = Infinity;
		if (p.limit != null) {
			limit = p.limit;
			if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) throw new Error('Field "limit" must be a positive integer.');
		}
		const refs = matches
			.slice(offset)
			.slice(0, limit)
			.map((n) => ({ name: n.name, uuid: n.uuid }));
		return { refs, total, offset };
	},

	// Measure verifiable dimensions in model units with named axes.
	// Modes: element (one cube), group (group/bone including children),
	// model (overall dims, no manual aggregation), distance (gap between two
	// refs `a`/`b`), clearance (coplanar-overlap scan with audit thresholds).
	// Boxes are the axis-aligned union of cube from/to; rotation is not expanded.
	measure(p) {
		requireProject();
		const mode = p.mode;
		if (!mode) throw new Error('Field "mode" is required (element|group|model|distance|clearance).');
		if (mode === 'element') {
			const ref = p.element;
			if (!ref) throw new Error('Field "element" (name|uuid) is required for mode "element".');
			const el = findElement(ref);
			if (!el) throw new Error('Field "element" not found: ' + ref);
			if (typeof Group !== 'undefined' && el instanceof Group)
				throw new Error('Field "element" is a group; use mode "group" with field "group".');
			if (!Array.isArray(el.from) || !Array.isArray(el.to))
				throw new Error('Field "element" has no bounding box: ' + ref);
			const box = bboxOfCubes([el]);
			return Object.assign(
				{ mode: 'element', units: 'model', element: { name: el.name, uuid: el.uuid }, cube_count: 1 },
				box
			);
		}
		if (mode === 'group') {
			const ref = p.group;
			if (!ref) throw new Error('Field "group" (name|uuid) is required for mode "group".');
			const g = findGroup(ref);
			if (!g) throw new Error('Field "group" not found: ' + ref);
			const cubes = collectGroupCubes(g);
			if (!cubes.length) throw new Error('Field "group" has no measurable cubes: ' + ref);
			const box = bboxOfCubes(cubes);
			return Object.assign(
				{
					mode: 'group', units: 'model',
					group: { name: g.name, uuid: g.uuid },
					cube_count: cubes.length, cubes: cubes.map((c) => ({ name: c.name, uuid: c.uuid })),
				},
				box
			);
		}
		if (mode === 'model') {
			const cubes = Cube.all.slice();
			const groups = typeof Group !== 'undefined' ? Group.all.length : 0;
			const box = bboxOfCubes(cubes);
			if (!box) {
				return {
					mode: 'model', units: 'model', cube_count: 0, group_count: groups,
					min: null, max: null, size: namedVec([0, 0, 0]), center: null,
				};
			}
			return Object.assign(
				{ mode: 'model', units: 'model', cube_count: cubes.length, group_count: groups },
				box
			);
		}
		if (mode === 'distance') {
			const ra = measurableBox(p.a, 'a');
			const rb = measurableBox(p.b, 'b');
			const gap = {}, delta = {};
			let sumSq = 0;
			AXES.forEach((ax) => {
				const aMin = ra.box.min[ax], aMax = ra.box.max[ax];
				const bMin = rb.box.min[ax], bMax = rb.box.max[ax];
				const g = Math.max(0, Math.max(aMin, bMin) - Math.min(aMax, bMax));
				gap[ax] = g;
				sumSq += g * g;
				delta[ax] = rb.box.center[ax] - ra.box.center[ax];
			});
			const overlapping = gap.x === 0 && gap.y === 0 && gap.z === 0;
			return {
				mode: 'distance', units: 'model',
				a: { name: ra.node.name, uuid: ra.node.uuid, kind: ra.kind },
				b: { name: rb.node.name, uuid: rb.node.uuid, kind: rb.kind },
				a_box: { min: ra.box.min, max: ra.box.max },
				b_box: { min: rb.box.min, max: rb.box.max },
				gap, delta,
				distance: Math.sqrt(sumSq),
				overlapping,
			};
		}
		if (mode === 'clearance') {
			const pairs = clearanceOverlaps();
			return {
				mode: 'clearance', units: 'model',
				coplanar_epsilon: COPLANAR_EPS, overlap_min: OVERLAP_MIN,
				scanned_cubes: Cube.all.filter(isUnrotatedCube).length,
				overlap_count: pairs.length,
				overlaps: pairs.map((e) => ({
					cubes: [e.a.name, e.b.name],
					axis: e.axis, plane: e.plane, gap: e.gap, overlap: e.overlap,
					hint: 'faces coplanar -> z-fight; offset one cube by >=0.1 on this axis',
				})),
			};
		}
		throw new Error('Field "mode" must be one of "element", "group", "model", "distance", "clearance" (got ' + JSON.stringify(mode) + ').');
	},

	// Audit the model for common problems that make results look broken: faces
	// with no texture (the untextured "gaps"), zero-area or out-of-bounds UVs,
	// degenerate cube sizes, and (for animated formats) cubes not parented to a
	// bone. Run this before screenshotting to fix issues proactively.
	//
	// Each issue may carry a structured `fix` patch {element, issue, tool, fix}:
	// `tool` names an existing tool and `fix` is directly usable as that tool's
	// arguments. Patches are PROPOSALS ONLY — nothing is auto-applied. When no
	// safe patch can be derived (zero-area UVs, ambiguous texture/bone choice),
	// `fix` is omitted rather than guessed. Fixes per kind:
	// - coplanar_overlap: nudge the second cube by OVERLAP_MIN on the reported
	//   axis via edit_elements (batch form, one edit). NOTE: full-state
	//   from/to patches don't compose across issues sharing a cube — before
	//   any auto-apply follow-up, accumulate per-cube deltas instead.
	// - no_texture: assign the project's single texture to just the flagged face
	//   via set_cube_uv (per-face, so other faces keep their textures).
	// - uv_out_of_bounds: clamp the UV rect into [0..tw, 0..th] via set_cube_uv,
	//   skipped when the clamp would itself be degenerate.
	// - degenerate_size: restore a 1-unit extent on the flagged axis via
	//   edit_element (full from/to so the patch is self-contained).
	// - no_bone_parent: attach to the project's single bone via edit_element.
	//
	// The top level also carries `gate: {errors, warnings, gate_pass}` from
	// summarizeGate (ticket #22): errors = degenerate_size + zero_uv +
	// uv_out_of_bounds + coplanar_overlap, warnings = no_texture +
	// no_bone_parent, gate_pass true iff errors == 0. `issues`/`by_type`/
	// `issue_count` are unchanged; `gate` is purely additive.
	check_model(p) {
		requireProject();
		const tw = Project.texture_width, th = Project.texture_height;
		const animMode = !!(Format && Format.animation_mode);
		const singleTexture = Texture.all.length === 1 ? (Texture.all[0].name || Texture.all[0].uuid) : null;
		const singleBone = Group.all.length === 1 ? (Group.all[0].name || Group.all[0].uuid) : null;
		const issues = [];
		Cube.all.forEach((cube) => {
			for (const dir in cube.faces) {
				const f = cube.faces[dir];
				if (!f) continue;
				if (!f.texture) {
					const issue = { cube: cube.name, face: dir, issue: 'no_texture' };
					if (singleTexture)
						issue.fix = {
							element: cube.name, issue: 'no_texture', tool: 'set_cube_uv',
							fix: { cube: cube.name, faces: { [dir]: { texture: singleTexture } } },
						};
					issues.push(issue);
				}
				const u = f.uv || [0, 0, 0, 0];
				const w = Math.abs(u[2] - u[0]), h = Math.abs(u[3] - u[1]);
				if (w <= 0 || h <= 0) {
					// Zero-area UV: no safe region to derive, patch stays omitted.
					issues.push({ cube: cube.name, face: dir, issue: 'zero_uv', uv: u });
				}
				else if (Math.max(u[0], u[2]) > tw + 0.01 || Math.max(u[1], u[3]) > th + 0.01 ||
					Math.min(u[0], u[1], u[2], u[3]) < -0.01) {
					const issue = { cube: cube.name, face: dir, issue: 'uv_out_of_bounds', uv: u };
					const x1 = Math.min(Math.max(u[0], 0), tw), y1 = Math.min(Math.max(u[1], 0), th);
					const x2 = Math.min(Math.max(u[2], 0), tw), y2 = Math.min(Math.max(u[3], 0), th);
					if (Math.abs(x2 - x1) > 0 && Math.abs(y2 - y1) > 0)
						issue.fix = {
							element: cube.name, issue: 'uv_out_of_bounds', tool: 'set_cube_uv',
							fix: { cube: cube.name, faces: { [dir]: { uv: [x1, y1, x2, y2] } } },
						};
					issues.push(issue);
				}
			}
			const s = [cube.to[0] - cube.from[0], cube.to[1] - cube.from[1], cube.to[2] - cube.from[2]];
			if (s[0] <= 0 || s[1] <= 0 || s[2] <= 0) {
				const issue = { cube: cube.name, issue: 'degenerate_size', size: s };
				const to = cube.to.slice();
				for (let i = 0; i < 3; i++) if (s[i] <= 0) to[i] = r4(cube.from[i] + FIX_MIN_SIZE);
				issue.fix = {
					element: cube.name, issue: 'degenerate_size', tool: 'edit_element',
					fix: { element: cube.name, from: cube.from.slice(), to },
				};
				issues.push(issue);
			}
			if (animMode && (!cube.parent || cube.parent === 'root')) {
				const issue = { cube: cube.name, issue: 'no_bone_parent' };
				if (singleBone)
					issue.fix = {
						element: cube.name, issue: 'no_bone_parent', tool: 'edit_element',
						fix: { element: cube.name, parent: singleBone },
					};
				issues.push(issue);
			}
		});

		// Z-FIGHTING / clipping detection: two faces sharing the same plane and
		// overlapping in area will flicker (the "two squares inside one another"
		// texture-clip). We flag unrotated cube pairs that share a min- or max-
		// plane on an axis AND overlap by real area on the other two axes (their
		// coplanar faces point the SAME way, so both render and fight). Fix by
		// offsetting one cube by >=0.1 (or insetting it) so the faces aren't coplanar.
		// Shared scan with measure clearance (same COPLANAR_EPS/OVERLAP_MIN).
		clearanceOverlaps().forEach((e) => {
			const issue = {
				issue: 'coplanar_overlap', cubes: [e.a.name, e.b.name],
				axis: e.axis, plane: e.plane,
				hint: 'faces coplanar -> z-fight; offset one cube by >=0.1 on this axis',
			};
			// Proposed fix: nudge the second cube by OVERLAP_MIN along the
			// reported axis (meets the documented >=0.1 offset).
			const ax = AXES.indexOf(e.axis);
			if (ax >= 0) {
				const from = e.b.from.slice(), to = e.b.to.slice();
				from[ax] = r4(from[ax]) + OVERLAP_MIN;
				to[ax] = r4(to[ax]) + OVERLAP_MIN;
				issue.fix = {
					element: e.b.name, issue: 'coplanar_overlap', tool: 'edit_elements',
					fix: { edits: [{ element: e.b.name, patch: { from, to } }] },
				};
			}
			issues.push(issue);
		});

		// SPACE AUDIT — see-through gaps and floating pieces (screenshot review
		// in data). Classes:
		// - gap_slit: crack-thin see-through void (parts meeting edge-to-edge
		//   instead of overlapping — handguards, buttplates, segmented curves)
		//   -> gate ERROR.
		// - see_through_opening: larger see-through void (window, port, guard
		//   loop) — legal design OR a missing face -> gate WARNING, verify
		//   against the reference.
		// - floating_piece: piece disconnected from the main mass in 3D
		//   -> gate WARNING (verify before deleting).
		// Unrotated, non-degenerate cubes only — rotated cubes expand their
		// bounding box in projection (hides slits, invents fake ones) and
		// zero-extent cubes have no volume (already flagged degenerate_size).
		const spaceOpts = (p && p.audit_space) || null;
		if (!spaceOpts || spaceOpts.enabled !== false) {
			const gaps = auditSpaceGaps(Cube.all.filter(isUnrotatedCube), spaceOpts || {});
			gaps.slits.forEach((s) => {
				issues.push({
					issue: 'gap_slit',
					at: s.at, axis: s.axis, area_units: s.area_units, dim_min: s.dim_min, dim_max: s.dim_max,
					hint: s.hint + '; extend a neighbouring cube >=0.5 units into the gap or switch the part to add_mesh shape:arc',
				});
			});
			gaps.openings.forEach((o) => {
				issues.push({
					issue: 'see_through_opening',
					at: o.at, axis: o.axis, area_units: o.area_units, dim_min: o.dim_min, dim_max: o.dim_max,
					hint: 'see-through opening (background visible along the ' + o.axis + ' axis) — verify against the reference: designed window/port or a missing face',
				});
			});
			gaps.detached.forEach((d) => {
				issues.push({
					issue: 'floating_piece',
					at: d.at, cubes: d.cubes,
					hint: 'piece disconnected from the main mass (no cube contact on any axis) — verify against the reference (orphan or intentional sub-assembly?)',
				});
			});
		}

		const byType = {};
		issues.forEach((i) => { byType[i.issue] = (byType[i.issue] || 0) + 1; });
		// Remember the gate for save_project's advisory warning (ticket #23):
		// snapshot the counts so later calls can't mutate the stored summary.
		const gate = summarizeGate(issues);
		G.lastGate = { errors: gate.errors, warnings: gate.warnings, gate_pass: gate.gate_pass };
		return {
			cubes: Cube.all.length, groups: Group.all.length, textures: Texture.all.length,
			texture_size: [tw, th], animation_format: animMode,
			issue_count: issues.length, by_type: byType, issues,
			gate,
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
		// fromDataURL loads the bitmap asynchronously; if a later tool edits the
		// texture before that load finishes, the canvas is still the default 16x16
		// and the paint is clipped/corrupted. Wait for the image so the texture is
		// guaranteed to be the requested size and ready to paint.
		return new Promise((resolve) => {
			const finish = () => { tex.width = width; tex.height = height; resolve(serializeTexture(tex)); };
			if (tex.img && tex.img.complete && tex.img.naturalWidth) return finish();
			if (tex.img && tex.img.addEventListener) {
				tex.img.addEventListener('load', finish, { once: true });
				setTimeout(finish, 400); // safety net
			} else {
				finish();
			}
		});
	},

	// Generate a pixelated VFX texture: a bright hot core fading to cool edges in
	// quantized colour bands with jagged transparent edges. `style` picks the
	// shape (flame, energy, orb, spark, smoke, trail, beam, bolt, ring,
	// shockwave, crystal). With frames>1 it bakes a vertical FLIPBOOK and starts
	// the texture animator so the effect loops. Defaults to an emissive/additive
	// render mode and 2-sided rendering so it glows on a plane. Use a `preset`
	// or explicit `palette` to colour it (e.g. energy/ice/fire/arcane/poison).
	create_vfx_texture(p) {
		requireProject();
		const style = (p.style || 'energy').toLowerCase();
		const w = (p.width | 0) || 16;
		const h = (p.height | 0) || ((style === 'flame' || style === 'fire' || style === 'beam' || style === 'beam_v') ? 24 : 16);
		const frames = Math.max(1, (p.frames | 0) || 1);
		const palette = Array.isArray(p.palette) ? p.palette
			: (VFX_PALETTES[p.preset] || VFX_PALETTES[style] || VFX_PALETTES.energy);
		const seed = p.seed != null ? Number(p.seed) : (Math.random() * 1000) | 0;
		const softEdge = p.soft_edge != null ? !!p.soft_edge : (style === 'orb' || style === 'glow' || style === 'smoke');
		const canvas = buildVfxCanvas(w, h, frames, style, palette, seed, softEdge);
		Undo.initEdit({ textures: [] });
		const tex = new Texture({ name: p.name || (style + '_vfx'), width: w, height: h * frames })
			.fromDataURL(canvas.toDataURL()).add(false);
		// One frame tall per UV island so Blockbench counts frames correctly.
		try { tex.uv_width = w; tex.uv_height = h; } catch (e) {}
		const rm = p.render_mode || (VFX_OPAQUE[style] ? 'emissive' : 'additive');
		try { tex.render_mode = rm; } catch (e) {}
		try { tex.render_sides = p.render_sides || 'double'; } catch (e) {}
		if (frames > 1) {
			tex.frame_time = p.frame_time != null ? Number(p.frame_time) : 2;
			tex.frame_interpolate = !!p.frame_interpolate;
			tex.frame_order_type = p.frame_order_type || 'loop';
		}
		if (p.particle) tex.enableParticle();
		try { tex.updateMaterial && tex.updateMaterial(); } catch (e) {}
		if (frames > 1) { try { TextureAnimator.start(); } catch (e) {} }
		Undo.finishEdit('MCP: create vfx texture');
		Canvas.updateAll && Canvas.updateAll();
		return Object.assign(serializeTexture(tex), { style, frames, palette });
	},

	// Set a texture's render mode (default | emissive | additive | layered |
	// normal | height | mer), 2-sided rendering, flipbook frame timing, or
	// particle flag. Use emissive/additive to make VFX (flames/energy/glow) light
	// up and ignore scene shading; render_sides 'double' shows planes from both
	// sides. `animate:true` starts the texture-animation player for flipbooks.
	set_texture_render_mode(p) {
		requireProject();
		const tex = findTexture(p.texture);
		if (!tex) throw new Error('Texture not found: ' + p.texture);
		if (p.render_mode) tex.render_mode = p.render_mode;
		if (p.render_sides) tex.render_sides = p.render_sides;
		if (p.frame_time != null) tex.frame_time = Number(p.frame_time);
		if (p.frame_interpolate != null) tex.frame_interpolate = !!p.frame_interpolate;
		if (p.frame_order_type) tex.frame_order_type = p.frame_order_type;
		if (p.particle === true) tex.enableParticle();
		try { tex.updateMaterial && tex.updateMaterial(); } catch (e) {}
		if (p.animate) { try { TextureAnimator.start(); } catch (e) {} }
		Canvas.updateAll && Canvas.updateAll();
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

	// PALETTE AUDIT — the mush detector. Pixel-art and quantized looks die by
	// gradients: a soft bake or a filtered export smears every face into dozens
	// of one-off shades, and the human reviewer sees "muddy colours" while the
	// data was invisible. This reads the SOURCE bitmap (not a screenshot, not
	// the viewport) and counts actual unique colours — overall and per UV
	// island (box-UV cubes assigned to this texture). `quantized_unique`
	// buckets colours to 16-level steps: a sheet with few real colours shows a
	// similar bucket count, while a gradient-smeared one explodes — the
	// ratio is the mush signal. Numbers only; no pixels are changed.
	audit_texture(p) {
		requireProject();
		let tex = p.texture ? findTexture(p.texture) : (Texture.getDefault ? Texture.getDefault() : null);
		if (!tex) tex = Texture.all[0];
		if (!tex) throw new Error('No texture to audit. Create one first with create_texture.');
		const canvas = tex.canvas;
		if (!canvas) throw new Error('Texture has no canvas to read.');
		const w = tex.width || canvas.width, h = tex.height || canvas.height;
		const ctx = canvas.getContext('2d');
		const img = ctx.getImageData(0, 0, w, h).data;
		const quant = (v) => (v >> 4); // 16-level bucket per channel
		const keyOf = (r, g, b, a) => a < 8 ? 'a0' : ((quant(r) << 8) | (quant(g) << 4) | quant(b));
		const total = new Map();
		let quantTotal = new Set();
		let transparent = 0;
		for (let i = 0; i < w * h; i++) {
			const r = img[i * 4], g = img[i * 4 + 1], b = img[i * 4 + 2], a = img[i * 4 + 3];
			if (a < 8) { transparent++; total.set('a0', (total.get('a0') || 0) + 1); quantTotal.add('a0'); continue; }
			const k = (r << 16) | (g << 8) | b;
			total.set(k, (total.get(k) || 0) + 1);
			quantTotal.add(keyOf(r, g, b, a));
		}
		const topColors = [...total.entries()]
			.filter(([k]) => k !== 'a0')
			.sort((x, y) => y[1] - x[1])
			.slice(0, 12)
			.map(([k, n]) => ({ color: '#' + k.toString(16).padStart(6, '0'), pixels: n }));
		let islands = [];
		const perIsland = p.per_island !== false;
		if (perIsland) {
			const scale = tex.width / (Project.texture_width || tex.width);
			const byRect = new Map();
			Cube.all.forEach((cube) => {
				for (const dir in cube.faces) {
					const f = cube.faces[dir];
					if (!f || f.texture !== tex.uuid) continue;
					const r = faceRect(f, scale);
					if (r.w <= 0 || r.h <= 0) continue;
					const k = r.x + ',' + r.y + ',' + r.w + ',' + r.h;
					if (!byRect.has(k)) byRect.set(k, { rect: r, names: [] });
					const entry = byRect.get(k);
					if (entry.names.indexOf(cube.name) === -1) entry.names.push(cube.name);
				}
			});
			islands = [...byRect.values()].map(({ rect, names }) => {
				const local = new Map();
				const localQuant = new Set();
				for (let y = rect.y; y < Math.min(rect.y + rect.h, h); y++) {
					for (let x = rect.x; x < Math.min(rect.x + rect.w, w); x++) {
						const i = y * w + x;
						const r = img[i * 4], g = img[i * 4 + 1], b = img[i * 4 + 2], a = img[i * 4 + 3];
						if (a < 8) { local.set('a0', (local.get('a0') || 0) + 1); localQuant.add('a0'); continue; }
						const k = (r << 16) | (g << 8) | b;
						local.set(k, (local.get(k) || 0) + 1);
						localQuant.add(keyOf(r, g, b, a));
					}
				}
				const dom = [...local.entries()]
					.filter(([k]) => k !== 'a0')
					.sort((x, y) => y[1] - x[1]);
				const area = Math.max(1, rect.w * rect.h);
				return {
					rect: [rect.x, rect.y, rect.w, rect.h],
					cubes: names.slice(0, 4),
					unique: dom.length,
					quantized_unique: localQuant.size,
					dominant: dom.slice(0, 4).map(([k, n]) => ({
						color: k === 'a0' ? 'transparent' : '#' + k.toString(16).padStart(6, '0'),
						share: Math.round((n / area) * 100),
					})),
				};
			}).sort((a2, b2) => b2.unique - a2.unique).slice(0, 60);
		}
		// Unique COLOURS only — transparency is already reported separately
		// (transparent_pixels) and counting it as a colour muddies the mush
		// signal (a mostly-empty sheet is not a colourful one).
		const uniqueTotal = [...total.keys()].filter((k) => k !== 'a0').length;
		const quantUnique = [...quantTotal].filter((k) => k !== 'a0').length;
		return {
			texture: tex.name || tex.uuid,
			size: [w, h],
			unique_total: uniqueTotal,
			quantized_unique_total: quantUnique,
			transparent_pixels: transparent,
			top_colors: topColors,
			islands,
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

	// High-level SMOOTH base coat (the "@volmur / Hytale" look). Assigns the
	// texture to every chosen face (no untextured gaps), then per face bakes a
	// soft vertical gradient in the region's base colour + gentle directional
	// shading (top lighter, underside darker) + a SUBTLE low-contrast mottle,
	// and finally a 3x3 box blur per UV island (the "smooth brush"). Cubes whose
	// name matches `glow_regex` are filled bright with no shading/blur so they
	// read as emissive. NO harsh per-pixel noise and NO dark per-face outline by
	// default — that is the dirty/blocky look to avoid. Paint crisp features with
	// paint_faces AFTER this.
	detail_cubes(p) {
		requireProject();
		let tex = p.texture ? findTexture(p.texture) : null;
		if (!tex && Texture.getDefault) tex = Texture.getDefault();
		if (!tex) tex = Texture.all[0];
		if (!tex) throw new Error('No texture to paint on. Create one first with create_texture.');

		let cubes;
		const sel = resolveScope(p);
		if (sel.mode === 'all') cubes = Cube.all.slice();
		else if (sel.mode === 'selected') cubes = sel.refs.map(findElement).filter((c) => c instanceof Cube);
		else if (!p.cubes || p.cubes === 'all') cubes = Cube.all.slice();
		else cubes = toList(p.cubes).map(findElement).filter((c) => c instanceof Cube);
		if (!cubes.length) throw new Error('No matching cubes.');

		const base = p.base || '#9c9c9c';
		const colors = p.colors || null;                              // region colour map
		const mottle = p.noise != null ? Number(p.noise) : 0.06;       // subtle, low default
		const blurAmt = p.blur != null ? Number(p.blur) : 0.55;        // the smooth brush
		const topLight = p.top_light != null ? Number(p.top_light) : 0.12;
		const bottomDark = p.bottom_dark != null ? Number(p.bottom_dark) : 0.22;
		const edgeDark = p.edge_darken != null ? Number(p.edge_darken) : 0; // OFF by default
		const streaks = !!p.streaks;                                   // fur/grain streaks
		const glowRe = p.glow_regex ? new RegExp(p.glow_regex, 'i') : /_core$|_glow$/i;
		const faceMul = {
			up: 1 + topLight, down: 1 - bottomDark,
			north: 0.95, south: 1.0, east: 1.06, west: 0.88,
		};
		const scale = tex.width / (Project.texture_width || tex.width);

		const jobs = [];
		Undo.initEdit({ elements: cubes });
		cubes.forEach((cube) => {
			const baseCol = regionColorFor(cube.name, colors, base);
			const glow = glowRe.test(cube.name);
			for (const dir in cube.faces) {
				const face = cube.faces[dir];
				if (!face) continue;
				face.texture = tex.uuid;
				const r = faceRect(face, scale);
				if (r.w <= 0 || r.h <= 0) continue;
				jobs.push({ r, dir, base: baseCol, glow, mul: faceMul[dir] != null ? faceMul[dir] : 1 });
			}
		});
		Undo.finishEdit('MCP: assign texture');

		tex.edit((canvas) => {
			const ctx = canvas.getContext('2d');
			ctx.imageSmoothingEnabled = false;
			// 1) gradient base coat per face
			jobs.forEach(({ r, base, glow, mul }) => {
				const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
				if (glow) {
					g.addColorStop(0, shadeHex(base, 1.12));
					g.addColorStop(0.5, shadeHex(base, 1.42));
					g.addColorStop(1, shadeHex(base, 1.05));
				} else {
					g.addColorStop(0, shadeHex(base, mul * 1.1));
					g.addColorStop(1, shadeHex(base, mul * 0.84));
				}
				ctx.fillStyle = g;
				ctx.fillRect(r.x, r.y, r.w, r.h);
				if (edgeDark > 0 && r.w > 2 && r.h > 2 && !glow) {
					ctx.fillStyle = shadeHex(base, mul * (1 - edgeDark));
					ctx.fillRect(r.x, r.y, r.w, 1);
					ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
					ctx.fillRect(r.x, r.y, 1, r.h);
					ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
				}
			});
			// 2) subtle low-contrast mottle (skip glow)
			if (mottle > 0) jobs.forEach(({ r, base, glow, mul }) => {
				if (glow) return;
				const count = Math.max(1, Math.floor(r.w * r.h * 0.10));
				for (let i = 0; i < count; i++) {
					const px = r.x + (Math.random() * r.w | 0);
					const py = r.y + (Math.random() * r.h | 0);
					ctx.fillStyle = shadeHex(base, mul * (1 - mottle + Math.random() * mottle * 2));
					ctx.fillRect(px, py, 1, Math.random() < 0.5 ? 2 : 1);
				}
			});
			// 3) optional grain streaks on top / back faces (fur, wood, stone)
			if (streaks) jobs.forEach(({ r, dir, base, glow, mul }) => {
				if (glow || (dir !== 'up' && dir !== 'north')) return;
				const lines = Math.max(1, Math.floor(r.w / 4));
				for (let i = 0; i < lines; i++) {
					const px = r.x + (Math.random() * r.w | 0);
					ctx.fillStyle = shadeHex(base, mul * (0.78 + Math.random() * 0.12));
					ctx.fillRect(px, r.y + 1, 1, Math.max(1, r.h - 2));
				}
			});
			// 4) smooth-brush blur per island (skip glow for crisp glow edges)
			if (blurAmt > 0) jobs.forEach(({ r, glow }) => {
				if (!glow) blurRect(ctx, r.x, r.y, r.w, r.h, blurAmt);
			});
		}, { edit_name: 'MCP: detail cubes (smooth)', no_undo: false });

		Canvas.updateAll();
		return { textured: cubes.length, faces: jobs.length, smooth: true, texture: serializeTexture(tex) };
	},

	// Promoted skill-snippet SMOOTH bake (ticket #27): the texturing skill's
	// smooth-bake recipe as a native tool — gradient + mottle + per-island
	// blur per face. Shares the smooth-coat helpers with detail_cubes
	// (shadeHex, faceRect, blurRect, regionColorFor, scope) and differs only
	// in snippet-faithful policy: snippet palette default, `_core$` glow,
	// hard parts (*_cap/*_base/chains/cords) keep crisp edges, snippet
	// gradient depth. No streaks/edge-darkening knobs (see detail_cubes).
	smooth_bake(p) {
		requireProject();
		let tex = p.texture ? findTexture(p.texture) : null;
		if (!tex && Texture.getDefault) tex = Texture.getDefault();
		if (!tex) tex = Texture.all[0];
		if (!tex) throw new Error('No texture to paint on. Create one first with create_texture.');

		let cubes;
		const sel = resolveScope(p);
		if (sel.mode === 'all') cubes = Cube.all.slice();
		else if (sel.mode === 'selected') cubes = sel.refs.map(findElement).filter((c) => c instanceof Cube);
		else if (!p.cubes || p.cubes === 'all') cubes = Cube.all.slice();
		else cubes = toList(p.cubes).map(findElement).filter((c) => c instanceof Cube);
		if (!cubes.length) throw new Error('No matching cubes.');

		const base = p.base || '#6e4f30';
		const colors = p.colors || null;                              // region colour map
		const mottle = p.noise != null ? Number(p.noise) : 0.13;       // snippet amplitude
		const blurAmt = p.blur != null ? Number(p.blur) : 0.55;        // the smooth brush
		const topLight = p.top_light != null ? Number(p.top_light) : 0.12;
		const bottomDark = p.bottom_dark != null ? Number(p.bottom_dark) : 0.22;
		const glowRe = p.glow_regex ? new RegExp(p.glow_regex, 'i') : /_core$/i;
		const pixelMode = String(p.style || '').toLowerCase() === 'pixel';
		const bands = Math.max(1, Math.min(8, p.bands != null ? Number(p.bands) : 3));
		const hardRe = /_cap$|_base$|chain|cord/i;                     // hard parts stay crisp
		const faceMul = {
			up: 1 + topLight, down: 1 - bottomDark,
			north: 0.95, south: 1.0, east: 1.06, west: 0.88,
		};
		const scale = tex.width / (Project.texture_width || tex.width);

		const jobs = [];
		Undo.initEdit({ elements: cubes });
		cubes.forEach((cube) => {
			const baseCol = regionColorFor(cube.name, colors, base);
			const glow = glowRe.test(cube.name);
			const hard = hardRe.test(cube.name);
			for (const dir in cube.faces) {
				const face = cube.faces[dir];
				if (!face) continue;
				face.texture = tex.uuid;
				const r = faceRect(face, scale);
				if (r.w <= 0 || r.h <= 0) continue;
				jobs.push({ r, dir, base: baseCol, glow, hard, mul: faceMul[dir] != null ? faceMul[dir] : 1 });
			}
		});
		Undo.finishEdit('MCP: assign texture');

		tex.edit((canvas) => {
			const ctx = canvas.getContext('2d');
			ctx.imageSmoothingEnabled = false;
			// 1) gradient base coat per face (snippet stops: mul*1.1 -> mul*0.85)
			jobs.forEach(({ r, base, glow, mul }) => {
				const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
				if (glow) {
					g.addColorStop(0, shadeHex(base, 1.12));
					g.addColorStop(0.5, shadeHex(base, 1.42));
					g.addColorStop(1, shadeHex(base, 1.05));
				} else {
					g.addColorStop(0, shadeHex(base, mul * 1.1));
					g.addColorStop(1, shadeHex(base, mul * 0.85));
				}
				ctx.fillStyle = g;
				ctx.fillRect(r.x, r.y, r.w, r.h);
			});
			if (pixelMode) {
				// PIXEL-ART MODE — flat quantized colour bands + boundary dither,
				// NO mottle, NO blur. The pixel-art look lives and dies on a tiny
				// palette: the smooth bake's gradient stops + per-island blur
				// smear every face into dozens of one-off shades (the mush a
				// screenshot review can only guess at). `bands` brightness
				// bands per face between the top-light and bottom-dark extremes,
				// quantized to whole-pixel rows so band edges snap to the grid.
				jobs.forEach(({ r, base, glow, hard, mul }) => {
					if (glow) return;                                   // cores keep their bright gradient
					const top = mul * (1 + topLight), bot = mul * (1 - bottomDark);
					const bh = Math.max(1, Math.round(r.h / bands));
					let prevF = null;
					for (let row = 0; row < bands; row++) {
						const t = bands === 1 ? 0.5 : row / (bands - 1);
						const f = top + (bot - top) * t;
						const y0 = r.y + row * bh;
						let hgt = (row === bands - 1) ? (r.y + r.h - y0) : bh;
						if (hgt <= 0) continue;
						ctx.fillStyle = shadeHex(base, f);
						ctx.fillRect(r.x, y0, r.w, hgt);
						// checkerboard dither across each band boundary: alternate
						// pixels of the boundary row take the PREVIOUS (lighter)
						// band's tone — pairs the two tones without adding new
						// colours (off for hard parts)
						if (!hard && row > 0 && r.w >= 4 && hgt >= 2) {
							ctx.fillStyle = shadeHex(base, prevF);
							for (let dx = 0; dx < r.w; dx++) {
								if ((dx + row) % 2 === 0) ctx.fillRect(r.x + dx, y0, 1, 1);
							}
						}
						prevF = f;
					}
				});
			} else {
				// 2) subtle low-contrast mottle (skip glow + hard parts for crisp edges)
				if (mottle > 0) jobs.forEach(({ r, base, glow, hard, mul }) => {
					if (glow || hard) return;
					const count = Math.max(1, Math.floor(r.w * r.h * 0.10));
					for (let i = 0; i < count; i++) {
						const px = r.x + (Math.random() * r.w | 0);
						const py = r.y + (Math.random() * r.h | 0);
						ctx.fillStyle = shadeHex(base, mul * (1 - mottle + Math.random() * mottle * 2));
						ctx.fillRect(px, py, 1, Math.random() < 0.5 ? 2 : 1);
					}
				});
				// 3) smooth-brush blur per island (skip glow + hard parts)
				if (blurAmt > 0) jobs.forEach(({ r, glow, hard }) => {
					if (!glow && !hard) blurRect(ctx, r.x, r.y, r.w, r.h, blurAmt);
				});
			}
		}, { edit_name: pixelMode ? 'MCP: smooth bake (pixel)' : 'MCP: smooth bake', no_undo: false });

		Canvas.updateAll();
		return pixelMode
			? { baked: true, style: 'pixel', bands, cubes: cubes.length, faces: jobs.length, texture: serializeTexture(tex) }
			: { baked: true, cubes: cubes.length, faces: jobs.length, texture: serializeTexture(tex) };
	},

	// Paint specific cube faces using coordinates RELATIVE to each face's UV
	// rect (so [0,0] is the top-left of that face). No need to compute absolute
	// UVs by hand — this is how you place eyes, nostrils, stripes, patterns, etc.
	paint_faces(p) {
		requireProject();
		const sel = resolveScope(p);
		let items;
		if (sel.mode !== 'legacy') {
			if (p.faces != null) throw new Error('Pass either "faces" or "scope"/"elements", not both.');
			const cubes = sel.mode === 'all'
				? Cube.all.slice()
				: sel.refs.map(findElement).filter((c) => c instanceof Cube);
			if (!cubes.length) throw new Error('No matching cubes.');
			items = cubes.map((c) => ({ cube: c.uuid, face: p.face, base: p.base, ops: p.ops, texture: p.texture }));
		} else {
			items = p.faces
				? toList(p.faces)
				: [{ cube: p.cube, face: p.face, base: p.base, ops: p.ops, texture: p.texture }];
		}
		const byTex = new Map();
		for (const it of items) {
			const cube = findElement(it.cube);
			if (!cube || !(cube instanceof Cube)) throw new Error('Cube not found: ' + it.cube);
			const dirs = (!it.face || it.face === 'all') ? Object.keys(cube.faces) : toList(it.face).filter((d) => FACE_DIRS.indexOf(d) !== -1);
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

	// Promoted skill-snippet texture export (ticket #28): writes project
	// textures to disk via Blockbench.writeFile with savetype 'image' — the
	// exact snippet behavior — with texture selection + optional destination.
	// Single seam: the texturing skill references this tool instead of the
	// snippet. Returns per-texture results so one bad ref never voids the
	// batch (contract-suite style: {exported, failed, results[]}).
	export_textures(p) {
		requireProject();
		if (p.texture != null && p.textures != null) {
			throw new Error('Pass either "texture" or "textures", not both.');
		}
		let refs;
		if (p.textures != null) {
			refs = toList(p.textures);
			if (!refs.length) throw new Error('Field "textures" must not be empty.');
		} else if (p.texture != null) {
			refs = [p.texture];
		} else {
			refs = (Texture.all || []).map((t) => t.uuid);
		}
		if (!refs.length) throw new Error('No textures to export. Create one first with create_texture.');
		const hasPath = p.path != null;
		const hasDir = p.directory != null;
		if (hasPath && hasDir) throw new Error('Pass either "path" or "directory", not both.');
		if (hasPath && refs.length > 1) {
			throw new Error('Field "path" is for a single texture; pass "directory" to export multiple textures.');
		}
		const fileNameFor = (tex) => {
			const base = String(tex.name || 'texture').replace(/[\\/]/g, '_');
			return /\.png$/i.test(base) ? base : base + '.png';
		};
		const joinDir = (dir, file) => String(dir).replace(/[\\/]+$/, '') + '/' + file;
		const defaultDir = () => {
			const sp = Project.save_path || null;
			if (!sp) {
				throw new Error('Field "path" (or "directory") is required until the project is saved: save the project first or pass an explicit destination.');
			}
			return String(sp).split(/[\\/]/).slice(0, -1).join('/') || '.';
		};
		const fallbackDir = !hasPath && !hasDir ? defaultDir() : null;
		const destFor = (tex) => {
			if (hasPath) return p.path;
			const dir = hasDir ? p.directory : fallbackDir;
			return joinDir(dir, fileNameFor(tex));
		};
		const results = [];
		for (const ref of refs) {
			const tex = findTexture(ref);
			if (!tex) {
				results.push({ texture: String(ref), ok: false, error: 'Texture not found: ' + ref });
				continue;
			}
			try {
				const dest = destFor(tex);
				Blockbench.writeFile(dest, { content: tex.getDataURL(), savetype: 'image' });
				results.push({ texture: tex.name, uuid: tex.uuid, ok: true, path: dest });
			} catch (e) {
				results.push({ texture: tex.name, uuid: tex.uuid, ok: false, error: (e && e.message) || String(e) });
			}
		}
		return {
			exported: results.filter((r) => r.ok).length,
			failed: results.filter((r) => !r.ok).length,
			results,
		};
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

	// Promoted skill-snippet pose preview (ticket #29): select an animation,
	// set the timeline to a given time, and drive the pose preview so the
	// agent can screenshot the pose — the exact snippet behavior, as a native
	// tool. Single seam: the animation skill references this tool instead of
	// the snippet. Returns the applied animation/time in contract-suite style.
	preview_pose(p) {
		requireProject();
		const ref = p.animation;
		if (ref == null || ref === '') throw new Error('Field "animation" (uuid or name) is required.');
		const anim = findAnimation(ref);
		if (!anim) throw new Error('Field "animation" not found: ' + ref);
		if (p.time == null || typeof p.time !== 'number' || Number.isNaN(p.time)) {
			throw new Error('Field "time" (seconds) is required.');
		}
		const t = Number(p.time);
		anim.select();
		Timeline.setTime(t);
		Animator.preview();
		return { animation: anim.name, uuid: anim.uuid, time: t };
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
	// 'right','top','bottom','isometric_right_front',...), {position,target},
	// or blueprint objects {view, ortho?, px_per_unit?, wireframe?}.
	// Call-level `ortho`/`px_per_unit`/`wireframe` apply to every shot unless
	// a per-view object overrides them. Camera semantics are unchanged —
	// blueprint mode only pins projection, scale, and overlay for the shot
	// and restores the prior preview state afterward.
	screenshot_views(p) {
		requireProject();
		const preview = Preview.selected;
		const views = (p && Array.isArray(p.views) && p.views.length)
			? p.views
			: ['isometric_right_front', 'front', 'left', 'back'];
		const defaults = {
			ortho: p && typeof p.ortho === 'boolean' ? p.ortho : undefined,
			px_per_unit: p && typeof p.px_per_unit === 'number' ? p.px_per_unit : undefined,
			wireframe: p && typeof p.wireframe === 'boolean' ? p.wireframe : undefined,
		};
		if (defaults.px_per_unit !== undefined && !(defaults.px_per_unit > 0)) {
			throw new Error('Field "px_per_unit" must be a positive number.');
		}
		const options = {};
		if (p && p.width) options.width = p.width;
		if (p && p.height) options.height = p.height;
		return (async () => {
			const { shots, projection_restored } = await captureBlueprintViews(preview, views, defaults, options);
			return { count: shots.length, shots, projection_restored };
		})();
	},

	// Pin a reference image against one blueprint view (ticket #25, the
	// pinning half of the reference-compare loop; compared with
	// compare_views).
	// `view` is a camera preset id or {position,target} (same camera
	// semantics as screenshot_views views). `source` is an image file path
	// (desktop app) or inline image data; "" unpins. Pinning again replaces
	// the stored reference. Returns the stored state so clients can read
	// back what is pinned: {view, pinned:true, mime, bytes} or {view,
	// pinned:false} after unpin.
	// `source: "@capture"` (compare v2) snapshots the CURRENT preview
	// render under the given view key — the save-what-I-see-now half of
	// the loop. Camera state is never moved; capture is async like the
	// screenshot paths. Pin under the same view you will later compare.
	set_reference_image(p) {
		requireProject();
		if (p && p.source === '@capture') {
			const preview = Preview.selected;
			const bp = p.view ? normalizeBlueprintView(typeof p.view === 'string' ? p.view : { view: p.view }, {}) : null;
			const key = (bp && bp.position && bp.target)
				? referenceViewKey({ position: bp.position, target: bp.target })
				: (bp ? referenceViewKey(p.view)
					: referenceViewKey({
						position: [preview.camera.position.x, preview.camera.position.y, preview.camera.position.z],
						target: [preview.controls.target.x, preview.controls.target.y, preview.controls.target.z],
					}));
			return new Promise((resolve) => {
				Screencam.screenshotPreview(preview, {}, (dataUrl) => {
					const bits = dataUrlToBytes(dataUrl);
					const ref = toReferenceImage(bits ? bits.bytes : null, ' (@capture)');
					const store = referenceStore();
					store[key] = ref;
					resolve({ view: key, pinned: true, mime: ref.mime, bytes: ref.bytes, captured: true });
				});
			});
		}
		const key = referenceViewKey(p && p.view);
		const ref = resolveReferenceSource(p ? p.source : undefined);
		const store = referenceStore();
		if (!ref) {
			delete store[key];
			return { view: key, pinned: false };
		}
		store[key] = ref;
		return { view: key, pinned: true, mime: ref.mime, bytes: ref.bytes };
	},

	// Compare the current model against the pinned reference images and
	// return structured delta text per view (ticket #26, the comparison half
	// of the reference-compare loop). `views` reuses the screenshot_views
	// camera semantics exactly (preset id, {position,target}, or blueprint
	// {view, ortho?, px_per_unit?, wireframe?} with call-level
	// ortho/px_per_unit/wireframe defaults), so pinning with
	// set_reference_image under the same view and comparing with the same
	// camera + px_per_unit yields a stable, comparable delta. Each entry
	// carries the canonical view key (the same key set_reference_image
	// reports) plus a pass/fail-ish `match`. A well-formed view with no
	// pinned reference becomes a per-view error naming "view" while the
	// other views still compare; a malformed view fails the whole call
	// naming "view" (same enforcement point as set_reference_image).
	// Camera/projection state is restored after the sequence.
	compare_views(p) {
		requireProject();
		if (!p || !Array.isArray(p.views) || !p.views.length) {
			throw new Error('Field "views" must be a non-empty array of blueprint views.');
		}
		const defaultThreshold = (p && typeof p.threshold === 'number') ? p.threshold : 128;
		if (!(defaultThreshold >= 1 && defaultThreshold <= 255)) {
			throw new Error('Field "threshold" must be an integer 1-255 (alpha cutoff for the silhouette mask).');
		}
		const gateFor = (v) => {
			let gate = (p && typeof p.gate === 'string') ? p.gate : undefined;
			if (v && typeof v === 'object' && !Array.isArray(v)) {
				if (typeof v.gate === 'string') gate = v.gate;
				if (v.gate === null) gate = undefined;
			}
			if (gate === undefined || gate === null) return { mode: 'default' };
			const spec = { iou: 0.85, area: 0.25, aspect: 0.1, centroid: 0.15 };
			const seen = { iou: false, area: false, aspect: false, centroid: false };
			for (const raw of String(gate).split(',')) {
				const tok = raw.trim().replace(/^@/, '');
				if (!tok) continue;
				const m = /^(iou|area|aspect|centroid)(?:<=(\d*\.?\d+))?$/.exec(tok);
				if (!m) return { error: 'Field "gate" must be a comma list of iou<=N, area<=N, aspect<=N, centroid<=N.' };
				if (seen[m[1]]) return { error: `Field "gate" lists ${m[1]} twice.` };
				seen[m[1]] = true;
				if (m[2] !== undefined) {
					const num = Number(m[2]);
					if (!isFinite(num)) return { error: `Field "gate" ${m[1]} threshold must be a finite number.` };
					spec[m[1]] = num;
				} else {
					spec[m[1]] = 0; // bare key = disable that check
				}
			}
			if (!(spec.iou > 0 && spec.iou <= 1)) return { error: 'Field "gate" iou threshold must be within (0, 1].' };
			for (const k of ['area', 'aspect', 'centroid']) {
				if (!(spec[k] >= 0)) return { error: `Field "gate" ${k} threshold must be >= 0.` };
			}
			return { mode: 'custom', spec };
		};
		const preview = Preview.selected;
		const defaults = {
			ortho: p && typeof p.ortho === 'boolean' ? p.ortho : undefined,
			px_per_unit: p && typeof p.px_per_unit === 'number' ? p.px_per_unit : undefined,
			wireframe: p && typeof p.wireframe === 'boolean' ? p.wireframe : undefined,
		};
		if (defaults.px_per_unit !== undefined && !(defaults.px_per_unit > 0)) {
			throw new Error('Field "px_per_unit" must be a positive number.');
		}
		const options = {};
		if (p && p.width) options.width = p.width;
		if (p && p.height) options.height = p.height;
		const store = referenceStore();
		const plan = p.views.map((v, vi) => {
			const bp = normalizeBlueprintView(v, defaults);
			if (bp.px_per_unit !== undefined && !(bp.px_per_unit > 0)) {
				throw new Error('Field "px_per_unit" must be a positive number.');
			}
			const key = referenceViewKey(v);
			let threshold = defaultThreshold;
			if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.threshold === 'number') {
				if (!(v.threshold >= 1 && v.threshold <= 255)) {
					throw new Error(`Field "threshold" on views[${vi}] must be an integer 1-255.`);
				}
				threshold = v.threshold;
			}
			const gate = gateFor(v);
			if (gate.error) throw new Error(gate.error);
			return { item: v, key, ref: store[key] || null, shot: null, threshold, gate, bp };
		});
		return (async () => {
			const capturable = plan.filter((e) => e.ref);
			if (capturable.length) {
				const { shots } = await captureBlueprintViews(preview, capturable.map((e) => e.item), defaults, options);
				capturable.forEach((e, i) => { e.shot = shots[i]; });
			}
			const comparisons = plan.map((e) => {
				if (!e.ref) {
					return {
						view: e.key,
						match: false,
						compared: false,
						error: `Field "view" ${JSON.stringify(e.key)} has no pinned reference. Pin one with set_reference_image first.`,
						projection_restored: true,
					};
				}
				const d = describeImageDelta(e.ref.data_url, e.shot.data_url);
				// ---- silhouette metrics (compare v2): real deltas, not just byte equality.
				let metrics = null, verdict = null, method = null;
				if (!d.match) {
					const refImg = decodePngRgba(dataUrlToBytes(e.ref.data_url)?.bytes || null);
					const shotImg = decodePngRgba(dataUrlToBytes(e.shot.data_url)?.bytes || null);
					if (refImg && shotImg) {
						const refM = buildSilhouetteMask(refImg, e.threshold);
						const shotM = buildSilhouetteMask(shotImg, e.threshold);
						if (refM.mask && shotM.mask) {
							method = refM.method === 'corners' && shotM.method === 'corners'
								? 'corners'
								: (refM.method === shotM.method ? refM.method : 'alpha+corners');
							const dw = Math.min(refImg.width, shotImg.width);
							const dh = Math.min(refImg.height, shotImg.height);
							const refMask = scaleMask(refM.mask, refImg.width, refImg.height, dw, dh);
							const shotMask = scaleMask(shotM.mask, shotImg.width, shotImg.height, dw, dh);
							metrics = silhouetteMetrics(refMask, shotMask, dw, dh, e.bp.px_per_unit > 0 ? e.bp.px_per_unit : null);
							// ---- verdict from gate (custom or defaults) ----
							const spec = e.gate.mode === 'custom'
								? e.gate.spec
								: { iou: 0.85, area: 0.25, aspect: 0.1, centroid: 0.15 };
							const checks = [];
							checks.push({ name: 'iou', pass: metrics.iou >= spec.iou, threshold: spec.iou, detail: `IoU ${metrics.iou} vs required ${spec.iou}` });
							if (metrics.ref_area > 0) {
								const ratio = metrics.shot_area / metrics.ref_area;
								metrics.area_ratio = +ratio.toFixed(3);
								checks.push({ name: 'area', pass: Math.abs(1 - ratio) <= spec.area, threshold: spec.area, detail: `shot is ${ratio < 1 ? `${(100 - ratio * 100).toFixed(0)}% smaller` : `${(ratio * 100 - 100).toFixed(0)}% larger`} than reference (area ratio ${metrics.area_ratio}, allowed ±${(spec.area * 100).toFixed(0)}%)` });
							}
							if (metrics.aspect_ref > 0 && metrics.aspect_delta_pct !== null) {
								checks.push({ name: 'aspect', pass: Math.abs(metrics.aspect_delta_pct) / 100 <= spec.aspect, threshold: spec.aspect, detail: `aspect ${metrics.aspect_ref}→${metrics.aspect_shot} (${metrics.aspect_delta_pct >= 0 ? '+' : ''}${metrics.aspect_delta_pct}%, allowed ±${(spec.aspect * 100).toFixed(0)}%)` });
							}
							if (metrics.centroid_delta_units) {
								const du = Math.hypot(metrics.centroid_delta_units[0], metrics.centroid_delta_units[1]);
								metrics.centroid_shift_units = +du.toFixed(3);
								checks.push({ name: 'centroid', pass: du <= spec.centroid, threshold: spec.centroid, detail: `centroid shifted ${du.toFixed(2)} model units (allowed ${spec.centroid})` });
							} else if (metrics.centroid_delta_px) {
								const dp = Math.hypot(metrics.centroid_delta_px[0], metrics.centroid_delta_px[1]);
								const dim = Math.max(dw, dh);
								const rel = dim > 0 ? dp / dim : 0;
								metrics.centroid_shift_px = Math.round(dp);
								checks.push({ name: 'centroid', pass: rel <= spec.centroid, threshold: spec.centroid, detail: `centroid shifted ${Math.round(dp)}px (${(rel * 100).toFixed(0)}% of frame, allowed ±${(spec.centroid * 100).toFixed(0)}%)` });
							}
							const failed = checks.filter((c) => !c.pass);
							verdict = {
								pass: failed.length === 0,
								checks: checks.map((c) => ({ name: c.name, pass: c.pass, threshold: c.threshold, detail: c.detail })),
								reasons: failed.map((c) => c.detail),
							};
						}
					}
				}
				return {
					view: e.key,
					match: d.match,
					compared: true,
					identical: !!d.match,
					method,
					metrics,
					verdict,
					delta: d.delta,
					reference: d.reference,
					shot: Object.assign({}, d.shot, {
						ortho: e.shot.ortho,
						px_per_unit: e.shot.px_per_unit,
						wireframe: e.shot.wireframe,
					}),
					projection_restored: e.shot.projection_restored,
				};
			});
			const withVerdict = comparisons.filter((c) => c.verdict);
			return {
				count: comparisons.length,
				matched: comparisons.filter((c) => c.compared && c.match).length,
				differed: comparisons.filter((c) => c.compared && !c.match).length,
				missing: comparisons.filter((c) => !c.compared).map((c) => c.view),
				metrics_passed: withVerdict.filter((c) => c.verdict.pass).length,
				metrics_failed: withVerdict.filter((c) => !c.verdict.pass).length,
				fallback_byte_only: comparisons.filter((c) => c.compared && !c.identical && !c.metrics).length,
				projection_restored: comparisons.every((c) => c.projection_restored),
				comparisons,
			};
		})();
	},

	// A compact playbook the AI can read before building, so models come out
	// detailed and rotated rather than a few flat axis-aligned boxes.
	get_guide(p) {
		const topic = (p && p.topic ? String(p.topic) : 'modeling').toLowerCase();
		const guide = GUIDES[topic];
		if (!guide) {
			return { topic: 'modeling', guide: MODELING_GUIDE, available_topics: Object.keys(GUIDES) };
		}
		return { topic, guide, available_topics: Object.keys(GUIDES) };
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
		let fn;
		try {
			fn = new Function('params', 'Blockbench', '"use strict";\n' + p.code);
		} catch (err) {
			console.error('[BlockbenchMCP] execute_script compile failed:', err);
			throw formatExecuteScriptError(err, 'compile', p.code);
		}
		let result;
		try {
			result = fn(p.params || {}, Blockbench);
		} catch (err) {
			console.error('[BlockbenchMCP] execute_script runtime failed:', err);
			throw formatExecuteScriptError(err, 'runtime', p.code);
		}
		return Promise.resolve(result).then(
			(r) => {
				// Best-effort safe serialization.
				try {
					JSON.stringify(r);
					return r;
				} catch (e) {
					return { value: String(r) };
				}
			},
			(err) => {
				console.error('[BlockbenchMCP] execute_script async rejection:', err);
				throw formatExecuteScriptError(err, 'runtime', p.code);
			}
		);
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
			// Ticket #30: execute_script errors are already linted + truncated
			// (phase/line/message, no raw stack). Full diagnostics stay in the
			// console above; the wire payload stays bounded. Other commands
			// keep their stack, truncated to the same bound.
			const isScriptError = !!err && (err.phase === 'compile' || err.phase === 'runtime');
			const body = {
				ok: false,
				id: payload && payload.id,
				error: truncateText(err && err.message ? err.message : String(err), EXEC_SCRIPT_MAX_CHARS),
			};
			if (isScriptError) {
				body.phase = err.phase;
				body.line = err.line;
			} else if (err && err.stack) {
				body.stack = truncateText(String(err.stack), EXEC_SCRIPT_MAX_CHARS);
			}
			writeResponse(socket, 200, body);
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
	version: '0.2.0',
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
