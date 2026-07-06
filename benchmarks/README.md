# Benchmarks

Performance suite for viborm's hot paths, run with vitest's built-in
benchmark runner (tinybench: warmup, mean/p75/p99, relative comparison).

## Suites

- **`e2e-overhead.bench.ts`** — the headline metric. Full client operations vs
  the equivalent raw SQL string on the same in-memory SQLite database. The
  database work is identical, so the gap between each pair is viborm's total
  per-query overhead (validation + query building + result parsing). Goal:
  ratios as close to 1.00x as possible.
- **`query-engine.bench.ts`** — `engine.build()` (args → SQL + params) per
  operation shape, with a hand-written SQL string as the floor.
- **`validation.bench.ts`** — the validation engine vs valibot, zod, and
  arktype through the StandardSchema interface (all JIT-less, matching edge
  runtimes).
- **`cold-start.bench.ts`** — schema definition + `createClient` cost, paid
  once per serverless isolate.
- **`drizzle.bench.ts`** — viborm vs drizzle vs raw on identical schema, data,
  and queries (three in-memory SQLite databases). Note drizzle's
  better-sqlite3 driver is synchronous; viborm pays for a fully async one.

Bundle footprint is tracked separately by `pnpm size` (size-limit).

## Workflow

```sh
pnpm bench              # run everything, compare within each group
pnpm bench:baseline     # save results to benchmarks/baseline.json (gitignored)
# ...make changes...
pnpm bench:compare      # re-run, show per-bench delta vs the saved baseline
```

Before optimizing: save a baseline. After: compare. Treat >10% regression on
any e2e pair as a blocker; micro-benches are noisier, look at the trend.

Run on AC power, close heavy apps; rme > ~5% means re-run before trusting a
small delta.
