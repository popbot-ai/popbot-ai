# Bundled `shado` binary

Prebuilt [`shado`](https://github.com/popbot-ai/shado) binaries — the shadow-workspace
controller PopBot uses for VHDX copy-on-write slots on very large Perforce/game trees.

These are **committed on purpose** so PopBot's release CI can bundle them without
needing the Go toolchain or the shado source checked out.

## Layout (one folder per platform)

```
bin/win/shado.exe     Windows  (committed)
bin/mac/shado         macOS    (planned — APFS clonefile backend)
bin/linux/shado       Linux    (committed — XFS/btrfs reflink backend)
```

electron-builder bundles the current platform's binary to `resources/shado/`
(see `win.extraResources` / `linux.extraResources` in `electron-builder.yml`);
`src/main/shado/client.ts` resolves it at runtime (packaged or dev). The Linux
and macOS binaries are extensionless ELF/Mach-O files committed with the
executable bit (git mode 100755) so the bundled copy stays runnable.

## Refreshing

```sh
npm run build:shado        # needs Go + shado source at ../shado (or $SHADO_SRC)
```

then commit the updated binary.

Current `bin/win/shado.exe` built from **popbot-ai/shado @ cdddec8**.
Current `bin/linux/shado` built from **popbot-ai/shado @ 39cf7a7** (+ Linux reflink backend).
