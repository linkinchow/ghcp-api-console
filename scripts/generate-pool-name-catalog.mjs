import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GIVEN_BY_INITIAL, SURNAMES } from './pool-name-tokens.mjs';

const root = new URL('../', import.meta.url);
const path = name => fileURLToPath(new URL(name, root));
const frozenText = readFileSync(path('upgrade/v1-frozen/userPool/nameCatalog.json'), 'utf8').replaceAll('\r\n', '\n');
const frozenHash = createHash('sha256').update(frozenText).digest('hex');
if (frozenHash !== '300b019ad4ed10c25071af2e8105b6fc556bfb4378bf77d3cddd90f5858951b5') throw new Error('Frozen legacy name catalog changed');
const original = JSON.parse(frozenText);
if (original.length !== 1000 || new Set(original).size !== 1000) throw new Error('Invalid original catalog');
const names = [...original], seen = new Set(original), letters = Object.keys(GIVEN_BY_INITIAL).sort();
if (letters.join('') !== 'fghijklmnopqrstuvwxyz') throw new Error('Expected balanced F-Z source buckets');
// Select a balanced set by round-robin initial, then given name and surname.
// Ordering is applied only to the additions below; the frozen prefix never moves.
for (let ordinal = 0; names.length < 5000; ordinal++) {
  const initial = letters[ordinal % letters.length];
  const round = Math.floor(ordinal / letters.length), given = GIVEN_BY_INITIAL[initial];
  const surname = SURNAMES[Math.floor(round / given.length)];
  if (!surname) throw new Error('Synthetic source tokens exhausted');
  const name = `${given[round % given.length]}.${surname}`;
  if (seen.has(name)) continue;
  if (!/^[a-z]+\.[a-z]+$/.test(name) || name.length > 27) throw new Error('Unsafe appended base');
  seen.add(name); names.push(name);
}
// The earlier interleaved addition order was an unpublished development draft.
// Sort the whole appended set once as F-Z, never the original1000 prefix.
const orderedNames = [...original, ...names.slice(original.length).sort()];
const content = JSON.stringify(orderedNames, null, 2) + '\n';
const outputs = ['src/packages/shared/src/poolNameCatalog.json', 'src/proxy/src/userPool/nameCatalog.json'];
if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Only --check is supported');
for (const output of outputs) {
  if (process.argv.includes('--check')) {
    if (readFileSync(path(output), 'utf8').replaceAll('\r\n', '\n') !== content) throw new Error(`Generated catalog differs: ${output}`);
  } else writeFileSync(path(output), content);
}
console.log(`${process.argv.includes('--check') ? 'Verified' : 'Generated'} ${names.length} bases, frozen first 1000 unchanged, 4000 original synthetic F-Z additions.`);
