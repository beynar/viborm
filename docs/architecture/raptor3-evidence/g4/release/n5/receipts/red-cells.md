# Red cells after N1 (estate-final: 99 cells in 25 files)


## tests/contracts/engine/query/nested-write-conformance-fk.test.ts (1)
- nested-write conformance: FK relations (tx vs batch) > createMany duplicate PK rolls back parent and prior children
    => AssertionError: expected { users: [ { id: 'u1', …(1) } ], …(4) } to deeply equal { users: [], posts: [], …(3) }

## tests/contracts/engine/query/nested-write-conformance-root-dependency.test.ts (2)
- nested-write conformance: create root barrier (tx vs batch) > before-parent self connect is unaffected by the future insert
    => AssertionError: expected 'Nested operation \'connect\' on relat…' to contain 'target record was not found'
- nested-write conformance: create root barrier (tx vs batch) > nested create keeps its before-parent decision ahead of its insert
    => AssertionError: expected 'query-engine-v2 create has conflictin…' to contain 'target record was not found'

## tests/contracts/engine/query/relation-key-update-legality-occupied-to-one.test.ts (1)
- relation-key update legality > reports not-found for an empty setNull child-held UPDATE under a PK transition
    => AssertionError: expected { name: 'QueryError', …(1) } to deeply equal { name: 'NestedWriteError', …(1) }

## tests/contracts/engine/query/relation-key-update-legality-transition-arm.test.ts (1)
- relation-key update legality > allows primary-key arithmetic transition with cascade upsert
    => AssertionError: expected { name: 'NotFoundError', …(1) } to deeply equal { name: 'UniqueConstraintError', …(1) }

## tests/contracts/engine/query/starts-with-prefix-plan.test.ts (5)
- PostgreSQL prefix plans (C-collated substrate) > default-mode startsWith becomes an index range
    => FAIL  |extended-local| tests/contracts/engine/query/starts-with-prefix-plan.test.ts > PostgreSQL prefix plans (C-collated substrate) > the range narrows to the matching rows, and they are the right on
- PostgreSQL prefix plans (C-collated substrate) > endsWith seq-scans under either spelling, which is why it did not move
    => error: missing FROM-clause entry for table "q0"
- PostgreSQL prefix plans (C-collated substrate) > the range narrows to the matching rows, and they are the right ones
    => FAIL  |extended-local| tests/contracts/engine/query/starts-with-prefix-plan.test.ts > PostgreSQL prefix plans (C-collated substrate) > endsWith seq-scans under either spelling, which is why it did not
- SQLite prefix plans > default-mode startsWith becomes an index range
    => SqliteError: no such column: q0.title
- SQLite prefix plans > the range returns exactly the matching rows
    => SqliteError: no such column: q0.title

## tests/contracts/engine/write/combined-depth-stress.test.ts (1)
- X1b combined depth stress — four mechanisms in one >=6-level tree > batch composes the same four mechanisms
    => TransactionError: Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.

## tests/contracts/engine/write/compound-junction.test.ts (4)
- compound many-to-many (atomicBatch) > skipDuplicates links only the exact complete target key
    => TransactionError: Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.
- compound many-to-many (transaction) > skipDuplicates links only the exact complete target key
    => ForeignKeyError: Foreign key constraint violation
- compound-key member uniqueness (atomicBatch) > one independently unique key member cannot link a different tuple
    => TransactionError: Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.
- compound-key member uniqueness (transaction) > one independently unique key member cannot link a different tuple
    => ForeignKeyError: Foreign key constraint violation

## tests/contracts/engine/write/create-many-skip-depth.test.ts (2)
- X1b mechanism 3 — createMany skipDuplicates under a fresh create at depth > batch: skip under a fresh create attaches survivors to the fresh child, na
    => TransactionError: Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.
- X1b mechanism 3 — createMany skipDuplicates under a located update target > batch: skip keeps the fresh child under c1, drops the duplicate, native Ob
    => TransactionError: Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.

## tests/contracts/engine/write/generated-output-fallback.test.ts (1)
- generated output exact batch scratch > a nested generated key and relation-supplied publication stay in one native batch
    => AssertionError: promise rejected "UnsupportedOperationError: query-engine-v… { …(4) }" instead of resolving

## tests/contracts/engine/write/inverse-to-one-update-depth.test.ts (2)
- E2-U1 provenance: the deeper key comes from the row the probe locked > a probe row without the located key fails closed at planning (atomic batch)
    => AssertionError: expected [Function] to throw error matching /did not produce row field 'id'/ but got 'Driver "pglite" returned a malformed …'
- E2-U1 provenance: the deeper key comes from the row the probe locked > a probe row without the located key fails closed at planning (transaction)
    => FAIL  |extended-local| tests/contracts/engine/write/inverse-to-one-update-depth.test.ts > E2-U1 provenance: the deeper key comes from the row the probe locked > a probe row without the located key fai

## tests/contracts/engine/write/junction-create-many-routing.test.ts (4)
- residual F1 — junction skip disposition is row-local and ordered > a relation-bearing spelled duplicate suppresses its subtree and join
    => AssertionError: expected [ { id: 1 }, { id: 2 } ] to deeply equal [ { id: 2 } ]
- residual F1 — junction skip disposition is row-local and ordered > a scalar adopter plans after a relation-bearing adopter creates its target
    => AssertionError: expected [ { slug: 'A', label: 'PARENT' } ] to deeply equal [ Array(2) ]
- residual F1 — junction skip disposition is row-local and ordered > a spelled scalar key links only when that exact target exists
    => ForeignKeyError: Foreign key constraint violation
- residual F1 — unnameable indexes dominate an adoptable selector > a spelled key does not link when only a raw unique index conflicts
    => ForeignKeyError: Foreign key constraint violation

## tests/contracts/engine/write/junction-produced-identity.test.ts (2)
- E4-U3 junction produced identity (atomic batch) > skipDuplicates with a produced key ADOPTS instead of refusing (E4-U3 × E6.8)
    => TransactionError: Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.
- E4-U3 junction produced identity (transaction) > skipDuplicates with a produced key ADOPTS instead of refusing (E4-U3 × E6.8)
    => AssertionError: expected [ 2 ] to deeply equal [ 2, -1 ]

## tests/contracts/engine/write/mutation-projection-cte-fold.test.ts (16)
- Phase 8.1 — the fold answers what the read answers > _count with an explicit relation answers what the read answers, on both substrates
    => FAIL  |extended-local| tests/contracts/engine/write/mutation-projection-cte-fold.test.ts > Phase 8.1 — the fold answers what the read answers > a select mixing scalars and a relation answers what the 
- Phase 8.1 — the fold answers what the read answers > a create's include folds to the read's answer
    => AssertionError: expected false to be true // Object.is equality
- Phase 8.1 — the fold answers what the read answers > a select mixing scalars and a relation answers what the read answers, on both substrates
    => FAIL  |extended-local| tests/contracts/engine/write/mutation-projection-cte-fold.test.ts > Phase 8.1 — the fold answers what the read answers > a to-many include with a cursor on the child's own key a
- Phase 8.1 — the fold answers what the read answers > a to-many include answers what the read answers, on both substrates
    => FAIL  |extended-local| tests/contracts/engine/write/mutation-projection-cte-fold.test.ts > Phase 8.1 — the fold answers what the read answers > a to-many include with its own select answers what the r
- Phase 8.1 — the fold answers what the read answers > a to-many include with a cursor on the child's own key answers what the read answers, on both sub
    => AssertionError: expected false to be true // Object.is equality
- Phase 8.1 — the fold answers what the read answers > a to-many include with a where and an orderBy answers what the read answers, on both substrates
    => FAIL  |extended-local| tests/contracts/engine/write/mutation-projection-cte-fold.test.ts > Phase 8.1 — the fold answers what the read answers > _count with an explicit relation answers what the read a
- Phase 8.1 — the fold answers what the read answers > a to-many include with its own select answers what the read answers, on both substrates
    => FAIL  |extended-local| tests/contracts/engine/write/mutation-projection-cte-fold.test.ts > Phase 8.1 — the fold answers what the read answers > a to-many include with a where and an orderBy answers wh
- Phase 8.1 — the fold's statement traffic > batch mode folds behind its in-unit presence guard
    => AssertionError: expected [ …(4) ] to have a length of 2 but got 4
- Phase 8.1 — the fold's statement traffic > create + include is ONE statement, and it is the CTE
    => AssertionError: expected [ …(2) ] to have a length of 1 but got 2
- Phase 8.1 — the fold's statement traffic > update + include is ONE statement, and it is the CTE
    => AssertionError: expected [ …(3) ] to have a length of 1 but got 3
- Phase 8.1 — the two legality guards > on that same model, an ordinary column still folds
    => AssertionError: expected false to be true // Object.is equality
- Phase 8.1 — what the fold must not change > a model nothing references folds a key rewrite that the cascading model declines
    => AssertionError: expected false to be true // Object.is equality
- Phase 8.2 — the nested-create tree > ONE arm taking a generated key still folds: its row order is the statement's own
    => AssertionError: expected false to be true // Object.is equality
- Phase 8.2 — the nested-create tree > a nested createMany rides the same fold
    => AssertionError: expected [ …(4) ] to have a length of 1 but got 4
- Phase 8.2 — the nested-create tree > a root and its two children are ONE statement
    => AssertionError: expected [ …(4) ] to have a length of 1 but got 4
- Phase 8.2 — the nested-create tree > a skip-carrying arm on another table still folds
    => AssertionError: expected false to be true // Object.is equality

## tests/contracts/engine/write/nested-create-context-grandchild.test.ts (1)
- CLASS VI key 3 — root-create nested createMany skipDuplicates > direct, transaction, and batch preserve the same skip winner
    => TransactionError: Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.

## tests/contracts/engine/write/nested-error-attribution.test.ts (1)
- nested statement error attribution > a tree folded into ONE statement keeps the operation's model
    => AssertionError: expected { model: 'post', …(2) } to deeply equal { model: 'author', …(2) }

## tests/contracts/engine/write/nested-semantic-stability.test.ts (2)
- X1 semantic stability — own-write 'split these operations' at depth > depth-1 root create rejects with the own-write message
    => AssertionError: expected 'Unique constraint violation' to contain 'Split these operations into separate …'
- X1 semantic stability — own-write 'split these operations' at depth > depth-4 lifted create-context chain rejects with the SAME own-write message
    => AssertionError: expected 'Unique constraint violation' to contain 'Split these operations into separate …'

## tests/contracts/engine/write/parent-held-lookup.test.ts (10)
- E1 U1 — the guard→UPDATE vanish window > a target deleted between planning and the batch aborts typed, writing nothing
    => AssertionError: expected error to be instance of NestedWriteError
- E1 U1 — the lookup fold's provenance > a probe row whose required referenced column reads NULL fails typed parsing
    => AssertionError: expected [Function] to throw error including 'Driver "pglite" returned a malformed …' but got 'Driver "pglite" returned a malformed …'
- E1 U1 — the lookup fold's provenance > the written key comes from the LOOKUP, not from the probe row
    => AssertionError: expected { id: 2, title: 'book-2', authorId: 1 } to deeply equal { id: 2, title: 'book-2', authorId: 2 }
- E1 U4 — the delegated upsert arm's staleness window > a target that vanishes before the batch aborts with the upsert family's wording
    => AssertionError: expected [Function] to throw error including 'Nested upsert premise changed for rel…' but got 'No author record found for update'
- PGlite atomic batch before-root target subtree (E1 U3) > a null referenced field in the target's create data stays refused
    => AssertionError: expected [Function] to throw error including 'query-engine-v2 update cannot resolve…' but got 'query-engine-v2 create cannot resolve…'
- PGlite atomic batch parent-held to-one lookup (E1 U1/U2) > a located target whose referenced NULLABLE unique is NULL refuses, and writes nothing
    => AssertionError: promise resolved "{ id: 1, name: 'renamed', …(1) }" instead of rejecting
- PGlite atomic batch parent-held upsert arm relations (E1 U4) > a same-update FK rebind makes the arm correlate on the FINAL value
    => AssertionError: promise rejected "UnsupportedOperationError: query-engine-v… { …(4) }" instead of resolving
- PGlite transaction before-root target subtree (E1 U3) > a null referenced field in the target's create data stays refused
    => FAIL  |extended-local| tests/contracts/engine/write/parent-held-lookup.test.ts > PGlite atomic batch before-root target subtree (E1 U3) > a null referenced field in the target's create data stays refu
- PGlite transaction parent-held to-one lookup (E1 U1/U2) > a located target whose referenced NULLABLE unique is NULL refuses, and writes nothing
    => FAIL  |extended-local| tests/contracts/engine/write/parent-held-lookup.test.ts > PGlite atomic batch parent-held to-one lookup (E1 U1/U2) > a located target whose referenced NULLABLE unique is NULL re
- PGlite transaction parent-held upsert arm relations (E1 U4) > a same-update FK rebind makes the arm correlate on the FINAL value
    => FAIL  |extended-local| tests/contracts/engine/write/parent-held-lookup.test.ts > PGlite atomic batch parent-held upsert arm relations (E1 U4) > a same-update FK rebind makes the arm correlate on the F

## tests/contracts/engine/write/polymorphic-collection-write-family.test.ts (11)
- polymorphic collection `set` refuses before the clear on a splittable batch > a generated target after the clear refuses with prior state intact
    => AssertionError: promise resolved "{ tenantId: 't1', code: 'left', …(2) }" instead of rejecting
- polymorphic collection write family (atomicBatch) > createMany skipDuplicates coalesces an existing singular target transition
    => TransactionError: Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.
- polymorphic collection write family (atomicBatch) > createMany skipDuplicates joins a later same-key row after an alternate conflict
    => TransactionError: Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.
- polymorphic collection write family (transaction) > SINGULAR member: exact reconnect is idempotent, an occupied slot TRANSFERS
    => TransactionError: Concurrent membership change on the singular polymorphic member of relation 'items.book': the captured owner's membership was already removed; retry to converge.
- polymorphic collection write family (transaction) > createMany skipDuplicates joins a later same-key row after an alternate conflict
    => ForeignKeyError: Foreign key constraint violation
- singular collection inverse (atomicBatch) > nested updateMany refuses one singular member across two owners before writing
    => AssertionError: promise resolved "{ id: 'w1', label: 'Warehouse' }" instead of rejecting
- singular collection inverse (atomicBatch) > non-empty set and connectOrCreate reach the same root membership guard
    => AssertionError: promise resolved "{ count: 2 }" instead of rejecting
- singular collection inverse (atomicBatch) > root updateMany refuses one singular member across two owners before writing
    => AssertionError: promise resolved "{ count: 2 }" instead of rejecting
- singular collection inverse (transaction) > nested updateMany refuses one singular member across two owners before writing
    => FAIL  |extended-local| tests/contracts/engine/write/polymorphic-collection-write-family.test.ts > singular collection inverse (atomicBatch) > nested updateMany refuses one singular member across two o
- singular collection inverse (transaction) > non-empty set and connectOrCreate reach the same root membership guard
    => FAIL  |extended-local| tests/contracts/engine/write/polymorphic-collection-write-family.test.ts > singular collection inverse (atomicBatch) > non-empty set and connectOrCreate reach the same root memb
- singular collection inverse (transaction) > root updateMany refuses one singular member across two owners before writing
    => FAIL  |extended-local| tests/contracts/engine/write/polymorphic-collection-write-family.test.ts > singular collection inverse (atomicBatch) > root updateMany refuses one singular member across two own

## tests/contracts/engine/write/progressive-parent-rowkey.test.ts (7)
- H1 — each placement guards its exact progressive premise > a child-held relation-bearing updateMany
    => AssertionError: expected 'SELECT 1 / CASE WHEN EXISTS (SELECT "…' to contain '"t0"."id" = $1'
- H1 — each placement guards its exact progressive premise > a junction relation-bearing createMany
    => AssertionError: expected 'SELECT 1 / CASE WHEN EXISTS (SELECT "…' to contain '"t0"."id" = $1'
- H1 — each placement guards its exact progressive premise > a junction relation-bearing updateMany
    => AssertionError: expected 'SELECT 1 / CASE WHEN EXISTS (SELECT "…' to contain '"t0"."id" = $1'
- H1 — the complete parent row key at a progressive nested series > a before-root series re-pins the selected row by its captured key
    => AssertionError: expected 0 to be less than 0
- H1 — the complete parent row key at a progressive nested series > a child-held updateMany cannot continue under a replacement owner
    => AssertionError: promise resolved "{ id: 'h-row-key', code: 'H3', …(1) }" instead of rejecting
- H1 — the complete parent row key at a progressive nested series > a concurrent move of the referenced value fails the member closed
    => AssertionError: promise resolved "{ id: 'h-row-key', …(2) }" instead of rejecting
- H1 — the complete parent row key at a progressive nested series > row liveness and non-PK membership remain separate guard facts
    => AssertionError: expected -1 to be greater than or equal to 0

## tests/contracts/engine/write/shared-pk-update-root.test.ts (16)
- Package E shared-PK update root (PGlite atomic batch) > a partial compound shared edge publishes every transitioned member
    => ForeignKeyError: Foreign key constraint violation
- Package E shared-PK update root (PGlite atomic batch) > fresh create publishes the complete selected compound tuple
    => UnsupportedOperationError: query-engine-v2 create cannot resolve the parent id for relation 'tokens': referenced field 'accountCode' is neither this record's primary key nor a knowable value in its ow
- Package E shared-PK update root (PGlite atomic batch) > update publishes a nested relation-folded non-primary referenced field
    => FAIL  |extended-local| tests/contracts/engine/write/shared-pk-update-root.test.ts > Package E shared-PK update root (better-sqlite3) > update publishes a nested relation-folded non-primary referenced 
- Package E shared-PK update root (PGlite atomic batch) > update publishes the target's post-update key before descendant writes
    => NestedWriteError: Cannot update relation 'chits': target record was not found for this parent.
- Package E shared-PK update root (PGlite transaction) > a partial compound shared edge publishes every transitioned member
    => ForeignKeyError: Foreign key constraint violation
- Package E shared-PK update root (PGlite transaction) > fresh create publishes the complete selected compound tuple
    => UnsupportedOperationError: query-engine-v2 create cannot resolve the parent id for relation 'tokens': referenced field 'accountCode' is neither this record's primary key nor a knowable value in its ow
- Package E shared-PK update root (PGlite transaction) > update publishes a nested relation-folded non-primary referenced field
    => FAIL  |extended-local| tests/contracts/engine/write/shared-pk-update-root.test.ts > Package E shared-PK update root (PGlite atomic batch) > update publishes a nested relation-folded non-primary refere
- Package E shared-PK update root (PGlite transaction) > update publishes the target's post-update key before descendant writes
    => NestedWriteError: Cannot update relation 'chits': target record was not found for this parent.
- Package E shared-PK update root (PGlite transaction) > upsert FOUND publishes a relation-folded non-primary referenced field
    => TypeError: UPDATE RETURNING did not produce the required record
- Package E shared-PK update root (PGlite transaction) > upsert FOUND publishes the target's post-update referenced key
    => FAIL  |extended-local| tests/contracts/engine/write/shared-pk-update-root.test.ts > Package E shared-PK update root (PGlite transaction) > upsert FOUND publishes a relation-folded non-primary referenc
- Package E shared-PK update root (better-sqlite3) > a partial compound shared edge publishes every transitioned member
    => ForeignKeyError: Foreign key constraint violation
- Package E shared-PK update root (better-sqlite3) > fresh create publishes the complete selected compound tuple
    => UnsupportedOperationError: query-engine-v2 create cannot resolve the parent id for relation 'tokens': referenced field 'accountCode' is neither this record's primary key nor a knowable value in its ow
- Package E shared-PK update root (better-sqlite3) > update publishes a nested relation-folded non-primary referenced field
    => AssertionError: expected undefined to deeply equal { accountProviderId: 'p2' }
- Package E shared-PK update root (better-sqlite3) > update publishes the target's post-update key before descendant writes
    => NestedWriteError: Cannot update relation 'chits': target record was not found for this parent.
- Package E shared-PK update root (better-sqlite3) > upsert FOUND publishes a relation-folded non-primary referenced field
    => TypeError: UPDATE RETURNING did not produce the required record
- Package E shared-PK update root (better-sqlite3) > upsert FOUND publishes the target's post-update referenced key
    => FAIL  |extended-local| tests/contracts/engine/write/shared-pk-update-root.test.ts > Package E shared-PK update root (better-sqlite3) > upsert FOUND publishes a relation-folded non-primary referenced f

## tests/contracts/engine/write/supplier-continuation.test.ts (3)
- E4 — supplier continuation keeps the write-side membership premise > a reused non-PK reference cannot redirect the continuation
    => AssertionError: promise resolved "{ id: 'p1', code: 'C' }" instead of rejecting
- E4 — the composed continuation on ordered committed segments > carries the parent and captured-target guards into every later segment
    => AssertionError: expected false to be true // Object.is equality
- E4 — the composed continuation on ordered committed segments > routes the composition's placement through the pre-effect capacity refusal
    => AssertionError: expected 'Driver \'pglite\' cannot execute this…' to match /cannot execute this record series as …/

## tests/contracts/public-client/batch-transaction.test.ts (3)
- $transaction with array (batch mode) > batch-only driver batches nested write operations atomically
    => TransactionError: Driver "pglite" does not support callback transactions and this transaction contains operations that cannot be batched atomically.
- $transaction with array (batch mode) > batch-only shared parsing keeps exact partitions with insert ids
    => TransactionError: Driver "pglite" does not support callback transactions and this transaction contains operations that cannot be batched atomically.
- $transaction([...]) guard attribution after rollback > batch-only: a premise the rollback does NOT restore is still attributed to its own guard
    => AssertionError: expected TransactionError: Driver "pglite" does no… { …(4) } to match object { name: 'NestedWriteError', …(1) }

## tests/contracts/public-client/operations.test.ts (1)
- Update Operations > updateMany > refuses a child-held connect across more than one matched row
    => TypeError: Cannot read properties of undefined (reading 'message')

## tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts (1)
- collects the frozen CS-02 structural work matrix
    => AssertionError: Expected values to be strictly deep-equal:

## tests/unit/instrumentation/namespace-attribute-segment.test.ts (1)
- progressive segment spans carry no database namespace
    => AssertionError: expected 0 to be greater than 0
