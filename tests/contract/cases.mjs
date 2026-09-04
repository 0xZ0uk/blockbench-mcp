/**
 * Table-driven contract cases at the MCP tool boundary.
 *
 * Each case sends representative args for one tool and asserts the
 * structured result clients see: schema success vs. structured error
 * naming the offending field. Mirrors the check_model audit style —
 * grouped per-issue lists, not snapshots.
 *
 * Follow-up precision tickets extend this table (add rows); do not add
 * new transport or storage seams.
 *
 * @typedef {{id:string, ticket:string, tool:string, args:Record<string,unknown>, expect:"ok"|"error", errorField?:string}} ContractCase
 */

/** @type {ContractCase[]} */
export const contractCases = [
  // ---- representative good payloads (structured success) ----
  { id: "status-empty", ticket: "#2", tool: "get_status", args: {}, expect: "ok" },
  { id: "check-model-empty", ticket: "#2", tool: "check_model", args: {}, expect: "ok" },
  {
    id: "add-cube-minimal",
    ticket: "#2",
    tool: "add_cube",
    args: { from: [-8, 0, 0], to: [8, 4, 4] },
    expect: "ok",
  },
  {
    id: "add-cube-full",
    ticket: "#2",
    tool: "add_cube",
    args: {
      name: "slide",
      from: [-12, 0, 0],
      to: [12, 4, 4],
      origin: [0, 0, 0],
      rotation: [0, 0, 0],
      inflate: 0,
      parent: "root",
    },
    expect: "ok",
  },
  {
    id: "add-groups-nested",
    ticket: "#2",
    tool: "add_groups",
    args: { groups: [{ name: "slide" }, { name: "grip", parent: "slide" }] },
    expect: "ok",
  },
  {
    id: "add-cubes-pair",
    ticket: "#2",
    tool: "add_cubes",
    args: {
      cubes: [
        { name: "slide-a", from: [0, 0, 0], to: [4, 2, 4] },
        { name: "slide-b", from: [0, 0, 4], to: [4, 2, 8] },
      ],
    },
    expect: "ok",
  },
  { id: "pack-uv-default", ticket: "#2", tool: "pack_uv", args: {}, expect: "ok" },
  {
    id: "pack-uv-all-string",
    ticket: "#2",
    tool: "pack_uv",
    args: { cubes: "all", padding: 1 },
    expect: "ok",
  },
  {
    id: "pack-uv-selected",
    ticket: "#2",
    tool: "pack_uv",
    args: { cubes: ["slide-a", "slide-b"], auto_resize: false },
    expect: "ok",
  },
  {
    id: "detail-cubes-all",
    ticket: "#2",
    tool: "detail_cubes",
    args: { cubes: "all", base: "#6e4a2b" },
    expect: "ok",
  },
  {
    id: "paint-faces-single",
    ticket: "#2",
    tool: "paint_faces",
    args: { cube: "body", face: "north", ops: [{ type: "rect", x: 0, y: 0, width: 4, height: 4 }] },
    expect: "ok",
  },
  {
    id: "edit-element-move",
    ticket: "#2",
    tool: "edit_element",
    args: { element: "slide", to: [24, 4, 4] },
    expect: "ok",
  },
  { id: "get-guide-modeling", ticket: "#2", tool: "get_guide", args: { topic: "modeling" }, expect: "ok" },
  {
    id: "add-plane-facing",
    ticket: "#2",
    tool: "add_plane",
    args: { from: [0, 0, 0], facing: "z" },
    expect: "ok",
  },

  // ---- representative bad payloads (structured error naming the field) ----
  {
    id: "add-cube-missing-from",
    ticket: "#2",
    tool: "add_cube",
    args: { to: [1, 2, 3] },
    expect: "error",
    errorField: "from",
  },
  {
    id: "add-cube-missing-to",
    ticket: "#2",
    tool: "add_cube",
    args: { from: [0, 0, 0] },
    expect: "error",
    errorField: "to",
  },
  {
    id: "add-cube-from-short",
    ticket: "#2",
    tool: "add_cube",
    args: { from: [0, 0], to: [1, 2, 3] },
    expect: "error",
    errorField: "from",
  },
  {
    id: "add-cube-from-non-numeric",
    ticket: "#2",
    tool: "add_cube",
    args: { from: [0, "x", 0], to: [1, 2, 3] },
    expect: "error",
    errorField: "from",
  },
  { id: "add-groups-missing", ticket: "#2", tool: "add_groups", args: {}, expect: "error", errorField: "groups" },
  { id: "add-cubes-missing", ticket: "#2", tool: "add_cubes", args: {}, expect: "error", errorField: "cubes" },
  {
    id: "pack-uv-cubes-type",
    ticket: "#2",
    tool: "pack_uv",
    args: { cubes: 123 },
    expect: "error",
    errorField: "cubes",
  },
  {
    id: "detail-cubes-type",
    ticket: "#2",
    tool: "detail_cubes",
    args: { cubes: 123 },
    expect: "error",
    errorField: "cubes",
  },
  {
    id: "get-guide-topic-enum",
    ticket: "#2",
    tool: "get_guide",
    args: { topic: "bogus" },
    expect: "error",
    errorField: "topic",
  },
  {
    id: "add-plane-facing-enum",
    ticket: "#2",
    tool: "add_plane",
    args: { from: [0, 0, 0], facing: "q" },
    expect: "error",
    errorField: "facing",
  },
  {
    id: "add-keyframe-missing-value",
    ticket: "#2",
    tool: "add_keyframe",
    args: { animation: "anim.walk", bone: "leg", time: 0 },
    expect: "error",
    errorField: "value",
  },
  { id: "delete-element-missing", ticket: "#2", tool: "delete_element", args: {}, expect: "error", errorField: "element" },

  // ---- ticket #3: strict bulk-create schemas (fail fast, field named) ----
  // Valid bulk creates succeed unchanged.
  {
    id: "add-groups-full",
    ticket: "#3",
    tool: "add_groups",
    args: {
      groups: [
        { name: "slide", origin: [0, 0, 0], rotation: [0, 0, 0] },
        { name: "grip", origin: [0, -4, 2], rotation: [15, 0, 0], parent: "slide" },
      ],
    },
    expect: "ok",
  },
  {
    id: "add-cubes-full",
    ticket: "#3",
    tool: "add_cubes",
    args: {
      cubes: [
        {
          name: "slide",
          from: [-12, 0, 0],
          to: [12, 4, 4],
          origin: [0, 0, 0],
          rotation: [0, 0, 0],
          inflate: 0,
          parent: "slide",
          box_uv: true,
          uv_offset: [0, 0],
          faces: { north: { uv: [0, 0, 4, 4] } },
        },
      ],
    },
    expect: "ok",
  },
  // Bulk cube items require from/to as 3-element numeric arrays.
  {
    id: "add-cubes-item-missing-from",
    ticket: "#3",
    tool: "add_cubes",
    args: { cubes: [{ name: "bad", to: [1, 2, 3] }] },
    expect: "error",
    errorField: "cubes[0].from",
  },
  {
    id: "add-cubes-item-missing-to",
    ticket: "#3",
    tool: "add_cubes",
    args: { cubes: [{ name: "bad", from: [0, 0, 0] }] },
    expect: "error",
    errorField: "cubes[0].to",
  },
  {
    id: "add-cubes-item-from-short",
    ticket: "#3",
    tool: "add_cubes",
    args: { cubes: [{ name: "bad", from: [0, 0], to: [1, 2, 3] }] },
    expect: "error",
    errorField: "cubes[0].from",
  },
  {
    id: "add-cubes-item-from-non-numeric",
    ticket: "#3",
    tool: "add_cubes",
    args: { cubes: [{ name: "bad", from: [0, "x", 0], to: [1, 2, 3] }] },
    expect: "error",
    errorField: "cubes[0].from",
  },
  {
    id: "add-cubes-item-to-short",
    ticket: "#3",
    tool: "add_cubes",
    args: { cubes: [{ name: "bad", from: [0, 0, 0], to: [1, 2] }] },
    expect: "error",
    errorField: "cubes[0].to",
  },
  // Bulk group and cube items reject unknown properties (typos fail fast).
  {
    id: "add-cubes-item-unknown-prop",
    ticket: "#3",
    tool: "add_cubes",
    args: { cubes: [{ name: "bad", from: [0, 0, 0], to: [1, 2, 3], frm: [0, 0, 0] }] },
    expect: "error",
    errorField: "cubes[0].frm",
  },
  {
    id: "add-groups-item-unknown-prop",
    ticket: "#3",
    tool: "add_groups",
    args: { groups: [{ name: "g", bogus: 1 }] },
    expect: "error",
    errorField: "groups[0].bogus",
  },
  {
    id: "add-groups-item-origin-short",
    ticket: "#3",
    tool: "add_groups",
    args: { groups: [{ name: "g", origin: [0, 0] }] },
    expect: "error",
    errorField: "groups[0].origin",
  },
];
