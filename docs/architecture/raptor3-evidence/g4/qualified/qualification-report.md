# G4 author qualification

## Outcome

The author qualification evidence is complete and frozen on production
`fce8ec0cd32c839c5517a383d92f003e090e72cb8110b8ec0e08e1f7664d6904`, harness
`d9b7c1653a76234a000ff49cc79cd530bd752e9adb2f0977d30bbe74d0c8ff56`, baseline
commit `0cc61e61`, and Node 24.21.0. The sealed index status is
`author-qualification-evidence-complete-independent-and-root-acceptance-pending`
and its `gaps` list is empty. Independent and root acceptance are not part of
this author package.

Every count in this report is derived from the receipts in this tree by
`support/build-qualification-index.mjs` and then pinned in that script, so a
later change to a receipt fails the build rather than quietly moving a number.

This is the third qualification attempt. Attempts 1 and 2 each found a red,
were stopped, and were superseded by the repair that red required; both are
kept whole and unrelabelled at `../qualified-attempt-1-stale-identity/` and
`../qualified-attempt-2-stale-identity/`, and neither contributes a count here.
`README.md` states what each found.

## Validation

- **Fixed modes.** All 65 registered fixed modes passed, 1,742 test executions,
  zero failures. One further fixed mode, `g0`, was also run inside campaign
  lane 5 (5 files / 33 tests, `campaigns/g0.receipt`); it is recorded separately
  and never counted as campaign cells.
- **Credential-free selectors.** The aggregate selector passed 65 files / 758
  tests; the PGlite provider selector passed 5 files / 11 tests. Both are
  log-only: their launchers print selection and resource lines but write no JSON
  identity companion, and `selector-launch-provenance.json` says so rather than
  claiming the logs embed the identity.
- **Native providers.** All current native modes passed on the task-owned
  loopback containers: PostgreSQL 12 modes / 64 tests on `127.0.0.1:65504` and
  MySQL 11 modes / 69 tests on `127.0.0.1:65515`. This includes the inherited
  `g2-mysql-contracts` 13/13, whose unique-race regression was the condition for
  starting qualification at all.
- **Campaigns.** All 15 campaigns passed: 265,000 cells, 795,000 exact replays,
  zero skips. The four G4 campaigns are 250 children each on disjoint fresh
  ranges — `g4-seeds` 20000–44999 and `g4-transport-seeds` 50000–74999 (the read
  campaign, two profiles each), `g4-write-seeds` 75000–99999 and
  `g4-write-transport-seeds` 100000–124999 (the accepted G3 write generator on
  seeds no child has run). The eleven inherited campaigns reran their own
  registered ranges on the frozen identity because the source under them changed.
- **Replays.** Seven current corpora replayed green through the `replay` gate
  (both write families, both G3 families, all three CS-03 extensions). Nine G3-era
  inputs were refused with the required stale-identity sentence. The two G4 read
  families are reproduced by re-running their own child command rather than
  through `replay` — see "The G4 read corpora" below — and both re-runs passed
  200 cells / 600 replays / zero skips and produced corpora **byte-identical**
  to the retained child archives they reproduce.
- **Structural measurement.** 28 cases / 60 same-build replays / zero skips,
  `qualifying: true`, alternative `shared-occurrence-candidate`, run in an
  isolated worktree. Reversing the instrumentation restored both touched file
  hashes and the complete production/harness identity
  (`structural-measurement/reversed-identity.json`).
- **Support checks.** Driver integration passed 2 files / 16 tests. Receipt
  self-tests passed 39. CLI self-tests passed 10. Typecheck reported only the two
  historical Pattern TS2345 diagnostics at `src/query-engine/pattern/pack.ts:1443`
  and `:2633`; there was no new diagnostic.
- **Corpus integrity.** A streaming audit restored and hashed every one of the
  1,320 retained gzip corpora: **53,996,673,706 original bytes from
  1,054,375,465 archive bytes**, each checked against its own descriptor for
  archive bytes, archive hash, restored bytes and restored hash. The runner had
  already archived 1,200 of them (the G3 and G4 families); this package re-proved
  those rather than trusting their descriptors, and compressed the remaining 120
  (G1 and G2 children) itself, unlinking a raw corpus only after its restore was
  proven. Nine replay inputs were compressed the same way: 300,270,586 bytes to
  6,083,035.
- **Source.** `source-allowlist.json` lists 244 task files (37 tracked, 207
  untracked) and `source.patch` (1,969,658 bytes) carries the tracked diff against
  `0cc61e61` followed by a `--no-index` new-file diff for each untracked file;
  the patch was checked to describe exactly the current tree.
  `support/frozen-identity-manifest.json` is the per-file manifest of all 1,074
  identity inputs and re-derives both fingerprints.
  `support/source-cost.json` records the charged perimeter at 171 files /
  53,890 token-lines / 2,518,074 bytes, with a 147-file / 47,710 token-line
  navigation subtotal.

## The G4 read corpora

A G4 read child corpus carries the campaign subject (`candidate` / `shipped`),
and the generic `replay` gate's corpus schema rejects unknown keys, so
`replay <g4 read corpus>` fails with `unrecognized_keys: subject`. That is the
runner's own design, not a defect the package is explaining away: the G4 read
family's archive descriptor names `g4-seed-batch <seed> --subject=candidate` as
its reproduction command, precisely because a read corpus names a subject and a
`replay` would not re-run the subject it was recorded on.

The two attempts made with the `replay` spelling are kept exactly as they ran,
as `replays/receipts/g4-seeds-20000.not-a-replay-input.receipt` and
`…/g4-transport-seeds-50000.not-a-replay-input.receipt` with their logs;
`replays/NOTE.md` is the integrator's classification. The two correct
reproductions ran afterwards and are `replays/receipts/g4-seed-batch-20000.receipt`
and `…/g4-transport-seed-batch-50000.receipt`. Each re-executed 200 cells / 600
replays / zero skips on the frozen identity and emitted a corpus whose bytes and
SHA-256 equal the retained child archive's `originalBytes` / `originalSha256`
(`support/reproduction-packaging.json`). So for those two children the claim is
not only "the archive restores" but "the archive's contents are what re-running
the child produces".

## Not in this package

**No performance evidence.** The §3 performance series (20 frozen cells, five
alternating fresh-process pairs per cell, 5 % time and 10 % peak-memory budgets)
is not part of the author qualification tree and no receipt of it is claimed
here; its receipts live under `../cutover/`.

## Claim boundaries

- **Source cost only.** The source measurements establish no runtime,
  allocation, bundle or package-size result. `support/source-cost.json` carries
  `status: "source-accounted-bundle-pending"` and the index repeats the
  boundary.
- **Native suites.** The PostgreSQL and MySQL results are the current-source
  modes on the two task-owned loopback containers recorded in
  `../environment/providers-restart-receipt.json`. They are not a claim about any
  other provider version, build or deployment.
- **Read campaign profiles.** The four G4 read profile names are backed by the
  transport model each cell actually exhibits, checked per child; the names alone
  are not the claim.
- **Write campaign.** `g4-write-seeds` and `g4-write-transport-seeds` are the
  accepted G3 write generator on fresh disjoint ranges. They are new inputs, not
  a new generator, and they are not a second qualification of the G3 envelope.
- **Acceptance.** Independent and root review attestations are external to this
  sealed author tree; nothing here is an acceptance.

## Risks

- Re-execution is proven for six of the 1,320 retained children — the first
  child of each of the four seeded families that has a replayable corpus, plus
  the two G4 read reproductions — and for the three CS-03 parent corpora, which
  are not among the 1,320. Every other retained corpus is proven to restore to
  its exact recorded bytes; that is a weaker claim than re-execution and is all
  the audit asserts.
- Free disk stayed between 4.7 GiB and 11 GiB across the qualification and was
  4.7 GiB when packaging began. The retention pass was run in move mode, which
  removes a lane's copy of a child receipt only after the retained copy's bytes
  and hash have been re-proved; nothing was removed that failed to verify. A
  future attempt on this machine should free space first rather than rely on that
  margin.
- Two earlier attempts were invalidated by reds this qualification itself found.
  That is the process working, but it means the current identity is young: it has
  one full pass behind it, not three.
- Review attestations must stay outside the sealed checksum tree so that they do
  not rewrite the author evidence they assess.
