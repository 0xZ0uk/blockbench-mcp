---
name: blockbench-look
description: Read and enforce a project's LOOK.md aesthetic spec during Blockbench work. Use when the project contains a LOOK.md (or docs/look/LOOK-*.md), when asked to match an aesthetic (PS1, Minecraft, Hytale, hand-painted), or before calling any modeling/texturing work done. Covers look discovery, planning against tokens, and gating the pre-save review on the look checklist. Load with the blockbench-mcp core skill.
---

# Blockbench look — build to the aesthetic, not to generic "good"

Skills teach *how* to build. The look file teaches *what good looks like today*. Without it,
agents produce competent generic models that match no aesthetic. With it, every decision —
palette entry, texture size, tri spent, transition treatment — is checked against the look
before the model is called done.

## Discovery (before any build planning)

A look file governs the session only if you find it. Check, in order:

1. `<project>/LOOK.md` — a project's own look (highest priority).
2. `<project>/docs/look/LOOK-*.md` — one file per aesthetic; the project (or user) says
   which one governs. Never blend two — if unclear, ask which look governs before building.
3. This repo's `docs/look/` — reference examples only (PS1, Minecraft, Hytale, Handpainted).
   Useful when the project has no look yet and needs one written (see spec.md).

If no look file exists and none was requested, say so in one line and proceed on the domain
skills alone. Do not invent aesthetic constraints.

## How to read a look file

- **Tokens are normative.** Frontmatter values (resolutions, budgets, palette, filtering,
  shading) are the contract. Prose explains *why* and how to apply them — it never overrides
  a token.
- **Bans are first-class rules.** Every look bans something another look requires (smooth
  bake banned under PS1/Minecraft, mandatory under Handpainted; meshes banned under
  Minecraft/Hytale). Read the ban list as carefully as the token list — bans prevent more
  drift than positive rules.
- **Blockbench Mapping is the executable part.** It translates each taste rule into tool
  calls. Follow it over your generic habits when the two conflict (e.g. your instinct says
  smooth-bake, the look says flat fills + dither — the look wins).
- **One look at a time.** A session has exactly one governing look. Name it before building.

## Plan against the look

Reference intake names look parameters up front, alongside masses and proportions:

- Palette entries this model will use (named tokens, not hex from memory).
- Budget class (prop vs character) and texture size for this asset.
- Which treatments apply (dither vs blend, flat vs smooth, point vs bilinear).

If the plan can't name these, the look file wasn't read — re-read it.

## Gate against the look (pre-save, every model)

Run the look's Review Checklist before `save_project`, after the generic done-gate:

- **Measurable items** — verify with tools (procedures in `references/look-checks.md`):
  texture dimensions, palette membership, tri counts, shading mode.
- **Judgment items** — verify with screenshots on the backgrounds the look specifies
  (dark for PS1, cluttered scene for Hytale, neutral for Handpainted): silhouette rules,
  transition treatments, "reads as the look" against the pinned references.
- A model that passes the machine gate but fails the look checklist is **not done**.
  Fix the look failure first — it is never acceptable to rationalize a visible aesthetic
  flaw as "close enough."

## When the project needs a look written

Point at this repo's `docs/look/spec.md` (the format specification) and the four worked
examples. Write tokens first (numbers before prose), map every rule to a tool call, ban by
name, end with a test-drive asset. Do not evolve the spec format itself without discussion —
examples may proliferate, the schema changes deliberately.
