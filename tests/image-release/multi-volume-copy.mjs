// Backup / restore of stopped service volumes for the multi-enterprise rollback drill. Runs as root in a throwaway,
// network-less helper container of the cached Node image:
//   node /fixtures/multi-volume-copy.mjs backup|restore|manifest <volume>...
// Each volume is mounted at /volumes/<volume>; the run's backup volume at /backup. Restore empties the mounted
// volume's contents (never the volume itself) and copies the backup back. Owner, group, mode and mtime are
// preserved (the services do not run as root), and both sides are compared by a manifest of path, SHA-256,
// owner and mode. Prints one JSON line with per-volume file counts and manifest hashes; never file contents.
import { createHash } from 'node:crypto';
import {
  chmodSync, chownSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync,
} from 'node:fs';
import { join, relative } from 'node:path';

const [operation, ...volumes] = process.argv.slice(2);
const sha = (value) => createHash('sha256').update(value).digest('hex');

function walk(root, directory = root) {
  const result = [];
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('symlink_not_supported');
    if (stat.isDirectory()) result.push(path, ...walk(root, path));
    else if (stat.isFile()) result.push(path);
    else throw new Error('special_file_not_supported');
  }
  return result;
}

function manifest(root) {
  if (!existsSync(root)) return { files: 0, sha256: sha('[]') };
  const entries = walk(root).map((path) => {
    const stat = lstatSync(path);
    const content = stat.isFile() ? sha(readFileSync(path)) : 'dir';
    return [relative(root, path).replaceAll('\\', '/'), content, stat.uid, stat.gid, stat.mode & 0o7777];
  });
  return { files: entries.filter((entry) => entry[1] !== 'dir').length, sha256: sha(JSON.stringify(entries)) };
}

/** Copies the contents of `source` into the existing directory `target`, keeping owner, mode and times. */
function copyContents(source, target) {
  for (const path of walk(source)) {
    const destination = join(target, relative(source, path));
    const stat = lstatSync(path);
    if (stat.isDirectory()) mkdirSync(destination);
    else copyFileSync(path, destination);
    chownSync(destination, stat.uid, stat.gid);
    chmodSync(destination, stat.mode & 0o7777);
  }
  // Times last: creating children updates a directory's mtime.
  for (const path of walk(source).reverse()) {
    const stat = lstatSync(path);
    utimesSync(join(target, relative(source, path)), stat.atime, stat.mtime);
  }
}

function emptyContents(directory) {
  for (const entry of readdirSync(directory)) rmSync(join(directory, entry), { recursive: true, force: true });
}

try {
  if (!['backup', 'restore', 'manifest'].includes(operation) || volumes.length < 1
    || !volumes.every((name) => /^[a-z0-9-]+$/.test(name))) {
    throw new Error('invalid_arguments');
  }
  const result = {};
  for (const name of volumes) {
    const live = `/volumes/${name}`;
    const saved = `/backup/${name}`;
    if (!existsSync(live)) throw new Error('volume_not_mounted');
    if (operation === 'backup') {
      if (existsSync(saved)) throw new Error('backup_already_exists');
      mkdirSync(saved, { recursive: true });
      copyContents(live, saved);
    } else if (operation === 'restore') {
      if (!existsSync(saved)) throw new Error('backup_missing');
      emptyContents(live);
      copyContents(saved, live);
    }
    const current = manifest(live);
    const backup = manifest(saved);
    if (operation !== 'manifest' && current.sha256 !== backup.sha256) throw new Error('manifest_mismatch');
    result[name] = { live: current, backup };
  }
  console.log(JSON.stringify({ volumeCopy: true, operation, volumes: result }));
} catch (error) {
  const reason = /^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'volume_copy_failed';
  console.log(JSON.stringify({ volumeCopy: false, operation, error: reason }));
  process.exitCode = 1;
}
