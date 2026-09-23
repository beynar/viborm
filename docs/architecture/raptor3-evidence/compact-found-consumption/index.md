# Compact found consumption — artifact index

This archive belongs only to the bounded compression and found-consumption
checkpoint. It is not a whole-release qualification or an adoption verdict.
The measured candidate is
`bd264d329221f1c6257aac264fedd59c413707e6`; the source and harness were clean
for every retained run.

The machine-readable map is [`artifact-index.json`](artifact-index.json),
SHA-256
`993f5312c135198af520f5641bcf09595d21c892fbaa01b9bfd37361f3a97e01`.
It records all 41 archived artifacts, their original absolute receipt paths,
their relative archive paths, byte sizes, and hashes. Raw copies are
byte-identical. Each compressed artifact records both the raw and gzip hashes
and was round-trip checked before archival.

## Source and harness identity

| Fact | Value |
| --- | --- |
| Repository tree | `8046ba2bc26881740a0331c698f6bd1d995cdfe6` |
| `src/` tree | `2f7858ad676d67f9d299b25c3f49bd54f5b75a92` |
| `tests/` tree | `4b02232da30b128a8d697c8eeac1459d39b703fc` |
| `scripts/` tree | `b8f91796272dc51e94efc79f7e760defe24ed344` |
| `benchmarks/` tree | `63f383607dadd33c8a87a98e728d5a20b47a8baa` |
| Native harness manifest | `66646be39f5db1e21d3fbcd8a634e7bd425bf82b5ecf102864b9d9b4ca8ab18a` |
| Lockfile SHA-256 used by performance reports | `c366c9806e268e19970626c34e0c5ea1bb74cc7c24b388fa072d580d7bf9aceb` |

Native qualification, the primary source censuses, and the primary performance
comparisons used Node 24.21.0 and V8 13.6.233.17-node.53. Native qualification
also used pnpm 10.11.0, Vitest 3.1.4, and TypeScript 7.0.2 on Darwin arm64.
The original Node 24.14.0 reports remain unchanged as supplemental evidence.
The exact runtime and helper-blob identities are retained in
[`native/source-count-index.json`](native/source-count-index.json) and the
lossless performance reports.

The native index keeps its original absolute `rawLog` paths unchanged. The
artifact map supplies the corresponding repository-relative archive paths; no
historical receipt was rewritten to pretend it originated inside this tree.

## Lossless compressed reports

| Archive | Role | Raw bytes | Gzip bytes | Raw SHA-256 | Gzip SHA-256 |
| --- | --- | ---: | ---: | --- | --- |
| `source/before-node24.21.json.gz` | primary | 635,986 | 93,738 | `70e4afbc422524b6c98bd3fc2ec3da41bd50a8df6d48fb0158523969bdb56906` | `dc0865f08b7d275d416e8ca9e1f51ce7491a24e2fc8132389a52b219d2342df5` |
| `source/after-node24.21.json.gz` | primary | 636,328 | 93,824 | `181b5a9627f295645707f14d0a0df327d452d27929c521df1e9dfdd452d18065` | `09d8328c537cd48784cbf86a2dc92f1d19f7ece1e413bbd23c0c3d83853f27d2` |
| `performance/perf-node24.21-vs-previous.json.gz` | primary | 51,891,967 | 4,400,860 | `79766f7eb914b9f3a842594a75dd19161c255ce5f8b7f15e8e53b34b2848cd9e` | `4e8f87c912bf73902188643a036e47676dc9be6006f492b39172576cdd745f5e` |
| `performance/perf-node24.21-vs-old-engine.json.gz` | primary | 51,885,475 | 4,401,080 | `336c19c648c73a0e6f8ab541fd417d09b84200cbb06154c46abea9f529167fe1` | `569080d28feeb5cf2a57475af0857389c007012e1b709f037ff4786439d681c7` |
| `source/before.json.gz` | Node 24.14 supplemental | 635,986 | 90,427 | `b70480c1c2ceea0b9aea452b6de14a12e946e4d93a0f99028134f07ca12e5e75` | `7d1ddf0ae409a201dc6304b6107d9b309ffb21e8eac3a6324f5799e5e7fde1fb` |
| `source/after.json.gz` | Node 24.14 supplemental | 636,328 | 90,496 | `f8cc8d3a30ad4b0b8af7780bd7a5ac9557c656a05ba3ab8e15cdf9b43eb37bbf` | `b39c9147b3d2244b18ff5194128839cb62eb738d33f9d0b85bedf976b4eb607a` |
| `performance/perf-vs-previous.json.gz` | Node 24.14 supplemental | 51,891,913 | 4,405,001 | `901ee03f4bc9584c460bffe648cecdf4d1c4eb5717693bf19015e74653ff2b19` | `4dc1d4db113c74fd03fd8efc524bb9387714a0023735a261adfaa16188673e53` |
| `performance/perf-vs-old-engine.json.gz` | Node 24.14 supplemental | 51,885,354 | 4,405,279 | `83fc8a13146e652954646cadb5e2987af988ea42a456b952c4999ae365fe8e53` | `69416a8042b6bbbf994663c75fe0cc3aaeebd1cde0eba3a3751e4c192435e447` |
| `performance/perf-vs-old-found-confirmation.json.gz` | Node 24.14 supplemental | 12,983,347 | 1,101,025 | `35cdea0e280c99e331f4cf53da4d185ae10a346fcb27b01f7e7af8257b9c6094` | `62ea66f9ee79830ce5a4fd29990728bc1b445bf5f5e98c8155e0b5649921087a` |

The reports are compressed because their lossless contents are about 223 MB.
After decompression, read performance comparisons with the repository's
`parseEvidenceReport` owner; the source reports are plain JSON. Do not print
whole comparisons or samples: they can contain complete fixture states.

## Raw checks

The four files under [`checks/`](checks/) are unchanged command logs from the
final candidate:

| Gate | Result |
| --- | --- |
| Whole-estate TypeScript | 0 diagnostics; 7.06 s wall; 5,129.1 MiB peak RSS |
| Fixed Raptor gate | 956 passed across 89 files |
| Core gate | 8,439 passed across 403 files |
| SQLite provider | 797 passed / 1 skipped across 9 files; the focused found-consumption file is 15/15 |

The 27 native logs under [`native/`](native/) are also unchanged. The corrected
index, SHA-256
`52b039d29a6d90d7e9e491daf3c5ea990a3ed49a70b1bb1fa35f3dfcc2f9126e`,
records:

| Provider group | Files | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: | ---: |
| PostgreSQL | 7 | 490 | 7 | 0 |
| MySQL2 | 15 | 793 | 1 | 0 |
| G1 PGlite | 5 | 11 | 0 | 0 |

These are execution totals, not a claim that the quick gates and provider
projects are disjoint coverage. They must not be summed into a distinct-test
count.

## Interpretation limits

The two primary performance reports are protocol-valid five-replicate semantic
comparisons. Their legacy `keepGate` remains `false` by design and is not an
adoption verdict. The immediate-parent report records a 0.719% missing-path
allocation increase beyond twice its run MAD. The old-engine report records a
pre-existing 21.199% bulk-allocation difference. The targeted found path
improves significantly against both comparison points. No report here
establishes a whole-release pass, adoption verdict, bundle savings, or waiver.
