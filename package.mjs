/**
 * Chrome Web Store package builder.
 *
 * Zips exactly the files Chrome loads at runtime — no source maps (they leak
 * source and account for most of dist/'s size), no build diagnostics, no store
 * listing art. Written against node:zlib directly to avoid adding a dependency
 * and to avoid depending on a shell `zip` binary being installed.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { RUNTIME_ICON_FILES } from './build-config.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const distDir = join(root, 'dist');

/** Everything Chrome loads, and nothing else. Order is the archive order. */
const PACKAGED_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'dashboard-bridge.js',
  'popup.js',
  'popup.html',
  'popup.css',
  ...RUNTIME_ICON_FILES,
];

const SIGNATURE_LOCAL_FILE = 0x04034b50;
const SIGNATURE_CENTRAL_DIRECTORY = 0x02014b50;
const SIGNATURE_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION_DEFLATE = 20;
const METHOD_DEFLATE = 8;

/**
 * Encode a timestamp as an MS-DOS date/time pair. DOS time has two-second
 * resolution and a 1980 epoch, which is why the seconds field is halved and the
 * year offset by 1980.
 */
function toDosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  return { time, day };
}

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const { time, day } = toDosDateTime(entry.modifiedAt);
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.contents, { level: 9 });
    const checksum = crc32(entry.contents);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(SIGNATURE_LOCAL_FILE, 0);
    localHeader.writeUInt16LE(VERSION_DEFLATE, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(METHOD_DEFLATE, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(day, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.contents.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(SIGNATURE_CENTRAL_DIRECTORY, 0);
    centralHeader.writeUInt16LE(VERSION_DEFLATE, 4);
    centralHeader.writeUInt16LE(VERSION_DEFLATE, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(METHOD_DEFLATE, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(day, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.contents.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    localParts.push(localHeader, name, compressed);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIGNATURE_END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

const entries = PACKAGED_FILES.map((name) => {
  const path = join(distDir, name);
  let stats;

  try {
    stats = statSync(path);
  } catch {
    throw new Error(
      `Cannot package the extension: dist/${name} is missing. Run the production build first.`,
    );
  }

  return { name, contents: readFileSync(path), modifiedAt: stats.mtime };
});

// Version comes from the built manifest, not the environment, so the archive name
// can never disagree with the version Chrome will read inside it.
const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
const zipName = `airewards-extension-${manifest.version}.zip`;
const zipPath = join(root, zipName);
const archive = buildZip(entries);

writeFileSync(zipPath, archive);

console.log(`Packaged ${entries.length} files into ${zipName} (${archive.length} bytes)`);
