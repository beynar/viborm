# G3P-06 registration-repair reproduction

Run serially from the repository root with Node v24.21.0.

## Registration and local stages

Import `EXTENDED_LOCAL_TESTS` and `RAPTOR3_FIXED_LOCAL_TESTS` from
`scripts/credential-free-test-manifest.mjs`. Require every fixed-local G2.7,
G3P-03, G3P-04 original/review, and G3P-05 path to be absent from
`EXTENDED_LOCAL_TESTS` and present in `RAPTOR3_FIXED_LOCAL_TESTS`. Require every
native G2.7/G3P-03/G3P-04 path to be absent from both.

```sh
pnpm test:types
node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 120000 scripts/raptor3-campaign-receipts.test.mjs
node scripts/run-node-safe.mjs --rss-limit-mb=1536 768 600000 scripts/raptor3-cli.test.mjs
node scripts/run-credential-free-tests.mjs --only 'Raptor 3 fixed contracts'
```

Run every fixed G0/G1/G2/G2.5/G2.7/G3P-02 through G3P-05 mode listed in the
original G3P-06 recipe, with G2 diagnostics separate.

Run PGlite one file per process, with each exact `--only` selector:

```sh
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/expanded/produced-legacy.test.ts'
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/expanded/batch-produced-legacy.test.ts'
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/expanded/produced-commands.test.ts'
node scripts/run-credential-free-tests.mjs --only 'raptor3-provider: tests/raptor3/expanded/batch-produced-commands.test.ts'
```

## Native providers

PostgreSQL uses cached image
`sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b`:

```sh
docker run -d --label viborm.test=raptor3-g3p06-repair --cpus=2 --memory=1g --tmpfs /var/lib/postgresql/data -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=raptor3_g2 -p 127.0.0.1::5432 sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b
docker port <exact-container-id> 5432/tcp
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g2-pg-baseline
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g2-pg-contracts
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g25-pg-contracts
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g27-pg-contracts
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g3p02-pg-contracts
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g3p03-pg-contracts
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g3p04-pg-contracts
docker inspect --format '{{.State.OOMKilled}} {{.RestartCount}} {{.State.Status}}' <exact-container-id>
docker rm -f <exact-container-id>
```

MySQL uses cached image
`sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb`:

```sh
docker run -d --label viborm.test=raptor3-g3p06-repair --cpus=2 --memory=1g --tmpfs /var/lib/mysql -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e MYSQL_DATABASE=raptor3_g2 -p 127.0.0.1::3306 sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb
docker port <exact-container-id> 3306/tcp
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g2-mysql-baseline
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g2-mysql-contracts
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g27-mysql-contracts
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g3p02-mysql-contracts
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g3p03-mysql-contracts
VIBORM_RAPTOR3_PROVIDER_PORT=<random-loopback-port> node scripts/run-raptor3.mjs g3p04-mysql-contracts
docker inspect --format '{{.State.OOMKilled}} {{.RestartCount}} {{.State.Status}}' <exact-container-id>
docker rm -f <exact-container-id>
```

Require an empty `viborm.test=raptor3-g3p06-repair` census after each exact
removal. Do not inspect container environment or print credentials.

## Campaigns, replay, cost, and archive

Run `g2-seeds`, `g2-transport-seeds`, `g3p06-seeds`, and
`g3p06-transport-seeds`; replay the fresh G2.5 polish and G2 conditional-upsert
corpora; run `scripts/query-engine-structure.mjs`; and measure cost without
`--bundle`. Assemble the compact campaign archive exactly as the original
G3P-06 recipe specifies. Verify every checksum and every embedded
production/harness identity.
