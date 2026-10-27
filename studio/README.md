# VibORM Studio

`viborm studio` serves this app and a JSON API for the client a project's
`viborm.config.ts` exports. The server side lives in `src/studio/`; this
directory holds what is not package source:

- `ui/`: the Svelte app (`@xyflow/svelte` diagram, rows browser, row editor).
  `pnpm studio:build` writes it as one HTML document to `ui/dist/index.html`,
  which `pnpm package:build` inlines into the CLI-only `viborm:studio-ui` chunk.
- `demo/`: a blog schema with one-to-one, one-to-many and many-to-many
  relations, its SQLite and PostgreSQL configs, and a seed script.
- `bun/`: the single-executable proof of concept and its findings.

```sh
pnpm package:build
npx jiti studio/demo/seed.ts sqlite        # or: pg (STUDIO_DEMO_PG_URL)
node dist/cli.mjs studio --config studio/demo/sqlite.config.ts

# Working on the app: serve the API above, then the app with hot reload.
pnpm studio:dev                            # proxies /api to 127.0.0.1:5577
```
