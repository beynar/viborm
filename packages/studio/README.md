# @viborm/studio

VibORM Studio: your schema as a diagram, and every model's rows to browse
and edit through your own VibORM client.

![The schema as a diagram](https://raw.githubusercontent.com/beynar/viborm/main/packages/studio/screenshots/erd.png)

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
  unique keys, and each relation as a line in crow's foot notation. Click a
  model or a relation to light up what it reaches, find a model by name,
  export the diagram as PNG or SVG. Each model gets an icon guessed from its
  name.
- **Rows:** a page at a time, searched, filtered (nested AND/OR/NOT groups, through relations,
  values picked by type) and sorted; columns hidden, moved, resized, pinned. A
  relation's cell opens the related rows under the row, and from there in
  their own table, polymorphic relations included. Copy a cell or selected rows;
  download the selection/current page, or export all filtered rows as CSV or
  JSON. Exports use visible scalar columns in their displayed order. A failed
  refresh keeps the last rows visible with a retry banner.
- **Saved views:** a table's filter, search, order, page size and columns
  saved under a name and an icon in the sidebar, kept by the studio per project
  (`~/.viborm/studio`), with the diagram's layout.
- **Editing:** cells edited in place with an editor of their type (switch,
  calendar, time, select), rows opened or added in a drawer, rows deleted. A
  foreign key is picked from the rows it can point to; a relation links and
  unlinks rows through nested writes, polymorphic ones included. Select rows to
  set one field across them, or duplicate one row into the new-row drawer
  without copying generated, primary-key or unique values.
- **Stacked changes:** nothing is written as you edit. A bar counts the
  changes; review, drop, or save them (⌘S), every one in one transaction of
  your client. Undo/redo works per editing action, including an entire paste,
  import or bulk edit; successive edits of one cell remain separate undo steps.
  The last 100 undo steps live in the open app; pending changes survive reload.
- **Import and paste:** preview CSV, TSV or a JSON array before staging new
  rows (500 rows / 512 KB per import). Paste a TSV rectangle at the focused
  cell to update loaded rows. Parsing finishes before any changes are staged;
  the client remains the final validator when saving. See the format below.
- **Query:** a read built with pickers (filter, order, page, columns,
  relations; counts, sums and averages per group), run through your client as
  you build it, with its rows, the SQL it ran, its trace (spans on a
  waterfall, database time against VibORM time) and the code to write. SQL is
  formatted in the database's dialect, with timing and bound values above it.
- **Query code:** switch the query sidebar to Code and paste a single call,
  such as `await client.user.findMany({ where: { active: true } })`. Run it
  with Run or ⌘/Ctrl+Enter; typing does not execute it. Result, SQL, Trace and
  Plan use the same loaded client. The editor accepts the six read operations
  (`findMany`, `findFirst`, `findUnique`, `count`, `aggregate`, `groupBy`)
  with literal objects/arrays, bigint and `new Date(...)`. Source is parsed
  as data, never evaluated: variables, functions, imports and mutations are
  refused. No setup or client import is needed.
- **Saved queries:** save the code or the model, operation and builder settings under a
  name. Reopen them from the sidebar or ⌘K, update or rename them, or use
  Save as new to keep a copy. Queries share the views' per-project storage and
  sync across open Studio pages. Deleting a saved query leaves database rows alone.
- **Plan:** PostgreSQL and MySQL execution plans as a Svelte Flow graph, a
  compact table or the raw database response. Inspect node timing, estimated
  and actual rows, index access and PostgreSQL buffers. Analyze captures the read and runs each statement
  again; Estimate captures the read once and asks for its plan without a second
  execution. The graph fits the whole plan on mount; zoom or focus an operation
  to inspect it. PostgreSQL Analyze uses a transaction-local 30-second timeout
  and requires interactive transactions (use Estimate on Neon HTTP).
  MySQL uses a MAX_EXECUTION_TIME hint, including on CTE reads. SQLite supplies an estimated query plan
  only, with the original read's duration and no per-node timings.
- **Drift:** a banner when the database differs from the schema, with what
  `viborm push` would change and its SQL.
- **Keyboard help:** the keyboard button in the sidebar, or ⌘/Ctrl+/, lists
  navigation, editing, clipboard and undo shortcuts.
- **⌘K:** go to a model, a view or a row by its key (`user 7`).
- **Navigation:** clean URLs (`/schema`, `/data/profile`, `/query`,
  `/query/<saved-id>`) with browser Back/Forward and direct-link refresh.
  Old hash bookmarks redirect in-place. The app shell and pending changes
  stay mounted as pages change; invalid pages and missing saved items are explicit.
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
| `--readonly` | Browse and export only: no create, update or delete |

![Related rows under their row](https://raw.githubusercontent.com/beynar/viborm/main/packages/studio/screenshots/related-rows.png)

The studio's version follows `viborm`'s: it reads the models your client
holds, so install the release that matches your `viborm` (`@viborm/studio`
1.6.0 requires `viborm` ~1.6.0). Full guide: https://viborm.dev/docs/studio

## Transferring data

Import uses scalar field names as CSV/TSV headers or JSON object keys. Unknown
fields and relations are refused. Omit a field to use its default; generated
values are omitted unless **Use new generated values** is unchecked. JSON
bigints and decimals must be strings to keep their exact value.

CSV/TSV imports and selection/page downloads use `\N` for null, an empty cell
for an empty string, and a doubled initial backslash for literal backslashes.
Quoted cells can contain separators, quotes and line breaks. Clipboard paste
has no header and starts at the focused cell; it must fit the loaded rows and
visible editable columns. Native text editors keep their normal clipboard.

The existing **All filtered rows** CSV export keeps its conventional empty
null cells for compatibility; use JSON for a lossless export/import round trip.
The export reads the database, while selection/page downloads include staged
cell values. Neither operation writes data.

The [comparison with Prisma and Drizzle](COMPETITIVE_REVIEW.md) records the
implemented improvements and the remaining product differences.

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
