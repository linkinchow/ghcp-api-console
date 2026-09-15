import test from 'node:test';
import { enabled, options } from './stream-soak-safety.js';

// Discovery without opt-in skips, never silently counts as real-engine acceptance.
const selected = enabled(process.env);
test('bounded real-MySQL independent-proxy long SSE smoke', { skip: !selected, timeout: 105000 }, async () => {
  // The immutable-source/manifest-aware CLI is the designated VM launch path.
  const { runSoak } = await import('./stream-soak-harness.js');
  await runSoak(options([]));
});
