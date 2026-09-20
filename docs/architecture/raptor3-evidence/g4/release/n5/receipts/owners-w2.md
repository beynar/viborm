# N5 wave 1 — the class-C owners, as the four groups reported them (verbatim)


## From w1:skip


### src/query-engine/raptor3/commands/execution.ts:adoptSuppressed (line 694, called from `series` at :666)

**Mechanism.** ONE owner, three losses, all from the same guard. `adoptSuppressed` returns early unless every field of `schema.keys(model)` is a literal, then unconditionally replays the member's `link`/`remove`/`junction` children. That guard answers 'did this member spell its own row key' and is used as if it answered 'does a row exist at that key' — and it knows nothing about whether the member is relation-bearing or about naming a row by a declared unique. The retired router it replaced, `routeJunctionCreateManyRow` (git `e8114ed9d^:src/query-engine/write-engine/junction-create-many-routing.ts`), decided a four-way disposition per row: (a) row key spelled -> LEAF with `joinWhenTargetExists`, i.e. the membership INSERT is CONDITIONAL on the target row existing; (b) `relationBearing || suppress` -> SERIES, where a skipped root strands the whole member, join included — checked BEFORE the leaf route, so a relation-bearing row never joins; (c) generated row key + exactly one spelled declared unique + no unnameable unique index -> ADOPT, i.e. no INSERT at all, the row is looked up by that selector and the membership written against it; (d) an unnameable raw/partial unique index dominates and suppresses everything. Raptor 3 kept only a degenerate (a) with the condition dropped, which is why a suppressed-but-never-inserted row gets a junction write (ForeignKeyError 23503, 4 cells), a relation-bearing duplicate keeps its join (1 cell), and the adopt route is gone (1 cell). AGENTS.md:1239-1256 states (a) and (b)'s subtree rule correctly but claims parity with the shipped engine ('which is what the shipped engine did'), which the two routes it cites falsify for a relation-bearing member; the doc comment at execution.ts:674-693 repeats the claim. Fixing this is route selection, not a policy boolean.

**Cells.**
- compound-junction.test.ts > compound many-to-many (transaction) > skipDuplicates links only the exact complete target key
- compound-junction.test.ts > compound-key member uniqueness (transaction) > one independently unique key member cannot link a different tuple
- junction-create-many-routing.test.ts > residual F1 — junction skip disposition is row-local and ordered > a spelled scalar key links only when that exact target exists
- junction-create-many-routing.test.ts > residual F1 — junction skip disposition is row-local and ordered > a relation-bearing spelled duplicate suppresses its subtree and join
- junction-create-many-routing.test.ts > residual F1 — junction skip disposition is row-local and ordered > a scalar adopter plans after a relation-bearing adopter creates its target
- junction-create-many-routing.test.ts > residual F1 — unnameable indexes dominate an adoptable selector > a spelled key does not link when only a raw unique index conflicts
- polymorphic-collection-write-family.test.ts > polymorphic collection write family (transaction) > createMany skipDuplicates joins a later same-key row after an alternate conflict

**Pin shape.** A pin for the repaired owner must separate the three facts the one guard currently conflates. (i) EXISTENCE, not spelling: a `createMany skipDuplicates` member that spells its complete row key but is suppressed by a DIFFERENT unique constraint (a declared one, as in compound-junction's `isbn`/`tenantId` and junction-routing's `slug`, or an unnameable raw index, as in `f1i_entries_token_uq`) writes NO membership and raises no provider error, while a member whose spelled key really does name an existing row still writes its membership against that row, idempotently — the natural spelling is the retired `joinWhenTargetExists`: emit the membership INSERT with the target row's existence as its own predicate, so no observation is needed and the batch route is unaffected. (ii) RELATION-BEARING: a suppressed member that carries its own nested writes strands the whole member, join included (measured today: members [{id:1},{id:2}] where V1 gave [{id:2}]; its `details.create` ghost is already correctly suppressed, so ONLY the junction row is at issue). (iii) ADOPT: a member with an omitted generated row key, on a model with no unnameable unique index, spelling exactly ONE declared unique, is not an INSERT — it names the existing row by that selector and writes the membership against it, including when that row was created earlier in the same operation by a sibling member's nested child. Any repair of (iii) must keep the three NEGATIVES that pass today only because the adopt route is absent: 'a raw unique index prevents an unsafe adopt route', 'an adoptable row and a relation-bearing unnameable row keep their own meanings' (two spelled uniques -> suppress, not adopt) and 'a later adopter plans after an earlier suppressible series row'. All seven cells and those three controls live in the three files above and run on PGlite via `run-shared-family-cwd.mjs`.


### src/query-engine/raptor3/shared/operation-context.ts:link (the `captured` branch's non-batch arm, the `rowCount !== 1` throw)

**Mechanism.** `link()` vacates a captured singular-junction slot with a DELETE and, on the direct-dispatch arm only, throws a raceable TransactionError when `rowCount !== 1`. Two `connect` entries that resolve to the SAME target tuple carry the SAME captured owner, so the second one re-deletes a row this operation itself already removed and reports 'Concurrent membership change … the captured owner's membership was already removed; retry to converge' in a single-threaded test. The batch arm only `queue()`s the delete and asserts nothing, which is exactly why the atomicBatch leg of the same cell is green — the two routes do not agree on one end state, which the file's own preamble says is the thing it exists to prove. Either the duplicate entries must share ONE slot transition (the cell's own comment: 'both planning captures see left, but only one may vacate it before right is inserted'), or the vacate must not read this operation's OWN earlier delete as a concurrent change. D-32's one-shot re-plan is not the answer here: there is no race to converge on.

**Cells.**
- polymorphic-collection-write-family.test.ts > polymorphic collection write family (transaction) > SINGULAR member: exact reconnect is idempotent, an occupied slot TRANSFERS

**Pin shape.** A pin must run the SAME six-step sequence on both substrates and require the same end state at every step: connect left; exact reconnect left (idempotent, the row survives); TWO entries naming the same target connecting to right (one transfer, bookMembers ['t1/right/eu/111']); two syntactically different selectors resolving to the same compound key; two book entries separated by a video entry across junction leaves; and a `set` whose refill contains the same target twice. Step 3 is the one that fails today, at the duplicate-entry vacate. The pin should also assert the vacate DELETE is emitted ONCE (or that a second vacate is a no-op), since an end-state-only pin would go green for an implementation that simply stopped asserting rowCount — which would silently drop the genuine concurrent-removal detection this arm exists for.


### NO OWNER in src/query-engine/raptor3/ — the retired guard was src/query-engine/relation-key-legality.ts:145/:149 (git e8114ed9d^); `grep -rn 'updateMany matched' src/` returns nothing today

**Mechanism.** A multi-row `updateMany` (root or nested) whose data carries a member of a SINGULAR relation is not executable: the member's slot can belong to only one matched row, so applied in sequence the last row takes it from the others. V1 refused before any write with 'updateMany matched N rows, so it cannot apply '<verb>' to relation '<rel>': that target's member-junction slot can belong to only one of them — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call.' (junction-held arm, :145) and the same sentence with 'that membership is stored on the target row' (reference-held arm, :149). Raptor 3 registers neither. MEASURED consequence: the operation resolves {count: 2}, writes the scalar data to BOTH rows, and lands the membership on whichever row ran last — the exact damage the sentence named. This is a cardinality fact D-52 explicitly keeps ('a refusal is kept where it names an execution fact (existence, membership, concurrency, cardinality …) that no owner can execute around'), so its absence is a loss, not D-52's 'fewer refusals'. Both modes fail identically, so the owner is the admission/analysis pass, not a transport.

**Cells.**
- polymorphic-collection-write-family.test.ts > singular collection inverse (transaction) > root updateMany refuses one singular member across two owners before writing
- polymorphic-collection-write-family.test.ts > singular collection inverse (transaction) > nested updateMany refuses one singular member across two owners before writing
- polymorphic-collection-write-family.test.ts > singular collection inverse (transaction) > non-empty set and connectOrCreate reach the same root membership guard
- polymorphic-collection-write-family.test.ts > singular collection inverse (atomicBatch) > root updateMany refuses one singular member across two owners before writing
- polymorphic-collection-write-family.test.ts > singular collection inverse (atomicBatch) > nested updateMany refuses one singular member across two owners before writing
- polymorphic-collection-write-family.test.ts > singular collection inverse (atomicBatch) > non-empty set and connectOrCreate reach the same root membership guard

**Pin shape.** ONE registration, reached from four directions, each asserting the sentence AND that nothing was written (both scalar columns unchanged and no membership row): a ROOT `updateMany` matching 2 rows with `items.connect` of a singular-inverse target; the SAME shape as a NESTED `shelves.updateMany` under `warehouse.update`; the same with `set`; the same with `connectOrCreate` (which must also create nothing). Both substrates must give the identical answer. The positive controls beside them must stay green: `updateMany` matching ONE row with the singular member succeeds, a PLURAL-inverse member across 2 rows succeeds with {count: 2}, and empty `connect: []`/`connectOrCreate: []`/`set: []` across 2 rows succeed. IMPORTANT — this owner also closes the gate's separate legality-and-client cell `tests/contracts/public-client/operations.test.ts > Update Operations > updateMany > refuses a child-held connect across more than one matched row`, which is the reference-held arm (:149) of the same V1 guard; wave 2 should treat the two as ONE unit, not two, and the repaired sentence must carry both wordings (member-junction slot vs. membership stored on the target row).


## From w1:legality


### src/query-engine/raptor3/shared/operation-context.ts:submit (the un-indexed attribution ladder, the re-probe loop at :1258-1272, the read at :1266)

**Mechanism.** When a batch aborts at a premise and the provider reports no statement index, the ladder re-probes each registered assertion OUTSIDE the batch with `await this.read(assertion.query, true)`. That read is unguarded, and a premise built from an ordered observation names the batch reference scratch (`SELECT "ref_value" FROM "__viborm_batch_refs" …`), which died with the rolled-back batch transaction: the re-probe raises 42P01, escapes `submit`, and the driver maps it to QueryError V2001 "Query execution failed" — replacing the NestedWriteError the ladder was about to attribute. The guide already states the intended answer one paragraph later ("a premise stated BEHIND the unit's own writes … is not re-probable after the rollback; when every premise ahead of the writes holds now and exactly one stands behind them, the ladder attributes that one") and the code for it is right there at :1280-1294 — the loop simply throws before reaching it.

**Cells.**
- relation-key-update-legality-occupied-to-one.test.ts > reports not-found for an empty setNull child-held UPDATE under a PK transition

**Pin shape.** A batch-only PGlite cell whose operation transitions the root's own key and carries a child-held nested `update` on an EMPTY slot (`setNullParent.update({where:{id:1}, data:{id:{increment:1}, child:{update:{label:'x'}}}})` with no child seeded) must answer, on the batch route as on the live route, NestedWriteError "Cannot update relation 'child': target record was not found for this parent." — never QueryError. Assert the error CLASS and message on both arms (the existing `expectParity` already does), and add a recording-driver pin that the ladder issues no re-probe of a premise whose SQL names `__viborm_batch_refs`. Shared with the rest of the estate's "typed errors lost to QueryError" set (N5 plan §5, six cells); I measured only my own, so the sharing is inferred from the plan, not from a run.


### src/query-engine/raptor3/commands/relation-body.ts:relation (the membership-parent choice at :536-541)

**Mechanism.** `parent: verb === "update" && edge.kind !== "junction" ? parent.fields : parent.located!.fields` — the post-write assignments are named for the nested `update` verb ALONE. Every other verb on a child-held edge, `upsert` included, correlates on the parent's PRE-transition located key. Under a root key transition with `onUpdate('cascade')` the provider has already moved the child's foreign key by the time the after-placed lookup runs, so the upsert's locate finds nothing: the live route falls to the CREATE arm and collides on the child's unique FK (UniqueConstraintError), the batch route answers NotFoundError. N1 case 3 and N3c §3 state the rule the code does not yet apply to every verb: the membership names the parent's key as it is at the lookup's own execution point.

**Cells.**
- relation-key-update-legality-transition-arm.test.ts > allows primary-key arithmetic transition with cascade upsert

**Pin shape.** `cascadeParent.update({where:{id:1}, data:{id:{increment:1}, child:{upsert:{create:{id:2,label:'Created'}, update:{label:'Updated'}}}}})` over a seeded child `{id:1,label:'Child',parentId:1}` must SUCCEED on both routes with `parents:[{id:2,name:'Parent'}]`, `children:[{id:1,label:'Updated',parentId:2}]` — i.e. the upsert takes its UPDATE arm because its membership correlates on parentId = 2. N3c's review blocked the naive value swap (naming the located key breaks the live route for a cascade edge), so the repair must distinguish placement, not verb: a lookup placed AFTER the parent's write names the post-write key whatever its verb. The two pins kept under `g4/release/n3c/pins/` are this unit's, once given a live-route cell that reaches the lookup.


### src/query-engine/raptor3/shared/operation-context.ts:executeMember (the unconditional `await this.flush(undefined, member)` at :444)

**Mechanism.** Every member of a record series flushes, and on a batch-only transport a flush is a committed segment. A nested `createMany` whose rows carry only literals needs no observation between members, yet it is dispatched as one batch per member: [INSERT user, INSERT post#1] commits, then [INSERT post#2] raises 23505. The first segment is durable, so the batch route's end state keeps the parent and the first child while the live route (one transaction) rolls everything back. D-51 allows a succession of segments as PACKAGING but requires that the two routes "keep one result", and the conformance harness makes that its load-bearing oracle (fixtures.ts:149).

**Cells.**
- nested-write-conformance-fk.test.ts > createMany duplicate PK rolls back parent and prior children

**Pin shape.** On a batch-only recording driver, `user.create({data:{id:'u1', name:'Kate', posts:{createMany:{data:[{id:'dup',…},{id:'dup',…}]}}}})` must dispatch ONE native batch (one `executeBatch` call, `committedSegments === 0` on the failure) and leave both tables empty after the duplicate-PK rejection, matching the interactive route byte for byte. The repair must make the member boundary conditional on a real need — an ordered observation, a produced identity a later member consumes, or an owned member-rollback region — rather than unconditional; a pin that a member series WITH such a need still segments (and reports `committedSegments`) keeps the D-51 packaging honest.


### src/query-engine/raptor3/commands/execution.ts:captureSeries (:803-940)

**Mechanism.** A relation-bearing root `updateMany` becomes a `SelectedSeries` (commands.ts:1833-1846) whose captured rows `captureSeries` turns into one member per row. Nothing anywhere counts the captured roots against a child-held relation part, so `data: { posts: { connect: [...] } }` across two matched roots is executed member by member and the last root silently takes the post from the first. The retired engine refused this before the first write, naming the observed count (`docs/architecture/retired/write-engine-ATOM.md:1053-1063`); a full grep of `src/` finds no surviving equivalent, and D-52 keeps a refusal that names exactly this kind of cardinality/membership fact.

**Cells.**
- public-client/operations.test.ts > Update Operations > updateMany > refuses a child-held connect across more than one matched row

**Pin shape.** `user.updateMany({where:{age:{gte:25}}, data:{posts:{connect:[{id:'post-1'}]}}})` with a `where` matching 2 users must reject BEFORE the first write, with a message naming the observed count, the verb and the relation ("updateMany matched 2 rows", "'connect'", "'posts'"), and `post-1.authorId` must still be 'user-1'. `captureSeries` is the one place that holds both the captured row count and the member commands, so the refusal belongs there, applied to the child-held membership verbs the retired contract names (`connect`, `connectOrCreate`, `set`) and to no other. A companion cell must keep the single-root case green (`operations.test.ts` already has "applies relation-only data, with no scalar column written").


### src/query-engine/raptor3/commands/commands.ts:assignMembership (:471; the `producer.known(referenced)` test at :479, the rejection at :491-495)

**Mechanism.** When the enclosing `badge → account` edge is assigned, it asks whether the account's referenced field `providerId` is known. The account's own `provider: {connect:{id:'provider'}}` supplies that literal, but it has not contributed to the account's `Assignments` yet, so `known` is undefined, `providerId` is not auto-generated, and the edge rejects with the UnsupportedOperationError. The value is a construction-time literal, so under D-52 there is nothing here a refusal can name — it is an ordering gap in the known-value propagation, not an execution fact.

**Cells.**
- generated-output-fallback.test.ts > generated output exact batch scratch > a nested generated key and relation-supplied publication stay in one native batch

**Pin shape.** On `BatchOnlyNonReturningSQLiteDriver`, `badge.create({data:{id:'badge', account:{create:{provider:{connect:{id:'provider'}}}}}, select:{id:true, accountProviderId:true}})` must resolve to `{id:'badge', accountProviderId:'provider'}` in ONE native batch (`driver.batchCalls === 1`) with `account.findMany()` = `[{id:1, providerId:'provider'}]` — i.e. a nested connect on the SAME create counts as a knowable value for a sibling edge that references the connected column. The refusal must still fire for the genuinely unknowable case (a referenced non-key column neither generated nor supplied), so the repair needs the negative cell beside it.


### src/query-engine/raptor3/commands/execution.ts:adoptSuppressed (:694-708)

**Mechanism.** A skipped INSERT is not a skipped membership — the method's own doc says so — but its first loop bails unless every primary-key field of the suppressed member is a spelled LITERAL. On a junction target whose key is generated (`stamp.id = s.int().id().increment()`) a member identified by its nameable unique (`name: 'sitting'`) therefore names "nothing" and writes no join row, even though E6.8's adopt-equivalence says that exact row rewrites as the connectOrCreate adopt. "Own key spelled" is being read as "row exists".

**Cells.**
- junction-produced-identity.test.ts > E4-U3 junction produced identity (transaction) > skipDuplicates with a produced key ADOPTS instead of refusing (E4-U3 × E6.8)

**Pin shape.** With a seeded `stamp {id:-1, name:'sitting'}`, `post.create({data:{id:'p6', title:'t', stamps:{createMany:{data:[{name:'sitting'},{name:'arriving'}], skipDuplicates:true}}}})` on the interactive route must link BOTH stamps to p6: `stamp.findMany({where:{posts:{some:{id:'p6'}}}, orderBy:{name:'asc'}}).map(r => r.id)` === `[fresh.id, -1]`, with `fresh.id !== -1` and exactly one new stamp row. The rule to pin at the owner: a suppressed member whose row key is generated but which spells a complete single nameable unique names the existing row THROUGH that unique, and only its membership (never a nested record write) is written against it.


### tests/contracts/engine/write/junction-produced-identity-behavior.ts (the last test of `registerProducedIdentityBehavior`, lines 313-351) — TEST-SIDE, not src; reported instead of applied because the file is not in my prompt's list

**Mechanism.** The B-ruled atomic-batch cell shares its body with the interactive (class-C) cell, so the G3P-04 re-expression needs a branch on the `name` parameter the function already receives. Proposed hunk, after `const operation = client.post.create({...})` and before `await operation;`:

      if (name === "atomic batch") {
        // G3P-04: root-conflict suppression is admitted only where the
        // operation owns the member rollback region, and the batch route owns
        // none (`AGENTS.md`, "G3P-04 admits root-conflict suppression only
        // when the operation owns the member rollback region"); the refusal
        // fires in the command analysis pass, before the enclosing root can
        // write. The adopt shape this cell pins is measured on the
        // interactive leg.
        await expect(operation).rejects.toMatchObject({
          name: "TransactionError",
          message:
            "Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.",
        });
        expect(await client.post.findMany()).toEqual([]);
        expect(
          (await client.stamp.findMany()).map((row: any) => row.id)
        ).toEqual([existing.id]);
        return;
      }

The rejection and its verbatim message are MEASURED. The two "writes nothing" assertions are DERIVED from AGENTS.md:591-606 ("refused before member effects", "It fires before the enclosing root can write") and match the house style a sibling N5 agent used for the same refusal in `create-many-skip-depth.test.ts`; they should be measured once before the hunk is kept. The Docker legs are unaffected (their `name` values are "Docker MySQL" / "Docker PostgreSQL", and both run transaction-capable drivers).

**Cells.**
- junction-produced-identity.test.ts > E4-U3 junction produced identity (atomic batch) > skipDuplicates with a produced key ADOPTS instead of refusing (E4-U3 × E6.8)

**Pin shape.** After the hunk the atomic-batch leg pins the registered G3P-04 refusal verbatim plus the untouched seed; the interactive leg stays red on the class-C adopt shape above until `adoptSuppressed` is repaired. Expected file result then: 1 failed | 11 passed (12).


## From w1:misc


### src/query-engine/raptor3/shared/operation-context.ts:1130 OperationContext.submit() (guards construction :1138-1148), with the continuation declaration at :2542

**Mechanism.** A generated-output continuation re-pins ONLY the created record's own identity: `guards` is built purely from `continuationList`, and nothing in submit() builds a premise re-pinning the PARENT row whose referenced value the continuation's membership correlates BY VALUE. On a batch-only driver with supportsOrderedCommittedSegments=true the supplier's INSERT commits in its own segment, so the later segment trusts a parent it never re-read — and a parent whose non-PK reference another row took over is invisible.

**Cells.**
- supplier-continuation.test.ts > E4 — the composed continuation on ordered committed segments > carries the parent and captured-target guards into every later segment
- supplier-continuation.test.ts > E4 — supplier continuation keeps the write-side membership premise > a reused non-PK reference cannot redirect the continuation

**Pin shape.** The mechanism already exists one level away and should not be duplicated: CommandExecution.captureSeries (src/query-engine/raptor3/commands/execution.ts:803-844) builds `parentRequirement` = select(parent.model, where: identity(parent) ∧ membershipValues(edge, parent), select: parent keys) with the failure `Cannot <verb> relation '<edge>': parent record changed across a committed segment.` (execution.ts:818) and asserts it with ctx.requirePresent at execution.ts:880 — at the position where the captured set is fixed, as the batch's FIRST statement. AGENTS.md:1203-1217 already states this invariant in the present tense. The repair declares the same premise beside a continuation whose membership names a parent, at one owner, with no policy boolean and no second reader. Then cell 1 observes a SELECT naming "e7_stations" among the continuation batch's SELECTs, in a strictly later batch than the supplier's INSERT; and cell 3 observes rejects.toThrow(/parent record changed across a committed segment/) with the supplier's INSERT already durable, b-new.stationCode='C' via the cascade, b2.stationCode='A', and b-new.tag still 'fresh' (the continuation NOT applied).


### src/query-engine/raptor3/commands/relation-body.ts:227 RelationBody.relation(), the case "connect"/"connectOrCreate"/"upsert"/"update" block at :405-570 (membership at :533-551, lookup construction at :552)

**Mechanism.** A parent-held to-one `connect` addressed by a unique the foreign key does NOT reference is resolved by an out-of-band probe READ whose value is then spent as the foreign key, instead of by a lookup correlated inside the UPDATE. Three consequences, all measured: (a) a corrupted probe row moves the write; (b) no existence premise rides the write's own atomic unit, so a target deleted between planning and the batch surfaces as a raw 23503 ForeignKeyError instead of the arm's NestedWriteError; (c) there is no guard for a located target whose REFERENCED column is NULL, so a connect silently writes NULL — a disconnect — while the payload asked to connect. `grep -rn 'is null\.' src/query-engine/raptor3/{commands,shared}` returns nothing: the lookup twin of the create-side refusal at commands.ts:493 does not exist.

**Cells.**
- parent-held-lookup.test.ts > PGlite transaction parent-held to-one lookup (E1 U1/U2) > a located target whose referenced NULLABLE unique is NULL refuses, and writes nothing
- parent-held-lookup.test.ts > PGlite atomic batch parent-held to-one lookup (E1 U1/U2) > a located target whose referenced NULLABLE unique is NULL refuses, and writes nothing
- parent-held-lookup.test.ts > E1 U1 — the lookup fold's provenance > the written key comes from the LOOKUP, not from the probe row
- parent-held-lookup.test.ts > E1 U1 — the guard→UPDATE vanish window > a target deleted between planning and the batch aborts typed, writing nothing

**Pin shape.** After the repair the four cells pin, unchanged from their current text: book 2 ends at authorId 2 although the probe's id was corrupted to 1 (the value comes from the correlated lookup, not the probe); a target deleted between planning and the batch rejects with a NestedWriteError naming the relation, book 2 left at authorId null; and a connect resolving to a row whose referenced field is NULL refuses by name — the lookup-side sentence for the same fact commands.ts:493 already spells on the create side — with the sibling scalar rebind name:'renamed' in the same SET NOT written (holder 1 stays {name:'holder-1', badgeCode:null}). COUPLING: 'a probe row whose required referenced column reads NULL fails typed parsing' (owner below) is reached through the same probe; a repair that removes or stops spending the probe changes that cell's derived answer, so re-derive it against the repaired shape rather than pinning today's attribution.


### src/query-engine/raptor3/shared/operation-context.ts:514 OperationContext.failure() — the InvalidScalarResult → QueryEngineError mapping at :531

**Mechanism.** The malformed-scalar message is built from `this.operation` (the ENCLOSING operation) rather than from the statement whose decode failed, so a planning probe's typed-parse failure is attributed to the enclosing `update` instead of to the probe's own findMany. The estate already attributes a statement's MODEL correctly per compiled statement (driver-error-context.ts buildMeta) — the operation is the field that did not follow.

**Cells.**
- parent-held-lookup.test.ts > E1 U1 — the lookup fold's provenance > a probe row whose required referenced column reads NULL fails typed parsing

**Pin shape.** `Driver "pglite" returned a malformed int scalar for operation "findMany": a required scalar is null.` — the operation of the STATEMENT that produced the row, with book 2 left at authorId null. Re-derive alongside the relation-body repair above (same probe).


### src/query-engine/raptor3/commands/commands.ts:471 assignMembership — the `destination.contribute(field, producer.field(referenced), …)` conflict template at :500

**Mechanism.** A direct scalar FK rebind in the root SET composed with a nested arm on the SAME relation is judged a conflict between two final assignments instead of being correlated: the arm should locate and write against the FINAL (post-rebind) value, which is the plan's own principle (§0) — a consumer receives a value valid at ITS execution point, after its prerequisite effects. No ruling or registration names this composition as an accepted refusal.

**Cells.**
- parent-held-lookup.test.ts > PGlite transaction parent-held upsert arm relations (E1 U4) > a same-update FK rebind makes the arm correlate on the FINAL value
- parent-held-lookup.test.ts > PGlite atomic batch parent-held upsert arm relations (E1 U4) > a same-update FK rebind makes the arm correlate on the FINAL value

**Pin shape.** Unchanged from the cells' current text: book 1 resolves to {id:1, title:'book-1', authorId:2}; authors read [{id:1,…,name:'decoy'}, {id:2,…,name:'renamed'}] (the author moved AWAY from is untouched); awards read [{id:5, title:'medal', authorId:2}].


### src/query-engine/raptor3/commands/commands.ts:471 assignMembership (:498 `producer.field(referenced)`) together with src/query-engine/raptor3/commands/execution.ts:296 CommandExecution.run, case "record" (:335 `this.identity(command.located.fields)`)

**Mechanism.** THE SHARED-PRIMARY-KEY TRANSITION'S PUBLISHED KEY (the plan's §5 'six cells, one owner'). When the root of a shared-primary-key update has a before-child that MOVES that key — as a literal (account.update({id:'cascade'})), through an upsert's update arm, or through a relation-folded non-primary referenced field (provider.connect moving providerAccount.providerId) — the post-transition value is not published to the consumers that take their observation after it. Three symptoms, one cause: (1) the record's own `UPDATE … RETURNING` is addressed by `identity(command.located.fields)`, the PRE-transition captured key, although ON UPDATE CASCADE has already moved that row — zero rows matched, TypeError at operation-context.ts:2691 (stack-confirmed), or a terminal read returning `undefined`, which is exactly the create-root defect the file's docstring says this suite exists to catch; (2) a sibling child-held lookup correlates on the pre-transition key and answers 'target record was not found for this parent' (relation-body.ts:537-540 already reads parent.fields for verb 'update', so the value bound there is the problem, not the site); (3) a COMPOUND transition publishes only some of its members, so a descendant FK carries a stale column and the database raises a real 23503 / SQLITE_CONSTRAINT_FOREIGNKEY.

**Cells.**
- shared-pk-update-root.test.ts > (PGlite transaction | better-sqlite3) > upsert FOUND publishes the target's post-update referenced key
- shared-pk-update-root.test.ts > (PGlite transaction | PGlite atomic batch | better-sqlite3) > update publishes the target's post-update key before descendant writes
- shared-pk-update-root.test.ts > (PGlite transaction | PGlite atomic batch | better-sqlite3) > a partial compound shared edge publishes every transitioned member
- shared-pk-update-root.test.ts > (PGlite transaction | better-sqlite3) > upsert FOUND publishes a relation-folded non-primary referenced field
- shared-pk-update-root.test.ts > (PGlite transaction | PGlite atomic batch | better-sqlite3) > update publishes a nested relation-folded non-primary referenced field

**Pin shape.** One published fact, consumed everywhere: when a before-child transitions the key this record's row is identified by, the transition PUBLISHES the post-transition value into the record's own assignments, and every later consumer — the record's own UPDATE where-clause, a sibling child-held lookup's membership, a descendant create's foreign key — reads it from there. Every member of a compound key is published, not just the ones the payload spelled. The cells then pin, unchanged from their current text: the root returns {accountId:'cascade'} / {accountProviderId:'p2'} / {accountId:'i2', accountCode:'c2'}; the after-update chit and note are written at cardId='cascade'; the before-update chit reads {cardId:'cascade', body:'updated before transition'}; the partial token reads {cardCode:'c2'}; providerAccount reads {providerId:'p2'}. All 13 cells are one repair; no policy boolean and no second reader — the single owner is where the transitioned value is bound, not each consumer.


### src/query-engine/raptor3/commands/commands.ts:471 assignMembership — `producer.known(referenced)` at :481, refusal at :493

**Mechanism.** A compound-key member resolved by a `connect` is not seen as 'a knowable value in its own create data', so a fresh create that connects its parent by a compound unique and carries a nested child referencing the NON-primary member of that key is refused, although the value is fixed before the child's INSERT. The message is the current, kept sentence — it fires on a shape that should succeed, so this is the guard's reach, not its wording.

**Cells.**
- shared-pk-update-root.test.ts > (PGlite transaction | PGlite atomic batch | better-sqlite3) > fresh create publishes the complete selected compound tuple

**Pin shape.** `producer.known(referenced)` recognises a connect-resolved value as known. The three cells then pin: partialCard.create({ account: { connect: { id_code: {id:'i1', code:'c1'} } }, tokens: { create: { id:'fresh-token' } } }) resolves to {accountId:'i1', accountCode:'c1'} and the token reads {cardCode:'c1'}. Distinct from the transition owner above (a PLANNING knowability test, not an unpublished post-transition value) although the plan groups both under the shared-PK unit; keep them as two hunks with two falsifiers.


## From w1:plans


### scripts/credential-free-test-manifest.mjs (the extendedLocalExclusions set)

**Mechanism.** scripts/raptor3-manifest.mjs owns the runner-only fact (CS02_STRUCTURE_MEASUREMENT_COUNTS/-_TESTS at :315-319, spread into RAPTOR3_RUNNER_ONLY_TESTS at :1435) but the credential-free manifest never imports that list: it imports and excludes only the SIBLING CS02_REPEATED_OCCURRENCE_TESTS (line 9, spread at ~:161 in extendedLocalExclusions and ~:219 in RAPTOR3_FIXED_LOCAL_TESTS). EXTENDED_LOCAL_TESTS (:237) is a recursive walk of tests/ minus filename filters and extendedLocalExclusions, so cs02-structure-measure.test.ts falls through into extended-local and runs outside the patched qualified-reference checkout its frozen matrix requires. Confirmed necessary: the inventory's `reads` are bound only by SemanticInventoryBindings.claimRead, whose sole caller is a site in reference-instrumentation.patch.

**Cells.**
- tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts > collects the frozen CS-02 structural work matrix

**Pin shape.** Add CS02_STRUCTURE_MEASUREMENT_TESTS to the import from ./raptor3-manifest.mjs at line 9, and spread ...CS02_STRUCTURE_MEASUREMENT_TESTS into extendedLocalExclusions beside ...CS02_REPEATED_OCCURRENCE_TESTS (~line 161). Do NOT add it to RAPTOR3_FIXED_LOCAL_TESTS (~line 219): the fixed stage has no instrumentation patch either. The pin is a manifest self-test: a file in RAPTOR3_RUNNER_ONLY_TESTS must appear in neither EXTENDED_LOCAL_TESTS nor RAPTOR3_FIXED_LOCAL_TESTS — one list owns "runner-only", and the credential-free manifest consumes it rather than restating it.


### tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts:measureCreate (and the same omission in bindOverlapTree/measureOverlap)

**Mechanism.** bindCreateTree binds the ROOT's COMMAND but never the root's occurrence, write or unconditional activation; those objects exist only after commands.analyze(root). The frozen inventory requires them (inventory(caseId, paths) opens paths with "root" and the default activationIds is one attempt/0/unconditional, structural-recipes.ts:100-126), so every construction-only recipe fails its inventory assert with activationIds [] and the root's occurrence/write missing. VERIFIED: binding them right after analyze — bindOccurrence(bindings, recipe.caseId, "root", occurrence); bindUnconditional(bindings, recipe.caseId, occurrence) — makes all 12 depth/width-create cases pass (deferred events resolve after run() returns, so a binding taken there is in time for the patched build too).

**Cells.**
- tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts > collects the frozen CS-02 structural work matrix (cause 1 of 3)

**Pin shape.** Two lines in measureCreate after `assert.equal(occurrence.command, root)`, and the matching pair in measureOverlap after `built.commands.analyze(built.root)`. NOT applied here: any edit under tests/raptor3 changes captureRaptor3Identity()'s `harness` fingerprint (scripts/raptor3-manifest.mjs:928-934) and so invalidates the frozen CS-02 qualified-reference receipts. Needs the CS-02 owner's decision, together with a re-freeze.


### tests/raptor3/core-structure/measurement/structural-recipes.ts:overlapRecipe (oracle.outcome) + cs02-structure-measure.test.ts:measureOverlap

**Mechanism.** The width-overlap recipe's terminal outcome is the retired own-write dependency refusal — measureOverlap asserts `failure instanceof NestedWriteError` with meta.operation 'updateMany' and meta.conflictsWith 'upsert', and the recipe freezes oracle.outcome: "NestedWriteError". D-51 abolished that refusal by name. With it gone the hand-built tree EXECUTES, and because measureOverlap never migrates its `new Database(":memory:")` the first statement fails with a raw QueryError 'Query execution failed' (model 'pair', operation 'create') out of src/drivers/error-mapping.ts:384. NEW since N1 (e19b20759) and entirely hidden behind cause 1 above, which aborts earlier.

**Cells.**
- tests/raptor3/core-structure/measurement/cs02-structure-measure.test.ts > collects the frozen CS-02 structural work matrix (cause 2 of 3)

**Pin shape.** A decision, not a pin: what does width-overlap measure now that the overlap analysis ends in execution rather than in a refusal? Either the recipe migrates its schema and freezes an executed outcome, or it keeps a refusal by naming one D-52 preserved. Both halves live outside my file list (structural-recipes.ts holds oracle.outcome and feeds recipeSha256) and both change the frozen matrix's eventsSha256/counters, so this belongs to the CS-02 owner. Flagged for the N5 ledger: the gate triage recorded this file as a manifest-ownership D cell and never saw this cause.
