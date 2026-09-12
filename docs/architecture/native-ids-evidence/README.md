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
| `final.json` | F | `bc3755b4` | The after-numbers, plus one block the script does not produce (below) |

`baseline.json` is never regenerated.

## The one hand-added block

`final.json` carries a `databaseStorage` key that `measure-bundle.mjs` knows
nothing about: 200,000-row tables on the project's PostgreSQL 16 and MySQL 8
containers, measured with `pg_total_relation_size` / `pg_relation_size` /
`pg_indexes_size` and `information_schema.TABLES`. The two throwaway scripts
that produced it are named inside the block, and re-running `measure-bundle.mjs`
into `final.json` drops it. Everything else in that file is reproducible from
the command above.

The report that reads all of this is
[`../native-ids-report.md`](../native-ids-report.md).
