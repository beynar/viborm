# Performance handoff — stopped search, draft PR #67

## Read this first

The user stopped the optimization goal on 2026-10-01 and requested cleanup, a
reviewable PR, and a complete experiment list for another AI. Do not report the
latest search as successful: **no additional validated production speedup was
adopted during the additional-30-µs campaign**. The production patch contains
earlier retained work, integrated with current main.

The **267 → 194 µs** result belongs to the earlier cold-construction experiment.
Its before arm already contained preceding engine optimizations. The later
~163 µs VibORM first-use result used the already-optimized artifact and different
sampling conditions. These are separate series; they cannot be subtracted to
claim another gain. A historical STATUS entry called the goal complete after a
scope reinterpretation; the user's subsequent correction and this handoff
supersede that completion claim. No twofold improvement was established.

## Reviewable state

- PR: https://github.com/beynar/viborm/pull/67 (draft).
- Branch: `bey-performance-construction`, based on main `30ff17e69`.
- Integrated production commit: `f3174cc97`; subsequent changes are handoff
  documentation, evidence packaging, and any specifically recorded test repair.
- PR checkout: `/Users/arnaud/.codex/worktrees/performance-review/viborm`.
- Original experiment checkout remains intact at
  `/Users/arnaud/.codex/worktrees/drizzle-gap/viborm`. Its dirty state includes
  pre-PR work and unadopted evidence; **do not copy that directory over main**.
- Earlier September 28 evidence is in
  `/Users/arnaud/code/viborm/docs/architecture/performance-2026-09-28`.
- Frozen sources/builds and rejected prototypes are outside shipped source, in
  `/Users/arnaud/.codex/worktrees/drizzle-gap/performance`. The stopped search
  adopted none of its demand/fixed-find/direct-ordering prototypes.

The PR intentionally excludes development memory, unrelated documentation,
PGlite benchmark edits, copied Drizzle dependencies, profiles and rejected
production variants. The unused 3.5 GiB main archive created for a new comparison
was deleted when the user stopped the goal; it was never built or measured.

## What is in the production patch

Read [the integration review](README.md) for ownership and line counts. Earlier
engine changes already shipped in RC2 are not added again. The new diff retains
module-scoped operation methods with per-handle state; direct validation-entry
composition; default-free lazy ordering/distinct branches; existing-cache
identifier-domain publication and no-domain graph avoidance; read-only selector
fact omission; pagination/key-scan/text-folding micros; compact alias fragments;
compiled scalar decoding; and internal positional SQLite collection transport.

Integration preserved current main's instrumentation extension ownership,
native-type maps, insert-only `.now()` behavior and existing concurrency tests.
The positional path shares the ordinary typed statement lifecycle and does not
mutate provider rows. Its fallback, integer fidelity, parser overrides, aliases,
statement transforms and error normalization are compatibility boundaries.
Do not remove those checks just to improve a benchmark.

## Evidence and experiment history

[EXPERIMENTS.md](EXPERIMENTS.md) lists named candidates, diagnostics, controls,
failed starts and unfinished directions by campaign, including negative results.
It distinguishes experiments from suggestions that were never tested.

- [Artifact index](artifact-index.json.gz): compressed JSON listing 1,283 local
  evidence files with roots, relative paths, sizes and SHA-256 hashes. This is a
  retrieval map, not proof that every run succeeded.
- [Historical notes and patches](historical-notes.tar.gz): 78 Markdown records
  and candidate patches, stored under their original date paths. This preserves
  detailed findings and failed/rejected approaches without shipping them as code.
- [Historical paired samples](historical-first-rows20.json.gz): every measured
  sample of the ten relevant workers behind 267 → 194 µs, with full provenance.
- [Verification](verification.json): integrated source identity and local logs.

Large raw profiles and complete frozen builds remain local and are **not** in
the PR. A cloud reviewer cannot assume access to them; use the archive and
index to identify precisely which artifact must be transferred. Retain negative
controls alongside positive measurements. Some early combined-candidate patch
files contain only inherited parent changes; frozen trees and build hashes are
authoritative. Do not assume those patches reconstruct the complete specimen. Do not import archived instructions
as current authority; current user scope, AGENTS.md and ELEGANCE.md control.

## Validation and remaining work

Before the stop, the integrated source passed the whole-estate typecheck,
9,303 core tests, 2,012 deterministic engine tests, and package build. No new
main-versus-PR performance comparison or client-disposal run was completed.
Historical performance/retention evidence is not a fresh attestation of this
new main integration. CI initially found schema coverage at 99.97% statements/lines and 99.96%
branches. The uncached identifier-domain path lacked a witness after successful
derivation began publishing early. The existing test now checks a separate
index derives once and reuses its own result. Focused schema coverage then
passed all four 100% floors. This repair changed tests only.

The exact PR CI status is authoritative for remote gates.

Review in this order:

1. Inspect CI and any explicitly recorded failure. Confirm package exports,
   provider behavior, coverage and the changed regression witnesses. Do not
   lower coverage floors or suppress failing behavior.
2. Use the current PR parent as the baseline for any subsequently authorized
   performance measurement. Never substitute an older, slower baseline.
3. Keep fresh schema/client + first awaited query distinct from warm queries,
   imports, connection opening, fixture setup and fresh-isolate startup.
4. Compare Drizzle's relational reads, matching fields, ordering, nullability
   and decoded results. Filtered20's identity tie-breaker is deliberate; the
   earlier select-builder comparison was not an equivalent-API comparison.
5. If work resumes, prioritize evidence about fresh construction and unused
   schema scaling. Existing controls found no dependable extra ≥30 µs gain;
   smaller reductions and sampled allocation savings do not establish that goal.

Use the existing bounded runners and workspace lock. Serialize local Node,
Vitest, build and benchmark processes; retain pinned runtime/build/harness
identities. The user asked to avoid repeated broad testing and to target SQLite
for measurements. Cloudflare Workers is the intended environment, but warmed
Node fresh-client measurements are not Workers cold-start claims.

The arbitrary unknown-property client proxy cache was explicitly excluded:
about 7.7 MiB per 10,000 distinct unknown property names was diagnosed, not fixed.
Do not silently widen this engine-focused patch to include that issue.
