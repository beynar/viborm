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

## 8. Adversarial review (2026-10-19) and dispositions

An independent review checked the plan against the code at `89633e5d9` and
reported 20 findings. Dispositions below supersede the sections above where
they differ.

| # | Sev. | Finding | Disposition |
|---|---|---|---|
| 1 | critical | A field-reference token, or an empty record, in an actor condition (`{ actor: { userId: token } }`, `{ actor: { p: {} } }`) lowers to no condition: the rule grants every row. **Reproduced on 1.3.1** (an actor named "nobody" read every post). A token in a value position lowers to `{}` (refused, except as a JSON `equals` literal). | **Fix (security).** The compiler refuses a token anywhere it is not a supported value (§4.4) and a condition record with no string key at any level. Tests for all spellings, under a JSON column, and at the type level. CHANGELOG "Security". |
| 2 | high | Cached reads (`cache: "allow"`) key on the whole settled policy: the first cached read compiles every model, a broken rule elsewhere throws, and every cached read serialises ≈ 815 KB (already in 1.3.1). An eager entry with a function `acyclic` throws in the key. | **Fix.** The rows identity in a cache key is a hash computed once per rows object (memoised), not the serialised policy. Settling that throws makes the read uncached (fail safe, A3 kept: the read itself still fails only on its own models). `settledRows` settles a function `acyclic` in eager entries too. Documented: the first cached read compiles the whole policy once per isolate. |
| 3 | high | Lazy `acyclic` compiles every model inside an update; an unrelated broken model makes every self-key write fail. | **Fix.** `acyclicAt` skips models whose compilation refuses (sound: a refused model judges nothing, and a model that inlines it refuses too). Documented as a one-time cost per isolate. |
| 4 | high | `readsAny`/`unread` decide whether a write re-judges the new row; an outer reference missed there lets `granteeRole` change unjudged. | **Specified (§4.3):** `readsAny` descends relation bodies with a depth counter, stops at `$exists` (new root), and counts `{ $row, up }` at depth d with `up == d` as a read of the judged row. Falsification tests (branch removed → must fail) for `update`, `updateMany`, `upsert`, nested update on SQLite3, PGlite, D1, Docker PG/MySQL. |
| 5 | medium | Lazy admission cache keyed by thunk only: one thunk under two models admits once. | **Fix:** key `(thunk, model)`. |
| 6 | medium | `compiled` is a plain `{}`: a model named `constructor`/`toString` reads an inherited function. | **Fix:** a `Map`. |
| 7 | medium | Three checkers for outer references would drift; an admission walk would duplicate the `where` schemas. | **Adopted:** no admission walk. The engine resolves and type-checks a reference in `#prepareOperand` against its model stack (refused when the statement is built, every time); the permissions compiler checks its own rules (unique coverage: `policy.compile`). |
| 8 | medium | Mutation selectors are qualified by the table name, not an alias. | **Adopted:** the root frame's qualifier is whatever the root is lowered with (alias or table name); never bare. Tests on MySQL's derived-table path and PG upsert. |
| 9 | medium | Refusing references in `recurse`/polymorphic bodies spreads through D7 inlining. | **Adopted:** only references that escape a `recurse` or polymorphic body are refused, by the permissions compiler (naming both models) and by the engine. |
| 10 | medium | `$exists` sharing needs its own shared-body kind; a CTE needs `LIMIT 1`. | **Adopted:** shared kind `exists`: `WITH __exists_N AS (SELECT 1 FROM … WHERE … LIMIT 1)`, used as `EXISTS (SELECT 1 FROM __exists_N)`. Test: two grants with different `granteeRole` in one statement never merge. |
| 11 | medium | Types: `$exists` missing from rule keys; lazy entries lose `$access` overloads and default-omit of gated fields; no types for `{ $row, up }`. | **Fix all three**, with type tests. |
| 12 | medium | DST, acceptance policy and oracle exercise neither feature; nothing enforces byte identity; engine coverage is a ratchet. | **Adopted:** a committed digest test of the compiled acceptance policy; SQL goldens unchanged for statements using neither feature; the DST policy gains a `$exists` membership check and an outer-reference role check, the independent oracle implements both; the new engine branches covered 100 %. |
| 13 | medium | Rule callbacks run at first use; the two-extension `evidence.as` collision moves to first use; compiler memos live as long as the schema. | **Documented**, not redesigned: a lazy entry's composition checks run when it resolves (eager entries unchanged). Retained heap measured on Pyxel; the compiler drops its memos once every model is compiled. |
| 14 | low | CHANGELOG must say errors move to first use and recommend `policy.compile(schema)` in CI. | Adopted. |
| 15 | low | `{ row, up }` collides with JSON literals and changes existing predicates' meaning. | **Adopted:** spelled `{ $row: "<field>", up: <n> }`; fields cannot start with `$`. |
| 16 | low | §4.1 contradicts itself on `$exists` depth. | An `$exists` body is a new root at depth 0; `up` never crosses it. |
| 17 | low | NULL outer columns under `every`/`none`. | Documented: same three-valued behaviour as same-row comparisons (a NULL never matches, so `none` holds). Not refused. |
| 18 | low | Functions count as immutable anywhere. | **Fix:** only a top-level `verbs` entry and `acyclic` may be functions in reusable rows. |
| 19 | low | `$exists` in nested writes. | Specified: it sees what its statement sees (earlier statements of the same write, never the row that statement writes, R4). |
| 20 | low | Hoisting (H) loses guard identity. | **Dropped** from 1.3.2. Sharing (§3.2, #10) gives the text reduction on PG/D1. |

Verified correct by the review: `LazyMap` keeps a failed build pending; `P`
unwinds; memos hold only completed results; `cycles()` pre-check; lazy entries
force `verbsRead`; per-chain reference checks; shared-body keys include values
and layer context; enum outer comparisons cast to text; `readsRelation → true`
for `$exists`; folding a false body; order independence tested.

## 9. As implemented (2026-10-19)

Departures from the plan, each decided with a measurement:

- **`$exists` bodies may read enclosing rows** (supersedes #16). Pyxel's role
  check written as `$exists: { member: { organizationId: { $row:
  "organizationId", up: 1 }, role: { $row: "granteeRole", up: 1 }, … } }` is
  one small subquery, where an outer reference through `organization.members`
  was a correlated relation body at every grant. An `$exists` body is one
  level below the row holding it, joined to nothing: without a `{ $row, up }`
  reaching out it is uncorrelated and shared; with one it is correlated and
  written in place (`frame.escaped`).
- **The outer-reference spelling is `{ $row, up }`** (#15).
- Field references in permission rules: the compiler's `isRecord` treats an
  object with a symbol key as a value, which both closes #1 and makes a
  same-row reference in a value position work (A6) without a conversion.
- A relation body containing a reference that escapes it is never shared
  (`correlatedAbove`), by the same lowering frames.
- The moves walk (`rootReads`) skips inlined `P(M, a)` objects (their
  references never leave them) and walks a shared clause once per depth: the
  first version walked inlined predicates as a tree and compiled Pyxel's
  policy in 472 ms instead of 40.
- An enum compared with a string through a reference is cast to text on both
  sides (PostgreSQL 42883 otherwise).
- Lazy rows are deep-frozen by the entry, so core reuses their admission per
  schema and a cache key digests them once (both were lost in the first lazy
  version; fresh-client apply back to ≈ 1.4 ms on Pyxel from source).

Measured on Pyxel's policy (PGlite, empty tables, from source):

| Policy variant | `page.findMany` | `page` + `$access` | `document.findMany` | `accessGrant.findMany` |
|---|---|---|---|---|
| as written | 5.0 KB, 2.4 ms | 9.4 KB, 4.0 ms | 4.8 KB, 3.4 ms | 26.3 KB, 14.1 ms |
| membership checks as `$exists` | 3.8 KB, 1.7 ms | 7.2 KB, 2.9 ms | 4.0 KB, 2.7 ms | 21.5 KB, 10.9 ms |
| + role check as one correlated `$exists` | 5.9 KB, 2.7 ms | 8.0 KB, 3.3 ms | 7.8 KB, 3.0 ms | 29.5 KB, 15.4 ms |

On PostgreSQL drivers and D1 the per-role uncorrelated checks win: each is
shared, while the correlated one is written at every grant. The guide says
so. Cold start (apply + first query, from source, loaded machine):
`memberNotifications` ≈ 5× faster than 1.3.1, `organizationBilling` 2–4×,
`document` ≈ 40 %, `page` unchanged.

Falsified: removing the `readsAny` descent lets a grant's role be rewritten
unjudged (contract test and the DST campaign at 100 seeds both fail);
keying lazy admission by function alone admits one model's entry for
another (contract test fails).
