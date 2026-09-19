# Pool name catalog provenance and upgrade boundary

The current runtime has **5,000 bases × suffixes `00`–`01` = 10,000 candidate positions**. This changes name distribution, not pool capacity. Every original base remains at its original index 0–999; 4,000 new bases are appended. A base means a unique `first.last` combination, not a distinct first name. Existing account identities, SSO users, ordinals, leases and credentials are never renamed or rewritten.

## Provenance

The original 1,000-entry JSON entered this repository in commit `da76eb1e12f2ecc2ecf3075dd4b75190c04c4338` (`feat(pool): add exclusive caller leases and managed account provisioning`, author/committer Max Zhou, 2026-09-11). The repository describes it as synthetic but contains no original generator, source website, dataset attribution or source license. Its actual external origin cannot be established from the checked-in evidence. Do not describe it as downloaded from a specific site or claim a verified license. It contains 1,000 distinct first-name tokens and 465 surname tokens cycling every 465 positions, from `aaliyah.abbott` to `emmanuelle.corkery`; first-name initials are A–E.

The **new additions** are deterministic synthetic combinations of explicit short given-name and surname tokens authored in `scripts/pool-name-tokens.mjs` for this repository. No website, individual records, external name dataset or additional dependency was imported for these additions. F–Z additions are selected evenly (190 or 191 per initial), then the entire appended 4,000-entry set is sorted lexicographically as one F–Z sequence. The original A–E prefix is already lexicographically ordered and remains untouched, so the final 5,000-entry catalog is A–Z overall. The curated source has eight given-name tokens for each of the 21 F–Z initials and 32 surname tokens, enough for 5,376 distinct full combinations; the generator selects the first 4,000 deterministically. This provenance statement does not retroactively establish the original catalog's source or license.

## Reproduction

Only edit the token source and reviewed generator when intentionally designing a later catalog version. Never hand-edit either generated JSON or reorder a published entry. Earlier 2,500-base and interleaved 5,000-base ordering were unpublished development candidates, not a supported persisted-catalog version; the final appended-set sort occurs before publication. The original published 1,000-entry prefix is never sorted or changed by the generator.

```sh
node scripts/generate-pool-name-catalog.mjs
node scripts/generate-pool-name-catalog.mjs --check
```

The generator pins the LF-normalized SHA256 of `upgrade/v1-frozen/userPool/nameCatalog.json` to `300b019ad4ed10c25071af2e8105b6fc556bfb4378bf77d3cddd90f5858951b5`, copies its exact 1,000-element order, and writes byte-identical canonical `src/packages/shared/src/poolNameCatalog.json` and Proxy compatibility `src/proxy/src/userPool/nameCatalog.json`. Frozen v1 code/catalog and earlier migration behavior must remain unchanged. Tests check all 10,000 generated names for uniqueness, lowercase collision safety and GitHub-style handle normalization with the longest allowed enterprise shortcode.

## Fail-closed adoption policy

Changing the base count changes ordinal mapping from position 1000 onward. Old ordinal 1000 meant `aaliyah.abbott01`; the new mapping means the first appended base plus `00`. Merely keeping the first 1,000 bases is therefore **not** enough to promise universal compatibility.

Runtime V4 startup and final V3→V4 offline preflight perform a bounded, read-only inventory check before application writes or migration mutations:

- `next_ordinal` must be an integer in 0–10000. At most 10,000 inventory rows are accepted; the query reads at most 10,001 rows to detect excess.
- Every inventory ordinal must be unique, nonnegative, strictly below the cursor, and map exactly to the new catalog. Its persisted identity and Proxy SSO alias must match exactly.
- Cursor at most 1000 with matching original-prefix inventory is safe to adopt. This is checked from the database, never inferred from customer estimates.
- Beyond 1000, at least one exact new-catalog inventory row with ordinal at least 1000 must exist. Without that evidence, a consumed cursor may be old-catalog history or collision skips; it is rejected as ambiguous.
- Any incompatible old suffix row, mixed old/new mapping, malformed alias, excessive row count or ambiguous consumed cursor fails with `name_catalog_upgrade_required`. Keep the previous runtime and arrange a separately reviewed offline identity-preserving migration. Never reset the cursor, renumber rows, rename accounts, delete historical inventory or silently rewrite fingerprints.

The conservative no-schema approach has a deliberate limitation: if the first crossing of ordinal 1000 skips all candidates due to collisions and writes no new-catalog inventory row, restart fails closed. It does not guess or rewind. A general legacy-catalog continuation/mixed-catalog migration requires an explicit persistent version/cutover design and is not implemented here.

Use a stopped/drained offline deployment cutover. **Mixed old/new writer versions and rolling catalog upgrades are unsupported.** The existing MySQL configuration fingerprint does not encode catalog contents, and SQLite has no corresponding fingerprint; neither is silently repurposed. No customer database was inspected to establish eligibility.

Earlier frozen v1 migration tools still validate and copy their original names. They do not import the new catalog. The final V4 preflight applies the new compatibility barrier before output/DDL mutation; original-column fidelity checks remain intact. Run this final preflight against an offline backup before choosing this runtime. A blocked high-ordinal installation must not be treated as successfully upgraded merely because an earlier intermediate migration completed.

The global cursor and cap remain 10,000. Reservation still skips global Proxy identity/SSO-alias collisions without reuse; an exhausted cursor stays exhausted. Additional enterprise capacity does not replenish names.
