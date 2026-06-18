# Third-Party Notices

PopBot is released under the MIT License (see `LICENSE`). It depends on and/or
bundles third-party software and assets that remain under their own licenses.
This file summarizes the notable ones. It is not exhaustive of every transitive
dependency; run `npx license-checker --production` for a full tree.

## Proprietary runtime dependency — NOT covered by this repo's MIT license

- **`@anthropic-ai/claude-agent-sdk`** — © Anthropic PBC. All rights reserved.
  This package is proprietary software, used under Anthropic's terms
  (https://www.anthropic.com/legal). It is required at runtime (PopBot drives
  the Claude Code agent through it) but is **not** redistributed in this
  repository (it installs from npm into `node_modules/`, which is gitignored),
  and it is **not** licensed under PopBot's MIT license. Each user obtains it
  under Anthropic's own terms when they `npm install`.

## Permissive dependencies requiring attribution

- **`@openai/codex-sdk`** and its bundled **`@openai/codex`** — Apache License
  2.0, © OpenAI. See the Apache-2.0 license text and any NOTICE files shipped
  in those packages.
- **TypeScript** (`typescript`, build-time) — Apache License 2.0, © Microsoft.

All other runtime and build dependencies (React, Vite, Electron,
electron-builder, Tailwind CSS, xterm.js, better-sqlite3, node-pty,
react-markdown, remark-gfm, react-virtuoso, react-diff-viewer-continued,
@anthropic-ai/sdk, and the `@types/*` packages) are distributed under the MIT
License. Their copyright and permission notices accompany them in
`node_modules/`.

## Fonts and icons

- **Font Awesome Free** (`@fortawesome/fontawesome-free`) — © Fonticons, Inc.
  Licensed under a combination of:
  - Icons: **CC BY 4.0** (attribution required)
  - Fonts: **SIL OFL 1.1** ("Font Awesome" is a Reserved Font Name)
  - Code: **MIT**
  When the application is built, Font Awesome glyphs and font files are bundled
  into the packaged app and must carry the above attribution.
- **Inter** and **JetBrains Mono** are loaded at runtime from Google Fonts
  (`fonts.gstatic.com`) and are not redistributed in this repository.

## Third-party trademarks and logos

The integration icons under `images/` — **`github_icon.png`**,
**`linear_icon.png`**, and **`slack_icon.png`** — are the trademarks and brand
assets of GitHub, Inc., Linear Orbit, Inc., and Slack Technologies, LLC,
respectively. They are used nominatively to identify those integrations and are
**not** licensed under PopBot's MIT license. They remain the property of their
respective owners and are subject to each owner's brand guidelines.
