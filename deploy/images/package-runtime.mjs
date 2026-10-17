// Runs inside the release image build stage: copies each workspace's compiled output for the
// runtime stages and writes an inventory of the production dependencies that ship with them.
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = '/app';
const TARGET = '/runtime';
const WORKSPACES = ['shared', 'proxy', 'sso', 'login', 'console'];
const EXCLUDED = /(?:\.test|\.spec)\.(?:js|json)$|(?:^|\/)tests?\//;
const INVENTORY = path.join(ROOT, 'node_modules', 'ghcp-production-dependencies.json');

/** SPDX expression from `license`, or from the legacy `license: {type}` / `licenses: [...]` forms. */
export function normalizeLicense(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim();
  if (typeof pkg.license?.type === 'string') return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter((type) => typeof type === 'string' && type.trim());
    if (types.length === 1) return types[0];
    if (types.length > 1) return `(${types.join(' OR ')})`;
  }
  return null;
}

async function copyRuntime(source, destination, relative = '') {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (EXCLUDED.test(rel)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyRuntime(from, to, rel);
    else if (entry.isFile()) await cp(from, to);
    else throw new Error(`Unexpected runtime file type: ${rel}`);
  }
}

async function packageWorkspaces() {
  await mkdir(TARGET, { recursive: true });
  for (const name of WORKSPACES) {
    const source = name === 'shared' ? path.join(ROOT, 'src/packages/shared') : path.join(ROOT, 'src', name);
    const destination = path.join(TARGET, name);
    await mkdir(destination, { recursive: true });
    await cp(path.join(source, 'package.json'), path.join(destination, 'package.json'));
    await copyRuntime(path.join(source, 'dist'), path.join(destination, 'dist'));
  }
}

async function readPackageJson(directory) {
  try {
    return JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function collectDependencies(directory, dependencies) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    // Workspace links point back into src/ and are packaged separately.
    if (entry.name === '.bin' || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const location = path.join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      await collectDependencies(location, dependencies);
      continue;
    }
    const pkg = await readPackageJson(location);
    if (pkg) dependencies.push({ name: pkg.name, version: pkg.version, license: normalizeLicense(pkg) });
    await collectDependencies(path.join(location, 'node_modules'), dependencies);
  }
}

async function main() {
  await packageWorkspaces();
  const dependencies = [];
  await collectDependencies(path.join(ROOT, 'node_modules'), dependencies);
  dependencies.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  await writeFile(INVENTORY, `${JSON.stringify(dependencies, null, 2)}\n`);
  const unknown = dependencies.filter((dependency) => dependency.license === null).map((d) => `${d.name}@${d.version}`);
  console.log(`Packaged ${WORKSPACES.length} runtime workspaces and ${dependencies.length} dependency entries; package license files remain in node_modules.`);
  if (unknown.length) console.log(`Dependencies without license metadata (review manually): ${unknown.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
