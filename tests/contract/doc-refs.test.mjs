/**
 * Skill/doc reference validator tests (ticket #48) — the prefactor guard
 * every P3 skill/docs edit runs against.
 *
 * A skill (each `SKILL.md` and its `references/` scripts) or user-facing
 * doc (`README.md`, `skills/INSTALL.md`) must never reference a tool id
 * absent from the registry published by `src/tools.ts` (the same list
 * `tools/list` serves), nor a repo path that does not exist. This class of
 * drift already shipped once (README named the deleted
 * `skills/build-zips.mjs` and claimed "40 tools" for a 55-tool registry).
 *
 * The reusable mechanics live in doc-refs.mjs (the service layer); this
 * file owns the why/when: the live-tree guard plus synthetic proofs that
 * the validator actually turns red on bogus tool and path references.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tools } from "../../dist/tools.js";
import {
  SCANNED_DOCS,
  TOOL_WORD_ALLOWLIST,
  extractToolMentions,
  extractPathMentions,
  loadScannedDocs,
  validateDocRefs,
} from "./doc-refs.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const registry = tools.map((t) => t.name);

function formatIssues(summary) {
  return summary.issues.map((i) => `${i.file}:${i.line} [${i.kind}] ${i.ref} — ${i.hint}`).join("\n");
}

test("doc refs: every skill/doc tool-id and repo-path mention resolves (ticket #48)", () => {
  const docs = loadScannedDocs(repoRoot);
  assert.equal(docs.length, SCANNED_DOCS.length, "the guard must scan the full doc list");
  const summary = validateDocRefs({ registry, repoRoot, docs });
  assert.equal(
    summary.issue_count,
    0,
    `doc reference drift:\n${formatIssues(summary)}\nby_type: ${JSON.stringify(summary.by_type)}`
  );
  assert.ok(summary.tool_mentions > 0, "the guard must actually see tool mentions");
  assert.ok(summary.path_mentions > 0, "the guard must actually see path mentions");
});

test("doc refs: the scan list covers every skill doc on disk", () => {
  /** @type {string[]} */
  const onDisk = ["README.md", "skills/INSTALL.md"];
  for (const entry of readdirSync(join(repoRoot, "skills"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = join("skills", entry.name, "SKILL.md");
    if (existsSync(join(repoRoot, skillMd))) onDisk.push(skillMd);
    const refDir = join(repoRoot, "skills", entry.name, "references");
    if (existsSync(refDir)) {
      for (const f of readdirSync(refDir)) {
        if (f.endsWith(".md")) onDisk.push(join("skills", entry.name, "references", f));
      }
    }
  }
  const scanned = new Set(SCANNED_DOCS);
  for (const f of onDisk) {
    assert.ok(scanned.has(f), `${f} exists on disk but is not in SCANNED_DOCS — new skill docs must join the guard`);
  }
});

test("doc refs: the tool-word allowlist can never shadow a real tool id", () => {
  const valid = new Set(registry);
  const collision = [...TOOL_WORD_ALLOWLIST].filter((w) => valid.has(w));
  assert.deepEqual(collision, [], `allowlist must stay disjoint from the registry, colliding: ${collision}`);
});

test("doc refs: a bogus tool id in a skill turns the validator red", () => {
  const text = [
    "# Scratch",
    "",
    "Bulk over single: prefer `add_groups` / `add_cubes` over their single forms.",
    "Then call `frobnicate_mega_widget` to finish.",
    "",
    "```jsonc",
    "frobnicate_mega_widget { \"when\": \"never\" }",
    "```",
  ].join("\n");
  const names = extractToolMentions(text).map((m) => m.name);
  assert.ok(names.includes("add_groups"), "real tools are still extracted");
  assert.ok(names.includes("frobnicate_mega_widget"), "the bogus id is extracted in both positions");

  const summary = validateDocRefs({
    registry,
    repoRoot,
    docs: [{ file: "synthetic.md", text }],
  });
  const bogus = summary.issues.filter((i) => i.kind === "unknown_tool" && i.ref === "frobnicate_mega_widget");
  assert.equal(bogus.length, 2, `both bogus mentions must be reported, got:\n${formatIssues(summary)}`);
});

test("doc refs: `(s)` plurals validate each variant they name", () => {
  const names = extractToolMentions("Prefer `add_groups` / `add_keyframe(s)` over singles.\n").map((m) => m.name);
  assert.deepEqual(names, ["add_groups", "add_keyframe", "add_keyframes"]);
  const green = validateDocRefs({
    registry,
    repoRoot,
    docs: [{ file: "synthetic.md", text: "Prefer `add_keyframe(s)` over singles.\n" }],
  });
  assert.equal(green.issue_count, 0, `both named variants are real tools, got:\n${formatIssues(green)}`);

  const red = validateDocRefs({
    registry,
    repoRoot,
    docs: [{ file: "synthetic.md", text: "Then call `frobnicate_x(s)` to finish.\n" }],
  });
  assert.equal(red.issue_count, 2, `each bogus variant is reported, got:\n${formatIssues(red)}`);
  assert.ok(red.issues.every((i) => i.kind === "unknown_tool"));
});

test("doc refs: one line naming one path reports it once", () => {
  const text = "Handlers live in [`plugin/blockbench_mcp.js`](plugin/blockbench_mcp.js), aka `plugin/blockbench_mcp.js`.\n";
  assert.deepEqual(
    extractPathMentions(text).map((m) => m.path),
    ["plugin/blockbench_mcp.js"],
    "link destination, backticked span, and bare token on one line must dedupe"
  );
  const summary = validateDocRefs({
    registry,
    repoRoot,
    docs: [{ file: "synthetic.md", text: "See [`skills/nope-not-here.mjs`](skills/nope-not-here.mjs), aka `skills/nope-not-here.mjs`.\n" }],
  });
  assert.equal(summary.issue_count, 1, `one typo is one issue, got:\n${formatIssues(summary)}`);
});

test("doc refs: a prefixed bogus tool id is stripped and reported", () => {
  const summary = validateDocRefs({
    registry,
    repoRoot,
    docs: [{ file: "synthetic.md", text: "Drive it with `mcp__blockbench__frobnicate_nope` today.\n" }],
  });
  assert.equal(summary.issue_count, 1, `expected one unknown_tool, got:\n${formatIssues(summary)}`);
  assert.equal(summary.issues[0].kind, "unknown_tool");
  assert.equal(summary.issues[0].ref, "frobnicate_nope");
});

test("doc refs: a missing repo path turns the validator red", () => {
  const text = [
    "# Scratch",
    "",
    "Handlers live in [`plugin/blockbench_mcp.js`](plugin/blockbench_mcp.js).",
    "Then run `node skills/nope-not-here.mjs` to finish.",
  ].join("\n");
  const paths = extractPathMentions(text).map((m) => m.path);
  assert.ok(paths.includes("plugin/blockbench_mcp.js"), "real paths are still extracted");
  assert.ok(paths.includes("skills/nope-not-here.mjs"), "the bogus path is extracted");

  const summary = validateDocRefs({
    registry,
    repoRoot,
    docs: [{ file: "synthetic.md", text }],
  });
  assert.equal(summary.issue_count, 1, `expected one missing_path, got:\n${formatIssues(summary)}`);
  assert.equal(summary.issues[0].kind, "missing_path");
  assert.equal(summary.issues[0].ref, "skills/nope-not-here.mjs");
});

test("doc refs: placeholders, urls, anchors, and comments are not paths", () => {
  const text = [
    "<!-- Tip: ![demo](assets/demo.gif) -->",
    "",
    "See [the docs](https://opencode.ai/docs/mcp-servers/) and [setup](#installation).",
    "Each folder ships `skills/<name>.zip` and `mcp__blockbench__*` tools.",
  ].join("\n");
  assert.deepEqual(extractPathMentions(text), [], "no path candidates expected");
  const summary = validateDocRefs({
    registry,
    repoRoot,
    docs: [{ file: "synthetic.md", text }],
  });
  assert.equal(summary.issue_count, 0, `conservative scope must stay green, got:\n${formatIssues(summary)}`);
});

test("docs: README tool count matches the published registry", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const claims = [...readme.matchAll(/\*\*(\d+)\s+tools\*\*/g)].map((m) => Number(m[1]));
  assert.equal(claims.length, 1, `README must make exactly one "**N tools" claim, found: ${claims}`);
  assert.equal(
    claims[0],
    registry.length,
    `README claims ${claims[0]} tools but the registry serves ${registry.length} — update the count with the tool change`
  );
});

test("docs: README tool reference table lists the whole registry", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  const section = readme.split("## Tool reference")[1].split(/^## /m)[0];
  assert.ok(section, "README must keep a ## Tool reference section");
  const inTable = new Set(
    [...section.matchAll(/`([a-z][a-z0-9_]*)`/g)]
      .map((m) => m[1])
      .filter((w) => registry.includes(w))
  );
  const missing = registry.filter((t) => !inTable.has(t));
  assert.deepEqual(
    missing,
    [],
    `tool reference table omits registry tools: ${missing} — add a row with the tool change`
  );
  assert.equal(inTable.size, registry.length);
});
