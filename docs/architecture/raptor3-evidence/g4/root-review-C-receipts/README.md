# Root review — Area C receipts

Produced on the frozen tree (production
`e2d5bcb2201641372941c2c1fa6e648f52429fb3ca8ce948678baa80a31b589f`, harness
`838a1e1bb2080e863f5decb56ce90c5218da1e1a341532c21d5b0e04453bc6c5`), read-only.

| file | what it is |
| --- | --- |
| `public-surface.log` | C1 probe: the public entry's export list, `createClient` arity, a second argument installing no route, and the routed `QueryEngine.build` identity |
| `refusal-and-meta-parity.log` | C1/C4 probe: 23 admitted public requests on both routes; class, code, message, `meta` and committed rows compared |
| `decisions-recheck.log` | C2 probe: D-6 and R-D2 (a) re-checked with cells this review wrote |
| `refusal-census.txt` | every `throw` in `raptor3/**` whose sentence has no shipped text, with its class and whether it exists at `0cc61e61` |
| `throw-sites.json` | all 156 `throw` sites in `raptor3/**` |
| `refusals.json` / `unmatched.json` / `newness.json` | intermediate census data |
| `extract-throws.mjs`, `refusals2.mjs`, `newness.mjs`, `classify.mjs` | the census scripts, in the order they run |

The three probe files and their workspace are in
`../root-review-probes/C/`. They are outside `tests/` on purpose: the harness
fingerprint hashes `tests/raptor3`, `scripts` and `benchmarks`, and the tree is
frozen. `tsconfig.json` beside them shadows `docs/tsconfig.json` (an Astro
config Vite cannot resolve).

Reproduce:

```
node scripts/run-vitest-safe.mjs run \
  --workspace=docs/architecture/raptor3-evidence/g4/root-review-probes/C/review.workspace.ts \
  docs/architecture/raptor3-evidence/g4/root-review-probes/C
```
