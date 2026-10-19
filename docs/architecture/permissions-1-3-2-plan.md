# Permissions 1.3.2: smaller, lazier policies

Status: draft for adversarial review (2026-10-19). Owner: Arnaud. Release: one
patch, **1.3.2** (owner ruling: everything below ships in the patch).

## 0. Why

Measured on Pyxel's policy (`~/code/secret-permissions`, 55 models, 40 governed),
viborm 1.3.1:

- Cold start: `permissions(config)` + first `$extends` ≈ 85 ms (all 40 models
  compiled and admitted), then the first query. Warm per request: ≈ 0.5 ms to
  apply, then each governed query.
- A governed query costs 1.5–11 ms against ≈ 0.2 ms plain, almost all of it
  Postgres planning the policy SQL: 5 KB for a page read, 27 KB for an
  `accessGrant` read (empty tables).
- Why the SQL is large (`accessGrant.read` = 37.6 KB of predicate):
  - the live-member check (`TENANT`: actor is a live member of the row's
    organisation, through `organization.members`) is repeated **19 times**,
    ≈ 30 % of it: every relation reference inlines the target's whole rule,
    `mandatory` included, and each copy is correlated to a different row, so
    neither the compiler nor the database can tell they are one fact;
  - the grant check (`grantTo`) is repeated 8 times (≈ 20 %), and inside it
    membership is checked once per role (`granteeRole = r AND member([r])`)
    because a rule cannot compare a nested row's column with an enclosing
    row's column.
- Not a cause: `create` never joins `read`/`update` (create implies nothing);
  dropping `update ⇒ read` changes nothing on Pyxel.
- Reducing `TENANT` to `organizationId` alone (an experiment, not a proposal)
  takes the policy from 815 KB to 641 KB and compile from ≈ 37 to ≈ 24 ms.

## 1. Agreements

| # | Agreement | Source |
|---|---|---|
| A1 | One patch release, 1.3.2, holds all of it | owner, 2026-10-19 |
| A2 | Per-model (lazy) compilation ships | owner, 2026-10-19, reversing 2026-10-18 |
| A3 | Declaration-level mistakes stay refused at `$extends`; a rule's own mistakes fail its model's first call, every time; `policy.compile(schema)` stays complete and byte-identical | owner + this plan |
| A4 | A rule can check a fact about the actor that does not depend on the row (`$exists`), written once per statement | owner, 2026-10-19 |
| A5 | A rule can compare a nested row's column with an enclosing row's column (outer reference) | owner, 2026-10-19 |
| A6 | Field-reference tokens inside a policy rule work (today they lower to `{}` and admission refuses: fails closed, but the feature is broken) | found 2026-10-19 |
| A7 | Pyxel's repository is not edited; its gains are measured from a variant of its policy built outside the repo | standing rule |
| A8 | Release only through Actions → Release with the owner's npm-production approval | standing rule |

Dropped, with reasons: merging CTEs that differ only in parameters (they
differ in meaning: one role each); a subquery operand (`$select`) for the role
check (A5 does it with less surface); caller-side `ctx.outer` in ordinary
`where` callbacks (§4.6).

## 2. A2 — per-model compilation (implemented, to finish)

State: local commits `1206e8b10`, `70060ff8c` on `release/1.3.2`.

- `policyCompiler(config, schema, actor)` (`src/permissions/compile.ts`):
  declaration checks at construction; `model(name)` compiles one model into
  one shared state; `acyclic(name)` compiles everything (any predicate may
  recurse over another model's self relation); `policy()` is the old output.
  `compilePolicy` = `policyCompiler(...).policy()`.
- `P`'s cycle stack unwinds on refusal (a compiler now outlives a refusal).
- Core contract: a `rows.verbs` entry may be a function (resolved, admitted
  and cached per registry on the model's first use); `RowsVerbs.acyclic` may
  be a function (resolved only for an update writing a self key). `LazyMap`
  in `bindRows`; per-chain reference check (`checkingLazyReferences`);
  `settledRows` for cache keys; `RowDomain.projects`.
- The entry compiles from a frozen snapshot of the declaration taken at
  `$extends`; exotic declarations (accessors, `Date` constants) keep the eager
  path.
- Measured (cold, apply + first query, Pyxel): `memberNotifications` ≈ 5×
  faster, `organizationBilling` 2–4×, `document` ≈ 40 %, `page` unchanged (its
  first read reaches 13 models through `accessGrant`). Warm: unchanged.

To finish: 100 % extension coverage (uncovered: `LazyMap` walking methods,
admission/reuse branches), provider suites, docs already drafted.

## 3. A4 — `$exists`: a check that does not depend on the row

### 3.1 Spelling and meaning

In a `rows` predicate (and so in a permissions rule), any `where` position may
hold:

```ts
{ $exists: { member: { organizationId: { control: "actor", path: "organizationId" },
                       userId: { control: "actor", path: "userId" }, user: { is: LIVE } } } }
```

- Exactly one model key; its value is that model's `where`. True when at least
  one row of the model, as the call may see it, matches.
- "As the call may see it": the body takes the target model's `related`
  domain from every other layer (soft delete, other extensions), never its
  own layer's (R5, as for relation filters). A permissions rule that wants the
  target's own permission writes it in the body (`{ organization: "read" }` is
  inlined as for relations, D7).
- The body may read control values, `$if`, relation filters, nested
  `$exists`, and outer references that stay inside the body (§4.2). It reads
  no column of the enclosing row: it is uncorrelated.
- Only in domain predicates, like `$if`: a caller's `where` refuses the key.
- Never NULL (EXISTS is two-valued).

### 3.2 Core and engine

- Admission (`src/validation/primitives/parameter.ts`, `src/extensions/admission.ts`):
  `DomainMarkers.exists?` hook intercepted in `conditionNodeOr` beside `$if`;
  admission validates the body with the target model's `where` schema
  (issue paths prefixed `$exists.<model>`); result is a frozen
  `Existence` node (`row-scope.ts`) whose own enumerable field is
  `$exists: { [model]: admittedBody }` (model by name: cache keys stay plain
  and non-circular). Whitelist the prototype in `isImmutableRowData` /
  `isImmutableRows`; WeakSet identity so re-admission is stable.
- Rows walkers (`src/extensions/rows.ts`): `collectReferences`, `readsCall`
  descend into the body (otherwise: no call values carried → total denial;
  undeclared controls unrefused).
- Engine (`src/query-engine/raptor3/shared/query.ts`): new `PreparedPredicate`
  kind `exists`; `#prepareWhere` branch (facts not exact, a `SelectorRead` on
  the target so nested-write ordering sees it); `foldConditions` (body false →
  false; body true → keep: "a visible row exists" is not TRUE), `callReads`
  (descend), `readsAny` → false (reads no column of the judged row; R4 judges
  against the table before the write), `readsRelation` → true (MySQL 1093,
  D1 isolation), `foldKnownNulls` does not descend; `#lowerPredicate`:
  `existsCheck(table(target, child), and(domainOf(target, "related"), body))`.
- One emission per statement: register the subquery as a `SharedBody` in
  `#sharingBodies` (no parent alias → identical occurrences key equal,
  values included). Where sharing is off (MySQL, SQLite3, mutation WHEREs)
  it stays inline; the databases evaluate an uncorrelated subquery once
  anyway, so the gain there is compile time and text, not runtime.

### 3.3 Permissions compiler

- `lower`: `$exists` branch (one schema model; body lowered at the target with
  D7 inlining; a false body makes the conjunct false).
- `provable`: `$exists` implies `$exists` of the same model when body implies
  body (EXISTS is monotone).
- `summarizeReads`: like a positive relation quantifier (its reads are guarded
  by the enclosing context); `guardAlternatives` descends; `fieldsRead` skips
  it (else a bogus `move:$exists`); `recursion` walks the body (acyclic).
- Types: `$exists` accepted in rule types (`src/permissions/index.ts`).
- **Hoisting (measured decision, H)**: rewriting `rel:{is|some:{A, E}}` to
  `E ∧ rel:{is|some:A}` and `OR[X∧E, Y∧E]` to `E ∧ OR[X,Y]` for `$exists`
  conjuncts E is sound (EXISTS two-valued; Kleene distributivity) and gated by
  `preservesReads`. Implement only if, after §3.2's one-emission, Pyxel's
  rewritten policy still spends significant compile time or text on the copies.
  Never from `every`/`none`/`isNot`/`NOT`, never across `recurse`. Policies
  without `$exists` must compile byte-identically.

## 4. A5 — outer references

### 4.1 Spelling

In a value position of a `rows` predicate:

```ts
{ row: "granteeRole", up: 2 }   // the column of the row 2 relation hops up
```

- `up` counts relation bodies (`is`, `isNot`, `some`, `every`, `none`, the
  to-one shorthand, an `$exists` body) between the value and the referenced
  row; `up: 0` is the same row (a same-row column comparison). Keys exactly
  `row` and `up`, `up` a non-negative integer: like `{ control }`, it is a
  marker only in domain predicates (a JSON column compared to such a literal
  must spell `{ equals: … }`).
- `up` may not leave the predicate it is written in: a predicate's root is
  depth 0, an `$exists` body's root is a new depth 0 (else it would be
  correlated). Inlined predicates (D7) keep their own relative depths.
- Pyxel's role check becomes one branch:

```ts
{ granteeRole: { not: null }, organization: { is: { members: { some: {
    userId: ME, role: { row: "granteeRole", up: 2 } } } } } }
```

### 4.2 Admission

A schema-aware static walk of the raw predicate (beside `cyclePath`) tracks
the model at each depth and refuses, naming the path: an `up` beyond the
predicate (or `$exists` body) root; a field the referenced model lacks; a
non-scalar, point or list field; a type different from the filtered field's
(scalar type and list-ness, as `checkRef` does); a reference inside a
`recurse` body or a polymorphic relation filter (not supported in 1.3.2). The
marker becomes a frozen `OuterColumn { row, up }` node (plain own fields:
cache keys distinguish `up`); whitelisted as immutable row data.

### 4.3 Engine

- Preparation carries a model stack per predicate (`#prepareWhere` →
  `#relationScope`, `$exists`); `#prepareOperand` maps an `OuterColumn` to
  `{ kind: "field", scalar, up }` resolved against the model `up` levels up
  (decimal and identifier-storage checks use that model).
- Lowering carries an alias stack pushed in `#lowerRelationPredicate` and the
  `$exists` case; each `lowerSelector` call starts a frame (a predicate's
  references are relative to its own root, not the statement's). An outer
  column resolves to `stack[length-1-up]` through `#preparedColumn` (read
  gates apply) and is never emitted bare (mutation targets: refuse when the
  frame has no alias for that level).
- Shared bodies: a relation body that contains a reference escaping it is not
  shareable (`inline`) up to the level that owns the referenced alias.
- Analyses: `readsAny` counts a reference that resolves to the judged row as a
  read of that field (else an update of `granteeRole` could skip the
  produced-row re-check, `produced()` / `producedWhere`'s `unread`);
  `SelectorFacts.fields` records it at the owning scope.

### 4.4 Permissions compiler

- `value()` keeps `{ row, up }` as data; `lower` checks `up` against the
  rule's own depth (refusal at compile, so `policy.compile` catches it) and
  the field on the model at that depth.
- A held field-reference token (A6) is lowered to `{ row: field, up: 0 }` when
  its model is the current model; any other token is refused with a message
  pointing at `{ row, up }`. Tokens never reach `keyOf` (all tokens key `{}`
  today).
- `fieldsRead` (moves, R4) walks every depth and adds the fields a reference
  reads on the rule's root row: a write of that field is placed again.
- `keyOf`, `same`, `provable`: plain data, structural; correct because
  references are relative and compared at the same position.

### 4.5 Risks named

Negated quantifiers with a NULL outer column (same three-valued behaviour as a
same-row comparison today, documented); MySQL 1093 path with references to
the mutation target; polymorphic arms and `recurse` refused for now.

### 4.6 Not in 1.3.2

`ctx.outer` for callers' `where` callbacks: needs a validation scope stack,
cache-key scope designators and either typed `outer` (TS2589 risk across the
cyclic where types) or an untyped accessor. The engine work here is the
foundation; the caller API is a later decision.

## 5. Pyxel validation (A7)

Build, in `/tmp/pyxel-bench`, a variant of Pyxel's policy: `TENANT` as
`organizationId: HERE` + one `$exists` live-member check; `grantTo`'s role
branches as one outer-reference branch. Measure against 1.3.1 and against the
branch without the rewrite: policy size, compile time cold/warm, SQL size and
PGlite time for page/document/accessGrant reads, cold first query per model.
Write the recipe in the guide (§7) with the measured numbers.

## 6. Verification gates

- Byte-identical `compile()` on the acceptance policy (430,140 B,
  `7a3d8cbf…`) and on Pyxel's unmodified policy.
- New tests: `$exists` (admission refusals, R5 visibility, folding, shared
  emission once, MySQL/SQLite/PG/D1 SQL, produced-row writes, nested-write
  ordering, cache keys), outer references (every quantifier, `up` limits,
  type refusals, moves re-judged when the referenced field changes, no
  sharing across escaping bodies, self relations), A6 tokens, lazy coverage.
- `pnpm test:types`; extensions coverage 100 % (and query-engine-core,
  validation gates as they stand); SQLite3, PGlite, D1, Docker PG/MySQL
  permissions and shared-body suites; Neki if credentials exist; package
  smokes; `pnpm test:dst` (100 seeds); docs validation; changed-file Biome;
  size limits (OD-17: measured rounded up to 0.1 kB + 0.3 kB, with reasons).
- CI green on the PR, Devin's review read, then squash-merge and Actions →
  Release 1.3.2 waiting for the owner's approval.

## 7. Docs and changelog

Permissions guide: per-model compilation (done), `$exists` and outer
references in the spellings table, a "Keeping policies small" section with
the Pyxel recipe and numbers; extension guide (`create.mdx`): `$exists`, outer
references, lazy entries (done); field-references page: policies may use
`{ row, up }`; CHANGELOG 1.3.2 (Added / Changed / Fixed: A6).
