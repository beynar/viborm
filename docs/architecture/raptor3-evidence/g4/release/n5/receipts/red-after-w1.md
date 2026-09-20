# N5 — cells still red after wave 1 (per group, with class and owner)


## w1:skip

- [C] tests/contracts/engine/write/compound-junction.test.ts > compound many-to-many (transaction) > skipDuplicates links only the exact complete target key
    owner: src/query-engine/raptor3/commands/execution.ts:adoptSuppressed
    derived: AGENTS.md:1239-1247: 'A suppressed INSERT suppresses the ROW, not the membership… A skipDuplicates member whose target row ALREADY EXISTS still writes the membership it declared, against that existing row… A member whose key the provider would generate names no existing row and writes nothing.' Row 
    measured: ForeignKeyError (PG 23503) — the junction INSERT for the never-inserted key (missing, alternate) is replayed.

- [C] tests/contracts/engine/write/compound-junction.test.ts > compound-key member uniqueness (transaction) > one independently unique key member cannot link a different tuple
    owner: src/query-engine/raptor3/commands/execution.ts:adoptSuppressed
    derived: Same rule. The member spells the FRESH compound key (tenant, different) but conflicts on `tenantId`, declared independently unique and held by the existing (tenant, existing) row. No row exists at (tenant, different), so no membership may be written: catalog.entries === [] and the entry stays null.
    measured: ForeignKeyError (PG 23503). I read this fixture in full, so the triage's 'signature match only' caveat for this cell is now discharged: it is the same spelled-fresh-key / other-unique-conflict shape.

- [C] tests/contracts/engine/write/junction-create-many-routing.test.ts > residual F1 — junction skip disposition is row-local and ordered > a spelled scalar key links only when that exact targe
    owner: src/query-engine/raptor3/commands/execution.ts:adoptSuppressed
    derived: AGENTS.md:1239-1247 plus the shipped route it cites: V1's `routeJunctionCreateManyRow` (git `e8114ed9d^:src/query-engine/write-engine/junction-create-many-routing.ts`) gave a spelled-row-key member the LEAF route with `joinWhenTargetExists = true`, i.e. the membership INSERT is CONDITIONAL on the ta
    measured: ForeignKeyError (PG 23503) — the junction row for the never-inserted id 3 is replayed unconditionally.

- [C] tests/contracts/engine/write/junction-create-many-routing.test.ts > residual F1 — junction skip disposition is row-local and ordered > a relation-bearing spelled duplicate suppresses its s
    owner: src/query-engine/raptor3/commands/execution.ts:adoptSuppressed
    derived: V1's router (same file, `routeJunctionCreateManyParsedRow`) reads `if (relationBearing || disposition.kind === 'suppress') return { kind: 'series', … }` BEFORE any leaf/join route: a member carrying its own nested writes NEVER takes `joinWhenTargetExists`, and the guide itself says 'a skipped root i
    measured: members [{id:1},{id:2}]; details [{id:'landed', entryId:2}] (the ghost child IS correctly suppressed); entry 1 unchanged (EXISTING/existing). The only divergence is the junction row for the relation-b

- [C] tests/contracts/engine/write/junction-create-many-routing.test.ts > residual F1 — junction skip disposition is row-local and ordered > a scalar adopter plans after a relation-bearing adopt
    owner: src/query-engine/raptor3/commands/execution.ts:adoptSuppressed
    derived: V1's `junctionSkipDuplicatesDisposition` (same file): a member with an OMITTED generated row key, on a model with no unnameable unique index, that spells exactly ONE declared unique, is not an INSERT at all — it is `{kind:'adopt', where:{<that unique>}}`: the row is looked up by that selector and th
    measured: members [{slug:'A', label:'PARENT'}]. B DOES exist (id 2, slug B, label CHILD, parentId 1) — it is simply not adopted into the collection. (The triage's 'the nested child goes missing from the result 

- [C] tests/contracts/engine/write/junction-create-many-routing.test.ts > residual F1 — unnameable indexes dominate an adoptable selector > a spelled key does not link when only a raw unique ind
    owner: src/query-engine/raptor3/commands/execution.ts:adoptSuppressed
    derived: Same rule as the first cell of this file. {id:2, slug:'new-slug', token:'TAKEN'} spells a fresh row key but conflicts on the RAW unique index `f1i_entries_token_uq`; no row exists at id 2, so the conditional join writes nothing and entry 2 stays null.
    measured: ForeignKeyError (PG 23503).

- [C] tests/contracts/engine/write/polymorphic-collection-write-family.test.ts > polymorphic collection write family (transaction) > SINGULAR member: exact reconnect is idempotent, an occupied slot TRA
    owner: src/query-engine/raptor3/shared/operation-context.ts:link
    derived: Two `connect` entries naming the SAME target must coalesce to ONE slot transition (the cell's own comment: 'both planning captures see left, but only one may vacate it before right is inserted'). Nothing concurrent exists in this single-threaded test, so the second entry must emit no second vacate a
    measured: Fails at STEP 3 of 6 (`connectBook('right', true)` — the duplicated connect) with TransactionError: "Concurrent membership change on the singular polymorphic member of relation 'items.book': the captu

- [C] tests/contracts/engine/write/polymorphic-collection-write-family.test.ts > polymorphic collection write family (transaction) > createMany skipDuplicates joins a later same-key row after an altern
    owner: src/query-engine/raptor3/commands/execution.ts:adoptSuppressed
    derived: Row A1 {region:'eu', isbn:'999', title:'Book one'} SPELLS its complete row key (eu,999), which is fresh, and conflicts on the separate `title` unique held by (eu,111). No row exists at (eu,999) at that moment, so A1 must write no membership; the later A2 creates that key and its membership is the di
    measured: ForeignKeyError (PG 23503). I read the fixture, so the triage's 'signature match only' caveat for this cell is discharged: it is the same spelled-fresh-key / other-unique-conflict shape as the compoun

- [C] tests/contracts/engine/write/polymorphic-collection-write-family.test.ts > singular collection inverse (transaction) > root updateMany refuses one singular member across two owners before writing
    owner: src/query-engine/raptor3 — NO OWNER (retired src/query-engine/relation-key-legality.ts:145)
    derived: `book.shelf` is a SINGULAR inverse, so one book's member-junction slot can belong to exactly one shelf. An `updateMany` matching TWO shelves that connects the same book cannot be executed by any owner — applied in sequence the last row takes the slot from the first. D-52 keeps exactly this kind of r
    measured: Resolves with {count: 2}; BOTH shelf labels are overwritten to 'must not write' and the book ends up on RIGHT only — bookMembers ['t1/right/eu/111']. That is precisely the last-row-wins outcome the re

- [C] tests/contracts/engine/write/polymorphic-collection-write-family.test.ts > singular collection inverse (transaction) > nested updateMany refuses one singular member across two owners before writi
    owner: src/query-engine/raptor3 — NO OWNER (retired src/query-engine/relation-key-legality.ts:145)
    derived: Same cardinality fact reached through a NESTED `shelves.updateMany` under warehouse.update: the same refusal, before any write; both labels intact, no membership.
    measured: Resolves with the warehouse row; labels both 'must not write'; bookMembers ['t1/right/eu/111'].

- [C] tests/contracts/engine/write/polymorphic-collection-write-family.test.ts > singular collection inverse (transaction) > non-empty set and connectOrCreate reach the same root membership guard
    owner: src/query-engine/raptor3 — NO OWNER (retired src/query-engine/relation-key-legality.ts:145)
    derived: `set` and `connectOrCreate` carry the same singular member across the same two matched rows, so they must reach the SAME guard with the verb name substituted ('set', then 'connectOrCreate'), before any write: labels intact, no memberships, and no 'must not create' book.
    measured: Both resolve with {count: 2}; labels both 'must not write'; bookMembers ['t1/right/eu/111']; titles still ['Book one','Book two'].

- [C] tests/contracts/engine/write/polymorphic-collection-write-family.test.ts > singular collection inverse (atomicBatch) > root updateMany refuses one singular member across two owners before writing
    owner: src/query-engine/raptor3 — NO OWNER (retired src/query-engine/relation-key-legality.ts:145)
    derived: Identical to the transaction-mode cell — this is a payload-shape refusal decided in the command analysis pass, so it cannot be transport-dependent.
    measured: Identical: {count: 2}, both labels written, bookMembers ['t1/right/eu/111'].

- [C] tests/contracts/engine/write/polymorphic-collection-write-family.test.ts > singular collection inverse (atomicBatch) > nested updateMany refuses one singular member across two owners before writi
    owner: src/query-engine/raptor3 — NO OWNER (retired src/query-engine/relation-key-legality.ts:145)
    derived: Identical to its transaction-mode twin.
    measured: Identical: warehouse row resolves, both labels written, bookMembers ['t1/right/eu/111'].

- [C] tests/contracts/engine/write/polymorphic-collection-write-family.test.ts > singular collection inverse (atomicBatch) > non-empty set and connectOrCreate reach the same root membership guard
    owner: src/query-engine/raptor3 — NO OWNER (retired src/query-engine/relation-key-legality.ts:145)
    derived: Identical to its transaction-mode twin.
    measured: Identical: both resolve {count: 2}, labels written, bookMembers ['t1/right/eu/111'], titles unchanged.


## w1:legality

- [C] tests/contracts/engine/query/relation-key-update-legality-occupied-to-one.test.ts > relation-key update legality > reports not-found for an empty setNull child-held UPDATE under a PK transition
    owner: src/query-engine/raptor3/shared/operation-context.ts:submit
    derived: N1 rule 3 / AGENTS.md 'A dependent read is an ordered observation (N1, D-51)': the child-held `child: {update:{…}}` lookup is placed after the parent's own UPDATE; the slot is empty, so the required target is absent at its observation and BOTH routes must answer the registered correlated refusal Nes
    measured: live = NestedWriteError "Cannot update relation 'child': target record was not found for this parent." (correct); batch = QueryError "Query execution failed", V2001, meta.providerCode 42P01. Probe (dr

- [C] tests/contracts/engine/query/relation-key-update-legality-transition-arm.test.ts > relation-key update legality > allows primary-key arithmetic transition with cascade upsert
    owner: src/query-engine/raptor3/commands/relation-body.ts:relation
    derived: `cascadeParent.update({where:{id:1}, data:{ id:{increment:1}, child:{ upsert:{ create:{id:2,…}, update:{label:'Updated'} } } }})`. The child-held edge is an `after` child, so the parent's UPDATE runs first and the provider's cascade rewrites cascadeChild.parentId 1→2. N1 case 3 / N3c §3: the members
    measured: live = UniqueConstraintError "Unique constraint violation"; batch = NotFoundError "No cascadeChild record found for update". Both routes wrong, and they disagree with each other (`expect(batch.error).

- [C] tests/contracts/public-client/operations.test.ts > Update Operations > updateMany > refuses a child-held connect across more than one matched row
    owner: src/query-engine/raptor3/commands/execution.ts:captureSeries
    derived: `user.updateMany({ where:{age:{gte:25}}, data:{ posts:{ connect:[{id:'post-1'}] } } })` matches 2 users; `posts` is child-held (post.authorId), so one post row cannot be a member of two parents — applied in sequence the last root silently takes it from the first. D-52 keeps a refusal that names an e
    measured: The call RESOLVES. `captureThrown` returns undefined and the cell dies at `TypeError: Cannot read properties of undefined (reading 'message')` (operations.test.ts:791). No equivalent refusal exists an

- [C] tests/contracts/engine/query/nested-write-conformance-fk.test.ts > nested-write conformance: FK relations (tx vs batch) > createMany duplicate PK rolls back parent and prior children
    owner: src/query-engine/raptor3/shared/operation-context.ts:executeMember
    derived: `user.create({ data:{ id:'u1', name:'Kate', posts:{ createMany:{ data:[{id:'dup'},{id:'dup'}] } } } })`. Nothing in this payload is a dependent read — the root key is a literal and every child value is a literal — so the whole operation is ONE unit and rides one native batch. N1 rule 5: the duplicat
    measured: Both routes reject with the same UniqueConstraintError, but the states diverge at fixtures.ts:149: transaction = empty, batch = `users:[{id:'u1',name:'Kate'}] posts:[{id:'dup',title:'First',userId:'u1

- [C] tests/contracts/engine/write/generated-output-fallback.test.ts > generated output exact batch scratch > a nested generated key and relation-supplied publication stay in one native batch
    owner: src/query-engine/raptor3/commands/commands.ts:assignMembership
    derived: `badge.create({ data:{ id:'badge', account:{ create:{ provider:{ connect:{ id:'provider' } } } } }, select:{ id, accountProviderId } })`. `badge.accountProviderId` references the non-PK unique `account.providerId`, and that column is filled by the nested `provider: {connect:{id:'provider'}}` — a con
    measured: Rejects: UnsupportedOperationError (V8003) "query-engine-v2 create cannot resolve the parent id for relation 'account': referenced field 'providerId' is neither this record's primary key nor a knowabl

- [C] tests/contracts/engine/write/junction-produced-identity.test.ts > E4-U3 junction produced identity (transaction) > skipDuplicates with a produced key ADOPTS instead of refusing (E4-U3 × 
    owner: src/query-engine/raptor3/commands/execution.ts:adoptSuppressed
    derived: `post.create({ data:{ id:'p6', title:'t', stamps:{ createMany:{ data:[{name:'sitting'},{name:'arriving'}], skipDuplicates:true } } } })` against an existing stamp `{id:-1,name:'sitting'}`. E6.8's adopt-equivalence (`docs/architecture/expressible-shapes-plan.md`): a skip-eligible generated-key juncti
    measured: Resolves, but the join-row list is `[2]` — only the fresh 'arriving' stamp is linked; the adopted 'sitting' row produced no join row at all.

- [B-ruled] tests/contracts/engine/write/junction-produced-identity.test.ts > E4-U3 junction produced identity (atomic batch) > skipDuplicates with a produced key ADOPTS instead of refusing (E4-U3 ×
    owner: ?
    derived: G3P-04 (AGENTS.md:591): "G3P-04 admits root-conflict suppression only when the operation owns the member rollback region … A plain `borrowed-transaction` binding remains refused before member effects", and the guide adds "It fires before the enclosing root can write." The atomic-batch substrate has 
    measured: TransactionError: "Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region." (verbatim, matching the derivation).


## w1:misc

- [C] tests/contracts/engine/write/supplier-continuation.test.ts > E4 — the composed continuation on ordered committed segments > carries the parent and captured-target guards into every 
    owner: src/query-engine/raptor3/shared/operation-context.ts:1130 OperationContext.submit() (with the continuation declaration at :2542)
    derived: The supplier INSERT commits in its own segment on a driver with supportsOrderedCommittedSegments=true, so every later segment must re-establish BOTH premises it is trusting: the captured target's identity AND the parent row whose key the continuation's membership correlates by. The plan's principle 
    measured: AssertionError: expected false to be true // Object.is equality — at `expect(guards.some((guard) => guard.includes('"e7_stations"'))).toBe(true)`. No SELECT in the continuation batch names the parent 

- [C] tests/contracts/engine/write/supplier-continuation.test.ts > E4 — supplier continuation keeps the write-side membership premise > a reused non-PK reference cannot redirect the conti
    owner: src/query-engine/raptor3/shared/operation-context.ts:1130 OperationContext.submit() (with the continuation declaration at :2542)
    derived: Same mechanism as the cell above, observed as a REFUSAL instead of a statement. badge.stationCode references station.code (a non-PK unique). Between the supplier's committed INSERT and the continuation's re-verification, p1's code moves A→C and p2 claims the vacated A. AGENTS.md:1210-1217 states in 
    measured: AssertionError: promise resolved "{ id: 'p1', code: 'C' }" instead of rejecting. No refusal at all; the continuation ran against a parent it never re-read.

- [C] tests/contracts/engine/write/parent-held-lookup.test.ts (cell defined in parent-held-lookup-behavior.ts:284) > PGlite transaction parent-held to-one lookup (E1 U1/U2) > a located target whose referenced NULLABLE unique is NULL refu
    owner: src/query-engine/raptor3/commands/relation-body.ts:227 RelationBody.relation(), the connect/update/upsert/connectOrCreate case at :405-570 (lookup construction at :552) — grep confirms no `is null.` r
    derived: badge 1 matches `slug:'codeless'` but its `code` — the column holder.badgeCode references — is NULL. Writing the lookup's NULL would DISCONNECT the holder while the payload asked to connect it, i.e. a different verb. D-52 keeps a refusal that names an execution fact no owner can execute around; 'the
    measured: AssertionError: promise resolved "{ id: 1, name: 'renamed', …(1) }" instead of rejecting — the update succeeded, writing name='renamed' and badgeCode=null.

- [C] tests/contracts/engine/write/parent-held-lookup.test.ts (cell defined in parent-held-lookup-behavior.ts:284) > PGlite atomic batch parent-held to-one lookup (E1 U1/U2) > a located target whose referenced NULLABLE unique is NULL ref
    owner: src/query-engine/raptor3/commands/relation-body.ts:227 RelationBody.relation(), case connect (:405-570)
    derived: Identical to the transaction leg; the refusal is owned by the relation body, which answers before any substrate question, so both legs must agree.
    measured: AssertionError: promise resolved "{ id: 1, name: 'renamed', …(1) }" instead of rejecting.

- [C] tests/contracts/engine/write/parent-held-lookup.test.ts > E1 U1 — the lookup fold's provenance > the written key comes from the LOOKUP, not from the probe row
    owner: src/query-engine/raptor3/commands/relation-body.ts:227 RelationBody.relation(), the connect lookup construction at :552
    derived: The cell forbids one of two defensible designs by name: the probe answers EXISTENCE, and the value written into the foreign key is read by a lookup subquery inside the UPDATE itself, so a corrupted probe row cannot move the write. Derived: with the probe's `id` rewritten to 1, book 2 still ends at a
    measured: AssertionError: expected { id: 2, title: 'book-2', authorId: 1 } to deeply equal { id: 2, title: 'book-2', authorId: 2 } — the probe's value is spent as the foreign key.

- [C] tests/contracts/engine/write/parent-held-lookup.test.ts > E1 U1 — the lookup fold's provenance > a probe row whose required referenced column reads NULL fails typed parsing
    owner: src/query-engine/raptor3/shared/operation-context.ts:514 OperationContext.failure() — the InvalidScalarResult → QueryEngineError mapping at :531 builds the message from `this.operation` (the enclosing
    derived: The probe row crosses the complete typed result boundary before the relation compiler consumes it, so a required int corrupted to null stops THERE and the failure is attributed to the statement that produced the row — the probe's own findMany — the way driver-error-context.ts buildMeta already attri
    measured: AssertionError: expected [Function] to throw error including '… operation "findMany" …' but got 'Driver "pglite" returned a malformed int scalar for operation "update": a required scalar is null.' (on

- [C] tests/contracts/engine/write/parent-held-lookup.test.ts > E1 U1 — the guard→UPDATE vanish window > a target deleted between planning and the batch aborts typed, writing nothing
    owner: src/query-engine/raptor3/commands/relation-body.ts:227 RelationBody.relation(), case connect (:405-570) — no live re-verification premise is queued for a connect-by-non-referenced-unique between probe
    derived: A target deleted between the planning probe and the atomic write batch must be caught by the connect arm's own presence premise riding the unit that carries the write (D-29: a premise is proved inside the atomic unit that carries the write it protects). Derived: a NestedWriteError naming the relatio
    measured: AssertionError: expected error to be instance of NestedWriteError — received ForeignKeyError { code: 'V3002', meta: { constraint: 'e1_books_authorId_fkey', providerCode: '23503', model: 'book', operat

- [C] tests/contracts/engine/write/parent-held-lookup.test.ts (cell defined in parent-held-lookup-behavior.ts:787) > PGlite transaction parent-held upsert arm relations (E1 U4) > a same-update FK rebind makes the arm correlate on the FIN
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership — the `destination.contribute(field, producer.field(referenced), …)` conflict template at :500.
    derived: The same SET moves book 1 from author 1 to author 2 (`authorId: 2`) and carries a nested `author: { upsert }` on that relation. Correlating on the located (pre-rebind) value would rename the author the book is moving AWAY from — the wrong row. Under the plan's principle (a consumer receives a value 
    measured: AssertionError: promise rejected "UnsupportedOperationError" instead of resolving — "query-engine-v2 update has conflicting final assignments for column 'authorId' on relation 'author'." (code V8003)

- [C] tests/contracts/engine/write/parent-held-lookup.test.ts (cell defined in parent-held-lookup-behavior.ts:787) > PGlite atomic batch parent-held upsert arm relations (E1 U4) > a same-update FK rebind makes the arm correlate on the FI
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:500)
    derived: Identical to the transaction leg; the refusal is raised at planning, before any substrate question.
    measured: Same UnsupportedOperationError, atomic-batch substrate.

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:408) > Package E shared-PK update root (PGlite transaction) > upsert FOUND publishes the target's post-update referenced key
    owner: src/query-engine/raptor3/commands/execution.ts:296 CommandExecution.run, case "record" (:335) + src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:498)
    derived: card.accountId IS the card's primary key AND its foreign key to account.id, with onUpdate('cascade'). The upsert's update arm moves account.id a1→cascade as a BEFORE child, so the database cascade has already moved the card's own row key by the time the card's own UPDATE runs: that UPDATE must addre
    measured: TypeError: UPDATE RETURNING did not produce the required record — thrown at src/query-engine/raptor3/shared/operation-context.ts:2691 in OperationContext.update, called from CommandExecution.run at sr

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:408) > Package E shared-PK update root (better-sqlite3) > upsert FOUND publishes the target's post-update referenced key
    owner: src/query-engine/raptor3/commands/execution.ts:296 CommandExecution.run, case "record" (:335)
    derived: Identical derivation; substrate-independent (the key is published at planning/execution, not by the transport).
    measured: TypeError: UPDATE RETURNING did not produce the required record (same operation-context.ts:2691 site, SQLite3Driver stack).

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:441) > Package E shared-PK update root (PGlite transaction) > update publishes the target's post-update key before descendant w
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:498) — the transitioned value is not published into the enclosing record's `fields` at the point its consumers take their observati
    derived: account.update({id:'cascade'}) moves the shared key; the sibling `chits.update` must correlate on the POST-transition key (relation-body.ts:537-540 already uses parent.fields for verb 'update'), and `chits.create` must write cardId='cascade'. Derived: root returns {accountId:'cascade'}, after-update
    measured: NestedWriteError: Cannot update relation 'chits': target record was not found for this parent. — the membership still resolves to the pre-transition key a1.

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:441) > Package E shared-PK update root (PGlite atomic batch) > update publishes the target's post-update key before descendant 
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:498)
    derived: Identical derivation; the harness's tx/batch parity requires both legs to agree on the end state.
    measured: NestedWriteError: Cannot update relation 'chits': target record was not found for this parent.

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:441) > Package E shared-PK update root (better-sqlite3) > update publishes the target's post-update key before descendant write
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:498)
    derived: Identical derivation.
    measured: NestedWriteError: Cannot update relation 'chits': target record was not found for this parent.

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:503) > Package E shared-PK update root (PGlite transaction) > a partial compound shared edge publishes every transitioned membe
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:498) — per-member publication of a compound transition
    derived: partialCard(accountId, accountCode) references partialAccount(id, code) with onUpdate('cascade'); the account update moves BOTH members (i1,c1)→(i2,c2). Every transitioned member must be published, so the nested `tokens.create` (which references partialCard.accountCode) must write cardCode='c2' and 
    measured: ForeignKeyError: Foreign key constraint violation (23503) — the token INSERT carried a pre-transition member, so only SOME of the compound key's columns were published.

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:503) > Package E shared-PK update root (PGlite atomic batch) > a partial compound shared edge publishes every transitioned memb
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:498)
    derived: Identical derivation.
    measured: ForeignKeyError: Foreign key constraint violation (23503).

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:503) > Package E shared-PK update root (better-sqlite3) > a partial compound shared edge publishes every transitioned member
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:498)
    derived: Identical derivation.
    measured: ForeignKeyError: Foreign key constraint violation (SQLITE_CONSTRAINT_FOREIGNKEY).

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:531) > Package E shared-PK update root (PGlite transaction) > fresh create publishes the complete selected compound tuple
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership — `producer.known(referenced)` at :481, refusal at :493: a connect-resolved compound-key member is not seen as known.
    derived: partialCard.create CONNECTs its account by the compound unique id_code, so both members of the card's own shared key are resolved by that connect. A nested tokens.create referencing the non-primary member accountCode must therefore resolve: the connect-resolved value IS knowable — it is fixed before
    measured: UnsupportedOperationError: query-engine-v2 create cannot resolve the parent id for relation 'tokens': referenced field 'accountCode' is neither this record's primary key nor a knowable value in its ow

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:531) > Package E shared-PK update root (PGlite atomic batch) > fresh create publishes the complete selected compound tuple
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:481/:493)
    derived: Identical derivation; a planning refusal, substrate-independent.
    measured: Same UnsupportedOperationError.

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:531) > Package E shared-PK update root (better-sqlite3) > fresh create publishes the complete selected compound tuple
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:481/:493)
    derived: Identical derivation.
    measured: Same UnsupportedOperationError.

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:557) > Package E shared-PK update root (PGlite transaction) > upsert FOUND publishes a relation-folded non-primary referenced f
    owner: src/query-engine/raptor3/commands/execution.ts:296 CommandExecution.run, case "record" (:335) + commands.ts:471 assignMembership (:498)
    derived: providerBadge.accountProviderId is the badge's shared primary key and references providerAccount.providerId (a NON-primary unique) with onUpdate('cascade'). The upsert's update arm carries `provider: { connect: { email:'p2@provider' } }`, which folds providerAccount.providerId p1→p2. The badge's own
    measured: TypeError: UPDATE RETURNING did not produce the required record (operation-context.ts:2691) — the badge's own UPDATE still addressed the pre-transition key p1.

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:557) > Package E shared-PK update root (better-sqlite3) > upsert FOUND publishes a relation-folded non-primary referenced field
    owner: src/query-engine/raptor3/commands/execution.ts:296 CommandExecution.run, case "record" (:335)
    derived: Identical derivation.
    measured: TypeError: UPDATE RETURNING did not produce the required record (operation-context.ts:2691).

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:599) > Package E shared-PK update root (PGlite transaction) > update publishes a nested relation-folded non-primary referenced 
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:498) + execution.ts:296 run, case "record" (:335)
    derived: Same shape as the upsert variant but through a plain nested update arm: `account: { update: { provider: { connect: { email:'p2@provider' } } } }` folds providerId p1→p2 and the badge's shared key must follow. Derived: the root returns {accountProviderId:'p2'} and the account reads providerId='p2'.
    measured: AssertionError: expected undefined to deeply equal { accountProviderId: 'p2' } — the root resolved but its terminal read addressed a key no row holds and returned undefined. This is the file docstring

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:599) > Package E shared-PK update root (PGlite atomic batch) > update publishes a nested relation-folded non-primary referenced
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:498)
    derived: Identical derivation; tx/batch parity requires the same end state.
    measured: AssertionError: expected undefined to deeply equal { accountProviderId: 'p2' }.

- [C] tests/contracts/engine/write/shared-pk-update-root.test.ts (cells in shared-pk-update-root-behavior.ts:599) > Package E shared-PK update root (better-sqlite3) > update publishes a nested relation-folded non-primary referenced fiel
    owner: src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:498)
    derived: Identical derivation.
    measured: AssertionError: expected undefined to deeply equal { accountProviderId: 'p2' }.


## w1:plans

- [D] tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts > collects the frozen CS-02 structural work matrix
    owner: ?
    derived: The file is runner-only by the list that owns that fact (scripts/raptor3-manifest.mjs:315-319 CS02_STRUCTURE_MEASUREMENT_TESTS, spread into RAPTOR3_RUNNER_ONLY_TESTS at :1435). Its intended environment applies tests/raptor3/core-structure/measurement/reference-instrumentation.patch to src/. The froz
    measured: AssertionError: Expected values to be strictly deep-equal — and, with instrumented probes, THREE distinct causes behind the one cell, in order: (1) bindCreateTree/measureCreate never bind the ROOT's o
