# Retained performance changes: integration review

This PR packages the retained experiments against main `30ff17e69`. The earlier
engine allocation changes shipped in RC2 and are not counted again. Rejected
prototypes, profiles, copied dependencies and development notes remain outside
the PR. The original experiment worktree is preserved.

## Baseline identity

The previously reported **267 → 194 µs** is a historical paired comparison of
fresh schema/client construction plus the first `rows20` query. Its baseline
was `cold-construction-base`, after earlier warm-query work but before the six
construction changes. It was neither original main nor Drizzle. Its successor
was `cold-construction-v2`, whose built modules match `cold-construction-final`.

The later Drizzle relational-API comparison measured that already-optimized
VibORM build at about 163 µs. That separate observation is not the before arm
of the 267 → 194 comparison, nor evidence of another improvement. Different
run conditions and warmup/sample counts prevent subtracting the two reports.

The [historical raw pairs](historical-first-rows20.json) retain all ten relevant worker
samples, SQL/result witnesses, runtime and artifact hashes.
[Artifact identities](historical-final-identity.json) tie those measurements to
the retained source. Five pairs used 40 disposable warmups and 100 new clients
per worker; median worker means were 266.699 and 193.955 µs. Median paired
saving was 64.924 µs (24.343%). This excludes native connection opening and
imports, reuses loaded code/JIT state, and is not Cloudflare cold-isolate evidence.
These historical results are not a new main-versus-PR measurement.

## Implementation and ownership

- Share operation class methods at module lifetime while each handle owns its
  driver binding, admitted input, prepared read and cache codec.
- Compose validation entries directly through their existing owners; defer
  unused ordering and distinct branches with the existing lazy primitive.
- Publish successful identifier-domain derivation on the existing topology-keyed
  WeakMap. With no domain declarations, skip the unnecessary propagation graph.
- Keep one predicate visitor while SQL-only reads omit write dependency facts.
- Compile scalar codec choices once per returned batch. SQLite collection reads
  can borrow positional native rows and construct public objects once; eligibility
  checks and fallback retain the ordinary typed statement and parser contracts.
- Avoid unused folding, unique-key scans and pagination copies; compose alias SQL
  without an extra child fragment and omit an absent WHERE clause.

The nonempty WHERE construction deliberately remains unchanged: an earlier
dynamic-array rewrite regressed filtered reads. No query cache or client proxy
cache change is part of this PR. No production dependency or public API is added.

## Integration review and verification

Review preserves current main's instrumentation ownership, native-type maps,
insert-only timestamps and existing concurrent operation/cache isolation test.
Schema entry extraction retains eager invalid-path errors and declared-undefined
entries. Positional transport retains integer fidelity, provider field parsing,
statement transforms, error normalization, fresh results and keyed fallback.

Final checks and production line counts are recorded below when complete.

## Reproduction

Run the normal bounded package build in each checkout first. Use absolute build
paths, a pinned Node executable, and serialize all verification jobs.

```sh
node scripts/run-node-safe.mjs 768 600000 benchmarks/first-operation.mjs \
  --base-build-dir /absolute/base/dist \
  --candidate-build-dir /absolute/candidate/dist \
  --workloads rows20 --modes fresh-client --rounds 5 \
  --warmup 100 --samples 200 --output /absolute/first-operation.json
node scripts/run-node-safe.mjs 768 180000 benchmarks/engine-retention-soak.mjs \
  --build-dir /absolute/candidate/dist --lifecycle-only \
  --output /absolute/lifecycle.json
node scripts/run-node-safe.mjs 768 600000 benchmarks/better-drizzle-compare.mjs \
  --build-dir /absolute/candidate/dist --libraries viborm,drizzle \
  --drizzle-dir /absolute/pinned-drizzle-install \
  --workloads unique,filtered20,relation20,insert,rows20,rows1000 \
  --modes time,alloc --rounds 5 --time-scale 10 \
  --output /absolute/competitor.json
```

The maintained comparison uses Drizzle's relational reads, matching returned
fields and ordering (including `views DESC, id ASC`). Inserts use its write
builder. It reports the resolved package version and uses the same native SQLite
dependency. CPU, sampled JavaScript allocation and retained heap are separate
measurements; allocation is not RSS.

The [historical disposal diagnostic](historical-final-lifecycle.json) collected
all 5,000 sampled references after 1,000 disposable clients. Bounded successful
collection is not a universal leak-free guarantee. The previously reported
unknown-property proxy cache remains outside this engine optimization scope.
