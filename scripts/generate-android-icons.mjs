import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Jimp = require('jimp-compact');

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const RES = path.join(ROOT, 'android/app/src/main/res');

const DENSITIES = {
  mdpi: 108,
  hdpi: 162,
  xhdpi: 216,
  xxhdpi: 324,
  xxxhdpi: 432,
};

const SAFE_ZONE_FRACTION = 66 / 108;

const LAYERS = [
  { source: 'assets/android-icon-foreground.png', output: 'ic_launcher_foreground.webp' },
  { source: 'assets/android-icon-monochrome.png', output: 'ic_launcher_monochrome.webp' },
];

const NOTIFICATION_DENSITIES = {
  mdpi: 24,
  hdpi: 36,
  xhdpi: 48,
  xxhdpi: 72,
  xxxhdpi: 96,
};

const NOTIFICATION_FILL = 0.9;

function contentBox(image) {
  const { width, height, data } = image.bitmap;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {

      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('The image is entirely transparent.');
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function contentFraction(image) {
  const box = contentBox(image);
  return Math.max(box.width / image.bitmap.width, box.height / image.bitmap.height);
}

const NOTIFICATION_SOURCE = { output: 'assets/android-notification-icon.png', size: 432 };

async function writeNotificationSourceAsset(Image, glyph) {
  const { size } = NOTIFICATION_SOURCE;
  const inner = Math.round(size * NOTIFICATION_FILL);
  const scaled = glyph.clone().contain(inner, inner, Image.RESIZE_BICUBIC);
  const canvas = new Image(size, size, 0x00000000);
  canvas.composite(scaled, Math.round((size - inner) / 2), Math.round((size - inner) / 2));
  canvas.scan(0, 0, size, size, function paint(x, y, index) {
    this.bitmap.data[index] = 255;
    this.bitmap.data[index + 1] = 255;
    this.bitmap.data[index + 2] = 255;
  });
  await writeFile(path.join(ROOT, NOTIFICATION_SOURCE.output), await canvas.getBufferAsync(Image.MIME_PNG));
  return NOTIFICATION_SOURCE.output;
}

async function writeNotificationIcon(Image, source) {
  const original = await Image.read(path.join(ROOT, source));
  const box = contentBox(original);
  const glyph = original.clone().crop(box.x, box.y, box.width, box.height);

  const written = [await writeNotificationSourceAsset(Image, glyph)];
  for (const [density, size] of Object.entries(NOTIFICATION_DENSITIES)) {
    const directory = path.join(RES, `drawable-${density}`);
    await mkdir(directory, { recursive: true });
    const inner = Math.round(size * NOTIFICATION_FILL);
    const scaled = glyph.clone().contain(inner, inner, Image.RESIZE_BICUBIC);
    const canvas = new Image(size, size, 0x00000000);
    canvas.composite(scaled, Math.round((size - inner) / 2), Math.round((size - inner) / 2));

    canvas.scan(0, 0, size, size, function paint(x, y, index) {
      this.bitmap.data[index] = 255;
      this.bitmap.data[index + 1] = 255;
      this.bitmap.data[index + 2] = 255;
    });

    await writeFile(path.join(directory, 'notification_icon.png'), await canvas.getBufferAsync(Image.MIME_PNG));
    written.push(`drawable-${density}/notification_icon.png`);
  }
  return written;
}

export async function generateAndroidIcons() {
  const written = [];
  for (const { source, output } of LAYERS) {
    const image = await Jimp.read(path.join(ROOT, source));
    if (image.bitmap.width !== image.bitmap.height) {
      throw new Error(`${source} is ${image.bitmap.width}x${image.bitmap.height}; an adaptive layer must be square.`);
    }

    const fraction = contentFraction(image);
    if (fraction > SAFE_ZONE_FRACTION) {
      throw new Error(
        `${source} has artwork filling ${(fraction * 100).toFixed(1)}% of its canvas, but a ` +
          `launcher mask may crop everything past ${(SAFE_ZONE_FRACTION * 100).toFixed(1)}%. ` +
          'Add transparent padding to the source rather than resizing the art.',
      );
    }

    for (const [density, size] of Object.entries(DENSITIES)) {
      const directory = path.join(RES, `mipmap-${density}`);
      await mkdir(directory, { recursive: true });
      const resized = image.clone().resize(size, size, Jimp.RESIZE_BICUBIC);
      await writeFile(path.join(directory, output), await resized.getBufferAsync(Jimp.MIME_PNG));
      written.push(`mipmap-${density}/${output}`);
    }
  }

  written.push(...(await writeNotificationIcon(Jimp, 'assets/android-icon-monochrome.png')));
  return written;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  generateAndroidIcons().then(
    (written) => {
      console.log(`Wrote ${written.length} launcher layers:`);
      for (const name of written) console.log(`  ${name}`);
    },
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
