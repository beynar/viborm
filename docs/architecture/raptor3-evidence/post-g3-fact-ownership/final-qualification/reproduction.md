# Post-G3 fact-ownership qualification reproduction

Run from the repository root with Node v24.21.0. Keep source and the registered
harness unchanged, and run every validator serially.

Run the 22 modes recorded under `receipts/fixed` with
`node scripts/run-raptor3.mjs <mode>`. They are the manifest's G0; G1 baseline,
contracts, comparison, generated, and transport; G2 baseline, contracts,
generated, and transport; G2.5; G2.7; G3P-02 through G3P-05; and the five
`post-g3-*` gates. Run `g2-diagnostics` separately as nonqualifying evidence.

Run the ordinary aggregate and the four PGlite files exactly as follows:

```sh
node scripts/run-credential-free-tests.mjs --only 'Raptor 3 fixed contracts'
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/expanded/produced-legacy.test.ts'
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/expanded/batch-produced-legacy.test.ts'
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/expanded/produced-commands.test.ts'
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/expanded/batch-produced-commands.test.ts'
```

For native providers, use only the cached image IDs in `index.json`. Start one
task-owned provider at a time with a random loopback port, tmpfs data, two CPUs,
1 GiB memory, no host mount, and a dedicated `viborm.test` label. Pass only its
mapped port as `VIBORM_RAPTOR3_PROVIDER_PORT`. PostgreSQL modes are
`g2-pg-baseline`, `g2-pg-contracts`, `g25-pg-contracts`, `g27-pg-contracts`,
`g3p02-pg-contracts`, `g3p03-pg-contracts`, `g3p04-pg-contracts`, and
`post-g3-clearability-pg-contracts`. MySQL uses the corresponding modes except
G2.5, which has no MySQL lane. Inspect OOM and restart state, remove the exact
container ID, and require an empty task-label census.

Run the campaigns, replay, support, and cost commands:

```sh
node scripts/run-raptor3.mjs g2-seeds
node scripts/run-raptor3.mjs g2-transport-seeds
node scripts/run-raptor3.mjs g3p06-seeds
node scripts/run-raptor3.mjs g3p06-transport-seeds
node scripts/run-raptor3.mjs replay <fresh-g25-polish-corpus.json>
node scripts/run-raptor3.mjs replay <fresh-g2-conditional-upsert-corpus.json>
node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs
node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs
pnpm test:types
node scripts/query-engine-structure.mjs
node scripts/measure-raptor3-baseline.mjs --output <cost.json>
```

Archive each parent campaign receipt and, keyed by `firstSeed`, each child's
`verified.json`, `vitest.json`, and `generated-campaign.json`. Omit each large
per-batch corpus and progress snapshot. Retain only the two exact fresh corpora
used by the saved-replay gates. Generate and verify SHA-256 checksums over every
archive file except the checksum manifest. Do not use `--bundle`.
