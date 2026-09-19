# Release unit "coverage" — independent review

**Verdict: REVISE (minimal — documentation only; no code, test, or floor changes required)**

Everything that changes behavior or coverage — the three production deletions,
the ten test files, the four re-measured scopes, the policy check, and the
typecheck — is sound and independently reproduced. What is missing is in
`note.md` itself: two of its required sections are still literal template
placeholders, and one real test addition in the diff is not itemized in the
note's per-block breakdown. All three are prose-only gaps; the underlying
facts already exist in the worktree's receipts and in my own reproductions
below.

---

## 1. Production deletions — all three CONFIRMED unreachable

### 1.1 `src/validation/model/args/aggregate.ts:865` (`groupByCollisions`)

Traced `by`'s schema: `by: v.union([v.array(scalarSchema), v.shorthandArray(scalarSchema)])`
under `atLeast: ["by"]` (`src/validation/model/args/aggregate.ts:902,915`).
Read `src/validation/primitives/object.ts:702-760` (the `atLeast`/`partial:false`
slow path `groupByCollisions` runs under): a missing `by` returns
`"Missing required field: by"` before `refuse` is ever called, because neither
`v.array` nor `v.union` sets `acceptsUndefined` (confirmed by grep — only
`optional`/schemas-with-defaults set it). A present `by` is validated by the
union first; `v.shorthandArray` (`src/validation/primitives/shorthand.ts:25`)
coerces a lone scalar into a one-element array via `coerce`, so both union
members always produce an array on success. `refuse` therefore never sees a
non-array `by`. The deleted `Array.isArray` guard's true arm (non-array `by`)
is unreachable. **Falsified independently — see §4.**

### 1.2 `src/validation/model/args/mutation.ts:73` (`refuseDefaultOnlySkipDuplicates`)

Confirmed all four registrations spell `data: v.array(...)` under an `atLeast`
that includes `"data"`: `mutation.ts:130`, `relations/create.ts:173`,
`relations/update.ts:433`, `relations/polymorphic/collection-mutation.ts:294`
(grepped each file directly). Same `object.ts` mechanism as §1.1 applies: a
missing/non-array `data` is refused by the required-field rule before `refuse`
runs. Guard's arm unreachable by the identical argument.

### 1.3 `src/validation/parse-failure.ts:22-30` (`readValidationFailureCause`)

Grepped every call site in `src/` (excluding tests): exactly three —
`query-engine/cache-flow.ts:116,242` and
`query-engine/write-engine/parse-boundary.ts:52` — and all three pass the
direct return value of a `parse(...)` call. Read `validation/index.ts:86-111`:
every code path of `parse` returns a plain object literal (`asyncValidationFailure`,
`malformedValidationFailure`, `{ issues }`, `{ value }`, or
`validationFailureFromThrown(cause)`, which itself always returns an object —
`parse-failure.ts:8-18`). `ParseResult<S>` is an interface union, structurally
assignable to the new `object` parameter type. The deleted `typeof`/`null`
check and `try/catch` around `Reflect.get` were guarding against a shape that
cannot occur; the whole-estate typecheck (§3) proves no caller violates the
new signature.

**No caller passes anything but a `parse`-built result in any of the three
deletions — reachability arguments hold.**

---

## 2. New test cells — all read; none are smoke-only

Read every hunk in all 13 changed files (`git diff 54a34e05 -- src tests`).
Every new/modified cell asserts a concrete registered outcome (exact message
string, exact `issues`/`source`/`meta` shape, exact event ordering, or exact
type), never a bare "doesn't throw" or an unused computed value:

- `tests/unit/validation/registry.core.test.ts` (new) — asserts exact
  `ValidationError.issues`/`.source` for the registry proxy's `does not exist`
  refusal (including a symbol key) and for `SchemaRegistry.validate`'s six
  arms (happy path, unknown model, unknown operation, dotted field path,
  empty-path whole-object refusal, Error-vs-non-Error containment with
  `originalCause` asserted both ways).
- `tests/unit/validation/parse-boundary.core.test.ts` (new) — asserts the
  exact `MALFORMED` message for both malformed-result shapes, the
  `"value" in result` success distinction, and `readValidationFailureCause`'s
  three arms (sanitized Error cause, normalized non-Error cause, `undefined`
  on an ordinary refusal — with `cause.stack` and `cause !== thrown` checked).
- `tests/unit/operation-schemas/args/aggregate-args.core.test.ts` — new
  "missing `by` refused before collision question" cell asserts the exact
  `{ message, path }`; new `describe("aggregate name collisions")` uses
  `test.each` over all five aggregate keys plus a negative control, asserting
  the exact templated message, matching `aggregate.ts:874` verbatim.
- `tests/unit/operation-schemas/args/mutation-args.core.test.ts` — same
  pattern for `data`; new `describe("default-only rows")` asserts the exact
  refusal sentence plus three real positive/negative controls.
- `tests/unit/scalars/json-scalar-schemas.core.test.ts` — `describe("filter
  path grammar")` and `describe("filter mode")` assert exact registered
  sentences for every refusal (`test.each` table), plus positive controls
  that check the *parsed* segment values, not just absence of an issue.
- `tests/contracts/adapters/internals-and-geo.core.test.ts` — asserts the
  exact `{ name, normalizedError }` shape for the two previously-uncovered
  diagonal cells (named-dialect unique-by-CONSTRAINT, SQLite
  primaryKey-by-qualified-COLUMNS) with a two-column key so the mapping is
  the fact under test, not one column's spelling.
- `tests/contracts/drivers/namespace-options.core.test.ts` — asserts the
  exact `TypeError`-shaped message for a non-string `namespace` across all
  driver constructors via `test.each`.
- `tests/contracts/drivers/shared-driver-boundaries.core.test.ts` — asserts
  object identity (`not.toBe`), exact field snapshot, and that the trusted
  phases are readable only through the owner accessor and never attached to
  the caller's own object (`not.toHaveProperty`) — a real negative control.
- `tests/contracts/drivers/pinned-session-condemned.core.test.ts` — asserts
  the exact event-ordering array `["release"]` for the "never discarded"
  path (see §5.2 — this cell is real but undocumented in `note.md`).
- `tests/contracts/public-client/errors/public-helpers.core.test.ts` —
  asserts the exact `source`/`meta`/`originalCause` derivation for all three
  `ValidationError` third-argument arms.

No `.skip`, `.only`, coverage-ignore comment, or floor-file edit anywhere in
the diff (grepped explicitly). The only `biome-ignore` added is
`lint/style/useThrowOnlyError` on two deliberate non-Error throws — exactly
what `note.md §0.3` discloses, nothing else. The two non-test-content diff
lines outside additions (in `aggregate-args.core.test.ts`'s import and
`mutation-args.core.test.ts`'s `expectTypeOf<{}>()` → `expectTypeOf<Record<string,
never>>()`) are the integrator's disclosed lint fix for the banned-`{}`-type
error in `receipts/verify-biome.log` — confirmed it doesn't change what the
type assertion tests (still a negative control against the same `Input`
type). Re-ran `npx biome check` on all 13 touched files myself: exit 0 (2
pre-existing infos in code this diff didn't touch — an unused var at
`mutation-args.core.test.ts:87` and an unused type alias at
`json-scalar-schemas.core.test.ts:37`, both outside any diff hunk, both info-
not error-level).

---

## 3. Re-measured scopes, policy, typecheck — all reproduced green

`TMPDIR=/private/tmp/viborm-coverage-tmp-r` exported for every run; one scope
per call, sequential (no concurrent test/typecheck runs), per the common
brief's hard rules.

| Command | Result | Receipt |
| --- | --- | --- |
| `pnpm test:coverage:validation` | **100/100/100/100** (floor 100), 825+991+1302+101 tests passed, 0 failed | `review-receipts/validation.log` |
| `pnpm test:coverage:errors` | **100/100/100/100** (floor 100), 131 tests passed | `review-receipts/errors.log` |
| `pnpm test:coverage:adapters` | **100/100/100/100** (floor 100), 182 tests passed | `review-receipts/adapters.log` |
| `pnpm test:coverage:drivers` | **96.05/92.58/96.1/96.05** (floor 96/92.5/96/96), all non-skipped suites passed | `review-receipts/drivers.log` |
| `pnpm test:coverage:policy` | 3 suites, **0 failures** (11+16+6 tests) | `review-receipts/policy.log` |
| `node scripts/run-typecheck.mjs` | **exit 0**, no diagnostic output | `review-receipts/typecheck.log` |
| `npx biome check` (13 touched files) | **exit 0** | `review-receipts/biome-recheck.log` |

My drivers figures (96.05/92.58/96.1/96.05) match the integrator's own
`receipts/verify-scope-drivers.log` exactly. Drivers' skipped suites
(libsql/pglite/mysql2 provider tests, 82–233 tests each) are gated by
environment/docker availability the same way on this host as they evidently
were for the integrator — not something this unit touched, and the floor is
met with them skipped, same as the integrator's own run.

No new test file needed manual coverage-policy registration: both genuinely
new files (`tests/unit/validation/parse-boundary.core.test.ts`,
`tests/unit/validation/registry.core.test.ts`) land under
`tests/unit/validation/**/*.core.test.ts`, which `vitest.workspace.ts:192`
already globs into `layer-validation`; the three modified driver test files
are already covered because `scripts/driver-test-manifest.mjs:8-12` builds
`DRIVER_CORE_TESTS` from a directory listing, not a hardcoded list. Confirmed
by reading both files directly.

---

## 4. Falsification (required reproduction)

Per instructions: built a detached scratch worktree
(`git worktree add --detach /private/tmp/viborm-coverage-scratch HEAD`,
`node_modules` symlinked from `/private/tmp/viborm-coverage` since
`pnpm-lock.yaml` is byte-identical), restored the deleted guard in
`src/validation/model/args/aggregate.ts`:

```ts
const by = value.by;
if (!Array.isArray(by)) return undefined;
const grouped = by as string[];
```

Ran `pnpm test:coverage:validation` there:

```
validation thresholds: statements 100% (floor 100%), branches 99.96% (floor 100%), functions 100% (floor 100%), lines 100% (floor 100%)
Error: Coverage policy failed:
validation: branches 99.96% is below 100%.
 ELIFECYCLE  Command failed with exit code 1.
```

Branches drop from 100% to 99.96% and the run exits 1 — no test in the suite
reaches the restored guard's true arm, exactly as the reachability argument
predicts. Receipt: `review-receipts/falsify-validation.log`. Worktree removed
afterward (`git worktree remove --force`); `git worktree list` confirms it is
gone and `/private/tmp/viborm-coverage` itself was never touched (only my own
new `review-receipts/` directory is untracked there).

I did not additionally build scratch reproductions for the `mutation.ts` and
`parse-failure.ts` deletions (only one was requested) — their soundness rests
on the static trace in §1.2–1.3, which uses the identical `object.ts`
mechanism verified live in §4's `aggregate.ts` run.

---

## 5. Findings

### 5.1 [MEDIUM — REVISE] `note.md` §6 and §7 are unfilled template placeholders

`note.md:225` is literally `VERIFICATION_PLACEHOLDER` and `note.md:229` is
literally `LOC_PLACEHOLDER`. `brief.md`'s Deliverables section explicitly
requires both ("the final `pnpm test:coverage` exit 0 receipt" / a statement
of the blockers, and "LOC delta (`git diff --numstat 54a34e05 -- src tests`)").
The underlying facts are not in doubt — I reproduced them independently in
§3–§4 and the integrator's own `receipts/VERIFY.log` and `receipts/verify-*.log`
already contain them — but the note itself, the actual deliverable, doesn't
state them.

**Resolution (minimal, no re-verification needed):** replace the two
placeholders with prose citing the existing receipts. For §7, the exact
numbers (already computed, safe to paste in) are:

```
src:    +20/-14  (aggregate.ts +4/-3, mutation.ts +4/-2, parse-failure.ts +12/-9)
tests: +677/-3   (10 files; 2 new: parse-boundary.core.test.ts +111,
                  registry.core.test.ts +164)
total: +697/-17  net +680
```

For §6, a one-line summary is enough: cite `receipts/VERIFY.log` (validation/
errors/adapters/drivers all exit 0 above floor, policy exit 0, typecheck exit
0/0 diagnostics, biome exit 1→0 after the lint fix) and note that `pnpm
test:coverage` (all scopes) does not exit 0 because of the two §5 blockers,
already stated correctly at `note.md:13`.

### 5.2 [LOW — REVISE] `note.md` §4 omits one real drivers test addition

The diff modifies `tests/contracts/drivers/pinned-session-condemned.core.test.ts`
(new `describe("a session that was never discarded")` cell, +27 lines,
asserting `releaseReservedPostgresSession`'s ordinary-return path), but
`note.md §4` itemizes only two blocks (`driver-options.ts:87-91` and
`execution-context.ts:148-151,174-177`). I read the new cell (§2 above): it is
a real assertion, not a smoke test, and it is automatically part of the
`drivers` coverage scope (§3), so this is not a policy violation — just a gap
in the required per-block breakdown ("per scope, per block: class (a/b/c),
the cell(s) written", per `brief.md` §"Required, per uncovered block").
`note.md §4` also still carries its own unfilled `DRIVERS_RESULT_PLACEHOLDER`
line, which should be replaced with the measured figures
(96.05/92.58/96.1/96.05, receipt `receipts/verify-scope-drivers.log` and my
own `review-receipts/drivers.log`) at the same time as §5.1's fix.

**Resolution (minimal):** add one bullet to §4 classifying the
`pinned-session-condemned.core.test.ts` cell (almost certainly class **b** —
reachable from the ordinary non-discard release path, pinned nowhere before),
and fill the result line.

### 5.3 No other findings

No floor was moved (no coverage-policy/vitest-workspace/threshold file in the
diff — checked `git diff 54a34e05 --name-only` against the full file list).
No existing test was deleted, weakened, or skipped (diffed every `-` line in
every test file; the only removals are an import line and one type-assertion
rewrite, both already accounted for in §2). No coverage-suppressing ignore
comment was added (grepped for `.skip(`, `.only(`, `biome-ignore`, `istanbul
ignore`, `c8 ignore`, `eslint-disable` across all `+` lines — only the two
disclosed `useThrowOnlyError` ignores appear).

---

## 6. §5 blockers (query-engine-core, write-engine) — confirmed out of scope, confirmed not overclaimed

Per instructions, these are recorded as resolved elsewhere (query-engine-core
scope definition in the follow-ups unit; Neon upsert defect as D-46) and I
took no action on them. I did confirm:

- `note.md:13` states explicitly: *"`pnpm test:coverage` does NOT exit 0"* —
  the note never claims a full green `pnpm test:coverage` on this tree.
- The §5.1/§5.2 receipts referenced (`receipts/query-engine-core-breakdown.json`,
  `receipts/write-engine-neon-failure.log`) exist, are dated to the base-tree
  measurement (00:56–01:14, before this unit's first edit, per file mtimes and
  the log's own "Start at" timestamps), and their content matches what the
  note describes (10,451/13,684 raptor3 statements, the Neon
  `TransactionError` on the upsert leg of a two-operation `$transaction`).

---

## 7. What I could not verify

- Did not run the full `pnpm test:coverage` (all scopes) — not requested for
  this unit (it would fail on the two known, out-of-scope blockers), and the
  common rules forbid running full campaigns during unit work.
- Did not independently re-derive the base-tree §5.1/§5.2 blocker numbers
  (query-engine-core 55.12%, the Neon `TransactionError`) — accepted them as
  pre-existing per the note's own framing and this unit's explicit
  instruction to take no action there; spot-checked only that the cited
  receipt files exist and are internally consistent with the note's prose.
- Did not falsify the `mutation.ts` or `parse-failure.ts` deletions with a
  live scratch-worktree coverage run (only one falsification was requested);
  their unreachability rests on static tracing through the same `object.ts`
  mechanism confirmed live for `aggregate.ts`.
- Did not audit driver/adapter files beyond the diff hunks and their directly
  cited call sites/registrations (e.g., did not read every one of the seven
  driver constructors end to end) — relied on the `test.each` coverage over
  `constructors` in `namespace-options.core.test.ts` and the scope's 96%+
  measured result as the check that the claim generalizes.
- Did not investigate why drivers' provider-gated suites
  (libsql/pglite/mysql2, 82–233 tests each) are skipped on this host — same
  skip pattern the integrator's own run shows, treated as pre-existing
  environment gating rather than something this unit changed.

---

## Receipts index

All under `docs/architecture/raptor3-evidence/g4/release/coverage/review-receipts/`:

- `validation.log`, `errors.log`, `adapters.log`, `drivers.log` — my own
  scope re-runs (§3)
- `policy.log` — `pnpm test:coverage:policy` (§3)
- `typecheck.log` — `node scripts/run-typecheck.mjs` (§3)
- `biome-recheck.log` — `npx biome check` on the 13 touched files (§2)
- `falsify-validation.log` — the restored-guard falsification (§4)
