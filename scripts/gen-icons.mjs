#!/usr/bin/env node
/**
 * Generate per-platform app icons from ONE square master (build/icon.png).
 *
 * Why per-platform shapes exist at all: no desktop OS masks your icon for you at
 * render time. The rounded "app icon" look is baked into the artwork, and each
 * platform wants a DIFFERENT shape:
 *
 *   - Windows  -> full-bleed SQUARE (the platform norm; no rounding).
 *   - Linux    -> near-full-bleed ROUNDED RECT (GNOME/Adwaita-ish soft corners).
 *   - macOS    -> Apple SQUIRCLE (superellipse) inset to ~80% of the canvas with
 *                 transparent padding, per Apple's icon grid. A full-bleed square
 *                 hands macOS a hard square that looks wrong next to native apps.
 *
 * So one master square is fanned out into three shaped sources here, and
 * electron-builder packs them into the container formats it needs:
 *
 *   build/win/icon.png    (square)          -> electron-builder -> .ico   (win.icon)
 *   build/icons/NxN.png   (rounded set)     -> electron-builder -> hicolor (linux.icon dir)
 *   build/mac/icon.png    (padded squircle) -> electron-builder -> .icns  (mac.icon)
 *
 * We DON'T emit .icns/.ico here: this ImageMagick build has no ICNS coder, and
 * electron-builder's own app-builder binary converts PNG -> icns/ico at build
 * time anyway (and does it on the native mac/win runners). We only produce the
 * shaped PNG sources.
 *
 * The macOS squircle is a close superellipse APPROXIMATION of Apple's curve, not
 * a pixel-exact copy of Apple's official template. It reads correctly in the dock;
 * swap in an Apple-template .icns via mac.icon if you ever need exact fidelity.
 *
 * Requires ImageMagick 7 (`magick`) on PATH. Run: `npm run gen-icons`.
 * Re-run whenever build/icon.png changes; commit the regenerated outputs.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MASTER = join(root, 'build', 'icon.png');

// Freedesktop hicolor sizes we ship for Linux. 1024 isn't a standard theme size
// but we include it as the high-res source; the smaller ones are what actually
// resolve in the launcher.
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

// macOS canvas + inset. Apple's grid puts the icon body at ~80.4% of the tile
// (824/1024) with transparent padding around the squircle.
const MAC_CANVAS = 1024;
const MAC_INSET = 824;

// Linux corner radius as a fraction of the tile — soft, near-full-bleed.
const LINUX_RADIUS_FRAC = 0.18;

// Superellipse exponent for the macOS squircle. ~5 matches Apple's curve well;
// 2 would be a plain ellipse, infinity a hard square.
const SQUIRCLE_N = 5;

function magick(args) {
  execFileSync('magick', args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

function ensureMagick() {
  try {
    execFileSync('magick', ['-version'], { stdio: 'ignore' });
  } catch {
    console.error(
      'ERROR: ImageMagick 7 (`magick`) not found on PATH. Install it and re-run.\n' +
        '  macOS:  brew install imagemagick\n' +
        '  Ubuntu: sudo apt-get install imagemagick\n' +
        '  Windows: winget install ImageMagick.ImageMagick',
    );
    process.exit(1);
  }
}

function freshDir(p) {
  rmSync(p, { recursive: true, force: true });
  mkdirSync(p, { recursive: true });
}

/**
 * Build a grayscale superellipse (squircle) mask at `size` px: white inside,
 * black outside. |x|^n + |y|^n <= 1 in normalized [-1,1] coords.
 */
function squircleMask(size, out) {
  const half = size / 2;
  const fx =
    `( pow(abs((i+0.5)/${half}-1),${SQUIRCLE_N}) + ` +
    `pow(abs((j+0.5)/${half}-1),${SQUIRCLE_N}) ) <= 1 ? 1 : 0`;
  magick(['-size', `${size}x${size}`, 'xc:black', '-fx', fx, out]);
}

/** Build a grayscale rounded-rectangle mask at `size` px (white inside). */
function roundRectMask(size, radius, out) {
  magick([
    '-size', `${size}x${size}`, 'xc:black', '-fill', 'white',
    '-draw', `roundrectangle 0,0 ${size - 1},${size - 1} ${radius},${radius}`,
    out,
  ]);
}

/** Resize the master to `fit` px, cut it to `mask`, then pad transparently to `canvas`. */
function shapeMasterInto(fit, canvas, mask, out) {
  const args = [
    MASTER, '-resize', `${fit}x${fit}!`,
    mask, '-alpha', 'off', '-compose', 'CopyOpacity', '-composite',
  ];
  if (canvas !== fit) {
    // Reset the compose operator to Over BEFORE extending. Without it the extent
    // pad step keeps CopyOpacity active and premultiplies the RGB against the
    // transparent canvas, flattening the whole icon to solid black (alpha stays
    // correct, color is lost). Over composites the padding transparently and
    // preserves the art's colors.
    args.push('-compose', 'Over', '-background', 'none', '-gravity', 'center',
      '-extent', `${canvas}x${canvas}`);
  }
  args.push(out);
  magick(args);
}

function main() {
  ensureMagick();
  if (!existsSync(MASTER)) {
    console.error(`ERROR: master icon not found at ${MASTER}`);
    process.exit(1);
  }

  const buildDir = join(root, 'build');
  const tmp = join(buildDir, '.icon-tmp');
  freshDir(tmp);

  // --- Windows: full-bleed square, straight copy at 1024 (electron-builder -> .ico) ---
  const winDir = join(buildDir, 'win');
  freshDir(winDir);
  magick([MASTER, '-resize', '1024x1024!', join(winDir, 'icon.png')]);
  console.log('win:   build/win/icon.png (square)');

  // --- Linux: rounded-rect set at each hicolor size (electron-builder -> hicolor) ---
  const iconsDir = join(buildDir, 'icons');
  freshDir(iconsDir);
  for (const s of LINUX_SIZES) {
    const radius = Math.round(s * LINUX_RADIUS_FRAC);
    const mask = join(tmp, `rr-${s}.png`);
    roundRectMask(s, radius, mask);
    shapeMasterInto(s, s, mask, join(iconsDir, `${s}x${s}.png`));
  }
  console.log(`linux: build/icons/{${LINUX_SIZES.join(',')}}.png (rounded)`);

  // --- macOS: padded superellipse squircle at 1024 (electron-builder -> .icns) ---
  const macDir = join(buildDir, 'mac');
  freshDir(macDir);
  const macMask = join(tmp, 'squircle.png');
  squircleMask(MAC_INSET, macMask);
  shapeMasterInto(MAC_INSET, MAC_CANVAS, macMask, join(macDir, 'icon.png'));
  console.log('mac:   build/mac/icon.png (squircle + padding)');

  rmSync(tmp, { recursive: true, force: true });
  console.log('\nDone. Commit the regenerated build/{win,icons,mac} icons.');
}

main();
