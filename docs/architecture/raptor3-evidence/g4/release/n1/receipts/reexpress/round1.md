# Re-expression round1 — 8 groups (Opus, brief-reexpress.md)


## root-dependency — {'re-expressed': 9, 'unchanged': 14, 'pre-existing-red': 2, 'newly-green': 4, 'disagreement': 1}
final: Tests 3 failed | 27 passed (30) — verbatim from /private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/n1/rootdep/final-run.log (node .../run-shared-family.mjs tests/contracts/engine/query/nested-write-conformance-root-dependency.test.ts, RUN root /private/

- [re-expressed] after-parent self connectOrCreate observes the current insert (was: … cannot depend on the current insert)
  before: DESIGN §6.2's veto: expectReject + "depends on an earlier 'create' target write", nodes []
  derived: children is an after-parent relation, so the root INSERT (id 1) runs first and the connectOrCreate lookup {id:1} is an ordered observation taken after it (equally: an established producer, plan §1 case 2) — it finds the row that insert made and takes the connect arm: nodes [{id:1,label:'root',parent
  measured: executes; both substrates persist nodes [{id:1,label:'root',parentId:1}] (byte-identical)
- [unchanged] after-parent self connectOrCreate allows a disjoint numeric id
  before: allows; nodes [{1,root,null},{2,child,1}]
  derived: disjoint (plan §1 case 1): a capture-phase read, unchanged
  measured: green at base and under N1
- [pre-existing-red] before-parent self connect is unaffected by the future insert
  before: expectReject + "target record was not found", nodes []
  derived: the connect feeds parentId, which the root's own INSERT consumes, and its only producer IS that insert — the one shape no order satisfies (AGENTS.md, rule 4): it keeps the inherited sentence "Nested operation 'connect' on relation 'parent' depends on an earlier 'create' target write … Split these op
  measured: rejects with exactly that sentence, under N1 AND at the base commit (identical message in base-run.log) — still red for the same reason; its recorded expectation is NOT the dependency sentence N1 retires, so it is not mine to re-express
- [pre-existing-red] nested create keeps its before-parent decision ahead of its insert
  before: expectReject + "target record was not found", nodes []
  derived: same rule-4 shape one level down (the nested create's parentId is consumed by its own insert), so I derived the inherited dependency sentence
  measured: rejects earlier, with "query-engine-v2 create has conflicting final assignments for column 'parentId' on relation 'parent'." — the enclosing `children` edge and the nested `parent: connect` both assign parentId. Identical message at the base commit, so still red for the same reason; recorded expecta
- [re-expressed] missing top-level upsert observes its create-branch insert (was: … applies the create-branch insert barrier)
  before: DESIGN §6.2's veto: expectReject + "depends on an earlier 'create' target write", nodes []
  derived: empty table → the create branch runs; as an arm of a Choose it is not an established producer, so case 3: the after-parent lookup {id:1} is observed after the branch's insert and connects → nodes [{id:1,label:'root',parentId:1}]
  measured: executes; both substrates persist nodes [{id:1,label:'root',parentId:1}]
- [re-expressed] root id transition frees the old id for a later self decision (was: … rejects a later self decision on the old id)
  before: DESIGN §6.2's veto: expectReject + "depends on an earlier 'update' target write", nodes [{1,root,null}], links []
  derived: the root's own UPDATE (id 1→2) runs before the m2m links body; the connectOrCreate {id:1} observes after it, finds nothing (id 1 is free) and takes its create arm, then links it → nodes [{1,old,null},{2,root,null}], links [{sourceId:2,targetIds:[1]}]
  measured: executes; both substrates persist exactly that
- [re-expressed] root id transition is observed under its new id by a later self decision (was: … rejects a later self decision on the new id)
  before: DESIGN §6.2's veto: expectReject + "depends on an earlier 'update' target write", nodes [{1,root,null}], links []
  derived: the observation after the id transition finds the root under id 2, so connectOrCreate connects it to itself → nodes [{2,root,null}], links [{sourceId:2,targetIds:[2]}]
  measured: executes; both substrates persist exactly that
- [newly-green] root id transition allows a disjoint numeric self decision
  before: allows; nodes [{2,root,null},{3,target,null}], links [{sourceId:2,targetIds:[3]}] — RED at the base commit (the base engine rejected a disjoint decision)
  derived: disjoint integers: a capture-phase read, unchanged, executes as written
  measured: green under N1 with the recorded expectation untouched
- [unchanged] payload update does not block self connectOrCreate by id
  before: allows
  derived: disjoint: unchanged
  measured: green at base and under N1
- [unchanged] payload update does not block self upsert by id
  before: allows
  derived: disjoint: unchanged
  measured: green at base and under N1
- [newly-green] nested payload update does not taint a sibling target decision
  before: allows; nodes [{1,after,10},{10,parent,null}], links [{sourceId:10,targetIds:[1]}] — RED at the base commit
  derived: the sibling's label update cannot change the identity the links lookup names, so the lookup executes as written
  measured: green under N1 with the recorded expectation untouched
- [re-expressed] payload update is observed by a recursive m2m deleteMany filter (was: payload update conflicts with a recursive m2m deleteMany filter)
  before: DESIGN §6.2's veto: expectReject + "depends on an earlier 'update' target write", nodes [{1,before,null}], links [{sourceId:1,targetIds:[1]}]
  derived: the root's own UPDATE writes label='after' before the links body; the junction capture is dependent and moves behind it, so the filter {label:'after'} now matches node 1, which is a member of its own links — deleteMany deletes that row, i.e. the root itself → nodes [], links []
  measured: executes; both substrates persist nodes [], links []
- [re-expressed] nested to-many update frees its old selector inside the child (was: … rejects its old selector inside the child)
  before: DESIGN §6.2's veto: expectReject + "depends on an earlier 'update' target write", nodes [{1,child,10},{10,parent,null}], links []
  derived: the child's own UPDATE (id 1→2) runs before the child's links body; the connectOrCreate {id:1} observes after it, finds id 1 free and creates it, then links it from the child's new id → nodes [{1,old,null},{2,child,10},{10,parent,null}], links [{sourceId:2,targetIds:[1]}]
  measured: executes; both substrates persist exactly that
- [newly-green] nested to-many update allows a disjoint child decision
  before: allows; nodes [{2,child,10},{3,target,null},{10,parent,null}], links [{sourceId:2,targetIds:[3]}] — RED at the base commit
  derived: disjoint integers: executes as written
  measured: green under N1 with the recorded expectation untouched
- [re-expressed] nested to-one update executes its child identity transition: the foreign key answers (was: nested to-one update uses an unknown child select
  before: DESIGN §6.2's veto: expectReject + "depends on an earlier 'update' target write", state unchanged
  derived: the shape now executes: UPDATE node SET id=2 WHERE id=1 while the root (node 10) still holds parentId=1, assigned before it — no rule requires the engine to re-point an already-assigned parent-held FK, so the database's own integrity answer stands (rule 5): a foreign key violation, transaction rolle
  measured: rejects on both substrates with the same mapped error, message "Foreign key constraint violation"; state unchanged (nodes [{1,parent,null},{10,root,1}], links [])
- [newly-green] existing top-level upsert uses its exact pk for disjointness
  before: allows; nodes [{2,root,null},{3,target,null}], links [{sourceId:2,targetIds:[3]}] — RED at the base commit
  derived: disjoint: executes as written
  measured: green under N1 with the recorded expectation untouched
- [unchanged] create then overlapping update: the update's probe runs first
  before: rejects, "Cannot update relation 'items': target record was not found" (retargeted by N6-U3)
  derived: rule 3's correlated refusal, unaffected by N1
  measured: green at base and under N1
- [unchanged] create then disjoint numeric update is allowed
  before: allows
  derived: disjoint: unchanged
  measured: green at base and under N1
- [unchanged] connect then overlapping update: the update's probe runs first
  before: rejects, "Cannot update relation 'items': target record was not found"
  derived: rule 3, unaffected
  measured: green at base and under N1
- [unchanged] connect then overlapping upsert: the upsert's probe decides first
  before: rejects, "Cannot upsert relation 'items': target record was not found"
  derived: rule 3, unaffected
  measured: green at base and under N1
- [unchanged] disconnect then to-one upsert rejects
  before: rejects, "Unsupported to-one operation combination"
  derived: an admission refusal, not a dependency: unchanged
  measured: green at base and under N1
- [unchanged] delete then to-one upsert rejects
  before: rejects, "Unsupported to-one operation combination"
  derived: an admission refusal: unchanged
  measured: green at base and under N1
- [disagreement] delete then overlapping set rejects
  before: DESIGN §6.2's veto: expectReject + OWN_WRITE_ERROR ("depends on an earlier"), items [{1,before,1}]
  derived: canonical to-many order runs delete before set; the set's lookup for item 1 is observed after the delete, finds nothing, and is rule 3's correlated refusal "Cannot set relation 'items': target record was not found." on BOTH routes, nothing commits
  measured: tx substrate = V7001 "Cannot set relation 'items': target record was not found." (my derivation exactly); batch substrate = V7006 "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target or ownership check) did not hold." — the two substrates expose different error cont
- [re-expressed] overlapping update array applies both members in order (was: overlapping update array rejects)
  before: DESIGN §6.2's veto: expectReject + OWN_WRITE_ERROR, items [{1,before,1}]
  derived: the two members run as a record series; the second observes the first's write; both find item 1 as a member → items [{1,second,1}]
  measured: executes; both substrates persist owners [{1,Owner}], items [{1,second,1}], profiles []
- [unchanged] disjoint numeric update array is allowed
  before: allows
  derived: disjoint: unchanged
  measured: green at base and under N1
- [re-expressed] overlapping upsert array applies both members in order (was: overlapping upsert array rejects)
  before: DESIGN §6.2's veto: expectReject + OWN_WRITE_ERROR, items [{1,before,1}]
  derived: each upsert observes the previous write; both take the found arm → items [{1,second,1}]
  measured: executes; both substrates persist owners [{1,Owner}], items [{1,second,1}], profiles []
- [unchanged] disjoint numeric upsert array is allowed
  before: allows
  derived: disjoint: unchanged
  measured: green at base and under N1
- [unchanged] to-one update slot mutation then upsert rejects
  before: rejects, "Unsupported to-one operation combination"
  derived: an admission refusal: unchanged
  measured: green at base and under N1
- [unchanged] upsert then updateMany: the targeted arm runs before the sweep
  before: allows (retargeted by N6-U3); items [{1,changed,1}]
  derived: canonical order already dissolves it: unchanged
  measured: green at base and under N1
- [unchanged] upsert then deleteMany: the removal has the last word
  before: allows (retargeted by N6-U3); items []
  derived: canonical order: unchanged
  measured: green at base and under N1
- DISAGREEMENT: "nested-write conformance: own-write dependencies (tx vs batch) > delete then overlapping set rejects" — the two substrates expose DIFFERENT error contracts for the same payload. Reproduce: cd /private/tmp/viborm-n1; TMPDIR=/private/tmp/viborm-n1-root-dependency-tmp node /private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/run-shared-family.mjs tests/contracts/engine/query/nested-write-conformance-root-dependency.test.ts. Schema numericDependencySchema (owner 1—* item, child-held ownerId). Seed: owner {id:1,name:'Owner'}, item {id:1,label:'before',ownerId:1}. Act: owner.update({where:{id:1},data:{items:{delete:{id:1},set:[{id:1}]}}}). DERIVED (rules 1+3): canonical to-many order runs `delete` before `set`; the set's lookup for item 1 is an ordered observation taken after the delete, finds nothing, and is the correlated refusal the relation body registers — "Cannot set relation 'items': target record was not found." — on BOTH routes, with nothing committed. MEASURED: transaction substrate (PGliteDriver) = NestedWriteError code V7001 message "Cannot set relation 'items': target record was not found." (matches the derivation); batch substrate (BatchOnlyPGliteDriver) = NestedWriteError code V7006 message "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target or ownership check) did not hold." The harness's expect(batch.error).toEqual(transaction.error) fails on that pair (full diff at /private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/n1/rootdep/final-run.log, failure [3/3]). MY READING: the transaction substrate is right — AGENTS.md's N1 paragraph and plan §1 both say the dependent read's own `required` row is a premise of the batch (`requirePresent` ahead of the projection) so an absent target aborts the batch before anything commits, and rule 3 says that absence IS the correlated refusal the relation body already registers. On the batch route the premise aborts correctly but the attribution ladder hands back the generic V7006 assertion sentence instead of resolving the rejected premise to its registered correlated refusal. That is an error-identity defect in the batch attribution (N3's ladder), not something to pin, so the cell is left exactly as it was (it still names OWN_WRITE_ERROR, which is now the only user of that constant). NOTE the same generic-V7006-vs-correlated-refusal shape is worth checking across the other conformance sli
- unverified: Whether the two substrates also agree on the PERSISTED STATE for the disagreement cell ("delete then overlapping set rejects"): the harness asserts error parity before the state assertions, and nested-write-conformance-fixtures.ts is not my write target, so I could not observe the states without weakening the shared oracle. Both messages are consistent with nothing having committed, but that is re
- unverified: The RESULT VALUE of the root update in "payload update is observed by a recursive m2m deleteMany filter": the nested deleteMany removes the root row itself, and the operation does not throw — what the client returns for a root update whose own row the payload then deletes is not pinned by this oracle (it dumps persisted state only). Worth a ruling / a result-mode pin elsewhere (ELEGANCE: check res
- unverified: The two pre-existing reds are reported as such and left untouched, but both now sit against N1's text and may be the integrator's to re-express: (a) "before-parent self connect is unaffected by the future insert" records "target record was not found" while both the base and the N1 engine answer the inherited sentence "Nested operation 'connect' on relation 'parent' depends on an earlier 'create' t
- unverified: I did not run pnpm test:all, the other conformance slices, the N1 pin file, or a typecheck — only my own file (final run above) plus one read-only base run of the same file in the main tree. The unused-import/unused-variable question after removing UPDATE_PREDICATE_ERROR is covered by biome only; no tsc was run.
- unverified: "Foreign key constraint violation" is pinned as a substring of the mapped error's message; the error CLASS/code for that cell is asserted only through the harness's tx-vs-batch equality (both substrates produced the identical error object), not named in the cell.
- biome: Before (HEAD version of the file, checked at e772741eb via the main tree's untouched copy, `npx biome check tests/contracts/engine/query/nested-write-conformance-root-dependency.test.ts`): exit 0, "Checked 1 file in 36ms. No fixes applied." — zero diagnostics in every category. After (my edited file

## transitive — {'re-expressed': 15, 'newly-green': 3, 'unchanged': 1}
final: Tests 31 passed (31) — Test Files 1 passed (1). Verbatim tail of /private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/n1/transitive/run-final.log: " ✓ |extended-local| tests/contracts/engine/query/nested-write-conformance-transitive.test.ts (31 tests) 147

- [re-expressed] sibling create then parent-holds connect rejects same target → "sibling create then parent-holds connect observes the earlier insert"
  before: expectReject: true + DESIGN §6.2's veto "depends on an earlier 'create' target write"; expected = untouched seed (accounts [], record {1,null,null}).
  derived: Both to-one payloads are parent-held, so both are `before` children of the record's own UPDATE, and relations run in the model's declaration order (primary, then secondary): `secondary`'s lookup of account 2 is taken after `primary`'s INSERT (N1 case 2/3), so the UPDATE carries both keys. accounts [
  measured: Identical on both substrates — and identical to the create-family twin four cells below, which was already green.
- [re-expressed] nested create then later root connectOrCreate rejects → "nested create then later root connectOrCreate adopts the created tag"
  before: expectReject: true + "depends on an earlier 'create' target write"; expected = TRANSITIVE_TARGET_SEED.
  derived: Workspace declares `projects` before `tags`, so the nested projects.update creates tag 100 on project 1 first; the root connectOrCreate's lookup is then an ordered observation that finds it and its adopt arm wins. workspaces [{1, projects [1], tags [100]}], projects [{1, tags [100]}], tags [100].
  measured: Identical on both substrates (and consistent with the disjoint id-101 twin immediately below, which was already green).
- [re-expressed] outer create then nested connectOrCreate rejects (name kept — it still rejects)
  before: expectReject: true + "depends on an earlier 'create' target write"; expected = TRANSITIVE_TARGET_SEED.
  derived: Declaration order puts `projects` first despite the payload's key order, so the nested connectOrCreate finds no tag 100 and CREATES it; the outer `tags: { create: { id: 100 } }` then inserts the same primary key. That is rule 5 — the database's own integrity answer — so: expectReject stays true, exp
  measured: Identical. The state assertion, previously unreachable (the run stopped at the error-substring assertion), now passes on both substrates — so "nothing commits" is verified, not assumed.
- [re-expressed] selected top-level upsert create branch gets inherited traversal (name kept)
  before: expectReject: true + "depends on an earlier 'create' target write"; expected = { workspaces: [], projects: [], tags: [] }.
  derived: No seed, so the root upsert takes its create branch; inside it `projects` runs before `tags`, so projects.create makes project 1 and tag 100, and the branch's own tags.connectOrCreate observes tag 100 and adopts it. workspaces [{1, projects [1], tags [100]}], projects [{1, tags [100]}], tags [100].
  measured: Identical on both substrates.
- [re-expressed] selected top-level upsert update branch gets inherited traversal (name kept)
  before: expectReject: true + "depends on an earlier 'create' target write"; expected = TRANSITIVE_TARGET_SEED.
  derived: Workspace 1 exists, so the update branch runs and answers exactly as its `workspace.update` twin: the root connectOrCreate observes the tag the nested update created and adopts it. workspaces [{1, projects [1], tags [100]}], projects [{1, tags [100]}], tags [100].
  measured: Identical on both substrates.
- [re-expressed] a connectOrCreate create alternative inherits earlier sibling writes → "a connectOrCreate create alternative is skipped when its adopt arm w
  before: expectReject: true + "depends on an earlier 'create' target write" (the pass traversed into the UNTAKEN Choose arm and refused); expected = TRANSITIVE_TARGET_SEED.
  derived: Project 1 is seeded, so projects.connectOrCreate takes its adopt arm: the create alternative and the nested connectOrCreate it carries never run. The sibling `tags: { create: { id: 100 } }` runs last (declaration order) and creates tag 100 on the workspace, so nothing is 'inherited' — hence the rena
  measured: Identical on both substrates; no rejection, no junction violation.
- [re-expressed] a later sibling sees writes from a connectOrCreate create alternative → "a later sibling sees no writes from an untaken connectOrCreate crea
  before: expectReject: true + "depends on an earlier 'create' target write"; expected = TRANSITIVE_TARGET_SEED.
  derived: Project 1 exists, so the adopt arm wins and the create alternative's `tags: { create: { id: 100 } }` never runs; the later sibling's own connectOrCreate finds no tag 100 and creates it. workspaces [{1, projects [1], tags [100]}], projects [{1, tags []}], tags [100].
  measured: Identical on both substrates.
- [re-expressed] a later sibling sees writes from an upsert create alternative → "a later sibling sees no writes from an untaken upsert create alternative"
  before: expectReject: true + "depends on an earlier 'create' target write"; expected = TRANSITIVE_TARGET_SEED.
  derived: The upsert finds project 1 among the parent's members and takes its empty update alternative, so the create alternative writes nothing; the later sibling creates tag 100 itself. workspaces [{1, projects [1], tags [100]}], projects [{1, tags []}], tags [100].
  measured: Identical on both substrates.
- [re-expressed] a later sibling sees writes from an upsert update alternative → "a later sibling sees no writes from an untaken upsert update alternative"
  before: expectReject: true + "depends on an earlier 'create' target write"; expected = { workspaces: [{1, [], []}], projects: [], tags: [] }.
  derived: The seed has no project, so the upsert takes its CREATE alternative ({ id: 1 }) and the update alternative that carries `tags: { create: { id: 100 } }` never runs; the later sibling creates tag 100 itself. workspaces [{1, projects [1], tags [100]}], projects [{1, tags []}], tags [100].
  measured: Identical on both substrates.
- [re-expressed] upsert array merges a mismatched create identity before the next input (name kept)
  before: expectReject: true + "depends on an earlier 'upsert' target write"; expected = { workspaces: [{1, [], []}], projects: [], tags: [] }.
  derived: Member 1 (where id 100, not found) creates project 101 and links it to workspace 1; member 2's lookup (where id 101) is an ordered observation across that member boundary, finds project 101 among the parent's members and takes its empty update alternative. workspaces [{1, projects [101], tags []}], 
  measured: Identical on both substrates.
- [re-expressed] upsert array keeps the found branch membership on its selector (name kept)
  before: expectReject: true + "depends on an earlier 'upsert' membership write"; expected = the seeded state (workspace 1 with project 100).
  derived: Both members carry the same selector { id: 100 }, which the seeded membership answers for both: each takes the found branch and each `update: {}` is a no-op, so the end state is exactly the seed — the same rows the veto's rollback used to leave. Only expectReject/expectedError go; the expected state
  measured: Identical on both substrates; no rejection.
- [re-expressed] deep nested update create then root decision rejects → "deep nested update create then root decision adopts the created tag"
  before: expectReject: true + "depends on an earlier 'create' target write"; expected = DEEP_TRANSITIVE_TARGET_SEED.
  derived: Depth changes nothing: `projects` runs before `tags`, so the tag created three levels down (workspace → project → component) is there when the root connectOrCreate observes it, and the adopt arm wins. workspaces [{1, projects [1], tags [100]}], projects [{1, components [1]}], components [{1, tags [1
  measured: Identical on both substrates (and consistent with the disjoint id-101 twin below, already green).
- [re-expressed] nested createMany then later decision rejects → "nested createMany then later decision adopts the created item"
  before: expectReject: true + "depends on an earlier 'createMany' target write"; expected = { owners [1], cohorts [{1, ownerId 1}], items [] }.
  derived: Owner declares `cohorts` before `selectedItems`, so the nested createMany inserts item 100 with groupId 1 first; the owner's selectedItems.connectOrCreate then observes it and adopts it (no second item). items [{100, groupId 1, selectedBy [{1}]}]. NOTE: the group's dump did not carry the owner↔item 
  measured: Identical on both substrates, including the membership the strengthened dump now sees.
- [re-expressed] nested predicate update rejects a later overlapping root filter → "nested predicate update allows a later overlapping root filter"
  before: expectReject: true + "depends on an earlier 'update' target write"; expected = TRANSITIVE_PREDICATE_SEED.
  derived: The root `tags: { deleteMany: { label: 'after' } }` is a dependent predicate read placed after the nested tags.update that wrote label 'after' (projects declared before tags), so it matches tag 100 and deletes it with both memberships. workspaces [{1, projectIds [1], tagIds []}], projects [{1, tagId
  measured: Identical on both substrates.
- [re-expressed] upsert update alternative exports its predicate delta to a later filter (name kept — the export is real now)
  before: expectReject: true + "depends on an earlier 'update' target write"; expected = TRANSITIVE_PREDICATE_SEED.
  derived: The upsert finds project 1 and takes its update alternative, which writes label 'after' on tag 100; the later root deleteMany observes that label and deletes the tag with both memberships. workspaces [{1, projectIds [1], tagIds []}], projects [{1, tagIds []}], tags [].
  measured: Identical on both substrates.
- [newly-green] create-family sibling create then connect observes the earlier insert
  before: Declared pre-existing red at the unit's base commit (orchestrator's pre-existing-red.json). Recorded expectation: no rejection, accounts [{2,'created'}], records [{1, primaryId 2, secondaryId 2}] — i.e. it already record
  derived: Under N1 the create-family root runs `primary`'s INSERT before `secondary`'s lookup (both parent-held `before` children, declaration order), so both keys land: exactly the recorded expectation.
  measured: Passes unchanged on both substrates; I did not touch it.
- [newly-green] nested predicate update allows a later identity-only root filter
  before: Declared pre-existing red at base. Recorded expectation: no rejection, workspaces [{1, projectIds [1], tagIds []}], projects [{1, tagIds []}], tags [].
  derived: deleteMany { id: 100 } needs no observation of the label the nested update wrote; it deletes the member tag and both memberships.
  measured: Passes unchanged on both substrates; I did not touch it.
- [newly-green] upsert update alternative predicate delta ignores an id-only filter
  before: Declared pre-existing red at base. Recorded expectation: no rejection, workspaces [{1, projectIds [1], tagIds []}], projects [{1, tagIds []}], tags [].
  derived: Same as the twin above with the delta written from inside the upsert's update alternative: an id-only filter does not consume the label delta, so the tag is deleted.
  measured: Passes unchanged on both substrates; I did not touch it.
- [unchanged] nested createMany and disjoint later decision succeed (green before and after — assertion STRENGTHENED, answer unchanged)
  before: Green; expected items [{100, groupId 1}, {101, groupId null}] — the owner↔item membership was not dumped at all.
  derived: Unchanged answer (the disjoint connectOrCreate creates item 101 and links it), but with `selectedBy` now in the dump the expectation becomes items [{100, groupId 1, selectedBy []}, {101, groupId null, selectedBy [{1}]}].
  measured: Identical on both substrates; still green. Nothing was loosened — this cell now asserts strictly more than before.
- unverified: The "pre-existing red at the base commit" classification of the six named cells is taken from the orchestrator's /private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/n1/pre-existing-red.json. I did NOT re-measure the base: the worktree's src carries the frozen N1 change and I may not stash, checkout or commit. For "outer create then nested connectOrCrea
- unverified: The three cells reported "newly-green" are green under the frozen N1 engine in this worktree; I did not verify WHY they were red at base (same caveat: no base run available to me).
- unverified: This harness witnesses only end state, rejection identity and tx-vs-batch parity. It cannot witness N1's transport-level claims — the barrier's committed segment, the premise riding with the queued writes, the number of native batches, `committedSegments`. Those live in tests/raptor3/g4/parity/ordered-observation.test.ts (24/24 green in the orchestrator's probe2), not here.
- unverified: I did not run pnpm test:all, and I did not run the sibling conformance files (other agents own them). The one estate typecheck error I observed is in nested-write-conformance-m2m.test.ts line 750 and belongs to that agent's in-flight edit, not to N1.
- unverified: Strengthening dumpTransitiveCreateMany with `include: { selectedBy: … }` is group-level machinery, shared by the two createMany cells; both are green after the change and the twin's expectation was widened, never loosened. If the integrator would rather keep group dumps frozen during N1, reverting that one hunk and dropping `selectedBy` from the two expectations restores the previous (membership-b
- biome: `npx biome check tests/contracts/engine/query/nested-write-conformance-transitive.test.ts` in /private/tmp/viborm-n1. BEFORE (file byte-identical to `git show HEAD:<file>`, verified by diff against the scratchpad copy): "Checked 1 file in 11ms. No fixes applied." — zero diagnostics, no category. AFT

## selector-history — {'re-expressed': 9, 'unchanged': 7}
final: `node scripts/run-vitest-safe.mjs run tests/raptor3/prep/selector-dependencies.test.ts tests/raptor3/post-prep/history-analysis.test.ts` → " Test Files 4 passed (4)" / " Tests 32 passed (32)" (16 cells × the raptor3 and coverage-raptor3 projects; 4.63s wall, 605.6 MiB peak RSS)

- [re-expressed] selector-dependencies: executes a root related-row write that changes a later relation predicate, then refuses the absent target (was "refus
  before: DESIGN §6.2's mode-independent veto: a NestedWriteError (NESTED_WRITE_FAILED) raised with driver.statements.length === 0 — "Semantic dependency refusal must precede every candidate statement"
  derived: Rules 1–3: relations run in declaration order, so markers.update sets m1.flag='new' first; the accounts lookup (some {t1,m1,flag:'old'}) is an ordered observation taken after it, binds no row, so the relation body's correlated refusal "Cannot update relation 'accounts': target record was not found f
  measured: message "Cannot update relation 'accounts': target record was not found for this parent.", meta {relation:'accounts'}, code NESTED_WRITE_FAILED; 4 statements: hub SELECT, marker member SELECT, UPDATE markers, hub-scoped accounts SELECT (write idx 2 < observation idx 3); assertInitialState passes
- [re-expressed] selector-dependencies: executes the same related-row dependency inside a selected nested record, then refuses the absent target (was "refuse
  before: same veto, asserted ahead of every statement
  derived: identical to the root cell one record deeper: the nested hub's marker update executes, the accounts observation follows it and finds nothing → correlated refusal, whole unit rolled back
  measured: same message/meta; 5 statements (envelope SELECT, hub SELECT, marker SELECT, UPDATE markers, accounts observation), write idx 3 < observation idx 4; initial state intact
- [re-expressed] selector-dependencies: executes a membership write that changes a later predicate on the same edge, then refuses the absent target (was "ref
  before: same veto, asserted ahead of every statement
  derived: the nested markers.update's accounts disconnect removes (a1,m1) first; the later accounts lookup (some {t1,m1}) observes the membership the removal left, binds no row → correlated refusal, nothing commits
  measured: same message/meta; 5 statements, the only mutation is DELETE FROM g3p05_dependency_account_markers (idx 3) and the single hub-scoped accounts observation is idx 4 (the earlier accounts SELECT at idx 2 is the disconnect's own member lookup, not hub-scoped); initial state intact
- [re-expressed] selector-dependencies: executes a selected updateMany write that changes a later relation predicate, then refuses the absent target (was "re
  before: same veto, asserted ahead of every statement
  derived: the junction updateMany captures its members and writes m1.flag='new'; the accounts observation, taken after it, no longer matches flag 'old' → correlated refusal, rollback
  measured: same message/meta; 5 statements, UPDATE markers at idx 3, observation idx 4; initial state intact
- [re-expressed] selector-dependencies: executes the same selected updateMany dependency inside a nested record, then refuses the absent target (was "refuses
  before: same veto, asserted ahead of every statement
  derived: as above, one record deeper under envelope.update
  measured: same message/meta; 6 statements, UPDATE markers at idx 4, observation idx 5; initial state intact
- [re-expressed] selector-dependencies: executes a selected deleteMany whose removal changes later target existence, then refuses the absent target (was "ref
  before: same veto, asserted ahead of every statement
  derived: markers.deleteMany removes marker (t1,m1) first (markers precedes accounts in declaration order); the accounts observation then finds no marker to satisfy some {t1,m1} → correlated refusal, rollback
  measured: same message/meta; 5 statements, DELETE FROM g3p05_dependency_markers at idx 3, observation idx 4; initial state intact
- [re-expressed] selector-dependencies: does not treat a key nested under OR as proof of disjointness
  before: same veto — a refusal ahead of every statement was the proof that the OR-nested key proved nothing — plus the end state (m1 flag 'old', a1 label 'before', a1 markers [m1])
  derived: the key under OR still proves nothing, so the lookup is DEPENDENT: it is placed after the marker update rather than captured ahead of it. Read as disjoint it would run first, match flag 'old' and land 'must-not-land'; read as dependent it sees flag 'new', matches neither OR arm (m2 was disconnected 
  measured: 4 statements: hub SELECT, marker SELECT, UPDATE markers (idx 2), the single hub-scoped accounts observation carrying the OR predicate (idx 3); the operation's answer is the same correlated refusal, and the end state is unchanged (m1 flag 'old', a1 label 'before', markers [m1])
- [re-expressed] selector-dependencies: does not treat a key nested under NOT as proof of disjointness
  before: same veto plus the same end state
  derived: identical to the OR case with NOT {t1,m2} AND flag 'old'
  measured: 4 statements, UPDATE markers at idx 2, the NOT-carrying hub-scoped observation at idx 3; end state unchanged
- [unchanged] selector-dependencies: accepts a selected updateMany proven disjoint by another complete compound key
  before: the disjoint read executes and both writes land
  derived: unchanged by N1 (case 1: disjoint stays a capture-phase read)
  measured: green at the base and after
- [unchanged] selector-dependencies: accepts a relation predicate proven disjoint by the complete compound target key
  before: the disjoint read executes and both writes land
  derived: unchanged by N1 (case 1)
  measured: green at the base and after
- [unchanged] selector-dependencies: does not confuse equal slot names on different membership edges
  before: different edges are not an overlap; the operation executes
  derived: unchanged by N1
  measured: green at the base and after
- [re-expressed] history-analysis: isolates alternative suffixes while exposing them to a later sibling
  before: analyze(root).refusal was a NestedWriteError whose meta read operation 'upsert', conflictsWith 'upsert', relation 'children' — DESIGN §6.2's veto over the suffix the later sibling sees
  derived: N1: the pass spends the same overlap fact on placement, so analyze has no refusal; the later upsert's lookup reads a row only the earlier upsert's create ARM can produce, and a Choose arm is excluded from case 2 (established producer), so it falls to case 3 — an ordered observation: lookup.dependent
  measured: refusal undefined; laterChoice.lookup.dependent === true; earlierChoice.lookup.dependent undefined; isolatedChoice.lookup.dependent undefined; root's children = [earlierChoice, laterChoice], both placement 'after', neither carrying a refusal
- [unchanged] history-analysis: keeps actual create spines linear at depths 1, 2, 8 and 32
  before: linear history, one occurrence per record
  derived: untouched by N1 (no dependent read in a create spine)
  measured: green at the base and after
- [unchanged] history-analysis: keeps actual create siblings linear at widths 1, 2, 8 and 32
  before: linear history across siblings
  derived: untouched by N1
  measured: green at the base and after
- [unchanged] history-analysis: retains repeated occurrences of the same record identity
  before: a repeated placement keeps two occurrences of one command
  derived: untouched by N1
  measured: green at the base and after
- [unchanged] history-analysis: keeps nested occurrences distinct across repeated compound placements
  before: nested occurrences stay distinct per placement
  derived: untouched by N1
  measured: green at the base and after
- unverified: Both files exercise only the LIVE route (better-sqlite3 in-memory for the prep file; the post-prep file builds commands without executing). The batch-route behaviour of the same shapes — the barrier, the premises riding with the queued writes, the committed segment — is pinned by tests/raptor3/g4/parity/ordered-observation.test.ts, which is not my file and which I did not run.
- unverified: The exact retired sentence per cell: the base cells asserted only `instanceof NestedWriteError` + `code === NESTED_WRITE_FAILED` + `statements.length === 0`, never a message, so my per-cell N1 comments name "DESIGN §6.2's veto raised before any statement" rather than quoting each cell's old wording. I did not run the base commit to recover the per-cell sentences (the engine is frozen in this workt
- unverified: `node scripts/run-typecheck.mjs` (whole estate, under the shared lock) reports no diagnostic in either of my two files. It ran against a tree carrying seven other agents' in-flight edits; the diagnostics it did report are theirs (tests/raptor3/post-prep/g29-member-dependency.test.ts:826,835 TS2367, and on an earlier run tests/raptor3/core-structure/structural-reference.test.ts:689 TS2304, which ha
- unverified: pnpm test:all was not run (forbidden by the task). No conformance/PGlite suite was run.
- unverified: Judgement call to flag for the integrator: the two OR/NOT placement cells still END in the same correlated refusal as the six cells above them, but per the task instruction they no longer assert a refusal — they run the operation through a documented `runForPlacement` helper and pin the statement order plus the unchanged end state. They remain falsifiable: inverting `observation > write` fails all
- biome: `npx biome check` on both files — BEFORE (HEAD copies): 10 errors, all lint/suspicious/noMisplacedAssertion (selector-dependencies 6 at 81/142/143/151/161/171; history-analysis 4 at 122/132/140/147); no formatter diagnostics. AFTER: 12 errors, same single category (selector-dependencies 8 at 81/171/

## m2m — {'re-expressed': 8, 'pre-existing-red': 3}
final: Test Files 1 failed (1) Tests 3 failed | 31 passed (34) (node /private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/run-shared-family.mjs tests/contracts/engine/query/nested-write-conformance-m2m.test.ts, cwd /private/tmp/viborm-n1, TMPDIR=/private/tmp/vib

- [re-expressed] m2m connectOrCreate string-selector array rejects unknown overlap
  before: PRE-EXISTING RED. Pinned DESIGN §6.2's veto: expectReject true + "depends on an earlier 'connectOrCreate' target write in the same nested write", state = untouched baseline. Gate class C at base: expectReject true but tr
  derived: One expanded series, two members in order: member 1 (where id t1) FINDS t1 and connects (create arm, name "ignored", not taken); member 2 (where id t9) finds nothing, creates t9 "tag-9" and connects. => membership p1 [t1,t9]; tags {t1,t2,t3,t9:"tag-9"}.
  measured: Exactly the derivation, both substrates agreeing. Renamed to "m2m connectOrCreate string-selector array connects the found member and creates the unknown one"; expected = m2mExpected({membership:{p1:["t1","t9"]}, tags:{...BASELINE,t9:"tag-9"}}).
- [re-expressed] m2m connectOrCreate then deleteMany rejects target dependency
  before: expectReject true + "depends on an earlier 'connectOrCreate' target write"; state = untouched baseline.
  derived: connectOrCreate (canonical position 5) runs before deleteMany (8). t9 absent -> created and linked; the removal's observation is placed behind the whole mutation INCLUDING its junction link, so t9 is a member, matches {id t9}, and its row plus membership go. => membership p1 []; tags {t1,t2,t3}.
  measured: Exactly the derivation. Renamed to "m2m connectOrCreate then deleteMany removes the tag the connectOrCreate just created"; expected stays m2mExpected() (the create-then-delete round trip returns the dump to baseline), expectReject/expectedError dropped.
- [re-expressed] m2m explicit delete then deleteMany rejects target dependency
  before: expectReject true + "depends on an earlier 'delete' target write"; state = p1 still connected to t1, all three tags alive.
  derived: delete (2) before deleteMany (8). delete {id t1}: t1 is a member -> row and junction row gone. deleteMany {id t1} observed behind it matches no member -> no-op. => membership p1 []; tags {t2,t3}.
  measured: Exactly the derivation. Renamed to "m2m explicit delete then deleteMany finds no member left to remove"; expected = m2mExpected({tags:{t2:"tag-2",t3:"tag-3"}}).
- [re-expressed] m2m update then deleteMany rejects target dependency
  before: expectReject true + "depends on an earlier 'update' target write"; state = p1 connected to t1, t1 still named "tag-1".
  derived: update (3) before deleteMany (8). The update renames t1 to "changed"; the removal's filter {name "changed"} is resolved against the state the update left, so it matches t1 (a member) and removes row and membership. => membership p1 []; tags {t2,t3}.
  measured: Exactly the derivation. Renamed to "m2m update then deleteMany removes the row the update just renamed"; expected = m2mExpected({tags:{t2:"tag-2",t3:"tag-3"}}).
- [re-expressed] m2m updateMany then deleteMany rejects filter dependency
  before: expectReject true + "depends on an earlier 'updateMany' target write"; state = p1 connected to t1, t1 still "tag-1".
  derived: updateMany (7) immediately before deleteMany (8). The bulk rename sets t1.name = "changed"; the removal's filter observes that result and removes t1's row and membership. => membership p1 []; tags {t2,t3}.
  measured: Exactly the derivation. Renamed to "m2m updateMany then deleteMany removes the rows its filter just matched"; expected = m2mExpected({tags:{t2:"tag-2",t3:"tag-3"}}).
- [re-expressed] m2m multiple deleteMany filters reject internal dependency
  before: PRE-EXISTING RED. expectReject true + "depends on an earlier 'deleteMany' target write"; state = p1 still connected to t1 and t2. Gate class C at base: expectReject true but transaction.rejected false.
  derived: One deleteMany series, two members; a read placed by construction is already behind every template write it may depend on (expandSeries only marks). Member 1 removes t1 (row + link); member 2 observes behind it, t2 is still a member, and removes t2. => membership p1 []; tags {t3}.
  measured: Exactly the derivation. Renamed to "m2m multiple deleteMany filters each observe what the previous one left"; expected = m2mExpected({tags:{t3:"tag-3"}}).
- [re-expressed] m2m upsert then deleteMany: the removal cannot read past the upsert
  before: expectReject true + "depends on an earlier 'upsert' target write" (N6-U3 had retargeted the attribution and called this "ATOM §4.1 case ii, the class no ordering can fix"); state = p1 connected to t1.
  derived: Canonical order runs upsert (4) before deleteMany (8) despite the payload's key order. The upsert finds t1 present and a member -> update arm, name "update". The removal observes behind it, t1 is a member and matches {id t1}, so row and membership go. => membership p1 []; tags {t2,t3}.
  measured: Exactly the derivation — the shape N6-U3 called unfixable by ordering is executed by the order that actually runs. Renamed to "m2m upsert then deleteMany: the removal observes the upserted row"; expected = m2mExpected({tags:{t2:"tag-2",t3:"tag-3"}}); the N6-U3 note kept in condensed form.
- [re-expressed] named likes create then stars connectOrCreate rejects target dependency
  before: expectReject true + "depends on an earlier 'create' target write"; state = alphas [{a1, likes [], stars []}], betas [].
  derived: Relations run in declaration order, and alpha declares likes before stars. likes.create inserts beta b1 and links it on the "likes" junction; stars.connectOrCreate {where id b1} observes behind the create, finds b1, and takes the connect arm on the second NAMED junction — no second beta row. => alph
  measured: Exactly the derivation. Renamed to "named likes create then stars connectOrCreate connects the beta the create just made"; expected = {alphas:[{id:"a1",likes:[{id:"b1"}],stars:[{id:"b1"}]}], betas:[{id:"b1"}]}.
- [pre-existing-red] m2m overlapping set and deleteMany reject membership dependency
  before: PRE-EXISTING RED. expectReject true + "depends on an earlier 'set' membership write"; state = untouched baseline. Gate class C at base (nested-conformance.md:81): expectReject true, transaction.rejected false — the depen
  derived: set (6) before deleteMany (8). set [t1] gives p1 the membership {t1}; the removal's observation, taken behind it, sees t1 as a member and deletes the row it was just given. => membership p1 []; tags {t2,t3}.
  measured: CONTRADICTS the derivation, both substrates agreeing: membership p1 [t1], tags [t1,t2,t3]. The removal read BEFORE the set and matched nothing. Cell left verbatim at its recorded expectation (brief rule e); it now fails at fixtures.ts:140 with the same class-C signature the gate recorded at base.
- [pre-existing-red] m2m disconnect then deleteMany rejects membership dependency
  before: PRE-EXISTING RED. expectReject true + "depends on an earlier 'disconnect' membership write"; state = p1 still connected to t1. Gate class C at base (nested-conformance.md:82), same signature as the set cell.
  derived: disconnect heads the canonical order (1), deleteMany is 8th. The strict selector disconnect removes the junction row and keeps t1's row; the removal observes the emptied membership behind it and matches nothing. => membership p1 []; tags {t1,t2,t3} (the ROW survives).
  measured: CONTRADICTS the derivation, both substrates agreeing: membership p1 [] and tags [t2,t3] — t1's ROW was deleted, i.e. the removal read BEFORE the disconnect and still saw t1 as a member. Cell left verbatim at its recorded expectation; fails at fixtures.ts:140, base signature unchanged.
- [pre-existing-red] self m2m connect then inverse upsert rejects shared junction dependency
  before: PRE-EXISTING RED. expectReject true + "depends on an earlier 'connect' membership write"; state = {follows: [], followedBy: []}. Gate at base (nested-conformance.md:84): batch.rejected (true) != transaction.rejected (fal
  derived: follows runs before followedBy (declaration order). follows.connect {id u1} writes the self junction row; the inverse followedBy.upsert {where id u1} observes behind it on the junction they share, finds u1 in u1.followedBy, and takes the found/update arm (the create arm would collide on the PK). => 
  measured: SUBSTRATES DISAGREE. tx: no refusal, state {users:[{id:u1,name:"updated"}], follows:[u1->[u1]], followedBy:[u1->[u1]]} — EXACTLY the derivation, the live route's sequential dispatch answers the ordered observation correctly. batch: NestedWriteError "Cannot upsert relation 'followedBy': target record
- DISAGREEMENT: JUNCTION MEMBERSHIP OVERLAPS ARE NEVER COMPUTED, SO N1 NEVER PLACES THEM (the one cause of all three remaining reds). src/query-engine/raptor3/commands/commands.ts:559 `readMembership` returns on its first line when `membership.edge.kind !== "reference"` — a junction edge (shared/storage.ts:27 `kind: "junction"`) never reaches `depend()`. That guard is present verbatim at the base commit (`git show HEAD:src/.../commands.ts | grep -n 'edge.kind !== "reference"'` -> line 559) and the N1 diff does not touch `readMembership`, so nothing about it changed. `readTarget`'s link/remove branch (commands.ts:607+) is not a substitute: it only fires when the READ's own selector scope path traverses the same edge, which a junction `deleteMany` capture's membership read does not. Consequence: the lookup is neither refused nor re-placed, it stays in the capture phase ahead of every `after` effect, and the consumer gets a STALE observation. This contradicts the unit's own contract text, which says the overlap "the dependency pass computes in checkPair -> readTarget / readMembership" is taken at its consumer's execution point (AGENTS.md:971-975) and that BOTH inherited sentences ('target / membership write') disappear (plan §1 'What disappears'). Reproduce: cd /private/tmp/viborm-n1; TMPDIR=/private/tmp/viborm-n1-m2m-tmp; node <scratchpad>/run-shared-family.mjs tests/contracts/engine/query/nested-write-conformance-m2m.test.ts -t "<cell>".
- DISAGREEMENT: DISAGREEMENT 1 — "m2m overlapping set and deleteMany reject membership dependency". Seed: baseline (p1,p2; t1,t2,t3; no memberships). Act: post.update p1 { tags: { set: [{id:t1}], deleteMany: {id:t1} } }. Derived from rules 1-2: set (canonical 6) runs before deleteMany (8), so the removal observes t1 as a member and deletes its row => membership p1 [], tags {t2,t3}. Measured (tx and batch identical, so the parity check passes): membership p1 [t1], tags [t1,t2,t3] — the removal resolved its filter against the membership as it stood BEFORE the set and matched nothing. My reading: the engine is wrong; the derivation follows D-51 and the principle that every consumer receives an observation valid at its execution point. Receipt: scratchpad/n1/m2m/run-set-selfref.log (isolated diff).
- DISAGREEMENT: DISAGREEMENT 2 — "m2m disconnect then deleteMany rejects membership dependency". Seed: baseline + p1 connected to t1. Act: post.update p1 { tags: { disconnect: {id:t1}, deleteMany: {id:t1} } }. Derived: disconnect heads the canonical order, so the removal observes the emptied membership, matches nothing, and t1's ROW survives => membership p1 [], tags {t1,t2,t3}. Measured (tx and batch identical): membership p1 [], tags [t2,t3] — t1's row was DELETED, i.e. the removal still saw t1 as a member. This is the mirror of disagreement 1 and the more damaging direction: a row the caller explicitly only disconnected is destroyed. My reading: the engine is wrong. Receipt: scratchpad/n1/m2m/run-disconnect.log (isolated diff).
- DISAGREEMENT: DISAGREEMENT 3 — "self m2m connect then inverse upsert rejects shared junction dependency" — a TX/BATCH PARITY BREAK (brief rule 6: a defect, not something to pin). Seed: user u1 "Alice". Act: user.update u1 { follows: { connect: {id:u1} }, followedBy: { upsert: { where:{id:u1}, create:{id:u1,name:"create"}, update:{name:"updated"} } } }. Derived: follows before followedBy (declaration order); the inverse upsert observes the self-junction row the connect just wrote, finds u1 in u1.followedBy and takes the update arm => users [{u1,"updated"}], follows u1->[u1], followedBy u1->[u1]. Measured: the TX substrate produces EXACTLY that (captured with a temporary diagnostic, since the harness stops at the parity assertion: TEMP-DIAGNOSTIC ok {"users":[{"id":"u1","name":"updated"}],"follows":[{"userId":"u1","followsIds":["u1"]}],"followedBy":[{"userId":"u1","followedByIds":["u1"]}]}), while the BATCH substrate rejects with NestedWriteError "Cannot upsert relation 'followedBy': target record was not found for this parent." The live route answers the ordered observation by sequential dispatch; the batch route asserts the upsert's found/membership premise in the batch AHEAD of the sibling connect, so the correlated refusal fires against a membership that the same unit is about to create. The two halves of the fix are one: give the junction membership overlap its placement (disagreement 0) and the premise then rides the right batch. Receipts: scratchpad/n1/m2m/run-set-selfref.log, run-selfref-state.log. Note for whoever re-expresses this cell after the fix: `dumpSelfRefM2m` currently carries memberships only, no rows, so it cannot witness WHICH upsert arm ran; I added an id+name `users` key for the measurement and reverted it with the cell.
- unverified: I could not measure the base commit (e772741eb) engine's produced STATE for the three membership cells: that needs a run against the clean base engine, and the only tree at that commit is the main tree /Users/arnaud/code/viborm, which the brief forbids touching. I relied instead on (a) the gate triage's recorded base signature, docs/architecture/raptor3-evidence/g4/release/gate/nested-conformance.
- unverified: The re-expressed cell "m2m connectOrCreate then deleteMany removes the tag the connectOrCreate just created" has an end state that coincides with the untouched baseline, so the persisted-state oracle alone cannot distinguish "created then deleted" from "nothing happened". What the cell still pins strictly is that the shape does NOT reject (expectReject is now false, so a refusal fails it) and that
- unverified: I ran only my assigned file. The pin file tests/raptor3/g4/parity/ordered-observation.test.ts, the other five conformance slices and the wider gate were not run by me (other agents own them, and the machine allows one vitest process at a time). The counts I quote for other files come from the pre-existing probe receipts under scratchpad/n1/probe2, not from my own runs.
- unverified: The temporary diagnostics I used to read the batch-route error and the tx-route state were reverted; the file's final diff touches only the eight re-expressed cells (verified with `git diff`, which shows no hunk in dumpSelfRefM2m or in the three membership cells).
- biome: npx biome check tests/contracts/engine/query/nested-write-conformance-m2m.test.ts, run in /private/tmp/viborm-n1. BEFORE (file byte-identical to `git show HEAD:<file>`, verified against a scratch copy): "Checked 1 file in 46ms. No fixes applied." — zero diagnostics, no category. AFTER: "Checked 1 fi

## membership — {'re-expressed': 7, 'newly-green': 1, 'pre-existing-red': 5, 'disagreement': 1}
final: Tests 6 failed | 24 passed (30) — Test Files 1 failed (1); Vitest resources: 6.28s wall, 1569 MiB peak sampled RSS (ceiling 2560 MiB), teardown verified. Remaining red (all six reproduce identically at the base commit except the last): "self to-one inverse upsert rejects a current-row FK membership 

- [re-expressed] nested create membership rejects a later cross-scope to-one upsert  →  renamed "nested create membership collides with the earlier cross-sco
  before: DESIGN §6.2's veto, expectReject + expectedError "depends on an earlier 'create' membership write", state = the seed. Red at base too: the base engine already answered 'Unique constraint violation' here, so N1 did not ch
  derived: Relations run in declaration order, so `container` (parent-held) precedes `children`: the cross-scope upsert observes node 1's empty partner slot and creates node 3 with partnerId 1; the nested create of node 2 then claims the same UNIQUE slot. Rule 5: the database's integrity answer is the operatio
  measured: Both substrates reject with one identical error, message exactly "Unique constraint violation"; both persist CROSS_SCOPE_MEMBERSHIP_BASE (the seed). Matches the derivation, including the rollback.
- [re-expressed] connectOrCreate membership rejects a later cross-scope to-one upsert  →  renamed "connectOrCreate membership collides with the earlier cross
  before: expectReject + "depends on an earlier 'connectOrCreate' membership write", state = the seed. Red at base with the same 'Unique constraint violation'.
  derived: The earlier cross-scope upsert creates node 3 in node 1's unique partner slot; the connectOrCreate finds node 2 and rebinds it onto the same slot ⇒ unique violation (rule 5), nothing commits.
  measured: Both substrates reject with the identical "Unique constraint violation"; state = CROSS_SCOPE_MEMBERSHIP_WITH_TARGET (the seed). Matches.
- [re-expressed] found connect membership rejects a later cross-scope to-one upsert  →  renamed "found connect membership collides with the earlier cross-sco
  before: expectReject + "depends on an earlier 'connect' membership write", state = the seed. Red at base with the same 'Unique constraint violation'.
  derived: Upsert first (declaration order) creates node 3 with partnerId 1; the connect rebinds node 2 onto the same unique slot ⇒ unique violation, nothing commits.
  measured: Both substrates reject with the identical "Unique constraint violation"; state = the seed. Matches.
- [re-expressed] nested to-many child update carries its selector into inverse membership (name kept — it still describes the shape)
  before: expectReject + UPDATE_MEMBERSHIP_ERROR; at base the engine refused with the inherited "Nested operation 'upsert' on relation 'partnerOf' depends on an earlier 'update' target write … Split these operations" (the sentence
  derived: Container 10's `nodes` update reaches node 1 (member ✓); node 1's own write moves partnerId 1→2; the `partnerOf` observation is taken AFTER that write, where nothing holds partnerId 1, so the upsert takes its create branch: node 3 {label three, partnerId 1}. containers [10]; nodes 1{one,c10,p null,p
  measured: Executes on both substrates; persisted state byte-identical to the derived state on tx and batch.
- [re-expressed] non-self nested FK rebind rejects a later inverse read of the same holder  →  renamed "non-self nested FK rebind follows the inverse read of
  before: expectReject + UPDATE_MEMBERSHIP_ERROR; at base the inherited "Nested operation 'update' on relation 'children' depends on an earlier 'update' target write …"; state = the seed.
  derived: `container` is declared before `children` (and is the parent-held/before child), so the inverse read runs first and finds node 1 still in container 10 ⇒ label "after"; the rebind then moves it to container 20. containers [10, 20]; nodes 1{after, c20, parent 9}, 9{root, c10}.
  measured: Executes on both substrates; state byte-identical to the derived state.
- [re-expressed] nested scalar FK rebind rejects a later inverse read of the same holder  →  renamed "nested scalar FK rebind follows the inverse read of the
  before: expectReject + "depends on an earlier 'update' membership write"; at base the inherited 'target write' sentence; state = the seed.
  derived: `children` is declared before `friends`: the child update observes node 1 still under parent 10 ⇒ label "after"; the friend update (junction (10,1) intact) then sets parentId 2. nodes 1{after, parent 2}, 2{two}, 10{root}; friends [(10,1)]; allies [].
  measured: Executes on both substrates; state byte-identical to the derived state (the order is load-bearing: friends-first would have failed the children membership).
- [re-expressed] nested scalar FK rebind rejects a later inverse upsert of the same holder  →  renamed "nested scalar FK rebind follows the inverse upsert of
  before: expectReject + "depends on an earlier 'update' membership write"; at base the inherited 'target write' sentence; state = the seed.
  derived: `children` before `friends`: the upsert observes node 1 still under parent 10 and takes its FOUND branch (label "after", no create — a create would collide on the primary key); the friend update then rebinds parentId to 2. Same end state as the read variant.
  measured: Executes on both substrates; state byte-identical to the derived state.
- [newly-green] nested identity transition exports the exact final membership source
  before: No expectReject; the recorded end state (node 1 → id 4 with friend 2, node 3's friend update renaming node 2). At the base commit this REJECTED (transaction.rejected true where false was expected), so it was red.
  derived: The `children.update` array runs member by member: node 1 takes identity 4 and connects friend 2 under its final identity; node 3's friends update then finds member 2 and renames it. nodes 2{after}, 3{three,p10}, 4{one,p10}; friends [(3,2),(4,2)].
  measured: Passes on both substrates under the frozen engine, unchanged file. N1's ordered observation made it green.
- [pre-existing-red] self to-one inverse upsert rejects a current-row FK membership move
  before: expectReject + UPDATE_MEMBERSHIP_ERROR, state = the seed. Red at base with exactly the same symptom.
  derived: The root write moves node 1's partnerId 1→2; the `partnerOf` observation taken after it finds the slot vacated ⇒ create node 3 {three, partnerId 1}. Executes; nodes 1{one,partner 2}, 2{two}, 3{three,partner 1}.
  measured: SUBSTRATES DISAGREE (same at base): transaction.rejected = false (the tx route executes — my derivation), batch.rejected = true. The harness stops at `expect(batch.rejected).toBe(transaction.rejected)`, so no state is reported. Rule 6 makes this a defect, not something to pin; left untouched.
- [pre-existing-red] self to-many inverse update rejects the moved current row
  before: expectReject + UPDATE_MEMBERSHIP_ERROR, state = the seed. Red at base with exactly the same symptom.
  derived: The root write moves node 1's parentId 1→2; the `children` update's membership observation, taken after it, finds node 1 is no longer a child of node 1 ⇒ rule 3's correlated refusal "Cannot update relation 'children': target record was not found for this parent.", nothing commits (the seed).
  measured: Both substrates reject and nothing commits, but with DIFFERENT error identities: tx = V7001 "Cannot update relation 'children': target record was not found for this parent." (exactly the derivation), batch = V7006 "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target
- [pre-existing-red] non-self child-holds cascade keeps membership through a key transition
  before: No expectReject; end state containers [11], node 1 {after, containerId 11}. Red at base with exactly the same symptom (its recorded expectation is NOT a dependency sentence).
  derived: Container 10's own write takes id 11, the FK cascades node 1 to containerId 11, and the `nodes` observation taken after the parent's write sees node 1 in container 11 ⇒ label "after". Executes, matching the recorded state.
  measured: SUBSTRATES DISAGREE (same at base): tx executes (rejected false — the derivation), batch rejects. Stops at the rejected-parity assertion. Left untouched.
- [pre-existing-red] nested physical membership rejects a later same-edge root update
  before: expectReject + "depends on an earlier 'connect' membership write", state = the seed. Red at base with exactly the same message as now.
  derived: `children` is declared before `friends`: the nested child update connects junction (1,2) first, so the root's `friends.update where id=2` observation, taken at its execution point, FINDS member 2 ⇒ label "after"; nodes 1{one,p1}, 2{after}; friends [(1,2)].
  measured: Both substrates reject, identically and atomically, with "Cannot update relation 'friends': target record was not found for this parent." (probe run4 confirms both persist the seed). Contradicts the derivation — the junction observation was taken ahead of the nested connect. NOT re-expressed; see Di
- [pre-existing-red] nested physical membership rejects a later same-edge root upsert
  before: expectReject + "depends on an earlier 'connect' membership write", state = the seed. Red at base with exactly the same symptom.
  derived: Same order as the update variant: the connect of (1,2) precedes the root's `friends.upsert where id=2`, so the upsert finds the member and takes its update branch ⇒ nodes 1{one,p1}, 2{after}; friends [(1,2)].
  measured: SUBSTRATES DISAGREE (same at base): tx executes (rejected false — the derivation), batch rejects. Stops at the rejected-parity assertion. Left untouched (rule 6).
- [disagreement] same-node non-self FK rebind rejects inverse descent through the final target
  before: expectReject + UPDATE_MEMBERSHIP_ERROR, state = the seed. NOT in the pre-existing-red list and correctly so: it was GREEN at the base commit (the base engine produced the veto sentence). It is red only under the frozen N
  derived: Node 1's own write sets containerId 10→20 and its `container` update descends to `nodes.update where id=1`. Under either consistent placement the operation executes: if the parent-held lookup keeps its pre-write point, it resolves container 10 and the membership read at that same point finds node 1 
  measured: Both substrates reject, identically and atomically, with "Cannot update relation 'nodes': target record was not found for this parent." (probe run4 confirms both persist the seed). This requires an INCONSISTENT split — the container resolved before the root write (10) while its membership premise is
- DISAGREEMENT: N1-CAUSED (the only one). Cell: "same-node non-self FK rebind rejects inverse descent through the final target", /private/tmp/viborm-n1/tests/contracts/engine/query/nested-write-conformance-membership.test.ts:663-697 (membershipDependencySchema). GREEN at the base commit e772741eb (the base engine answered the retired veto), RED under the frozen engine. Repro: seed containers 10 and 20, node 1 {label one, containerId 10}; act client.node.update({where:{id:1}, data:{containerId:20, container:{update:{nodes:{update:{where:{id:1},data:{label:'after'}}}}}}}). DERIVED (AGENTS.md N1 paragraph + plan §1 case 3): the operation executes — with the parent-held lookup kept at its pre-write point it resolves container 10 and its membership read, at that same point, finds node 1 in 10; with the lookup moved behind the root write it resolves container 20 and finds node 1 in 20. Both consistent placements give containers [{10},{20}], node 1 {label 'after', containerId 20}. MEASURED (both substrates, identical error object, both persisting the seed — verified by a temporary expectedError probe, run4-probe.log): NestedWriteError "Cannot update relation 'nodes': target record was not found for this parent." That is only possible if the container was resolved BEFORE the root's own write while the membership premise was asserted AFTER it — the stale-observation split that plan §1 'What each observation is valid for' forbids ('An observation made before a sibling write of the same target is stale for every consumer placed after that write'). The failure boundary is intact (atomic on both routes); only the answer is wrong. No pin in tests/raptor3/g4/parity/ordered-observation.test.ts covers a parent-held to-one lookup whose answer the parent's OWN write changes; that is the missing pin.
- DISAGREEMENT: PRE-EXISTING, engine-level (identical at base, so not N1's doing). Cell: "nested physical membership rejects a later same-edge root update", membership file line ~896 (transitiveMembershipDependencySchema). Repro: seed node 1 {parentId 1}, node 2; act client.node.update({where:{id:1}, data:{children:{update:{where:{id:1},data:{friends:{connect:{id:2}}}}}, friends:{update:{where:{id:2},data:{label:'after'}}}}}). DERIVED: `children` is declared before `friends`, so the nested connect inserts junction (1,2) first and the root's friends membership observation, taken at its execution point, finds member 2 ⇒ nodes 1{one,p1}, 2{after}, friends [(1,2)]. MEASURED (both substrates, identical, atomic): "Cannot update relation 'friends': target record was not found for this parent." The junction observation is still taken ahead of a write that lives in a SIBLING relation's nested subtree — the overlap the dependency pass sees within one relation body (pinned by 'a dependent junction capture moves behind the write it depends on') is not seen across relations/depths. Same message at base, so N1 neither caused nor fixed it.
- DISAGREEMENT: PRE-EXISTING, substrate parity (rule 6 defects; all three identical at the base commit, harness stops at `expect(batch.rejected).toBe(transaction.rejected)` so no state is reported). (a) "self to-one inverse upsert rejects a current-row FK membership move": tx executes (agreeing with the derivation — the vacated partner slot takes the upsert's create branch), batch rejects. (b) "non-self child-holds cascade keeps membership through a key transition": tx executes (the cascaded key 11 carries the membership, as the cell's recorded state says), batch rejects. (c) "nested physical membership rejects a later same-edge root upsert": tx executes (the upsert finds member 2 after the nested connect), batch rejects. In all three the BATCH route refuses what the tx route executes — i.e. the membership premise is asserted ahead of the write it must observe, instead of at the observation point. This is the same family as N3's 'a premise about an observation is asserted where the observation is taken', one level deeper.
- DISAGREEMENT: PRE-EXISTING, error identity across substrates. Cell "self to-many inverse update rejects the moved current row": both routes refuse and nothing commits, but tx raises V7001 "Cannot update relation 'children': target record was not found for this parent." (exactly rule 3's correlated refusal, = my derivation) while the batch route collapses it to V7006 "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target or ownership check) did not hold." Identical at base. Once the batch route carries the correlated refusal's identity, this cell needs re-expressing to the V7001 sentence (its current expectedError, UPDATE_MEMBERSHIP_ERROR, is a sentence N1 retires); I left it untouched because the measurement is ambiguous across substrates today.
- DISAGREEMENT: HARNESS NOTE for the integrator: the orchestrator's pre-existing-red list for this file (scratchpad/n1/pre-existing-red.json, taken from probe1 at 03:58) is two cells off against the real base. Measured against e772741eb with a clean src/ (main tree, byte-identical test file): "nested identity transition exports the exact final membership source" IS red at base (now green), and "same-node non-self FK rebind rejects inverse descent through the final target" is NOT red at base (green there, red now). The probes' conf-* runs predate the last engine edit (src/query-engine/raptor3/commands/commands.ts mtime 04:14:36, probe2's conf run 04:12). Also: run-shared-family.mjs passes `cwd` to startBoundedProcess, which never forwards it to spawn, so the child inherits the CALLER's cwd — which is how the base run in /Users/arnaud/code/viborm and the unit run in /private/tmp/viborm-n1 were both taken with the sanctioned runner, lock and RSS ceiling.
- unverified: The transaction-route END STATE of the three substrate-parity cells (self to-one inverse upsert…, non-self child-holds cascade…, nested physical membership …root upsert). The harness aborts at the rejected-parity assertion before dumping, and nested-write-conformance-fixtures.ts is not one of my write targets, so I could not surface it.
- unverified: The error `code` of the three re-expressed "Unique constraint violation" cells. Only the message is observable through the harness (the code prints only when the two substrates disagree, and here they matched); `expectedError` can pin a message substring only — the message is the whole string "Unique constraint violation".
- unverified: Whether the pre-existing parity breaks originate in the engine's batch lowering or in BatchOnlyPGliteDriver itself — not investigated (pre-existing, and outside this unit's frozen engine).
- unverified: Nothing outside this file was run: no sibling conformance suites, no tests/raptor3/g4/parity/ordered-observation.test.ts re-run, no typecheck, and no `pnpm test:all` (forbidden by the task).
- unverified: The base-commit measurement was taken by running the byte-identical file in /Users/arnaud/code/viborm (HEAD e772741eb, `git status --short src/` empty). I did not revert the worktree engine to double-check in-place, since it is frozen and shared with seven sibling agents.
- biome: `npx biome check tests/contracts/engine/query/nested-write-conformance-membership.test.ts` — BEFORE (HEAD copy at /private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/n1-membership/HEAD-copy.test.ts, identical to git HEAD): \"Checked 1 file in 12ms. No fi

## core-structure — {'re-expressed': 8, 'unchanged': 7}
final: structural-reference.test.ts: "Test Files 2 passed (2) / Tests 20 passed (20)" (10 cells x the |raptor3| and |coverage-raptor3| projects); Vitest resources: 5.35s wall, 539.0 MiB peak sampled process-group RSS. member-scope.contract.test.ts: "Test Files 2 passed (2) / Tests 16 passed (16)" (8 cells 

- [re-expressed] CS-01 member-major/read-major priority (sqlite-interactive) > "chooses member zero's later guard-observed active-arm conflict before member 
  before: DESIGN §6.2's veto, and WHICH of the two dependent connects was refused first: NestedWriteError NESTED_WRITE_FAILED, meta {relation 'lateTicket', operation 'connect', conflictsWith 'create'} (member-major: member zero's 
  derived: Rule 1-2: relations run in declaration order (bins, earlyHolders, lateHolders); the bins series creates ticket 'first' (b1, member 0) then 'second' (b2, member 1). Both connects are reads whose answer an earlier write of the same operation changes, and both consumers sit after the bins body, so each
  measured: Exactly the derivation: failure undefined, produced {id:'s1',label:'prefix'}, admissions [template 'other', member 'first', member 'second'], 2 ticket INSERTs then 2 ticket reads (dispatch indices 6,7 then 8,11), end state as derived.
- [re-expressed] CS-01 member-major/read-major priority (sqlite-atomic-batch) > same cell (lateFound = true)
  before: Same veto, plus the batch route's planning progress: meta.recordSeriesProgress {atomicity 'segment', phase 'planning', committedSegments 1, committedWriteMembers 1, completedMembers 0, memberPath [0], totalMembers 2}; sh
  derived: Same as the interactive cell (rule 6: the two substrates must agree on the end state). On the batch route each observation is read through the barrier — the queued unit goes with its premises and the read rides the same native batch behind the writes (rule 2/3), so the succession D-51 accepts replac
  measured: Identical to the interactive profile (reads at indices 18 and 23, after the INSERTs at 13 and 17; a requirePresent premise on tickets rides ahead of the late read in the same batch). End state and produced value identical to the live route.
- [re-expressed] CS-01 member-major/read-major priority (sqlite-interactive) > "reobserves the guard-observed absence, ignores that untaken arm, and reports 
  before: The same veto, reported for the OTHER member: meta {relation 'earlyTicket', operation 'connect', conflictsWith 'create'} — with the late target absent the untaken arm's connect raises nothing, so member one's earlier rea
  derived: The guard leaves an absent selection uncached, so the late choice reobserves 'missing' at its execution point and takes the create arm, which holds no connect and therefore opens NO observation. The only ordered observation is the early holder's connect on member one's ticket 'second'. End state: ti
  measured: Exactly the derivation: one ticket read only (index 8, after the two INSERTs at 6,7), then INSERT late_holders('missing','s1',NULL); produced {id:'s1',label:'prefix'}; admissions unchanged.
- [re-expressed] CS-01 member-major/read-major priority (sqlite-atomic-batch) > same cell (lateFound = false)
  before: Same veto with memberPath [1] and the same batch-route planning progress; shelf label 'prefix'.
  derived: As the interactive cell, with rule 6's parity: one end state on both substrates.
  measured: Identical to the interactive profile (one ticket read at index 18, after the INSERTs at 13 and 17).
- [re-expressed] CS-01 reconciles the whole body before authoritative contribution publication: agree-partial
  before: DESIGN §6.2's MEMBERSHIP veto, raised before any statement: NestedWriteError NESTED_WRITE_FAILED, meta {operation 'updateMany', conflictsWith 'upsert', relation 'kids'}, driver.statements.length === 0, nothing written (p
  derived: The consumer's membership lookup ('kids of the new pair, slug found') is answered by the upsert's earlier membership write, so under rule 2 it is an ordered observation: the capture leaves the capture phase and is taken after the upsert published the agreeing pa/pb contribution. Reconciliation itsel
  measured: First measurement contradicted the derivation with an internal Error "Selected series was not captured" — the cell's white-box scaffolding placed the selectedSeries WITHOUT the captureSeries that the public recipe always places beside it (RelationBody.requireSeriesCapture, relation-body.ts:698-723);
- [re-expressed] CS-01 reconciles the whole body before authoritative contribution publication: agree-reordered
  before: Identical to agree-partial (the cell's point is that the parent's key order does not change the answer): the same membership veto with meta {updateMany, upsert, kids} and no statement dispatched.
  derived: Identical to agree-partial: key order changes nothing, so the observation is taken after the same publication and the same member is updated.
  measured: Identical to agree-partial in every statement and row (same act completion applied — the capture is placed inside the shared helper executeReconciliationPublication).
- [unchanged] CS-01 reconciles the whole body before authoritative contribution publication: agree-complete
  before: Success, value {a:'north', b:'west', label:'parent'}; pairs both rows, kid {target, found, 'first', north, west}. Runs the public create, not the synthetic consumer.
  derived: Untouched by N1: no second consumer, so no dependent read. Same success and rows.
  measured: Green throughout (the expected values are byte-identical; only the surrounding ternaries were re-pivoted from 'agree-complete ? A : B' to 'conflict ? B : A' so the two re-expressed cells can share the executed rows).
- [unchanged] CS-01 reconciles the whole body before authoritative contribution publication: conflict
  before: UnsupportedOperationError matching /owns 'pa, pb'/; nothing written (pairs [old/pair/old], kid stored/old/pair).
  derived: Untouched by N1: the reconciliation refusal names an authority fact, not a dependency (D-52 keeps it).
  measured: Green throughout, same error and same rows.
- [unchanged] CS-01 Selection observation identity versus occurrence identity > observes one present Selection once across two ordered placements
  before: Statements ['SELECT','INSERT'] — a present Selection is observed once across a before- and an after-placement.
  derived: No dependency: the selection's answer is not changed by the record's own write (disjoint, rule 2's first case), so nothing moves and the positive cache still answers the later placement.
  measured: Green, unchanged.
- [unchanged] CS-01 Selection observation identity versus occurrence identity > reobserves an absent Selection at its later placement after a producer
  before: Statements ['SELECT','INSERT','SELECT'] and the created row.
  derived: Unchanged: an absent selection keeps no cache and is reobserved at its later placement — the same shape N1 generalises, already expressed here.
  measured: Green, unchanged.
- [re-expressed] CS-03 peer member scope (sqlite-interactive) > cs03-peer-scope-surrounding
  before: DESIGN §6.2's veto: outcome failure, NestedWriteError code V7001, meta {relation 'artifacts', operation 'update', conflictsWith 'create'}; forbiddenWrite === false (the surrounding update must not run); final === initial
  derived: The surrounding read's selector ('lookup' = 'shared', admitted in check c1's member scope) names the very row the nested branch's member n2 creates, and the groups body runs before the probes body (declaration order), so under rule 2 it is an ordered observation taken after those creates: the update
  measured: Exactly the derivation: outcome success {id:'root'}, the two artifacts with 'shared' carrying 'must-not-run', the forbidden write dispatched after the last writer effect and after its own member-scope admission, and every recorded scope-order assertion still true with the same admissions list.
- [re-expressed] CS-03 peer member scope (sqlite-atomic-batch) > cs03-peer-scope-surrounding
  before: Same veto and meta; final.artifacts [safe/expanded-write, shared/expanded-write] — the creates had committed in an earlier segment before the planning refusal.
  derived: Same as the live route (rule 6): one end state on both substrates, now including the dependent update.
  measured: Identical to the interactive profile — outcome success {id:'root'} and the same two rows; the profile branch in the expectation disappears (a strengthening for the live route, which now pins two rows instead of 'unchanged').
- [unchanged] CS-03 peer member scope (sqlite-interactive | sqlite-atomic-batch) > cs03-peer-scope-root
  before: Success {count: 2}; three audit-id admissions before the first write; nodes/audits rows as recorded.
  derived: No dependent read (the audits create names no row an earlier write changes), so N1 does not reach this cell.
  measured: Green in both profiles, unchanged.
- [unchanged] CS-03 peer member scope (sqlite-interactive | sqlite-atomic-batch) > cs03-peer-scope-nested
  before: Success {count: 2}; one shared target created and both nodes pointing at it; capture:n1 < admit:n1 < effect:target-create < capture:n2 < admit:n2.
  derived: The second member's connectOrCreate is first-create-wins inside one relation body (the established-producer case the contract already had), not a dependency the veto ever touched.
  measured: Green in both profiles, unchanged.
- [unchanged] CS-03 peer member scope (sqlite-interactive | sqlite-atomic-batch) > cs03-peer-scope-static
  before: Success {id:'board'}; one author, two posts pointing at it.
  derived: A static createMany series with a provable local producer: unchanged by N1.
  measured: Green in both profiles, unchanged.
- unverified: ACT CHANGE NEEDING THE INTEGRATOR'S REVIEW (not an expectation change, not a seed change): in `executeReconciliationPublication` (structural-reference.test.ts) I added the `captureSeries` placement that the public recipe always places beside a `selectedSeries` (`RelationBody.requireSeriesCapture`, src/query-engine/raptor3/commands/relation-body.ts:698-723). Without it the frozen engine throws its 
- unverified: The whole-estate typecheck (`node scripts/run-typecheck.mjs`, ~4.5 GB) was NOT run — seven other agents share this machine. Instead I typechecked a two-file program over the same tsconfig (scratch config in TMPDIR, 2.0 GB peak, 2 s): zero diagnostics in either owned file; the only errors reported were 9 pre-existing `StandardSchemaOf` TS2724s in src/schema/scalars/*, an artifact of the scratch con
- unverified: The batch route's planning progress meta (`recordSeriesProgress` {committedSegments: 1, memberPath: [...]}) that the CS-01 priority cell used to pin exists only on a failure, so it no longer has a home in this file; I did not relocate it. Per plan §1 the unit's own pin file tests/raptor3/g4/parity/ordered-observation.test.ts owns `committedSegments` for the ordered observation — worth the integrat
- unverified: Both owned files are SQLite-only (better-sqlite3 in-memory, the two structural profiles); no PGlite/conformance parity leg applies to them, so rule 6's tx-versus-batch agreement is witnessed here only by the two SQLite profiles reaching the same end state, which I did assert.
- biome: Before (HEAD copies, `npx biome check --max-diagnostics=200`): structural-reference.test.ts 16 — 1 assist/source/organizeImports, 4 lint/performance/useTopLevelRegex, 11 lint/suspicious/noMisplacedAssertion; member-scope.contract.test.ts 38 — 38 lint/suspicious/noMisplacedAssertion. After: structura

## g29 — {'re-expressed': 11, 'unchanged': 16, 'disagreement': 1}
final: Combined final run (node scripts/run-vitest-safe.mjs on the three files, TMPDIR=/private/tmp/viborm-n1-g29-tmp): " Test Files 2 failed | 4 passed (6)" / " Tests 2 failed | 54 passed (56)". Per file (each file is collected twice, by the `raptor3` and `coverage-raptor3` vitest projects, so N tests = 2

- [re-expressed] g29-member-dependency · exact selected-member dependency (sqlite-interactive) > "template wanted refuses before capture" -> "template wanted
  before: DESIGN §6.2's mode-independent veto: NestedWriteError "Nested operation 'update' on relation 'tickets' depends on an earlier 'create' target write in the same nested write. Split these operations into separate queries.",
  derived: Rule 1/2: shelf UPDATE (label 'prefix') runs, then relation `bins` (declaration order) whose updateMany member create inserts a ticket with the MEMBER-admitted id 'other2' on bin b1 (shelfId null), then relation `tickets` whose `update where {id:'wanted'}` is a dependent read taken AFTER that create
  measured: NestedWriteError "Cannot update relation 'tickets': target record was not found for this parent.", meta {relation:'tickets'}; admissions [{template,'wanted'},{member,'other2'}]; shelfWrite true, ticketWrite true; shelves [{s1,'initial'}], tickets []. Identical through the client route (`engine: "shi
- [re-expressed] g29-member-dependency · exact selected-member dependency (sqlite-atomic-batch) > "template wanted refuses before capture" -> renamed as abov
  before: Same veto; on the batch profile no recordSeriesProgress was expected (the template-wanted arm passed `undefined`), refusal before any statement, shelves 'initial', tickets [].
  derived: Same as the live derivation, except that the barrier before the dependent read commits the preceding segment (D-51's succession of statements), so the shelf prefix and the member's created ticket stay durable and the refusal carries the progress record.
  measured: Same message; meta {relation:'tickets', recordSeriesProgress:{atomicity:'segment', phase:'member', committedSegments:2, completedMembers:1, committedWriteMembers:2}}; shelves [{s1,'prefix'}], tickets [{id:'other2',note:'created',binId:'b1',shelfId:null}]. Identical through the client route.
- [re-expressed] g29-member-dependency · exact selected-member dependency (sqlite-interactive) > "actual member wanted refuses before member effects" -> "act
  before: Same veto with meta.recordSeriesProgress {phase:'planning', memberPath:[0], totalMembers:1, committedSegments:1, committedWriteMembers:1} on the batch profile; ticketWrite asserted FALSE ("Dependency refusal must precede
  derived: The member admission makes the create's id 'wanted'; the create runs on bin b1 (shelfId null); the dependent `tickets.update where {id:'wanted'}` observes after it, finds no member of shelf s1, rule 3 refuses, live route rolls back.
  measured: "Cannot update relation 'tickets': target record was not found for this parent.", meta {relation:'tickets'}; admissions [{template,'other'},{member,'wanted'}]; ticketWrite true; shelves [{s1,'initial'}], tickets [].
- [re-expressed] g29-member-dependency · exact selected-member dependency (sqlite-atomic-batch) > "actual member wanted refuses before member effects" -> ren
  before: Same veto, phase 'planning', committedSegments 1, committedWriteMembers 1, memberPath [0], totalMembers 1; tickets [] at the end.
  derived: As above plus the committed segment: shelf prefix and the created ticket durable.
  measured: Same message; meta {relation:'tickets', recordSeriesProgress:{atomicity:'segment', phase:'member', committedSegments:2, completedMembers:1, committedWriteMembers:2}}; shelves [{s1,'prefix'}], tickets [{id:'wanted',note:'created',binId:'b1',shelfId:null}].
- [re-expressed] g29-member-dependency · exact selected-member dependency (sqlite-interactive) > "later actual member wanted refuses before either member" ->
  before: Same veto with memberPath [1], totalMembers 2, committedSegments 1, committedWriteMembers 1 on the batch profile; ticketWrite false; tickets [].
  derived: Both bin members' creates run (ids 'second' on b1, 'wanted' on b2, both shelfId null), then the dependent lookup observes and finds no shelf member 'wanted'; rule 3 refuses; live route rolls back.
  measured: "Cannot update relation 'tickets': target record was not found for this parent.", meta {relation:'tickets'}; admissions [{template,'other'},{member,'second'},{member,'wanted'}]; ticketWrite true; shelves [{s1,'initial'}], tickets [].
- [re-expressed] g29-member-dependency · exact selected-member dependency (sqlite-atomic-batch) > "later actual member wanted refuses before either member" -
  before: Same veto, phase 'planning', committedSegments 1, committedWriteMembers 1, memberPath [1], totalMembers 2; tickets [].
  derived: As above plus two committed member segments.
  measured: Same message; meta {relation:'tickets', recordSeriesProgress:{atomicity:'segment', phase:'member', committedSegments:3, completedMembers:2, committedWriteMembers:3}}; shelves [{s1,'prefix'}], tickets [{id:'second',note:'created',binId:'b1',shelfId:null},{id:'wanted',note:'created',binId:'b2',shelfId
- [unchanged] g29-member-dependency · exact selected-member dependency (sqlite-interactive) > "disjoint actual member preserves an independent wanted upda
  before: Success: value {s1,'prefix'}; shelves [{s1,'prefix'}]; tickets [{other2,'created',b1,null},{wanted,'looked-up',null,s1}].
  derived: Disjoint lookup (rule 2, the capture-phase read is unchanged): unaffected by N1.
  measured: Unchanged, green.
- [unchanged] g29-member-dependency · exact selected-member dependency (sqlite-atomic-batch) > "disjoint actual member preserves an independent wanted upd
  before: Same success end state.
  derived: Unaffected by N1.
  measured: Unchanged, green.
- [unchanged] g29-member-dependency · self-relation occurrence roles (sqlite-interactive) > "keeps disjoint writes separate even when every occurrence has
  before: Success: root 'prefix', a created node 'other2' under branch's watches, 'wanted' relabelled 'looked-up'.
  derived: Disjoint occurrences; no dependent read; unaffected by N1.
  measured: Unchanged, green.
- [unchanged] g29-member-dependency · self-relation occurrence roles (sqlite-atomic-batch) > "keeps disjoint writes separate even when every occurrence ha
  before: Same success end state.
  derived: Unaffected by N1.
  measured: Unchanged, green.
- [re-expressed] g29-member-dependency · nested selected-series dependency (sqlite-atomic-batch) > "keeps an inner unresolved dependency until the inner capt
  before: DESIGN §6.2's veto "Nested operation 'update' on relation 'notes' depends on an earlier 'create' target write in the same nested write. Split these operations into separate queries.", meta {conflictsWith:'create',operati
  derived: Rules 1/5: bin b1's own UPDATE, then relation `tickets` (declared before `notes`) whose inner updateMany member creates a note with the inner-member-admitted id 'wanted' — the seeded note's own primary key. The INSERT executes and the database's integrity answer is the operation's failure; the batch
  measured: UniqueConstraintError "Unique constraint violation"; admissions ['other','other','wanted']; noteWrite true; shelves [{s1,'prefix'}], bins [{b1,'outer-member',s1}], notes [{wanted,'independent',null,b1}]. Statement probe: the inner INSERT names ("id","text","binId","ticketId").
- [disagreement] g29-member-dependency · nested selected-series dependency (sqlite-interactive) > "keeps an inner unresolved dependency until the inner captu
  before: Same veto (no recordSeriesProgress on the live profile), noteWrite false, shelves 'initial', bins 'bin', the seeded note untouched.
  derived: Same inner create executes with id 'wanted' and duplicates the seeded note; rule 5's answer is UniqueConstraintError with the transaction rolled back (shelves 'initial', bins 'bin', note untouched), and the three admissions of the single plan.
  measured: NotNullConstraintError "Not-null constraint violation"; admissions ['other','other','wanted',undefined,undefined] (FIVE); shelves 'initial', bins 'bin', note untouched. Statement probe shows the whole plan running TWICE: statements 1-8 end in INSERT INTO g29_nested_notes ("id","text","binId","ticket
- [unchanged] g29-member-dependency · published-parent dependency (sqlite-interactive) > "lets a member lookup consume its already-published parent values
  before: Success: value {s1,'code-1','prefix'}; ticket t1 note 'member-used-parent'.
  derived: No dependent read (the parent's published value is a producer reference, N1 case 2); unaffected.
  measured: Unchanged, green.
- [unchanged] g29-member-dependency · published-parent dependency (sqlite-atomic-batch) > "lets a member lookup consume its already-published parent value
  before: Same success end state.
  derived: Unaffected by N1.
  measured: Unchanged, green.
- [re-expressed] g29-dependency-choices · dependency choice locality (sqlite-interactive) > "refuses the same conflicting lookup when its create arm is taken
  before: DESIGN §6.2's veto "Nested operation 'connect' on relation 'ticket' depends on an earlier 'create' target write in the same nested write. Split these operations into separate queries.", meta {conflictsWith:'create',opera
  derived: Rule 4 does NOT apply: the producer (the `bins.updateMany` ticket create) runs BEFORE the holder's own write, not after it, so this parent-held lookup is an ordered observation (rule 2), not a read the parent's own write consumes. The upsert probes h2, misses, takes the create arm, whose `ticket: {c
  measured: No failure; value {id:'s1',label:'prefix'}; admissions [{template,'other'},{member,'wanted'}]; shelfUpdate true, ticketInsert true, holderInsert true, holderUpdate false; shelves [{s1,'prefix'}]; tickets [{wanted,'created',b1}]; holders [{h1,'initial',s1,null},{h2,'missing',s1,'wanted'}]. Exactly th
- [re-expressed] g29-dependency-choices · dependency choice locality (sqlite-atomic-batch) > "refuses the same conflicting lookup when its create arm is take
  before: Same veto with recordSeriesProgress {phase:'member', committedSegments:2, committedWriteMembers:2, completedMembers:1}; shelves 'prefix'; tickets [{wanted,'created',b1}]; holders only h1.
  derived: Same as the live derivation; both substrates must reach the same end state (rule 6).
  measured: Identical to the live substrate, including holders [{h1,...},{h2,'missing',s1,'wanted'}] — the two substrates agree.
- [unchanged] g29-dependency-choices · dependency choice locality (sqlite-interactive) > "ignores a conflicting lookup in an untaken create arm"
  before: Success: label 'found' on h1, ticket 'wanted' created, no holder INSERT.
  derived: Locality of the untaken Choose arm is unchanged by N1 (`commands.ts` Choose arms / activeRefusal walked by plan §1).
  measured: Unchanged, green.
- [unchanged] g29-dependency-choices · dependency choice locality (sqlite-atomic-batch) > "ignores a conflicting lookup in an untaken create arm"
  before: Same success end state.
  derived: Unaffected by N1.
  measured: Unchanged, green.
- [unchanged] g29-dependency-choices · dependency choice locality (sqlite-interactive) > "preserves the selected update when the untaken arm has no lookup
  before: Same success end state (control for the arm with no lookup).
  derived: Unaffected by N1.
  measured: Unchanged, green.
- [unchanged] g29-dependency-choices · dependency choice locality (sqlite-atomic-batch) > "preserves the selected update when the untaken arm has no looku
  before: Same success end state.
  derived: Unaffected by N1.
  measured: Unchanged, green.
- [unchanged] g29-dependency-choices · one-arm dependency locality (sqlite-interactive) > "ignores a conflicting lookup in an untaken found body"
  before: "Cannot update relation 'holders': target record was not found for this parent.", meta {relation:'holders'}; no holder statement; shelves 'initial'; tickets [] (rolled back).
  derived: The `holders.update where {id:'h2'}` lookup overlaps no earlier write (holders are untouched), so it stays a capture-phase read (rule 2, disjoint) and rule 3's correlated refusal is unchanged; the nested connect inside the never-run found body is still local.
  measured: Unchanged, green.
- [unchanged] g29-dependency-choices · one-arm dependency locality (sqlite-atomic-batch) > "ignores a conflicting lookup in an untaken found body"
  before: Same message with recordSeriesProgress {phase:'member', committedSegments:2, committedWriteMembers:2, completedMembers:1}; shelves 'prefix'; tickets [{wanted,'created',b1}] (committed segment).
  derived: Unchanged by N1, including the committed segment already recorded.
  measured: Unchanged, green.
- [unchanged] g29-dependency-choices · one-arm dependency locality (sqlite-interactive) > "preserves missing-target behavior when the untaken body has no 
  before: Same missing-holder refusal, control without the nested connect.
  derived: Unaffected by N1.
  measured: Unchanged, green.
- [unchanged] g29-dependency-choices · one-arm dependency locality (sqlite-atomic-batch) > "preserves missing-target behavior when the untaken body has no
  before: Same missing-holder refusal with the same progress record.
  derived: Unaffected by N1.
  measured: Unchanged, green.
- [re-expressed] g29-dependency-boundaries · dependency boundaries (sqlite-interactive) > "refuses an actual member lookup that conflicts with an earlier sib
  before: DESIGN §6.2's veto "Nested operation 'update' on relation 'tickets' depends on an earlier 'create' target write in the same nested write. Split these operations into separate queries.", meta {conflictsWith:'create',opera
  derived: Rules 1/2: shelf UPDATE 'prefix', then relation `tickets` (declared first) creates ticket 'created' with lookupKey 'wanted', binId b1, shelfId s1; then relation `bins`, whose member b1 carries `tickets.update where {lookupKey:<member-admitted 'wanted'>}` — a dependent read taken after that create. I
  measured: No failure; value {id:'s1',label:'prefix'}; admissions [{template,'raw-member-lookup','other'},{member,'raw-member-lookup','wanted'}]; shelfWrite true, ticketInsert true, ticketUpdate true; shelves [{s1,'prefix'},{s2,'decoy'}]; tickets [{id:'created',lookupKey:'wanted',note:'member-effect',binId:'b1
- [re-expressed] g29-dependency-boundaries · dependency boundaries (sqlite-atomic-batch) > "refuses an actual member lookup that conflicts with an earlier si
  before: Same veto with recordSeriesProgress {phase:'planning', committedSegments:1, committedWriteMembers:1, completedMembers:0, memberPath:[0], totalMembers:1}, and shelves [{s1,'prefix'},...] — i.e. this cell WAS the file's me
  derived: Identical to the live derivation; both substrates succeed and agree (rule 6). The old committed-segment-under-a-refusal measurement is no longer reachable in this shape, because there is no planning refusal left here.
  measured: Identical to the live substrate, byte for byte in the diagnostic.
- [unchanged] g29-dependency-boundaries · dependency boundaries (sqlite-interactive) > "admits only the template and preserves a later sibling after an em
  before: Success: only the template admitted; value {s1,'prefix'}; ticket 'existing' note 'looked-up'; no ticket INSERT.
  derived: Empty capture: no member, no dependent read; unaffected by N1.
  measured: Unchanged, green.
- [unchanged] g29-dependency-boundaries · dependency boundaries (sqlite-atomic-batch) > "admits only the template and preserves a later sibling after an e
  before: Same success end state.
  derived: Unaffected by N1.
  measured: Unchanged, green.
- DISAGREEMENT: DISAGREEMENT 1 — a plain create's duplicate key spends D-25's one recovery on the LIVE route only, so the two substrates no longer agree (rule 6). Cell: /private/tmp/viborm-n1/tests/raptor3/post-prep/g29-member-dependency.test.ts, `G2.9 nested selected-series dependency [commands] (sqlite-interactive) > keeps an inner unresolved dependency until the inner capture` (helper `runNestedSeriesRefusal`, line ~807). NOT re-expressed; the recorded expectation and the cell name stand. DERIVATION (before measuring): the payload is shelf.update{label,bins.updateMany[b1]{label:'outer-member', tickets.updateMany[t1]{notes.create{text:'created'}}, notes.update where {id:'wanted'}}}. `bin.tickets` is declared before `bin.notes`, so the inner ticket member's note create runs first; its id default is admitted at the inner member scope as 'wanted', which is the seeded note's own primary key. Rule 5: the executed INSERT's unique violation is the operation's failure — UniqueConstraintError, transaction rolled back on the live route (shelves 'initial', bins 'bin', the seeded note untouched), with the plan's three admissions ['other','other','wanted']. MEASURED, batch substrate (sqlite-atomic-batch, BoundaryBatch-style driver, no region): exactly the derivation — UniqueConstraintError 'Unique constraint violation', admissions ['other','other','wanted'], shelves [{s1,'prefix'}], bins [{b1,'outer-member','s1'}], notes [{wanted,'independent',null,b1}]. MEASURED, live substrate (sqlite-interactive): NotNullConstraintError 'Not-null constraint violation', admissions ['other','other','wanted',undefined,undefined] (FIVE), everything rolled back. A statement probe (temporary `PROBE_statements` dump of driver.statements, since reverted) shows the WHOLE plan running twice: statements 1-8 end in `INSERT INTO "g29_nested_notes" ("id","text","binId","ticketId") VALUES (?,?,NULL,?)` (the duplicate 'wanted'); statements 9-16 re-run shelf SELECT/UPDATE, bin SELECT/UPDATE, ticket SELECT and end in `INSERT INTO "g29_nested_notes" ("text","binId","ticketId") VALUES (?,NULL,?)` — no id column, because the re-plan asked the id default again and this cell's three-value stub answered `undefined`. CODE SITES: src/query-engine/raptor3/shared/operation-context.ts:2333-2341 (`insert`, the non-batch path) records `attempt.rejectedInsert = {error, producer}` for ANY UniqueConstraintError from an insert that has a producer — no `missingChoices`/selected-constraint condition; :1391-1412 `recoveryRejection` t
- unverified: Each file is collected twice, by the `raptor3` and the `coverage-raptor3` vitest projects, so vitest's "Tests N" counts are 2 x the number of cells (14 + 10 + 4 = 28 cells -> 56 tests). Every cell figure in this report is per cell, not per test.
- unverified: I ran only my three files (and, once, the whole-estate typecheck). I did not run the PGlite conformance suites, `tests/raptor3/g4/parity/ordered-observation.test.ts`, `tests/raptor3/post-prep/native-g29-member-dependency.test.ts` (which the runner's path filter also collects when given a bare `g29-member-dependency` substring — I always passed the full path, and its 14 cells are not mine), or pnpm
- unverified: The `engine: "shipped"` leg of the three re-expressed matrix cells (`client.shelf.update`, run only when template === 'wanted') now answers IDENTICALLY to `createCommandEngine` on both profiles — I verified this with a temporary probe (since reverted) and then asserted the single full expectation for both legs, which is strictly stronger than the retired `assertShippedDependencyFailure` regex it r
- unverified: The committed-segment measurement that `src/query-engine/raptor3/AGENTS.md` attributes to `g29-dependency-boundaries.test.ts` ("a capture flushes, and on the batch route a flush COMMITS everything queued before it ... a planning refusal the capture then raises can no longer undo it") is no longer observable in that file: with N1 the cell succeeds on both substrates, so nothing is left uncommitted.
- unverified: One cosmetic, meaning-preserving touch inside the NOT-re-expressed live nested-series cell: its two `profile === "sqlite-atomic-batch" ? A : B` label ternaries were hoisted VERBATIM into two consts above the new batch branch (`expectedShelfLabel`, `expectedBinLabel`). This was required because the batch branch's early `return` narrows `profile` and would otherwise make those in-place comparisons a
- unverified: `tests/raptor3/post-prep/history-analysis.test.ts` appeared as modified in the worktree partway through my run. It is not one of my files and I never opened or wrote it; another agent owns it.
- unverified: Originals of my three files are preserved at /private/tmp/viborm-n1-g29-tmp/backup/*.test.ts.orig; run logs and the two temporary probes' output are under /private/tmp/viborm-n1-g29-tmp/ (run-member-1/2/3.txt, run-choices-1/2.txt, run-bound-1/2.txt, run-final.txt, probe-nested.txt, probe-shipped.txt, typecheck.txt). Both probe instrumentations were reverted before the final runs. Nothing was commi
- biome: "npx biome check --max-diagnostics=500 <file>" on each file, BEFORE (worktree files were pristine at HEAD e772741eb, so the HEAD copy and the before state are the same bytes) and AFTER. No formatter was ever run on these files; formatting was written by hand and verified non-destructively with `npx 

## transitions — {'re-expressed': 5, 'disagreement': 1, 'unchanged': 3}
final: Combined (all four wrappers, one vitest process, both projects `raptor3` + `coverage-raptor3`, both profiles): "Tests 8 failed | 200 passed (208)" / "Test Files 4 failed | 4 passed (8)" / "Vitest resources: 5.70s wall, 728.7 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown ver

- [re-expressed] g2-own-delete-update-refused (own-write.ts)
  before: DESIGN §6.2's mode-independent veto: NestedWriteError V7001 "Nested operation 'update' on relation 'notes' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate querie
  derived: Canonical to-many order runs `delete` (2nd) before `update` (3rd): the delete removes note 801, and the update's lookup is an ordered observation taken after it, finding nothing. Rule 3 -> the relation body's correlated refusal "Cannot update relation 'notes': target record was not found for this pa
  measured: sqlite-interactive: exactly as derived — NestedWriteError V7001, that message, meta {relation:'notes'}, final == initial, and SQL order [SELECT author][SELECT note 801 for parent (the delete's disjoint planning read)][UPDATE authors SET name][DELETE note 801][SELECT note 801 for parent -> empty]. sq
- [re-expressed] g2-own-update-coc-refused (own-write.ts)
  before: DESIGN §6.2's veto: NestedWriteError V7001 "Nested operation 'connectOrCreate' on relation 'notes' depends on an earlier 'update' target write in the same nested write. Split these operations into separate queries.", fin
  derived: Canonical order runs `update` (3rd) before `connectOrCreate` (5th): the update renames member 802 to body "changed"; the conditional's lookup observes after it, finds 802, connects the member it found and mints nothing (the `create: {id:802, body:"never"}` arm is not taken). Success, value {id:1,ema
  measured: Exactly as derived on BOTH profiles. Cell GREEN.
- [disagreement] g2-own-coc-set-same (own-write.ts)
  before: DESIGN §6.2's veto: NestedWriteError V7001 "Nested operation 'set' on relation 'notes' depends on an earlier 'connectOrCreate' target write in the same nested write. Split these operations into separate queries.", final 
  derived: Canonical order runs `connectOrCreate` (5th) before `set` (6th): COC mints note 905 (body "adopted-905") and connects it; `set: [{id:905}]` then observes 905 and makes the membership EXACTLY {905}, so 801, 802 and 804 leave (authorId null). Success; notes = [801/null, 802/null, 803/null, 804/null, 8
  measured: Success, but the departing members KEEP their membership: notes = [801/1, 802/1, 803/null, 804/1, 899/2, 905/1]. Cause, from the dispatched SQL: the set's removal leg is UPDATE "g2_own_notes" SET "authorId" = NULL WHERE ("authorId" = ? AND NOT ("id" = NULL)) with params [1] — the retained member's k
- [unchanged] g2-own-filter-write-refused (own-write.ts)
  before: NestedWriteError V7001 "Nested operation 'update' on relation 'badge' depends on an earlier 'update' target write in the same nested write. Split these operations into separate queries.", final == initial, refusal preced
  derived: Not derived — the cell was green under the frozen engine, so the ruling did not change its answer (the read is one the enclosing own write consumes, rule 4).
  measured: Green on both profiles, unchanged.
- [re-expressed] g2-own-membership-disconnect (membership-own-write.ts)
  before: DESIGN §6.2's veto: NestedWriteError V7001 "Nested operation 'upsert' on relation 'children' depends on an earlier 'disconnect' membership write in the same nested write. Split these operations into separate queries.", m
  derived: `parent` is parent-held, so `parent: { disconnect: true }` contributes its null literals to the record's OWN write, which runs before the child relation's `after` phase. The `children.upsert` then looks up its global target (node 910 still exists) and requires the membership captured AFTER the disco
  measured: sqlite-interactive: exactly as derived (message, code, meta, cause, final == initial, carrier cleared first). SQL: [SELECT node 910][UPDATE nodes SET parent_type=NULL,parent_id=NULL WHERE id=910][SELECT node 910][SELECT nodes WHERE parent_type='tree.node.v1' AND parent_id=910 AND id=910 -> empty]. s
- [unchanged] g2-own-membership-connect (membership-own-write.ts)
  before: NestedWriteError V7001 "Nested operation 'upsert' on relation 'parent' depends on an earlier 'connect' membership write in the same nested write. Split these operations into separate queries.", meta {operation:'upsert', 
  derived: Not derived — green under the frozen engine: the upsert's read is one the record's own write CONSUMES (rule 4), so the inherited sentence stays. Its assertion text is preserved verbatim, only re-shaped so the disconnect cell can branch beside it.
  measured: Green on both profiles, unchanged expectation.
- [re-expressed] g2-child-delete-connect-modify-refused (singular.ts)
  before: DESIGN §6.2's veto: NestedWriteError V7001 "Nested operation 'update' on relation 'badge' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries.", final == ini
  derived: Canonical to-one order runs `delete`, `connect`, `update`: the lax delete removes the incumbent b1, the connect adopts b-alt (stationId='s1'), and the selector-free modifier is correlated to the parent — its lookup is an ordered observation naming the member the connect established, so b-alt.tag bec
  measured: Exactly as derived on BOTH profiles. Cell GREEN. (The payload keeps its recorded spelling `tag: "never"`; that name belonged to the retired veto.)
- [unchanged] g2-parent-delete-connect-refused (singular.ts)
  before: NestedWriteError V7001 "Nested operation 'connect' on relation 'depot' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries."
  derived: Not derived — green under the frozen engine, and it is the shape rule 4 names: a read the parent's own write consumes (the parent-held depotId). It is the same shape the unit's own pin file asserts.
  measured: Green on both profiles, unchanged.
- [re-expressed] g2-lattice-delete-connect-update (singular-lattice.ts)
  before: Recipe outcome "own-write": NestedWriteError V7001 "Nested operation 'update' on relation 'badge' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries.", badg
  derived: Same shape as the singular cell above: `delete` removes incumbent b1, `connect` adopts b-alt, the selector-free `update` observes the adopted member and sets tag 'u'. New FinalState "delete-adopt-modify": badges = [{b-alt,'u','s1'}, {b-foreign,'untouched-foreign','s9'}, {b-free,'untouched-free',null
  measured: Exactly as derived on BOTH profiles. Cell GREEN. The table's fourth outcome kind, "own-write", is now reached by no arm combination of this lattice and was removed with its assert branch (D-51 named in a comment at the type).
- DISAGREEMENT: DEFECT 1 — the `set` removal leg loses the retained key when the retained member is the one an earlier sibling produced (`g2-own-coc-set-same`, RED on sqlite-interactive AND sqlite-atomic-batch, both vitest projects). Reproduce: cd /private/tmp/viborm-n1 && TMPDIR=/private/tmp/viborm-n1-transitions-tmp node scripts/run-vitest-safe.mjs run tests/raptor3/transitions/own-write-commands.test.ts. Payload: author.update({where:{id:1}, data:{name:'root-effect', notes:{ set:[{id:905}], connectOrCreate:[{where:{id:905}, create:{id:905, body:'adopted-905'}}] }}}). Canonical order runs connectOrCreate then set. Emitted SQL: UPDATE "g2_own_notes" SET "authorId" = NULL WHERE ("authorId" = ? AND NOT ("id" = NULL)) with params [1] — the retained member's key is the SQL literal NULL, so `NOT (id = NULL)` is NULL and the removal matches nothing; members 801, 802, 804 keep authorId 1. The green sibling g2-own-coc-set-distinct (set:[{id:801}], a key no sibling produces) emits the same statement correctly: ... AND NOT ("id" = ?) with params [1,801]. Derived end state: notes = [801/null, 802/null, 803/null, 804/null, 899/2, 905 'adopted-905'/1], outcome success. Measured end state (identical on both substrates, so the tx-vs-batch parity check is blind to it): notes = [801/1, 802/1, 803/null, 804/1, 899/2, 905 'adopted-905'/1]. My reading: the engine is wrong — this is N1's established-producer/ordered-observation seam failing to carry the observed key into the set's exclusion predicate, and it fails SILENTLY (a predicate no row satisfies) rather than as a refusal, which is the worst failure mode for a membership verb. Per brief rule (e) the cell's recorded expectation was left UNCHANGED; the exact re-expression to install once the predicate carries the key is written in the comment beside `setSame` in tests/raptor3/transitions/own-write.ts.
- DISAGREEMENT: DEFECT 2 — the batch route loses the correlated refusal's identity to the N3 assertion floor (`g2-own-delete-update-refused`, GREEN on sqlite-interactive, RED on sqlite-atomic-batch). Same reproduce command. Payload: author.update({where:{id:1}, data:{name:'root-effect', notes:{ update:[{where:{id:801}, data:{body:'never'}}], delete:[{id:801}] }}}). Both routes agree on the end state (nothing commits) and on the class (NestedWriteError). Live: code V7001, message "Cannot update relation 'notes': target record was not found for this parent.", meta {relation:'notes'}, cause undefined. Batch: code V7006 (NESTED_WRITE_ASSERTION_FAILED), message "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target or ownership check) did not hold.", meta {relation:''}, plus a redacted cause chain. The batch's completed statements show the ladder re-probing after the abort — SELECT id FROM g2_own_authors WHERE (id=1 AND id=1) and SELECT id FROM g2_own_notes WHERE (authorId=1 AND id=801 AND id=801) — which, run after the segment rolled back, finds note 801 present again and therefore cannot attribute the rejection to the premise that failed. That is a premise whose truth depends on an earlier write of the SAME batch: it is not re-probable after a rollback. My reading: the engine is wrong — brief rule 3 gives one correlated refusal for this fact and ELEGANCE requires error identity to survive the transport; this is the same family as plan §5 C's "the batch route's typed errors lost to QueryError". The cell now pins the derived (live-verified) answer on both profiles and stays red on batch.
- DISAGREEMENT: DEFECT 3 (or an authorised packaging difference the brief's rule 6 forbids me to pin) — the two substrates disagree on the END STATE when a dependent membership observation follows the record's own write (`g2-own-membership-disconnect`, GREEN on sqlite-interactive, RED on sqlite-atomic-batch). Reproduce: TMPDIR=/private/tmp/viborm-n1-transitions-tmp node scripts/run-vitest-safe.mjs run tests/raptor3/transitions/membership-own-write-commands.test.ts. Payload: node.update({where:{id:910}, data:{ children:{ upsert:{where:{id:910}, create:{id:911,label:'must not create'}, update:{label:'must not update'}} }, parent:{disconnect:true} }}). Both routes raise the same failure (NestedWriteError V7001 "Cannot upsert relation 'children': target record was not found for this parent."). Live: the transaction rolls back, node 910 keeps parent_type='tree.node.v1'/parent_id=910. Batch: the barrier's batch — [assert node 910 exists][UPDATE g2_membership_nodes SET parent_type=NULL, parent_id=NULL WHERE id=910][SELECT node 910] — COMMITS, and the dependent membership read is then dispatched OUTSIDE any batch (inTx=false), so the disconnect is durable: node 910 ends with parent_type=NULL/parent_id=NULL, and the failure meta additionally carries recordSeriesProgress {atomicity:'segment', phase:'member', committedSegments:1, completedMembers:0, committedWriteMembers:1}. Note the tension the integrator must resolve: AGENTS.md:986-996 says the dependent read rides IN the write's batch with its `required` row as a premise "so an absent target aborts the batch before anything commits" (which is what DEFECT 2's cell measures), while the AGENTS.md paragraph at :1016-1019 and plan §1 case 3 say a dependent observation on a batch-only transport COMMITS the segment before it and reports it as progress (which is what this cell measures). Brief rule 6 ("the tx substrate and the batch substrate must agree on the end state; a disagreement is a DEFECT, not something to pin") is why I did not make `final` profile-dependent. The cell pins the derived, live-verified answer (nothing commits, meta exactly {relation:'children'}) and stays red on batch. If the committed segment is in fact the intended contract for this shape, the fix is at the contract, not at this cell, and the cell's `final` and `meta` then need a profile branch via `prepare(controls).profile` (the precedent is tests/raptor3/transitions/supplier-continuations.ts:36).
- DISAGREEMENT: REQUESTED CHANGE in a file I do not own (tests/raptor3/contracts.ts) — two scenario ids now misdescribe their cells: `g2-own-update-coc-refused` and `g2-child-delete-connect-modify-refused` both EXECUTE now. I did not rename them: the ids are pinned by G2_OWN_WRITE_CASE_IDS / G2_SINGULAR_CASE_IDS in tests/raptor3/contracts.ts (asserted by the -legacy wrappers, which I may not edit) and are the recorded cell identities inside sealed evidence receipts under docs/architecture/raptor3-evidence/** (post-g3-fact-ownership/*, g3-prep-06-review-repair/*), which ELEGANCE says to preserve. Each cell instead carries a comment naming what it now pins. If Arnaud wants the rename, it is one edit in contracts.ts plus one in the table, and the evidence correspondence is knowingly broken. `g2-own-delete-update-refused` keeps its name honestly (it still refuses, now for the correlated reason).
- unverified: The `-legacy.test.ts` wrappers of these four tables (own-write-legacy, membership-own-write-legacy, singular-legacy, singular-lattice-legacy) were not run — they are not my targets. They should follow: the `-commands` wrapper already evaluates `baseline.fixture.assert(baseline.observation)` against the default-route client with the same fixture, which is exactly what the legacy wrapper does, and I
- unverified: No PGlite / shared-family conformance cell was run (none of my files is one), so the tx-vs-batch parity booleans of the conformance harness were not exercised; DEFECT 3's substrate disagreement is measured on the SQLite profiles of this harness only.
- unverified: I did not determine whether DEFECT 2's V7006 floor and DEFECT 3's committed segment are owned by N1 or by a later unit (N3b's attribution ladder / N4's committed-segment reporting). I judged both against the brief's rules 3 and 6 and the AGENTS.md paragraphs, and flagged the AGENTS.md internal tension in DEFECT 3 rather than choosing a winner.
- unverified: `pnpm test:all` was not run (forbidden by the task). Only the four `-commands` wrappers and `node scripts/run-typecheck.mjs` were run.
- unverified: Whether the `NOT ("id" = NULL)` predicate of DEFECT 1 also reaches non-`set` verbs (e.g. `deleteMany`/`updateMany` exclusions) or other providers was not probed — I only measured the two cells of my own table that exercise it.
- biome: Per file, `npx biome check --max-diagnostics=200 <file>`, category by category. No `format` and no `parse` diagnostics before or after in any of the four; every change was made by hand and the formatter was never run on these files. - own-write.ts: before 23 (lint/suspicious/noMisplacedAssertion 23)
