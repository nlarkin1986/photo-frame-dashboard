// Mirrors a folder of photos into the private Vercel Blob store the dashboard reads from.
//
//   npm run photos -- ~/Pictures/Frame
//
// Each photo is resized with macOS `sips` (JPEG, HEIC and PNG all work) into a large and a
// small JPEG. Files directly in the folder get no place name; files in a subfolder use the
// subfolder's name as their place ("Tofino 2021/beach.jpg" shows "Tofino 2021"). Photos that
// were removed from the folder are deleted from the store. Running it again only uploads what
// changed.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { del, list, put } from '@vercel/blob';
import exifr from 'exifr';

const SIZES = { l: 1600, s: 800 };
const EXTENSIONS = /\.(jpe?g|heic|heif|png)$/i;

const root = process.argv[2];
if (!root || !statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('Usage: npm run photos -- <folder of photos>');
  process.exit(1);
}

function files(dir, depth = 0) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return depth === 0 ? files(path, 1) : [];
    return EXTENSIONS.test(entry.name) ? [path] : [];
  });
}

function pixels(path) {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { encoding: 'utf8' });
  return [Number(out.match(/pixelWidth: (\d+)/)[1]), Number(out.match(/pixelHeight: (\d+)/)[1])];
}

function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function describe(path) {
  const bytes = readFileSync(path);
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const exif = (await exifr.parse(bytes, { pick: ['DateTimeOriginal', 'CreateDate', 'Orientation'], translateValues: false }).catch(() => null)) || {};
  const taken = exif.DateTimeOriginal || exif.CreateDate || statSync(path).mtime;
  let [w, h] = pixels(path);
  // EXIF orientations 5-8 are rotated a quarter turn; the browser applies the rotation.
  if (exif.Orientation >= 5) [w, h] = [h, w];
  const folder = relative(root, path).split(sep).length > 1 ? relative(root, path).split(sep)[0] : '';
  const date = isoDate(new Date(taken));
  return {
    id,
    o: h > w ? 'p' : 'l',
    date,
    place: folder,
    // Photos from the same folder (or the same day) can be paired side by side.
    tag: folder ? 'f-' + createHash('sha256').update(folder).digest('hex').slice(0, 8) : 'd-' + date,
    path,
  };
}

const photos = [];
for (const path of files(root)) {
  try {
    photos.push(await describe(path));
  } catch (err) {
    console.warn(`Skipping ${relative(root, path)}: ${err.message}`);
  }
}
const unique = [...new Map(photos.map((p) => [p.id, p])).values()];

const existing = new Set();
let cursor;
do {
  const page = await list({ prefix: 'photos/', cursor });
  page.blobs.forEach((b) => existing.add(b.pathname));
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);

const work = mkdtempSync(join(tmpdir(), 'frame-photos-'));
let uploaded = 0;
try {
  for (const p of unique) {
    for (const [size, edge] of Object.entries(SIZES)) {
      const pathname = `photos/${p.id}-${size}.jpg`;
      if (existing.has(pathname)) continue;
      const out = join(work, `${p.id}-${size}.jpg`);
      execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', String(edge), p.path, '--out', out], { stdio: 'ignore' });
      await put(pathname, readFileSync(out), { access: 'private', contentType: 'image/jpeg', addRandomSuffix: false, allowOverwrite: true });
      uploaded++;
    }
    console.log(`${p.date}  ${p.o === 'p' ? 'portrait ' : 'landscape'}  ${relative(root, p.path)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const index = unique.map(({ path, ...photo }) => photo).sort((a, b) => a.date.localeCompare(b.date));
await put('photos/index.json', JSON.stringify(index), {
  access: 'private', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true,
});

const keep = new Set(unique.flatMap((p) => Object.keys(SIZES).map((s) => `photos/${p.id}-${s}.jpg`)));
const stale = [...existing].filter((pathname) => pathname !== 'photos/index.json' && !keep.has(pathname));
if (stale.length) await del(stale);

console.log(`\n${index.length} photos in the frame, ${uploaded} files uploaded, ${stale.length} removed.`);
