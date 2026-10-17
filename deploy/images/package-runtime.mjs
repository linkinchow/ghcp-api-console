import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = '/app';
const target = '/runtime';
const excluded = /(?:\.test|\.spec)\.(?:js|json)$|(?:^|\/)tests?\//;
async function copyRuntime(source, destination, relative = '') {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (excluded.test(rel)) continue;
    const src = path.join(source, entry.name), dst = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyRuntime(src, dst, rel);
    else if (entry.isFile()) await cp(src, dst);
    else throw new Error(`Unexpected runtime file type: ${rel}`);
  }
}

await mkdir(target, { recursive: true });
for (const name of ['shared', 'proxy', 'sso', 'login', 'console']) {
  const source = name === 'shared' ? path.join(root, 'src/packages/shared') : path.join(root, 'src', name);
  const destination = path.join(target, name);
  await mkdir(destination, { recursive: true });
  await cp(path.join(source, 'package.json'), path.join(destination, 'package.json'));
  await copyRuntime(path.join(source, 'dist'), path.join(destination, 'dist'));
}

const dependencies = [];
async function inspectPackages(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.isSymbolicLink()) continue;
    const location = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) { await inspectPackages(location); continue; }
    try {
      const pkg = JSON.parse(await readFile(path.join(location, 'package.json'), 'utf8'));
      dependencies.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? null });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await inspectPackages(path.join(location, 'node_modules')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
await inspectPackages(path.join(root, 'node_modules'));
dependencies.sort((a,b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
await writeFile(path.join(root, 'node_modules', 'ghcp-production-dependencies.json'), JSON.stringify(dependencies, null, 2) + '\n');
console.log(`Packaged five runtime workspaces and ${dependencies.length} dependency entries; package license files remain in node_modules.`);
