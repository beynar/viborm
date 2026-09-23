# G3-03 independent review follow-up 2

## Verdict

**ACCEPT the bounded post-review repairs and focused checks on the exact
identity below.** This follow-up does not rewrite the initial `REVISE` review or
the first focused acceptance. It does not accept the aggregate CLI trials or
G3-04 qualification, which remain later gates.

## Source-bound result

The fresh focused receipts bind:

- production:
  `5d7a639868789faff0cf0a2a04b11e846a91e4d82001c81277bf312ecb0c74c6`
- harness:
  `43aec109aa86f8fe40be200eb0ff3563633ff20323c0d08d70fb602ec390bdc2`
- Node: `v24.21.0`
- Vitest: `3.1.4`
- SQLite driver: `12.6.0`

Five local modes pass 21/21 with no failures or skips:

| Mode | Result | Raw report SHA-256 | Evidence directory |
| --- | ---: | --- | --- |
| `g3-bulk-series` | 6/6 | `c14bd776981b296db7cee2f854efa23892aff050cc2b560564e0aa9226e5f051` | [`unit03/focused-green/bulk`](unit03/focused-green/bulk/) |
| `g3-transaction-array` | 4/4 | `89dbc5c1e6e7a98b4ded36a00fed4c1080baf2692659906fac5c55d3eb75f7d2` | [`unit03/focused-green/array`](unit03/focused-green/array/) |
| `g3-scope-failure` | 2/2 | `ba46d2c5497655f35819e5422df7da29ecee73dfa0e92b1f6e41e4f19385da76` | [`unit03/focused-green/scope`](unit03/focused-green/scope/) |
| `cs01-extension-composition` | 4/4 | `40c448040367ea6e606c5a743801caacc902509551d95dd4a267bc99417c1e5a` | [`unit03/focused-green/composition`](unit03/focused-green/composition/) |
| `g3-execution-review` | 5/5 | `4a390df4ccd8886234d49edd2ae7bc979d9d0b847791086910cebe4ebf4a2e4b` | [`unit03/focused-green/review`](unit03/focused-green/review/) |

The two native scope-composition modes pass 4/4:

| Mode | Result | Raw report SHA-256 | Evidence directory |
| --- | ---: | --- | --- |
| `g3-scope-composition-pg` | 2/2 | `ea24dd90497f08ce6457206d5153f4f78d80291523b78ec735c901e622c2fce8` | [`unit03/native-green/pg`](unit03/native-green/pg/) |
| `g3-scope-composition-mysql` | 2/2 | `fdb82d644b52af703c7112ba2690b2e78110d3575cb47a7a2ef22e42734804b3` | [`unit03/native-green/mysql`](unit03/native-green/mysql/) |

The final whole-estate type log is
[`unit03/type-and-selftests/typecheck-final.log`](unit03/type-and-selftests/typecheck-final.log)
(SHA-256
`c37c9c6758f413d170006dc18abfc2e1537ac05e1db50cc94a3c1eca6a968732`).
It contains only the two established Pattern `TS2345` diagnostics at
`pack.ts:1443` and `pack.ts:2633`; no G3 production, witness, harness, or native
diagnostic remains. The command exits nonzero because those two historical
diagnostics remain, so this is not described as a globally green type check.

## Repair review

The bounded source corrections preserve the reviewed contracts:

- Bulk row readers and expected default rows now establish total numeric and
  string values at the fixture boundary. Campaign replay callbacks explicitly
  discard their richer world return where the minimizer requires
  `Promise<void>`, and optional records and completed drivers are narrowed
  before use. These are type-model repairs, not weaker result or replay checks.
- Transport diagnostics prepend stable `g3-*:*` property names while retaining
  the prior case-sensitive diagnostic text after the separator. Existing
  transport refusal assertions and the minimizer's stable-property identity
  therefore both remain meaningful.
- The scope witness identifies the held provider statement as the nested author
  `create`, not the enclosing root `createMany`. It preserves the exact caller
  failure as the outer transaction result and separately proves the observed
  candidate rejects with `TransactionError` and no published progress.
- `readSuppressedFailures(callerFailure)` is correctly empty in that observed
  scope case. The candidate failure already has its own observed promise; it is
  not a release or background secondary recorded by the canonical
  `withSuppressedFailure` owner. An unobserved divergent transaction-scope
  failure belongs to the transaction cleanup `AggregateError` contract instead.
- CS-01 now proves admitted scalar `updateMany` selection exactly, retains the
  two pre-I/O relation-projection refusals (`select` and `include`), and proves a
  relation-bearing scalar `omit` returns the exact projected root while the
  exact root and child rows are stored. It does not widen relation projection.

Current reviewed source hashes are:

- bulk scenario:
  `d37364211b6efca1ba6c23553d42d053179bc91de19cb8f79e1a83472c8ae7b4`
- transaction-array scenario:
  `7a9c1b4bab990f8f075d43dfccaeba271ad8a6002ec2a262ea873cb2e6700796`
- failure minimizer:
  `6136d3202ba5c883cf34d35a51095bfdea6162210cc9a7c6b3adc192e3bac1cd`
- transport plans:
  `d5aab0c322a56ef8af8776b0f45f2d6297d8f0391283644d54c8084f3d4346f1`
- scope failure contract:
  `cbaf0abea85b36f7f0b331af3665f3af67f554d7d158d72909c979b8f56f6f47`
- CS-01 extension A contract:
  `2fab81342f27a514b311c39911dadca323779777273eb2dec00256bd087fb129`

## Remaining boundary

These receipts resolve the bounded repair and typing questions only. The
credential-free aggregate, CLI trials, full G3 campaigns and replays, provider
inventory, accounting, structural measurement, archive checks, and root global
review remain G3-04 obligations on whatever identity is finally frozen. The
separate `g3-generated-minimization` mode is one test and must run explicitly;
the current credential-free aggregate does not select it.
