# G3-04 independent qualification review

## Status

**ACCEPT.** The fixed, native-provider, campaign, saved-replay, support,
typing, structure, accounting, archive, and integration evidence all bind the
same frozen identity. I found no remaining G3-04 qualification defect. This is
acceptance of the private G3 construction and its evidence, not public client
adoption or the deferred G4 codec/projection envelope.

Reviewed qualification identity:

- production: `5d7a639868789faff0cf0a2a04b11e846a91e4d82001c81277bf312ecb0c74c6`
- harness: `03b9f9050193b1cfada53f892f0ac487a5ccc291ec1c97f7b2290c259e935b44`
- runtime: Node 24.21.0 on darwin/arm64

## Pre-qualification audit

The current manifest and runner reconcile with the reviewed
[inventory](unit04-inventory.md): 31 inherited and 11 new G3 fixed modes select
1,133 tests. The credential-free aggregate selects 65 files and 754 tests; it
deliberately excludes the one-test minimization mode, which must run separately.
The aggregate `g3p05-contracts` mode includes the selector-dependency 11,
variant-order 4, and recursive-read-fit 6 tests, so its split aliases are not
missing coverage. The provider inventory is 10 PostgreSQL modes / 58 tests and
9 MySQL modes / 47 tests.

The campaign arithmetic is also complete: seven inherited families contribute
21,000 cells and 63,000 exact replays; the two G3 lanes add 40,000 cells and
120,000 replays. Acceptance therefore requires 61,000 cells, 183,000 exact
replays, and zero skips on one frozen identity. A selected saved corpus from
each G3 lane is additional replay evidence, not a substitute for a completed
parent campaign.

The final 100-ID trials validate the archive scale and mechanism, not the full
campaign. SQLite produced 78,700,582 raw bytes and a 1,389,330-byte verified
gzip archive; scripted transport produced 85,021,090 raw bytes and a
1,650,048-byte archive. The existing parent runner verifies restored size and
SHA-256 before removing only that task-created raw child. Retaining all raw
children would require about 16.4 GB and is not the accepted archive plan.

Source accounting must preserve four different units without conflation:
physical lines, code-bearing `tokenLines`, actual parser-leaf tokens, and source
bytes. `tokenLines` is a line count, not a token count. Existing shared owners
newly brought into the charged perimeter must remain separate from genuine G3
source growth. No bundle or runtime reduction is claimed at this milestone.

## Accepted source-bound results

The 42 independently registered fixed modes retain 42 `attempt.json`,
`verified.json`, and raw Vitest receipts. Every receipt binds the reviewed
production/harness/runtime identity. Directory labels equal `verified.mode`,
and direct aggregation of the raw Vitest reports is **1,133/1,133 passed**, zero
failed and zero pending.

The 19 native PostgreSQL/MySQL modes likewise bind the reviewed identity and
their directory labels. Direct aggregation is **105/105 passed**: PostgreSQL
58 and MySQL 47. The provider records retain loopback ports 51436/51439,
container and image identities, and the one-GiB memory boundary without
credentials. The credential-free aggregate log separately records 65 files / 754
tests passed, and the PGlite log records five files / 11 tests passed; final
closure must still bind these log-owned selections durably to the frozen
identity rather than inventing a different reporter receipt.

All nine campaign families reconcile from their parent and child artifacts to
**61,000 completed cells, 183,000 exact replays, and zero skips** on the reviewed
identity. The seven inherited families contribute 21,000/63,000/0. Each new G3
lane has 100 contiguous 100-ID children covering seeds 8000 through 17999,
20,000 cells, and 60,000 replays. In each of the two profiles per lane, exactly
10,000 cells ran with 2,000 actual actor overlaps and 2,000 actual faults.

The G3 SQLite archive retains 100 unique original hashes for 7,307,669,774
original bytes in 136,223,853 compressed bytes. The transport archive retains
100 unique original hashes for 8,104,480,920 original bytes in 160,982,722
compressed bytes. Both have exactly one descriptor and gzip per child, no raw
duplicate, actual compressed sizes matching their receipts, and parent
descriptors byte-semantically equal to the child receipts.

## Final evidence audit

The closure evidence establishes all remaining obligations:

1. The aggregate log records 65 files / 754 passing tests; the PGlite log
   records five files / 11 passing tests. Their established launchers are
   log-only, and `selector-launch-provenance.json` binds the exact commands,
   log hashes, resource results, and no-edit qualification window without
   pretending that the logs contain an identity field.
2. The public-client driver integration report passes 16/16. The campaign
   receipt selftests pass 34/34 and the CLI suite passes 7/7. All preserved
   resource records report successful teardown.
3. Seven selected corpus inputs match their recorded SHA-256 values and replay
   successfully. The two historical inputs retain their old identities and are
   refused; neither has a forged `verified.json`.
4. The typecheck log contains exactly the two historical Pattern TS2345
   diagnostics at `src/query-engine/pattern/pack.ts:1443` and `:2633`, and no
   task-added diagnostic.
5. Structural measurement passes 28 cases / 60 same-build replays / zero skips.
   Its isolated instrumentation identity is distinct, and both the source-file
   hashes and complete production/harness identity return byte-exactly to the
   frozen base after reversal.
6. A streaming audit decoded every one of the 200 G3 gzip corpora without
   materializing restored copies: 15,412,150,694 restored bytes from
   297,206,575 compressed bytes, with zero hash, byte-count, descriptor, or
   corpus mismatch.
7. The source patch reverses cleanly against the current qualified tree to
   baseline commit `26e4f78378e5f545c694c8bc3789201db7f5926a`.
   Every one of the 57 source-allowlist byte counts and SHA-256 values matches
   the worktree.
8. `retained-files.json` classifies every file in `unit04`: 1,996 retained
   files (506,916,892 bytes), 451 local-only files (959,017,043 bytes), and no
   unclassified file. Six adjacent compact development-red archives/descriptors
   add 3,955,945 retained bytes while their three raw originals stay local.
   `SHA256SUMS` contains exactly those 2,003 retained entries, contains no raw
   corpus/progress/work-copy-path leak, and verifies 2,003/2,003 from the
   archive root.

## Accounting and integration boundary

The final census is 6,955 code-bearing lines, 43,457 parser-leaf tokens, and
231,518 bytes across the 12-file core; the 30-file broader perimeter is 11,877
code-bearing lines, 72,459 parser-leaf tokens, and 501,048 bytes. Relative to
CS-04, genuine whole-owner source growth is 359 code-bearing lines. Another
846 lines are existing driver-instrumentation and bind-budget owners newly
charged by the wider perimeter; they are not called compression. No bundle or
runtime-speed claim follows from this census.

The exact integration set is the union of the 57-file `source-allowlist.json`,
the G3 plan/status/review files, the retained checksum tree, and the compact
unit01-unit03 evidence, excluding the raw/local-only files named by
`retained-files.json`. The final explicit path list is
`/tmp/viborm-g3-unit04-allowlist-final.txt`: 2,308 unique existing files,
529,069,557 bytes, SHA-256
`d28ff03b480c5ea78481592aa6ae474ce5fc98dd73b001a48846ab73aa3a9536`.
It excludes `CONTEXT.md`,
`memory.md`, every Pattern file, Exa output, pre-G3 evidence archives, root
transport corpora, the two trial-20 raw green corpora, and the three large raw
development-red specimens.

## G4 boundary

G3 qualification does not adopt or route the private engine. The shipped client
remains unchanged. G4 still owns the full query/projection and codec envelope,
public type/lifecycle integration, and native PostgreSQL/MySQL execution of the
recursive-read fit. It must also reconcile SQL set/increment semantics with
non-returning final-key derivation before adding the deferred arithmetic/list
operators. The accepted SQLite recursive-read fit remains a regression through
G3; it is neither a public recursive API nor complete native conformance.
