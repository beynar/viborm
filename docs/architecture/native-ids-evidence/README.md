# Native IDs — measurement evidence

Every file here is produced by `node scripts/measure-bundle.mjs --out <file>`
after `pnpm package:build`. The fixtures under `scripts/bundle-fixtures/` are
frozen instruments: editing one invalidates every file in this directory at
once. The output carries no timestamps and no machine-specific paths, so two
runs at one commit with one `dist/` are byte-equal.

| File | Stage | Commit | What it is |
|---|---|---|---|
| `baseline.json` | A | `fc69297b` | Before anything moved: `decimal.js`, `@paralleldrive/cuid2`, `nanoid`, `ulidx` all in the graph |
| `stage-b.json` | B | — | After the three identifier packages left and the six formats became VibORM's own |
| `stage-c.json` | C | — | After `decimal.js` became `big.js@7.0.1` |
| `final.json` | F | see its own `commit` | The after-numbers, plus one block a second script adds (below) |

`baseline.json` is never regenerated. `final.json` is: it carries the numbers of
the tree it was last measured on, and its `commit` field says which.

## The second block, and the second script

`final.json` carries a `databaseStorage` key that `measure-bundle.mjs` knows
nothing about and DROPS on a rerun: 200,000-row tables on the project's
PostgreSQL 16 and MySQL 8 containers, measured with `pg_total_relation_size` /
`pg_relation_size` / `pg_indexes_size` and `information_schema.TABLES`. It is
produced by a committed script, and the exact command is inside the block:

```sh
pnpm package:build
node scripts/measure-bundle.mjs --out docs/architecture/native-ids-evidence/final.json
PG_TEST_CONNECTION_STRING=… MYSQL_TEST_CONNECTION_STRING=… \
  node scripts/measure-id-storage.mjs --rows 200000 --repeat 2 \
    --merge docs/architecture/native-ids-evidence/final.json
```

That order matters: the storage merge must come last, or the bundle run erases
it.

`databaseStorage.runs` is always a LIST, because the question "is this size a
property of the storage or of this run" has to be answerable from the artifact.
Every PostgreSQL heap size and every MySQL size except the two random-uuid
primary keys is byte-identical across runs; a random uuid's btree fill is
data-dependent, and InnoDB's `DATA_LENGTH` moves in 1 MiB extents, so those
cells are quoted as a range and never as a figure.

The report that reads all of this is
[`../native-ids-report.md`](../native-ids-report.md).
