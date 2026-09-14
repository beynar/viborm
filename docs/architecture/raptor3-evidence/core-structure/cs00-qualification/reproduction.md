# CS-00 qualification reproduction

Run from the repository root with Node v24.21.0. Keep production identity
`2fa782174626ac1d27b31ecae3beb6fdf97f49450b86ceeb94230f90ba579e11`
and harness identity
`e0da0fd939ab2ba5fde32c094bb407d3648421bc40ab8f539372203c501b87ff`
unchanged. Run all validators serially under the registered ceilings.

Run the 26 modes under `receipts/fixed` with
`node scripts/run-raptor3.mjs <mode>`. Run `g2-diagnostics` separately as
nonqualifying evidence.

Run the ordinary aggregate and five isolated PGlite files:

```sh
node scripts/run-credential-free-tests.mjs --only 'Raptor 3 fixed contracts'
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/expanded/produced-legacy.test.ts'
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/expanded/batch-produced-legacy.test.ts'
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/expanded/produced-commands.test.ts'
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/expanded/batch-produced-commands.test.ts'
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/post-prep/g29-result-progress-pglite.test.ts'
```

For native providers, use only the cached image digests in `index.json`. Start
one task-owned provider at a time with a random loopback port, tmpfs data, two
CPUs, 1 GiB memory, no host mount, and a dedicated `viborm.test` label. Pass
only its mapped port as `VIBORM_RAPTOR3_PROVIDER_PORT`. PostgreSQL modes are
`g2-pg-baseline`, `g2-pg-contracts`, `g25-pg-contracts`,
`g27-pg-contracts`, `g3p02-pg-contracts`, `g3p03-pg-contracts`,
`g3p04-pg-contracts`, `post-g3-clearability-pg-contracts`, and
`g29-member-dependency-pg`. MySQL uses the corresponding modes except G2.5,
plus `g29-member-dependency-mysql`. Inspect OOM and restart state, remove the
exact container ID, and require an empty task-label census.

Run the campaigns, replay, support, structure, and cost commands:

```sh
node scripts/run-raptor3.mjs g2-seeds
node scripts/run-raptor3.mjs g2-transport-seeds
node scripts/run-raptor3.mjs g3p06-seeds
node scripts/run-raptor3.mjs g3p06-transport-seeds
node scripts/run-raptor3.mjs replay <fresh-g25-polish-corpus.json>
node scripts/run-raptor3.mjs replay <fresh-g2-conditional-upsert-corpus.json>
node scripts/run-raptor3.mjs replay docs/architecture/raptor3-evidence/post-g3-fact-ownership/final-qualification/corpora/g25-polish-corpus.json
node scripts/run-raptor3.mjs replay docs/architecture/raptor3-evidence/post-g3-fact-ownership/final-qualification/corpora/g2-conditional-upsert-corpus.json
node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs
node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs
pnpm test:types
node scripts/query-engine-structure.mjs
node scripts/measure-raptor3-baseline.mjs --output <cost.json>
```

The two historical replay commands must refuse their stale embedded identity;
they are not passing saved-replay gates. Measure parser token count by the same
parser-owned leaf traversal as `scripts/query-engine-structure.mjs`: skip JSDoc
and EOF and count leaf tokens. Do not substitute a standalone scanner.

Archive each campaign parent and, keyed by `firstSeed`, every child's
`verified.json`, `vitest.json`, and `generated-campaign.json`. Omit large
per-batch corpora and progress snapshots. Retain only the two fresh corpora used
by the passing saved-replay gates. Generate and verify SHA-256 checksums over
every archive file except the checksum manifest. Do not use `--bundle`.
