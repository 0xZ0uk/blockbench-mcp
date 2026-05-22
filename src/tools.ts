/**
 * Tool catalogue for the BlockbenchMCP server.
 *
 * Each tool maps (mostly 1:1) onto a command handled by the bridge plugin.
 * Handlers return MCP content blocks; screenshots and texture reads return
 * image blocks so the model can actually *see* the result.
 */
import { callBlockbench } from "./client.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, any>) => Promise<ContentBlock[]>;
}

// ---- schema helpers --------------------------------------------------------
const vec3 = (desc: string) => ({
  type: "array",
  items: { type: "number" },
  minItems: 3,
  maxItems: 3,
  description: desc,
});
const obj = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
});

function text(value: unknown): ContentBlock[] {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return [{ type: "text", text: body }];
}

/** Tool whose result is just the JSON returned by the bridge. */
function forward(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  action = name
): ToolDef {
  return {
    name,
    description,
    inputSchema,
    handler: async (args) => text(await callBlockbench(action, args)),
  };
}

// ---------------------------------------------------------------------------
export const tools: ToolDef[] = [
  // ===== status & discovery ================================================
  forward(
    "get_status",
    "Get the current Blockbench state: open project, format, counts of cubes/groups/textures/animations, and edit mode. Call this first to understand the workspace.",
    obj({})
  ),
  forward(
    "list_formats",
    "List all model formats available in this Blockbench install (e.g. free, java_block, bedrock, and any added by plugins such as GeckoLib's animated_entity). Use the returned `id` with new_project.",
    obj({})
  ),

  // ===== project lifecycle =================================================
  forward(
    "new_project",
    "Create a new project from the start screen, choosing a format. This is the entry point for any new model.",
    obj(
      {
        format: {
          type: "string",
          description:
            "Format id or name (e.g. 'free', 'java_block', 'bedrock', 'geckolib_model' for GeckoLib). Use list_formats to discover ids. The matching plugin must be installed for plugin formats.",
        },
        name: { type: "string", description: "Project / model name." },
        geometry_name: { type: "string", description: "Optional geometry identifier (Bedrock/GeckoLib)." },
        texture_width: { type: "number", description: "UV/texture width (default 16)." },
        texture_height: { type: "number", description: "UV/texture height (default 16)." },
      },
      ["format"]
    )
  ),
  forward(
    "set_project_meta",
    "Update the open project's name, geometry name, or texture resolution.",
    obj({
      name: { type: "string" },
      geometry_name: { type: "string" },
      texture_width: { type: "number" },
      texture_height: { type: "number" },
    })
  ),
  forward("close_project", "Close the currently open project.", obj({})),
  forward(
    "save_project",
    "Save the open project as a .bbmodel. Provide `path` to save to a specific file (desktop), otherwise Blockbench's save flow is used.",
    obj({ path: { type: "string", description: "Absolute file path to save to (optional)." } })
  ),
  forward(
    "export_project",
    "Export the project through its format's codec (e.g. Java model JSON, Bedrock geometry, GeckoLib model). Provide `path` to write a file directly.",
    obj({ path: { type: "string", description: "Absolute output path (optional)." } })
  ),
  forward(
    "load_project",
    "Load a .bbmodel project file from disk (desktop only).",
    obj({ path: { type: "string", description: "Absolute path to a .bbmodel file." } }, ["path"])
  ),

  // ===== outliner / geometry ===============================================
  forward(
    "add_group",
    "Add a group / bone to the outliner. Groups are the bones used for animation. Returns the created group with its uuid.",
    obj({
      name: { type: "string" },
      origin: vec3("Pivot point [x,y,z] (the bone's rotation pivot)."),
      rotation: vec3("Initial rotation in degrees [x,y,z]."),
      parent: { type: "string", description: "uuid or name of the parent group (omit for root)." },
    })
  ),
  forward(
    "add_cube",
    "Add a cube to the model. Coordinates are in Blockbench units. Returns the created cube with uuid and faces.",
    obj(
      {
        name: { type: "string" },
        from: vec3("Lower corner [x,y,z]."),
        to: vec3("Upper corner [x,y,z]."),
        origin: vec3("Rotation pivot [x,y,z] (defaults to `from`)."),
        rotation: vec3("Rotation in degrees [x,y,z]."),
        inflate: { type: "number", description: "Inflation applied to all faces." },
        autouv: { type: "number", enum: [0, 1, 2], description: "0 disabled, 1 auto, 2 relative auto." },
        box_uv: { type: "boolean", description: "Use box UV (default follows the format)." },
        uv_offset: { type: "array", items: { type: "number" }, description: "[u,v] offset for box UV." },
        parent: { type: "string", description: "uuid or name of the parent group." },
        faces: {
          type: "object",
          description:
            "Optional per-face setup, keyed by north/south/east/west/up/down. Each: {uv:[x1,y1,x2,y2], rotation, texture: name|uuid}.",
        },
      },
      ["from", "to"]
    )
  ),
  forward(
    "edit_element",
    "Edit an existing cube or group (rename, move, rotate, reparent, resize, inflate, visibility).",
    obj(
      {
        element: { type: "string", description: "uuid or name of the cube/group to edit." },
        new_name: { type: "string" },
        from: vec3("New lower corner (cubes only)."),
        to: vec3("New upper corner (cubes only)."),
        origin: vec3("New pivot."),
        rotation: vec3("New rotation in degrees."),
        inflate: { type: "number" },
        visibility: { type: "boolean" },
        parent: { type: "string", description: "uuid/name of new parent group, or 'root'." },
      },
      ["element"]
    )
  ),
  forward(
    "delete_element",
    "Delete a cube or group (and its children) from the model.",
    obj({ element: { type: "string", description: "uuid or name." } }, ["element"])
  ),
  forward(
    "list_outliner",
    "Return the full outliner tree (groups/bones and their nested cubes) with uuids, origins and rotations.",
    obj({})
  ),
  forward(
    "get_element",
    "Get detailed info for one cube or group by uuid or name.",
    obj({ element: { type: "string" } }, ["element"])
  ),

  // ===== UV & textures on faces ============================================
  forward(
    "set_cube_uv",
    "Set UV mapping and/or per-face texture on a cube's faces.",
    obj(
      {
        cube: { type: "string", description: "uuid or name of the cube." },
        faces: {
          type: "object",
          description:
            "Keyed by face direction. Each: {uv:[x1,y1,x2,y2], rotation:0|90|180|270, texture: name|uuid}.",
        },
      },
      ["cube", "faces"]
    )
  ),
  forward(
    "apply_texture",
    "Apply a texture to all faces of an element (or all cubes if `element` omitted).",
    obj({ texture: { type: "string" }, element: { type: "string" } }, ["texture"])
  ),

  // ===== textures ==========================================================
  forward(
    "create_texture",
    "Create a new texture. Either fill it with a solid color, or supply a full PNG via `data_url`. Returns the texture uuid.",
    obj({
      name: { type: "string" },
      width: { type: "number", description: "Defaults to project texture width." },
      height: { type: "number", description: "Defaults to project texture height." },
      fill: { type: "string", description: "Solid fill color, e.g. '#a0703c' (CSS color)." },
      data_url: {
        type: "string",
        description: "Optional 'data:image/png;base64,...' to use as the texture image directly.",
      },
      particle: { type: "boolean", description: "Mark as particle texture (some formats)." },
    })
  ),
  forward(
    "import_texture",
    "Import a texture from an image file on disk (desktop only).",
    obj({ path: { type: "string" }, name: { type: "string" } }, ["path"])
  ),
  forward("list_textures", "List all textures in the project.", obj({})),
  {
    name: "get_texture",
    description:
      "Read a texture back as an image so you can inspect what it currently looks like. Returns the PNG inline.",
    inputSchema: obj({ texture: { type: "string", description: "uuid or name." } }, ["texture"]),
    handler: async (args) => {
      const res: any = await callBlockbench("get_texture", args);
      const base64 = String(res.data_url || "").replace(/^data:image\/png;base64,/, "");
      return [
        { type: "text", text: JSON.stringify(res.texture, null, 2) },
        { type: "image", data: base64, mimeType: "image/png" },
      ];
    },
  },
  forward(
    "paint_texture",
    "Paint directly on a texture with a list of pixel-art drawing operations. This is how you texture a model procedurally. Ops run in order on the texture's canvas (origin top-left, y down).",
    obj(
      {
        texture: { type: "string", description: "uuid or name of the texture to paint." },
        edit_name: { type: "string", description: "Undo entry label." },
        ops: {
          type: "array",
          description:
            "Drawing operations. Each op has a `type` and a `color` (CSS color). Types: " +
            "pixel{x,y}; rect{x,y,width,height,fill?,line_width?}; line{x1,y1,x2,y2,line_width?}; " +
            "circle{x,y,radius,fill?,line_width?}; gradient{x1,y1,x2,y2,x,y,width,height,stops:[[offset,color],...]}; " +
            "fill_all{}; clear{x?,y?,width?,height?}.",
          items: { type: "object" },
        },
      },
      ["texture", "ops"]
    )
  ),
  forward(
    "resize_texture",
    "Resize a texture's bitmap to new dimensions (nearest-neighbour).",
    obj({ texture: { type: "string" }, width: { type: "number" }, height: { type: "number" } }, [
      "texture",
      "width",
      "height",
    ])
  ),

  // ===== animations ========================================================
  forward(
    "create_animation",
    "Create an animation (requires a format that supports animation, e.g. GeckoLib animated_entity or Bedrock entity). Returns the animation uuid.",
    obj({
      name: { type: "string", description: "Animation name, e.g. 'animation.bear.walk'." },
      loop: { type: "string", enum: ["once", "hold", "loop"], description: "Loop mode (default 'loop')." },
      length: { type: "number", description: "Length in seconds." },
    })
  ),
  forward("list_animations", "List all animations and their animated bones.", obj({})),
  forward(
    "add_keyframe",
    "Add a single keyframe to an animation for a given bone and channel.",
    obj(
      {
        animation: { type: "string", description: "uuid or name of the animation." },
        bone: { type: "string", description: "uuid or name of the group/bone to animate." },
        channel: { type: "string", enum: ["rotation", "position", "scale"], description: "Default 'rotation'." },
        time: { type: "number", description: "Time in seconds." },
        value: vec3("Channel value [x,y,z] (degrees for rotation, units for position, factor for scale)."),
        interpolation: { type: "string", enum: ["linear", "catmullrom", "step", "bezier"] },
      },
      ["animation", "bone", "time", "value"]
    )
  ),
  forward(
    "add_keyframes",
    "Add many keyframes at once — the efficient way to author a full animation. Pass an array of {bone, channel, time, value, interpolation}.",
    obj(
      {
        animation: { type: "string" },
        keyframes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              bone: { type: "string" },
              channel: { type: "string", enum: ["rotation", "position", "scale"] },
              time: { type: "number" },
              value: vec3("[x,y,z]"),
              interpolation: { type: "string" },
            },
            required: ["bone", "time", "value"],
          },
        },
      },
      ["animation", "keyframes"]
    )
  ),
  forward(
    "remove_animation",
    "Delete an animation from the project.",
    obj({ animation: { type: "string" } }, ["animation"])
  ),

  // ===== view / camera / screenshot ========================================
  forward(
    "set_camera_angle",
    "Position the preview camera, by named preset and/or explicit camera position & target.",
    obj({
      preset: { type: "string", description: "A camera angle preset id (e.g. 'front', 'isometric_right_front')." },
      position: vec3("Explicit camera position [x,y,z]."),
      target: vec3("Look-at target [x,y,z]."),
      angle: { type: "string", description: "'ortho' to switch to orthographic projection." },
    })
  ),
  {
    name: "screenshot",
    description:
      "Capture the current 3D preview and return it as an image so you can visually inspect the model and iterate. Optionally specify width/height.",
    inputSchema: obj({
      width: { type: "number" },
      height: { type: "number" },
    }),
    handler: async (args) => {
      const res: any = await callBlockbench("screenshot", args);
      return [
        { type: "text", text: "Preview screenshot:" },
        { type: "image", data: res.base64, mimeType: "image/png" },
      ];
    },
  },

  // ===== plugins ===========================================================
  forward(
    "list_plugins",
    "List Blockbench plugins (installed and available in the store). Filter with `query` or `installed_only`.",
    obj({
      query: { type: "string", description: "Search term matched against id/title/description." },
      installed_only: { type: "boolean" },
    })
  ),
  forward(
    "install_plugin",
    "Install a Blockbench plugin from the store (by `id`, e.g. 'geckolib' for GeckoLib Models & Animations), or from a `url`, or a local `path`. Needed before using plugin-specific formats like GeckoLib's 'geckolib_model'.",
    obj({
      id: { type: "string", description: "Store plugin id." },
      url: { type: "string", description: "Direct https URL to a plugin .js file." },
      path: { type: "string", description: "Local plugin .js file path (desktop)." },
    })
  ),
  forward(
    "uninstall_plugin",
    "Uninstall an installed Blockbench plugin by id.",
    obj({ id: { type: "string" } }, ["id"])
  ),

  // ===== escape hatch ======================================================
  forward(
    "execute_script",
    "Run arbitrary JavaScript inside Blockbench's renderer for anything not covered by a dedicated tool. The code has access to all Blockbench globals (Project, Cube, Group, Texture, Animation, Undo, Canvas, Outliner, Format, Formats, ...) and receives a `params` object. Return a JSON-serializable value. Use sparingly; prefer dedicated tools.",
    obj(
      {
        code: {
          type: "string",
          description:
            "Function body. Example: \"return Cube.all.map(c => c.name)\". Wrap edits in Undo.initEdit/finishEdit and call Canvas.updateAll() after geometry changes.",
        },
        params: { type: "object", description: "Optional object passed in as `params`." },
      },
      ["code"]
    )
  ),
];
