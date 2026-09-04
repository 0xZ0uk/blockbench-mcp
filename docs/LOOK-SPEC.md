# LOOK.md Format

LOOK.md is a self-contained, plain-text representation of a 3D art direction for low-poly
game assets built in Blockbench. It defines one aesthetic — a "look" — so that stylistic
choices stay consistent across modeling sessions and between different AI agents and tools.
As a human-readable, open-format document, it serves as a living source of truth that both
humans and AI can understand and refine.

A LOOK.md file contains two parts: YAML frontmatter, and a markdown body. The frontmatter
holds machine-readable look tokens: the checkable numbers (resolutions, budgets, palette
values, filtering modes). The markdown body holds human-readable rationale and guidance:
why those values exist and how to apply them. The tokens are the normative values; the prose
provides context for how to apply them.

## What LOOK.md is

- **One file per aesthetic.** A project targeting the PS1 look ships one LOOK.md; a project
  mixing looks ships one per look. The file names the look it defines (`name:`) and nothing else.
- **A contract between taste and verification.** Tokens cover the measurable half of a style
  (texture sizes, palette membership, tri budgets); prose covers the judgment half (when to
  break a rule, what "reads right" means). Review checklists bind the two.
- **A companion to skills, not a skill.** Modeling/texturing skills teach *how* to build;
  LOOK.md teaches *what good looks like today*. Skills stay generic and reusable; the look
  file swaps per project.

## What LOOK.md is not

- **Not a skill.** It carries no workflow, no tool instructions, no snippets. An agent reads it
  for constraints and taste, then executes with its skills.
- **Not a per-model spec.** It defines the look for a whole project or asset family, never a
  single model. Per-model decisions (this character's palette entries, that prop's budget)
  instantiate the look; they don't redefine it.
- **Not a renderer config.** It may state downstream assumptions (point filtering, fog, dark
  backgrounds) so models are built for the world they'll live in, but engine settings live in
  the engine.
- **Not universal.** A LOOK.md that tries to cover "all low-poly" covers nothing. If two
  aesthetics share nothing checkable, they are two files.

# Look Tokens

LOOK.md embeds look tokens as YAML frontmatter. The frontmatter block must begin with a line
containing exactly `---` and end with a line containing exactly `---`.

Example:

```yaml
---
version: alpha
name: PS1 Look
description: Mid-90s console aesthetic — chunky low-poly geometry, tiny point-filtered pixel textures, limited palettes, dithered shading.
colors:
  primary: "#8B5A2B"
  shadow: "#2A2030"
  highlight: "#F0E8D8"
texture:
  resolution: 64px
  resolutionMax: 128px
  filtering: point
  paletteMax: 16
geometry:
  triBudgetProp: 300
  triBudgetCharacter: 1200
  shading: flat
  gridSnap: true
treatments:
  dithering: true
  unlitBrightFaces: true
---
```

## Schema

```yaml
version: <string>          # optional, current version: "alpha"
name: <string>
description: <string>      # optional; one-line character of the look
colors:
  <token-name>: <Color>
texture:
  resolution: <Dimension>  # default texture size (square assumed unless stated)
  resolutionMax: <Dimension>
  filtering: <point | bilinear | none>
  paletteMax: <number>     # max distinct colors per model
geometry:
  triBudgetProp: <number>
  triBudgetCharacter: <number>
  shading: <flat | smooth>
  gridSnap: <boolean>
treatments:
  <token-name>: <boolean|string>  # look-specific, e.g. dithering, unlitBrightFaces
```

**Color**: any hex string (`"#RRGGBB"` recommended). Quote all hex values — YAML chokes on
bare `#`.

**Dimension**: a number + `px` suffix for texture sizes (e.g. `64px`).

**Token References**: `{group.token}` (e.g. `{colors.primary}`) may be used anywhere a value
is expected, so palettes stay single-source.

**Custom groups and keys are allowed.** A look with needs this schema doesn't cover (animation
frame rules, export codecs, engine assumptions) adds a group rather than bending an existing
one. Consumers accept unknown groups if their values are well-formed.

# Sections

Every LOOK.md follows the same structure. Sections may be omitted if irrelevant, but those
present should appear in the order below. All sections use `##` headings.

1. **Overview**
2. **Colors** (also: "Palette")
3. **Geometry**
4. **Textures**
5. **Shading & Rendering**
6. **Blockbench Mapping**
7. **Do's and Don'ts**
8. **Review Checklist**

## Overview

A holistic description of the look: the era or reference it descends from, the emotional
response assets should evoke, and the one-sentence rule an agent falls back on when no token
or rule covers a decision ("celebrate the grid, never hide it"). Foundational context for
high-level stylistic judgment.

## Colors

The palette and its discipline. Name each color's role (what it's for, where it appears),
state the per-model color cap, and say how transitions between colors are handled (blend,
dither, hard step). Tokens: `colors:*`, `texture.paletteMax`.

## Geometry

The shape language: primitive preferences, tri budgets per asset class, shading mode, grid
discipline, silhouette rules. State budgets as ranges and say which matters more — hitting the
number or staying consistent across assets (usually consistency). Tokens: `geometry:*`.

## Textures

Resolution policy (default, max, when to use which), filtering mode, painting discipline
(hand-painted pixels vs baked gradients vs flat fills), UV expectations (packing, texel
density, grid alignment). Say explicitly which texture treatments from other looks are
*banned* here. Tokens: `texture:*`.

## Shading & Rendering

How light and depth work in this look: flat vs smooth shading, how accents/emissives behave,
what backgrounds assets are reviewed against, and any downstream rendering assumptions the
model must be built for (filtering, fog, vertex snap). Tokens: `treatments:*`.

## Blockbench Mapping

The section DESIGN.md has no equivalent of, and the one that makes LOOK.md executable. Every
taste rule above gets its tool-call translation: which format to create, which texture sizes
to pass, which tools to prefer or avoid, which primitives and segment counts to use, what the
export step produces. If a rule can't be mapped to a tool call or a check, it belongs in
Do's and Don'ts as judgment, not here.

## Do's and Don'ts

Practical guardrails and common pitfalls, phrased as do/don't pairs. The place for rules that
are real but not checkable ("don't texture what a flat palette color already says").

```markdown
## Do's and Don'ts

- Do celebrate texels; never bilinear-filter.
- Do dither transitions; never blend them.
- Don't exceed 128px on any texture.
```

## Review Checklist

Checkboxes binding tokens to verification. Each item must be answerable by an agent with the
MCP tools (texture sizes via `list_textures`, palette via `get_texture`, tris via outliner
queries) or by a screenshot comparison. A checklist item that can be neither checked nor seen
is decoration — delete it.

# How to Use LOOK.md

1. **Load it with the skills, not as one.** The agent loads its modeling/texturing skills for
   *how* and the project's LOOK.md for *what good looks like*. Skill descriptions stay
   generic; the look file is per-project context.
2. **Plan against it.** Reference intake names palette entries and budget class up front ("this
   prop: 64px, ≤8 colors, ≤300 tris"), so the look constrains the plan before the first tool call.
3. **Gate against it.** The pre-save review runs the checklist: measurable items checked via
   tools, judgment items via screenshots (on the backgrounds the look specifies, not default grey).
4. **One look at a time.** If a session mixes looks, say which LOOK.md governs before building.
   Never blend two looks by instinct.

# How to Create a LOOK.md

1. **Collect 2–3 reference images** that embody the look. Pictures keep the file honest; the
   Overview should be writable from them alone.
2. **Extract the checkable numbers first**: texture sizes, filtering, palette size, tri
   budgets, shading mode. If you can't state a number, you don't have a rule yet — write prose
   and mark it judgment.
3. **Write the tokens**, then the sections in canonical order, then the Blockbench Mapping
   (map every rule to a call or a check), then Do's and Don'ts, then the Review Checklist.
4. **Ban by name.** For every treatment your source aesthetics use that this look rejects
   (smooth bakes under PS1, grid-breaking organic meshes under Minecraft), write the ban down.
   Rejection rules prevent more drift than positive ones.
5. **Validate**: every token referenced in prose exists in frontmatter; every checklist item is
   checkable via tools or screenshots; hex values quoted; `{group.token}` paths resolve.
6. **Test-drive**: build one asset with skills + the new LOOK.md and run its checklist. Fix the
   file where the agent had to guess — every guess is a missing rule.

# Validation

Machine-checkable (an agent or script can verify):

- Texture dimensions ≤ `resolutionMax`, defaulting to `resolution` (via `list_textures`).
- Palette membership: sampled texture colors within the `colors` set ± dither pairs
  (via `get_texture`).
- Tri counts within the asset-class budget (via outliner queries).
- Token references resolve; hex quoted; sections in canonical order.

Human-checkable (screenshots):

- Silhouette rules, transition treatments (dither vs blend), background readability,
  "reads as the look" against the pinned references.

# Worked Example

`LOOK.md` (PS1 Look) next to this file: 64/128px point-filtered textures, ≤16 colors,
300/1200 tri budgets, flat shading, grid snap, dithering mandated, smooth-bake banned,
reviewed on dark backgrounds. Built by following the creation workflow above from the
low-poly texture research (gradient-atlas vs pixel-texture vs flat-color discipline).

# Consumer Behavior for Unknown Content

| Scenario | Behavior | Example |
|---|---|---|
| Unknown section heading | Preserve; do not error | `## Animation` |
| Unknown token group | Accept if values are well-formed | `export: {codec: ...}` |
| Unknown token name in a known group | Accept if value type is valid | `treatments: {scanlines: true}` |
| Broken `{group.token}` reference | Error; fix before use | `{colors.missing}` |
| Duplicate section heading | Error; reject the file | Two `## Geometry` headings |
| Checklist item neither checkable nor visible | Warning; delete or rewrite | "feels retro enough" |
