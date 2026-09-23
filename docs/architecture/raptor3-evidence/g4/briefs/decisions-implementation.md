# Decisions implementation brief — apply Arnaud's six compatibility decisions

Read `common.md`, the decisions table in `g4.md` ("Arnaud's decisions
(16:55, 2026-09-15)"), the decision records in `g4/unit02/note.md`
(R-D1…R-D4 rows and their pinning cells) and `g4/unit03/note.md` FU.6
(D-5, D-6). You are the author of this unit; you own the candidate files
(`src/query-engine/raptor3/**`), `tests/raptor3/g4/unit02/**`, and, by writer
transfer for this unit, `tests/raptor3/g4/route-transactions.test.ts` and
`tests/raptor3/g4/route-lifecycle.test.ts` (the D-5 and D-6 pins). Not the
manifest; report count changes. No shipped-engine file changes.

## Work

1. **R-D2 (b) and (c) → shipped parity.** A `number`-key `increment` is
   refused with the shipped sentence; `set` beside an operator on a key
   answers the shipped sentences (the update/updateMany one and the
   upsert-with-relations one, mutation-identity.ts:187) instead of letting
   `set` win. Same owner as the existing key-portability refusal
   (`EngineSchema.keyPortabilityRefusal` / the found-arm channel); no new
   walk. (a) stays: the decimal primary-key `increment` remains supported;
   its pin becomes a positive contract cell (candidate answer is the
   contract; the shipped refusal is recorded as the legacy baseline in the
   cell's comment).
2. **R-D3 → public identity.** The bare `Error: Raptor 3 update expression
   publication requires an integer field` becomes a `QueryEngineError` with a
   descriptive message naming the model, field and operation and `meta`
   `{ model, operation, field }`, raised at the same point (before any
   statement is dispatched). The pin asserts the new identity on the
   candidate and records the shipped row answer as the accepted divergence.
3. **R-D4, D-5, D-6 → positive contract witnesses.** Rewrite each pin so the
   candidate's behavior is asserted as the contract (FK stores the located
   key; the multi-statement array member is packaged atomically and its rows
   committed; the interceptor sees the admitted payload) and the shipped
   answer is kept only as a recorded legacy baseline in a comment or a
   clearly labelled `legacy` assertion that does not gate. The cells must
   still fail if the candidate regresses.
4. **R-D1 → record only.** Add the authorization to the R-D1 row and the
   private guide paragraph; keep the unit-level refusal pin; no code.
5. **Private guide.** Append to `src/query-engine/raptor3/AGENTS.md` one
   paragraph per decided behavior (decimal PK increment supported; number-key
   increment and set-beside-operator refused as shipped; batch-only
   multi-statement array members packaged; upsert interceptor input is the
   admission; collation-equal connect stores the located key; the public
   identity of the batch expression-publication refusal).
6. Re-run the affected suites (`tests/raptor3/g4/unit02/` on SQLite and live
   MySQL, `g4-route-transactions`, `g4-route-lifecycle`, `g3-execution-review`,
   `g2-mysql-contracts`, `g2-pg-contracts`) and the whole-estate typecheck.
   Write `g4/unit02/note.md` "Decisions applied" with the cell-by-cell
   changes and receipts; regenerate the closure patches; recapture identity.

## Exit and return value

Structured summary: unit, summary, location, notePath, patchPath, repairs
(decision → change → cell → receipt), suites, native, typecheck, cost,
registrationRequests (count changes), blockers, unverifiedClaims.

## Added after closure round 3 (ACCEPT, 17:02) — same unit, same owner

Read `g4/unit02-closure-review-followup-2.md` (the round-3 verification) in
full; its notes are work items here:

7. **R-D4 provenance re-wording (reviewer note 3).** Re-word note.md §R4.8,
   §R5.6 and §R5.10: the FK-byte divergence is pre-existing at 0cc61e61
   (measured with the reviewer's own probe in the clean worktree,
   `g4/unit02-closure-review-followup-2-receipts/classify-rd4-baseline-0cc61e61.log`);
   what the repairs changed is reachability on the intermediate phase-2 tree.
   Withdraw "now a measured falsehood" and name the tree each measurement ran
   on. Soften R-B5's wording per note 2 (round 3 restores the baseline
   reachability of both spellings).
8. **Predicate verb type (reviewer note 5).** Type
   `nestedTargetAddressesConstraint`'s verb parameter as the switch's own
   case-label union so a missed wiring is a typecheck, not a silent default.
   No new guard, no runtime branch.
9. **Two author rows (reviewer note 4).** Add to
   `tests/raptor3/g4/unit02/unique-discriminator.test.ts`: R-D4's parent-held
   instance (a to-one `connect` writes the located key into the FOREIGN-KEY
   column — this is the positive contract cell for R-D4 under item 3, so
   write it once in that form) and one junction `upsert` row (the only verb
   whose two shipped phases disagree; both engines agree today and the cell
   pins that).
10. **R-B5 — junction `delete` foreign-key failure (inherited from G3,
    parity work, not a decision).** A junction `delete` (exact bytes or
    collation-equal key) answers `ForeignKeyError` on the candidate and writes
    nothing; the shipped engine removes the link row and then the target
    (`RelationJunctionPart.ts` delete kind: link membership removed before the
    target row is deleted). Minimize first (the reviewer's probe
    `tests/raptor3/g4/review/unit02-closure2/mysql-scope-boundaries.review.test.ts`
    and the author's pin cell reproduce it), name the exact mechanism in the
    candidate (statement order of the junction delete in `relation-body.ts`
    / the delete assignment producer, or a missing link-row statement), and
    repair it in that one owner with the shipped order as the contract: the
    link row is removed, then the target, in one region. The pin cell flips
    from "both answers recorded" to the positive contract (rows: link gone,
    target gone) and must also be measured on SQLite (the FK is enforced
    there by the harness's `PRAGMA foreign_keys`) — if SQLite does not
    reproduce it, say so and keep the MySQL cell as the falsifier. §8 stop
    rule: if the same minimized failure survives two attempted repairs,
    record it as a blocker for Arnaud with both attempts' receipts and stop
    repairing. Re-check that the frozen fast-path statement counts
    (`physical-envelope.test.ts` 10 / `packaged-array` 5 / `prepared-operation`
    5) do not increase; if the junction delete gains a statement it needed
    anyway, re-pin with the reason in the cell.

Ordering inside the unit: items 1–4 and 7–9 first (they touch the same cells),
then item 10 (production owner), then item 5 (guide) and item 6 (suites,
note, patches, identity). One mode per Bash call with a bounded timeout. The
MySQL container port is `docker port viborm-raptor3-g3-mysql-20260914 3306`
(currently 65515), PostgreSQL `docker port viborm-raptor3-g3-pg-20260914 5432`
(currently 65504); pass `VIBORM_RAPTOR3_PROVIDER_PORT`. Report the R-B5
outcome explicitly in `blockers` (repaired, or blocked after two attempts).
