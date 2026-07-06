# Prisma Nested Writes Implementation Plan

## Purpose

Close the nested-write gap identified in `prisma-subset-priorities.md`.

The target is not "nested writes for Postgres only". VibORM's core promise is
that ORM features are available across supported providers. Provider-specific
SQL belongs behind adapters/drivers, not in the public API contract.

External baseline: Prisma documents nested writes as relational writes with
transactional guarantees. VibORM should provide the same core guarantee for the
documented relational SQL surface: either the whole nested mutation succeeds or
nothing changes.

## Non-Negotiable Contract

- One public nested-write contract across supported providers.
- Query engine decides WHAT mutation graph to execute.
- Adapters/drivers decide HOW that graph becomes dialect-specific SQL or an
  atomic execution strategy.
- No accepted-but-ignored nested write key.
- No fake provider defaults. If a supported driver cannot execute a documented
  nested-write shape atomically, the driver implementation is incomplete.
- No destructive migrations, database drops, or data-loss operations outside
  isolated test databases.
- Runtime behavior and TypeScript behavior should agree where practical.
- No Prisma `XOR`, `Exact`, or heavy generated helper type clone.

## Target Surface

| Parent operation | Supported nested operations after this plan |
|------------------|---------------------------------------------|
| `create` | `create`, `createMany`, `connect`, `connectOrCreate` |
| `update` | `create`, `createMany`, `connect`, `connectOrCreate`, `disconnect`, `delete`, `set`, `update`, `updateMany`, `upsert`, `deleteMany` |
| `upsert` create branch | Same as parent `create` |
| `upsert` update branch | Same as parent `update` |
| top-level `createMany` | No relation envelopes |

`create` branch update/delete-like operations stay unsupported because there is
no existing related record under the new parent yet. They must reject before
query generation.

## Relation Shape Rules

| Relation shape | Operation shape |
|----------------|-----------------|
| To-one `update` | `update: { ...data }` |
| To-many `update` | `update: { where, data }` or array of `{ where, data }` |
| To-one `updateMany` | Unsupported; reject |
| To-many `updateMany` | `updateMany: { where?, data }` or array of `{ where?, data }` |
| To-one `upsert` | `upsert: { create, update }` |
| To-many `upsert` | `upsert: { where, create, update }` or array of that shape |
| To-one `deleteMany` | Unsupported; use `delete: true` where valid |
| To-many `deleteMany` | `deleteMany: where` or array of `where` |

All to-many targeted operations must be parent-correlated. A unique selector may
identify a real row, but the operation must still prove that row belongs to the
parent being mutated before it updates, deletes, or disconnects it.

## Phase 0: Contract Lock

### Scope

Define the exact nested-write contract before changing code.

### Work

- Update the compatibility matrix only as a contract draft, not as a completed
  support claim.
- Add examples for:
  - to-one nested `update`;
  - to-many nested `update`;
  - to-many nested `updateMany`;
  - to-one and to-many nested `upsert`;
  - to-many nested `deleteMany`;
  - required-relation rejection cases.
- Document zero-row semantics:
  - `update` and `delete` with a specific target throw if no correlated row is
    found.
  - `updateMany` and `deleteMany` may affect zero rows without throwing.
  - `upsert` creates only when no row matching `where` exists; if a row exists
    but belongs to another parent, reject instead of mutating or creating a
    duplicate.

### Success Criteria

- A reader can tell which shapes are planned, unsupported, and intentionally
  excluded.
- No docs imply provider-specific nested-write support.

### Verification

```bash
git diff --check -- docs/content/docs/client/compatibility.mdx docs/content/docs/client/relations/nested-writes.mdx
```

## Phase 1: Validation and Type Surface

### Scope

Accept the missing nested-write keys in validation schemas, but only in shapes
the query engine will implement later in this plan.

### Work

- Extend `src/validation/relations/update.ts`.
- Extend `SUPPORTED_NESTED_WRITE_KEYS` in
  `src/query-engine/builders/nested-write-detector.ts`.
- Extend `RelationMutation` and `parseRelationMutation` in
  `src/query-engine/builders/relation-data-builder.ts`.
- Add explicit runtime rejection for:
  - nested `updateMany` on to-one relations;
  - nested `deleteMany` on to-one relations;
  - nested `update`, `updateMany`, `upsert`, `deleteMany` inside parent
    `create` and upsert create branches;
  - malformed operation envelopes;
  - relation fields inside top-level `createMany`.

### Success Criteria

- TypeScript accepts only planned operation shapes.
- Runtime validation accepts the same planned shapes.
- Unsupported shapes fail before query generation.
- Existing supported nested writes remain unchanged.

### Expected Tests

- `tests/model/args/nested-args.test.ts`
  - type/runtime accepts planned new shapes;
  - type/runtime rejects invalid cardinality;
  - type/runtime rejects planned-unsupported create-branch update/delete keys.
- `tests/model/update/relation-update.test.ts`
  - relation update schema unit tests for every new operation.
- Existing tests for `create`, `connect`, `connectOrCreate`, `disconnect`,
  `delete`, and `set` stay green.

### Verification

```bash
pnpm vitest run tests/model/args/nested-args.test.ts tests/model/update/relation-update.test.ts tests/relations/update.test.ts
pnpm type-check
git diff --check
```

## Phase 2: Provider-Independent Atomic Execution Contract

### Scope

Remove the architectural assumption that nested writes require callback
transactions. Callback transactions are one execution strategy, not the public
feature boundary.

### Work

- Introduce a small nested mutation execution contract, not a god file:
  - likely location: `src/query-engine/operations/nested-writes/atomic-runner.ts`;
  - strategy 1: interactive transaction runner for drivers with
    `supportsTransactions`;
  - strategy 2: atomic batch / planned SQL runner for drivers with
    `supportsBatch`;
  - hard reject only when a driver supports neither atomic strategy.
- Keep operation code in concern files:
  - `update.ts` for nested update;
  - `update-many.ts` for nested updateMany;
  - `upsert.ts` for nested upsert;
  - `delete-many.ts` for nested deleteMany;
  - existing `connect.ts`, `disconnect.ts`, `delete.ts`, `set.ts` stay focused.
- For batch-only drivers, define what must be expressible without
  read-your-writes:
  - parent IDs must be known before child writes, or generated by a
    driver/adapter-owned expression that later statements can reference safely;
  - connect/update/delete targets must be expressible as correlated SQL
    predicates;
  - connectOrCreate/upsert must use adapter-owned conflict/conditional
    primitives, not host-side races.
- Add application-side ID generation where the scalar says `uuid`, `ulid`,
  `cuid`, or `nanoid`; this is required so parent create plus child create can
  be planned without provider-specific `RETURNING`.
- Keep auto-increment support provider-safe:
  - transactional drivers may use existing `RETURNING` / `lastInsertId` paths;
  - batch-only drivers must either have an adapter-owned safe expression or
    fail a driver conformance test until implemented.

### Success Criteria

- Query engine no longer treats `supportsTransactions === false` as automatic
  nested-write rejection.
- Every supported driver has a declared atomic nested-write strategy.
- The public nested-write contract does not vary by provider.
- Unsafe paths fail closed with capability errors until the driver strategy is
  implemented; they are not documented as provider-specific public behavior.

### Expected Tests

- `tests/query-engine/nested-mutation-routing.test.ts`
  - replace the current "non-transactional driver rejects nested writes" test
    with "driver lacking every atomic strategy rejects".
- `tests/drivers/*`
  - add driver capability tests for interactive, batch, or unsupported atomic
    nested mutation strategy.
- `tests/client/batch-transaction.test.ts`
  - ensure batch-only atomic execution still rejects non-batchable ordinary
    transactions but can be used by the nested-write runner when planned.

### Verification

```bash
pnpm vitest run tests/query-engine/nested-mutation-routing.test.ts tests/client/batch-transaction.test.ts
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 3: Nested `update`

### Scope

Implement nested `update` for to-one and to-many relations.

### Work

- Add `src/query-engine/operations/nested-writes/update-one.ts` or extend the
  current `update.ts` only if it remains cohesive.
- To-one:
  - update the currently related row;
  - throw if no related row exists;
  - preserve required-relation constraints.
- To-many:
  - require `whereUnique`;
  - combine `whereUnique` with parent correlation;
  - throw if the correlated target row does not exist;
  - allow recursive supported nested writes inside the nested update data.
- Use `buildSet`, `buildWhereUnique`, `buildWhere`, and FK helpers instead of
  ad hoc SQL strings.
- Preserve non-returning dialect behavior by refetching only through safe
  unique selectors.

### Success Criteria

- Specific child update cannot mutate another parent's child.
- Missing child throws and rolls back the parent mutation.
- Recursive nested writes either execute atomically or reject before mutation.
- SQL remains adapter-owned.

### Expected Tests

- `tests/query-engine/nested-mutation-routing.test.ts`
  - parent update plus to-one nested update;
  - parent update plus to-many nested update;
  - another parent's child cannot be updated;
  - missing child rolls back parent scalar update;
  - recursive nested update works or rejects before parent update.
- `tests/query-engine/nested-writes.test.ts`
  - parse/separate new mutation payload.
- `tests/client/operations.test.ts`
  - PGlite runtime happy path and rollback path.

### Verification

```bash
pnpm vitest run tests/query-engine/nested-mutation-routing.test.ts tests/query-engine/nested-writes.test.ts tests/client/operations.test.ts
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 4: Nested `updateMany` and `deleteMany`

### Scope

Implement set-based to-many nested mutations.

### Work

- Add focused files:
  - `src/query-engine/operations/nested-writes/update-many.ts`;
  - `src/query-engine/operations/nested-writes/delete-many.ts`.
- `updateMany`:
  - accepts `where?` plus `data`;
  - combines target `where` with parent correlation;
  - returns no public count in the parent payload;
  - zero affected rows is allowed.
- `deleteMany`:
  - accepts `where` or array of `where`;
  - combines each target filter with parent correlation;
  - zero deleted rows is allowed.
- Reject to-one `updateMany` / `deleteMany` before SQL generation.
- Preserve required relation safety:
  - `deleteMany` deletes rows and lets FK constraints enforce required related
    records;
  - `updateMany` must not set required FK fields to null through relation
    operations.

### Success Criteria

- Set-based operations cannot escape the parent correlation.
- Zero-match behavior matches the documented contract.
- Parent scalar mutation rolls back on child SQL failure.

### Expected Tests

- `tests/query-engine/nested-mutation-routing.test.ts`
  - updateMany updates only the parent's children;
  - deleteMany deletes only the parent's children;
  - zero-match updateMany/deleteMany is not an error;
  - SQL failure rolls back parent update.
- `tests/client/operations.test.ts`
  - client runtime coverage with deterministic seed data.
- `tests/query-engine/sql-generation.test.ts`
  - generated SQL includes parent correlation.

### Verification

```bash
pnpm vitest run tests/query-engine/nested-mutation-routing.test.ts tests/query-engine/sql-generation.test.ts tests/client/operations.test.ts
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 5: Nested `upsert`

### Scope

Implement nested upsert for to-one and to-many relations.

### Work

- Add `src/query-engine/operations/nested-writes/upsert.ts`.
- To-one:
  - if the relation currently has a target row, update it;
  - otherwise create a new target row and connect it;
  - for current-FK relations, update the parent FK when creating a target.
- To-many:
  - require `where`;
  - if `where` matches a row correlated to the parent, update it;
  - if `where` matches a row owned by another parent, reject;
  - if `where` matches no row, create a new row correlated to the parent.
- Use the atomic runner so the existence check and branch mutation are one
  atomic nested write, not a host-side race.
- Support recursive nested writes in `create` and `update` branches only when
  they can be executed atomically.

### Success Criteria

- Upsert cannot steal another parent's child.
- Missing child creates exactly one connected row.
- Existing child updates exactly that row.
- Concurrent duplicates are handled by unique constraints plus adapter-owned
  conflict behavior, not swallowed errors.

### Expected Tests

- `tests/query-engine/nested-mutation-routing.test.ts`
  - to-one upsert create branch;
  - to-one upsert update branch;
  - to-many upsert create branch;
  - to-many upsert update branch;
  - existing row owned by another parent rejects;
  - unique conflict rolls back parent mutation.
- `tests/client/operations.test.ts`
  - runtime PGlite coverage.
- `tests/drivers/count-aggregate-window-behavior.ts` is not touched; use driver
  nested-write shared spec instead if introduced in Phase 6.

### Verification

```bash
pnpm vitest run tests/query-engine/nested-mutation-routing.test.ts tests/client/operations.test.ts
pnpm test:drivers:local
pnpm type-check
git diff --check
```

## Phase 6: Cross-Provider Nested Write Behavior Spec

### Scope

Prove the feature works across local supported providers, then add hosted-driver
coverage where practical.

### Work

- Extract a shared nested-write behavior spec:
  - suggested file: `tests/drivers/nested-write-behavior.ts`;
  - schema: `user`, `post`, `profile`, `tag`, and a many-to-many join case;
  - deterministic IDs and nullable/non-nullable FK variants;
  - coverage for every supported nested operation.
- Apply the shared spec to:
  - PGlite;
  - SQLite3;
  - LibSQL.
- Add dialect SQL-generation coverage for:
  - PostgreSQL;
  - SQLite;
  - MySQL.
- Add hosted/external suites only when credentials or stable local emulators are
  available:
  - D1;
  - D1 HTTP;
  - Neon HTTP;
  - MySQL/PlanetScale.
- If any supported driver lacks an atomic nested-write strategy, keep the phase
  open. Do not document the public feature as provider-specific.

### Success Criteria

- Local driver suites prove nested writes behave the same on PGlite and
  SQLite-family drivers.
- SQL-generation tests prove MySQL dialect keeps parent correlation and
  fail-closed behavior.
- Hosted-driver gaps are explicitly tracked as implementation blockers, not
  accepted public-contract differences.

### Verification

```bash
pnpm test:pglite
pnpm test:sqlite
pnpm test:drivers:local
pnpm vitest run tests/query-engine/nested-mutation-routing.test.ts tests/query-engine/sql-generation.test.ts
pnpm type-check
git diff --check
```

## Phase 7: Result Shaping and Documentation Reconciliation

### Scope

Make returned payloads and docs match the implemented nested-write surface.

### Work

- Ensure parent mutation result shaping respects `select` and `include` after
  nested update/updateMany/upsert/deleteMany.
- Ensure relation `_count` and included relations are refetched after mutation
  through safe unique selectors.
- Update:
  - `docs/content/docs/client/compatibility.mdx`;
  - `docs/content/docs/client/relations/nested-writes.mdx`;
  - `README.md` matrix if `Subset` status changes.
- Remove conceptual warnings for shapes that are now proven.
- Keep explicit warnings for intentionally unsupported create-branch update /
  delete-like operations.

### Success Criteria

- Docs no longer say nested `update`, `updateMany`, `upsert`, or `deleteMany`
  are unsupported once implemented.
- README accurately reflects remaining subset rows.
- Result shape tests cover select/include with nested write results.

### Verification

```bash
pnpm vitest run tests/client/select-include-result.test.ts tests/client/operations.test.ts
pnpm type-check
pnpm test:drivers:local
git diff --check
```

## Final Audit

Run the strongest practical suite before marking nested writes complete:

```bash
pnpm vitest run tests/model/args/nested-args.test.ts tests/model/update/relation-update.test.ts tests/relations/update.test.ts
pnpm vitest run tests/query-engine/nested-writes.test.ts tests/query-engine/nested-mutation-routing.test.ts tests/query-engine/nested-create-many.test.ts tests/query-engine/named-inverse-nested-writes.test.ts
pnpm vitest run tests/client/operations.test.ts tests/client/relation-types.test.ts tests/client/select-include-result.test.ts
pnpm test:drivers:local
pnpm type-check
pnpm test
pnpm build
git diff --check
```

Final completion requires:

- no accepted nested-write shape is ignored;
- every documented shape is atomic;
- every supported local provider passes the shared behavior spec;
- unsupported shapes reject before query generation;
- parent correlation is tested for every destructive child operation;
- docs, README, and compatibility tables match the actual contract.

## Final Audit Preparation Notes

- Local conformance coverage for nested writes is represented by
  `tests/drivers/nested-write-behavior.ts` and is wired for PGlite, SQLite3, and
  LibSQL.
- Hosted/external gaps are tracked in
  `tests/drivers/nested-write-provider-gaps.md`; they are not
  provider-specific public contract differences.
- Public docs describe nested `update`, `updateMany`, `upsert`, and
  `deleteMany` as supported only in the documented parent/relation shapes, with
  create-branch update/delete-like exclusions kept explicit.
