# VibORM Studio as a Bun executable (proof of concept)

`main.ts` is the whole entry: the same runner `viborm-studio` uses
(`src/run.ts`), the prebuilt app embedded as text, and Bun's own `import()`
in place of jiti to load the user's TypeScript config. Bun caches what it
imports, so the binary does not watch for changes.

```sh
pnpm --filter @viborm/studio compile   # ui/dist, then ./viborm-studio for this machine
cd packages/studio && bun build --compile --bytecode --format=esm --minify \
  --compile-autoload-package-json --compile-autoload-tsconfig \
  --target=bun-linux-x64 bun/main.ts --outfile viborm-studio-linux-x64
cd my-app && /path/to/viborm-studio --config viborm.config.ts
```

## Findings (Bun 1.4.4, macOS arm64, 2026-10-27)

Measured against a scratch project outside the repository with `viborm`
installed from the packed tarball, `pg` and `better-sqlite3`.

| | `npx @viborm/studio` (Node 24) | compiled binary |
| --- | --- | --- |
| What the user downloads | the `@viborm/studio` package (~0.5 MB compressed) | 96 MB (darwin-arm64, with the Entasis app; 93 MB before it), 113 MB (linux-x64), 120 MB (windows-x64) |
| Start to first `/api/schema` answer | ~110 ms | ~45 ms with `--bytecode`, ~57 ms without; ~950 ms on the first launch of a fresh binary (macOS) |
| PostgreSQL (`pg`) | works | works |
| SQLite through `better-sqlite3` | works | **fails**: Bun cannot load the addon (oven-sh/bun#4290); every query is V1001 |
| SQLite through `viborm/bun-sqlite` | n/a | works |
| Cross-compilation | n/a | `--target=bun-linux-x64` / `bun-windows-x64` build in ~2 s each (not run here) |

1. **Compiling works.** `--bytecode` needs `--format=esm` with top-level
   `await`; it adds ~3.5 MB and saves ~12 ms of startup. Embedding the app is
   one `import html from "../ui/dist/index.html" with { type: "text" }`.
2. **Loading the user's TypeScript config works**: the binary's runtime
   transpiles a `.ts` file from disk on `import()`.
3. **Its imports do not, by default.** A standalone executable does not resolve
   `node_modules`: `import "pg"` from the user's config fails with "Cannot find
   package", and so do `Bun.resolveSync` and `createRequire().resolve`, so a
   runtime `Bun.plugin` resolver cannot work around it either.
   `--compile-autoload-package-json` turns package resolution back on; with it
   the config, `viborm` and `pg` load from the user's `node_modules`.
4. **The binary does not replace an install.** The config imports `viborm` and
   a driver, so the user still needs both in `node_modules`. The binary then
   holds a second copy of VibORM beside the application's, which works today
   (the studio reads model state and error codes, not classes) but is a
   version-skew risk, as it is for the npm package (whose version follows
   `viborm`'s for that reason).
5. **The driver must run on Bun.** `better-sqlite3`, the Node SQLite driver
   VibORM documents, does not, so a SQLite user would have to switch their
   config to `viborm/bun-sqlite` to use the binary.

## Query-code update (2026-10-28)

The code editor bundles the existing TypeScript dependency to parse one read
call without evaluating JavaScript. It remains entirely in Studio: the Node
CLI is 8.24 MB uncompressed / 1.56 MB gzipped (excluding the frontend).
The updated darwin-arm64 bytecode executable builds at 110.61 MB, loads the
external PostgreSQL project, and executes `client.customer.count()`. A warm
start to `/api/schema` measured 148 ms; the first launch was not measured
reliably. The original table above records the earlier build.

## Recommendation

Ship `npx @viborm/studio` and do not distribute the binary. It saves ~65 ms of
startup for a tool that runs for minutes, costs ~100 MB per platform plus
signing and notarization, still needs the application's `node_modules`, and
cannot open `better-sqlite3` databases. Keep this entry as the recipe should a
self-contained studio (one that bundles its drivers and takes a connection URL
instead of the application's config) become a goal.
