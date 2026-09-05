/**
 * Space-audit tests — drive the REAL bridge handler (plugin/blockbench_mcp.js
 * check_model) with stubbed Blockbench globals, no live Blockbench, no ports.
 *
 * Table-driven: each fixture isolates one finding class.
 * - gap_slit: crack-thin see-through void (edge-to-edge junctions) -> ERROR.
 * - see_through_opening: larger see-through void -> WARNING (verify).
 * - floating_piece: piece disconnected in 3D -> WARNING.
 * Legal 3D openings (notches, C-shapes) and sealed cavities stay silent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

class Cube {
  constructor({ name, uuid, from, to, rotation = [0, 0, 0], faces = {} }) {
    this.name = name;
    this.uuid = uuid ?? `uuid-${name}`;
    this.from = from;
    this.to = to;
    this.rotation = rotation;
    this.faces = faces;
    this.parent = "root";
  }
}
class Group {
  constructor({ name, uuid, children = [] }) {
    this.name = name;
    this.uuid = uuid ?? `uuid-${name}`;
    this.children = children;
  }
}

const pluginPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../plugin/blockbench_mcp.js");
let src = fs.readFileSync(pluginPath, "utf8");
const cutAt = src.indexOf("// Plugin registration");
assert.ok(cutAt > 0, "plugin must contain the registration marker");
src = `${src.slice(0, cutAt)}\nglobalThis.__COMMANDS__ = commands;\nglobalThis.__AUDIT__ = { auditSpaceGaps, auditProjectFootprint, floodOutside, emptyRegions, solidIslands };\nglobalThis.__MESH__ = meshPrimitive;\n})();\n`;

const sb = {
  console, Buffer, JSON, Math, Object, Array, Number, String, Boolean, Infinity,
  Project: { texture_width: 16, texture_height: 16 },
  Format: { animation_mode: false },
  Formats: {},
  Group, Cube,
  Outliner: { elements: [] },
  Texture: { all: [] },
  Animation: { all: [] },
  Undo: { initEdit() {}, finishEdit() {} },
  Canvas: { updateAll() {} },
  Plugin: { register() {} },
  MenuBar: { addAction() {} },
  require: () => { throw new Error("net unavailable in tests"); },
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(src, sb, { filename: "blockbench_mcp.js" });
const commands = sb.__COMMANDS__;
const audit = sb.__AUDIT__;
assert.ok(commands?.check_model, "plugin must expose check_model");
assert.ok(audit?.auditSpaceGaps, "plugin must expose auditSpaceGaps for tests");

/** vm-realm objects carry a different prototype: compare via JSON round-trip. */
const plain = (v) => JSON.parse(JSON.stringify(v));

function reset(cubeSpecs, { textures = [] } = {}) {
  const cubes = cubeSpecs.map((s) => new Cube(s));
  sb.Cube.all = cubes;
  sb.Group.all = [];
  sb.Outliner.elements = [...cubes];
  sb.Texture.all = textures.map((t) => ({ name: t.name ?? null, uuid: t.uuid ?? `uuid-${t.name}` }));
  sb.Format.animation_mode = false;
  return { cubes };
}

const texFaces = () => ({ up: { texture: "uuid-skin", uv: [0, 0, 2, 2] } });

test("space audit: hairline slit between stacked slabs is a gap_slit error", () => {
  // Two 12u slabs separated by a 1u crack in y, end caps sealing the crack
  // so it is enclosed in the z (side) projection — a real see-through slit.
  reset([
    { name: "upper", from: [0.5, 3, 0], to: [12, 5, 4], faces: texFaces() },
    { name: "lower", from: [0.5, 0, 0], to: [12, 2, 4], faces: texFaces() },
    { name: "cap-left", from: [0, 0, 0], to: [0.5, 5, 4], faces: texFaces() },
    { name: "cap-right", from: [12, 0, 0], to: [12.5, 5, 4], faces: texFaces() },
  ]);
  const res = plain(commands.check_model({}));
  assert.equal(res.by_type.gap_slit, 1, `expected gap_slit, got ${JSON.stringify(res.by_type)}`);
  assert.equal(res.gate.errors, 1);
  assert.equal(res.gate.gate_pass, false);
  const slit = res.issues.find((i) => i.issue === "gap_slit");
  assert.equal(slit.dim_min, 1);
  assert.equal(slit.dim_max, 11, "crack spans the unsealed stretch (cell-quantized)");
});

test("space audit: no flag on fully solid model", () => {
  reset([{ name: "solid", from: [0, 0, 0], to: [6, 6, 6], faces: texFaces() }]);
  const res = plain(commands.check_model({}));
  assert.equal(res.by_type.gap_slit, undefined);
  assert.equal(res.by_type.see_through_opening, undefined);
  assert.equal(res.by_type.floating_piece, undefined);
  assert.equal(res.gate.gate_pass, true);
});

test("space audit: AK-style edge-to-edge junction (wood meets barrel line) convicts", () => {
  // The handguard slit from the review: the wood's top edge stops 1u short of
  // the metal line and neighbouring blocks seal both ends of the crack in
  // side view — you see daylight straight through.
  reset([
    { name: "barrel-line", from: [4, 5, 0], to: [20, 6, 2], faces: texFaces() },
    { name: "handguard", from: [4, 1, 0], to: [16, 4, 2], faces: texFaces() },
    { name: "rear-block", from: [0, 1, 0], to: [4, 6, 2], faces: texFaces() },
    { name: "muzzle-block", from: [16, 1, 0], to: [20, 6, 2], faces: texFaces() },
  ]);
  const res = plain(commands.check_model({}));
  assert.equal(res.by_type.gap_slit, 1, `expected the edge-to-edge slit, got ${JSON.stringify(res.by_type)}`);
  const slit = res.issues.find((i) => i.issue === "gap_slit");
  assert.equal(slit.axis, "z", "the crack is visible from the z (side) projection");
  assert.equal(slit.dim_min, 1);
});

test("space audit: bridged junction (overlap) passes clean", () => {
  // Same layout, but the handguard reaches INTO the barrel line (top edge at
  // y=5.5 overlaps the tube's y=5 bottom) and penetrates the rear block by
  // 0.5 in x. Every overlapping pair is offset so no two faces share a plane
  // (the coplanar audit runs on the same fixtures — keep it quiet here).
  reset([
    { name: "barrel-line", from: [4, 5, 0.5], to: [20, 6, 2], faces: texFaces() },
    { name: "handguard", from: [3.5, 0.75, 0], to: [16, 5.5, 1.5], faces: texFaces() },
    { name: "rear-block", from: [0, 1, 0.25], to: [4, 6, 1.75], faces: texFaces() },
    { name: "muzzle-block", from: [16, 0.85, 0.25], to: [20.5, 6.5, 1.75], faces: texFaces() },
  ]);
  const res = plain(commands.check_model({}));
  assert.equal(res.by_type.gap_slit, undefined, `must not flag overlapped junction: ${JSON.stringify(res.by_type)}`);
  assert.equal(res.gate.gate_pass, true, `gate must pass: ${JSON.stringify(res.issues.map((i) => i.issue))}`);
});

test("space audit: large see-through window is a warning, not an error", () => {
  // Frame with a wide rectangular window (4x4 in a 12x12 wall), depth-
  // staggered so the four wall cubes don't z-fight with each other.
  reset([
    { name: "wall-top", from: [0, 8, 0], to: [12, 12, 4], faces: texFaces() },
    { name: "wall-bottom", from: [0, 0, 0], to: [12, 4, 4], faces: texFaces() },
    { name: "wall-left", from: [0, 4, 0], to: [4, 8, 4], faces: texFaces() },
    { name: "wall-right", from: [8, 4, 0], to: [12, 8, 4], faces: texFaces() },
  ]);
  const res = plain(commands.check_model({}));
  assert.equal(res.by_type.see_through_opening, 1, `expected opening, got ${JSON.stringify(res.by_type)}`);
  assert.equal(res.by_type.gap_slit, undefined, "a wide window is not a crack-thin slit");
  assert.equal(res.gate.errors, 0, "openings warn, they do not fail the gate");
  assert.equal(res.gate.warnings, 1);
  assert.equal(res.gate.gate_pass, true);
});

test("space audit: sealed interior cavity stays silent (hidden in projection)", () => {
  // Solid shell with a hollow core — invisible from outside, never reported.
  reset([
    { name: "shell-top", from: [0, 4, 0], to: [12, 6, 6], faces: texFaces() },
    { name: "shell-bottom", from: [0, 0, 0], to: [12, 2, 6], faces: texFaces() },
    { name: "shell-left", from: [0, 0, 0], to: [12, 6, 2], faces: texFaces() },
    { name: "shell-right", from: [0, 0, 4], to: [12, 6, 6], faces: texFaces() },
    { name: "shell-front", from: [0, 0, 0], to: [2, 6, 6], faces: texFaces() },
    { name: "shell-back", from: [10, 0, 0], to: [12, 6, 6], faces: texFaces() },
  ]);
  const res = plain(commands.check_model({}));
  assert.equal(res.by_type.see_through_opening, undefined);
  assert.equal(res.by_type.gap_slit, undefined);
});

test("space audit: fully-detached cube is a floating_piece warning", () => {
  reset([
    { name: "body", from: [0, 0, 0], to: [8, 8, 8], faces: texFaces() },
    { name: "floater", from: [20, 0, 0], to: [24, 4, 4], faces: texFaces() },
  ]);
  const res = plain(commands.check_model({}));
  assert.equal(res.by_type.floating_piece, 1, `expected floating_piece, got ${JSON.stringify(res.by_type)}`);
  assert.equal(res.gate.errors, 0);
  assert.equal(res.gate.warnings, 1);
  assert.equal(res.gate.gate_pass, true);
  const fp = res.issues.find((i) => i.issue === "floating_piece");
  assert.deepEqual(fp.cubes, ["floater"]);
});

test("space audit: touching cubes count as connected (no false floating)", () => {
  reset([
    { name: "receiver", from: [0, 0, 0], to: [8, 8, 8], faces: texFaces() },
    { name: "stock", from: [8, 2, 2], to: [16, 6, 6], faces: texFaces() },
    { name: "grip", from: [2, -6, 2], to: [6, 0, 6], faces: texFaces() },
  ]);
  const res = plain(commands.check_model({}));
  assert.equal(res.by_type.floating_piece, undefined);
  assert.equal(res.gate.gate_pass, true);
});

test("space audit: audit_space.enabled=false skips the scan entirely", () => {
  reset([
    { name: "upper", from: [0, 3, 0], to: [12, 5, 4], faces: texFaces() },
    { name: "lower", from: [0, 0, 0], to: [12, 2, 4], faces: texFaces() },
  ]);
  const off = plain(commands.check_model({ audit_space: { enabled: false } }));
  assert.equal(off.by_type.gap_slit, undefined);
  assert.equal(off.gate.errors, 0);
});

test("space audit: rotated cubes are exempt (bounding-box projection would lie)", () => {
  const cubes = [
    new Cube({ name: "upper", from: [0, 3, 0], to: [12, 5, 4], faces: texFaces() }),
    new Cube({ name: "lower", from: [0, 0, 0], to: [12, 2, 4], faces: texFaces() }),
    new Cube({ name: "tilted", from: [0, 0, 0], to: [2, 2, 2], rotation: [0, 45, 0] }),
  ];
  reset(cubes.map((c) => ({ name: c.name, from: c.from, to: c.to, rotation: c.rotation, faces: c.faces })));
  const res = plain(commands.check_model({}));
  assert.equal(res.by_type.gap_slit, undefined, "rotated cube must not expand projections");
});

test("space audit: sub-quarter-unit gaps stay quiet", () => {
  reset([
    { name: "a", from: [0, 0, 0], to: [4, 4, 4], faces: texFaces() },
    { name: "b", from: [4, 0.1, 0.1], to: [8, 3.9, 3.9], faces: texFaces() },
  ]);
  const res = plain(commands.check_model({}));
  // The 0.2u x 3.8u crack is real but hairline-thin AND tiny — under the
  // AUDIT_MIN_AREA_UNITS floor it must not flood the issue list.
  assert.equal(res.by_type.gap_slit, undefined);
  assert.equal(res.gate.gate_pass, true);
});

test("audit helpers: grid caps at AUDIT_GRID_MAX", () => {
  // axis=0 projects onto the YZ plane: span (300,200) -> scale ceil(300/160)=2
  const cubes = [new Cube({ name: "huge", from: [0, 0, 0], to: [500, 300, 200], faces: {} })];
  const proj = plain(audit.auditProjectFootprint(cubes, 0));
  assert.ok(proj.nx <= 160 && proj.ny <= 160, `grid must cap at 160: got ${proj.nx}x${proj.ny}`);
  assert.equal(proj.scale, 2, `scale must step up for span 300 (ceil(300/160)=2): got ${proj.scale}`);
});

test("audit helpers: floodOutside marks border-connected region only", () => {
  // 6x5 grid: solid columns x=0 and x=2, rows y=0/y=4, right wall x=5 with a
  // doorway at (5,2). Left pocket (1,1..3) is sealed by wall+x=0+rows; the
  // right region drains through the doorway.
  const nx = 6, ny = 5;
  const solid = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++)
      if (x === 0 || x === 2 || y === 0 || y === 4 || x === 5) solid[y * nx + x] = 1;
  solid[2 * nx + 5] = 0; // the doorway
  const outside = plain(audit.floodOutside(solid, nx, ny));
  assert.equal(solid[1 * nx + 1], 0, "fixture sanity: pocket cell (1,1) is empty");
  assert.equal(outside[1 * nx + 1], 0, "sealed left pocket must not be outside");
  assert.equal(outside[2 * nx + 5], 1, "the doorway itself is outside-connected");
  assert.equal(outside[2 * nx + 3], 1, "right region drains through the doorway");
  assert.equal(outside[2 * nx + 2], 0, "solid wall cells are never outside");
});

test("audit helpers: emptyRegions finds the enclosed component", () => {
  const nx = 6, ny = 6;
  const solid = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++)
      if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1 || (x >= 1 && x <= 3 && y >= 1 && y <= 2)) solid[y * nx + x] = 1;
  const outside = plain(audit.floodOutside(solid, nx, ny));
  const regions = plain(audit.emptyRegions(solid, outside, nx, ny));
  const enclosed = regions.filter((r) => !r.touchesBorder);
  assert.equal(enclosed.length, 1);
  assert.equal(enclosed[0].area, 10, `enclosed empty area must be 10 cells (4x4 frame minus 3x2 block), got ${enclosed[0].area}`);
});

test("audit helpers: solidIslands splits disconnected masses", () => {
  const nx = 8, ny = 4;
  const solid = new Uint8Array(nx * ny);
  // left block (x 0-2) and right block (x 5-7), gap at x=3-4
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x <= 2; x++) solid[y * nx + x] = 1;
    for (let x = 5; x <= 7; x++) solid[y * nx + x] = 1;
  }
  const islands = plain(audit.solidIslands(solid, nx, ny));
  assert.equal(islands.length, 2, `expected 2 islands, got ${islands.length}`);
});

test("arc primitive: verts/faces counts and closed geometry", () => {
  const mp = sb.__MESH__;
  assert.ok(mp, "plugin must expose meshPrimitive for tests");
  const prim = plain(mp("arc", 20, 4, 2, 8, 90));
  // segments=8 -> 9 rings -> 8 quads per wall x4 walls + 2 caps
  assert.equal(prim.faces.length, 8 * 4 + 2, `expected 34 faces, got ${prim.faces.length}`);
  assert.equal(prim.verts.length, 9 * 4, `expected 36 verts (9 rings x 4 corners), got ${prim.verts.length}`);
  // every face index must be a real vertex
  for (const f of prim.faces) for (const idx of f) assert.ok(idx >= 0 && idx < prim.verts.length, `face index ${idx} out of range`);
  // ring 0 starts at +x; the cross-section is centred on the ring centre at
  // x=r, so its z-extents are 0 and 2*tube (normal at angle 0 is -z).
  const v0 = prim.verts[0];
  assert.ok(Math.abs(v0[0] - 9) < 1e-6, `first vert x should be r-tube=9, got ${v0[0]}`);
  assert.ok(Math.abs(v0[2] - 0) < 1e-6, `first vert z should be 0, got ${v0[2]}`);
  // 90deg sweep: the last ring sits on the +z axis (x ~= 0)
  const nRings = prim.verts.length / 4;
  const lastRingX = prim.verts[(nRings - 1) * 4][0];
  assert.ok(Math.abs(lastRingX) < 1e-6, `90deg sweep: last ring x should be ~0, got ${lastRingX}`);
  // watertight: every vertex referenced by at least one face
  const used = new Set();
  for (const f of prim.faces) for (const idx of f) used.add(idx);
  assert.equal(used.size, prim.verts.length, "every vertex must belong to a face (watertight mesh)");
});
