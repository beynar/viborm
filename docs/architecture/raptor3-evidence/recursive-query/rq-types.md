# RQ-02 completion and RQ-05 types, exactness and schema-only rendering (unit `rq-types`)

Unit `rq-types`, 2026-09-22/23. Scope: RQ-02 in full and RQ-05's "public
inference and exact options" and "render recursive operation-result types
without a driver" items of
[recursive-query.md](../../../../features-docs/recursive-query.md), with §3.4 as
the design and §5's "Input boundary" and "Type surface" rows as the falsifier
list. This is a unit record, not a qualification verdict: the independent
review, native provider lanes and RQ-07 belong to their owners.

## Identity of what was executed

| Fact | Recorded value |
| --- | --- |
| Repository / branch / HEAD | `/Users/arnaud/code/viborm`, `pattern-engine`, `076fad02b1c77435ce7389a51996163c66aad819`; uncommitted tree preserved, nothing staged or committed |
| Runtime | `/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin/node` (Node `24.21.0`); `TMPDIR=/private/tmp/viborm-rq-types-tmp` |
| Compilers | whole estate: `typescript-native` 7.0.2 through `scripts/run-typecheck.mjs`; focused probes and the client layer type chunk: JS `typescript` 5.9.3 through `scripts/run-node-safe.mjs 1280 …` (the layer type stage's compiler and heap) |
| Owned production, final SHA-256 | `validation/relations/recurrence.ts` `31cfe13c…af3` (untracked); `validation/relations/select-include.ts` `ec7f935a…7ab`; `validation/relations/index.ts` `621103b0…6be`; `schema/relation/static-membership.ts` `c3939a8d…122` (unchanged by this unit); `client/result-types.ts` `a308ff18…822`; `client/types.ts` `d042c8c9…a83`; `client/typescript-type-renderer.ts` `633c7089…e43`; `query-engine/result/result-shape.ts` `6ba5f20f…e2b`; `query-engine/types.ts` `648c1e7d…624` |
| Owned witnesses, final SHA-256 | `tests/unit/operation-schemas/relations/recursive-query.core.test.ts` `fbe3a745…217` (22 cells); `tests/types/client/recursive-query.core.types.ts` `6b94b2ff…673` (compile-only, 33 negative pins); `tests/contracts/public-client/schema-introspection.core.test.ts` `80340710…995` (13 cells) |
| Before-state copies | every owned file `cp` to `$TMPDIR/backup-before/` before the first edit; red-witness runs `cp` those copies into place and restore by `cp` from `$TMPDIR/new-snap/`, SHA-256 re-verified after every restore; never `git checkout` |

**Concurrency record.** Between my write of `recurrence.ts` (new one-argument
`recurrenceSchema`) and the matching `select-include.ts` rewrite, about one
minute around 00:05–00:06, the tree held a caller of the old arity; the cache
unit recorded three void runs in that window and repeated them. Each of the
five before-state swaps below (runtime, renderer, two coverage runs, one JSON
Schema size run) held a complete, self-consistent before-state of the swapped
files for the length of one Vitest run.

## Changes

### C1 — Runtime eligibility reads three resolved facts; the rest were already facts

- **Witness before.** Focused coverage of the whole relations directory (16
  files, 509 cells) on the before-state: `recurrence.ts` 93.63 % statements /
  85.71 % branches, uncovered lines 111–112 (`partnerOf`'s fall-through), 127–128
  (a slot identity re-check), 142 (junction whose endpoints are not both
  collections), 150 (singular inverse without `unique`), 154 (collection owning a
  foreign key); `select-include.ts` 98.27 % branches (line 96, the
  `requireRecurrence` refusal). The validation subsystem gate requires 100 % on
  `src/validation/**`, and none of those arms is reachable from a resolved index.
- **Fact.** A slot recurses exactly when its model has a complete primary row
  key, its resolved edge is an ordinary foreign-key or junction edge, and both
  endpoints are the same model object.
- **Owner.** `recurrenceSchema(resolved)` in `validation/relations/recurrence.ts`,
  reading the key catalog (`rowKey`) and the `ResolvedSlot` published by
  `relation-resolution.ts`.
- **Hunk.** `recurrenceSchema(source, field, resolved)` → `recurrenceSchema(resolved)`;
  body is edge kind → endpoint identity → `rowKey` → FK or graph language.
- **Deleted.** `sameSlot`, `partnerOf`, the slot identity re-check, the
  `rowKey.fields.length === 0` arm (a row key never has zero members), the
  relation-state lookups and the three cardinality/owner/`unique` checks. They
  are resolver invariants, not new facts: only `s.toOne` declares
  `.fields(…)`, so a collection never owns a foreign key; the resolver sets
  `unique` exactly when both endpoints are singular
  (`relation-resolution.ts`, `resolveOrdinaryPair`), so a singular inverse is
  always the one-to-one side; a junction edge is built only between two
  collections. The static projection still proves the partner cardinality, as
  §3.1 asks, because TypeScript has no resolver.
- **Second placement.** Runtime cells admit both FK directions, both one-to-one
  directions and both junction directions; refuse the structurally identical
  non-self pair, a variant carrier, the inverse bound to variant storage and a
  keyless model; admit a widened-name pair the static view refuses.
- **Result after.** 100 % statements, branches, functions and lines on both
  files (same 509 cells).

### C2 — A foreign-key bag refuses `preventCycles` by its own type and sentence

- **Witness before.** Runtime cell "refuses a caller-selected cycle policy on
  every foreign-key direction" red: the only issue text was `Unknown key:
  preventCycles` inside a union concatenation. Static: the third-level FK flag
  (`forest.root.children.include.parent.recurse`) compiled on the old source
  (unused directive, `cost-cmp-old-new-probe`).
- **Fact.** Foreign-key recursion has no cycle policy; the key is refused
  wherever a foreign-key bag appears.
- **Owner.** `ForeignKeyRecurse` / `foreignKeyOptions` in `recurrence.ts`
  (`preventCycles?: undefined` in the type, `v.refused(…)` at runtime).
- **Hunk.** One optional refused entry and one type member.
- **Deleted.** The client guard's per-relation membership read that allowed
  `preventCycles` only for junctions (`RecurrenceOptionKeys` over
  `StaticRecursiveMembership`) — now unnecessary, see C7.
- **Second placement.** Root, second and third relation level, fresh and
  `as const` variables; runtime on `children`, `parent` (select placement) and
  `mateOf`, for `false` and `true`.
- **Result after.** All red cells green; the static refusal reads `Type 'false'
  is not assignable to type 'undefined'` at the flag.

### C3 — The depth validator drops a redundant safe-integer test

- **Witness before.** None needed: behaviour-preserving deletion.
- **Fact / owner.** An integer inside 1–1000 is a positive safe integer; the
  range check in `recurrence.ts`'s `depth` owns the rule. The sentence is kept
  byte-identical because the query unit's migrated pin matches it.
- **Deleted.** `Number.isSafeInteger(integer.value) &&`.
- **Second placement.** The existing `refuses invalid depth 9007199254740992`
  cell stays green on the range check alone.

### C4 — A spelled `recurse` decides the node form

- **Witness before.** Runtime cells "refuses every per-parent window clause
  beside recurse" and "refuses a misspelled node clause beside recurse" red.
  Before, every recursion error on an ELIGIBLE slot was a union concatenation
  that included the false sentence "recurse is available only on a resolved self
  relation…", e.g. `Value did not match any union member: Expected boolean,
  recurse is available only …, skip cannot be combined with recurse`.
- **Fact.** A relation node with a defined `recurse` is the recursive node form;
  any other value is the ordinary node language, unchanged.
- **Owner.** `withRecursiveNode` in `select-include.ts`, shared by the to-one and
  to-many factories. It keeps `type: "union"` and `options` so JSON Schema reads
  the three forms as one `anyOf`.
- **Deleted.** `requireRecurrence` and its `refuse` hooks on both recursive node
  objects (the dispatch now owns "recurse is spelled").
- **Second placement.** To-one and to-many; `select` and `include`.
- **Result after.** Exact sentences: `take|skip|cursor|distinct cannot be
  combined with recurse`, `Unknown key: wher`. Non-recursive inputs meet the same
  `v.union([boolean, ordinary])` they met before this unit; relative to HEAD,
  that `ordinary` node carries the refused optional `recurse` entry an earlier
  slice added (the public delta is stated under "Runtime falsifier cells
  added").

### C5 — The asking key has its own refusal and keeps the projection's options

- **Witness before.** Runtime cell "refuses the asking key in either projection
  of its own recursive node" red: the refusal reused the availability sentence.
- **Fact.** Inside its own repeated node the asking key has a second producer.
- **Owner.** `askingKeyRefusal` + `projectionWithoutAsking` in `select-include.ts`,
  now `schema.extend(…)` so the target projection keeps its own options.
- **Second placement.** `select` and `include`; `children` and `parent`.
- **Result after.** `children is produced by recurse and cannot be selected
  again inside its own recursive node`.

### C6 — Factories read the asking slot from the resolved slot

- **Witness before.** None needed (no behaviour change); 223 admission cells
  stay green.
- **Fact / owner.** The asking key is `resolved.slot.field`; Source/Key remain
  type parameters, as `toOneUpdateFactory` already threads them.
- **Hunk / deleted.** `validation/relations/index.ts` returns to HEAD's value
  parameters (`relation, resolved, targetSchemas`); the added `source`/`field`
  value threading (44 code lines) is deleted.

### C7 — The exact-option guard walks the literal to any depth

- **Witness before.** On the old source the new probe file reports: third-level
  typo under `include` and under `select`, third-level FK flag, a typo in a
  collection's `variants` arm and in a to-one discriminator arm — all compiling
  (unused directives); and a generic ordinary-node wrapper
  (`childrenWith<Node extends { select?: { label?: true } }>`) refused with
  `RecurrenceClauseGuard<…>` in the message. That wrapper compiles at HEAD
  (compiled against a `git archive HEAD src` snapshot), so the one-level guard
  had regressed a non-recursive program.
- **Fact.** Every `recurse` bag the caller spelled admits only `depth` and
  `preventCycles`; which of them a topology forbids is the bag type's fact (C2).
- **Owner.** `RecursiveProjectionRootGuard` in `client/types.ts`, one member of
  `NoExtraOperationKeys`. It walks the literal — `select`, `include`,
  collection `variants`, to-one variant arms — and never the model: no target
  getter, no membership, no whole-model comparison, no depth unrolling.
- **Hunk.** `RecurrenceBagGuard` (`unknown` when nothing is misspelled), a
  root clause that names only clauses the argument spelled, an object-only node
  guard, and projection members typed `boolean | node`.
- **Deleted.** `SpelledRecurrenceOptionKeys`, `RecurrenceOptionKeys`,
  `RecurrenceValueGuard`, `DirectRecurrenceNodeGuard`, `RecurrenceClauseGuard`,
  `NestedRecurrenceClauseGuard`, `NestedRecurrenceProjectionGuard`,
  `DirectRecurrenceProjectionGuard` and the client's imports of
  `StaticJunctionMembership`, `StaticRecursiveMembership`, `TargetModelOf`
  (46 code lines net).
- **Second placement.** Fresh literals, `as const` and widened variables, the
  transaction client, a five-extension chain, `$withCache()`, collection and
  to-one variant arms.
- **Result after.** All 33 negative pins refuse for their stated reason (audited
  by stripping every directive: 33 errors, each on the line after its
  directive). Depth-one typos are reported on the misspelled key; deeper ones on
  the second-level node key that contains them, with a message chain ending `The types of
  'recurse.depths' are incompatible … 'number' is not assignable to type
  'never'`.
- **Failures found and repaired inside this unit** (kept as history): an
  object-typed `{}` bag guard let `{ recurse: false }` compile and turned
  refusals into `'recurse' does not exist in type 'never'` (scratch probe); a
  guard that always declared `select?`/`include?` put `include` into
  `keyof Parameters<createMany>[0]` (whole-estate typecheck,
  `tests/contracts/public-client/relation-types.test.ts:351`). Both repaired
  before the final runs; the first typecheck's red is superseded, not hidden.
- **Measured limit, pinned.** A wrapper generic over the whole bag
  (`<Bag extends true | { depth?: number }>(recurse: Bag)`) is refused: no sound
  guard can prove a type parameter free of misspelled keys. Generic depth and
  generic ordinary-node wrappers infer. Generic clause and whole-argument
  wrappers were already refused at HEAD by `ClauseGuard` and are unchanged.

### C8 — The recursive wrapper keeps every world of a union node

- **Witness before.** Probe `_unionKeepsTheDefaultRow` red: with
  `select: maybeSelect` (`{ label: true } | undefined`), `Omit<Node, Key>` kept
  only the keys the two worlds share, so the default row's `parentId` was lost.
- **Fact / owner.** `RecursiveRelationNode` in `client/result-types.ts` is
  `Node & { [Key]…: … }`; the asking key cannot occur in `Node` (C5).
- **Result after.** Green; every shape probe (bounded, exhaustive, widened
  `number` and `number | false`, optional recurse, parent, nested, compound)
  green.

### C9 — The schema-only view carries the admitted recurrence

- **Fact.** A recursive slot's schema-only shape is its one ordinary node plus
  the same `NormalizedRecurrence` execution consumes.
- **Owner.** `ExpectedRelationResultShape.recurrence` (`query-engine/types.ts`),
  filled by `admittedRecurrence` in `result/result-shape.ts`, which reads the
  admitted value and parses nothing (no adapter, no operation context, no third
  result representation).
- **Deleted.** No deletion (new consumer of an existing fact).

### C10 — The renderer names each recursive node once

- **Witness before.** Four cells in `schema-introspection.core.test.ts` red on
  the before-state: the slot rendered as a one-level object with no repeated key,
  i.e. a type that is wrong for every result deeper than one level.
- **Fact.** A recursive slot renders as a named alias whose own key repeats the
  slot: optional under a numeric cutoff, required on exhaustive traversal, with
  the slot's cardinality and emptiness.
- **Owner.** `recursiveRowType` in `client/typescript-type-renderer.ts`.
- **Choice.** Named recursive aliases. TypeScript names recursion only through a
  declaration, so a result containing a recursive slot renders as declarations —
  `type VibORMOperationResult = …;` followed by `type VibORMRecursiveNodeN = …;`
  numbered outer-first — and every other result keeps rendering one expression
  (existing pins unchanged). The text references no new exported helper, so no
  package build was needed; the pre-existing `import("viborm").Decimal` leaf is
  unchanged. The rejected alternative, an exported `import("viborm").…` helper,
  needs a root export and a public-surface golden change outside this unit.
- **Compile proof.** The rendered declarations of one payload are pasted
  verbatim into the probe file and agree (mutual assignability) with the client's
  inferred result, under the whole-estate typecheck. The renderer takes no
  client, so default omit cannot reach it: the same probe shows the client's
  `defaultOmit` removing `label` at every repeated level while the rendered text
  keeps it.
- **Second placement.** `findMany`, `findUnique`, `findFirstOrThrow`, `update`
  (mutation readback), ordinary → recursive → second recursive slot, junction
  graph.

### Runtime falsifier cells added (RQ-02)

`recursive-query.core.test.ts` 10 → 22 cells, all existing cells unchanged:
depth bounds 1 and 1000 and exhaustive traversal in every eligible direction
(graph `{}` / `{ preventCycles: false }` default to 100); `recurse: undefined`
parses exactly as the plain node and `recurse: false` / `depth: true` are
refused; C2, C4, C5 sentences; variant carrier and variant-bound inverse
refused; widened-name pair admitted; one rule under `select` and `include`, below
an ordinary node and with a second recursive slot; unchanged non-recursive
admission; and invalid recursion refused with `ValidationError` before a counting
`MemoryCache` is read or written and before a counting driver executes, through
both `$withCache()` and the plain client (a valid read first proves the counters
move). The last cell asserts through the existing admission boundary; nothing
was added downstream. "Unchanged" is relative to this unit's before-state, not
to HEAD: relative to HEAD, every non-recursive relation node now admits
`recurse: undefined`, carries `recurse?: undefined` in its input type and
`"recurse": {"not": {}}` in its JSON Schema, and, on a slot that cannot recurse,
refuses a defined `recurse` with the availability sentence — a public delta
that predates this unit — while every other spelling parses as before.

## Runs

| Command (Node 24.21.0, `TMPDIR` above) | Result |
| --- | --- |
| `run-vitest-safe … --project layer-operation-schemas` recursive-query, select-include, to-many, to-one, polymorphic-collection-selection, polymorphic, wrapper-delegation | 7 files, 223 / 223 |
| `run-vitest-safe … --project layer-client` schema-introspection, typescript-renderer-boundaries / -closure / -nullability, client-coverage | 5 files, 36 / 36 |
| `run-vitest-safe … --project layer-validation` json-schema, registry | 2 files, 87 / 87 |
| same operation-schemas run with v8 coverage on `recurrence.ts`, `select-include.ts` (whole relations directory) | 16 files, 509 / 509; 100 % in all four metrics on both files |
| JS `tsc` on the probe file alone | 0 diagnostics |
| JS `tsc` on the client layer type chunk that holds the probe (10 files, layer tsconfig, 1280 MB heap) | 0 diagnostics |
| `node scripts/run-typecheck.mjs` | **0 diagnostics**, 22.87 s, 5 133 MiB peak (ceiling 8 192). An earlier run had 1 error (C7's `keyof` leak), repaired |

Red-witness runs (before-state swapped in by `cp`): runtime 18 / 22 (4 red),
renderer 9 / 13 (4 red), coverage as in C1, probe file 9 errors on the old
source. No native provider lane, engine lane or wide run was executed.

## Registrations owed

None new: every file is admitted by an existing glob. Counts for the integrator:
`tests/unit/operation-schemas/relations/recursive-query.core.test.ts` → 22 cells
(`layer-operation-schemas`, was 10); `tests/contracts/public-client/schema-introspection.core.test.ts`
→ 13 cells (`layer-client`, was 9); `tests/types/client/recursive-query.core.types.ts`
→ compile-only, `layer-client` type stage and the whole-estate typecheck.

Integration notes (files outside this unit): `src/client/AGENTS.md`'s schema
introspection paragraph and the public JSDoc of `renderOperationResultType`
(`src/client/schema-introspection.ts`, which still reads as if the result is
always one type expression) should state the declaration form of recursive
results (`type VibORMOperationResult = …;` plus `VibORMRecursiveNodeN` aliases);
`compileCacheResultCodec` (`query-engine/result/cache-result-codec.ts`, no caller)
would ignore `ExpectedRelationResultShape.recurrence` if revived.

## Measured

Compile cost, JS `tsc` 5.9.3 `--extendedDiagnostics`, one probe per program, on
two source copies that differ only in this unit's nine files:

| Program | Old source | New source |
| --- | ---: | ---: |
| Control: schemas and client, no calls | 3 130 340 | 3 092 705 |
| Previous probe file (377 lines), own cost | 94 348 | 92 691 |
| New probe file (857 lines, 33 negative pins), own cost | 167 869 (9 errors) | 165 858 (0 errors) |
| `contextual-typing-gate.core.types.ts` (non-recursive control), own cost | 142 321 | 138 149 |

No TS2589. Client layer type chunk 3 (the probe's chunk): 3 438 578 → 3 503 825
instantiations with the new probe, 1.199 → 1.169 GB checker memory, 1 402 →
1 373 MiB peak RSS (ceiling 1 536). Code-bearing lines of the nine owned
production files: 3 943 before this unit → 3 897 after (−46) while adding
schema-only rendering; +609 against HEAD for the feature as a whole. JSON Schema
of a self tree's `findMany` input: 441 917 → 442 133 bytes (+216, C2's refusal);
the size itself predates this unit.

## Unverified

- Wall time of `pnpm test:layer:client` against its 45 s budget: not run as a
  whole; the chunk above took 17–32 s under a load average of ~23.
- A to-one variant arm whose public type is literally `recurse` would be read as
  the bag (false refusal); a public type spelled like another node clause is not
  walked. Documented at `RelationNodeClauseKey`.
- The any-depth seal covers recurse option bags only. A misspelled node clause
  (e.g. `wher`) beside `recurse` in a non-fresh variable compiles, as for every
  nested ordinary node at HEAD, and runtime admission refuses it.
- The numeric range 1–1000 is a runtime rule; the depth type is `number`.
- `depth: false as boolean` is refused statically because `true` is no depth;
  widened forms that admit only legal depths (`number`, `number | false`) render
  the optional key.
- Native PostgreSQL/MySQL and PGlite lanes (integrator).

## Blockers

None.

## Repair round (2026-09-23)

Four minor review findings, all applied as requested, none declined. Only
`validation/relations/select-include.ts`, `recursive-query.core.test.ts` and
this note changed. The other ten owned files still match the identity table
(re-hashed before the first edit and after the last run). For the two changed
files the table's hashes are superseded by `select-include.ts` `42275a1a…9e7`
and `recursive-query.core.test.ts` `30aac2f4…958` (still 22 cells). Before-round
copies are in `$TMPDIR/repair-before/`.

### R1 — The availability refusal names the ordinary-edge condition (finding 1)

- **Witness before.** `thread.replies` is a self relation, and its model has a
  complete primary key. It is refused only because its resolved edge is the
  variant row carrier (`recurrence.ts:131`), yet the sentence named only the
  two conditions that hold. For the red witness, both pins were changed to the
  new text first and run against the unchanged production text: 2 failed, 20
  filtered out by `-t`. The received message was `Value did not match any union
  member: Expected boolean, recurse is available only on a resolved self
  relation whose model has a complete primary key`.
- **Fact.** The refusal states the three conditions `recurrenceSchema(resolved)`
  reads: self identity, an ordinary foreign-key or junction edge (never variant
  storage), and a complete primary key.
- **Owner.** `unavailableRecurrence` in `select-include.ts` owns the sentence.
  Eligibility stays with `recurrenceSchema` (C1).
- **Hunk.** `select-include.ts:90` now reads `"recurse is available only on an
  ordinary self relation (a foreign key or a junction, never variant storage)
  whose model has a complete primary key"`. The same text is pinned at
  `recursive-query.core.test.ts:413` and `:586`, and `toContain` is kept.
- **Deleted.** Nothing.
- **Second placement.** The to-one and to-many ordinary nodes share this one
  refusal. The two cells cover a to-many variant-bound inverse
  (`thread.replies`) and a to-one non-self slot (`grove.root`). A grep of
  `src`, `tests`, `features-docs`, `docs` and `scripts` (all file types, no
  snapshots exist) finds no other copy. C4's "Witness before" quotes the old
  sentence as history.
- **Changed expectations.** Both changed pins are in cells this unit added. The
  refused inputs and the `toContain` assertion are unchanged. The new text
  follows §2.1: "an ordinary, schema-resolved model-target relation", and
  inverses bound to variant storage "do not admit `recurse`". The file has no
  `.skip`, `.only` or `.todo`.
- **JSON Schema.** Not affected. A refused entry renders `{"not": {}}` without
  its message (`json-schema/converters.ts`, `case "refused"`), so the size
  figure under Measured stands.
- **Result after.** 2 passed, 20 filtered out. A read-only `biome check` of
  the two code files is clean.

### R2 — Note-only corrections (findings 2, 3, 4)

- **Finding 2.** Added one sentence to "Runtime falsifier cells added (RQ-02)"
  and a matching clause to C4's "Result after". Relative to HEAD, every
  non-recursive relation node now admits `recurse: undefined`. It carries
  `recurse?: undefined` in its input type and `"recurse": {"not": {}}` in JSON
  Schema, and, on a slot that cannot recurse, refuses a defined `recurse` with
  the availability sentence. This delta predates the unit, and every other
  spelling parses as before. The qualifier is needed because a defined
  `recurse` on an eligible slot is the recursive node form (C4), not a
  refusal. Checked this round by reading only: HEAD's `select-include.ts`
  contains no `recurse`, and the before-state copy
  (`$TMPDIR/backup-before/src/validation/relations/select-include.ts`) already
  attached `recurse: unavailableRecurrence()` to both ordinary node objects.
  The parse and JSON Schema comparison against HEAD is the reviewer's
  measurement (a `git archive HEAD` copy and an author/book/keyless schema, 14
  inserted entries). It was not repeated here.
- **Finding 3.** "Integration notes" now names the `renderOperationResultType`
  JSDoc in `src/client/schema-introspection.ts` beside `src/client/AGENTS.md`.
  Both should state the declaration form.
- **Finding 4.** C7 now says deeper diagnostics land on the second-level node
  key that contains the bag. "Unverified" now records that the any-depth seal
  covers recurse option bags only. Both facts come from the reviewer's probes
  (the non-fresh `wher` variable and the fourth-level bag). No probe was
  re-run in this round.

### Runs (repair round)

| Command (Node 24.21.0, `TMPDIR` above) | Result |
| --- | --- |
| `run-vitest-safe … --project layer-operation-schemas recursive-query.core.test.ts -t "refuses recursion on a variant carrier and on the inverse bound to its storage\|keeps every non-recursive node on its ordinary admission"`, new pins, old production sentence | 2 failed / 20 filtered (red witness) |
| same, after the reword | 2 passed / 20 filtered |
| `node_modules/.bin/biome check` on the two edited code files | clean, no fixes |
| `node scripts/run-typecheck.mjs` | **0 diagnostics**, exit 0, 12.58 s wall, 5 725.5 MiB peak RSS (ceiling 8 192) |

Not re-run this round, as instructed (only the affected cells were re-run):
the file's other 20 cells, the other operation-schemas, client and validation
files, the focused probe compiles, and the compile-cost and coverage
measurements. The only production change is the string passed to
`v.refused(reason: string)`, which carries no type. No native provider lane,
engine lane or wide run was executed.

Registrations owed: none new, and the counts are unchanged (22 cells in
`recursive-query.core.test.ts`). Blockers: none.
