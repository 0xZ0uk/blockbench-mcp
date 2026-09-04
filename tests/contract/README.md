# Contract test harness (ticket #2)

Single seam for all follow-up precision tickets. One command runs it green
on a clean tree:

```bash
npm test
```

(`npm test` rebuilds `dist/` with `tsc`, then runs `node --test`
over `tests/contract/*.test.mjs`. `pnpm test` works the same.)

## What it proves

Table-driven cases send representative tool calls and assert the structured
results clients actually see — success payloads vs. field-named errors —
mirroring the `check_model` audit style of grouped per-issue lists:

- **Schemas offered to clients** — `tests/contract/cases.mjs` rows are
  validated against the published `tools[].inputSchema` from `dist/tools.js`
  (what clients validate pre-flight). Good rows must pass; bad rows must
  fail with the offending field named (`errorField`, e.g. missing `from` on
  `add_cube`). Table failures are harness diagnostics reported in the
  `check_model` audit style of grouped per-issue lists — they mirror, but
  are not themselves, client-visible results.
- **Handler results returned over the bridge** — representative handlers
  (`add_cube`, `check_model`, bridge-error propagation) run with the bridge
  transport stubbed and assert the `ContentBlock`s clients receive
  (text JSON, grouped `by_type`/`issues` audit shape).
- **MCP results clients actually receive** — `mcp-transport.test.mjs`
  drives the production ListTools/CallTool wiring (`createServer()` from
  `dist/index.js`) over an in-memory MCP transport with the bridge stubbed
  and asserts the real `CallToolResult`s, including `isError` and the
  field-bearing error text for unknown tools and bridge rejections.

What it never touches: helper or serializer internals, Blockbench
internals, or a live Blockbench window (the bridge is stubbed; the only
transport code exercised is the production MCP request wiring).

## How to extend (follow-up tickets)

1. Add rows to `tests/contract/cases.mjs`:
   `{ id, ticket, tool, args, expect: "ok" | "error", errorField? }`.
2. Keep cases at the tool-contract boundary only (schemas + handler
   results). Do not assert coercion helpers, packers, or serializers.
3. Run `npm test`. Green is the gate.

No new transport or storage seams: this directory (`validator.mjs`,
`cases.mjs`, `runner.mjs`, `contract.test.mjs`, `mcp-transport.test.mjs`) is
the single seam.
