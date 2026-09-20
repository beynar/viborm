# D-53 — the transport witnesses (unit note)

Ruling D-53 (Arnaud, `raptor3-nesting-and-refusals-plan.md` §0): *PGlite
establishes PostgreSQL SQL behaviour, not every driver's transport. Session
lifetime, failure attribution and commit certainty are TRANSPORT facts with
their own witnesses per driver; a driver without such a witness stays
UNQUALIFIED for a behaviour that depends on them.*

This unit builds the witnesses and states the qualification table once. It
makes **no engine change**: the one the brief authorised is not available under
its own condition, and is requested as a ruling in §5.

---

## 1. Where the facts live

Each fact is read from the driver's OWN declaration, never inferred from a
provider name.

| fact | declaration | seam that consumes it |
| --- | --- | --- |
| session lifetime | `pinnedSession` hook / `_canPinSession()` (`src/drivers/driver.ts:201`, `:225`) | nothing in the engine reads it — see §5 |
| failure attribution | the batch path taken in `_executeBatch` (`src/drivers/driver-transaction-base.ts:776`): the shared per-statement loop (`:659`) names the statement, a native override does not | `findUniqueExecutionContextIndex` (`src/drivers/driver-diagnostics.ts:26`) → `error.meta.statementIndex` → `OperationContext.submit` (`src/query-engine/raptor3/shared/operation-context.ts:1260`) |
| commit certainty | `supportsTransactions` / `supportsBatch` / `supportsOrderedCommittedSegments` (defaults at `src/drivers/driver-instrumentation.ts:240`, `:248`, `:258`) | `submit`'s `acknowledged` callback and `mayHaveCommittedSegment` |
| bind capacity | `maxBindParametersPerStatement` (default `src/drivers/driver-instrumentation.ts:268`) | compilation's static capacity check |

The **scratch** whose lifetime is in question is D-50's batch reference table:
`__viborm_batch_refs`, a `CREATE TEMP TABLE IF NOT EXISTS` queued ONCE per
attempt (`OperationContext.ensureScratch`, `operation-context.ts:2547`), read
back as `references.read(scratchId, key)` and deleted at the operation's end
(`:1760`). A TEMP table belongs to a SESSION; the PostgreSQL adapter says so in
as many words (`src/adapters/databases/postgres/postgres-adapter.ts:581-587`:
"its later segments still read the references the first one stored, on the same
pinned session").

**Which drivers the question reaches.** The batch route is taken when
`usesBatch` holds, and `usesBatch` is `ownership === "batch-preparation" ||
(standalone && !driver.supportsTransactions)` (`operation-context.ts:389`); the
first arm never DISPATCHES a segment, because `OperationContext.submit` refuses
a batch-preparation context before it assembles anything
(`operation-context.ts:1261`, the array route's `incompletePreparation`), so for
a dispatched unit `usesBatch` reduces to `standalone && !supportsTransactions`.
So a nested write is dispatched as a SUCCESSION OF SEGMENTS on exactly two
shipped drivers — Neon HTTP and D1, the two that declare no interactive
transaction — and on no other. Every remaining driver runs the
same nested write inside one interactive transaction, where "does the scratch
survive to the next dispatched unit" cannot arise: one transaction is one
session by construction. That is why the table below marks session lifetime
*n/a (one interactive session)* rather than *qualified* for them.

---

## 2. The qualification table

`pinned` = a credential-free pin in this repository. `live <VAR>` = a
credential-gated witness, named by its environment variable, never its value.
`unqualified` = no witness runs here.

| driver | route a nested write takes | session lifetime | failure attribution | commit certainty | bind capacity |
| --- | --- | --- | --- | --- | --- |
| `pglite` | interactive (`supportsTransactions`) | n/a — one interactive session | **pinned** (live PGlite: `transport-seam-pglite.test.ts`) | **pinned** (aborted batch leaves no writes, same file) | 65 535, confirmed |
| `sqlite3` (better-sqlite3) | interactive | n/a — one interactive session | **pinned** (live sqlite3 seam: `transport-witnesses.test.ts`) | **pinned** (same cell) | 999, confirmed |
| `bun-sqlite` | interactive | n/a — one interactive session | derived (same shared seam, no Bun runtime here) | derived | 999, confirmed |
| `libsql` | interactive | n/a — one interactive session | derived (same shared seam) | derived | 999, confirmed |
| `pg` | interactive | n/a — one interactive session | derived (same shared seam) | derived | 65 535, confirmed |
| `postgres` | interactive | n/a — one interactive session | derived (same shared seam) | derived | 65 535, confirmed |
| `bun-sql` | interactive | n/a — one interactive session | derived (same shared seam) | derived | 65 535, confirmed |
| `mysql2` | interactive | n/a — one interactive session | derived (same shared seam) | derived | 65 535, confirmed |
| `planetscale` | interactive (`supportsTransactions = true`, no batch) | n/a — one interactive session | derived (same shared seam) | derived | 65 535, confirmed |
| `neon-http` | **batch** (`supportsTransactions = false`, `supportsBatch = true`) | **unqualified** — `_canPinSession()` false, **pinned** on the Neon-shaped fixture; live witness gated on `NEON_TEST_DATABASE_URL`, which is unset here | index-free by construction (whole request rejected); already pinned by `tests/contracts/engine/write/neon-committed-segments-capability.test.ts` | **unqualified** — `supportsOrderedCommittedSegments` stays `false`; live witness gated on `NEON_TEST_DATABASE_URL` | 65 535, **pinned** |
| `d1` | **batch** (`supportsTransactions = false`, `supportsBatch = true`) | **unqualified** — `_canPinSession()` false, same Neon-shaped fixture stands for it | index-free by construction (`client.batch()` rejects the whole request) | declares `supportsOrderedCommittedSegments = true`; **unqualified** — no witness in this repository, and the flag is NOT moved | 100, confirmed |

Declarations read for the table (source, not inference):

| driver | `supportsTransactions` | `supportsBatch` | `supportsOrderedCommittedSegments` | `pinnedSession` | `maxBindParametersPerStatement` |
| --- | --- | --- | --- | --- | --- |
| `pglite` | inherited `true` | inherited `false` | inherited `false` | present | 65 535 |
| `pg` | inherited `true` | inherited `false` | inherited `false` | present | 65 535 |
| `postgres` | inherited `true` | inherited `false` | inherited `false` | present | 65 535 |
| `bun-sql` | inherited `true` | inherited `false` | inherited `false` | present | 65 535 |
| `mysql2` | inherited `true` | inherited `false` | inherited `false` | present | 65 535 |
| `planetscale` | `true` | inherited `false` | inherited `false` | absent | 65 535 |
| `sqlite3` | inherited `true` | inherited `false` | inherited `false` | absent | 999 |
| `bun-sqlite` | inherited `true` | inherited `false` | inherited `false` | absent | 999 |
| `libsql` | inherited `true` | inherited `false` | inherited `false` | absent | 999 |
| `neon-http` | `false` | `true` | inherited `false` | absent | 65 535 |
| `d1` | `false` | `true` | `true` | absent | 100 |

**A caveat that matters for §5.** `pinnedSession`'s ABSENCE does not mean "no
session". `src/drivers/driver.ts:194-200` says it is "Absent on every stateless
transport (Neon HTTP, PlanetScale, D1) **and on the SQLite family, which keeps
its existing single-connection queue**" — so the hook's absence conflates *no
session at all* with *one connection that IS the session but is not reserved
through this hook*. In production the conflation is harmless, because the only
drivers on the batch route (Neon HTTP, D1) are genuinely sessionless. It is not
harmless for the FIXTURES, which are SQLite drivers forced onto the batch
route; §5 measures exactly how much.

---

## 3. The pins

Credential-free, registered in `scripts/raptor3-manifest.mjs`:

- `tests/raptor3/g4/parity/batch-only-drivers.ts` — the family gains
  `SessionlessBatchOnlyDriver`: batch-only, atomic, pins no session, and
  **discards its temporaries between batches**. Its only difference from its
  session-keeping sibling `BatchOnlyDriver` is the transport fact D-53 names,
  which is what lets the same payload run on both.
- `tests/raptor3/g4/parity/transport-witnesses.test.ts` (6 cells,
  `G4_PARITY_COUNTS`):
  1. *a second segment's scratch is gone on a transport that pins none* — a
     two-member series whose second member's probe takes the boundary N5 gives
     it, so the second member's own generated key is stored in a LATER segment.
     Rejects with the raw provider failure after one committed segment, and the
     failure reports `committedSegments: 1, mayHaveCommittedSegment: true`.
  2. *even the scratch CLEANUP is a carry* — the same series whose probe FINDS
     the first member's row: every write commits, and the operation still fails,
     because the terminal segment's `DELETE FROM "__viborm_batch_refs"` names a
     table its own transport discarded.
  3. *the same series completes on a transport that keeps its session* — the
     control on `BatchOnlyDriver`.
  4. *a ONE-segment nested write is within what one batch proves* — D-50's first
     pin still holds on the sessionless transport, which is the plan's own
     bound on what PGlite proves.
  5. *the real sqlite3 seam names the failing statement and leaves nothing
     behind* — `SQLite3Driver._executeBatch` of three statements, the third a
     duplicate key: `statementIndex === 2` and the table is empty.
  6. *Neon HTTP declares no session to pin* — `_canPinSession()` false and the
     bind capacity, the two declarations no other suite owns.
- `tests/raptor3/g4/parity/transport-seam-pglite.test.ts` (2 cells,
  `D53_PROVIDER_TESTS`, live PGlite, `--project raptor3-provider`) — the
  PostgreSQL half of the same seam fact: `statementIndex === 2` for the third
  statement of a batch, and nothing left behind the batch it aborted.

Credential-gated:

- `tests/providers/hosted/neon-http-transport.test.ts` — three cells behind
  `describe.skipIf(!databaseUrl)` with `NEON_TEST_DATABASE_URL`, the exact
  gating of its sibling `neon-http.test.ts`: a failed batch leaves no writes; a
  committed batch is durable for the next request; a temporary does not survive
  to the next batch. **Unset in this environment, so all three skip by name and
  the file fails nothing.** Unlike its sibling it does mutate the endpoint (one
  table of its own, created and dropped), because commit certainty cannot be
  witnessed by a read. It is deliberately NOT evidence for
  `supportsOrderedCommittedSegments`, which needs proof that the commit is
  identified BEFORE result decoding; nothing here can see that boundary, and
  the flag is not moved.

Not restated here, because they already have an owner:
`tests/contracts/engine/write/neon-committed-segments-capability.test.ts` owns
Neon's capability trio and its index-free multi-statement rejection;
`tests/raptor3/prep/native-constraint-ownership.test.ts` owns the engine-route
`statementIndex`; `tests/raptor3/g4/parity/ordered-observation.test.ts` owns
"nothing of the unit commits" for the atomic batch.

Registrations: `G4_PARITY_COUNTS` (6) and a new `D53_PROVIDER_TESTS` spread
into `RAPTOR3_PROVIDER_TESTS` in `scripts/raptor3-manifest.mjs`; the same list
added beside `D50_PROVIDER_TESTS` in
`scripts/credential-free-test-manifest.mjs` (so the live-PGlite file is
excluded from the packed extended-local shards) and in
`scripts/run-credential-free-tests.mjs` (so it runs isolated under the
allowlisted PGlite ceiling); `vitest.workspace.ts`'s `neon-http` provider
project globs its own prefix, `tests/providers/hosted/neon-http*.test.ts`.

---

## 4. Falsification record

| what was falsified | how | result |
| --- | --- | --- |
| `SessionlessBatchOnlyDriver` really measures the transport fact | removed the `DROP TABLE IF EXISTS temp."__viborm_batch_refs"` from its `executeBatch` | cells 1 and 2 go red ("provider failure: undefined" — the operation succeeds); cells 3–6 stay green |
| the sqlite3 seam index is measured, not assumed | asserted `statementIndex === 1` instead of `2` at the file's one index assertion (cell 5, `transport-witnesses.test.ts:271`) | that cell goes red in both projects; cells 1–4 and 6 stay green |
| the PGlite seam index is measured, not assumed | asserted `statementIndex === 1` instead of `2` | "names the statement of the batch that failed" goes red; "leaves no writes" stays green |
| the proposed refusal of §5 is not free | applied it as a probe and ran the whole parity family and three batch-route suites | 8 registered cells go red: `member-boundary-packaging.test.ts` ×4, `published-key.test.ts` ×1 and this unit's own `transport-witnesses.test.ts` ×3 — six of them on the session-KEEPING fixture (the five named plus the control "the same series completes on a transport that keeps its session"), refused wrongly; cells 1 and 2 on the sessionless fixture, which pin the bare provider failure the refusal would replace, would be re-expressed to it |

---

## 5. The engine change NOT made — a ruling for Arnaud

**What the plan expects.** §4 "The transport fact" says the engine "states that
once: a unit that would carry a scratch reference into a later segment is
refused on a driver without a pinned session (**the existing sentence, at its
existing site**)".

**What is actually there.** Nothing. `pinnedSession` / `_canPinSession` has no
reader anywhere under `src/query-engine/` or `src/client/`, and the sentence
the plan remembers is the RETIRED engine's
`"query-engine-v2 cannot merge an insertId-scratch operation into a shared
driver batch."` (`0cc61e61f:src/query-engine/write-engine/OperationExecutor.ts:1517`),
which this engine deliberately retired — the guide says so:
"The shipped route's insertId-scratch refusal is retired… Do not re-introduce
that refusal in the route" (`raptor3/AGENTS.md`). So there is no existing site
and no existing sentence.

**What the gap costs, measured** (cells 1 and 2 of
`transport-witnesses.test.ts`): on a batch-only transport that pins no session,
a nested write whose second segment touches the scratch fails with a bare
`QueryError: Query execution failed` after a committed segment — and in the
sharper shape every write of the operation has committed and the operation
still reports failure, because only the scratch CLEANUP was left outside the
session. Both shapes are DERIVED for Neon HTTP and D1, not measured there: the
batch route follows from `supportsTransactions = false`, and the D-50 scratch is
a session-scoped temporary table in both dialects (PostgreSQL `CREATE TEMP
TABLE`, SQLite `temp.`); the gated cell "a temporary does not survive to the
next batch" of `tests/providers/hosted/neon-http-transport.test.ts` is the
witness that would make it measured for Neon HTTP, and D1 has no witness at
all. What the SQLite fixture measures is the engine's side of the shape. Both
reach the engine with an ordinary admitted
payload.

**The smallest change that states it**, at the one owner that knows both facts
— the scratch is the attempt's (`TransportAttempt.scratchId`), the session is
the driver's — is in `OperationContext.submit`, immediately after the batch's
statements are assembled and before it is dispatched:

```ts
/** D-53: the scratch lives on the SESSION, not on the unit. */
private requireScratchSession(
  attempt: TransportAttempt,
  statements: readonly BatchQuery[]
): void {
  const scratch = attempt.scratchId;
  if (scratch === undefined) return;
  if (!attempt.scratchDispatched) {
    attempt.scratchDispatched = true;   // one new field beside `scratchId`
    return;
  }
  if (this.driver._canPinSession()) return;
  if (!statements.some((statement) => statement.params?.includes(scratch)))
    return;
  throw new TransactionError(
    `Driver '${this.driver.driverName}' cannot carry a batch reference into a later segment: the transport pins no session, so the scratch the earlier segment made is gone.`,
    { meta: { driver: this.driver.driverName, operation: this.operation } }
  );
}
```

**Why it was not applied — two blockers, either of which is Arnaud's to rule
on.**

1. **The sentence would be a NEW PUBLIC refusal.** The brief's condition is
   "with the registered sentence if the shipped corpus has one… the public set
   must not grow; if a new public sentence is unavoidable, STOP and report it
   as a ruling". The shipped corpus at `0cc61e61f` carries no sentence for this
   fact. The three nearest are about other facts: the retired array-route
   `insertId-scratch` merge refusal; `"query-engine-v2 cannot materialize
   generated output … across statements inside one indivisible shared batch.
   Use the default operation form or a driver with an interactive
   transaction."`; and `"Step '…' publishes an insert id a later statement of
   the same unit consumes, and this dialect has no batch scratch for it"` —
   which is a DIALECT fact, not a session fact. Spelling this one therefore
   takes the public census from 23 distinct sentences to 24.
2. **`_canPinSession()` is not a clean reading of the fact** (§2's caveat).
   Applied as written it turns **8 registered cells** red — four in
   `member-boundary-packaging.test.ts`, one in `published-key.test.ts`, three in
   this unit's own `transport-witnesses.test.ts` — six of them on
   `BatchOnlyDriver`, a fixture whose one better-sqlite3 connection DOES keep
   the scratch and which is therefore refused wrongly (the five named and the
   control "the same series completes on a transport that keeps its session");
   the other two are cells 1 and 2 on the sessionless fixture, which pin the
   bare provider failure the refusal would replace and would be re-expressed to
   it. Two honest repairs
   exist, and the choice is a ruling: give the session-keeping fixture the
   `pinnedSession` hook it truthfully could implement (a test-only change, and
   the declaration then means what D-53 wants it to mean), or give the drivers
   a declaration that says session lifetime rather than migration-lock
   reservability.

**The alternative with no new sentence, for comparison.** Make the scratch's
own setup ride EVERY dispatch that touches it, with a fresh scratch id per
dispatch on a transport that pins no session. Cells 1 and 2 would then both
PASS rather than be refused — a second segment re-creates its table and stores
its own key, and the cleanup becomes a no-op — and the only thing left
unexpressible is a value stored in one segment and read in a later one, which
the engine already derives at one owner
(`AssertedPremise.readsBatchReference` / `OperationContext.readsBatchReference`,
`operation-context.ts:1241`). It is a larger change than a refusal and it
changes behaviour on pinned drivers too, so it is offered as the other arm of
the ruling, not as this unit's work.

Until either lands, the table's verdict stands: **Neon HTTP and D1 are
UNQUALIFIED for any behaviour that carries a batch reference scratch across a
segment**, and a one-segment nested write (D-50's first pin) is within what
PGlite proves — which cell 4 measures on the sessionless transport itself.

### Addendum, 2026-09-21 — ruling D-58 took the alternative

Arnaud ruled the second arm of §5: EXECUTE by carrying the VALUE, not a
reference. The unit is `g4/release/d58/note.md`. Two rows of §2's table change
their meaning and nothing else in this note is rewritten:

- **`neon-http` / session lifetime** and **`d1` / session lifetime**:
  "unqualified — for a scratch reference that crosses a segment" is retired as
  a verdict about the ENGINE, because no scratch reference crosses a segment
  any more. Every dispatched unit creates its own scratch, reads back what it
  stored at its own boundary and drops it there; the next unit binds literals.
  The row now reads **qualified on the Neon-shaped fixture, UNVERIFIED live**:
  the executed end state is pinned on `SessionlessBatchOnlyDriver`
  (`transport-witnesses.test.ts` cells 1–3), and the live witness is still the
  credential-gated `tests/providers/hosted/neon-http-transport.test.ts`, which
  is about the PROVIDER's temporaries and skips where the credential is unset.
- Every other row, and the `supportsOrderedCommittedSegments` verdict for both
  drivers, is unchanged. No capability flag moved.

§5's refusal — the one that would have taken the census from 23 to 24 and
turned 8 registered cells red — is **not** taken, and the `_canPinSession()`
reading it needed gains no engine reader. §4's fourth falsification row
therefore records a refusal that was measured and declined, not one that was
deferred.

---

## 6. Runs

All through `node scripts/run-vitest-safe.mjs run <file>` with
`TMPDIR=/private/tmp/viborm-d53-tmp`, one at a time; the live-PGlite file
through the sanctioned isolated stage with `--project raptor3-provider`.

| run | result | resources |
| --- | --- | --- |
| `tests/raptor3/g4/parity/transport-witnesses.test.ts` | 12 / 12 (6 cells × 2 projects) | 4.8 s wall, 537 MiB peak |
| `tests/raptor3/g4/parity/transport-seam-pglite.test.ts` (`raptor3-provider`) | 2 / 2 | 3.3 s wall, 1348 MiB peak |
| `tests/providers/hosted/neon-http-transport.test.ts` | 3 skipped (env var unset), file passes | 3.2 s wall, 497 MiB peak |
| the 12 other importers of `batch-only-drivers.ts` | 247 / 247 | ≤ 5 s each |
| `tests/raptor3/post-prep/g29-result-progress.test.ts`, `tests/raptor3/prep/set-preparation.test.ts` | 16 / 16 | ≤ 5 s each |
| `node scripts/run-typecheck.mjs` | 0 diagnostics | 5.5 s wall, 4348 MiB peak |
| `node scripts/raptor3-refusal-census.mjs` | byte-identical to the base census: 23 public sentences at 30 sites, 72 registered, 21 invariants, 11 internal | — |
| `node scripts/query-engine-structure.mjs` | 38 files, 20 120 lines, 15 960 token lines — unchanged, no engine source touched | — |

Biome per file, current against the base copy at `32aa01d8a`:

| file | base | now |
| --- | --- | --- |
| `tests/raptor3/g4/parity/batch-only-drivers.ts` | 0 | 0 |
| `scripts/raptor3-manifest.mjs` | 70 | 70 (pre-existing, untouched) |
| `scripts/credential-free-test-manifest.mjs` | 0 | 0 |
| `scripts/run-credential-free-tests.mjs` | 0 | 0 |
| `vitest.workspace.ts` | 1 | 1 (pre-existing import order, untouched) |
| `tests/raptor3/g4/parity/transport-witnesses.test.ts` | new | 0 |
| `tests/raptor3/g4/parity/transport-seam-pglite.test.ts` | new | 0 |
| `tests/providers/hosted/neon-http-transport.test.ts` | new | 0 |

## 7. Unverified, and still red

- **Unverified: the three hosted Neon cells.** `NEON_TEST_DATABASE_URL` is
  unset in this environment, so they have never executed. Their shape is
  type-checked and their gating is measured; their ANSWERS are not evidence
  until a run with the credential produces them.
- **Unverified: `d1`'s `supportsOrderedCommittedSegments = true`.** The
  declaration is read, not witnessed; no D1 witness for it exists in this
  repository. The flag is left exactly as it is, per the brief.
- **Derived, not measured: the failure-attribution and commit-certainty cells
  for `pg`, `postgres`, `bun-sql`, `mysql2`, `planetscale`, `libsql`,
  `bun-sqlite`.** They share the one seam measured live on PGlite and sqlite3
  (`driver-transaction-base.ts:659`), and none of them takes the batch route,
  so the derivation is from the same code rather than from a provider claim —
  but it is a derivation. Docker (`pg`, `mysql2`) and Bun were not run.
- **Still red: nothing.** No suite is red at this unit's tip that was green at
  `32aa01d8a`.
