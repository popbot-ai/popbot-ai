# Design

Frozen reference material from the PopBot design phase. Treat as historical context — the canonical, living design lives at [`../docs/POPBOT_DESIGN.md`](../docs/POPBOT_DESIGN.md).

## Layout

- [`prototype/`](prototype/) — Claude-Design-generated React prototype (8 JSX components, ~1,750 LOC, plus `styles.css` and four HTML preview shells). Globals-only, no build step.
- [`chat/popbot_design_chat.md`](chat/popbot_design_chat.md) — full transcript of the design conversation that produced the spec. Long; useful for "why did we decide X?" archaeology.

## Running the prototype

Two ways to view it:

```bash
# 1. Self-contained, single file — no network, no relative path resolution
open design/prototype/PopBot-standalone.html

# 2. Multi-file version (loads jsx via <script type="text/babel">) — needs to
#    be served because file:// blocks Babel from fetching the .jsx siblings.
cd design/prototype && python3 -m http.server 8000
# then open http://localhost:8000/PopBot.html
```

`PopBot.html` and `PopBot-export.html` are the multi-file versions. `PopBot (1).html` is an alternate that should be considered a duplicate of `PopBot.html`.

## Status of these files

- **The prototype is the authoritative UI reference.** When porting components into the real Electron renderer, match its visual + interaction behavior unless the design doc says otherwise.
- **Do not edit the prototype to add features.** New work goes into `src/renderer/`. The prototype is a snapshot.
- The original JSX files were written against `React`/`ReactDOM` globals (not ESM). Porting requires translating the global references and removing the `useStateA`/`useEffectA` aliases (a hack the prototype used to avoid name collisions when concatenating files).
