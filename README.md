# BlockbenchMCP

![MCP](https://img.shields.io/badge/MCP-server-6f42c1)
![Blockbench](https://img.shields.io/badge/Blockbench-4.8%2B-1f8cff)
![Node](https://img.shields.io/badge/Node-18%2B-339933)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

> Let an AI build Minecraft models, textures and animations directly inside [Blockbench](https://www.blockbench.net/) — through the [Model Context Protocol](https://modelcontextprotocol.io/).

BlockbenchMCP gives an AI assistant a live connection to a running Blockbench window. The model can start a project from the start screen, build geometry (bones + cubes), **paint textures procedurally**, author **keyframe animations** (including [GeckoLib](https://github.com/bernie-g/geckolib)), **install Blockbench plugins**, move the camera, and **take screenshots so it can look at its own work and refine it** — all without you touching the editor.

<!-- Tip: add a screenshot or gif of a generated model here, e.g. ![demo](assets/demo.gif) -->

It was used to model, texture and animate a full GeckoLib grizzly bear (walk / run / sleep / attack) end-to-end from a single prompt.

---

## Table of contents

- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Connecting your AI client](#connecting-your-ai-client)
- [Tool reference](#tool-reference)
- [Example: an animated GeckoLib bear](#example-an-animated-geckolib-bear)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

---

## How it works

There are two pieces:

| Piece | Runs where | Responsibility |
|-------|-----------|----------------|
| **Bridge plugin** — [`plugin/blockbench_mcp.js`](plugin/blockbench_mcp.js) | Inside Blockbench (desktop) | Hosts a local HTTP endpoint on `127.0.0.1:8787` (built on Node's `net` module) and runs each command against the Blockbench API on the renderer thread. |
| **MCP server** — [`src/`](src/) → `dist/` | A Node process your AI client launches | Exposes Blockbench as MCP tools (stdio transport) and forwards every call to the bridge. |

```
┌────────────┐   stdio (MCP)   ┌──────────────────┐   HTTP 127.0.0.1:8787   ┌─────────────────────┐
│  AI client │ ──────────────▶ │  blockbench-mcp  │ ──────────────────────▶ │  Blockbench + plugin │
│ (Claude…)  │ ◀────────────── │   (Node server)  │ ◀────────────────────── │   (live editor)      │
└────────────┘                 └──────────────────┘                         └─────────────────────┘
```

## Features

- 🧱 **Modeling** — create bones (groups) and cubes, edit/move/reparent/delete them, read the full outliner tree.
- 🎨 **Texturing** — create textures, paint procedurally (pixels, rects, lines, circles, gradients), apply to faces, set per-face UVs, import/resize, and read a texture back as an image.
- 🎬 **Animation** — create animations, add keyframes in bulk for any bone/channel with interpolation control (linear / catmullrom / step / bezier).
- 📸 **Vision** — `screenshot` and `get_texture` return the image inline so the model can *see* and iterate.
- 🧩 **Plugins** — search, install (by store id, URL, or file) and uninstall Blockbench plugins, so the AI can set up formats like GeckoLib itself.
- 🔧 **Escape hatch** — `execute_script` runs arbitrary Blockbench JS for anything not covered by a dedicated tool.
- 🟢 **33 tools** total, all over a single local connection.

## Requirements

- **Blockbench desktop app**, version **4.8+** (the web app cannot host the bridge — see [Limitations](#limitations)).
- **Node.js 18+** (for global `fetch`).
- An MCP-capable client (Claude Code, Claude Desktop, Cursor, etc.).

## Installation

### 1. Install the bridge plugin in Blockbench

1. Open the **desktop** Blockbench app.
2. **File ▸ Plugins ▸ Load Plugin from File** and select [`plugin/blockbench_mcp.js`](plugin/blockbench_mcp.js).
   *(Alternatively copy it into your Blockbench `plugins` folder.)*
3. On first start the plugin asks for **network permission** (it needs the `net` module to host the local server). Choose **“Always allow for this plugin.”**
4. A toast confirms **“MCP server started on port 8787.”**
   - Toggle the server any time: **Tools ▸ Start / Stop MCP Server**
   - Change the port: **Settings ▸ General ▸ MCP Server Port** (default `8787`)

Verify it's up:

```bash
curl http://127.0.0.1:8787/ping
# {"ok":true,"protocol":1,"blockbench_version":"5.x.x","is_app":true,"has_project":false}
```

### 2. Build the MCP server

```bash
git clone https://github.com/sosadly/blockbench-mcp.git
cd blockbench-mcp
npm install
npm run build
```

## Connecting your AI client

Point your client at `dist/index.js` over stdio. Use an **absolute path**.

**Claude Code** — `.mcp.json` in your project (or `claude mcp add`):

```json
{
  "mcpServers": {
    "blockbench": {
      "command": "node",
      "args": ["/absolute/path/to/blockbench-mcp/dist/index.js"],
      "env": { "BLOCKBENCH_MCP_PORT": "8787" }
    }
  }
}
```

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "blockbench": {
      "command": "node",
      "args": ["C:\\path\\to\\blockbench-mcp\\dist\\index.js"]
    }
  }
}
```

| Env var | Default | Purpose |
|---------|---------|---------|
| `BLOCKBENCH_MCP_PORT` | `8787` | Must match the plugin's port setting. |
| `BLOCKBENCH_MCP_HOST` | `127.0.0.1` | Bridge host. |

## Tool reference

| Group | Tools |
|-------|-------|
| **Status** | `get_status`, `list_formats` |
| **Project** | `new_project`, `set_project_meta`, `save_project`, `export_project`, `load_project`, `close_project` |
| **Geometry** | `add_group`, `add_cube`, `edit_element`, `delete_element`, `list_outliner`, `get_element` |
| **UV & textures** | `create_texture`, `paint_texture`, `apply_texture`, `set_cube_uv`, `import_texture`, `resize_texture`, `list_textures`, `get_texture` |
| **Animation** | `create_animation`, `add_keyframe`, `add_keyframes`, `list_animations`, `remove_animation` |
| **View** | `set_camera_angle`, `screenshot` |
| **Plugins** | `list_plugins`, `install_plugin`, `uninstall_plugin` |
| **Escape hatch** | `execute_script` |

Conventions: coordinates are **Blockbench units**; rotations are **degrees**; texture pixel ops use a **top-left origin with y pointing down**. `add_cube` returns each face's resolved UV rect, which makes it easy to paint features (eyes, nose, claws) exactly onto the right pixels.

## Example: an animated GeckoLib bear

The sequence an AI follows for *“make a textured GeckoLib bear that can walk, run, sleep and attack”*:

```jsonc
// 1. Install GeckoLib (adds the `geckolib_model` format)
install_plugin { "id": "geckolib" }

// 2. New project, straight from the start screen
new_project { "format": "geckolib_model", "name": "bear",
              "texture_width": 64, "texture_height": 64 }

// 3. Bones, then cubes parented to them (uv_offset packs box UVs without overlap)
add_group { "name": "body", "origin": [0, 12, 0] }
add_cube  { "name": "torso", "from": [-5, 8, -7], "to": [5, 16, 7],
            "parent": "body", "uv_offset": [0, 0] }
add_group { "name": "head", "origin": [0, 13, -7], "parent": "body" }
add_cube  { "name": "head", "from": [-3.5, 10, -13], "to": [3.5, 16, -7],
            "parent": "head", "uv_offset": [0, 22] }
// ...legs, ears, muzzle, tail...

// 4. Texture: base fill, then paint detail onto the UV rects add_cube returned
create_texture { "name": "bear", "width": 64, "height": 64, "fill": "#6e4a2b" }
paint_texture  { "texture": "bear", "ops": [
  { "type": "rect", "x": 8,  "y": 30, "width": 1, "height": 1, "color": "#0f0a05" }, // eye
  { "type": "rect", "x": 27, "y": 36, "width": 4, "height": 3, "color": "#140e08" }  // nose
] }
apply_texture  { "texture": "bear" }

// 5. Animate (bulk keyframes, smooth interpolation)
create_animation { "name": "animation.bear.walk", "loop": "loop", "length": 1.2 }
add_keyframes {
  "animation": "animation.bear.walk",
  "keyframes": [
    { "bone": "leg_front_left", "channel": "rotation", "time": 0.0, "value": [28, 0, 0], "interpolation": "catmullrom" },
    { "bone": "leg_front_left", "channel": "rotation", "time": 0.6, "value": [-28, 0, 0], "interpolation": "catmullrom" },
    { "bone": "leg_front_left", "channel": "rotation", "time": 1.2, "value": [28, 0, 0], "interpolation": "catmullrom" }
  ]
}

// 6. Look at the result, then refine
screenshot {}

// 7. Save / export
save_project   { "path": "D:/models/bear.bbmodel" }
export_project { "path": "D:/models/bear.geo.json" }
```

## Troubleshooting

**Blockbench shows “server stopped” and Start does nothing.**
The plugin needs the `net` module. When you click **Start MCP Server**, Blockbench shows a permission dialog — choose **“Always allow for this plugin.”** If you previously denied it, revoke and retry from the plugin's context menu, or restart Blockbench.

**MCP tools fail with “Cannot reach Blockbench on 127.0.0.1:8787”.**
Make sure Blockbench is open, the plugin is loaded, and the server is running (green toast / `curl .../ping` works). Confirm the port in the plugin settings matches `BLOCKBENCH_MCP_PORT`.

**“Unknown format … the matching plugin must be installed.”**
Plugin formats like GeckoLib's `geckolib_model` require `install_plugin { "id": "geckolib" }` first. Run `list_formats` to confirm the id appeared.

**Console 404s about `about.md` / the plugin store.**
Harmless — Blockbench tries to fetch store metadata for the side-loaded plugin and gets a 404. It does not affect the bridge.

## Security

- The bridge binds to **`127.0.0.1` only** — it is not reachable from your network.
- `execute_script` runs **unsandboxed JavaScript** inside Blockbench. Only connect MCP clients you trust, and prefer the dedicated tools over `execute_script` where possible.

## Limitations

- **Desktop only.** The bridge relies on Node modules (`net`), which the Blockbench web app does not expose to plugins.
- **One Blockbench window.** The bridge talks to whichever project is currently active.
- Box-UV packing is up to the caller; `add_cube` returns resolved face UVs to make this manageable.

## Development

```bash
npm run dev     # tsc --watch
npm run build   # one-off compile to dist/
```

- MCP tool definitions live in [`src/tools.ts`](src/tools.ts); the HTTP client in [`src/client.ts`](src/client.ts); the server entry in [`src/index.ts`](src/index.ts).
- Bridge command handlers live in [`plugin/blockbench_mcp.js`](plugin/blockbench_mcp.js) under the `commands` object — add a handler there and a matching tool in `tools.ts` to extend the surface.
- The Blockbench API used by the bridge is documented in the [official type definitions](https://github.com/JannisX11/blockbench/tree/master/types).

## License

[MIT](LICENSE) © [sosadly](https://github.com/sosadly)

Built with the [Model Context Protocol](https://modelcontextprotocol.io/). Not affiliated with Blockbench or GeckoLib.
