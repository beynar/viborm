# D-58 — a value produced in one segment is carried into the next as a literal (unit note)

Ruling D-58 (Arnaud, 2026-09-21, 09:50), taking the alternative offered in
`g4/release/d53/note.md` §5 rather than the refusal: on a batch-only transport
that pins no session (Neon HTTP, D1), a nested write the engine dispatches as a
SUCCESSION of segments must EXECUTE. Each dispatched unit creates its own
scratch; a value stored in one segment and read in a later one is read back at
the segment boundary and carried into the next unit as a LITERAL. No new public
sentence, no transport branch.

Worktree `/private/tmp/viborm-d58`, branch `d58` from `33f4478b6` (M1, D-59).
The integrator commits.

---

## 1. The derivation

**Which statements of a later segment read the scratch.** The engine already
knows, and the answer was three kinds, not one:

1. **A later segment's STORE.** `ensureScratch` minted ONE id per transport
   ATTEMPT and queued `batchRefs.setup` + `clear` into whichever unit happened
   to be open. A second member whose probe took the boundary N5 gives it
   therefore stored its own generated key with `INSERT INTO
   "__viborm_batch_refs" …` in a LATER batch, against a table only the first
   batch created. (D-53 cell 1.)
2. **A later segment's READ.** `insert` published the produced increment key as
   `cast(references.read(scratchId, key), width)` and `update` published an
   `int` arithmetic the same way; the value reached its consumers through
   `CommandAttempt`'s bindings, and a consumer in a later segment bound the
   expression verbatim. The engine derives exactly this at one owner already —
   `OperationContext.readsBatchReference` for `AssertedPremise` and for the
   continuation guards (N5) — and a MEMBERSHIP CONTINUATION was the sharpest
   case: its query was built when the continuation was DECLARED, so the guard a
   later segment carries named the producing unit's scratch.
3. **The CLEANUP.** `finishTerminals` queued the one `batchRefs.cleanup` at the
   operation's end, which is a later segment than the one that created the
   table whenever the write segmented at all. (D-53 cell 2: every write
   commits and the operation still fails, on the DELETE alone.)

**What a segment boundary must do for them.** At the boundary the dispatched
unit's scratch values are read back — `references.read` for every key the unit
stored, inside the SAME batch, at its end — and the next unit binds them as
literals. Three consequences follow and nothing else is needed:

- **(1) disappears**: a unit that stores creates its own scratch
  (`ensureScratch` per UNIT, not per attempt), so no `store` ever names a table
  an earlier segment made.
- **(2) disappears**: the consumer binds the read-back value, so no `read`
  crosses. The continuation therefore STATES its query when its GUARD is built,
  not when it is declared, and `MembershipParent.where` resolves through the
  interpreter that holds the row rather than through a snapshot taken at
  declaration.
- **(3) disappears**: the cleanup rides the unit that created the scratch.

**Why the terminal unit reads nothing back.** The operation's terminal
statements are the one unit with no next, and the one unit a prepared package
IS. `finishTerminals` closes the scratch there, so `submit` finds none and
carries nothing: a ONE-segment nested write (D-50's first pin, D-53 cell 4)
costs exactly what it cost before this unit. Measured — see §4.

**Why there is no transport branch.** The boundary behaves identically on a
session-keeping driver; it is simply one `SELECT` more per unit that stored a
produced value AND is followed by another. Measured on `BatchOnlyDriver` in §4.
`pinnedSession` / `_canPinSession` gains no engine reader, which is what keeps
the census at 23 (§6).

**Where the literal binds.** `Queries.fieldValue` is already "the one
destination-aware operand owner: filters, cursors, order operands, assignments
and reference values all bind a value through this function". Hand it the
literal instead of the `Sql` and a carried key binds exactly as a SPELLED key
does, through the field's own codec — which is also why the read-back goes
through `referenceProjection`, the estate's existing owner of "read a produced
value back": the value returns decoded in the field's domain (`bigint` as a
BigInt), not as a provider string.

---

## 2. The engine change

One fact — *a value crosses a segment as a literal* — at one owner: the place
that assembles a dispatched unit and knows its boundary, `OperationContext.submit`.

| hunk | what it states |
| --- | --- |
| `src/query-engine/raptor3/shared/transport-attempt.ts` | `ScratchPublication` (model, field, expression); `publishScratchValue` / `drainScratchPublications`; `carryScratchValue` / `carried`, the read-back literals held beside `scratchId`; `scratchId`'s docblock now says it is the UNIT's. |
| `shared/operation-context.ts` — `carryScratch` (new) | Queues one `referenceProjection` SELECT per value this unit stored, at the end of the unit's own batch; answers the plan to settle. |
| `shared/operation-context.ts` — `settleCarry` (new) | Decodes one read-back through the projection and records the literal on the attempt. A value the provider MALFORMED is this operation's RESULT failure (`this.failure(error, "result", member)`) — the same answer the terminal read gives for the same row — so the settle sits AFTER the transport's own try/catch and is never read as a rejection of the unit that wrote it. |
| `shared/operation-context.ts` — `closeScratch` (new) | Queues `batchRefs.cleanup` and spends `scratchId`: the scratch dies with the unit that made it. Called by `submit` (a dispatched unit's end) and by `finishTerminals` (the operation's last unit, and the prepared package's). |
| `shared/operation-context.ts` — `submit` | `carryScratch()` then `closeScratch()` before the pending queue is spliced; the read-back responses are settled after a successful dispatch. |
| `shared/operation-context.ts` — `Continuation` | `readonly state: () => Query` + a memoised `query`: the guard's query is STATED when the guard is built. `submit` builds guards from it and the ladder derives `readsBatchReference` from the same stated query. |
| `shared/operation-context.ts` — `MembershipParent.where` | `Input` → `() => Input`. |
| `shared/operation-context.ts` — `insert`, `update` | The published expression is named, recorded with `publishScratchValue`, then published; both continuations pass `state`. |
| `shared/operation-context.ts` — `ensureScratch`, `finishTerminals` | `ensureScratch` documents the unit ownership; `finishTerminals`' inline cleanup becomes `closeScratch()`. |
| `commands/command-attempt.ts` | `read` answers `this.transport.carried(bound[field])` — ONE reader. `references()` is DELETED: its only caller was the `choose` arm, and the boundary now owns the fact. |
| `commands/execution.ts` | `membershipParent` returns a `where` thunk; the `choose` arm's private read-back becomes the plain boundary `await ctx.flush(undefined, member)`. |
| `shared/operation-context.ts` — `flush` | The trailing premises step aside at EVERY boundary this owner takes, not only where the caller passed a projection. D-29's rule must not change because the `choose` arm stopped carrying its own read-back, and conditioning it on the projection list made it depend on the caller's shape. The broadened arm is not merely inert, it is UNEXERCISED, and that is a property of the change rather than an accident: `flush` instrumented to log every call with NO projections that actually moved statements out of `pending` (`withholdPremises` grew `withheld`) produced ZERO hits across the whole credential-free `tests/raptor3/g4/parity/` directory (24 files, 41 file-project pairs, 345 cells) and across `nested-write-conformance-membership` (30 cells) — no boundary in either corpus reaches `flush` with no projections while a trailing premise waits. So the hunk can carry no pin, and restoring `if (projections.length > 0)` is the equally inert alternative. The two pre-existing callers the broadened arm now also covers are `executeMember`'s `flush(undefined, member)` (`operation-context.ts:547`) and `answer`'s `flush()` (`operation-context.ts:1045`) — boundaries this unit does not otherwise touch. (`receipts/`.) |

Registered refusals, invariants and internal sentences: untouched (§6).

---

## 3. Pins and their base results

`tests/raptor3/g4/parity/transport-witnesses.test.ts` — the D-53 file keeps its
owner and its six facts; cells 1 and 2 are re-expressed from the bare provider
failure to the executed end state, and a three-segment cell is added. **7
cells** (was 6).

| cell | states | at the base (`33f4478b6`) |
| --- | --- | --- |
| 1. *a second segment STORES its own member's key, because the scratch is its own* (`SessionlessBatchOnlyDriver`) | both members write; each child bound to the key its OWN segment's provider generated (`alpha`→1, `beta`→2) | **red**: `QueryError: Query execution failed` after one committed segment |
| 2. *the scratch CLEANUP rides the segment that made it, so the terminal segment carries none* (sessionless) | one writer, both notes, no error | **red**: same bare failure, with every write already committed |
| 3. *a value produced in the first segment is a literal in the second and the third* (sessionless, NEW) | a series of three probing members under a parent whose key the provider generates: 4 dispatched units, all three children hold the parent's key, and NO statement after the first unit names `__viborm_batch_refs` | **red**: `QueryError: Query execution failed` |
| 4. *the same series completes on a transport that keeps its session* | unchanged control | green, unchanged |
| 5. *a ONE-segment nested write is within what one batch proves* | unchanged (D-50's first pin) | green, unchanged |
| 6. *the real sqlite3 seam names the failing statement* | unchanged | green, unchanged |
| 7. *Neon HTTP declares no session to pin* | unchanged | green, unchanged |

**One further cell is re-expressed, and the derivation names why.**
`tests/raptor3/g3/author-execution-regressions.test.ts` → *"reports a malformed
result on the transport its plan uses, with the progress that transport has"*
pinned the packaging in as many words: *"Two batch entries … the write window
(scratch prologue, parent insert, generated-key capture, child insert) and the
terminal window (the read-back and the scratch release)."* Under D-58 the
scratch release rides the write window and the key it produced is read back
there, so a driver that malforms int results meets the corrupted value inside
the window that WROTE it: `batchCalls` 2 → **1**, and
`recordSeriesProgress.completedMembers` 2 → **1**, because the result failure is
raised before the second member completes. Everything else the cell pins is
unchanged and still asserted — the error class and code, the exact message
(`Driver "sqlite3" returned a malformed int scalar for operation "createMany":
the value is not a canonical integer.`), `atomicity: "segment"`,
`phase: "result"`, `committedSegments: 1`, `committedWriteMembers: 2`, the
corrupted flag, and both row sets. The two numbers are re-expressed at the cell
with D-58 named and the reason stated.

The fixture schema gains one field for cell 3: `holder.code`, a unique that is
NOT the key, because a `connectOrCreate` on a non-key unique is answered by a
lookup outside the queue — which is what gives a member its boundary.

The credential-gated `tests/providers/hosted/neon-http-transport.test.ts` is
untouched: "a temporary does not survive to the next batch" is a fact about the
PROVIDER, not about the engine, and stays the live transport witness. It skips
by name (`NEON_TEST_DATABASE_URL` unset) exactly as before.

### Falsification record

| what was falsified | how | result |
| --- | --- | --- |
| the three D-58 cells are red at the base | the four engine files replaced by `git show HEAD:…` (backup copies restored after; no `git checkout`) | cells 1, 2 and 3 red with the bare `QueryError`; cells 4–7 green |
| the READ-BACK is load-bearing, and on BOTH transports | `carryScratch` drains its publications without queueing the SELECT | cell 3 red (sessionless) **and** `published-key`'s batch-only *"a child-held arm placed after the parent's write names the key that write published"* red with `No piece record found for update` — the session-KEEPING fixture, i.e. not a transport fact |
| the scratch is the UNIT's, not the attempt's | `closeScratch` stopped spending `attempt.scratchId` | cells 1, 2, 3 red, and cell 4 (D-50's one-segment pin) red with `malformed int scalar … a required scalar is null` |

---

## 4. Statement-count deltas

Measured on the recording `BatchOnlyDriver` family (a temporary
`console.log` in `RecordingSQLiteDriver.executeBatch`, reverted), base vs tip,
per cell. **The unit COUNT never changes**; the only new statement is the
read-back SELECT, and the cleanup DELETE moves from the terminal unit into the
unit that made the scratch.

| pin | cell | base (statements per dispatched unit) | now | delta |
| --- | --- | --- | --- | --- |
| `member-boundary-packaging` | a nested createMany of literal rows is ONE unit with its parent | 4 | 4 | 0 |
| | a member a later member must SEE still takes its boundary | 6, 2, 2 | 8, 2, 1 | +1 |
| | it takes it while the parent's own write is still pending | 7, 4 | 9, 3 | +1 |
| | it takes it where the parent row is itself the pending write | 6, 4 | 8, 3 | +1 |
| | an observing series that then fails (D-51) | 6, 5 | 8, 4 | +1 |
| `batch-observed-publication` | all 10 cells | 1×5, 3×5, 7×1 | identical | 0 |
| `published-key` | a child-held arm placed after the parent's write names the key that write published (batch-only route) | 6, 4 | 8, 3 | +1 |
| | the other 11 cells | — | identical | 0 |
| `increment-key-width` | a `bigint` increment key stored after its INSERT and read back at width | 7 | 7 | 0 |
| `postgres-identity-scratch` (live PGlite) | carries a generated parent key to its nested creates in one native batch | 7 | 7 | 0 |
| | carries the key to a nested createMany across the series' committed segments | 7 | 7 | 0 |

The +2/−1 shape is the whole change: the producing unit gains the read-back
`SELECT (CAST((SELECT "ref_value" …) AS INTEGER)) AS "id"` and the
`DELETE FROM "__viborm_batch_refs"`, and the unit that used to carry the
terminal cleanup loses it. An operation that never crosses a boundary while
holding a scratch — every one-unit nested write, every `postgres-identity-scratch`
cell, every `increment-key-width` cell, every `batch-observed-publication`
cell — pays nothing.

**No pin's count assertion is re-expressed.** None of the five asserts an
absolute statement count; `member-boundary-packaging` asserts the number of
dispatched UNITS (`driver.segments`), which is unchanged, and the others assert
statement ORDER and shape. The only cells re-expressed are D-53's, and the
derivation names why: their end state, not their packaging, is what the ruling
changes.

---

## 5. Registrations to apply (not made here — the brief forbids editing the manifest)

- `scripts/raptor3-manifest.mjs`, `G4_PARITY_COUNTS`:
  `"tests/raptor3/g4/parity/transport-witnesses.test.ts": 6` → **7**.
  Nothing reads the VALUES (only `Object.keys`), so no suite is red without it;
  it is the documented cell count and should follow the file.

No other registration changes: no file added, none removed, no provider list
touched.

---

## 6. Runs

`TMPDIR=/private/tmp/viborm-d58-tmp`, one vitest at a time through
`node scripts/run-vitest-safe.mjs run <file>`; the live-PGlite files through the
worktree launcher with `--project raptor3-provider`.

| run | result |
| --- | --- |
| `node scripts/run-typecheck.mjs` | **0 diagnostics** (5.3 s wall, 5103 MiB peak) |
| `tests/raptor3/g4/parity/`, the whole directory in three chunks (27 files; the three live-PGlite files run separately under the isolated stage) | 140 / 140, 137 / 137, 70 / 70 — **347 / 347** |
| `tests/raptor3/g4/parity/transport-witnesses.test.ts` | 14 / 14 (7 cells × 2 projects) |
| the six `nested-write-conformance-*` files + `parent-held-lookup`, `shared-pk-update-root`, `supplier-continuation` | 320 / 320 |
| the atomic-output family (`generated-output-continuation-race`, `generated-output-fallback`, `junction-produced-identity`, `fresh-create-subtree`, `create-junction-upsert`, `compound-relation-adoption`) | 53 / 53 |
| all 57 credential-free `tests/contracts/engine/write/` files, in three chunks | 185 / 185, 233 / 233, 388 / 388 — **806 / 806** |
| `tests/raptor3/g3/author-execution-regressions.test.ts` | 6 / 6 after the re-expression (1 red before it, by derivation) |
| `post-prep/g29-*` ×4 + `transitions/{series-staleness,supplier-continuations,staleness}-commands` | 94 / 94 |
| `postgres-identity-scratch`, `postgres-declared-type-scratch`, `transport-seam-pglite` (live PGlite) | 7 / 7 |
| `tests/providers/hosted/neon-http-transport.test.ts` | 3 skipped by name, file passes |
| `node scripts/run-raptor3.mjs g3-generated-transport-smoke` | 1 / 1 |
| `… g3-transaction-array` | 4 / 4 |
| `… g2-baseline` | 216 / 216 |
| `… g2-contracts` | 216 / 216 |
| `… g1-compare` | 36 / 36 |
| `pnpm test:all --only "Raptor 3 fixed"` | **864 / 864** (82 files; 863 at the base plus this unit's new cell) |

**Census** (`node scripts/raptor3-refusal-census.mjs`): invariants 22 sites / 21
distinct, internal 11 / 11, registered 72 / 72, **public 30 sites / 23 distinct
sentences** — every one of those four byte-identical to the base. The one
difference is the rethrow column, **55 → 56**: `settleCarry` re-raises a decode
failure through `this.failure`, which carries no sentence of its own. Total
sites 190 → 191. No sentence was added, removed or changed, and the public count
the brief asks about is unchanged.

**Biome**, per file, base vs now:

| file | base | now |
| --- | --- | --- |
| `src/query-engine/raptor3/shared/operation-context.ts` | 6 | 6 (pre-existing, untouched) |
| `src/query-engine/raptor3/shared/transport-attempt.ts` | 0 | 0 |
| `src/query-engine/raptor3/commands/command-attempt.ts` | 1 | 1 (pre-existing, untouched) |
| `src/query-engine/raptor3/commands/execution.ts` | 4 | 4 (pre-existing, untouched) |
| `tests/raptor3/g4/parity/transport-witnesses.test.ts` | 0 | 0 |
| `tests/raptor3/g3/author-execution-regressions.test.ts` | 8 | 8 (pre-existing, same rules, same format hunks) |
| `src/query-engine/raptor3/AGENTS.md` | n/a (markdown) | n/a |

**LOC** (`node scripts/query-engine-structure.mjs`, charged engine source):
38 files, **20 120 → 20 295 lines (+175)**, **15 960 → 16 029 token lines
(+69)**. The token-line share is the mechanism; the rest is the prose that
states it.

---

## 7. Unverified, and what stays open

- **Unverified live: Neon HTTP and D1.** The shape is measured on the
  Neon-shaped SQLite fixture (`SessionlessBatchOnlyDriver`), not on the
  providers. `NEON_TEST_DATABASE_URL` is unset here, so the three hosted cells
  still skip; D1 has no witness in this repository. The D-53 table's session
  row for both drivers is now **qualified on the fixture, unverified live** —
  recorded as a dated addendum in that note, not a rewrite.
- **Unverified: `d1`'s `supportsOrderedCommittedSegments = true`.** Untouched by
  this unit, as by D-53.
- **Not measured here:** Docker `pg` / `mysql2` and Bun. The change is dialect-
  neutral (it is the engine's placement of statements the dialect already
  spells), and the PostgreSQL half runs live on PGlite.
- **Still red: nothing.** No suite is red at this unit's tip that was green at
  `33f4478b6`.

---

## 8. The commit message

```
feat(raptor3): a value produced in one segment is carried into the next as a literal — every dispatched unit owns its scratch (D-58)

The D-50 batch reference table is a session-scoped temporary, so it belongs to
the dispatched UNIT and not to the operation. `ensureScratch` mints one per
unit; `submit` — the one place that assembles a unit and knows where it ends —
reads back every value that unit stored (one SELECT through
`referenceProjection`, inside the same batch) and then drops the table.
`TransportAttempt.carried` holds the literals beside the scratch id, and
`CommandAttempt.read`, the one reader of a field's runtime value, answers the
literal in place of the spent expression, so every later statement, premise,
guard and terminal read binds it exactly as a spelled key would. A membership
continuation states its query when its GUARD is built, not when it is declared.

No transport branch, no new public sentence: the census stays at 23 public
sentences at 30 sites. D-53's cells 1 and 2 are re-expressed from the bare
provider failure to the executed end state on `SessionlessBatchOnlyDriver`, and
a three-segment cell is added; the gated Neon cell stays the transport witness.
A one-segment nested write costs exactly what it cost before; a unit that
crosses a boundary costs one SELECT more, and the cleanup moves into the unit
that made the scratch.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

## 9. Repair round — 2026-09-20

Five review findings, all five applied; none declined. The unit's truth, its one
owner and its pins are unchanged. Sections 1–8 stand as the first round's
record; this section is the dated addendum, not a rewrite.

| # | severity | finding | what changed |
| --- | --- | --- | --- |
| 1 | major | The carry settle was the FIRST throw out of `submit` after a dispatch that SUCCEEDED, and it bypassed `settleSubmitted` — the owner that composes and releases `heldOutcomeFailure`. A `committedSegment` listener failure the batch HELD while it acknowledged was silently dropped, and left set on the context. | `shared/operation-context.ts`, `submit`: the carry loop is wrapped, and its catch releases the hold and composes it exactly as the dispatch-failure arm above already does (`this.answered(this.retainOutcomeFailure(error, held.failure))`). The comment above states why this is the one throw that must do it. |
| 2 | minor | `transport-witnesses` cell 3 asserted `batchCalls >= 4` where the fact is exactly 4 — an inequality cannot notice a regression that splits the operation into MORE units, which is the packaging §4 claims never moves. | `assert.ok(dispatched.batchCalls >= 4, …)` → `assert.equal(dispatched.batchCalls, 4, …)`. Green: the count is exactly 4. |
| 3 | minor | `if (!row) return;` in `settleCarry` was a guard whose unique coverage cannot be named, and it failed SILENTLY in the one way this unit exists to prevent: with no row nothing is carried, the spent `Sql` keeps answering, and the next unit binds a scratch its own segment never created. | The guard is dropped: `…decodeQuery(carry.query, response.rows, true)[0]!`. `settleCarry` gains a docblock stating why one row is guaranteed — `referenceProjection` builds a projection-only `SELECT <expression>` with no FROM and no cardinality of its own, so every provider answers it with one row. A violation is now a type error, not an uncarried value. |
| 4 | minor | `referenceProjection` lost its only external caller when the `choose` arm's private read-back was deleted but stayed public — dead surface inviting a second reader of the read-back this unit centralised. | `private referenceProjection(…)`. The guide sentence at `AGENTS.md:1104-1106` still names it as the owner and needed no change. |
| 5 | minor | The `flush` premise-withholding hunk carries no pin, and §2's justification ("measured inert") was weaker than what is measurable. | §2's `flush` row now states the stronger measured fact and its bound (the arm is UNEXERCISED in both corpora, so it can carry no pin) and names the two pre-existing callers it now also covers, `operation-context.ts:547` and `:1045`. No code changed. |

### Falsification of the repair

| what was falsified | how | result |
| --- | --- | --- |
| the composition in finding 1 is load-bearing | `acknowledged()` patched to raise a throwing listener (`throw new Error("PROBE-LISTENER")` inside its try), `author-execution-regressions` run (the malformed-int cell reaches the carry decode failure); engine restored from a backup copy afterwards, `git status` unchanged | measured at one scope, the file on both projects (3 cells × 2 = 6 results), as passed / total: **6 / 6 before the repair** (the carry catch unwrapped — the listener failure vanished) and **4 / 6 after it**, the malformed-int cell red on both projects with the failure composed exactly as the shipped order states it: `AggregateError: Query execution and write-outcome publication both failed.` Re-measured by the integrator after the re-check (`receipts/repair-held-listener-composition.txt`); 6 / 6 again with the probe removed. |
| the broadened `flush` arm is unexercised (finding 5) | `flush` instrumented to log every call with no projections whose `withholdPremises` actually moved statements out of `pending`; the whole credential-free parity directory and `nested-write-conformance-membership` run under it; engine restored from a backup copy afterwards | **0 hits** in 345 + 30 cells |

### Runs after the repair

| run | result |
| --- | --- |
| `node scripts/run-typecheck.mjs` | **0 diagnostics** (6.7 s wall, 5227 MiB peak) |
| `tests/raptor3/g3/author-execution-regressions.test.ts` | 6 / 6 |
| `tests/raptor3/g4/unit02/uncertain-outcome-meta.test.ts` | 16 / 16 |
| `tests/raptor3/g4/unit02/malformed-result-cuts.test.ts` | 8 / 8 |
| `tests/raptor3/g4/parity/transport-witnesses.test.ts` | 14 / 14 (7 cells × 2 projects) |
| the credential-free `tests/raptor3/g4/parity/` directory, in halves (24 files) | 130 / 130 + 215 / 215 — **345 / 345** |
| `tests/contracts/engine/query/nested-write-conformance-membership.test.ts` (worktree launcher) | 30 / 30 |

**Census** (`node scripts/raptor3-refusal-census.mjs`): invariants 22 sites / 21
distinct, internal 11 / 11, registered 72 / 72, **public 30 sites / 23 distinct
sentences** — byte-identical to the base and to the first round. The rethrow
column moves **56 → 57** and total sites **191 → 192**: finding 1's catch
re-raises through `this.answered`, which carries no sentence of its own. No
sentence was added, removed or changed.

**Biome**, per file: `shared/operation-context.ts` 6 (unchanged — `format`,
`assist/source/organizeImports`, 4 × `lint/style/noParameterProperties` at
383-396, every one pre-existing and untouched; the file's format-hunk count is
48 before and after the repair, 49 at the base);
`tests/raptor3/g4/parity/transport-witnesses.test.ts` 0.

**LOC** (`node scripts/query-engine-structure.mjs`, charged engine source): 38
files, 20 295 → **20 319 lines** (+24 over the first round, **+199** over the
base), 16 029 → **16 036 token lines** (+7, **+76** over the base).

**Unverified, unchanged.** §7 stands: Neon HTTP and D1 are still unverified live,
and nothing red at this tip was green at `33f4478b6`.
