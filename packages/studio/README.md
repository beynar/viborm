# @viborm/studio

VibORM Studio: your schema as a diagram, and every model's rows to browse
and edit through your own VibORM client.

```sh
npx @viborm/studio            # or: pnpm add -D @viborm/studio && pnpm viborm-studio
```

Run it anywhere in your project. It finds your config by itself:
`viborm.config.ts` (or `.mts`, `.js`, `.mjs`) in the working directory or a
parent directory up to the repository root, else the first file below that
imports `defineConfig` from `"viborm/config"` (a monorepo's
`apps/api/viborm.config.ts` from the repository root, say). It then serves
the studio on `http://127.0.0.1:5577` and opens it.

- **Schema:** each model's columns with their types, nullability, primary and
  unique keys, and each relation as a line in crow's foot notation.
- **Rows:** a page at a time, searched, filtered and sorted, each relation a
  link to the rows it reaches; cells edited in place, rows added in a drawer,
  deleted after a confirmation.
- **Live:** the studio watches your config and every project file it imports.
  Save your schema and the diagram and the rows reload; a save that does not
  load keeps the previous schema and says why.

Every read and write goes through your client: its validation, defaults,
generators and relation semantics apply exactly as in your application, and
a refused value shows the client's own message. The server listens on
127.0.0.1 only and takes API calls only from its own page.

| Option | |
| --- | --- |
| `-c, --config <path>` | Use this config instead of searching for one |
| `-p, --port <port>` | Port on 127.0.0.1 (default 5577, or a free one when taken) |
| `--no-open` | Do not open the browser |
| `--no-watch` | Do not reload when the config or the schema changes |

The studio's version follows `viborm`'s: it reads the models your client
holds, so install the release that matches your `viborm`.

## Developing it

- `src/`: the CLI, config discovery and watching, the JSON API and the local
  server. VibORM's schema internals are bundled from this repository's source.
- `ui/`: the Svelte app on entasis and Tailwind 4, after Pyxel's database
  screens (`@xyflow/svelte` diagram, entasis `DataTable` rows, row drawer).
- `test/`: run by the root's `layer-studio` and `coverage-studio` projects.
- `demo/`: a blog schema with one-to-one, one-to-many and many-to-many
  relations, its SQLite and PostgreSQL configs, and a seed script.
- `bun/`: the single-executable proof of concept and its findings.

```sh
pnpm package:build                      # viborm's dist, which the demo imports
pnpm --filter @viborm/studio build      # ui/dist, then dist/cli.mjs and dist/studio.html
pnpm --filter @viborm/studio check      # svelte-check
npx jiti packages/studio/demo/seed.ts sqlite    # or: pg (STUDIO_DEMO_PG_URL)
node packages/studio/dist/cli.mjs -c packages/studio/demo/sqlite.config.ts
pnpm --filter @viborm/studio dev        # the app with hot reload, its /api proxied to :5577
```
