/**
 * Skill/doc reference validator service (ticket #48) — the reusable "how".
 *
 * Orchestration (doc-refs.test.mjs) owns why/when; this module owns how to
 * extract tool-id and repo-path mentions from skills/docs and report drift
 * in the check_model audit style (grouped per-issue lists, counts by type).
 *
 * Scope is deliberately conservative (ticket #48):
 * - Tool mentions: backticked single-word `snake_case` spans (with optional
 *   `mcp__blockbench__` / `blockbench_` prefix and `(s)` plural), plus bare
 *   `name {` invocations inside fenced code blocks (the README jsonc recipe
 *   style). Anything else (dotted JS APIs, paths, wildcards, placeholders)
 *   is not a tool mention and is skipped.
 * - Path mentions: markdown link destinations, backticked spans, and bare
 *   tokens that look like repo paths — first segment is a known repo root
 *   (`skills/`, `plugin/`, `src/`, `dist/`, `docs/`, `tests/`) or a script /
 *   artifact filename (`*.mjs`, `*.js`, `*.zip`). Bare filenames, prose
 *   words, URLs, `#anchors`, and `<placeholder>` / `*` patterns are skipped.
 * - HTML comments are stripped before extraction (commented-out content is
 *   not a reference).
 *
 * Every function takes explicit inputs and returns structured results —
 * never throws for validation findings, never touches the network.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

/** Docs scanned by the live-tree guard. */
export const SCANNED_DOCS = [
  "README.md",
  "skills/INSTALL.md",
  "skills/blockbench-mcp/SKILL.md",
  "skills/blockbench-modeling/SKILL.md",
  "skills/blockbench-texturing/SKILL.md",
  "skills/blockbench-animation/SKILL.md",
  "skills/blockbench-modeling/references/modeling-scripts.md",
  "skills/blockbench-texturing/references/texturing-scripts.md",
  "skills/blockbench-animation/references/animation-scripts.md",
  "commands/plan-model.md",
  "commands/silhouette-review.md",
  "commands/bake-texture.md",
  "commands/export-model.md",
  "commands/pose-preview.md",
];

/**
 * Known-good non-tool words appearing in tool-mention position today.
 * Inline allowlist (ticket #48): categories are format ids (`free`,
 * `geckolib_model`), bone names (`body`, `head`, `neck`, `tail`), enum /
 * schema words (`linear`, `catmullrom`, `scope`, `origin`, `parent`, ...),
 * mesh-shape words (`cone`, `crystal`, ...), JS/shell words in snippets
 * (`return`, `require`, K&R control keywords that can precede `{` at a line
 * start in reference snippets, `fetch`, `net`, `cd`, `pwd`, `path`, `code`),
 * plugin internals (`commands`), and client/prose words (`blockbench`,
 * `plugins`, `args`, ...). Anything else in tool-mention position is
 * reported as `unknown_tool`. A test pins `TOOL_WORD_ALLOWLIST ∩ registry`
 * empty so an allowlist entry can never shadow a real tool id.
 */
export const TOOL_WORD_ALLOWLIST = new Set(
  [
    "args",
    "animation",
    "back",
    "base",
    "blur",
    "blockbench",
    "body",
    "bottom_dark",
    "box_uv",
    "catch",
    "catmullrom",
    "cd",
    "code",
    "colors",
    "commands",
    "cone",
    "crystal",
    "cylinder",
    "diamond",
    "directory",
    "do",
    "else",
    "fetch",
    "finally",
    "for",
    "free",
    "from",
    "gate",
    "geckolib_model",
    "gem",
    "glow_regex",
    "head",
    "linear",
    "modeling",
    "neck",
    "net",
    "no_texture",
    "noise",
    "octahedron",
    "origin",
    "parent",
    "path",
    "plane",
    "plugins",
    "prism",
    "pwd",
    "px_per_unit",
    "pyramid",
    "reference",
    "regex",
    "require",
    "return",
    "rotation",
    "scale",
    "scope",
    "segments",
    "shard",
    "switch",
    "tail",
    "texture",
    "texturing",
    "time",
    "top_light",
    "topic",
    "try",
    "up",
    "uv",
    "vfx",
    "warning",
    "wedge",
    "while",
  ].sort()
);

/**
 * Known-good path exceptions. Empty today (the two known README drifts are
 * fixed, not allowlisted). If a future valid reference cannot resolve from
 * the repo root, add it here with a TODO pointing at its ticket — never
 * widen the extractor to silence it.
 */
export const PATH_ALLOWLIST = new Set([]);

const REPO_ROOTS = new Set(["skills", "plugin", "src", "dist", "docs", "tests"]);
/** Bare repo-rooted path tokens, compiled from REPO_ROOTS so the two stay coupled. */
const BARE_PATH_RE = new RegExp(`\\b((?:${[...REPO_ROOTS].join("|")})\\/[A-Za-z0-9_.\\-/]*[A-Za-z0-9_.\\-/])`, "g");
const SCRIPT_EXTS = [".mjs", ".js", ".zip"];
const TOOL_PREFIXES = ["mcp__blockbench__", "blockbench_"];

/** Blank HTML comments, keeping line numbers stable. */
export function stripHtmlComments(text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Blank `http(s)://...` runs so URL tails are never read as paths. */
function stripUrls(text) {
  return String(text).replace(/https?:\/\/\S+/g, (m) => " ".repeat(m.length));
}

function stripPrefixes(name) {
  for (const p of TOOL_PREFIXES) {
    if (name.startsWith(p)) return name.slice(p.length);
  }
  return name;
}

/**
 * Extract tool-id mentions from one doc's text.
 *
 * @param {string} text doc source
 * @returns {{name:string, raw:string, line:number}[]} candidates in file order
 */
export function extractToolMentions(text) {
  const src = stripHtmlComments(String(text));
  const lines = src.split("\n");
  /** @type {{name:string, raw:string, line:number}[]} */
  const out = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    // Backticked spans: only single-word snake_case (optional tool prefix,
    // optional "(s)" plural like `add_keyframe(s)`).
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const raw = m[1];
      const plural = raw.match(/^(.*)\(s\)$/);
      const raws = plural ? [plural[1], `${plural[1]}s`] : [raw];
      for (const r of raws) {
        const word = r.match(/^(mcp__blockbench__|blockbench_)?([a-z][a-z0-9_]*)$/);
        if (!word) continue;
        out.push({ name: stripPrefixes(word[0]), raw, line: i + 1 });
      }
    }
    // Bare `name {` invocations inside fenced blocks (jsonc recipe style).
    if (inFence) {
      const bare = line.match(/^\s*([a-z][a-z0-9_]*)\s*\{/);
      if (bare) out.push({ name: stripPrefixes(bare[1]), raw: bare[1], line: i + 1 });
    }
  }
  return out;
}

/** True when the span is a placeholder/wildcard rather than a real path. */
function isPlaceholder(p) {
  return p.includes("<") || p.includes(">") || p.includes("*");
}

/** Trim prose punctuation captured at the edges of a bare path token. */
function cleanBarePath(p) {
  return p.replace(/^["'([{]+/, "").replace(/["'()\]}:;,.\]]+$/, "");
}

/**
 * Extract repo-path mentions from one doc's text.
 *
 * @param {string} text doc source
 * @returns {{path:string, line:number}[]} candidates in file order
 */
export function extractPathMentions(text) {
  const src = stripUrls(stripHtmlComments(String(text)));
  const lines = src.split("\n");
  /** @type {{path:string, line:number}[]} */
  const out = [];
  const seen = new Set();
  const push = (p, line) => {
    const cleaned = cleanBarePath(p.trim().replace(/\/+$/, ""));
    if (!cleaned || isPlaceholder(cleaned)) return;
    if (cleaned.startsWith("#")) return;
    // One line can surface the same path three ways (link destination,
    // backticked span, bare token) — report it once.
    const key = `${line} ${cleaned}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: cleaned, line });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Fences carry no link destinations, but bare `dist/...` tokens in
    // json examples still count — the bare scan below runs inside fences too.
    // Markdown link destinations: `[text](dest)`.
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const dest = m[1].trim();
      if (!dest || dest.startsWith("#") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(dest)) continue;
      if (isPlaceholder(dest)) continue;
      push(dest, i + 1);
    }
    // Backticked spans that look like repo paths.
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const raw = m[1].trim();
      if (!raw || isPlaceholder(raw) || /\s/.test(raw)) continue;
      const first = raw.split("/")[0];
      const isRooted = REPO_ROOTS.has(first);
      const isScript = SCRIPT_EXTS.some((e) => raw.endsWith(e)) && !raw.includes("/");
      if (raw.includes("/") ? isRooted : isScript) push(raw, i + 1);
    }
    // Bare repo-rooted tokens in prose and fenced examples.
    for (const m of line.matchAll(BARE_PATH_RE)) {
      push(m[1], i + 1);
    }
  }
  return out;
}

/**
 * Read the scanned docs off disk.
 *
 * @param {string} repoRoot absolute repo root
 * @param {string[]} [files] doc paths relative to the root
 * @returns {{file:string, text:string}[]} sources in scan order
 */
export function loadScannedDocs(repoRoot, files = SCANNED_DOCS) {
  return files.map((file) => ({ file, text: readFileSync(join(repoRoot, file), "utf8") }));
}

/**
 * Validate tool-id and repo-path mentions across docs.
 *
 * @param {{registry:string[], repoRoot:string, docs:{file:string, text:string}[]}} input
 * @returns {{file_count:number, tool_mentions:number, path_mentions:number, issue_count:number, by_type:Record<string,number>, issues:{file:string, kind:string, ref:string, line:number, hint:string}[]}}
 */
export function validateDocRefs({ registry, repoRoot, docs }) {
  const valid = new Set(registry);
  /** @type {{file:string, kind:string, ref:string, line:number, hint:string}[]} */
  const issues = [];
  let toolMentions = 0;
  let pathMentions = 0;

  for (const { file, text } of docs) {
    for (const m of extractToolMentions(text)) {
      toolMentions++;
      if (valid.has(m.name) || TOOL_WORD_ALLOWLIST.has(m.name)) continue;
      issues.push({
        file,
        kind: "unknown_tool",
        ref: m.name,
        line: m.line,
        hint: `\`${m.raw}\` names ${JSON.stringify(m.name)}, absent from the tool registry (src/tools.ts); fix the reference or add a genuinely new tool to the registry`,
      });
    }
    for (const m of extractPathMentions(text)) {
      pathMentions++;
      if (PATH_ALLOWLIST.has(m.path)) continue;
      const docDir = join(repoRoot, dirname(file));
      const resolvable = existsSync(join(repoRoot, m.path)) || existsSync(join(docDir, m.path));
      if (!resolvable) {
        issues.push({
          file,
          kind: "missing_path",
          ref: m.path,
          line: m.line,
          hint: `${JSON.stringify(m.path)} does not exist from the repo root (nor relative to ${file}); fix the reference or ship the file`,
        });
      }
    }
  }

  /** @type {Record<string, number>} */
  const byType = {};
  for (const issue of issues) {
    byType[issue.kind] = (byType[issue.kind] ?? 0) + 1;
  }
  return {
    file_count: docs.length,
    tool_mentions: toolMentions,
    path_mentions: pathMentions,
    issue_count: issues.length,
    by_type: byType,
    issues,
  };
}
