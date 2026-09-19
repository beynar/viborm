# External review of the plan's first revision (2026-09-20, relayed by Arnaud)

Reviewed at `464705acc`; no files changed, no tests rerun. Verdict: the
direction is worth pursuing; revise before implementation. The six points,
each checked by the integrator against the code before revision 2 applied
them:

1. **N1 — overlap equality does not prove a usable producer.** `equal` means
   a write overlaps a selector; it does not establish that the write produced
   a row available to this consumer (a delete can match; conditional writes,
   suppression, intervening updates and membership changes matter). The
   existing producer shortcut excludes batch execution and selectors with
   remaining conditions (`execution.ts:236`), so the batch "no read, no
   premise" path is new work. Rule to adopt: reuse an exact producer only when
   its executed outcome establishes the consumer's identity and conditions;
   otherwise an ordered observation. The proof belongs to the occurrence and
   dependency owners, not a per-verb interpreter.
2. **N1 — `flush()` is not a safe generic dependency barrier.** It withholds
   queued premises before submitting (`operation-context.ts:1036`); replacing
   `read()` with it could dispatch writes without the premises meant to
   protect them. The plan must say which effects precede the read, which
   premises execute atomically with them, and which observations remain valid
   afterwards. `runSelection()` caches positive observations, so moving a read
   later does nothing for a cached selection.
3. **N3 — the recovery fix targets the wrong owner.** Fresh-plan assertion
   recovery exists in `OperationContext.batchAttempt()` (`:870`);
   `CommandExecution.recover()` retries the existing tree, and widening its
   assertion branch would intercept the failure before the fresh-plan owner
   and expand an already-expanded series. `m8-race-retry` expects an
   un-attributable assertion to produce a non-raceable typed error in exactly
   one attempt — an error-translation problem, not permission to retry.
   Investigate attribution and recovery eligibility first.
4. **N4 — cardinality cannot replace protected capture.** The selected-bulk
   cardinality checks run in JavaScript after the mutation
   (`operation-context.ts:2043`); they are not atomic premises. Splitting
   capture and mutation into committed segments can discover a mismatch after
   effects committed, and a row can change membership or values without
   changing the count. Specify the captured-set, membership and result
   guarantees and enforce them within the consuming mutation's atomic
   boundary before removing the refusal.
5. **N2 — the claimed existing no-op is absent.** The deletion passes
   `attempt.rows.get(...)!` to `ctx.delete()` (`execution.ts:535`); an
   optional lookup alone exposes an undefined-row failure. N2 needs an
   explicit absent-selection consumption rule, including junction removal.
6. **D-53 removes evidence where this work needs it.** PGlite establishes
   PostgreSQL SQL behaviour, not every driver's session lifetime, failure
   attribution or commit certainty. The new scratch assumes a pinned session
   across segments (`postgres-adapter.ts:583`); Neon HTTP dispatches separate
   batch transactions. Share SQL tests; keep distinct transport-boundary
   witnesses; unmeasured drivers stay unqualified.

The principle to build on: every consumer receives a value or observation
that is valid at its execution point, after its prerequisite effects, with
the required protection and within the caller's authority. Report three
outcomes apart — supported behaviour increased; dead or internal diagnostics
removed or reclassified; integrity and provider boundaries remaining. A
census count is not an architectural target, and a valid schema must not
become illegal to move a refusal out of the runtime count.
