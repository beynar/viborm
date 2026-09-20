# Re-expression round2 — 4 groups (Opus, brief-reexpress.md)


## root-dependency — {'re-expressed': 1, 'pre-existing-red': 2}
final: Test Files 1 failed (1) Tests 2 failed | 28 passed (30) Duration 2.35s (transform 777ms, setup 8ms, collect 1.15s, tests 1.02s, environment 0ms, prepare 26ms) — the 2 remaining failures are the two pre-existing-red "create root barrier" cells, byte-identical to HEAD and untouched by me. The round-2 

- [re-expressed] nested-write conformance: own-write dependencies (tx vs batch) > delete then overlapping set rejects
  before: expectReject: true with expectedError: OWN_WRITE_ERROR ("depends on an earlier") — DESIGN §6.2's mode-independent veto, and the seeded state unchanged. In round 1 (pre-repair engine) the cell was a DISAGREEMENT: tx gave 
  derived: Written before measuring. `items` is a to-many with a child-held FK (item.ownerId -> owner.id). The canonical collection order runs `delete` before `set`, so (1) `delete: {id:1}` is a strict member selector, item 1 IS a member of owner 1 at its observation, and it is deleted; (2) `set: [{id:1}]`'s t
  measured: Exactly the derivation, on both substrates. Baseline round-2 run: the cell now fails ONLY at the expectedError substring pin — "expected 'Cannot set relation \'items\': target…' to contain 'depends on an earlier'" — which means expect(batch.error).toEqual(transaction.error) PASSED, i.e. the two subs
- [pre-existing-red] nested-write conformance: create root barrier (tx vs batch) > before-parent self connect is unaffected by the future insert
  before: expectReject: true, expectedError: "target record was not found", expected: {nodes: []}. Byte-identical to HEAD — neither round 1 nor I touched it.
  derived: Not re-derived for re-expression (report-only). The shape is `node.create({id:1, parent:{connect:{id:1}}})`: `parent` is parent-held (node.parentId -> node.id), so the connect's target lookup produces the very key the root's OWN insert consumes — Assignments.consumes, the one shape no order satisfie
  measured: Rejects with "Nested operation 'connect' on relation 'parent' depends on an earlier 'create' target write in the same nested write. Split these operations into separate queries." — which does not contain the recorded "target record was not found". Fails at the expectedError substring pin only; the r
- [pre-existing-red] nested-write conformance: create root barrier (tx vs batch) > nested create keeps its before-parent decision ahead of its insert
  before: expectReject: true, expectedError: "target record was not found", expected: {nodes: []}. Byte-identical to HEAD — neither round 1 nor I touched it.
  derived: Not re-derived for re-expression (report-only). The child create sits in `children` (so the containing relation assigns parentId = 10) and also carries its own `parent: {connect:{id:1}}` (parentId = 1): two conflicting final assignments for one column, refused at planning, independent of any depende
  measured: Rejects with "query-engine-v2 create has conflicting final assignments for column 'parentId' on relation 'parent'." — does not contain the recorded "target record was not found". Fails at the expectedError substring pin only. The throw site is commands.ts:484, which falls between N1's hunks (+448,3 
- unverified: The two 'create root barrier' cells' redness AT THE BASE was not re-measured in this round: that would mean reverting the worktree's uncommitted src/ changes, which the brief forbids. Evidence used instead: both cells are byte-identical to HEAD (verified by extracting each cell block from `git show HEAD:<file>` and comparing), the orchestrator lists both in n1/pre-existing-red.json, cell A's messa
- unverified: The error CODE equality on the focus cell was established indirectly, not printed in round 2. The harness's `expect(batch.error).toEqual(transaction.error)` compares {name, code, message} and passed; the tx-side message is unchanged from round 1, whose diff recorded the tx side as {name:'NestedWriteError', code:'V7001', message:"Cannot set relation 'items': target record was not found."}; and rela
- unverified: Only this one file was run. I did not run the wider estate, other groups' files, or pnpm test:all.
- unverified: The other 27 cells in the file were green in the round-2 baseline run before my edit and green in the final run; I did not re-derive them individually, since the task scoped me to the one red cell plus the two pre-existing reds.
- biome: `npx biome check <file>` from the worktree root. HEAD copy (`git show HEAD:<file>` into a scratch tree): exit 0, "No fixes applied." — 0 diagnostics in every category. After my edit: exit 0, "No fixes applied." — 0 diagnostics in every category. Identical. An intermediate state raised 1 x lint/corre

## m2m — {'re-expressed': 3, 'unchanged': 9}
final: Test Files 1 passed (1) / Tests 34 passed (34) — `node .../run-shared-family.mjs /private/tmp/viborm-n1/tests/contracts/engine/query/nested-write-conformance-m2m.test.ts`, "✓ |extended-local| tests/contracts/engine/query/nested-write-conformance-m2m.test.ts (34 tests) 1622ms", Duration 3.16s, 5.02s 

- [re-expressed] m2m overlapping set and deleteMany: the removal observes the set's membership (was: "… reject membership dependency")
  before: expectReject + "depends on an earlier 'set' membership write"; expected = the untouched baseline (no membership, tags t1/t2/t3)
  derived: canonical order runs `set` (6) before `deleteMany` (8): the set links t1, and the removal's capture — a junction membership read, repair (1) — is an ordered observation behind the set's whole mutation, finds t1 a member, matches {id:t1} and deletes the tag row with its junction row ⇒ memberships p1 
  measured: identical on both substrates: no rejection, m2mExpected({ tags: { t2, t3 } }); tx-vs-batch dumps byte-identical
- [re-expressed] m2m disconnect then deleteMany observes the emptied membership and keeps the row (was: "… rejects membership dependency")
  before: expectReject + "depends on an earlier 'disconnect' membership write"; expected = rolled-back membership p1 [t1]
  derived: `disconnect` (1) before `deleteMany` (8): the strict member selector drops t1's junction row and keeps its tag row; the removal observes the emptied membership behind it and matches no member ⇒ memberships p1 [] p2 [], tags baseline {t1,t2,t3}, no rejection (pin #9's first half; the file's own "stan
  measured: identical on both substrates: no rejection, m2mExpected() (baseline tags, empty memberships); tx-vs-batch dumps byte-identical
- [re-expressed] self m2m connect then inverse upsert observes the shared junction and updates (was: "… rejects shared junction dependency")
  before: expectReject + "depends on an earlier 'connect' membership write"; expected = { follows: [], followedBy: [] }
  derived: `follows` before `followedBy` (declaration order) and both are views of ONE junction table, so the upsert's membership probe is an ordered observation of the link the connect just made (repair 1) and its found requirement rides that observation's batch (repair 4): u1 IS a member of its own followedB
  measured: identical on both substrates: no rejection; users [{u1,"updated"}], follows u1→[u1], followedBy u1→[u1]. Round 1's parity break (tx executed, batch raised "Cannot upsert relation 'followedBy': target record was not found for this parent.") is gone
- [unchanged] self-referential m2m connect then disconnect
  before: expected = { follows: [{u1,[u3]}], followedBy: [{u3,[u1]}] }
  derived: answer unchanged by N1; only the group's dump shape changed — I strengthened the file-local `dumpSelfRefM2m` to carry the user ROWS (id + name) beside the two membership views, because on this self-referential junction the arm a nested upsert took is visible nowhere else, so this cell's expected gai
  measured: green with users [{u1,Alice},{u2,Bob},{u3,Cara}] added; memberships unchanged
- [unchanged] m2m connectOrCreate string-selector array connects the found member and creates the unknown one
  before: round-1 re-expression of DESIGN §6.2's veto ("depends on an earlier 'connectOrCreate' target write")
  derived: unchanged from round 1
  measured: still green under the repaired engine
- [unchanged] m2m connectOrCreate then deleteMany removes the tag the connectOrCreate just created
  before: round-1 re-expression of the 'connectOrCreate' target veto
  derived: unchanged from round 1
  measured: still green under the repaired engine
- [unchanged] m2m explicit delete then deleteMany finds no member left to remove
  before: round-1 re-expression of the 'delete' target veto
  derived: unchanged from round 1
  measured: still green under the repaired engine
- [unchanged] m2m update then deleteMany removes the row the update just renamed
  before: round-1 re-expression of the 'update' target veto
  derived: unchanged from round 1
  measured: still green under the repaired engine
- [unchanged] m2m updateMany then deleteMany removes the rows its filter just matched
  before: round-1 re-expression of the 'updateMany' target veto
  derived: unchanged from round 1
  measured: still green under the repaired engine
- [unchanged] m2m multiple deleteMany filters each observe what the previous one left
  before: round-1 re-expression of the 'deleteMany' target veto
  derived: unchanged from round 1
  measured: still green under the repaired engine
- [unchanged] m2m upsert then deleteMany: the removal observes the upserted row
  before: round-1 re-expression of the 'upsert' target veto (N6-U3's retarget)
  derived: unchanged from round 1
  measured: still green under the repaired engine
- [unchanged] named likes create then stars connectOrCreate connects the beta the create just made
  before: round-1 re-expression of the 'create' target veto
  derived: unchanged from round 1
  measured: still green under the repaired engine
- unverified: The judgement call the integrator may want to review: I strengthened the file-local `dumpSelfRefM2m` (used by nothing outside this file — grep confirms) to return `users` (id + name) beside `follows`/`followedBy`, because the self-ref dump otherwise cannot witness WHICH upsert arm ran; that is why the sibling green cell 'self-referential m2m connect then disconnect' gained the three seeded rows in
- unverified: Only repairs (1) and (4) are exercised by this file; (2), (3), (5), (6) and (7) are not reachable from any m2m cell, so this file says nothing about them.
- unverified: I ran only my own file and the whole-estate typecheck; no other conformance file, no SQLite pins, no `tests/raptor3/g4/parity/ordered-observation.test.ts` run of my own — the pins' green state is taken from the unit's note, not re-measured here.
- unverified: The end state is measured on PGlite only (the harness's two substrates: PGliteDriver and BatchOnlyPGliteDriver). No other provider was exercised.
- unverified: src/ was read (commands.ts `readMembership`) but never modified; `git status --short` shows the engine hunks exactly as the integrator left them.
- biome: Zero diagnostics, every category, before and after — identical to HEAD. Edited file: `npx biome check tests/contracts/engine/query/nested-write-conformance-m2m.test.ts` → "Checked 1 file in 11ms. No fixes applied." HEAD baseline: `git show HEAD:<file>` written as tests/contracts/engine/query/nested-

## variant-order — {'re-expressed': 2, 'unchanged': 2}
final: Test Files 2 passed (2) Tests 8 passed (8) (the file runs in two vitest projects — |raptor3| and |coverage-raptor3| — so 8 = 4 cells x 2; `node scripts/run-vitest-safe.mjs tests/raptor3/prep/variant-collection-order.test.ts`, 4.41s wall, 539.1 MiB peak RSS, teardown verified)

- [re-expressed] G3P-05 mixed variant collection ordering > guards every root target, clears each member table once, then observes and writes (was: "… then w
  before: ONE guard phase: every SELECT on a target table ahead of the first junction clear (`Math.max(...guards) < Math.min(...clears)`), plus the target write list ["UPDATE:clips","DELETE:notes","DELETE:books","INSERT:clips","IN
  derived: `set` is first in `collectionMutationOrder` (set, updateMany, deleteMany, connect, create, createMany), so it clears all three member tables for c1 and links n-set. The updateMany (clips) and the two deleteMany arms (books, notes) read the junction membership, and `readMembership`'s junction clause 
  measured: Exactly the derivation. Trace: 0 crate lookup; 1 SELECT notes id='n-set' (the set's target lookup, ahead of its clear); 2-5 SELECT clips/books/notes id=? for k-connect, b-connect, n-connect, b-connect-2 (caller order); 6,7,8 DELETE FROM crate_books / crate_clips / crate_notes WHERE crate='c1'; 9 INS
- [re-expressed] G3P-05 mixed variant collection ordering > keeps the same guard-clear-observe-write contract in a nested record (was: "keeps the same guard-
  before: The same `assertGuardClearWriteOrder` + `assertMixedState` contract one record down (warehouse.update → crates.update where c1): one guard phase ahead of the clears, deleteMany's target writes over the seeded membership.
  derived: Identical to the root cell. The nesting changes nothing: the write (the set's clears/link) and the reads (updateMany/deleteMany member reads) are both children of the crate record occurrence, so their nearest common ancestor and their relative run order are the same as at the root; only the warehous
  measured: Identical shape shifted by one statement: 0 warehouse lookup; 1 crate lookup (warehouseId='w1' AND id='c1'); 2 n-set guard; 3-6 the four connect guards in caller order; 7,8,9 the three clears; 10 the set's link INSERT ('c1','n-set'); 12, 14, 16 the three membership observations (clips 'sweep', books
- [unchanged] G3P-05 mixed variant collection ordering > set of the empty collection clears all variants without deleting targets
  before: `set: []` clears all three member tables exactly once and deletes no target row (5 books, 3 clips, 5 notes).
  derived: No membership-reading consumer in the payload — the set is the only verb — so `readMembership` finds no read to place and nothing moves. Unchanged.
  measured: Green before and after the edit (both vitest projects).
- [unchanged] G3P-05 mixed variant collection ordering > admits an ordinary relation before a later-declared variant relation
  before: Admission order ["ordinary", "variant"], the c1 membership after a single variant `create` plus an ordinary `logs.create`.
  derived: Only `create` verbs — no junction link/remove/set precedes a membership read, so no ordered observation arises. Unchanged.
  measured: Green before and after the edit (both vitest projects).
- unverified: Only the SQLite LIVE route is exercised here: the file drives `createCommandEngine({ schema, driver })` over a `better-sqlite3` driver in the |raptor3| and |coverage-raptor3| projects. It has no batch / batch-only / PGlite substrate, so the barrier behaviour for these three observations (flush, the required-row premise riding the batch) is not measured by this file — it is the unit's own pins in t
- unverified: The relative order AMONG the three membership observations is measured (books before notes, which INVERTS the payload's `deleteMany` key order [note, book] — the arms follow the variant's `.through({ book, clip, note })` declaration order, and the recorded HEAD write list had DELETE:notes before DELETE:books). I deliberately did NOT pin it: my derivation only fixes each observation behind its junc
- unverified: The whole-estate typecheck (`node scripts/run-typecheck.mjs`) ran clean — exit 0, zero `error TS`, 5.04s, 4989.1 MiB peak — but it ran against this shared worktree while the other three round-2 agents may have had edits in flight, so it attests to my file, not to a frozen estate.
- unverified: I did not run any other estate lane (per the brief, no `pnpm test:all`), so cross-file effects of my edit are unverified — though this file exports nothing and its helpers (`assertGuardClearWriteOrder`, `assertMixedState`, `mixedMutation`) are module-local.
- unverified: The HEAD engine's own statement order was not re-measured: `src/` is the frozen N1 engine in this worktree and I may not check it out. The 'recorded order' I compared against is the HEAD copy of the test file's assertions (confirmed byte-identical to `e772741eb`), which pin it exactly.
- biome: Identical to HEAD, category by category. BEFORE (HEAD copy, `git show e772741eb:tests/raptor3/prep/variant-collection-order.test.ts`): 17 errors — 8 lint/performance/useTopLevelRegex, 9 lint/suspicious/noMisplacedAssertion, 0 format. AFTER: 17 errors — 8 lint/performance/useTopLevelRegex, 9 lint/sus

## membership — {'re-expressed': 6, 'newly-green': 2, 'disagreement': 3, 'unchanged': 5}
final: Test Files 1 failed (1) / Tests 3 failed | 27 passed (30). The three remaining failures are the cross-scope trio, all at nested-write-conformance-fixtures.ts:149 (`expect(batch.state).toEqual(transaction.state)`) — a tx-vs-batch parity break, reported as disagreements, not pinned. Round-1 end state 

- [re-expressed] same-node non-self FK rebind descends into the final target's inverse membership (was: "… rejects inverse descent through the final target")
  before: DESIGN §6.2's mode-independent veto — expectReject: true, "depends on an earlier 'update' membership write", state unchanged (node 1 label "one" in container 10). Green at HEAD.
  derived: Repair 3 / the note's D3: the parent-held `container` choice names the container node 1 references AFTER its own write (20), and its subtree (`nodes.update where id 1`) reads the membership that same write moves, so the whole choice runs behind the root UPDATE. The descent then finds node 1 a member
  measured: Executes on both substrates, byte-identical, exactly the derived state (cell green in run2 and run6-final).
- [re-expressed] self to-many inverse update rejects the moved current row
  before: DESIGN §6.2's veto — expectReject: true, "depends on an earlier 'update' membership write", state unchanged. Red at HEAD (batch V7006 NestedWriteAssertionError vs tx V7001).
  derived: The membership node 1 ∈ node 1's `children` is carried by node 1's own parentId, which the root's own write moves to 2, so the lookup is an ordered observation behind that write and finds no member. Rule 3: the relation body's correlated refusal, "Cannot update relation 'children': target record was
  measured: Both substrates reject with the identical error object (the harness's `expect(batch.error).toEqual(transaction.error)` passes) and the message is exactly "Cannot update relation 'children': target record was not found for this parent."; state unchanged. Green after re-expressing `expectedError` only
- [re-expressed] self to-one inverse upsert creates into the slot the current-row FK membership move vacated (was: "… rejects a current-row FK membership mov
  before: DESIGN §6.2's veto — expectReject: true, "depends on an earlier 'update' membership write", state unchanged (node 1 partnerId 1, node 2). Red at HEAD (`batch.rejected` ≠ `transaction.rejected`).
  derived: Repair 2 (a self-held FK): the inverse `partnerOf` slot is the row whose partnerId = 1, and node 1's own write sets its own partnerId to 2, so the slot is observed after that write and is empty. The to-one upsert (no `where`) takes its create branch. End state: node 1 {label "one", partnerId 2}, nod
  measured: Executes on both substrates, byte-identical, exactly the derived state.
- [newly-green] non-self child-holds cascade keeps membership through a key transition
  before: Already recorded as executing — no expectReject; expected containers [{11}], node 1 {label "after", containerId 11}. Red at HEAD and after round 1 (tx executed, batch rejected: `expect(batch.rejected).toBe(transaction.re
  derived: Repair 2 (the parent's referenced key): container 10's own write moves its id to 11 and `onUpdate("cascade")` carries node 1's containerId with it; the `nodes.update where id 1` membership read is an ordered observation behind that write, so node 1 is still a member and is renamed. End state exactly
  measured: Green on both substrates with no edit — the batch route now agrees with the tx route.
- [re-expressed] nested physical membership carries into a later same-edge root update (was: "… rejects a later same-edge root update")
  before: DESIGN §6.2's veto — expectReject: true, "depends on an earlier 'connect' membership write", state unchanged (friends []). Red at HEAD (both routes gave "Cannot update relation 'friends': target record was not found for 
  derived: Repair 1 across a sibling relation's nested subtree: relations run in declaration order, `children` before `friends`, so the link node1→node2 made inside `children.update where id 1` is an earlier write of the `membershipFriends` junction; the root's `friends.update where id 2` reads that junction's
  measured: Executes on both substrates, byte-identical, exactly the derived state.
- [re-expressed] nested physical membership carries into a later same-edge root upsert (was: "… rejects a later same-edge root upsert")
  before: DESIGN §6.2's veto — expectReject: true, "depends on an earlier 'connect' membership write", state unchanged. Red at HEAD (`batch.rejected` ≠ `transaction.rejected`).
  derived: Same junction observation as the update cell; the upsert's lookup lands behind the link, finds node 2 inside the membership and takes its found branch (repair 4's "no row outside the membership" premise holds). End state: nodes [{1,"one",parentId 1},{2,"after",parentId null}], friends [{sourceId 1, 
  measured: Executes on both substrates, byte-identical, exactly the derived state.
- [disagreement] nested create membership collides with the earlier cross-scope to-one upsert on the unique partner slot
  before: Round 1 re-expressed it from the veto ("depends on an earlier 'create' membership write") to expectReject: true + "Unique constraint violation" + CROSS_SCOPE_MEMBERSHIP_BASE, and it was green at the end of round 1. Red a
  derived: Unchanged by the repairs: `container` is declared before `children`, so the cross-scope upsert observes node 1's empty partner slot and creates node 3 {partnerId 1}; the nested create of node 2 then claims the same unique slot. Rule 5 + rule 6: the unique violation is the operation's failure, the tr
  measured: Error identical on both routes (assertions at fixtures.ts:139/143/145 all pass). tx state = the recorded expected. batch state = the recorded expected PLUS {containerId: null, id: 3, label: "three", parentId: null, partnerId: 1} — the pre-barrier segment committed. Fails at fixtures.ts:149.
- [disagreement] connectOrCreate membership collides with the earlier cross-scope to-one upsert on the unique partner slot
  before: Round 1 re-expressed to expectReject: true + "Unique constraint violation" + CROSS_SCOPE_MEMBERSHIP_WITH_TARGET; green at the end of round 1. Red at HEAD for the old reason.
  derived: As above: node 3 takes node 1's unique partner slot, then the connectOrCreate rebinds node 2 onto the same slot; the unique violation leaves nothing durable on either substrate.
  measured: Same divergence, measured on its own (run4-coc.log): batch keeps node 3 {partnerId 1}; node 2's partnerId stays null; tx keeps nothing. Fails at fixtures.ts:149.
- [disagreement] found connect membership collides with the earlier cross-scope to-one upsert on the unique partner slot
  before: Round 1 re-expressed to expectReject: true + "Unique constraint violation" + CROSS_SCOPE_MEMBERSHIP_WITH_TARGET; green at the end of round 1. Red at HEAD for the old reason.
  derived: As above, with `connect` rebinding node 2 onto the slot node 3 took; nothing durable on either substrate.
  measured: Same divergence, measured on its own (run5-connect.log): batch keeps node 3 {partnerId 1}. Fails at fixtures.ts:149.
- [newly-green] nested identity transition exports the exact final membership source
  before: expectReject: false; red at HEAD (over-rejection — the dependency pass refused a shape the expectation says executes).
  derived: N1 spends the overlap on placement, not a refusal, so the shape executes and the recorded end state stands.
  measured: Green on both substrates with no edit.
- [unchanged] nested to-many child update carries its selector into inverse membership
  before: Round 1 re-expressed it from the veto to an executing cell (node 1 partnerId 2, node 3 in the vacated slot). Red at HEAD (target-write wording pre-empted the membership one).
  derived: Unchanged by the repairs — the inverse observation is taken after the child's own write, the slot is vacated, the upsert creates node 3.
  measured: Still green on both substrates.
- [unchanged] non-self nested FK rebind follows the inverse read of the same holder
  before: Round 1 re-expressed from the veto to an executing cell (node 1 label "after", containerId 20, parentId 9). Red at HEAD.
  derived: Unchanged by the repairs — `container` is declared before `children`, the inverse read observes node 1 still in container 10 and the rebind follows it.
  measured: Still green on both substrates.
- [unchanged] nested scalar FK rebind follows the inverse read of the same holder
  before: Round 1 re-expressed from the veto to an executing cell (node 1 label "after", parentId 2). Red at HEAD.
  derived: Unchanged by the repairs.
  measured: Still green on both substrates.
- [unchanged] nested scalar FK rebind follows the inverse upsert of the same holder
  before: Round 1 re-expressed from the veto to an executing cell (found branch, node 1 label "after", parentId 2). Red at HEAD.
  derived: Unchanged by the repairs.
  measured: Still green on both substrates.
- [unchanged] same-node non-self FK rebind allows a disjoint inverse holder / nested physical membership allows a disjoint target endpoint / allows a disj
  before: Executing cells that pin the disjoint side of each pair; green at HEAD and after round 1.
  derived: The repairs move only non-disjoint reads; a disjoint read keeps its place (the pin "a disjoint capture keeps its place ahead of the effects").
  measured: All still green on both substrates in the final run.
- [re-expressed] helper removed: const UPDATE_MEMBERSHIP_ERROR
  before: A file-local constant holding "depends on an earlier 'update' membership write", used by three cells (lines 312, 492, 673 of the round-1 file).
  derived: After the three re-expressions its last reference disappears; its text is preserved verbatim inside each cell's `// N1 (D-51): pinned DESIGN §6.2's veto ("…")` comment.
  measured: Removed; 0 references left in the worktree (greped repo-wide, it was never exported). Biome stays at 0 diagnostics.
- DISAGREEMENT: THE CROSS-SCOPE TRIO — a tx-vs-batch state parity break introduced by the round-2 repairs (all three cells were green at the end of round 1; they are red now on a NEW axis). Cells: "nested create membership collides with the earlier cross-scope to-one upsert on the unique partner slot" (seed seedCrossScopeMembershipBase, act runCrossScopeMembershipMutation(client, "create", 1)); "connectOrCreate membership collides …" (seedCrossScopeMembershipWithTarget, "connectOrCreate", 1); "found connect membership collides …" (seedCrossScopeMembershipWithTarget, "connect", 1). Reproduce: cd /private/tmp/viborm-n1 && TMPDIR=/private/tmp/viborm-n1-r2-membership-tmp node /private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/run-shared-family.mjs tests/contracts/engine/query/nested-write-conformance-membership.test.ts -t "connectOrCreate membership collides" (logs: scratchpad/n1-membership-r2/run3-create.log, run4-coc.log, run5-connect.log, run6-final.log).
- DISAGREEMENT: DERIVATION (rules 1-7): relations run in declaration order and `container` is declared before `children` on the node model, so the cross-scope subtree runs first: container 10's `nodes.update where id 1` → `partnerOf.upsert` finds the slot empty and INSERTs node 3 {label "three", partnerId 1}. The `children.update where id 1` subtree then puts node 2 into the same unique slot (create / connect / connectOrCreate), and partnerId is UNIQUE. Rule 5: the unique violation is the operation's failure; rule 3/5: nothing commits — the transaction rolls back on the live route, the batch aborts on the batch route; rule 6: both substrates must end byte-identical, at CROSS_SCOPE_MEMBERSHIP_BASE / _WITH_TARGET.
- DISAGREEMENT: MEASURED: both substrates raise the identical error (the harness's `expect(batch.error).toEqual(transaction.error)` and the "Unique constraint violation" containment both pass), but the states differ. transaction.state = the recorded `expected`. batch.state = the recorded `expected` plus one extra row, verbatim from the diff: {"containerId": null, "id": 3, "label": "three", "parentId": null, "partnerId": 1}. Identical delta in all three cells. Failing assertion: nested-write-conformance-fixtures.ts:149, `expect(batch.state).toEqual(transaction.state)`.
- DISAGREEMENT: MY READING: the tx route is right and matches the contract; the batch route leaks D-51's committed segment. The barrier sits BETWEEN the two subtrees, so the first native batch (which created node 3) commits before the second batch carries the colliding write and aborts; `OperationContext.committedProgress` (shared/operation-context.ts:215, and the recovery guard at :1443) then forbids any recovery, so node 3 stays durable. What makes the read dependent is `Commands.readMembership` (commands/commands.ts:564-619): the `children` edge is a reference edge owned by the target, its member side is [parentId], and the earlier create of node 3 is a `record` command on `edge.target` whose `fields.operation === "create"`, so `command.fields.writesField(parentId)` holds for the created row and the membership read of node 9's `children` is placed behind it. That placement is conservative but defensible (a create CAN produce a member: a new node with parentId 9 would be one) — the defect is the consequence, not the placement: on a batch-only transport, any operation that flushes a barrier and then fails a database integrity check can no longer satisfy the conformance oracle's byte-identical-state requirement. This is the same family as the gate's already-recorded row "fk | createMany duplicate PK rolls back parent and prior children — a batch-only-transport atomicity gap" (docs/architecture/raptor3-evidence/g4/release/gate/nested-conformance.md), now reachable from three more cells. The integrator's choice: narrow the create's contribution to `readMembership` (a create can only ADD a member, so a read that is only asked whether an EXISTING row is a member could stay put), or keep the unit atomic across a barrier on the batch route, or record these three as a documented parity exception — the last would be a harness change, not a test-file change, and is outside my write target.
- DISAGREEMENT: I did NOT re-express these three cells: rule 6 says a tx-vs-batch disagreement is a defect, not something to pin, and the harness asserts parity before it ever compares `expected`, so the divergence is inexpressible in the cell anyway. They stay exactly as round 1 left them (expectReject: true, "Unique constraint violation", the seed state), which is still exactly what the tx route does.
- unverified: No TypeScript typecheck was run (the change is data literals inside the existing `Scenario<…>[]` plus the removal of one unused file-local `const`; vitest transpiled and ran the file four times). The estate's typecheck stage is the integrator's.
- unverified: The unit's pins (tests/raptor3/g4/parity/ordered-observation.test.ts) were read but not run by me — the task states they are all green; every measurement here was taken against the engine as it stands in /private/tmp/viborm-n1 (src untouched: `git status` still shows only the integrator's eight modified source files).
- unverified: For the three disagreement cells I could not read `transaction.state` in full through the harness, because the parity assertion at fixtures.ts:149 fires before the `expected` comparisons at :151-152. I inferred tx.state = the recorded `expected` from (a) the printed diff's unchanged context and (b) round 1 having measured all three fully green (tx.state == batch.state == `expected`) under the pre-
- unverified: That the barrier in the cross-scope trio is forced by the `children` membership read landing behind the create of node 3 is a code-level reading of `Commands.readMembership` plus one eliminated alternative (the `create` variant has no lookup of its own in the `children` subtree and diverges identically), not a measured statement/batch trace. A RecordingSQLiteDriver trace would settle it, but it ne
- unverified: The array route (D-46) was not exercised for any of these cells; the conformance harness runs only the PGlite transaction and forced-atomic-batch substrates.
- biome: Identical to HEAD, category by category: 0 diagnostics before, 0 after. HEAD copy measured by writing `git show HEAD:tests/contracts/engine/query/nested-write-conformance-membership.test.ts` to a temporary sibling path inside the worktree and running `npx biome check` on it → "Checked 1 file in 11ms
