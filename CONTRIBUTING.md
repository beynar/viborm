# Contributing to VibORM

Use Node.js 22+ and pnpm 10.11.0. Install the committed dependencies with
`pnpm install --frozen-lockfile`.

## Checks

| Command | Checks |
| --- | --- |
| `pnpm test:types` | The complete source and test TypeScript program with the pinned native compiler |
| `pnpm test:core` | All core runtime projects, in sequential memory-bounded shards |
| `pnpm test:layer:validation` | One layer's runtime tests and compile-only public probes |
| `pnpm test:all` | Full credential-free local/provider estate and package checks |
| `pnpm test:package` | Build and test package exports and packed consumers |
| `pnpm --dir docs validate` | Documentation structure, links and examples supported by the docs tool |

Use `node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts
--project=layer-validation path/to/test.core.test.ts` for a focused runtime check.
The command belongs on one line. For a live PGlite test, use
`node scripts/run-credential-free-tests.mjs --only <filename>` so its existing
isolated provider allowance applies. Never bypass the runners or raise their
memory limits to make a check pass. They hold a shared workspace lock and verify
child-process teardown.

The package consumer gates separately verify the supported TypeScript 5.9 and
Node 22.0 floors. A native TypeScript pass alone does not establish package support.
Container, Bun, Workers and hosted checks are separate provider evidence; a skipped
provider has not passed. Project `.env` files are ignored. Never commit credentials
or run destructive fixtures against shared databases.

## Changes

Keep SQL syntax in adapters, transport and lifecycle behavior in drivers, and
query structure in the query engine. Read the relevant layer's `AGENTS.md` for
its established contracts. Add a regression that fails for the reported behavior;
check public type claims through a real public call, including misspelled keys
beside valid keys.

Open a pull request with the concrete before/after behavior and checks executed.
Preserve compatibility except where the fix requires a documented change. Prefer
removing duplicated rules to adding another registry or state owner. Separate
product requests from confirmed defects, and report unexecuted provider coverage
honestly.

Publication uses the protected-main workflow in [RELEASING.md](RELEASING.md).
