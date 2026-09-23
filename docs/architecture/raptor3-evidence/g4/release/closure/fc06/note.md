# FC-06 — evidence, documentation and the local release verdict

Branch `fc06` from `a9e62d8dc` (the wave-2 merge), worktree
`/private/tmp/viborm-fc06`, `TMPDIR=/private/tmp/viborm-fc06-tmp`, Node
v24.21.0, 2026-09-21.

A docs-and-tooling unit. **No engine source file changed**: `git diff a9e62d8dc
-- src` touches exactly one path, `src/query-engine/raptor3/AGENTS.md`, which is
the engine guide and carries no parser token. Engine token lines are 16,040
before and after. Nothing was committed, staged, pushed or reformatted beyond
the two files whose base copy is format-clean and the one new file.

The frozen gate, the performance comparator and the commit are the
integrator's; this unit did not run them, and the verdict they complete is
drafted in [`release-verdict-draft.md`](release-verdict-draft.md).

---

## (a) The census reads the sentences it was blind to

**The witness.** `node scripts/raptor3-refusal-census.mjs`.

*At the base*, three sentences this engine states reached the report nowhere.
Two throw sites were listed as sentence-less rethrows
(`receipts/census-base.md`, "Sites without a sentence"):

| site | the sentence the base could not read |
| --- | --- |
| `commands/execution.ts:1035` | `Cannot ${series.mutation.kind} relation '${edge.name}': parent record changed across a committed segment.` (built into a local `const`) |
| `commands/execution.ts:1071` | `updateMany matched ${count} rows, so it cannot apply '${verb}' to relation '${name}': …` (built by the site's own factory `exclusiveMemberMove`) |
| `shared/operation-context.ts:638` | `Driver "${driver}" returned a malformed ${scalarType} scalar for operation "${operation}": ${error.reason}.` — built by the failure owner itself and listed at no site at all |

N5 named exactly this gap and exactly this repair ("the tool's next extension is
to follow the argument of `ctx.failure` / `failure()` to its construction, so a
public sentence at such a site cannot slip in unread").

*After*, all three are read, and each is classified: the first two are matched
in the old engine's corpus and the third matches its `" returned a malformed"`
family fragment, so all three are **inherited** — the count of unmatched
candidate sentences does not move (`receipts/census-after.md`).

**The necessary fact.** The sentence a throw site STATES when the value it
throws was built beside it and handed to the engine's one failure owner.

**The owner.** `constructionsOf`, the census's existing origin resolver — the
same function that already reads a local `const`, a local factory, a method of
the throw's own class, a named constant and both arms of a conditional. The
failure owner it follows through is DECLARED as data, `FAILURE_OWNER`
(`shared/operation-context.ts`, class `OperationContext`, method `failure`,
carried parameter 0 named `error`), and the declaration is re-checked on every
run: if the class, the method or the carried parameter is not where it says,
the report says so and the run exits non-zero — the same discipline the private
fits already had.

**The hunk.** `scripts/raptor3-refusal-census.mjs`, four places:

1. `FAILURE_OWNER`, the declaration and its reasoning.
2. One branch in `constructionsOf`: a call to the owner's method with at least
   the carried argument resolves to the constructions of that argument. The
   zero-argument `failure()` of a premise or a continuation carries nothing and
   is therefore not read — no name test rescues it, the arity does.
3. `locateFailureOwner` + `ownerSubstitutions` in `collectSites`: the owner's
   own constructions are collected ONCE, at the owner, as sites of their own
   (`via: "failure()"`), instead of being attributed to each of its twelve
   callers.
4. The failure of the check is reported and answered in the exit code, beside
   the corpus failure and the contradicted private fit.

**The rule deleted.** `site.reach`, three assignments of a classification
string that nothing rendered — a second, silently stale statement of what
`site.outcome` already owns, and the exact kind of drift this unit exists to
remove. Deleting it is the only deletion here; the rest is new meaning, which
is the honest answer for a fact the tool did not state.

**The second placement.** The same resolution serves both halves of the owner:
the value a caller hands over AND the value the owner substitutes for it. The
second half forecloses a hazard rather than repairing a state the file was in:
the generic `this.<method>()` arm would credit the owner's sentence to every
site that rethrows a CAUGHT value through it the moment `failure` returned its
substitution directly instead of assigning it (the shape cell 3 spells;
falsification F1 reddens it). The shipped owner ASSIGNS its substitution
(`shared/operation-context.ts:638`), so the arm never reached that construction
and the base census attributed it to nobody.

**Accurate labels** (the second half of the brief's (a)). The report no longer
says "public refusals". It says **candidate sentences unmatched in the
old-engine corpus** and **inherited sentences**, states in its own header that
these are counts of SENTENCES and not of capabilities, says that they include
the integrity and provider-result failures a correct engine must state and
sentences no admitted payload can reach, and names
`g4/release/closure/fc00/inventory.md` as the authority for what the engine
supports. The bridging sentence "earlier notes call this number '23 public
refusals'" keeps every existing receipt readable.

**Self-tests.** New `scripts/raptor3-refusal-census.test.mjs`, 7 cells,
`node:test`, registered in `package.json`'s `test:coverage:policy` beside the
three other harness self-tests (and named in both CI comments that list them).
Each cell writes a FIXTURE engine tree that spells the shape, runs the real
program over it through the new `--root` option, and reads the report:

1. a sentence built into a local `const` and handed to the owner is read (and
   lands in the inherited half, because the fixture's corpus carries it);
2. a sentence built by the site's own factory and handed to the owner is read
   (and lands in the candidate half);
3. a CAUGHT value rethrown through the owner stays sentence-less, and the
   owner's own sentence is reported exactly once;
4. the owner's substitution is read at the owner, not at `execution.ts`;
5. a zero-argument `failure()` member is not mistaken for the owner;
6. an owner whose method has been renamed makes the run exit 1 and say so;
7. the engine's own tree still declares the owner where the census reads it.

`--root` is the one new option: the census reads its sources, its git history
and its shipped corpus from one place, and the self-test points that place at a
fixture instead of censusing the engine to check itself. The census's output on
the real tree is byte-identical before and after the option was added.

**Falsified three times** (`receipts/census-falsifications.log`, each in a
backup copy restored by `cp`, md5 verified): removing the carried-argument
branch reddens cells 1–3; not collecting the owner's substitutions reddens
cells 3–4; dropping the owner check from the exit code reddens cell 6.

**What the census still cannot read, and now says so.** A value another owner
built (a catch binding, a parameter), a property of another object
(`refusal.error`), a value assigned after its declaration, a control-flow
sentinel, a message computed at the site. Two shapes were examined and
deliberately left out: `OperationContext.answered`, a pass-through whose call
sites all carry either a cross-module composition or a caller's factory (adding
it to the declaration changes no count today, so it would be a check with no
coverage to name), and `keyPortabilityRefusal`, a factory in another file whose
product `relation-body.ts` throws — reading that one is the general call-graph
analysis the brief forbids.

**Counts.** 192 → **193 sites** (+1, the owner's own substitution),
inherited 72 → **75**, candidate sentences **23** at 30 sites (unchanged),
internal 11, invariant 21.

---

## (b) Reconciliations by current evidence

Each is a dated superseding record, added beside what it supersedes; no sealed
receipt was rewritten, and nothing red became a pass. The ledger record carries
them all; the final report's open items carry the ones a reader of that report
needs (`g4/final-report.md`, "Closure checkpoint addendum" and items 10–16).

| open item | its state now |
| --- | --- |
| D-16 "families Arnaud has not ruled on" | **stale status paragraph** — FC-00 traced the 2026-09-17 ruling; the final report's item 0 now carries the reconciliation and names the two items that still trace to that surface, both owned |
| the census blind spot | **closed here**, with self-tests and the counts above |
| `extension-campaign.selftest.test.ts` in two lists | **closed here** (item e) |
| the stale `reference-instrumentation.patch` | **closed here**: kept as history, and a run that names it is refused (item e) |
| the T3 temporal residual (F-4) | **closed by FC-02B** |
| the located-NULL refusal covering only a parent-held `connect` (F-6) | **closed by FC-02C** for the found `connectOrCreate`; two measured residuals remain, recorded as final-report item 12 |
| the three executed failures E-1/E-2/E-3 | **closed by FC-01 / FC-02A / FC-03**, each with registered pins red at the base |
| D-14 / R-1, the build contract | **closed by D-64** as an accepted restriction; code, tests and docs agree. FC-04 measured that the pin the ruling cites runs in NO vitest project — recorded as final-report item 13, not silently left |
| R-2, the private recursive-read fit | **at its default**: kept private, and the census re-checks that privacy on every run and states it as a declared fit, not a capability |
| R-3, a database-side default spelling | unchanged; declined under D-59 |
| R-5, D-9's suppression limit | **confirmed at its default by FC-04**, and stated more precisely than its inventory row |
| the pg `batchPrimaryKeyDataflowContract` registration kept red | **still unmeasured** — the gated PostgreSQL lane is the integrator's one frozen gate; recorded as final-report item 10 with its file and line |
| D-65, the captured set's batch-route window | **pending**, with the integrator's recommended default; final-report item 11. `requireCapturedSet`'s over-promising comment is deliberately untouched, because correcting it would pick reading A |
| the two public contract changes' release note | written at commit 34; this unit corrected two claims inside it (item c) |
| live Neon / hosted D1 | **deferred**, and now stated as deferred rather than as absent evidence (item c) |

---

## (c) The drivers guide says what the engine does

`docs/content/docs/drivers/index.mdx`, the "Nested writes and failures per
driver" callout and two rows of its table.

**Deleted, because it was false:** "A `create` or `update` and everything
nested under it is one batch. A `createMany` of relation-bearing rows is
dispatched one batch per row, and a member that must read a row an earlier
member wrote starts a new batch." Packaging has not followed the verb since
N5: the boundary `executeMember` would take at a member's end is DEFERRED while
an enclosing write waits (a series of literal rows is one unit with its parent),
and the boundary is taken by the OBSERVING member, in `OperationContext.answer`,
when another record of the series left a write waiting
(`tests/raptor3/g4/parity/member-boundary-packaging.test.ts`, whose docblock
states the rule and whose controls exist to keep exactly this honest).

**Replaced by the rule the tree holds:** what travels in one batch follows the
work's own dependencies, not the verb; a `create`/`update` with its nested work
and a `createMany` of relation-bearing rows with its parent are ONE batch while
no part must read what another part wrote; a part that must observe an earlier
write takes the boundary, and on neon-http and d1 that dispatch is a committed
segment, which is what `committedSegments` counts; a generated key crosses as a
literal, so none of it depends on the transport keeping a session.

**Partial progress** is now stated only where it can happen ("neon-http and d1
are the only routes where a write that needs more than one batch can").

**Hosted evidence told from local:** the Neon row says the live suite is
credential-gated on `NEON_TEST_DATABASE_URL` and was not run for this release;
the D1 row says the driver is exercised on the Workers runtime's own local D1
(`tests/providers/workers/d1.test.ts`, project `provider-d1`, registered in
`vitest.workspace.ts` through `vitest.d1.config.ts`, run by
`run-credential-free-tests.mjs` and by CI) and on no hosted Cloudflare D1. The
same two corrections were applied to the CHANGELOG's release note, together
with its refusal-count sentence, which now says 23 SENTENCES the previous
engine did not carry rather than "23 new refusals".

---

## (d) The engine guide states one rule per fact

`src/query-engine/raptor3/AGENTS.md`. Four active paragraphs contradicted the
addendum printed under them; each now states the CURRENT rule, and every
addendum is kept (with two openings adjusted so they no longer quote a sentence
that is gone). History stays in the ledger; ELEGANCE was not touched.

| paragraph | was | now |
| --- | --- | --- |
| the occurrence boundary | "Once members are expanded (`Commands.expanded`) nothing moves any more" — a flag that no longer exists | the ancestor's own execution position, decided per pair (`CommandExecution.started`), which is what FC-01 landed |
| identity vs observation | the cascade paragraph said the statement, its children and the read-back name the row where the cascade left it, and said nothing about what was SEEN | adds the distinction FC-02A established: the three read the row's CURRENT values at one owner (`CommandAttempt.read`); what the operation saw stays in `CommandAttempt.rows` for the consumers that need it, and the two are never substituted |
| scratch lifetime | the D-58 paragraph named `referenceProjection` as the read-back's owner — deleted by FC-05 | `Queries.scalarQuery`, the composition every published scalar is read back through |
| the P1 claim | "never materialises that list again per row" | exact: never rebuilds the members as PAIRS nor the document around them; exactly one array per document remains, the shape's own key list, and removing that too is an unmeasured candidate, not a rule |
| the write-outcome composition | the parenthesis gave a stale reason for not importing `@extensions/query` (a routing table C-01 deleted) | the rule lives at `@errors` and this engine imports it like the client; the addendum keeps the measured reason |

---

## (e) The harness owns each fact once

**The duplicate registration.**
`tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts`
was in `RAPTOR3_RUNNER_ONLY_TESTS` (with a comment claiming it "needs the
runner's environment") AND, through `CS03_EXTENSION_SUPPORT_TESTS`, in
`RAPTOR3_FIXED_LOCAL_TESTS`. The manifest's own docblock says runner-only files
"need the mode runner's environment and fail under a bare project run", so the
claim is measurable — and it is false: the file names no environment variable,
reaches its cells through an ordinary SQLite world, and no runner mode names it
(the `cs03-extension-*-seeds` modes run `CS03_EXTENSION_CAMPAIGN_TESTS`, the
campaign itself). Measured under a bare project run: **42 / 42**
(`receipts/extension-campaign-selftest-bare.log`).

Reconciled through the manifest, which owns the fact: the deterministic half
now spreads `CS03_EXTENSION_SUPPORT_TESTS` (both support files, stated once)
and the runner-only half carries neither. Nothing else moves — the file stays
in the fixed local list and stays out of extended-local, so no lane's cell
count changes; it now also joins `coverage-raptor3`, which is why the bare run
reports 84 cells in two projects.

**And the invariant is now pinned on the list itself.**
`scripts/raptor3-campaign-receipts.test.mjs` asserted "in neither
credential-free list" over a hand-kept copy of four runner-only groups; it now
asserts it over `RAPTOR3_RUNNER_ONLY_TESTS`, which covers all eight and deletes
the duplicate list. Red against the base placement with exactly the offending
file named, green after (`receipts/registration-falsification.log`).

**The stale benchmark patch.**
`tests/raptor3/core-structure/measurement/reference-instrumentation.patch` is
the flat-history-reference alternative superseded at `b0ec55fa3`; measured at
this HEAD, **20 of its 29 hunks no longer apply** (`patch -p1 --dry-run
--fuzz=3`). Its verifier is `scripts/run-raptor3.mjs`'s
`structuralMeasurementContext`, which is entered at the top of `run(request)`,
before anything is spawned — and which checked only that the file EXISTS before
its hash was written into `verified.json` as the instrumentation that produced
the measurement. A retired patch named there produced a new baseline silently.

It now refuses: `assertStructuralMeasurementPatch` (beside its sibling
`assertStructuralMeasurementRuntime`, in the harness-assertion owner
`scripts/raptor3-manifest.mjs`) requires the named patch to REVERSE-apply to
the measured tree — the exact statement "this tree carries what this patch
adds". `git apply` is exact, so a patch that only fits with fuzz is refused
too, which is the claim the receipt makes. Two new cells in the receipts
self-test: a synthetic applied patch passes and a synthetic stale one is
refused, and the retired file itself is refused by name. Falsified by replacing
the check with `git rev-parse` (both cells red).

The patch file is kept: it is history, and the live instrumentation for that
measure remains `g4/qualified/structure/instrumentation.patch`.

**Observed and NOT touched:** `tests/raptor3/expanded/compound-falsifier.test.ts`
is registered in both `G1_BASELINE_COUNTS` and `G1_CONTRACT_COUNTS`. That is
two RUNNER MODES naming one file (the legacy and candidate arms), not one file
claiming two environments, and it predates this branch.

---

## (f) The like-for-like recount

Full table with its method, denominators and caveats:
[`receipts/loc-recount.md`](receipts/loc-recount.md); the raw measurement is
`receipts/source-size-fc06.json` (`scripts/measure-raptor3-baseline.mjs`) and
`receipts/query-engine-structure-after.json`.

| | closure tree | release tree | Δ |
| --- | ---: | ---: | ---: |
| engine token LOC (`src/query-engine/**`, 38 files) | **16,040** | 16,036 | +4 |
| engine physical lines | 20,446 | 20,319 | +127 |
| engine source bytes | 764,450 | 756,128 | +8,322 |
| with the same integration files (52 files) | 19,898 | 19,896 | +2 |
| charged total (63 files, incl. the shared class reported apart) | 23,833 | 23,831 | +2 |

Separated as the plan asks: **new meaning +28** (FC-01 +3, FC-02A +2, FC-03
+23), **duplicate-rule removal −26** (FC-05: −24 engine, −2 client),
**cosmetic 0 token lines** (123 of the 127 new physical lines carry no parser
token), **retired comparison code: none this wave**. Moved production
responsibility is counted, not hidden: FC-05's 13 token lines moved to
`@errors` and the 13 deleted from `@extensions` cancel, and the engine's −24
already contains the restatement it deleted.

Against the recorded denominators: engine **0.3485** of 46,021; with the same
integration files **0.3989** of 49,887. The physical-LOC target of plan §7
(≤ 0.70) had never been reported with a number; against the two recorded
old-engine readings it is **0.34** and **0.33**.

---

## Runs (no wide runs; one vitest at a time)

| what | result | receipt |
| --- | --- | --- |
| `scripts/raptor3-refusal-census.test.mjs` (new) | **7 / 7** | `receipts/census-selftest-after.log` |
| its three falsifications | 4/7, 5/7, 6/7 — each reddening exactly the cells it should | `receipts/census-falsifications.log` |
| `scripts/raptor3-campaign-receipts.test.mjs` | **41 / 41** (39 + the two structural-patch cells) | `receipts/campaign-receipts-after.log` |
| its falsification (base list placement restored) | **40 / 41**, red on the file it names | `receipts/registration-falsification.log` |
| `scripts/coverage-policy.test.mjs` | **11 / 11** | `receipts/coverage-policy-after.log` |
| `pnpm test:coverage:policy` (the registered gate, end to end with the new stage) | **11 + 16 + 6 + 7**, exit 0, every stage inside its 512 MiB / 60 s launcher | `receipts/test-coverage-policy-chain.log` |
| `tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts` (bare project run, the measurement that decided item e) | **42 / 42**, and 84 in two projects after the reconciliation | `receipts/extension-campaign-selftest-bare.log` |
| docs `blume validate` | 11 warnings, identical before and after this unit's edit (measured both ways), none about the changed page | `receipts/docs-validate-after.log` |
| docs `blume check` | red at 324 TypeScript errors, every one in `docs/architecture/raptor3-evidence/**` preserved snapshots, none in `content/`; pre-existing, and this unit changed no TypeScript under `docs/` | `receipts/docs-check-after.log` |

**Typecheck:** `node scripts/run-typecheck.mjs` → **0**, exit 0
(`receipts/typecheck.log`).

**Census:** 23 unmatched candidate sentences at 30 sites / 75 inherited / 11
internal / 21 invariant / **193 sites** (base: 23 / 72 / 11 / 21 / 192). The
candidate count is unchanged; the site total and the inherited count moved
because the tool now reads three sentences it could not read, all of them
inherited. `receipts/census-base.md`, `receipts/census-after.md`.

**Biome per changed file, against the base copy**
(`receipts/biome-base-vs-after.txt`):

| file | base | after |
| --- | --- | --- |
| `scripts/raptor3-refusal-census.mjs` | 0, format-clean | 0, format-clean (formatted — its base copy carries no `format` diagnostic) |
| `scripts/raptor3-refusal-census.test.mjs` | new file | 0, formatted with `biome format --write` |
| `scripts/raptor3-manifest.mjs` | 70 (69 `noMisplacedAssertion` + 1 `useTopLevelRegex`), format-clean | 72, format-clean — **+2 `lint/suspicious/noMisplacedAssertion`**, the two assertions of the new patch check, the same rule the file's other 69 assertions trip; no new rule, no suppression |
| `scripts/raptor3-campaign-receipts.test.mjs` | 53, one `format` diagnostic | **53**, one `format` diagnostic — identical; the two new cells' refusal regex is a top-level constant so `useTopLevelRegex` stays at 46, and the formatter was NOT run |
| `scripts/run-raptor3.mjs` | 37, one `format` diagnostic | **37**, identical; the formatter was not run |
| `package.json`, the two workflow files, `CHANGELOG.md`, the `.mdx` and the two `.md` | no diagnostics | no diagnostics |

**LOC:** `scripts/query-engine-structure.mjs` token lines **16,040 → 16,040**.

---

## Registrations

| file | cells | where |
| --- | ---: | --- |
| `scripts/raptor3-refusal-census.test.mjs` | 7 (`node:test`) | `package.json` → `test:coverage:policy`, beside the three existing harness self-tests; named in `.github/workflows/ci.yml` and `release.yml`'s comments |
| `scripts/raptor3-manifest.mjs` | — | **edited**, for item (e) only: the CS-03 support group moved from the runner-only half to the deterministic half, and `assertStructuralMeasurementPatch` added beside `assertStructuralMeasurementRuntime` |
| `scripts/raptor3-campaign-receipts.test.mjs` | 39 → **41** | the two structural-patch cells; the file is run by its own launcher, not by the manifest |

No `G4_PARITY_COUNTS` entry is owed by this unit. The seven the other closure
units owe are listed in the release verdict draft's Validation table, so the
integrator applies them in one place.

---

## Capability change

**None.** No production code changed, no refusal was added, removed or
re-worded, and the candidate-sentence count is the same 23. What changed is
what the tooling can READ and what the documents SAY.

---

## Unverified

1. The runner's own call site for `assertStructuralMeasurementPatch` is wired
   and read, but not executed by a test: the `cs02-structure-measure` mode runs
   only in an isolated patched checkout. The assertion itself is pinned by
   three cells, one of them the retired file.
2. The D1 lane was not run by this unit. Its source, project and CI step were
   read; the guide and CHANGELOG now claim exactly that and nothing about a
   passing run.
3. `blume check` is red for the docs workspace at the base as well as after;
   the 324 errors were grouped by directory rather than diffed cell by cell
   against a base run, because this unit changed no TypeScript under `docs/`.
4. The frozen 146-file / 46,021 baseline's own PHYSICAL lines and BYTES are not
   in the evidence tree; the physical and byte ratios are reported against two
   recorded old-engine readings, both named exactly in `receipts/loc-recount.md`.
5. The census's remaining blind spots are named in its own report and in (a)
   above; none of them is measured to hide a sentence today, but that is an
   argument from the shapes present at this HEAD, not a proof about future code.

## Blockers

**None.** No public-contract change, no new recovery authority and no
numerical-semantics change was needed. Two decisions remain recorded and
pending for Arnaud, neither of them this unit's to take: **D-65** (the captured
set's batch-route window, with the integrator's recommended default) and
**FC-02C's two compatibility residuals**.

---

## Repair round — 2026-09-21 (review round 1)

Four findings, four applied, none declined.

**1 (major, `scripts/raptor3-refusal-census.test.mjs:283`) — cell 7 must not
read a revision a shallow clone lacks.** The cell's fact is the declared failure
owner, not the inherited/candidate split, but it ran the census with the default
`SHIPPED_CORPUS_REV` (`0cc61e61f`); where that revision is absent from local
history the census exits 1 on the corpus
(`scripts/raptor3-refusal-census.mjs:948-955`), and the `coverage` job that this
unit taught to run `pnpm test:coverage:policy` checks out at the default depth 1
(`.github/workflows/ci.yml:157`, `.github/workflows/release.yml:135`, neither
carrying `fetch-depth`). The cell now passes `--shipped-rev HEAD` — the same
argument every other cell of the file already hands the census over its fixture
(line 140) — so all seven cells read a corpus that always resolves and the two
workflows are left alone. Receipt: `receipts/repair-falsifications.log`, F-R1 —
with `SHIPPED_CORPUS_REV` set to an absent hex in a backup copy of the census
script (restored by cp; md5 `27fb52546acc18e3565cb1623a8949a9` identical before
and after) the file reports `tests 7 / pass 7 / fail 0`, where the reviewer
measured 6/1 before the repair. The second option the finding offered
(`fetch-depth: 0` on the two `coverage` checkouts) was not taken: it buys full
history for a gate that needs none, and it would leave the cell red for anyone
running that gate in a shallow clone.

**2 (minor, `note.md:77`) — the second placement states a hazard, not a state
the file was in.** `OperationContext.failure` ASSIGNS its substitution
(`src/query-engine/raptor3/shared/operation-context.ts:638`) and
`returnedConstructions` (`scripts/raptor3-refusal-census.mjs:406-420`) reads
only `return` expressions, so the generic `this.<method>()` arm never reached
that construction and `receipts/census-base.md` attributed the sentence to
nobody (`grep -c "returned a malformed"` = 0). The paragraph now says what the
declaration forecloses — the arm would credit the owner's sentence to every site
that rethrows a CAUGHT value through it the moment `failure` returned its
substitution directly instead of assigning it, which is the shape cell 3 spells
and falsification F1 reddens — and records that the shipped owner assigns. The
same correction is carried in the repair round's structured report: that
round's schema has no `second_placement` field, so the corrected sentence is
quoted in its `applied` entry.

**3 (minor, `release-verdict-draft.md:64`) — two of the three, not three.** The
Outcome section now reads "(three it could not read — two reported as
sentence-less rethrows and one at no site at all, all three inherited)", the
exact wording requested; the rest of the paragraph is re-wrapped, same words.
The note's own table already said it correctly, and the diff of the two census
receipts is the evidence: two rows leave "Sites without a sentence"
(`commands/execution.ts:1035`, `:1071`) and `shared/operation-context.ts:638` is
a NEW site, which is why the total moves 192 → 193.

**4 (minor, `scripts/raptor3-campaign-receipts.test.mjs:357`) — a guard whose
unique coverage cannot be named.** `applied` is a path string (line 349), so
`applied.length > 0` was constant true and the `: ""` arm unreachable — and had
it ever been taken, the cell would have asserted a refusal for an EMPTY patch
file instead of a stale one, which is not the fact it names. The ternary is
gone; the cell writes the stale patch directly. Receipt:
`receipts/repair-falsifications.log`, F-R2 — with the status assertion of
`assertStructuralMeasurementPatch` neutered in a backup copy of
`scripts/raptor3-manifest.mjs` (restored by cp; md5
`58a554c1137fd34587927a8417a6ccf9` identical before and after) the file reports
`pass 39 / fail 2`, the stale-patch cell among them, so the cell still
discriminates the refusal it names.

**Runs of the repair round.** `scripts/raptor3-refusal-census.test.mjs` 7 cells,
7 pass, 0 fail (`receipts/repair-census-selftest.log`);
`scripts/raptor3-campaign-receipts.test.mjs` 41 cells, 41 pass, 0 fail
(`receipts/repair-campaign-receipts.log`); the two falsifications above
(`receipts/repair-falsifications.log`). Nothing else was re-run — the other
three files of `test:coverage:policy` are untouched by this round. **Typecheck**
`node scripts/run-typecheck.mjs`, exit 0, 6.11 s
(`receipts/repair-typecheck.log`). **Biome** per changed file against its base
copy, identical counts: 54 on `scripts/raptor3-campaign-receipts.test.mjs` (the
single `format` diagnostic is the base's — the formatter was NOT run on it, and
the repaired hunk no longer appears in its diff, being written the way Biome
prints it), 0 on the new `scripts/raptor3-refusal-census.test.mjs`
(`receipts/repair-biome.txt`). **No census re-run:** no refusal and no error
class changed, so the counts stand at 23 candidate sentences / 75 inherited /
193 sites. No engine source file was touched, no test was deleted, skipped or
weakened, and the LOC recount is unchanged — the round moves two script lines
and two documentation paragraphs.

---

## Commit message draft (the integrator commits)

```
docs(raptor3): the tree's own account of itself — census, guides and the closure evidence (FC-06)

The refusal census could not read a sentence a site builds and throws through
the engine's failure owner: `execution.ts`'s two carried errors and the owner's
own provider-result substitution reached no line of its report. It now follows
that one declared owner — the carried argument with the resolution it already
uses for a direct throw, and the owner's own substitutions counted once at the
owner — and re-checks the declaration on every run, failing loudly instead of
dropping those sentences. All three are matched in the old engine's corpus, so
the count of unmatched candidate sentences stays 23; sites 192 → 193 and
inherited 72 → 75. The report's labels say what they measure: candidate and
inherited SENTENCES, integrity and provider-result failures included, with the
behavioural closure inventory named as the authority for capability. New
harness self-test, 7 cells on a fixture engine tree, falsified three ways,
registered beside the other script gates.

The documents now say what the tree does. The drivers guide's packaging promise
follows the work's dependencies instead of the verb name, partial progress is
explained only for the two routes that permit it, and hosted evidence is told
apart from the local Workers-pool D1 lane; the CHANGELOG's refusal count and D1
sentence match. Four contradicted rules in the engine guide state the current
one (the occurrence boundary after FC-01, identity against observation after
FC-02A, the scratch read-back's owner after FC-05, P1's exact claim), with the
addenda kept and the history in the ledger. Every other open local item is
reconciled by current evidence as a dated record — D-16's stale clause, the
class-2 rows discharged by the wave, D-64's closed build contract with its pin
that runs in no lane, D-65 pending with the integrator's default, the pg
registration still owed to the one frozen gate.

The harness owns each fact once: `extension-campaign.selftest.test.ts` was
runner-only and credential-free at the same time, measured 42/42 under a bare
project run and moved to the deterministic half, with the invariant now
asserted over the manifest's own runner-only list; and a structural measurement
that names an instrumentation patch its tree does not carry is refused before
it measures anything, which the retired `reference-instrumentation.patch`
(20 of 29 hunks stale) now demonstrates.

Recount, like for like: engine 16,040 token lines = 0.3485 of the old engine's
46,021, 19,898 = 0.3989 with the same integration files, physical 0.34/0.33
against plan §7's 0.70 — +28 of new meaning, −26 of duplicate-rule removal,
nothing cosmetic in the token count. Typecheck 0; census 23 candidate / 75
inherited / 193 sites; Biome per changed file unchanged except the two named
assertions; no engine source file touched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
