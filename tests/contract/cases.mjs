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
  {
    id: "add-cubes-dedupe",
    ticket: "#19",
    tool: "add_cubes",
    args: {
      dedupe_by_name: true,
      cubes: [{ name: "slide-a", from: [0, 0, 0], to: [4, 2, 4] }],
    },
    expect: "ok",
  },
  {
    id: "add-groups-dedupe",
    ticket: "#19",
    tool: "add_groups",
    args: { dedupe_by_name: true, groups: [{ name: "slide" }] },
    expect: "ok",
  },
  {
    id: "add-cubes-dedupe-bad-type",
    ticket: "#19",
    tool: "add_cubes",
    args: {
      dedupe_by_name: "yes",
      cubes: [{ name: "slide-a", from: [0, 0, 0], to: [4, 2, 4] }],
    },
    expect: "error",
    errorField: "dedupe_by_name",
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
  // ---- ticket #4: bulk edit/delete (success, partial-failure-safe schemas, resolution) ----
  {
    id: "edit-elements-batch-ok",
    ticket: "#4",
    tool: "edit_elements",
    args: {
      edits: [
        { element: "slide", patch: { to: [24, 4, 4] } },
        { element: "grip", patch: { rotation: [0, 15, 0], parent: "root" } },
      ],
    },
    expect: "ok",
  },
  {
    id: "edit-elements-uuid-ok",
    ticket: "#4",
    tool: "edit_elements",
    args: { edits: [{ element: "550e8400-e29b-41d4-a716-446655440000", patch: { from: [0, 0, 0] } }] },
    expect: "ok",
  },
  {
    id: "edit-elements-mixed-batch-ok",
    ticket: "#4",
    tool: "edit_elements",
    args: {
      edits: [
        { element: "slide", patch: { to: [24, 4, 4] } },
        { element: "missing-part", patch: { rotation: [0, 0, 0] } },
      ],
    },
    expect: "ok",
  },
  {
    id: "delete-elements-batch-ok",
    ticket: "#4",
    tool: "delete_elements",
    args: { elements: ["slide", "grip"] },
    expect: "ok",
  },
  {
    id: "delete-elements-uuid-ok",
    ticket: "#4",
    tool: "delete_elements",
    args: { elements: ["550e8400-e29b-41d4-a716-446655440000"] },
    expect: "ok",
  },
  { id: "edit-elements-missing", ticket: "#4", tool: "edit_elements", args: {}, expect: "error", errorField: "edits" },
  { id: "delete-elements-missing", ticket: "#4", tool: "delete_elements", args: {}, expect: "error", errorField: "elements" },
  {
    id: "edit-elements-item-missing-element",
    ticket: "#4",
    tool: "edit_elements",
    args: { edits: [{ patch: { to: [1, 2, 3] } }] },
    expect: "error",
    errorField: "edits",
  },
  {
    id: "delete-elements-item-type",
    ticket: "#4",
    tool: "delete_elements",
    args: { elements: [123] },
    expect: "error",
    errorField: "elements",
  },
  {
    id: "edit-elements-empty",
    ticket: "#4",
    tool: "edit_elements",
    args: { edits: [] },
    expect: "error",
    errorField: "edits",
  },
  {
    id: "delete-elements-empty",
    ticket: "#4",
    tool: "delete_elements",
    args: { elements: [] },
    expect: "error",
    errorField: "elements",
  },

  // ---- ticket #5: measure bounding boxes and model dims ----
  // Single-element box, group box incl. children, and overall model dims.
  {
    id: "measure-element",
    ticket: "#5",
    tool: "measure",
    args: { mode: "element", element: "slide" },
    expect: "ok",
  },
  { id: "measure-group", ticket: "#5", tool: "measure", args: { mode: "group", group: "slide" }, expect: "ok" },
  { id: "measure-model", ticket: "#5", tool: "measure", args: { mode: "model" }, expect: "ok" },
  { id: "measure-missing-mode", ticket: "#5", tool: "measure", args: {}, expect: "error", errorField: "mode" },
  {
    id: "measure-bad-mode",
    ticket: "#5",
    tool: "measure",
    args: { mode: "bogus" },
    expect: "error",
    errorField: "mode",
  },
  {
    id: "measure-element-type",
    ticket: "#5",
    tool: "measure",
    args: { mode: "element", element: 123 },
    expect: "error",
    errorField: "element",
  },

  // ---- ticket #8: explicit scope enum for UV, detail, paint ----
  // Explicit scope, defaulted (omitted) scope, and legacy 'all' tolerance.
  {
    id: "scope-pack-uv-explicit-all",
    ticket: "#8",
    tool: "pack_uv",
    args: { scope: "all", padding: 1 },
    expect: "ok",
  },
  {
    id: "scope-pack-uv-selected",
    ticket: "#8",
    tool: "pack_uv",
    args: { scope: "selected", elements: ["slide-a", "slide-b"], auto_resize: false },
    expect: "ok",
  },
  {
    id: "scope-pack-uv-implied-selected",
    ticket: "#8",
    tool: "pack_uv",
    args: { elements: ["slide-a"] },
    expect: "ok",
  },
  {
    id: "scope-pack-uv-defaulted",
    ticket: "#8",
    tool: "pack_uv",
    args: { padding: 2, auto_resize: false },
    expect: "ok",
  },
  {
    id: "scope-pack-uv-legacy-single",
    ticket: "#8",
    tool: "pack_uv",
    args: { cubes: "slide-a" },
    expect: "ok",
  },
  {
    id: "scope-pack-uv-bad-scope",
    ticket: "#8",
    tool: "pack_uv",
    args: { scope: "everything" },
    expect: "error",
    errorField: "scope",
  },
  {
    id: "scope-pack-uv-empty-elements",
    ticket: "#8",
    tool: "pack_uv",
    args: { scope: "selected", elements: [] },
    expect: "error",
    errorField: "elements",
  },
  {
    id: "scope-pack-uv-elements-empty-implied",
    ticket: "#8",
    tool: "pack_uv",
    args: { elements: [] },
    expect: "error",
    errorField: "elements",
  },
  {
    id: "scope-detail-selected",
    ticket: "#8",
    tool: "detail_cubes",
    args: { scope: "selected", elements: ["body"], base: "#6e4a2b" },
    expect: "ok",
  },
  {
    id: "scope-detail-explicit-all",
    ticket: "#8",
    tool: "detail_cubes",
    args: { scope: "all" },
    expect: "ok",
  },
  {
    id: "scope-detail-defaulted",
    ticket: "#8",
    tool: "detail_cubes",
    args: { base: "#6e4a2b" },
    expect: "ok",
  },
  {
    id: "scope-detail-bad-elements",
    ticket: "#8",
    tool: "detail_cubes",
    args: { scope: "selected", elements: "body" },
    expect: "error",
    errorField: "elements",
  },
  {
    id: "scope-paint-face-enum-array",
    ticket: "#8",
    tool: "paint_faces",
    args: {
      cube: "body",
      face: ["north", "up"],
      ops: [{ type: "rect", x: 0, y: 0, width: 4, height: 4 }],
    },
    expect: "ok",
  },
  {
    id: "scope-paint-face-all-legacy",
    ticket: "#8",
    tool: "paint_faces",
    args: {
      cube: "body",
      face: "all",
      ops: [{ type: "rect", x: 0, y: 0, width: 4, height: 4 }],
    },
    expect: "ok",
  },
  {
    id: "scope-paint-face-bad-dir",
    ticket: "#8",
    tool: "paint_faces",
    args: {
      cube: "body",
      face: "sideways",
      ops: [{ type: "rect", x: 0, y: 0, width: 4, height: 4 }],
    },
    expect: "error",
    errorField: "face",
  },
  {
    id: "scope-paint-face-bad-dir-array",
    ticket: "#8",
    tool: "paint_faces",
    args: {
      cube: "body",
      face: ["north", "sideways"],
      ops: [{ type: "rect", x: 0, y: 0, width: 4, height: 4 }],
    },
    expect: "error",
    errorField: "face",
  },
  {
    id: "scope-paint-selected",
    ticket: "#8",
    tool: "paint_faces",
    args: {
      scope: "selected",
      elements: ["body"],
      face: "north",
      ops: [{ type: "rect", x: 0, y: 0, width: 4, height: 4 }],
    },
    expect: "ok",
  },
  {
    id: "scope-paint-explicit-all",
    ticket: "#8",
    tool: "paint_faces",
    args: {
      scope: "all",
      face: "up",
      ops: [{ type: "rect", x: 0, y: 0, width: 4, height: 4 }],
    },
    expect: "ok",
  },
  {
    id: "scope-paint-selected-face-array",
    ticket: "#8",
    tool: "paint_faces",
    args: {
      scope: "selected",
      elements: ["body"],
      face: ["north", "up"],
      ops: [{ type: "rect", x: 0, y: 0, width: 4, height: 4 }],
    },
    expect: "ok",
  },
  {
    id: "scope-paint-batch-defaulted",
    ticket: "#8",
    tool: "paint_faces",
    args: { faces: [{ cube: "body", face: "north" }] },
    expect: "ok",
  },

  // ---- ticket #6: measure distance and clearance ----
  // Distance between two refs, clearance scan (hit/clean via handler tests),
  // plus schema guards for the new fields.
  {
    id: "measure-distance",
    ticket: "#6",
    tool: "measure",
    args: { mode: "distance", a: "slide-a", b: "slide-b" },
    expect: "ok",
  },
  { id: "measure-clearance", ticket: "#6", tool: "measure", args: { mode: "clearance" }, expect: "ok" },
  {
    id: "measure-distance-a-type",
    ticket: "#6",
    tool: "measure",
    args: { mode: "distance", a: 123, b: "slide-b" },
    expect: "error",
    errorField: "a",
  },
  {
    id: "measure-distance-b-type",
    ticket: "#6",
    tool: "measure",
    args: { mode: "distance", a: "slide-a", b: 123 },
    expect: "error",
    errorField: "b",
  },

  // ---- ticket #7: blueprint orthographic screenshots ----
  // Ortho side/front/top captures per call or per view; camera semantics unchanged.
  { id: "screenshot-views-default", ticket: "#7", tool: "screenshot_views", args: {}, expect: "ok" },
  {
    id: "screenshot-views-blueprint-call",
    ticket: "#7",
    tool: "screenshot_views",
    args: { views: ["front", "top"], ortho: true, px_per_unit: 8, wireframe: false },
    expect: "ok",
  },
  {
    id: "screenshot-views-blueprint-per-view",
    ticket: "#7",
    tool: "screenshot_views",
    args: {
      views: [
        { view: "front", ortho: true, px_per_unit: 8 },
        { view: { position: [0, 8, 32], target: [0, 8, 0] }, wireframe: true },
      ],
    },
    expect: "ok",
  },
  {
    id: "screenshot-views-ortho-type",
    ticket: "#7",
    tool: "screenshot_views",
    args: { views: ["front"], ortho: "yes" },
    expect: "error",
    errorField: "ortho",
  },
  {
    id: "screenshot-views-px-type",
    ticket: "#7",
    tool: "screenshot_views",
    args: { views: ["front"], px_per_unit: "8" },
    expect: "error",
    errorField: "px_per_unit",
  },
  {
    id: "screenshot-views-wireframe-type",
    ticket: "#7",
    tool: "screenshot_views",
    args: { views: ["front"], wireframe: "yes" },
    expect: "error",
    errorField: "wireframe",
  },

  // ---- ticket #24: query_elements paged, filtered lookups ----
  // Filters + paging schemas; bridge filtering math is pinned in
  // query-elements.test.mjs (real handlers, stubbed globals).
  { id: "query-elements-empty-args", ticket: "#24", tool: "query_elements", args: {}, expect: "ok" },
  { id: "query-elements-regex", ticket: "#24", tool: "query_elements", args: { regex: "^leg|arm_" }, expect: "ok" },
  { id: "query-elements-parent", ticket: "#24", tool: "query_elements", args: { parent: "slide" }, expect: "ok" },
  {
    id: "query-elements-all-filters",
    ticket: "#24",
    tool: "query_elements",
    args: { regex: "leg", parent: "slide", limit: 5, offset: 5 },
    expect: "ok",
  },
  { id: "query-elements-limit-type", ticket: "#24", tool: "query_elements", args: { limit: "10" }, expect: "error", errorField: "limit" },
  { id: "query-elements-limit-float", ticket: "#24", tool: "query_elements", args: { limit: 1.5 }, expect: "error", errorField: "limit" },
  { id: "query-elements-offset-type", ticket: "#24", tool: "query_elements", args: { offset: true }, expect: "error", errorField: "offset" },
  { id: "query-elements-offset-float", ticket: "#24", tool: "query_elements", args: { offset: 2.5 }, expect: "error", errorField: "offset" },
  { id: "query-elements-regex-type", ticket: "#24", tool: "query_elements", args: { regex: 42 }, expect: "error", errorField: "regex" },
  { id: "query-elements-parent-type", ticket: "#24", tool: "query_elements", args: { parent: 42 }, expect: "error", errorField: "parent" },
  {
    id: "query-elements-unknown-prop",
    ticket: "#24",
    tool: "query_elements",
    args: { bogus: 1 },
    expect: "error",
    errorField: "bogus",
  },

  // ---- ticket #25: set_reference_image pin/unpin ----
  // Pin per view (preset id or explicit {position,target}) from a path or
  // inline image; empty source unpins. Handler round-trip (pin -> readable
  // state, unpin -> cleared) plus bridge error fields are pinned in
  // set-reference-image.test.mjs (real bridge handler, stubbed globals).
  {
    id: "set-reference-preset-inline",
    ticket: "#25",
    tool: "set_reference_image",
    args: {
      view: "front",
      source:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    },
    expect: "ok",
  },
  {
    id: "set-reference-explicit-view",
    ticket: "#25",
    tool: "set_reference_image",
    args: { view: { position: [0, 8, 32], target: [0, 8, 0] }, source: "/tmp/ref-front.png" },
    expect: "ok",
  },
  {
    id: "set-reference-unpin-empty",
    ticket: "#25",
    tool: "set_reference_image",
    args: { view: "front", source: "" },
    expect: "ok",
  },
  { id: "set-reference-missing-view", ticket: "#25", tool: "set_reference_image", args: { source: "" }, expect: "error", errorField: "view" },
  { id: "set-reference-missing-source", ticket: "#25", tool: "set_reference_image", args: { view: "front" }, expect: "error", errorField: "source" },
  { id: "set-reference-view-type", ticket: "#25", tool: "set_reference_image", args: { view: 42, source: "" }, expect: "error", errorField: "view" },
  { id: "set-reference-view-empty-object", ticket: "#25", tool: "set_reference_image", args: { view: {}, source: "" }, expect: "error", errorField: "view" },
  { id: "set-reference-view-partial", ticket: "#25", tool: "set_reference_image", args: { view: { position: [0, 0, 0] }, source: "" }, expect: "error", errorField: "view" },
  { id: "set-reference-view-array", ticket: "#25", tool: "set_reference_image", args: { view: ["front"], source: "" }, expect: "error", errorField: "view" },
  { id: "set-reference-source-type", ticket: "#25", tool: "set_reference_image", args: { view: "front", source: 42 }, expect: "error", errorField: "source" },
  {
    id: "set-reference-unknown-prop",
    ticket: "#25",
    tool: "set_reference_image",
    args: { view: "front", source: "", bogus: 1 },
    expect: "error",
    errorField: "bogus",
  },

  // ---- ticket #26: compare_views structured delta text ----
  // Same camera semantics as screenshot_views; views is required (no
  // default set — nothing to compare without requested views). Handler
  // round-trips (missing reference, unchanged model, pin -> edit ->
  // compare) plus restore guarantees are pinned in
  // compare-views.test.mjs (real bridge handler, stubbed globals).
  { id: "compare-views-preset", ticket: "#26", tool: "compare_views", args: { views: ["front"] }, expect: "ok" },
  {
    id: "compare-views-blueprint-per-view",
    ticket: "#26",
    tool: "compare_views",
    args: {
      views: [
        { view: "front", ortho: true, px_per_unit: 8 },
        { view: { position: [0, 8, 32], target: [0, 8, 0] }, wireframe: true },
      ],
    },
    expect: "ok",
  },
  {
    id: "compare-views-blueprint-call",
    ticket: "#26",
    tool: "compare_views",
    args: { views: ["front", "top"], ortho: true, px_per_unit: 8 },
    expect: "ok",
  },
  { id: "compare-views-missing-views", ticket: "#26", tool: "compare_views", args: {}, expect: "error", errorField: "views" },
  { id: "compare-views-views-type", ticket: "#26", tool: "compare_views", args: { views: "front" }, expect: "error", errorField: "views" },
  { id: "compare-views-views-empty", ticket: "#26", tool: "compare_views", args: { views: [] }, expect: "error", errorField: "views" },
  {
    id: "compare-views-ortho-type",
    ticket: "#26",
    tool: "compare_views",
    args: { views: ["front"], ortho: "yes" },
    expect: "error",
    errorField: "ortho",
  },
  {
    id: "compare-views-px-type",
    ticket: "#26",
    tool: "compare_views",
    args: { views: ["front"], px_per_unit: "8" },
    expect: "error",
    errorField: "px_per_unit",
  },
  {
    id: "compare-views-wireframe-type",
    ticket: "#26",
    tool: "compare_views",
    args: { views: ["front"], wireframe: "yes" },
    expect: "error",
    errorField: "wireframe",
  },
  {
    id: "compare-views-unknown-prop",
    ticket: "#26",
    tool: "compare_views",
    args: { views: ["front"], bogus: 1 },
    expect: "error",
    errorField: "bogus",
  },

  // ---- ticket #27: smooth_bake native tool (promoted skill snippet) ----
  // Same scope contract as detail_cubes; handler parity (gradient +
  // mottle + per-island blur on a fixture model) is pinned in
  // smooth-bake.test.mjs (real bridge handler, stubbed globals).
  { id: "smooth-bake-default", ticket: "#27", tool: "smooth_bake", args: {}, expect: "ok" },
  {
    id: "smooth-bake-palette",
    ticket: "#27",
    tool: "smooth_bake",
    args: {
      base: "#6e4f30",
      colors: [{ match: "leg|paw", color: "#5a3d22" }],
      noise: 0.13,
      blur: 0.55,
    },
    expect: "ok",
  },
  {
    id: "smooth-bake-scope-selected",
    ticket: "#27",
    tool: "smooth_bake",
    args: { scope: "selected", elements: ["body"] },
    expect: "ok",
  },
  {
    id: "smooth-bake-legacy-cubes",
    ticket: "#27",
    tool: "smooth_bake",
    args: { cubes: "all", base: "#6e4a2b" },
    expect: "ok",
  },
  {
    id: "smooth-bake-cubes-type",
    ticket: "#27",
    tool: "smooth_bake",
    args: { cubes: 123 },
    expect: "error",
    errorField: "cubes",
  },
  {
    id: "smooth-bake-scope-bad",
    ticket: "#27",
    tool: "smooth_bake",
    args: { scope: "everything" },
    expect: "error",
    errorField: "scope",
  },
];
