# 0001. Electron + Vite + React + TypeScript + Tailwind

> **Status:** accepted
> **Date:** 2026-05-01

## Context

PopBot needs a desktop window that supervises long-running child processes (Unity Editor, sidecar HTTP server, Claude Agent SDK sessions), holds a SQLite-backed transcript store, talks to the macOS Accessibility API via a native helper, and presents a complex multi-pane UI. Single developer, single platform (macOS) for v1.

## Decision

Build on **Electron** (Node 20 + Chromium) with **Vite** as the bundler, **React + TypeScript** in the renderer, **Tailwind** for styling, **electron-builder** for packaging.

## Consequences

- Fastest path to a working window; everything we need (process supervision, fs, child_process, native HTTP, native bindings) is one `import` away.
- The renderer carries Chromium's footprint (~80 MB cold). Acceptable for a developer tool.
- React + TS matches the design prototype's idiom. Translation cost from the prototype JSX is mechanical.
- Tailwind keeps styling close to the existing prototype's flat, dark, design-token approach (the prototype already uses CSS custom properties; Tailwind layers cleanly on top).
- Vite's HMR is the fast feedback we want during early UI iteration.
- electron-builder handles macOS code signing + notarization when we get there.

## Alternatives considered

- **Tauri** (Rust core, system webview). Smaller binary, but we'd burn days on Rust ↔ Node bridges for `node-pty`, `better-sqlite3`, the Claude Agent SDK, and the MCP HTTP plumbing. Reconsider for v2 if footprint becomes a problem.
- **Native macOS (SwiftUI).** Tightest integration with the window-positioning needs, but rebuilds the renderer ecosystem from scratch and locks us out of cross-platform later.
- **Webview + remote backend.** Splits the lifecycle across processes for no benefit; we still need a local supervisor for Unity and the sidecar.
- **CRA / Webpack instead of Vite.** Slower dev loop, no real upside.
