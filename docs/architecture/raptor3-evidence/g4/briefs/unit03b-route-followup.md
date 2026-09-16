# G4-03b brief — route follow-up after G4-02 (bounded)

Read `common.md`, the accepted G4-03 record (`g4/unit03/note.md` §4 blockers
B-1…B-4, §D rows, §F/§R sections, `g4/unit03/handoff.md`), the G4-03 reviews
(`g4/unit03-review*.md`) and the G4-02 note/handoff (`g4/unit02/`). You are
the author of the route unit continuing after G4-02 landed the candidate-side
capabilities the route was blocked on.

## Files you own

`src/query-engine/raptor3/route/client-route.ts`, the existing seams in
`src/query-engine/query-engine.ts`, `src/query-engine/pending-operation.ts`,
`src/client/client.ts` (and array-transaction files only if strictly
required), `tests/raptor3/g4/route-*.test.ts`, `tests/types/raptor3/`. Not
`commands/`, `shared/`, the manifest, or the witness files.

## Outcome

1. **D-1 removed.** The route no longer wraps every write in
   `withTransaction`; inside a callback/nested transaction it passes
   `operationRegion` (the transferred operation region) on the borrowed
   binding, the array sequential fallback keeps supplying only
   `memberRollback` as today, and the candidate decides the envelope
   (G4-02 item 11, revision 4; see `g4/unit02/note.md` §8.4 and §11.3 for
   the exact route diff the phase-1 author wrote out).
   Retire the D-1 pins into positive parity assertions: the failing
   statement-atomic write inside `$transaction(callback)` poisons the caller's
   transaction on both routes; the multi-statement member rolls back only
   itself on both; observed unit sequences match on both.
2. **B-1 consumed.** The route uses the candidate's `prepare(...)` handle:
   admitted payload for the interceptor `context.input` and the cache key,
   the prepared read shape for the official cache result codec. `$withCache`
   works on the candidate route for reads; RF-10 and NS-04 hold. The
   candidate admits once; prove it with the existing admission-count oracle.
3. **B-4 consumed.** The client's execution context reaches candidate
   statements: statement transforms and observers see them (LX-13, LX-14,
   LX-15 fully covered).
4. **D-2 removed.** A read member in an atomic array on a batch-only driver
   succeeds on both routes (G4-02 item 12).
5. **D-3/D-4.** Thread the array owner's driver into `prepareBatch`; make
   `buildStatement()` answer the prepared read's single statement where one
   exists (or record the remaining divergence with a pin).
6. **B-3 consumed.** The route hands the client's resolved registry/index to
   the candidate schema factory (G4-02 item 10) so no second resolution runs.
7. Re-run the full G4-03 route suites, the shipped client falsifier batches
   the original unit ran, the C13 lifecycle witnesses (`g4-lifecycle-*`), and
   the whole-estate typecheck. Update `note.md` (append "Follow-up after
   G4-02"), `handoff.md` (cutover diff description refreshed), cost, and
   registration requests (counts) for the integrator.

## Exit and return value

Structured summary: unit, patch path, note path, rows moved from partial to
covered with receipts, pins retired/added, suites run with counts and
receipts, typecheck, cost, blockers, unverified claims.
