# Look files

One folder, one idea: **aesthetic specs for Blockbench work.**

- [`spec.md`](spec.md) — the LOOK.md format specification: what a look file is and isn't,
  the token schema, canonical sections, and how to write one.
- [`LOOK-PS1.md`](LOOK-PS1.md) — worked example: a PS1-style look (tiny point-filtered
  textures, tight palette, chunky flat-shaded geometry).

## What this is

A LOOK.md is a one-file-per-aesthetic spec — machine-readable tokens (resolutions, budgets,
palette) up front, human-readable rationale behind. Skills teach agents *how* to build;
the look file teaches *what good looks like* for your project. Exploratory, not part of
the MCP or its skills.

## How to use it in a project

1. Copy `LOOK-PS1.md` (or write your own per `spec.md`) into your project as `LOOK.md`.
2. Load it alongside the modeling/texturing skills — skills for *how*, the look file
   for *what good looks like today*.
3. Plan against it (name palette entries and budget class before the first tool call)
   and gate against it (run its review checklist before saving).
