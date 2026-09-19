# Claude Fable — overnight G4 implementation handoff

Implement G4 of Raptor 3 in `/Users/arnaud/code/viborm`. Use `/workflows` and
**Opus subagents at maximum reasoning** for implementation and independent
adversarial review. You are the integrator and final reviewer. This instruction
replaces the central plan's older Sol/high model assignment, not its engineering
constraints or acceptance gates. Inspect the installed `/workflows` instructions
and available model controls; do not invent a command or silently substitute a
different model. Report a missing capability explicitly.

Work through the night toward completed, qualified G4. Start implementation
after the bounded orientation below; do not spend the night reopening the
architecture. Continue ordinary implementation, repairs and qualification
without routine approval requests. A hard stop condition still applies while
Arnaud is asleep: preserve the exact blocker and continue only independent,
unaffected work. Do not waive a contract to achieve an overnight deadline.

## Goal: Raptor 3, not a polished Raptor 1

The original engine accumulated features as a working prototype. This rewrite
seeks a smaller language of necessary facts that expresses the same behaviors
through composition, derivation and ordinary recursion. We want fewer
independently maintained decisions, lower maintenance and extension cost, less
production code, and no material performance regression. Neither denser syntax
nor a tiny interpreter hiding a large compiler achieves this.

G0–G3 already tested and improved this representation. The foundation is
qualified; extend it, do not start another speculative foundation checkpoint.
No component is sacred, but a replacement needs a concrete counterexample and
must follow the remaining redesign budget. G4 completes the behavior and
provider envelope and proves whether the replacement is fit for adoption.

Preserve the public API, inferred types, zero codegen and aggregate `s`
ergonomics. Do not require users to import every feature individually to obtain
a smaller bundle. Do not prune capabilities or dependencies as an adjacent task.

## Accepted starting point

Local commit: `0cc61e61` — `refactor(raptor3): unify completion and scalar update ownership`.

- Production identity: `fe544577cbc3c6747806f4b6a178ffe284d52d7ac3b5dd87fcd39adc2c3d54da`.
- Harness identity: `3d9977876d5b8c0c80aec1ea6902f34b39ea80ab52e07e7242a287312dd2b922`.
- Runtime: Node **24.21.0**, darwin/arm64; better-sqlite3 **12.6.0**, Vitest **3.1.4**.
- Core: **6,927 code-bearing LOC / 43,383 parser tokens / 230,397 bytes**.
- Complete charged perimeter: **11,849 LOC / 72,385 parser tokens / 499,927 bytes**.

G3 and its final structural correction are independently and root accepted.
The last correction removed 28 production LOC, 74 parser tokens and 1,121 bytes.
No bundle or runtime improvement was inferred from those source measurements.
Qualification includes 42 fixed modes / 1,137 tests, the overlapping 758-test
aggregate, PGlite 11, PostgreSQL 58, MySQL 47, nine campaigns totaling 61,000
cells / 183,000 exact replays / zero skips, replay and harness integrity gates.
Those numbers describe G3, not credit toward G4's new campaign budget.

The last whole typecheck reported only historical Pattern TS2345 errors in
`src/query-engine/pattern/pack.ts:1443` and `:2633`. Keep them separate; permit
no new diagnostics. Recheck the current tree rather than assuming it is clean.
Known unrelated dirty files at handoff were `CONTEXT.md`, `memory.md`, and
`tests/pattern/pack/program-dump.ts`; other untracked work also exists. Preserve
all unrelated work. Do not reset, stash, delete archives or stage everything.

## Read these sources, in order

Paths below are relative to the repository root.

1. `AGENTS.md`, `src/query-engine/AGENTS.md`, and
   `src/query-engine/raptor3/AGENTS.md`; read applicable nested instructions for
   each additional layer you touch.
2. `docs/architecture/raptor3-implementation-plan.md` — authoritative scope,
   contracts, G4 units, handoffs, decision-elimination gate, resource rules,
   performance budgets, stop rules and separate cutover gate. Read the complete
   active plan, particularly §§2, 4–9 and the current handoff.
3. `docs/architecture/raptor3-evidence/g3.md`, then
   `docs/architecture/raptor3-evidence/g3/structure-correction/root-acceptance.md`
   and `qualification-review.md` in that same directory.
4. `docs/architecture/raptor3-evidence/g3-prep-inventory.md` — remaining shipped
   behavior and its intended ownership. Reconcile with current source and
   registered suites; old inventory status is not proof a feature is missing.
5. `docs/architecture/raptor3-evidence/core-structure.md` and `g29.md` for
   inherited decisions and consumed repair/redesign budgets. Retrieve relevant
   historical details; do not reload every raw corpus to begin work.
6. `features-docs/recursive-query.md` and the central plan's bounded recursive
   fit contract. The queued public feature is context, not extra shipping scope.

The current sealed qualification package is
`docs/architecture/raptor3-evidence/g3/structure-correction/qualified-final/`.
Its `qualification-index.json`, `reproduction.md`, `source-allowlist.json`,
`cost-report.md` and support identity/cost reports explain reproducibility.
The sealed author's index deliberately retains its pre-review pending status;
the later external review and root acceptance supersede that status. Do not
reopen G3 or rewrite historical receipts because of it.

## Navigate by semantic owner

- `src/query-engine/raptor3/commands/index.ts`: private candidate entry.
- `commands/commands.ts`: admitted recipes and same-tree dependency analysis.
- `commands/relation-body.ts`: relation composition, verb order, provenance,
  resolved membership and selector-versus-producer continuation.
- `commands/assignments.ts`: symbolic final writes, demands and contributions.
- `commands/execution.ts`: interpretation and recursive member execution.
- `shared/operation-context.ts`: broad per-operation owner, execution boundary,
  transport, progress and terminal completion through composed owners.
- `shared/query.ts`: prepared selector/projection meaning, correlated/shaped
  queries, dependency facts, SQL lowering through adapters, decoding, updates.
- `shared/schema.ts`: immutable schema-derived views, not execution state.
- `program/`: retained comparison specimen, **not a second expansion target or
  fallback**. Include its cost where the established perimeter requires it.
- Existing client, extension, cache, transaction, driver and adapter owners:
  reuse their lifecycles and protocols; the candidate does not replace them.

Read actual code before choosing edits. This map is orientation, not a mandate
to create a new abstraction in each file.

## Rules we learned the hard way

Read [ELEGANCE.md](../../ELEGANCE.md) for the canonical reusable principles.
The following are their **Raptor-specific applications at this handoff**, not a
second general policy. The current private architecture guide and central plan
own exact contracts.

- **Shared meaning:** `Queries.prepareSelector` supplies selection and dependency
  facts; prepared projections supply lowering and decoding. Bind fresh aliases
  without another public-syntax walker or rebuilding SQL for decoder shape.
  `Queries.updateValue` supplies mutation assignments and symbolic updated keys;
  no JavaScript operator ladder. Internal captures retain canonical codec values.
- **Shared structure:** logical analysis and physical execution use the same
  placement-owned occurrence structure. Do not restore flat histories, copied
  prefixes, suffix replacement, mirrored branches, membership-owner searches or
  reset journals. Reused command definitions do not share occurrence state.
- **Lifetimes:** command and transport attempt state are replaced together.
  Ownership, admission, acknowledged progress, committed continuations and the
  one-recovery allowance remain outside replacement as specified by the plan.
  One broad `OperationContext` composes these owners; it does not collapse them.
- **Admission and observation:** transforms/defaults run once per admitted input,
  including across replay; retain deferred member timing. Never cache observed
  absence. Missing, foreign and lost targets remain different failures. Enforce
  membership through consumption. Complete row keys, reference keys and exact
  junction pairs differ; field references are not literal disjointness proof.
- **Series:** keep scalar bulk work set-oriented. Root and nested series share
  construction, capture and member execution with their distinct admission
  boundaries. Prepare all captured members before effects; actual member defaults
  can invalidate a template answer. Read terminal rows after all member effects
  through complete final keys.
- **Completion:** `finishOne`, `finishMany` and `finishValue` express cardinality
  independently of physical query count, through one terminal decoder.
  Nested `executeRecords` must not finish the operation, clean parent scratch,
  acknowledge preparation or replace the outer result parser. Preserve multiple
  roots, nested siblings, generated keys, count/selected/empty results and late
  failures. Removing a refusal must test every newly reachable result mode.
- **Authority:** the existing array owner composes `PreparedBatchOperation` or
  owns sequential fallback. Borrowing alone grants no lifecycle, savepoint,
  suppression or replay authority. Recovery requires the exact failed INSERT
  and its eligible rejection; uncertainty, acknowledged prefixes or a missing
  recovery winner authorize no new INSERT. Keep `return await` inside the
  recovery owner when it must catch terminal rejection.
- **External owners:** adapters spell SQL, existing codecs own scalar meanings,
  and client/extension/cache/driver owners retain their lifecycles and trust
  boundaries. Preserve non-RETURNING simple, compound and decimal updated keys
  omitted from projection, including low-bind caps. Read those layers' current
  rules; they evolved during the private rewrite.

## G4 execution order and agent workflow

Use `/workflows` to organize these existing units, not to add a parallel process
framework. Keep one integrator and at most three worker streams. Production
authors and independent reviewers use Opus/max. Assign each agent one outcome,
owned files, constraints and a concrete exit. Do not have an author approve its
own unit. Give reviewers goals and contracts without steering their verdict.

- **G4-01 — query/projection semantics:** complete remaining C01/C12 through
  current shaped/correlated query owners: read language, filters, ordering,
  pagination, grouping/aggregates, projections and codecs. No separate aggregate,
  nested-read or recursive engine. Freeze the concrete read/projection handoff
  early enough for G4-02, with executable examples and falsifiers.
- **G4-03 — client lifecycle/types:** may proceed alongside G4-01 in disjoint
  boundary/test files on verified interfaces. Complete C13 through the candidate
  without duplicating admission, extensions, raw, cache or transaction lifecycle.
  Probe public types through real public call syntax, including nested typo
  probes beside valid keys and variable-held inputs. Do not switch the shipped
  client route to claim integration.
- **G4-02 — physical/provider envelope:** starts after the G4-01 handoff is
  accepted. Complete required providers, existing fast paths and the physical
  realization of that handoff. Shared query/context files require explicit
  writer transfer; two agents editing different methods is still a conflict.
- **G4-04 — qualification/adoption review:** after all units pass independent
  review, perform your integrated code/ownership review **before** expensive
  full qualification. Repair bounded findings, freeze source and harness, run
  qualification, then close that same review against evidence and cost.

Independent witness work can run in parallel with implementation after its
contract is frozen. It must not derive expected behavior from the candidate.
Batch completed-unit review findings; have the author repair and the reviewer
verify affected paths. Reuse agent context where useful. Validation is serial
under the existing workspace lock, on a stable imported graph or explicit
immutable snapshot. Stop dependent streams when a shared contract changes.

## LOC and decision-elimination checkpoint for every unit

Before coding, record the required behavior, current owner and smallest proposed
change in `docs/architecture/raptor3-evidence/g4.md`. At review, answer:

> Which existing decisions become unnecessary? Exactly what disappears, and
> which invariant makes it unnecessary while that invariant holds?

Name the removed mechanism, consumers and a falsifier. Check a second applicable
placement through the same owner. Moving code or renaming state is not deletion.
If genuinely new behavior removes nothing, say so and justify its owner.

Report incremental and cumulative core LOC, full charged LOC, parser tokens and
bytes. Include new/moved/shared owners; keep tests and evidence separate. Use
the existing census and fixed denominators. Do not confuse the current G3
incremental baseline with the plan's original replacement baseline, or count
comparison retirement as semantic compression. Explain growth and added rules.
The target is a lean, expressive final system—not passing an arbitrary LOC
test. Preserve §7's actual targets and required shortfall review; do not silently
waive them or automatically discard a sound engine for missing a percentage.

## Qualification, performance and evidence discipline

Use the existing scripts and discover registered modes before calling them:
`scripts/run-raptor3.mjs`, `scripts/raptor3-manifest.mjs`,
`scripts/run-node-safe.mjs`, `scripts/run-typecheck.mjs`,
`scripts/query-engine-structure.mjs`, `scripts/measure-raptor3-baseline.mjs`.
Pinned Node is `/Users/arnaud/.vite-plus/js_runtime/node/24.21.0/bin/node`;
also ensure children resolve that runtime. Keep current dependency versions.

First verify current identity, provider availability, resource lock, disk space
and evidence output/reporters with narrow checks. Do not rerun all accepted G3
campaigns merely to orient yourself. During units run missing red witnesses,
affected suites, cross-position tests, types and required native checks. At
closure run the complete required G4 behavior/type/package/provider inventory
and inherited regression gates on the frozen final identity.

G4 requires **25,000 new seed IDs per admitted A/B lane/profile**, not 25,000
total across profiles and not 25,000 hosted-provider calls. Freeze disjoint
ranges. Preserve the plan's actor/fault quotas, actual applicable cuts, exact
replay and independent oracles. Native lane C runs required contracts and named
races. Use at most 100 seeds per child and the existing 120-second campaign
batch limit/resource policy. Partial batches and missing barriers are failures.
Source or harness changes cannot inherit stale successful receipts.

Performance is now a hard qualification requirement, unlike deferred G3 timing.
Follow §7 exactly: comparable baseline/candidate workloads; five alternating
fresh-process samples each; medians and prescribed MAD uncertainty; 5% time and
10% memory budgets; one full repeat for inconclusive results, then block adoption.
Frozen scalar/bulk fast-path statement and round-trip counts must not increase.
Measure end-to-end work fairly, including admission/decoding, real providers,
bundle fixtures and parser cost. Do not move work outside measurement boundaries,
trim outliers, weaken a budget or infer performance from LOC.

Carry recursive-read fit to fuller projection/codecs and native PostgreSQL/MySQL
lowering. Preserve the bounded fixture's depth-as-edges, path-local cycle stop,
pruning and separate overlapping occurrences. No query-per-depth, finite include
unrolling or handwritten test-only traversal can satisfy it. This proves fit;
it does not settle or ship the queued public recursive API.

The last qualification exhausted disk space because raw campaign corpora are
large. Estimate required space before long runs. Use existing compact reporter
and lossless archive support, retain all required replay proof, and verify
restored bytes/hash before any task-local raw replacement. Do not build an
artifact service or delete historical/user files. Retain parent **and required
child** verified/Vitest/compact-summary receipts: missing G3P06 children caused
the final seal to be rejected even though the runs passed. Failed attempts stay
failed; never relabel them. Preserve exact commands, identities and actual modes.

Keep qualification artifacts frozen. Put later reviewer/root attestations
outside their checksum tree. An evidence-only packaging repair does not require
rerunning unchanged code when its exact original raw proof still exists.
Missing required evidence blocks acceptance; summaries and agent claims are not
substitutes. Count overlapping tests honestly and distinguish PGlite, native
providers and simulated transport claims.

## Stop rules and delivery

Follow §8 and carry consumed budgets forward. Two unsuccessful repairs of the
same minimized failure require Arnaud's decision. Representation redesign and
performance revisions have their specified bounded budgets; renaming a unit,
starting a worktree or handing it to another agent resets none. New observable
compatibility choices require a decision, not automatically copying or correcting
legacy behavior. Keep already approved single-admission and exact-INSERT rules.

Missing provider proof, unresolved performance uncertainty, unsafe resource
enforcement, false-green harnesses, required skipped cases or feature loss cannot
be called PASS. Save a reproducible blocker and exact remaining work if the
night ends or intervention is required. Do not claim completion from focused
tests or because code is written.

Maintain the central plan, private guide when durable knowledge changes, and
`docs/architecture/raptor3-evidence/g4.md`. Record unit status, decisions,
ownership/deletions, measured costs, repair budgets, exact evidence, and time
spent implementing/reviewing/validating/packaging. Preserve historical evidence.

When qualified, make one exact task-scoped local Conventional Commit after
auditing the staged set and final source identity. Do not push, publish,
destructively alter databases, expose credentials, delete the legacy engine or
perform C-01 public cutover. Prepare a reviewable cutover proposal only; adoption
shortfalls and cutover require the authority specified by the central plan.

Report with **Outcome**, **Validation**, and **Risks**: completed versus pending
units, independent review status, exact measurements and baseline deltas,
qualification identity, commit, and any blocking requirement. Keep the report
concise and link the evidence. G4 is done only when its actual hard exits pass,
not when the engine merely looks elegant.
