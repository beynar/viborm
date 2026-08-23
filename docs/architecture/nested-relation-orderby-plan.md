# Multi-level nested relation orderBy — phased plan

> **Superseded relation spellings.** This document is a historical record. Its
> relation declarations use the retired six-factory API, and its diagnostics and
> internal type names may name owners that no longer exist. The shipped language
> is two factories, `s.toOne` and `s.toMany`, whose argument states the target
> domain; pairing, foreign-key ownership, uniqueness, junction topology and slot
> emptiness are all derived by one schema-wide resolver. See
> [`./global-relation-cardinality-plan.md`](./global-relation-cardinality-plan.md) for the unified language and
> the deliberate verdict changes it made. The measured history below is
> deliberately not rewritten into a new-API history.

Status: **delivered — historical record.** Anchor: branch `prisma-parity`.

> **The depth cap in this document is out of date.** The plan was written and
> executed against a cap of **3** relation hops; decision D-5 (unit W1-U7 on
> `prisma-parity-v2`) raised it to **8**. The live constants are
> `MAX_RELATION_ORDER_DEPTH` in `src/validation/relations/order-by.ts` and
> `src/query-engine/builders/relation-orderby-builder.ts`, pinned equal by
> `tests/query-engine/orderby-relation-depth.test.ts`; the user-facing statement
> is in `docs/content/docs/client/sorting.mdx`. Everything below is preserved as
> the original design record — read "3 hops" as "the cap at the time".

## Problem & first principles

Today's relation orderBy is **one hop deep**:
- to-one: `orderBy: { author: { name: "asc" } }` — scalar fields of the target
  only (`relation-orderby-builder.ts:59` `buildToOneRelationOrders`, which
  `throw`s if the field `!isScalarField(targetModel, field)`);
- to-many: `orderBy: { posts: { _count: "asc" } }` only.

Prisma allows chaining through to-one relations:
`orderBy: { post: { author: { name: "asc" } } }`. VibORM rejects it at both the
validation layer (`validation/relations/order-by.ts` `toOneOrderByFactory`
offers only `getTargetScalarOrderBySchema` = target scalars) and the engine
(the `isScalarField` throw above).

### The mechanism is already 90% present

`getRelationOrderAlias` (`relation-orderby-builder.ts:99`) already builds a
`LEFT JOIN <target> AS <alias> ON <correlation>` via `buildCorrelation` and
threads joins up through `OrderByParts.joins` → `find-common.ts:106`. Extending
to N hops is: **when an orderBy field on the target is itself a to-one relation,
recurse — chain another LEFT JOIN off the current relation's alias (not the root
alias) and build orders against the deeper alias.** The join primitive,
correlation builder, and alias generator all already exist and compose.

So the engine change is small and mechanical. **The hard part is the validation
schema**: it must become *recursive* (a to-one's orderBy includes that model's
to-one relations, which include theirs…), and this codebase is acutely
TS-recursion-sensitive — see the memory note on mutually-recursive model consts
collapsing to `any`, and the TS2589 depth error hit in the coverage work. A
naive recursive schema will either blow instantiation depth or collapse types.
**Bounded depth is a hard requirement, not a nicety.**

## Scope decisions (decided)

- **To-one chains only.** `{ post: { author: { name } } }` — each hop is a
  to-one (`manyToOne`/`oneToOne`). Ordering *through* a to-many is meaningless
  without an aggregate; the existing `{ posts: { _count } }` stays the only
  to-many form. A to-many appearing mid-chain is rejected with a clear error.
- **Depth cap: 3 relation hops** (matches Prisma's practical limit and bounds
  the type recursion). Beyond the cap: clear error, not silent truncation.
- **Every hop is a LEFT JOIN** (a null parent FK → null sort key, ordered per
  the existing `nulls` handling). Correct and matches single-hop today.
- **Self-relations & cycles** (`category.parent.parent…`) must work up to the
  depth cap — the depth bound is what makes a cyclic schema's orderBy type
  finite.

## Phase 1 — Engine: recursive JOIN building (behind the existing validation gate)

**Goal:** the builder can emit N-hop join chains; still unreachable until Phase 2
opens validation, so no behavior change.

- In `buildToOneRelationOrders` (`relation-orderby-builder.ts:59`): replace the
  `isScalarField` throw with a branch — if the field is a **to-one relation** on
  `relationInfo.targetModel`, recurse: resolve/reuse a nested alias JOINed off
  the *current* `relatedAlias`, and recurse into `buildToOneRelationOrders` with
  the nested relation + deeper alias + a depth counter. If it's a to-many →
  clear "cannot order through a to-many relation; use `_count`" error. If
  neither scalar nor relation → existing unknown-field error.
- **Alias keying:** `relationAliases` is currently keyed by `relationInfo.name`
  (`getRelationOrderAlias:104`). Re-key by **relation path** (`"post.author"`)
  so (a) the same nested relation reused across orderBy keys shares one join,
  and (b) two different paths to the same model don't collide. Thread the parent
  path down the recursion.
- **Depth guard:** pass a `depth` param; `throw` a clear error past the cap
  (defense-in-depth even though validation will also cap it).
- Correlation for the nested hop uses the **nested** relation's fields, JOINed
  parent-alias = the outer relation's alias. `buildCorrelation` already takes
  `(ctx, relationInfo, parentAlias, relatedAlias)` — pass the chained aliases.

*Gate:* a white-box builder test constructs a 2- and 3-hop orderBy input and
asserts the emitted SQL has the right chained `LEFT JOIN`s and the ORDER BY
references the deepest alias — no client/validation involved yet.

## Phase 2 — Validation: bounded recursive to-one orderBy schema

**Goal:** open the type so `{ post: { author: { name } } }` validates, with a
hard depth bound to protect TS instantiation.

- Rewrite `toOneOrderByFactory` (`validation/relations/order-by.ts`) so a
  to-one's orderBy schema = **target scalars** (as today) **∪** an entry per
  **target to-one relation**, whose value is *the same schema one level
  shallower*. Implement with an explicit **depth-parameterised generator**
  (`buildToOneOrderBySchema(target, depth)`), NOT open `v.lazy` recursion —
  `depth` decrements to 0 (scalars only), giving a finite, bounded type. This is
  the crux: the bound is what keeps the inferred type finite on cyclic schemas
  and under TS's depth limit.
- **Type-level:** the corresponding `ToOneOrderBySchema<S>` type must mirror the
  bounded generator with a depth-counter tuple (e.g. `[unknown, unknown,
  unknown]` shrinking per level) so the *inferred* client type is also finite.
  This is the highest-risk piece — see Risks. Prove it with type tests before
  wiring runtime.
- The to-many factory (`toManyOrderByFactory`) is unchanged (`_count` only).

*Gate:* `tests/model/args/` type test: `{ post: { author: { name: "asc" } } }`
type-checks; a 4-hop chain is a type error; a to-many mid-chain is a type error;
**`pnpm type-check` on the whole suite stays clean** (the real gate — a depth
blow-up surfaces here, cf. TS2589). Runtime validation-schema unit test for the
same cases.

## Phase 3 — End-to-end wiring, cross-dialect execution

**Goal:** the feature works through the client on every driver.

- Confirm `find-common.ts` / `include-builder` thread the multi-hop
  `OrderByParts.joins` unchanged (they already spread `orderByParts.joins` into
  the query — likely zero change).
- **Execution tests** in a shared behavior suite (extend
  `relation-read-aggregate-behavior.ts` or new `nested-orderby-behavior.ts`),
  wired into all six driver files: 2-hop and 3-hop chains return exactly-ordered
  rows; null-FK rows sort per `nulls`; a self-relation chain
  (`category` ordered by `parent.parent.name`) works; ordering through a
  to-many errors clearly; combined with `take`/`skip`/multi-key orderBy.
- Docs: `docs/content/docs/client/sorting.mdx` currently *documents* multi-level
  nested orderBy (the drift the audit flagged). This phase makes the docs true —
  align the example to the real depth cap.

*Gate:* execution suite green on pglite/sqlite3/libsql + Docker MySQL/pg;
`sorting.mdx` example runs as written.

## Phase 4 (optional) — Ordering by nested `_count` / aggregates

**Goal:** Prisma also allows `orderBy: { posts: { _count: "desc" } }` at depth
and aggregate orderBy in groupBy; assess whether nested aggregate ordering
(`{ author: { posts: { _count } } }`) is wanted.

- Likely low demand; **explicit non-goal unless requested** — note it here so it
  isn't silently assumed. The Phase 1 recursion + the existing
  `buildToManyRelationOrders` could combine, but only build it on a real ask.

## Risks
- **TS instantiation depth / `any`-collapse (primary risk).** The recursive
  schema type is exactly the shape that has bitten this codebase (memory:
  mutually-recursive model consts; the TS2589 in coverage). The depth-counter
  bound and a type-test gate *before* runtime wiring are the mitigation. If a
  3-hop bound still strains type-check, drop to 2 hops (still covers the
  overwhelmingly common case) rather than reaching for `any`.
- **Alias collisions across include + orderBy** — the shared monotonic alias
  generator already prevents this; path-keyed reuse must not accidentally share
  a join across two semantically different paths (hence key by full path, not
  model).
- **Performance:** each hop is a LEFT JOIN; a 3-hop order = 3 joins. Acceptable
  and index-usable; no subquery-per-row. Note it, don't optimize prematurely.

## Definition of done
`orderBy: { post: { author: { name: "asc" } } }` (to-one chains, ≤3 hops,
including self-relations) validates with a finite inferred type, executes as
chained LEFT JOINs producing correctly-ordered rows on every driver, rejects
to-many-mid-chain and over-depth with clear errors, and the `sorting.mdx` docs
match reality. `pnpm type-check` stays clean — the bounded type is the whole
game.
