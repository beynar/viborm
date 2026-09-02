# The oracle harness

Stream A of the pattern-engine program
([`docs/architecture/pattern-engine-ideal-state.md`](../../../docs/architecture/pattern-engine-ideal-state.md)
§13.2 K4, §13.3 unit A). It freezes what today's write engine emits for a
corpus of payloads so that the pattern engine can be held to it byte for byte.

```text
tests/pattern/
  harness/dump.ts               K4: dump one operation → canonical JSON
  harness/smoke.core.test.ts    day-0 smoke
  corpus/schemas.ts             three schemas covering every storage kind
  corpus/payloads.ts            the hand-authored payload list
  corpus/oracle.core.test.ts    goldens ↔ dumps, byte for byte; corpus summary
  corpus/goldens/*.json         one golden per payload × dialect × substrate × world
```

Run only this project:

```sh
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=layer-pattern
```

## What a golden contains

One golden is `serializeDump(dumpOperation(...))` for one **cell** —
`payload × dialect (postgresql | mysql | sqlite) × substrate (transaction |
batch) × world (found | missing)` — as sorted-key JSON:

| field | meaning |
|---|---|
| `operation`, `model`, `dialect`, `substrate`, `world` | the cell |
| `kind` | `operation` (one fragment atom) or `recordSeries` (ATOM §17) |
| `planning` | the planning fragment's steps (a series: its capture fragment) |
| `final` | the compiled fragment's steps (empty for a series) |
| `outputs` | the final fragment's published outputs |
| `capturedRoots`, `memberCount`, `members`, `resultReads` | series only: how many rows the synthesized capture observed, and each member / result read dumped through the same planning → compile path |
| `error` | a refusal thrown before any I/O — validation, legality, construction, packing-time — with its name, message and code |

Each step carries `position`, `id`, `kind`, the adapter's prepared `sql` and
`params`, `outputs`, `expects`, `racePin`, `onUniqueConflict`, `model`; a guard
carries its `premise` statement and `failure`; a nested series step carries its
`progressive` guard. Planning references render as `{ "ref": "step.output" }`,
dates as `{ "date" }`, bigints as `{ "bigint" }`, bytes as `{ "bytes" }`.

The **substrate** is the planning driver's capability pair: `transaction` is
`supportsTransactions: true`, `batch` is `supportsBatch: true` with no
transactions. A batch-only dump on MySQL (no `RETURNING`) refuses `update`,
`delete` and `upsert` with a `TransactionError`; that refusal is a contract and
is dumped, not thrown.

### The synthesized world

Compile needs the planning reads' rows. The harness synthesizes them
(`synthesizeKnown`) rather than executing anything:

- **found**: every read finds its rows; **missing**: every branch read (no
  `expects`) finds none. A read with a postcondition is required and finds its
  row in both worlds.
- A read finds **one row per distinct key its widest `IN (…)` list names**
  (the engine decides "every named target exists" by row count), else one
  row; a series capture finds `DumpOptions.capturedRoots` rows (default 1).
- A row carries every column the probe's select list requests plus every
  `firstRowField` it declares. A column the probe's flat predicate binds by
  equality or `IN` takes the **bound value** (the engine matches bulk rows to
  selectors by value); a bound planning reference resolves through the rows
  already synthesized. Every other column takes a **typed sentinel**: `1` for
  ints, `"<step>.<column>"` for strings, a fixed date, and so on — distinct
  per row ordinal. A polymorphic carrier's private identity column is typed by
  its storage scalar; its private discriminator holds the **first declared
  variant's** stored value, so a payload that wants the found arm of a typed
  polymorphic verb names that variant.
- A step without a `model` (a locate) is typed by the model its id is
  prefixed with; a junction-table read's columns get the untyped sentinel.

Two things the synthesized world cannot express, by construction, and which
therefore dump as a found-world refusal rather than a found arm:

1. a probe that also selects the child's foreign key and compares it to the
   parent's identity (`Cannot upsert relation … not found for this parent`)
   — the value is not in the predicate;
2. a typed polymorphic verb naming a variant other than the first.

## Adding a payload

1. Pick the schema in `corpus/schemas.ts` that has the storage kind you need
   (`fk`, `junction`, `poly`); add a model or field only if no existing one
   admits the shape, and remember every existing golden on that schema may
   then change.
2. Append `fk(...)` / `junction(...)` / `poly(...)` to the end of the matching
   group in `corpus/payloads.ts`. The `name` is the golden's file stem (`:`
   becomes `_`) — keep it stable, never rename. Prefix it `invalid:` when the
   refusal IS the contract; such a payload must dump an error on every
   found-world cell. A valid payload must dump cleanly on at least one
   `postgresql/transaction` cell.
3. Pass `{ capturedRoots: n }` as the fifth argument for an `updateMany`
   series whose behaviour depends on how many roots the capture observes.
4. Bump the frozen counts in `oracle.core.test.ts`'s summary test.
5. Regenerate the goldens and read the diff — only the new files should
   appear.

## Regenerating goldens

```sh
PATTERN_UPDATE_GOLDENS=1 node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=layer-pattern tests/pattern/corpus/oracle.core.test.ts
```

This rewrites every golden and deletes orphans. Any golden that changes for
an existing payload is a change to today's engine's contract: it needs the
same classification the differential demands (design gap, packer special
case, or maintainer decision — §13.1) before it lands.

The summary test prints every payload with an erroring cell and the first
such error, so the invalid set — and every substrate-specific refusal — is
visible in the run log.
