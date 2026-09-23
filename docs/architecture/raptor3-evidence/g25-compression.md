# Raptor 3 G2.5 compression follow-up

Date: 2026-09-08

## Outcome

The bounded post-G2.5 compression pass is source-qualified for its fixed scope.
It does not reopen G2.5, start G3, change a public route, or qualify adoption.

- Slice A is retained. `Queries` now has one membership-predicate algorithm for
  alias-to-alias correlation and captured-source membership. The existing
  `correlation()` and `memberWhere()` methods only select the operand form.
- Slice B is retained. `RelationBody` binds and caches only the ordinary edge or
  tagged variants reached by the admitted mutation. Literal requirements stay
  with first binding, and transition registration stays with executed relation
  construction.
- Slice C is rejected. Its tentative symbolic `Choice` branch-output composition
  saved three token-bearing lines, but added a parallel whole-assignment alias
  interpreter. `command-attempt.ts` and `execution.ts` were restored byte for
  byte to the qualified G2.5 snapshot.

The unchanged whole-owner census reports:

| Scope | G2.5 | Final | Delta |
|---|---:|---:|---:|
| Command language | 2,124 | 2,124 | 0 |
| Shared private engine | 2,010 | 1,990 | -20 |
| Retained owners | 449 | 449 | 0 |
| Total token-bearing lines | 4,583 | 4,563 | -20 |
| Total physical lines | 5,000 | 4,980 | -20 |
| Total bytes | 164,954 | 164,394 | -560 |

File attribution is exact: Slice A changes `shared/query.ts` by -20 token lines,
-20 physical lines, and -620 bytes. Slice B changes
`commands/relation-body.ts` by 0 token lines, 0 physical lines, and +60 bytes.
The total token-line reduction is 0.44%. This is a private representation
contraction, not a whole-engine, bundle, declaration, package, or performance
claim.

## Validation

Every bounded launcher receipt used production identity
`dafdda6ae547ca38bddd49fdd7358fa87221d1e83c41d5fb7cb217979444018d`
and harness identity
`b720e2f0a11d0cd8a1ec00f94319310a22ee92648db94919752ae832a34a3e9f`.
The runner used Node v24.20.0, better-sqlite3 12.6.0, Vitest 3.1.4, a
768 MiB heap limit, a 1,536 MiB sampled process-group RSS limit, and a 120 s
child wall limit. Runs were serial and each bounded runner verified teardown.

| Gate | Result | Peak sampled RSS |
|---|---:|---:|
| Campaign receipt self-test | 7 passed, 0 skipped | no sample |
| `g1-compare` | 66 passed, 0 skipped | 732.6 MiB |
| `g2-baseline` | 216 passed, 0 skipped | 761.4 MiB |
| `g2-contracts` | 216 passed, 0 skipped | 770.2 MiB |
| `g2-generated` | 52 passed, 0 skipped | 730.2 MiB |
| `g2-transport` | 16 passed, 0 skipped | 654.9 MiB |
| `g25-contracts` | 6 passed, 0 skipped | 520.6 MiB |

The G2.5 gate includes two independent SQLite witnesses. One proves that a
captured fixed-reference decimal uses the target physical codec while nested
result correlation uses an alias. The other proves that a captured compound
variant-junction decimal uses the source physical codec while returned variant
members use alias correlation.

The native whole-estate typecheck completed under its existing 8,192 MiB
ceiling. It reported only the two pre-existing Pattern TS2345 errors at
`src/query-engine/pattern/pack.ts:1443` and `:2633`; it reported no new error.

The installed census owner produced
[`g25-compression-cost.json`](g25-compression-cost.json) with calibration source
identity `7b5e72064164e274d2daf72300bd15e2aaeefefeddea3ca5b63a46b8e67d28c4`.
The former G2.5 cost and evidence archives were not modified. Independent
Sol 5.6/high implementation and review streams accepted A and B and rejected C;
the root coordinated the freeze and qualification.

## Risks

The two complete G2 generated campaigns and native PostgreSQL/MySQL fixed gates
were not rerun. C was rejected, and A/B remained local to private predicate
construction and lazy relation binding, so those expensive lanes did not add
required evidence for this bounded pass. Historical campaign/provider receipts
remain evidence for their old G2.5 source only and do not qualify this identity.

The fixed G2.5 gate executed its 12 in-test exact replays. No separate
saved-corpus replay gate, bundle, declaration, package, or performance
qualification was run. Those limits do not block this private contraction; G4
and any later cutover still own complete qualification.
