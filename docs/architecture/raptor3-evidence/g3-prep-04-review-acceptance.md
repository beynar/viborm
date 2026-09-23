# Raptor 3 — G3P-04 independent acceptance attestation

Date: 2026-09-11. Verdict: **ACCEPT**.

This later attestation does not alter the immutable original G3P-04 handoff,
the first review-repair package, or the second review-repair package and their
indexes. The same independent reviewer accepted the second repair on production
`939810eee04971c33ff625047ba7bc8187e8b078e0567d5dc09d2f0ed5a8e5c3`,
harness
`4c8c2c4a4330655fcab55d203977bfe726240072af0ad7c2d37c4b388db941f9`,
and whole-source identity
`0cd8da7e085fbfe46e3a39437d2a34bae42bda9fb054b41653cd9e690be1e52e`.

Independent verification passed the five G3P-04 review regressions, the five
original G3P-04 SQLite cases, and all eleven conditional-upsert cases. It also
verified all 34 files in the second-repair checksum manifest, the embedded live
runner identities, and the 657-file whole-source identity behind the matched
8,745-token-line, 28-owner cost. No frozen receipt or index was relabeled.

The reviewer accepted all three repaired rules: borrowed suppression refuses
before effects across both `Choose` arms, borrowed exact failure cannot gain
standalone replay authority, and selected static series publish terminal state
in input order. G3P-04 is independently accepted. G3P-05 may proceed; the
exhausted generated-output and borrowed pre-effect repair budgets remain carried.
