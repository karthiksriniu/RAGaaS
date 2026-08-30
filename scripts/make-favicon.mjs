import sharp from "sharp";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = join(__dirname, "..", "src", "app");

// Usage:
//   node scripts/make-favicon.mjs
//
// Regenerates src/app/favicon.ico from the icon SVGs beside it. It exists so
// the .ico is not an unreproducible binary nobody can ever change - edit the
// SVG, re-run this, commit both.
//
// Two sources, not one. At 16px the three-bar voice level in icon.svg blurs
// into a single white smudge, so 16 gets its own cut with one wide bar; every
// larger size uses the real mark. An .ico can hold a different image per size,
// which is the entire reason the format still exists.
// icon-16.svg lives here rather than beside icon.svg because src/app is a
// route directory: Next resolves icon* files there into real <link> tags, and
// a second one would end up advertised to browsers as an alternative favicon.
const SOURCES = [
  { size: 16, dir: __dirname, file: "icon-16.svg" },
  { size: 32, dir: app, file: "icon.svg" },
  { size: 48, dir: app, file: "icon.svg" },
  { size: 64, dir: app, file: "icon.svg" },
];

const images = [];
for (const { size, dir: srcDir, file } of SOURCES) {
  // density well above the target: librsvg rasterises at this DPI first, so a
  // low value would alias the arcs before the resize ever runs.
  const buf = await sharp(readFileSync(join(srcDir, file)), { density: 384 })
    .resize(size, size)
    .png()
    .toBuffer();
  images.push({ size, buf });
}

// ICO container. Entries carry PNG payloads, understood by every browser that
// still asks for a .ico at all.
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(images.length, 4);

let offset = 6 + 16 * images.length;
const entries = [];
for (const { size, buf } of images) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size === 256 ? 0 : size, 0); // 0 means 256 in this format
  e.writeUInt8(size === 256 ? 0 : size, 1);
  e.writeUInt8(0, 2); // palette size
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(buf.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += buf.length;
  entries.push(e);
}

const out = join(app, "favicon.ico");
writeFileSync(out, Buffer.concat([dir, ...entries, ...images.map((i) => i.buf)]));
console.log(`favicon.ico: ${SOURCES.map((s) => s.size).join("/")}px, ${offset} bytes`);
