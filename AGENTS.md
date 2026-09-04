# AGENTS.md

Be sure to always use the official MCP specification to model your decisions: https://modelcontextprotocol.io/specification/2026-07-28

## Blockbench MCP: tool-name mapping (Claude ↔ OpenCode)

The server registers itself under the name `blockbench` (see `.mcp.json` for
Claude Code and `opencode.json` for OpenCode). Clients prefix the server name
onto each tool name with different separators, so the same tool resolves under
two names:

| Claude Code / Claude Desktop | OpenCode | Same tool? |
|------------------------------|----------|------------|
| `mcp__blockbench__<tool>` | `blockbench_<tool>` | Yes — identical server, schema, and result. |

- Every `mcp__blockbench__<tool>` reference in `skills/**` (for example
  `mcp__blockbench__get_status` or `mcp__blockbench__check_model`) means
  `blockbench_<tool>` under OpenCode — e.g. `blockbench_get_status`,
  `blockbench_check_model`.
- The full `<tool>` list lives in `src/tools.ts` (`get_status`,
  `new_project`, `add_cubes`, `paint_faces`, `screenshot_views`, ...).
- When a skill instruction says "call the `mcp__blockbench__X` tool", resolve
  it in OpenCode as `blockbench_X`. Nothing about arguments, schemas, or
  return values differs between the two names.
- The server itself is unchanged by this mapping — it is the same stdio
  process launched via `node dist/index.js` with `BLOCKBENCH_MCP_PORT`
  (default `8787`) matching the Blockbench plugin's port setting.
