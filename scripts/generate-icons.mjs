/**
 * Turns `assets/icon-source.png` into the platform icon formats that
 * electron-builder needs. The output is committed, so CI never has to
 * rasterize anything and the Windows runner never needs macOS-only tooling.
 *
 * The source artwork is a square plate on a white card. This script finds the
 * plate, drops everything around it, and re-cuts the corners as a transparent
 * rounded rectangle on Apple's proportions. That keeps the dock silhouette
 * correct and stops a white square appearing behind the mark.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { deflateSync, inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "assets");
const SOURCE = path.join(ASSETS, "icon-source.png");
const FAVICON = path.join(ROOT, "src", "app", "favicon.ico");
const SPLASH_LOGO = path.join(ROOT, "electron", "logo.png");
const SPLASH_SIZE = 512;

// macOS expects the artwork to sit inside its canvas rather than bleed to the
// edge. Apple's grid puts the rounded rectangle at 824/1024 with a 185/1024
// radius, and the same inset does no harm on Windows.
const PLATE_INSET = 96 / 1024;
const PLATE_RADIUS = 188 / 1024;

/** Signed distance to a rounded rectangle, negative inside. */
function roundRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - halfW + radius;
  const dy = Math.abs(y - cy) - halfH + radius;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** One pixel of feather turns a hard distance field into an antialiased edge. */
function coverage(distance) {
  return Math.min(Math.max(0.5 - distance, 0), 1);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Each scanline is prefixed with filter type 0, which stores it verbatim.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO files may embed PNG payloads directly, which avoids a BMP encoder. */
function encodeIco(entries) {
  const directory = Buffer.alloc(6 + entries.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(entries.length, 4);

  let offset = directory.length;
  entries.forEach((entry, index) => {
    const at = 6 + index * 16;
    // 256 is stored as 0, the format's way of encoding "full size".
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([directory, ...entries.map((entry) => entry.png)]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}

/**
 * Decodes the subset of PNG that design tools export: 8 bits per channel,
 * greyscale/RGB/palette/alpha, non-interlaced. Anything else is rejected loudly
 * rather than silently producing a corrupt icon.
 */
function decodePng(file) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, index) => file[index] === byte)) {
    throw new Error("Source is not a PNG file.");
  }

  let header = null;
  let palette = null;
  let transparency = null;
  const data = [];

  let offset = 8;
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("ascii", offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body[8],
        colorType: body[9],
        interlace: body[12],
      };
    } else if (type === "PLTE") {
      palette = body;
    } else if (type === "tRNS") {
      transparency = body;
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      break;
    }
  }

  if (!header) throw new Error("PNG is missing its IHDR chunk.");
  if (header.depth !== 8) {
    throw new Error(`Unsupported PNG bit depth: ${header.depth}.`);
  }
  if (header.interlace !== 0) {
    throw new Error("Interlaced PNGs are not supported.");
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  if (!channels) {
    throw new Error(`Unsupported PNG colour type: ${header.colorType}.`);
  }

  const { width, height } = header;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(data));
  const pixels = Buffer.alloc(stride * height);

  // Undo the per-scanline filters. Each one predicts a byte from its left (a),
  // upper (b) and upper-left (c) neighbour, so both loops run front to back.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c =
        y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;

      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`Unknown PNG filter type: ${filter}.`);
      }

      pixels[y * stride + x] = value & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const from = index * channels;
    const to = index * 4;
    let r;
    let g;
    let b;
    let a = 255;

    if (header.colorType === 3) {
      const entry = pixels[from] * 3;
      r = palette[entry];
      g = palette[entry + 1];
      b = palette[entry + 2];
      if (transparency && pixels[from] < transparency.length) {
        a = transparency[pixels[from]];
      }
    } else if (header.colorType === 0 || header.colorType === 4) {
      r = pixels[from];
      g = pixels[from];
      b = pixels[from];
      if (header.colorType === 4) a = pixels[from + 1];
    } else {
      r = pixels[from];
      g = pixels[from + 1];
      b = pixels[from + 2];
      if (header.colorType === 6) a = pixels[from + 3];
    }

    rgba[to] = r;
    rgba[to + 1] = g;
    rgba[to + 2] = b;
    rgba[to + 3] = a;
  }

  return { width, height, rgba };
}

/**
 * Finds the square plate inside the source card.
 *
 * The artwork is a dark rounded square sitting on white with a soft drop
 * shadow. A generous threshold would chase the shadow and pull the crop off
 * centre, so this only counts pixels that differ sharply from the corner
 * colour. Sources that already carry alpha are measured on alpha instead.
 */
function findPlate({ width, height, rgba }) {
  const at = (x, y) => (y * width + x) * 4;
  const corners = [
    at(0, 0),
    at(width - 1, 0),
    at(0, height - 1),
    at(width - 1, height - 1),
  ];
  const transparentCorners = corners.every((index) => rgba[index + 3] < 8);

  const background = [0, 1, 2].map((channel) =>
    Math.round(
      corners.reduce((sum, index) => sum + rgba[index + channel], 0) /
        corners.length,
    ),
  );

  const isArtwork = (index) => {
    if (transparentCorners) return rgba[index + 3] > 8;
    if (rgba[index + 3] < 8) return false;
    return [0, 1, 2].some(
      (channel) => Math.abs(rgba[index + channel] - background[channel]) > 96,
    );
  };

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isArtwork(at(x, y))) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) {
    throw new Error("Could not find any artwork in the source image.");
  }

  // Square the crop around the plate's centre. The smaller side wins so a
  // shadow that overshoots one edge cannot drag background into the frame.
  const side = Math.min(maxX - minX + 1, maxY - minY + 1);
  return {
    x: (minX + maxX + 1 - side) / 2,
    y: (minY + maxY + 1 - side) / 2,
    side,
  };
}

/**
 * Box-filter downscale of the cropped plate, then the rounded-rect mask.
 *
 * Averaging every source pixel that falls under a destination pixel is what
 * keeps the fine chevrons from aliasing into noise at 32px, which a nearest
 * neighbour or bilinear sample would not.
 */
function renderIcon(source, plate, size) {
  const buffer = new Uint8Array(size * size * 4);

  // Pull the crop in by a hair. The detected bounds sit on the plate's own
  // antialiased edge, and sampling that ring would ring the icon in white.
  const trim = Math.max(1, plate.side * 0.004);
  const originX = plate.x + trim;
  const originY = plate.y + trim;
  const span = plate.side - trim * 2;

  const center = size / 2;
  const half = size / 2 - size * PLATE_INSET;
  const radius = size * PLATE_RADIUS;

  // Source pixels covered by one destination pixel inside the mask.
  const boxSize = span / (half * 2);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const alpha = coverage(
        roundRectDistance(x + 0.5, y + 0.5, center, center, half, half, radius),
      );
      if (alpha <= 0) continue;

      // Map the mask back onto the crop, so the artwork's own corners land
      // exactly under the mask's corners.
      const left = originX + (x - (center - half)) * boxSize;
      const top = originY + (y - (center - half)) * boxSize;

      const x0 = Math.max(0, Math.floor(left));
      const x1 = Math.min(source.width, Math.max(x0 + 1, Math.ceil(left + boxSize)));
      const y0 = Math.max(0, Math.floor(top));
      const y1 = Math.min(source.height, Math.max(y0 + 1, Math.ceil(top + boxSize)));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let samples = 0;

      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const from = (sy * source.width + sx) * 4;
          r += source.rgba[from];
          g += source.rgba[from + 1];
          b += source.rgba[from + 2];
          a += source.rgba[from + 3];
          samples += 1;
        }
      }

      if (!samples) continue;

      const index = (y * size + x) * 4;
      buffer[index] = Math.round(r / samples);
      buffer[index + 1] = Math.round(g / samples);
      buffer[index + 2] = Math.round(b / samples);
      buffer[index + 3] = Math.round((a / samples) * alpha);
    }
  }

  return buffer;
}

async function main() {
  await mkdir(ASSETS, { recursive: true });

  const source = decodePng(await readFile(SOURCE));
  const plate = findPlate(source);

  // The icns pass asks for the same sizes twice, once for @1x and once for the
  // @2x alias, so each render is kept.
  const cache = new Map();
  const png = (size) => {
    if (!cache.has(size)) {
      cache.set(size, encodePng(renderIcon(source, plate, size), size));
    }
    return cache.get(size);
  };

  const ico = encodeIco(
    [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) })),
  );

  await writeFile(path.join(ASSETS, "icon.png"), png(1024));
  await writeFile(path.join(ASSETS, "icon.ico"), ico);

  // The web build wears the same mark, so the icon in a browser tab matches the
  // one in the dock.
  await writeFile(FAVICON, ico);

  await writeFile(SPLASH_LOGO, png(SPLASH_SIZE));

  if (process.platform === "darwin") {
    const iconset = path.join(ASSETS, "icon.iconset");
    await rm(iconset, { recursive: true, force: true });
    await mkdir(iconset, { recursive: true });

    for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
      await writeFile(path.join(iconset, `icon_${size}x${size}.png`), png(size));
      if (size > 16) {
        await writeFile(
          path.join(iconset, `icon_${size / 2}x${size / 2}@2x.png`),
          png(size),
        );
      }
    }

    await run("iconutil", [
      "-c",
      "icns",
      iconset,
      "-o",
      path.join(ASSETS, "icon.icns"),
    ]);
    await rm(iconset, { recursive: true, force: true });
  } else {
    console.warn("Skipped icon.icns: iconutil is only available on macOS.");
  }

  console.log(`Icons written to ${path.relative(ROOT, ASSETS)} and electron`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
