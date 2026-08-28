/**
 * Generate ShopiQ's site identity icons from the brand logo.
 *
 *   node scripts/generate-icons.mjs
 *
 * The source is the 2000×2000 brand mark on R2. It is a rounded orange square,
 * but it has NO alpha channel — the area outside the rounded corners is solid
 * black. Shipped as-is, every browser tab would show black triangles in the
 * corners of the icon against a light toolbar.
 *
 * The fix cannot be "make black transparent", because the shopping cart in the
 * middle of the mark is black too. Instead the transparent region is found by
 * flood-filling inward from the four corners: the corner black is connected to
 * the edge, the cart is enclosed by orange and is never reached. That derives
 * the real silhouette from the artwork rather than guessing a corner radius,
 * so it stays correct if the logo is ever redrawn.
 *
 * Outputs are committed to the repository. A deploy must not depend on the CDN
 * being reachable at build time.
 */
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const SOURCE =
  process.env.SHOPIQ_LOGO_URL ?? 'https://cdn.shopiq.yashgarg.co.in/Logo/ShopiQ.png';

const APP = path.join(process.cwd(), 'app');

/** Brand orange, used as the flat background for the social preview. */
const BRAND = { r: 255, g: 152, b: 31 };

/** Near-black, allowing for the JPEG-ish fringing around the artwork edges. */
const isDark = (r, g, b) => r < 60 && g < 60 && b < 60;

/**
 * Build an alpha channel by flood-filling from the image border.
 *
 * Iterative rather than recursive: 4 million pixels would blow the call stack.
 */
function silhouetteAlpha(data, width, height, channels) {
  const outside = new Uint8Array(width * height);
  const stack = [];

  const consider = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (outside[index]) return;
    const offset = index * channels;
    if (!isDark(data[offset], data[offset + 1], data[offset + 2])) return;
    outside[index] = 1;
    stack.push(x, y);
  };

  for (let x = 0; x < width; x += 1) {
    consider(x, 0);
    consider(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    consider(0, y);
    consider(width - 1, y);
  }

  while (stack.length > 0) {
    const y = stack.pop();
    const x = stack.pop();
    consider(x + 1, y);
    consider(x - 1, y);
    consider(x, y + 1);
    consider(x, y - 1);
  }

  const alpha = Buffer.alloc(width * height);
  for (let i = 0; i < outside.length; i += 1) alpha[i] = outside[i] ? 0 : 255;
  return alpha;
}

/**
 * An .ico wrapping a PNG.
 *
 * The ICO format has allowed PNG-compressed entries since Vista, and every
 * browser that still asks for /favicon.ico understands them. sharp cannot
 * write .ico, and the container is 22 bytes of header, so it is written here
 * rather than pulling in a dependency for it.
 */
function icoFromPng(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width  (0 means 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette size
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, png]);
}

const response = await fetch(SOURCE);
if (!response.ok) {
  console.error(`Could not fetch the logo: ${response.status} ${SOURCE}`);
  process.exit(1);
}
const source = Buffer.from(await response.arrayBuffer());

const { data, info } = await sharp(source)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const alpha = silhouetteAlpha(data, info.width, info.height, info.channels);

const transparent = alpha.reduce((count, value) => count + (value === 0 ? 1 : 0), 0);
console.log(
  `source ${info.width}×${info.height} — ${((transparent / alpha.length) * 100).toFixed(1)}% ` +
    'masked out as corner background',
);

// The master: the logo with its real silhouette as alpha.
const master = await sharp(source)
  .ensureAlpha()
  .joinChannel(alpha, { raw: { width: info.width, height: info.height, channels: 1 } })
  .png()
  .toBuffer();

const square = (size) => sharp(master).resize(size, size, { fit: 'cover' }).png().toBuffer();

// app/icon.png — Next generates the <link rel="icon"> tags from this.
await fs.writeFile(path.join(APP, 'icon.png'), await square(512));

// Apple wants an opaque icon: iOS puts no rounding of its own on a home-screen
// icon it was given transparency for, and the corners would render black.
await fs.writeFile(
  path.join(APP, 'apple-icon.png'),
  await sharp(master)
    .resize(180, 180, { fit: 'cover' })
    .flatten({ background: BRAND })
    .png()
    .toBuffer(),
);

// A real favicon.ico, for the clients that request the path directly rather
// than reading the link tags.
await fs.writeFile(path.join(APP, 'favicon.ico'), icoFromPng(await square(32), 32));

// The social preview.
//
// On the app's own pitch black rather than a flat orange field, so a shared
// link looks like the product it opens. The mark is composited rather than
// cropped — a 1200×630 cover crop of a square would slice the cart in half —
// and the wordmark is drawn as SVG text so the card says what it links to.
const OG_BACKGROUND = '#08080A';
const markSize = 200;

const wordmark = Buffer.from(
  `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
     <style>
       .name { font: 700 96px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
       .tag  { font: 400 34px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
     </style>
     <text x="600" y="420" class="name" fill="#FFFFFF" text-anchor="middle">
       Shopi<tspan fill="#F7931E">Q</tspan>
     </text>
     <text x="600" y="482" class="tag" fill="#8A8A93" text-anchor="middle">
       Shop by talking. Voice and chat, in English or Hindi.
     </text>
   </svg>`,
);

await fs.writeFile(
  path.join(APP, 'opengraph-image.png'),
  await sharp({
    create: { width: 1200, height: 630, channels: 4, background: OG_BACKGROUND },
  })
    .composite([
      {
        input: await sharp(master).resize(markSize, markSize, { fit: 'contain' }).png().toBuffer(),
        top: 120,
        left: Math.round((1200 - markSize) / 2),
      },
      { input: wordmark, top: 0, left: 0 },
    ])
    .png()
    .toBuffer(),
);

for (const file of ['icon.png', 'apple-icon.png', 'favicon.ico', 'opengraph-image.png']) {
  const { size } = await fs.stat(path.join(APP, file));
  console.log(`  app/${file.padEnd(22)} ${(size / 1024).toFixed(1)} kB`);
}
