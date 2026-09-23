## 1. Source identity

- commit: `bc18b4e2325a5f7dce1165e05a28482f78a83d72`
- head: bc18b4e2325a5f7dce1165e05a28482f78a83d72 2026-09-21T14:16:50+02:00 feat(raptor3): the final local closure — one shared reference requirement, the D-65 captured-set contract, native MySQL qualified, the deadlock policy, the release record
- calibration source identity: `77b2d00e918fd4c19abb8557c2eedfad8fd25f01ab4264df4d9ba7fcdaf0272c` (sha256 over the calibration owner's named file set)
- scope: src/, benchmarks/, scripts/, package.json, pnpm-lock.yaml, tsconfig.json, tsdown.config.ts, biome.jsonc — the existing calibration owner
- working tree at assembly: 

```
M AGENTS.md
 M docs/architecture/raptor3-evidence/g4/release/closure-final/README.md
 M docs/architecture/raptor3-evidence/g4/release/closure-final/release-verdict.md
 M scripts/closure-final-index.mjs
?? docs/architecture/raptor3-evidence/g4/release/closure-repair/
?? scripts/closure-final-inventory.mjs
```


Git TREE identities — git object id (SHA-1 tree object), every byte under the named path at this commit. These are
complete: unlike the manifest digest, they reach native entry files and
imported fixtures. A squash that reports the same ids carries the same bytes.

| scope | git object id |
| --- | --- |
| commit tree | `3614eb42d120e20cf4ea4e02e755d7f9c532ab6d` |
| `src/` | `46fd05115fabf717ebd346291f47fbf0509ac1c5` |
| `tests/` | `8124d70eb2a462b16d2f12a134cc30ec7a4aa55d` |
| `scripts/` | `687dcf6f382314c9a95d1ffe70c3848f68278340` |
| `benchmarks/` | `63f383607dadd33c8a87a98e728d5a20b47a8baa` |

Config and lockfile digests — sha256 over the file's bytes in the working tree. A sha256 of a
file's bytes and a Git tree id are different algorithms over different
scopes; neither stands in for the other.

| file | sha256 |
| --- | --- |
| `package.json` | `2dd00d97b15fdd2ae20a4fa054bd1befa7fad7c8e18bb2331e7264d90e32961a` |
| `pnpm-lock.yaml` | `c366c9806e268e19970626c34e0c5ea1bb74cc7c24b388fa072d580d7bf9aceb` |
| `tsconfig.json` | `0354d544ad062405d302d19536d3fc9fe0cbac981c55eeb10969ed0086aac760` |
| `tsdown.config.ts` | `53ab155f1139a63ee4da90411e29a4c3ab456457eeb66fab1867d2e55df892db` |
| `biome.jsonc` | `97424db7945038373663f9c7d72fa214e7a1ebc4573cfedc792e47cc4e622f07` |
| `vitest.config.ts` | `a0e536a68dff32def4967d82dca0df1d61afc5f87961fcaab034117a5ed6fd15` |
| `vitest.workspace.ts` | `0a6ab889a7e618dde4c67c1512311ae62c6c3c668d65830346ef17f436ca454c` |
| `vitest.d1.config.ts` | `31235d754ecb015f14a276a46c361ce337aad13688e8bc3da83fd51b3a65379b` |

No retained review directory sits beside this checkpoint.

## 2. Harness identity

- test files a manifest names: 663
- harness identity: `7daded95c7a9e96e810c096c3da8e95cab3a2d726b1ec132574cbb58bce04264` (sha256 over the sorted (path, file sha256) pairs of every path a manifest names)

| manifest module | sha256 |
| --- | --- |
| `scripts/raptor3-manifest.mjs` | `0c5cbdf1f3c68304af2753ded37495c63f9e8a65658c6b1e8100587fe4e5a645` |
| `scripts/credential-free-test-manifest.mjs` | `99696bf1d759ea6fe6d63eacd125b5489731ffac0edcf431fb463d1b4df63d7a` |
| `scripts/client-test-manifest.mjs` | `428020660c3028dd2eb36ce722d9eb9e692c779a19fd0b154edb43c761a47a28` |
| `scripts/driver-test-manifest.mjs` | `2a027df21d54fd332332764646b6b9680faa888751583ad9b9281ecb8a5ca8e0` |
| `scripts/migration-test-manifest.mjs` | `28b01fa5f8b0bd45c3c151d7df456b903894660cbcbbba15a9b57fff60e28a5c` |
| `scripts/query-engine-test-manifest.mjs` | `bca818458f2bd9284d7836db3c6e83b57a96801b48b634ce0978654f7d9ed81a` |

## 3. Runtime and dependency identity
