import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Reuse the rasterizer installed by this Next.js workspace.
const require = createRequire(import.meta.url);
const requireNext = createRequire(require.resolve('next/package.json'));
const sharp = requireNext('sharp');

const brand = JSON.parse(await readFile(new URL('../lib/brand.json', import.meta.url), 'utf8'));
const output = new URL('../public/brand/', import.meta.url);
await mkdir(output, { recursive: true });

function svg(content, title = brand.name) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="${brand.mark.viewBox}" role="img"><title>${title}</title>${content}</svg>\n`;
}

const mark = (color) => `<path fill="${color}" d="${brand.mark.path}"/>`;
const icon = svg(
  `<rect width="32" height="32" rx="${brand.icon.radius}" fill="${brand.colors.ink}"/><g transform="${brand.icon.transform}">${mark(brand.colors.mint)}</g>`,
);

for (const name of ['deep', 'mint', 'ink', 'white', 'black']) {
  const source = svg(mark(brand.colors[name]));
  await writeFile(new URL(`logo-${name}.svg`, output), source);
  await sharp(Buffer.from(source), { density: 1152 })
    .resize(512, 512)
    .png()
    .toFile(fileURLToPath(new URL(`logo-${name}-512.png`, output)));
}
await writeFile(new URL('favicon.svg', output), icon);

const faviconBuffers = [];
for (const size of [16, 32, 48, 192, 512]) {
  const png = await sharp(Buffer.from(icon), { density: 1152 }).resize(size, size).png().toBuffer();
  const filename = size <= 48 ? `favicon-${size}.png` : `icon-${size}.png`;
  await writeFile(new URL(filename, output), png);
  if (size <= 48) faviconBuffers.push({ size, png });
}

// Apple applies its own corner mask. Supply a full opaque square at 180px.
const apple = svg(
  `<rect width="32" height="32" fill="${brand.colors.ink}"/><g transform="${brand.icon.transform}">${mark(brand.colors.mint)}</g>`,
);
await sharp(Buffer.from(apple), { density: 1152 })
  .resize(180, 180)
  .png()
  .toFile(fileURLToPath(new URL('apple-touch-icon.png', output)));

// ICO directory containing actual 16/32/48px PNG images; no runtime converter needed.
const directory = Buffer.alloc(6 + faviconBuffers.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(faviconBuffers.length, 4);
let offset = directory.length;
faviconBuffers.forEach(({ size, png }, index) => {
  const entry = 6 + index * 16;
  directory[entry] = size;
  directory[entry + 1] = size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(png.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
await writeFile(
  new URL('../public/favicon.ico', import.meta.url),
  Buffer.concat([directory, ...faviconBuffers.map(({ png }) => png)]),
);
// Commit the mirrors so the Web example builds independently of the docs workspace.
const web = new URL('../../packages/app/web/', import.meta.url);
await mkdir(new URL('public/', web), { recursive: true });
await cp(output, new URL('public/brand/', web), { recursive: true });
await copyFile(
  new URL('../public/favicon.ico', import.meta.url),
  new URL('public/favicon.ico', web),
);
await copyFile(
  new URL('../lib/brand.json', import.meta.url),
  new URL('lib/brand.generated.json', web),
);
console.log('Generated brand assets for the docs and Web example.');
