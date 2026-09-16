# G4-04 root integrated review — Area C (contracts and decisions)

Independent reviewer, read-only on production and tests. Opened 20:10, closed
21:05, 2026-09-15. Brief: [`briefs/root-review.md`](briefs/root-review.md)
"Area C"; checklist [`root-review-checklist.md`](root-review-checklist.md)
section C; ledger [`g4.md`](../g4.md); inputs
[`decisions-review.md`](decisions-review.md) and
[`root-review-A.md`](root-review-A.md).

Tree identity at open and at close, recomputed with `captureRaptor3Identity`:
production `e2d5bcb2201641372941c2c1fa6e648f52429fb3ca8ce948678baa80a31b589f`,
harness `838a1e1bb2080e863f5decb56ce90c5218da1e1a341532c21d5b0e04453bc6c5` —
byte-identical to [`freeze/identity.json`](freeze/identity.json) before and
after this review. Nothing was committed, staged or repaired. My probes live
under [`root-review-probes/C/`](root-review-probes/C/) and my receipts under
[`root-review-C-receipts/`](root-review-C-receipts/); both are under `docs/`,
which neither fingerprint hashes.

## Outcome

**REVISE** — on one finding, and it is a **ledger edit, not a source change**:
a decision is still owed to Arnaud and is in none of the ledger's decision
tables. The frozen identity stays valid and the running qualification does not
need to restart for it.

Everything else in Area C holds, and holds under measurement rather than
citation: no public API, argument, result shape or error class changed; the
one place the private route changes an answer reuses the shipped error identity
and sentence; twenty-three admitted public requests answer byte-identical
class, code, message, `meta` and committed rows on both routes; the two
decisions I re-checked with cells of my own are applied exactly as Arnaud
worded them, in both directions; and no diagnostic-meta difference is recorded
under RF-15 because the one candidate for it was closed by parity — which I
measured, on four `NotFoundError` refusals plus a `UniqueConstraintError` and a
`ForeignKeyError`.

Finding 2 is not about the candidate at all: **this review's probe runs
contended for the shared workspace lock and caused twelve of the integrator's
qualification modes to be recorded FAILED as lock refusals.** They need
re-running. I state it here, with the list and the timestamps, because nobody
else can attribute it.

## One row per checklist line

Checklist section C has two lines; the brief's Area C splits them into four
items. Both granularities are below.

| line | verdict | receipt or finding |
| --- | --- | --- |
| **C1a** — no public API, argument, result shape or error class changed | **CLOSED** | `git diff 0cc61e61 -- src` touches nineteen files; outside `raptor3/**` the only non-comment changes are the three client seams and the adapter vocabulary, and no `export` line changed anywhere outside `raptor3/**` (`git diff 0cc61e61 -- src ':!src/query-engine/raptor3' \| grep -E '^[+-]' \| grep -v '^[+-][+-]' \| grep export` is empty). `src/errors.ts` and `src/errors/**` are byte-unchanged, so no error class moved. Measured, not read: the public entry exports 48 names, none of them the route; `createClient.length === 1`; a second argument passed to `createClient` installs nothing (the engine below it still has `route === undefined` and still compiles one statement) — [`public-surface.log`](root-review-C-receipts/public-surface.log). Note 3 records the one public *type* that did widen (`DatabaseAdapter.expressions.integerDivide`), which the common brief authorizes and the ledger records |
| **C1b** — the three seams add only the private route parameter and its plumbing | **CLOSED** | `client.ts` +35/−4: one `import type`, one optional third constructor parameter, one optional second `create` parameter, and the `QueryEngine` construction that passes `route?.(schema, driver, {index, registry})`. `query-engine.ts` +14/−2: a `readonly route` field, a seventh optional constructor parameter, and the scope-derivation call that forwards it. `pending-operation.ts` +143/−23: `#route`, `#routedInstance`, `#resolveRouted`, `#preparedInput`, `#cacheResultCodec`, `#cacheKeyPayload`, `#runRouted`, and one `if (this.#route)` branch in each of `prepareBatch`, `#resolveSinglePlan`, `run`, `buildStatement` and the cache/interceptor payload readers. Every branch is exclusive and the `undefined`-route arm is the shipped code unchanged. The one behaviour a route changes outside the candidate is `QueryEngine.build` answering `undefined` (D-4′), and it surfaces through the EXISTING refusal: `QueryEngineError` / `V9001` / "Operation 'findMany' does not compile to one SQL statement. Execute the operation instead." — measured, [`public-surface.log`](root-review-C-receipts/public-surface.log) |
| **C1c** — `tests/types/raptor3/` and the shipped type tests still pass under `node scripts/run-typecheck.mjs` | **CLOSED BY ANOTHER RECEIPT, not re-run here** | `tsconfig.json` includes `tests/**/*.ts`, so `tests/types/raptor3/route-public-types.core.types.ts` (whose first assertion is `expectTypeOf(candidate).toEqualTypeOf<typeof shipped>()`, with `@ts-expect-error` directives that fail as TS2578 the moment a surface stops refusing) is inside the whole-estate typecheck. The freshest receipt on the frozen `src/` + `tests/` is the freeze round-2 one, [`freeze/receipts/round2/typecheck.log`](freeze/receipts/round2/typecheck.log): exactly the two permitted `pattern/pack.ts` diagnostics, 20.08 s, 4,669 MiB. The only edit after it was `scripts/raptor3-manifest.mjs`, which `allowJs: false` excludes. **I did not run my own** — see finding 2; a second 4.7 GiB process under the shared lock would have damaged more qualification modes. The qualification's own support group runs one (`qualification-plan.md` §3) and that is the integrator's receipt |
| **C1d** — every refusal wording restored to the shipped text | **CLOSED with two notes** | Census of all **156** `throw` sites in `raptor3/**`, **115** distinct messages: [`throw-sites.json`](root-review-C-receipts/throw-sites.json), [`refusal-census.txt`](root-review-C-receipts/refusal-census.txt). After normalizing `${…}` and string concatenation, 56 messages are the shipped sentence verbatim (including the two I read side by side — the decimal field-reference domain refusal and the cursor-null refusal, both split across `+` in the shipped source, and the `FeatureNotSupportedError("point", "distance …", …)` construction, which mirrors `distance-builder.ts:113-119` argument for argument). Of the 59 that are not: 42 exist unchanged at `0cc61e61`; 22 are bare `Error`/`TypeError` internal invariants; 13 are `TypeError` provider-row guards; and the reachable new ones are exactly the two decided identities R-D1 (`query.ts:869`) and R-D3 (`operation-context.ts:1561`), both pinned. Behaviourally: 23 admitted public requests, 0 divergences in class, code, message, `meta` and committed rows — [`refusal-and-meta-parity.log`](root-review-C-receipts/refusal-and-meta-parity.log). Notes 4 and 5 record the two wordings that are neither shipped nor pinned |
| **C1e** — recorded diagnostic-meta differences (RF-15) listed, none silent | **CLOSED — the list is empty, and that is measured** | RF-15 appears in G4 exactly once outside the briefs (`unit02/note.md:1140`), as the *fallback* for one obligation: "single-statement `NotFoundError` meta parity (suppress the `recordSeriesProgress` wrap when there is no series), **or RF-15**". Parity was taken, not RF-15 (`operation-context.ts:752-768`, `published()`). Measured on both routes over five refusals carrying `meta`: `NotFoundError` from root `update`, root `delete`, `findUniqueOrThrow` and `findFirstOrThrow` all answer `{"model":"owner","operation":"<verb>"}` on both engines; `UniqueConstraintError` answers `{columns, correlationId, driver, model, operation}` and `ForeignKeyError` `{correlationId, driver, model, operation, providerCode}`, identical on both (`correlationId` is a fresh UUID per raised error on both routes and is normalized). **No diagnostic-meta difference exists to be listed, and none is silent.** [`refusal-and-meta-parity.log`](root-review-C-receipts/refusal-and-meta-parity.log) |
| **C2a** — the six decisions are applied exactly as worded (re-check two by running the cells) | **CLOSED** | Read `decisions-review.md` (REVISE at 18:12) and confirmed both its must-fixes closed before the freeze: R-D2 (c) is now asked at the nested positions and the guide's two false absolutes are replaced by the facts the code carries (`AGENTS.md:605-648`), and the `g4-unit02-*` counts were re-derived. Re-checked two with cells the unit did not write ([`decisions-recheck.log`](root-review-C-receipts/decisions-recheck.log)): **D-6** with an OPERATOR update arm and a DEFAULTED create column — the candidate publishes the one admission (`score: 0`, `tier: "bronze"` filled in, `{increment: 5}` preserved), the shipped route publishes the caller's raw arms, and the public answers and committed rows agree; **R-D2 (a)** — a decimal key `increment`/`decrement` succeeds on the candidate (10.00 → 11, → 9) and answers the shipped refusal on the shipped engine, while `multiply`/`divide` answer the shipped sentence on BOTH. R-D2 (b) and (c) are re-measured in the parity table at the root, at `updateMany`, and at five nested positions — including the two the freeze note lists as **unverified** (a child-held to-one `update` and a parent-held to-one `update`): all AGREE. R-D1 is record-only and the tree carries no expression form (`query.ts:869` still refuses); R-D3 is the registered `QueryEngineError` with `meta {model, operation, field}` raised before any statement (`operation-context.ts:1561-1570`), pinned at `unit02/key-arithmetic.test.ts:547`. R-D4 and D-5 I did not re-measure (see Unverified) |
| **C2b** — the six integrator decisions listed with their justification | **CLOSED with one note** | `operationRegion` grant — `g4.md:287-302` ("a `memberRollback` grant is member isolation, not an operation region … mirrors the shipped `runTransactionScope`/`runLinearOn` split"). Root `create` fold — `g4.md:325-331` ("Folding is parity, not a choice … records the eliminated cut with the §5.4 evidence"). Single-statement meta parity — `g4.md:316-324`, and I measured the outcome (C1e). Refusal precedence by parity — `g4.md:249-262` (finding K: "a parity repair with an unambiguous shipped oracle, not a compatibility decision", delegated to phase 2 with the reviewer's two probes as the witness). Witness harness edits — `g4.md:817-822` ("without them a red G4 witness would enter the credential-free lane") and `g4.md:360-368` for the generator's seed bounds. Program specimen through `Queries.read` — **listed as delivered, not justified**: note 6 |
| **C2c** — decisions still owed to Arnaud: none expected; list any | **FINDING 1 — one is owed and is in no table** | `freeze/note.md` §6 item 3, restated unchanged in §R2.9 at the freeze: "**[for Arnaud, one line] R-D3's error class.**" The ledger's two decision tables (`g4.md:437-444` and `:448-454`) carry no row for it; the only record is narrative prose at `g4.md:630`. Details and resolution below |

## Findings

### 1. [must-fix — the REVISE trigger] A decision is still owed to Arnaud and appears in no ledger table: R-D3's error class

**Location.** `docs/architecture/raptor3-evidence/g4/freeze/note.md` §6 item 3
(and §R2.9, "§6 items 3 (R-D3's error class, for Arnaud) … stand unchanged");
[`decisions-review.md`](decisions-review.md) finding 4; the applied form at
`src/query-engine/raptor3/shared/operation-context.ts:1551-1571`; the normative
paragraph at `src/query-engine/raptor3/AGENTS.md:675-682`. The ledger's tables
are `g4.md:437-444` ("Arnaud's decisions (16:55, 2026-09-15)") and `g4.md:448-454`
("Compatibility decisions recorded for Arnaud (history)"); neither has a row.

**What is open.** Arnaud decided R-D3 as "give it a public identity now", and
the candidate gives it one — a `QueryEngineError` naming model, field and
operation, with `meta { model, operation, field }`, raised before any statement.
Which identity is not settled. `QueryEngineError`'s own `code` is
`V9001 INTERNAL_ERROR`; its subclass `UnsupportedOperationError`
(`src/errors/query.ts:401-418`) carries `V8003 UNSUPPORTED_OPERATION` and the
same `meta`, and its class doc reserves it for "a documented capability boundary
… NOT an engine crash". The guide's R-D3 paragraph says, normatively, "**It is a
capability boundary with a public identity, not an internal invariant**" —
the subclass's own words, applied to this refusal. The same file already throws
`UnsupportedOperationError` for a capability boundary at
`operation-context.ts:1012-1015`, as do `assignments.ts`, `commands.ts` and
`client-route.ts`. So the frozen candidate publishes `INTERNAL_ERROR` for a
refusal every normative document in the repository calls a deliberate boundary.

**Why it is a must-fix and not a note.** This is the checklist line's own
question — "Decisions still owed to Arnaud: none expected; **list any**" — and
the answer is not none. `code` is a public identity a consumer branches on, so
the open question is about an observable answer, not about prose. Two
independent records (the freeze-preparation author and the decisions reviewer)
classified it as "one line for Arnaud", and the freeze went ahead with it open
and untabulated: an adoption recommendation read against those tables would say
"six decisions, all decided" while a seventh is pending. Measured, not argued:
the frozen tree answers `QueryEngineError|V9001` for this refusal
(`unit02/key-arithmetic.test.ts:547` pins exactly that sentence and class).

**What would resolve it. No source change, and no re-freeze.** One row in
`g4.md`'s decision table — *open, owed to Arnaud: R-D3's class; applied as the
base `QueryEngineError` (V9001) in the frozen candidate;
`UnsupportedOperationError` (V8003) satisfies the decision as worded and
distinguishes a boundary from a crash; receipts `freeze/note.md` §6.3 and
`decisions-review.md` note 4* — so the question travels with the package. If
Arnaud later answers V8003, the change is one class name at
`operation-context.ts:1561` plus the two pins that name the class.

### 2. [must-fix — integrator action; **caused by this review**] Twelve qualification modes are recorded FAILED as workspace-lock refusals, not as test failures

**Location.** `g4/qualified/fixed/FAILURES.log` and
`g4/qualified/native-pg/`; the mode logs themselves carry the evidence — their
first line is `Test command refused: Vitest (PID …) already owns this workspace.`
or `Test command refused: workspace verification PID … is still active without
owning the current command chain.`, with no test output at all.

**Attribution, measured.** My three probe runs held the shared lock at
20:22:39, 20:33:56 and 20:35:38, and my retry loop re-acquired it as soon as it
freed between the integrator's modes. Every refusal below falls inside that
window (20:22:04–20:35:31), and the PIDs named in the refusals are my Vitest
children:

| group | modes recorded FAILED by lock refusal |
| --- | --- |
| `fixed` | `g4-lifecycle-events` (20:22:04), `g4-route-lifecycle` (20:22:43), `g4-route-cache` (20:23:20), `g4-generation-selftests` (20:23:56), `g4-unit01-review` (20:24:57), `g4-unit02-author` (20:25:16), `post-g3-selector-preparation` (20:28:35), `post-g3-history-analysis` (20:28:47), `g29-member-dependency` (20:28:55) |
| `native-pg` | `g25-pg-contracts` (20:33:58), `g3p02-pg-contracts` (20:34:44), `g3p04-pg-contracts` (20:35:31) |

Three of them (`g4-route-lifecycle`, `g4-route-cache`, `g4-unit02-author`) are
the modes that carry the D-5, D-6, R-D1, R-D2 and R-D3 decision pins, so the
qualification currently has no green receipt for the decision cells. Their
green receipts at the freeze exist
([`freeze/receipts/round2/g4-unit02-author.log`](freeze/receipts/round2/g4-unit02-author.log),
[`freeze/receipts/g4-route-transactions.log`](freeze/receipts/g4-route-transactions.log))
and my own independent cells agree with them, but a qualification receipt is
not a freeze receipt.

**What would resolve it.** Re-run the twelve modes in a quiet window; nothing
about the frozen tree changed. I have stopped running anything in the main tree
and will not run more.

**One real failure, not mine.** `g2-generated` (`fixed`, 20:33:19) is a genuine
red: `G2 seed 2122, sqlite-atomic-batch, commands failed → AssertionError:
g2-generated-transitions changed subsequent public operation outcomes`, 1 failed
/ 51 passed. It has full test output and is outside my area; naming it here so
it is not swept up with the twelve.

### 3. [note] `DatabaseAdapter.expressions.integerDivide` is a REQUIRED member added to a publicly exported interface

`src/adapters/database-adapter.ts:282-294` (the member itself at `:294`). `DatabaseAdapter` is exported from
the `viborm/adapters` public entry (`src/adapters/index.ts:1`, mapped in
`package.json` and `tsdown.config.ts`), and supplying a custom adapter at driver
construction is a documented recipe
(`docs/architecture/client-extension-plan.md:169`,
`database-namespace-plan.md:409`). A required member is therefore a compile-time
breaking change for any third-party implementation.

This is **authorized and recorded**, which is why it is a note: `common.md`
allows "an adapter capability … when a provider genuinely lacks a spelling, in
the exact adapter seam, and record it"; the seam is genuinely needed (MySQL `/`
yields DECIMAL, and a cast rounds on MySQL and PostgreSQL while only SQLite
truncates); the three implementations are additive; the guide names it
(`AGENTS.md:231-237`); and the seam's own contract test was extended, not
weakened (`tests/contracts/adapters/dialect-vocabulary.core.test.ts:139-151`).
Worth one line in the adoption recommendation as an adapter-contract addition,
so it is not discovered as a surprise by a consumer with a custom adapter.

### 4. [note] Three route-only refusal sentences are neither shipped nor pinned

`src/query-engine/raptor3/route/client-route.ts:164`, `:276`, `:311` — three
`UnsupportedOperationError` sentences beginning "The Raptor 3 route cannot
encode a cached …". `grep -rn "cannot encode a cached" tests/` is empty; the
only occurrences outside the source are historical receipts from before B-1c.

I argue all three are unreachable on the frozen tree, which is why this is a
note and not a finding: `cacheResultCodec` is reached only from
`readPendingCacheResult`, whose `cacheKeyArgs()` already refuses a non-read
before the codec is asked, and `prepare()` publishes a `read` for every
`isReadOperation` verb (`commands/index.ts:148-151`), so `:164` cannot fire; a
recursive read has no public operation at all (inventory RF-16), so `:276`
cannot; and `leafCodec`'s three handled arms exhaust the scalar-less leaves the
`Leaf` docblock enumerates (`query.ts:69-80`: `_count`, `exist`, a non-decimal
`_avg`, `_distance`), so `:311` cannot. `:311` in particular is a guard whose
unique coverage cannot be named — the shape the maintainer's "one guard per
invariant" rule refuses — and `Leaf.type` being `string` rather than a union is
what keeps the compiler from proving it. Either narrow `Leaf.type` and delete
the arm, or pin one of the three.

### 5. [note] Two new `InvalidScalarResult` reasons extend a candidate-specific diagnostic sentence, unrecorded

`src/query-engine/raptor3/shared/query.ts:3744` ("the value is not an array of
finite numbers") and `:3897`/`:3908` ("the value is not a binary value") are new
in G4 — the vector and blob leaves G4-01 added. They are not public sentences on
their own: `OperationContext.failure` composes them into
`Driver "<driver>" returned a malformed <type> scalar for operation "<op>":
<reason>.` with `meta {driver, operation, scalarType}`
(`operation-context.ts:329-337`). That composed sentence is the candidate's own
— the shipped result parser words the same class of fault differently
(`src/drivers/mysql2/index.ts:100`, `src/drivers/normalized-result.ts:43-88`) —
and it is inherited at `0cc61e61`, recorded in `unit02/note.md` as the RF-16 row.
No G4 record names the two NEW reasons. One line in the unit02 note's
malformed-row row closes it.

### 6. [note] "Program specimen through `Queries.read`" is listed as delivered, not justified

Checklist C names six integrator decisions and asks for each one's
justification. Five have one in the ledger (C2b above). The sixth appears only
inside the phase-1 author-result sentence (`g4.md:275`, "the specimen routed
through `Queries.read`") and as an A4 deletion row. The code carries the reason
(`program/index.ts:53-56`: "The specimen keeps ONE read entry: the same
`Queries.read` owner the commands engine consumes"), and the decision is sound —
the specimen is a research artifact, and letting it keep a second read entry
would have kept a second authority alive. One sentence in the ledger closes the
line with a justification instead of a delivery note.

### 7. [note] Two shipped vector refusals the candidate does not restate — correctly, and worth saying so

`builders/distance-builder.ts:170-179` raises `Vector distance <label> requires
'to' to be an array of finite numbers.` and `… metric must be 'l2' or
'cosine'.`; `grep -rn` over `raptor3/**` finds neither. The candidate reads the
admitted values instead (`query.ts:1829-1834`: `specification.to as number[]`,
`specification.metric === "cosine" ? "cosine" : "l2"`).

I checked whether that is a silent widening and it is not: admission owns both
facts — `v.enum(["l2", "cosine"])` and `v.array(v.number())` in
`src/validation/model/core/select.ts:68` and `orderby.ts:9` and `:26-31`, with
`v.number()` rejecting non-finite values (`validation/primitives/number.ts:32`).
So neither shipped sentence is reachable through admitted public syntax on
either engine, and not restating them is "validate once at admission; trust
downstream" applied correctly rather than a dropped refusal. The three vector
sentences the guide DOES call registered (`AGENTS.md:130-137`) are present
verbatim and pinned. Recorded because a census that only greps for missing
sentences would read this as a gap.

## What was verified and holds

**Probes (all three on the frozen identity, through the bounded runner).**

| probe | cells | result | receipt |
| --- | --- | --- | --- |
| `public-surface.review.test.ts` | 3 | **3 passed** | [`public-surface.log`](root-review-C-receipts/public-surface.log) |
| `refusal-and-meta-parity.review.test.ts` | 23 rows in 1 cell | **23 AGREE / 0 DIVERGE** | [`refusal-and-meta-parity.log`](root-review-C-receipts/refusal-and-meta-parity.log) |
| `decisions-recheck.review.test.ts` | 2 | **2 passed** | [`decisions-recheck.log`](root-review-C-receipts/decisions-recheck.log) |

**The parity table, row by row** (shipped public client vs
`createCandidateClient`, byte-identical worlds, class + code + message + `meta`
+ committed rows compared):

| row | both engines answer |
| --- | --- |
| root `update` of a missing row | `NotFoundError\|V6001\|No owner record found for update`, `meta {model, operation}` |
| root `delete` of a missing row | the same, `operation: "delete"` |
| `findUniqueOrThrow` / `findFirstOrThrow` | the same, `operation` naming the OrThrow verb |
| R-D2 (c) root: `{set, increment}` on the key | `QueryEngineError\|V9001\|Primary key field 'id' accepts exactly one update operation; received set, increment.` |
| an INT key under `increment` | performed by both; both then hit `UniqueConstraintError\|V3001` with identical `columns` |
| R-D2 (b): a NUMBER key under `increment` / `multiply` | `Arithmetic updates are not portable for number primary key field 'id'. Use an explicit set value.` |
| an INT key divided by zero | `Cannot divide primary key field 'id' by zero.` |
| R-D2 (c) on a NUMBER key | arity wins over portability, identically |
| arity root: the key names no operation | `… received none.` |
| root `upsert`, no relation in the update payload, key names nothing | `QueryEngineError\|V9001\|Unknown update operation: ` — the identity the freeze-preparation round restored, confirmed independently |
| R-D2 (c) root `updateMany` | the arity sentence |
| R-D2 (c) NESTED to-many `update`, `updateMany` member, `upsert` (found arm) | the arity sentence at all three, nothing written |
| R-D2 (c) NESTED to-many `upsert`, target ABSENT | **no refusal on either engine**: both take the create arm and both commit item 77 — the blocking finding of freeze round 1, closed |
| R-D2 (c) NESTED child-held to-one `update` | the arity sentence — the edge kind `freeze/note.md` §R2.9 item 2 lists as unverified |
| R-D2 (c) NESTED parent-held to-one `update` | the arity sentence — likewise |
| a provider unique violation | `UniqueConstraintError\|V3001`, `meta {correlationId, driver, model, operation, providerCode}` |
| G4-01 finding J: a decimal field reference across domains | the shipped sentence verbatim, including both decimal descriptors |
| a decimal column divided by zero | `Cannot divide decimal field 'cents' by zero.` |
| control: an insensitive `contains` that must NOT refuse | `ok:[{"id":1},{"id":2}]` on both |

**The two must-fixes of `decisions-review.md` are closed on the frozen tree.**
(1) The guide no longer states the two absolutes the reviewer measured false:
`AGENTS.md:605-648` now names the exact positions the predicate is asked at
(admission for a root `update`/`updateMany`; the found-arm gate of a relation-
bearing `upsert`; and the three nested positions `relation-body.ts` admits an
update payload in), says plainly that a nested `upsert` defers to its found arm
and that an absent target takes the create arm unjudged on both engines, and
states as parity that a relation-free root `upsert` judges the key payload on
NEITHER engine. My five nested rows and the absent-target row are the
measurement. (2) The `g4-unit02-*` counts were re-derived (`g4.md:733-737` and `:704`:
author 17 files / 110, mysql 3 / 17, pg 1 / 1).

**Registered identities and their pins.**

| identity | sentence | pin |
| --- | --- | --- |
| R-D1 | `Raptor 3 cannot name the updated value of '<model>.<field>' under '<op>': the provider owns that operator's rounding inside its own assignment.` | `tests/raptor3/g4/unit02/key-arithmetic.test.ts:458` ✔ |
| R-D3 | `Cannot publish the updated value of '<model>.<field>' for operation "<op>" inside an atomic batch: …` | `tests/raptor3/g4/unit02/key-arithmetic.test.ts:547` ✔, plus `review/unit02-decisions/batch-publication-identity.review.test.ts:167` |
| G3 vector, nullable select | shipped text | `review/unit01-followup2/distance-depth.test.ts`, `review/unit01-followup/distance-parity.test.ts` ✔ |
| G3 vector, provider capability | shipped text and the same `FeatureNotSupportedError("vector", usage, …)` construction with the same `orderBy`/`select` split (`distance-builder.ts:155-162` vs `query.ts:1821-1828`) | `unit01/repair2.test.ts`, `review/unit01-followup2/distance-pins.test.ts`, `contracts/engine/query/vector-orderby.core.test.ts` ✔ |
| G3 vector, dimension mismatch | shipped text | `contracts/engine/query/vector-orderby.core.test.ts`, `contracts/drivers/behaviors/vector-behavior.ts` ✔ |
| G3 GeoPoint distance tier | shipped text, same `FeatureNotSupportedError("point", "distance …", …)` construction as `distance-builder.ts:113-119` | `g4/read-codecs.test.ts`, `g4/read-ordering.test.ts` ✔ |
| shipped vector `to` shape and metric | *not raised by the candidate at all* — admission owns both facts | unreachable on either engine — note 7 |

## Unverified

1. **The whole-estate typecheck** was not re-run by me (C1c); I cite the freeze
   round-2 receipt and the reason in finding 2.
2. **R-D4** (collation-equal `connect` storing the located row's bytes) and
   **D-5** (a multi-statement array member packaged on a batch-only driver) were
   not re-measured here: R-D4 needs a live MySQL `_ci` collation and D-5 a
   batch-only driver, and after finding 2 I stopped taking the shared lock. Both
   were falsified by mutation in `decisions-review.md` (its
   `falsify-rd4-shipped-swap.log`, `falsify-d5-shipped-swap.log`) and are pinned
   in `unique-discriminator.test.ts` and `route-transactions.test.ts`.
3. **Every row of my parity table is SQLite.** The key refusals are raised
   before any statement is built, so no dialect can reach them differently — an
   argument, not a measurement, and the same standing gap `unit02/note.md` §D.9
   item 3 and `freeze/note.md` §R2.9 item 1 already record.
4. **The bulk-verb progress meta** (`createMany`, `updateMany`, `deleteMany`
   failing mid-series) is the family that legitimately carries
   `recordSeriesProgress`; I measured only the single-row premise family, where
   parity is the claim. A divergence in the bulk family would be an RF-15
   candidate and no receipt of mine excludes one.
5. **Cost** is Area D's; I recomputed nothing.
6. **`scripts/raptor3-cli.test.mjs` and the harness self-tests** — unchanged
   standing gap, noted by three earlier reviews.
