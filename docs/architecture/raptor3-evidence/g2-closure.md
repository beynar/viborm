# Raptor 3 — G2 qualification

Date: 2026-09-08. Status: **G2 complete; G3 not started**.

## Outcome

The private command engine passes the registered C05–C07 transition contracts
and both complete generated campaigns. All four G2 units are complete; the
evidence archive is verified. The shipped engine remains the public route. No G3
implementation, public cutover, package-size or performance claim is made here.

The [central plan](../raptor3-implementation-plan.md) owns the milestone exit.
The [execution record](g2.md) retains intermediate failures and repairs; the
[inventory](g2-inventory.md) connects the independent witnesses to existing
public contracts. The three Astra/high streams used disjoint source ownership,
baseline-first classification and adversarial review. Runtime checks ran serially
with source frozen. Documentation changes do not change the measured identities.

Decision: the G2 exit is met and the G3 investment is justified. No language
redesign round was consumed, and no repeated-repair failure remains unresolved.
G3 still needs its own classified scope and independently proved handoffs.

The implemented shared rules are:

- Captured identity differs from the final key requested by this operation.
  Existing Assignments carry exact producer fields across key changes; old
  membership reads and later final-key writes use the appropriate occurrence.
- Initial absence differs from loss of an observed row. A lookup owns both
  failure roles. Found COC, conditional upsert and singular junction captures
  retain the exact row or pair they observed.
- Membership is the resolved edge/member, not a public name or shared column.
  Actual assignment contributions retain their logical command owner. Direct,
  inverse and tagged views reuse existing topology identities.
- Clearing a membership, deleting its target, and transferring its owner have
  different effects. They compose ordinary removal/deletion, lookup, record and
  link commands. A link reads actual preceding removals rather than an
  `afterClear` flag. Junction key rebasing changes only the addressed side.
- Conditions are ordinary SQL observations. Skip and match retain the same
  captured identity; SQL owns NULL truth. Found-arm legality precedes skip.
- Recovery belongs to the exact failed INSERT and selected unique constraint.
  Other branches, acknowledged work and uncertain dispatch do not authorize it.
  Input admission is not repeated by that recovery.

Two compatibility decisions were explicitly approved by Arnaud: one scalar
transform call per admitted input, and exact failed-INSERT ownership for unique
recovery. Baseline and candidate keep separate exact observations for those
decisions. The legacy engine is unchanged; no global comparison exemption was
introduced. Template and captured-member admission remain separate scopes.

### Source cost and structure

The [cost receipt](g2-cost.json) uses the unchanged token-start-line census,
charging every included source file whole. These are code-bearing LOC, not LLM
tokens or minified bytes.

| Selected candidate cost | Files | Code-bearing LOC |
|---|---:|---:|
| Commands, field demands and private entry | 3 | 1,886 |
| Shared schema, storage, query and operation context | 4 | 2,007 |
| Retained admission/types and adapter integration | 5 | 449 |
| **Total** | **12** | **4,342** |

The total is 4,748 physical lines and 157,234 source bytes. G1's comparable
partial total was 2,799 lines: G2 adds 1,543. The 9,000-line G2 review guidepost
is met. Comparing this partial engine with the old full 49,887-line engine would
be misleading. The full-engine forecast stays 20,200–31,000 until broader
coverage supports changing it. Bundle and performance qualification remain G4.

The seven current command forms are record, lookup, choice, link, removal,
deletion and series. No separate payload/OwnWrite interpreter, per-depth compiler,
variant engine, generic graph pass or provider-name dispatch was introduced.
Storage views consume the existing resolved schema index; syntax remains with
adapters. Retained admission is the named exception, not a legacy compiler
fallback. The unselected program remains a comparison specimen.

Large-file cohesion was reviewed explicitly: Commands is 1,655 physical lines,
OperationContext 964, and Queries 714. Construction, analysis and interpretation
share one closed command language and the same operation-owned occurrences;
provider execution/progress, schema admission, storage binding and field demand
already have separate owners. The files are not split by verb or worker merely
to move lines. This is a G2 cohesion decision, not proof of maximum compression
or a waiver from reviewing G3's new scope responsibilities.

The separately counted evidence/tool cohort is 152 files, 31,351 code-bearing
lines, 32,826 physical lines and 1,097,494 source bytes. It includes existing
benchmarks and G0/G1 infrastructure, not only new G2 tests. This cost is visible
but is not shipped engine code or part of an import-size reduction claim.

## Validation

Final production identity:
`a83684e26f175a3ed1a42a194969815ac2640e6232d173910a5e23e377be4b64`.
Final harness identity:
`52244510bf1f486d17fc9ae00fa5bf9ba22d62186afb2c19f961335b2529ec52`.

| Final-source check | Result | Receipt suffix |
|---|---|---|
| G2 public baseline | 216/216 | `rC5qSv` |
| G2 candidate comparison | 216/216, three exact replays per candidate cell | `Gll1tf` |
| G1 contracts | 143/143 | `aA4u4V` |
| G1 representation comparison | 66/66 | `pOtTo2` |
| G1 transport | 44/44 | `prtRYu` |
| G1 generated/falsifier checks | 35/35 | `3EQf6N` |
| G2 generated/falsifier checks | 52/52 | `BRGTUR` |
| G2 transport checks | 16/16 | `Qoyrj1` |
| Native PostgreSQL comparison | 18/18 | `rRD2R6` |
| Native MySQL comparison | 13/13 | `LuLgWb` |
| External conditional-upsert corpus replay | 22 saved records replayed through the source-checking command | `7G0Gzq` |
| Disputed diagnostic behavior | 2/2 reproductions; not accepted error-policy changes | `EaLv0j` |
| SQLite 5,000-seed campaign | 5,000 per profile; 30,000 exact candidate replays; zero skips | `s5BPLN` |
| Transport 5,000-seed campaign | 5,000 per profile; 30,000 exact candidate replays; zero skips | `gyLCgG` |

Receipt directories use the prefix `viborm-raptor3-g0-` under the recorded local
temporary directory. Counts overlap and must not be summed as distinct features.
Native checks use real PostgreSQL/MySQL constraints and races. Scripted transport
replies are not SQL evaluation or evidence of another hosted provider.

The earlier SQLite parent `viborm-raptor3-g2-seeds-flIvOr` and transport parent
`viborm-raptor3-g2-transport-seeds-Tq6CXA` each passed 5,000 seeds per profile and
30,000 candidate replays. They retain the preceding harness identity. A stale
disputed-behavior probe was then corrected at its own diagnostic-read cut;
production code did not change. Both campaigns were repeated for the final
harness identity. The existing receipt validator verifies exact seed coverage,
replays and quotas; no partial-progress receipt is counted as completion.

Final campaign parents are `viborm-raptor3-g2-seeds-s5BPLN` and
`viborm-raptor3-g2-transport-seeds-gyLCgG`. Each has 50 verified 100-seed batches,
covering seeds 2,000–6,999 on both profiles. This is **20,000 seed/profile cells
and 60,000 exact candidate replays**, with zero skips. Every profile has 1,250
two-actor cells and 1,250 injected-fault cells (25% each). SQLite's two profiles
also prove actual overlap for all 1,250 such cells and operation counts from
1–16. Scripted returning/ack profiles retain their explicit transport-model
scope. SQLite children peak at 12.20s /768.1MiB; transport children peak at
20.74s /714.7MiB (wall and RSS maxima need not be the same child).

Every listed completed runtime check verified teardown under the existing
768MiB heap, 1,536MiB sampled process-group RSS and 120-second child ceilings.
The final native whole-estate typecheck used 9.41s /5,757.6MiB under its existing
8,192MiB ceiling. It reports no Raptor3 errors but exits nonzero on the two
pre-existing Pattern TS2345 errors at `pattern/pack.ts:1443` and `:2633`.
The source census used 1.72s /359.4MiB with verified teardown.

Both disposable provider containers were stopped and auto-removed after native
validation. Their temporary databases had no host mounts. No shared database
or saved evidence was deleted. Neither container reported OOM or restart.

### Retained evidence

The [index](g2-closure-index.json) maps the final checks, source identities,
campaign batches, resources and historical diagnostics. The [run log](g2-closure-runs.log)
preserves final command output, including the nonzero whole-estate typecheck.
The [archive](g2-closure-evidence.tar.gz) contains frozen production/harness
source, configuration, cost receipt and 335 receipt directories: 3,022 entries,
113,792,122 compressed bytes. Exact archive membership and safe relative paths
were verified. SHA-256:
`453d4166e1e0f679479d077414450cb9e9c00da90b9778bb1e8ba731f966e5e3`.
Dependencies, environment files and credentials are excluded. This is an
evidence snapshot, not a standalone repository or shipped package. The plan and
reports remain adjacent to the archive so their status can be maintained.

## Risks

G3/G4 remain unqualified: bulk/scoped retry, recursive composition, complete reads,
public typing/lifecycle, package shape and performance need their own exits.

Conditional skip-to-match replanning remains a G3 scope obligation; raceable
metadata alone is not retry parity. The reproduced old behavior in which a
failed diagnostic read replaces a primary failure is unchanged; a prospective
correction still needs the pending compatibility decision. No divergence was
silently accepted for it.

The whole-estate typecheck remains red for the two pre-existing Pattern errors.
This experiment neither fixes those unrelated files nor claims a green full
repository typecheck.
