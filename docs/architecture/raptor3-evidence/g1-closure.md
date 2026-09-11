# Raptor 3 — G1 closure

Date: 2026-09-08.

## Outcome

**G1 is complete. G2 has not started.** The private structured-command candidate
passes the expanded G1 contracts, both 1,000-seed campaigns, the admitted live
PGlite witnesses, command-boundary checks and independent adversarial review.
The shipped engine remains the public route. This is permission to invest in
the next experiment, not a replacement or release decision.

The [central plan](../raptor3-implementation-plan.md) remains the implementation
owner. The original [representation comparison](g1.md) and later
[non-variant checkpoint](g1-expanded.md) retain their original costs and receipts;
this report closes their remaining G1 inventory, not the full engine inventory.

| Unit | Executed result |
|---|---|
| G1-01 | Commands won the same-scope S1–S4 comparison: 1,815 versus 1,985 counted production lines. That archived comparison is unchanged. |
| G1-02 | Independent public recipes, raw-state oracles, variants/identity/lifetime witnesses, generated worlds, shrinking, explicit transport responses and fault replay. |
| G1-03 | Shared construction and membership across fresh/selected sources, both FK orientations, junctions, compound keys and basic variants. One assignment owner supplies final fields and exact producer demands. |
| G1-04 | Adapter-based SQL on real SQLite and PGlite, same-batch references, acknowledged generated-output continuation and exact membership conflict targeting. |
| G1-05 | Operation-local execution, successful publication, rollback/progress, shaped/correlated results and witnessed captured-key decoding. |
| G1-06 | Final source-bound validation, measured whole-file cost, review closure and retained evidence. |

The new evidence did not require a generic graph pass, a variant engine or a
class per relation verb. Basic variant storage binds the same membership shape
from the existing resolved topology. Public tags, stored discriminator values,
private carrier columns and reference tuples remain distinct facts. Captured
decimals use the existing codec's canonical private representation; public
results receive fresh Decimal values.

Construction and interpretation remain together in `commands/commands.ts`
(772 physical lines). This is a reviewed cohesion choice: both operate on the
same closed command tree; admission, field demands, storage mapping, physical
dispatch and projection already have separate owners. No forwarding layer was
added merely to split construction and execution between workers. Its size is
visible and remains subject to review as G2 introduces real new responsibilities.

The production author, independent witness author and read-only adversary used
Astra/high. Findings returned to the owning author, then the integrator inspected
the repairs and reran the relevant witnesses. Two late production findings were
pinned independently against the legacy engine before repair:

- A selected parent's selector-bearing upsert must distinguish a globally absent
  target from a target owned by someone else. Global lookup followed by the
  existing membership requirement now covers child-held references and inverse
  variants as well as junctions. A selector-free singular lookup stays correlated.
- Reconnecting the exact same junction membership must not fail. The existing
  link operation now targets only the complete source-and-target uniqueness
  tuple. Other unique/FK failures remain loud; an adapter without targeted
  conflict support is explicitly refused in this private slice.

These repairs added no command kind or execution pass. Separate harness findings
also mattered: a fault specimen must copy its own frozen-wire projection;
recorder snapshots must use the existing lossless codec; and cleanup evidence
must distinguish protected native errors from deliberately redacted public
causes. The first replay mismatch stays authoritative during cleanup. Review
closed with no remaining G1 blocker.

The [cost receipt](g1-closure-cost.json) charges every included source file whole,
using the unchanged TypeScript token-start line census. These are code-bearing
LOC, not LLM tokens.

| Charged selected candidate | Files | Code-bearing LOC |
|---|---:|---:|
| Command representation, field demands and entry | 3 | 945 |
| Shared schema, storage, query and operation context | 4 | 1,405 |
| Unchanged admission/types and adapter integration | 5 | 449 |
| **Total** | **12** | **2,799** |

The total is 3,192 physical lines / 103,762 source bytes. It meets G1's ≤5,000
guidepost. The listed evidence/tool cohort is reported separately: 78 files,
19,577 code-bearing lines, 20,471 physical lines and 661,473 bytes, including
pre-existing and G0 infrastructure. It is not hidden engine work or a claim that
all those tests were written during G1. Shared launcher/configuration changes
also remain visible outside the engine count.

The old production baseline remains 49,887 counted lines, with its original
baseline file unchanged. Comparing 2,799 with that whole engine would be a false
reduction claim: G1 does not implement its full surface. The whole-engine
forecast stays 20,200–31,000 until broader evidence supports revising it. The
unexpanded program's current count is likewise not comparable with the expanded
commands; only their archived same-scope comparison selects the representation.

## Validation

All acceptance runs use production identity
`21bb428e9da03fa79250f67d2cc5eebf96fabb12dc7188a278d665a4d2064d57`
and harness identity
`bc5b680cf33d7584da6bb0583838f00bf1008f8c08f2451ec79cc3a0945a2b74`.
They ran on the named dirty checkout, not a claimed clean HEAD. Final executable
source stayed fixed during validation; documentation changes do not change these
identities.

| Final command or suite | Result |
|---|---|
| `g1-baseline` | 141/141: independent expanded legacy cells and the compound falsifier |
| `g1-contracts` | 143/143: 82 ordinary, 42 variant/identity, 16 lifetime, one compound falsifier and two cleanup witnesses |
| `g1-compare` | 66/66; S1–S4 and 144 exact candidate replays remain green |
| `g1-generated` | 35/35; generated smoke, shrinking and multiple-fault/healthy-suffix checks |
| `g1-transport` | 44/44; explicit reply scheduling, real pending-call overlap, publication, progress, error attribution and harness falsifiers |
| `g1-seeds` | 1,000 seeds per SQLite profile; 2,000 cells and 6,000 exact candidate replays |
| `g1-transport-seeds` | 1,000 seeds per scripted profile; 2,000 cells and 6,000 exact candidate replays |
| Four isolated PGlite files | 10/10 registrations: five baseline witnesses and five candidate comparisons |
| G0 regression from CLI setup | 33/33 registrations, 200 seeded cells and 672 exact replays |
| CLI boundary suite | 6/6, including saved replay, missing/filtered/stale input and both real watchdog stops |
| `test:all --only "Raptor 3"` | 320/320; inherited specimen/replay variables could not replace the fixed lane |

These suites overlap; their registrations must not be summed as distinct
semantic capabilities. The A/B campaigns total **4,000 seed/profile cells and
12,000 exact candidate replays**, with zero skips. Each of the four profiles has
250 two-actor cells and 250 injected-fault cells. Both campaigns use ten serial
children of 100 distinct seeds, numbered 1000–1999. Lane A releases actual
queued replies and checks physical parameters; it does not evaluate SQL. Lane B
executes and inspects real SQLite, including the restricted atomic-batch model.

The PGlite witnesses distinguish independently advanced generated primary and
non-primary outputs, multiple consumers, supply before the parent, and a moved
producer whose old unique value is taken by a decoy before continuation. They
use the existing isolated schema-family fixture. This proves those PostgreSQL
behaviors, not hosted transport or concurrent-server isolation.

Cleanup injects a secondary failure only after a real successful native rollback.
It pins unchanged rows/sequence state and the ordered native primary/secondary
report. Interactive public lifecycle errors are checked as a complete aggregate
with shared correlation before their two genuine members are compared through
the existing outer-error rule. Atomic public causes remain redacted; no new
public secondary-error visibility is claimed. Opaque nested causes are never
recursively normalized. Original observations and exact replay tapes are kept.

The same external replay command accepts saved overlap and cleanup corpora.
Known-bad publication and wrong-parent corpora exit nonzero for
`exact-publication-parameters` and `generated:membership`, respectively, not for
a stale hash or an incidental exception. The shrink witness retains original
and reduced recipes and replays both three times. The provider-wait watchdog
reaches an actual queued public call before its 10-second stop; the original
120-second watchdog remains intact. Both verify process-group teardown.

Resource ceilings were unchanged: ordinary checks use a 768 MiB heap, sampled
1,536 MiB group RSS and 120-second child limit. Campaign child maxima were
4.99s / 744.8 MiB for A and 6.34s / 755.0 MiB for B. The combined fixed lane used
813.2 MiB. The four isolated live-PGlite runs used 6.57–7.02s and at most
1,551.8 MiB under their existing 2,560 MiB allowance. The CLI suite completed in
172.37s under its outer 600-second owner. Teardown was verified.

The native whole-estate typecheck reports **no Raptor 3 errors**, but exits 1
on the two pre-existing Pattern TS2345 errors in `pattern/pack.ts` at lines 1443
and 2633. It used 5.76s / 5,529.3 MiB under its existing 8,192 MiB allowance.
The source census used 1.29s / 362.3 MiB. No current runtime or bundle improvement
is inferred from these checks.

[The evidence index](g1-closure-index.json) names the source and archive hashes,
final receipt directories, seed batches, provider runs and diagnostic failures.
The [archive](g1-closure-evidence.tar.gz) retains the private candidate, evidence
code, selected configuration and receipt files against the stated checkout.
It is not a standalone repository or dependency installation. Historical red
runs have earlier identities and are diagnostic, not final-source replay claims.

## Risks

G1's scalar/output slice is int, string and the witnessed decimal paths, not the
complete scalar/filter/result-parser surface. MySQL, hosted providers, full
lazy/callback/array/extension integration, all bulk and recursive operations,
and the remaining C01–C13 cells are not qualified. Current targeted-conflict
refusals are private experiment limits, not changes to shipped support.

The retained `types.ts` is charged whole but still has dormant declarations that
reach legacy series types. The consumed operation-name union does not execute
that language. Candidate-only declaration/package independence remains a later
adoption requirement; renaming an import would not settle it.

The next investment is G2's before/after key identity, membership transitions,
occupancy and supply/modify laws. Those witnesses may expose limits that require
revising the current representation. G3 then completes scopes, series and
recursive composition; G4 completes the public envelope and full provider,
bundle and performance qualification. Early timing precision remains deferred
under Arnaud's approved policy, not resolved or waived for adoption.
