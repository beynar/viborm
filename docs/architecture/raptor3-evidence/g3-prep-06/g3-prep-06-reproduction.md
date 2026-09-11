# G3P-06 reproduction and archive assembly

Run from the repository root with Node v24.21.0. Do not modify source or the
registered harness between commands. Run every validator serially.

## Fixed and local qualification

```sh
pnpm test:types
node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs
node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs
node scripts/run-raptor3.mjs g0
node scripts/run-raptor3.mjs g1-baseline
node scripts/run-raptor3.mjs g1-contracts
node scripts/run-raptor3.mjs g1-compare
node scripts/run-raptor3.mjs g1-generated
node scripts/run-raptor3.mjs g1-transport
node scripts/run-raptor3.mjs g2-baseline
node scripts/run-raptor3.mjs g2-contracts
node scripts/run-raptor3.mjs g2-generated
node scripts/run-raptor3.mjs g2-transport
node scripts/run-raptor3.mjs g25-contracts
node scripts/run-raptor3.mjs g27-contracts
node scripts/run-raptor3.mjs g3p02-contracts
node scripts/run-raptor3.mjs g3p03-contracts
node scripts/run-raptor3.mjs g3p04-contracts
node scripts/run-raptor3.mjs g3p04-review-contracts
node scripts/run-raptor3.mjs g3p05-contracts
node scripts/run-raptor3.mjs g2-diagnostics
```

Run each PGlite file separately through the credential-free runner with
`--only`. PGlite uses the approved 2,560 MiB RSS ceiling; all other gates retain
their registered ceiling.

## Native qualification

Use only the cached image IDs in the index. Start one task-owned container at a
time with a random loopback port, tmpfs provider data, two CPUs, 1 GiB memory,
no host mount, and label `viborm.test=raptor3-g3p06`. Set only
`VIBORM_RAPTOR3_PROVIDER_PORT` for the runner. Execute PostgreSQL modes
`g2-pg-baseline`, `g2-pg-contracts`, `g25-pg-contracts`, `g27-pg-contracts`,
`g3p02-pg-contracts`, `g3p03-pg-contracts`, and `g3p04-pg-contracts`. Execute
the corresponding MySQL modes except G2.5, which has no MySQL mode.

After each matrix, inspect only OOM, restart count, and running state; remove
that exact container ID; then require an empty label census. Never print
provider environment or credentials.

## Campaigns, replay, and cost

```sh
node scripts/run-raptor3.mjs g2-seeds
node scripts/run-raptor3.mjs g2-transport-seeds
node scripts/run-raptor3.mjs g3p06-seeds
node scripts/run-raptor3.mjs g3p06-transport-seeds
node scripts/run-raptor3.mjs replay <fresh-g25-polish-corpus.json>
node scripts/run-raptor3.mjs replay <fresh-g2-conditional-upsert-corpus.json>
node scripts/query-engine-structure.mjs
node scripts/measure-raptor3-baseline.mjs --output <g3-prep-06-cost.json>
```

For compact archive assembly, retain each campaign parent `verified.json`; for
every listed batch, retain `verified.json`, `vitest.json`, and
`generated-campaign.json`. Preserve the batch under its `firstSeed`, which
replaces the temporary absolute directory as its durable lookup key. Do not
copy per-batch `corpus.json` or progress snapshots. Retain the two exact fresh
corpora used by the saved-replay gates.

Generate SHA-256 checksums over every archived file except the checksum
manifest itself. Verify the manifest, embedded production/harness identities,
test counts, campaign cell/replay/skip totals, and absence of pending tests.
Do not use `--bundle` and do not archive the evidence tree wholesale.
