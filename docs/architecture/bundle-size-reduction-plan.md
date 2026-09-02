# Bundle Size Reduction Plan

**Date:** 2026-09-01

**Status:** Proposed

**Scope:** Runtime import size, with no public query or schema-language change

## 1. Decision

VibORM will reduce the representative PostgreSQL client bundle through three
accepted changes:

1. replace the current entry-file size report with reproducible bundled consumer
   fixtures and hard raw/gzip budgets;
2. preserve `s.string().cuid()` while replacing CUID2's `bignumber.js` byte-to-base36
   conversion with native `BigInt`;
3. make the official cache runtime reachable only when the application imports and
   installs `cache()`.

The public schema surface remains the cohesive aggregate `s` API. This plan does
**not** ask users to import `model`, `string`, or each scalar separately. The current
aggregate is defined in [`src/schema/index.ts`](../../src/schema/index.ts) and exposed
through [`src/schema/exports.ts`](../../src/schema/exports.ts); both remain the normal
authoring path.

The current representative `viborm/pg` bundle is **956,782 raw bytes and 270,809
gzip bytes**. The accepted dependency/reachability work targets **at most 925,000 raw
bytes and 258,000 gzip bytes** for the same fixture. The expected result is about
255 KB gzip: approximately 8.7 KB leaves with `bignumber.js`, and complete cache
detachment measured a ceiling of about 7.0 KB. The 258 KB gate leaves room for
compression interaction without letting a codec-only cache move masquerade as
complete detachment.

Raptor 3 then targets the relation-aware write kernel without removing its public
capability. The 2026-09-01 diagnosis in
[raptor3-restructuring-plan.md](./raptor3-restructuring-plan.md) re-measured this
section's original estimate and found it roughly 2× too high: the corrected base case
removes about **3,000 physical lines, 2,240 parser token-lines, 25 KB minified, and
6.1 KB gzip**; the behavior-preserving stretch ceiling is about **4,800 physical
lines, 3,600 token-lines, 40 KB minified, and 9.7 KB gzip** (an adversarial floor of
4.4 KB gzip base). Applied after the expected A-C result, those estimates put the full
PostgreSQL fixture near **249 KB gzip** in the base case and **245 KB gzip** at
stretch. Raptor 3's value is structural (three verb tables instead of six, no
decision-free re-switches, no shadow interpreter, no duplicate compiler, no temporal
compile outputs); its byte result is about 2% of the fixture and must be reported and
ratcheted, not promised. They are prototype targets, not release budgets, until a
retained vertical slice measures the real compression interaction.

This is one staged reduction program, not a claim that 258 KB is the final acceptable
size. Phases A-C remove dependency and reachability weight; Phase D is the
behavior-preserving Raptor 3 structural program. It does not pre-authorize a public
feature split, a read-only client, or a second import style.

## 2. Goal, constraints, and done condition

### 2.1 Goal

Lower the bytes a normal PostgreSQL user imports while preserving this spelling:

```ts
import { s } from "viborm";
import { createClient } from "viborm/pg";

const user = s.model({
  id: s.string().id(),
  name: s.string(),
});

export const db = createClient({
  schema: { user },
  databaseUrl: "postgres://localhost/viborm_bundle_probe",
});
```

The measurement must include everything a consumer bundler retains from those public
imports. Measuring the `dist/pg.mjs` path configured in
[`package.json`](../../package.json) by itself is not evidence of that cost.

### 2.2 Constraints

1. Preserve the aggregate `s` API. No per-scalar import requirement and no generated
   schema client.
2. Preserve the Node 22 runtime floor declared in [`package.json`](../../package.json).
3. Preserve `s.string().cuid()` output, prefix, default-factory, schema-JSON, and
   Worker request-context behavior owned by
   [`StringScalar`](../../src/schema/scalars/string/scalar.ts) and its current tests.
4. Preserve the six-capability extension chain and the authenticated official-cache
   extension described in [`AGENTS.md`](../../AGENTS.md) and
   [`src/cache/AGENTS.md`](../../src/cache/AGENTS.md). Do not add a plugin registry,
   priority layer, or public cache token.
5. Preserve cache key identity, result detachment, malformed-snapshot refusal,
   Decimal reconstruction, SWR, invalidation timing, interception order, and protected
   instrumentation.
6. Count every emitted JavaScript chunk. Moving code behind `import()` does not reduce
   deployed bytes and must not make the gate green.
7. Keep `sideEffects: false`; the current package already declares it in
   [`package.json`](../../package.json), and controlled measurement found no hidden
   side-effect retention.
8. Follow [`ELEGANCE.md`](../../ELEGANCE.md): delete or relocate a second semantic
   owner before adding an abstraction. A smaller file or shorter spelling is not a
   result by itself.

### 2.3 Done when

The program is complete only when:

- after `package:build`, `pnpm size` bundles the tracked consumer fixtures, totals
  every emitted JavaScript file, and enforces raw and gzip budgets;
- the ordinary PostgreSQL fixture is at or below 925,000 raw bytes and 258,000 gzip
  bytes;
- the same fixture with `pg` external is at or below 842,000 raw bytes and 232,000
  gzip bytes;
- an ordinary client has no runtime import path to the cache driver, cache schemas,
  cache result codecs, cache key implementation, or cache instrumentation;
- a client extended with `cache()` retains the complete cache behavior and does not
  duplicate the core query/result machinery;
- `bignumber.js` and the production `@paralleldrive/cuid2` package are absent from the
  ordinary consumer bundle;
- `s.string().cuid()` remains byte-compatible with the CUID2 algorithm under a
  deterministic oracle and retains every public behavior test;
- all focused and final validation gates in Section 10 pass;
- the applicable architecture guides describe the new owners and the previous import
  paths no longer coexist.

Raptor 3 has an additional completion condition: every migrated relation verb is
dispatched once into an existing executable `Part`, OwnWrite facts come from that same
fold, and the mirrored mutation/plan plus shadow traversal have disappeared. The base
program aims to remove about 3,000 physical lines and 6.1 KB gzip (corrected in
[raptor3-restructuring-plan.md](./raptor3-restructuring-plan.md) §7). If the retained
units do not approach that overlap-adjusted target, record the measured rejection and
re-scope the architecture; do not declare a file reshuffle to be Raptor 3.

## 3. Measured baseline

### 3.1 Reproduction protocol

The 2026-09-01 diagnosis used:

- the public aggregate `s` and public `viborm/pg` client;
- the one-model fixture in Section 2.1;
- Node 22 target semantics;
- esbuild 0.25.4;
- ESM, minification, and tree shaking;
- one non-splitting output for the primary measurement;
- gzip level 9 over the emitted JavaScript bytes.

The CUID dependency audit read the installed
`node_modules/@paralleldrive/cuid2/src/index.js` resolved by
[`pnpm-lock.yaml`](../../pnpm-lock.yaml): version 3.3.0 imports
`bignumber.js` for `bufToBigInt`, imports SHA3-512 from `@noble/hashes`, and uses
the converted integer only for its base-36 hash text. Phase B pins that finding with
a compatibility oracle before removing the production dependency.

The permanent gate created by Phase A becomes the owner of this protocol. Until that
gate exists, these numbers are diagnostic evidence rather than a reproducible release
contract.

| Fixture | Raw bytes | Gzip bytes | What it answers |
|---|---:|---:|---|
| public `s` + one model + `viborm/pg`, including `pg` | 956,782 | 270,809 | user-visible import cost |
| same fixture with `pg` external | 873,510 | 245,019 | VibORM-owned runtime signal |
| `createClient` re-export only | 928,044 | 264,150 | cost retained before a schema exists |
| empty-schema client | 928,097 | 264,190 | schema specialization is not occurring |
| one-table client | 956,782 | 270,809 | one small schema adds only about 6.6 KB gzip |

The last three rows are an attribution tool, not evidence that reachable runtime is
waste. A representative full-client user needs the query and write engine after the
schema is declared, so the fact that `createClient` already reaches it is not itself an
optimization target. The rows show only that schema declaration does not specialize
the runtime and let later experiments isolate subsystem weight. Every proposal below
must therefore identify unnecessary owners, representations, or passes while the full
public capability remains fixed. Importing from the root versus `viborm/schema`
changed the controlled result by only 37 gzip bytes, so barrel routing is not the
problem.

### 3.2 The current size gate measures the wrong object

[`package.json`](../../package.json) configures `size-limit` with the file plugin,
disables gzip and Brotli, and points the PostgreSQL row at `dist/pg.mjs`. That file is
only an entry module. It does not include the chunks and dependencies a consumer
bundler follows. The release flow in [`scripts/release.mjs`](../../scripts/release.mjs)
runs this report after `package:build`, so the false 5.09 KB result currently reaches
the release gate.

Controlled packaging experiments also ruled out a large build-configuration win:

| Experiment | Gzip change |
|---|---:|
| bundle directly from TypeScript instead of published `dist` | +1,527 B |
| disable output splitting | +41 B |
| build only `pg` and schema entries | -689 B |
| disable shims | 0 B |
| ignore tree-shaking annotations | +209 B |

The 500 KB published `pending-operation` chunk is real runtime code. It contains 147
runtime modules, including 43 write-engine modules, 39 builders, 20 result modules,
and 19 operation modules. [`pending-operation.ts`](../../src/query-engine/pending-operation.ts)
and [`routing.ts`](../../src/query-engine/write-engine/routing.ts) synchronously reach
that complete operation language.

### 3.3 Accepted byte targets

Controlled dependency stubs establish ceilings, not promises:

| Candidate | Raw ceiling | Gzip ceiling | Source of reachability |
|---|---:|---:|---|
| remove only `bignumber.js` from CUID2 | 19,089 B | 8,572 B | [`autogenerate.ts`](../../src/schema/scalars/string/autogenerate.ts) |
| remove all of CUID2 | 24,941 B | 11,042 B | same static import |
| remove current `src/cache` runtime | 11,663 B | 4,009 B | client/cache flow and official capability |
| detach shape-compiled cache result machinery | about 11,700 B | about 3,800 B | [`cache-result-codec.ts`](../../src/query-engine/result/cache-result-codec.ts) and its value codecs |
| remove all currently reachable cache-named runtime modules | about 19,400 B | about 7,000 B | complete capability inversion across client, query engine, codecs, and instrumentation |

The accepted CUID work deliberately keeps SHA3 and CUID2 semantics, so the 8.6 KB
`bignumber.js` ceiling is the relevant target. Cache measurements overlap; they must
not be added together. The complete Phase C inversion targets the 7.0 KB ceiling;
the 3.8 KB codec result is its lower bound, not its completion condition.

## 4. Elegance and the large query engine

### 4.1 Verdict

The previous verdict was too charitable. `ELEGANCE.md` is not the cause of the size,
but the write engine does not currently apply it at the correct granularity.

The failure is **coarse ownership**. A class or file was counted as one owner because
it had one architecture name, while several independent protocols continued inside
it. Phase-specific unions were discounted as representations rather than concepts,
even when the next phase switched on the same discriminant again. The result is few
nouns on the architecture diagram and too many decisions hidden inside those nouns.

The live census from
[`scripts/query-engine-structure.mjs`](../../scripts/query-engine-structure.mjs) is:

| Measure | Query engine | Write engine |
|---|---:|---:|
| TypeScript files | 146 | 43 |
| physical lines | 60,209 | 34,075 |
| token-bearing lines | 45,965 | 25,907 |
| measured functions | 2,383 | 1,318 |
| branch nodes | 5,252 | 2,651 |
| files over 600 lines | 20 | 12 |
| runtime import-cycle components | 1 | 0 |

The deeper 51-file parser/OwnWrite/write audit produced these additional static
signals. They are review triggers, not claims that every counted line is deletable:

| Signal | Measured result |
|---|---:|
| functions with at least five parameters | 95 |
| functions with at least three forwarding-only parameters | 118 |
| classes / class fields / class methods | 33 / 284 / 487 |
| private methods with at most one direct internal call | 203 |
| fields read by only one method | 94 |
| constructors over 100 lines | 7 |
| discriminated unions / switches | 34 / 28 |
| high-similarity switch pairs | 84 |

The decisive evidence is not any one count. It is the same semantic axis recurring
across them:

1. **Phase amplification.** The eleven-arm
   [`RelationMutationEntry`](../../src/query-engine/builders/relation-mutation-parser.ts)
   becomes a twelve-arm `JunctionMutation`, then a twelve-arm `JunctionPlan`.
   [`RelationJunctionPart.ts`](../../src/query-engine/write-engine/RelationJunctionPart.ts)
   switches over that family five times—55 cases—for construction, allocation,
   membership sites, planning, and compilation. Across the related parser, OwnWrite,
   and write routes, 18 switches carry 161 case labels. Each phase republishes the
   decision instead of discharging it.
2. **Mega-owners.** `RecordUpdateCompilerState` is about 4,645 class lines with 34
   fields and 79 methods. Its thirteen-field relation-work bag, including five mutable
   output collections, reaches about 20 methods. `CreateOperation` is about 3,402 class
   lines with 23 fields and 59 methods. These are not one cohesive responsibility merely
   because each compiles one record.
3. **Modeful construction.** [`SubOperationOptions`](../../src/query-engine/write-engine/shared.ts)
   makes `CreateOperation` serve four roles: public create shell, nested fresh record,
   root `createMany` member, and upsert create arm. The bag is not discriminated;
   invalid combinations are representable, constructor precedence selects a mode,
   and `UpdateOperation` accepts unrelated fields it ignores.
4. **Hidden compile outputs.** `RecordUpdateCompiler.compile()` returns only steps but
   mutates `compiledFinalFieldValues`, `compiledSelectedRowKey`, and
   `relationTransitionFinal`. Callers must compile first and then call
   `updatedFieldValue()` or `updatedPrimaryKeyWhere()`. The instance is an
   order-sensitive scratchpad because the semantic compile result is missing from the
   type.
5. **Missing lifetime ownership.** `StepScope` is only an ID allocator, while
   `engine`, `scope`, `txMode`, and `recordCompilers` are threaded through the recursive
   relation tree. `txMode` alone appears 208 times on 194 lines, even though
   `selectExecutionMode(engine, operation)` ignores `operation` and derives one fixed
   driver fact. Renaming this group `Context` would hide the cascade, not fix it.
6. **A shadow compiler.** `OwnWriteAnalyzer`, `OwnWriteLedger`, `OwnWriteRelation`, and
   `OwnWriteSteps` total 1,868 physical lines. The ledger enforces a real invariant,
   but `OwnWriteSteps` is a second recursive interpreter of all eleven public verbs and
   reparses nested programs. The executable relation lowering should publish the same
   read/write footprints to that ledger; a second verb traversal should not survive.
7. **A weak trusted value.** `RecordMutationData` remains a generic
   `parsed/source` pair and `RelationMutationEntry` keeps plural arrays even on to-one
   paths. There are 30 direct `[0]` reads of entry/program arrays and 93 internal
   query-engine refusal sites in the audited path; at least 38 explicitly restate
   parse-boundary facts such as “one item”, “correlated target”, or “this verb is
   admitted.” This is evidence that validation produced data but not the exact trusted
   domain value downstream code needs.
8. **A missing composition seam.** Fresh-record emission already has before-root,
   root-write, and after-root phases, but exposes a flat `FreshRecordPart`. To place a
   junction insert between target creation and descendants, the engine therefore keeps
   the 808-line [`nested-target-parts.ts`](../../src/query-engine/write-engine/nested-target-parts.ts)
   restricted compiler beside the full fresh compiler. A staged fresh-record result can
   preserve both existing statement orders while deleting the second compiler.
9. **A missing execution session.** Progressive execution passes 8-13 parameters
   through five recursive levels. This is a real per-run lifetime with progress,
   visibility, path, commit, and notification invariants. It belongs in a behavioral
   execution session, not in positional forwarding or an inert context bag. This
   affects total code cohesion but is not the main cause of the isolated 79 KB write
   delta because the executor is already reachable in the read baseline.

The class form also has a measurable emitted-code tax. TypeScript `private` methods
and fields remain property names after esbuild minification. A throwaway, unwired
`CreateManyOperation` spike kept the same local algorithm and measured:

| Shape | token-bearing lines | minified raw | gzip |
|---|---:|---:|---:|
| current class | 197 | 2,716 B | 1,093 B |
| class with one repeated procedure extracted | 127 | 2,333 B | 1,023 B |
| closure factory with the repeated procedure retained | 133 | 2,104 B | 971 B |
| closure factory with one local procedure | 113 | 1,757 B | 926 B |

This prototype was not wired into tests, so it proves emitted syntax and state-shape
cost, not semantic equivalence. It rejects a blanket “classes are free” assumption,
but it also rejects a blanket method-inlining program: one-use methods are symptoms of
phase mixing, not thousands of automatically deletable lines.

Copy/paste and comments are not the root cause. Weak clone scanning found about 1-2%
mechanical duplication, and comments inflate physical LOC without entering the
bundle. External packages are also excluded from the controlled 79 KB relation-write
delta. The credible behavior-preserving prize is the overlap-adjusted Raptor 3 model
below. Deleting the full 79 KB would still require a product capability reduction;
that is not the goal of this lane.

| Scenario | Physical LOC removed | Parser token-lines removed | Minified raw removed | Gzip removed |
|---|---:|---:|---:|---:|
| low | about 1,500 | about 1,130 | about 13 KB | about 3.2 KB |
| **base commitment** | **about 3,000** | **about 2,240** | **about 25 KB** | **about 6.1 KB** |
| stretch ceiling | about 4,800 | about 3,600 | about 40 KB | about 9.7 KB |

These figures replace the original 5,350 / 4,300 / 51.3 KB / 12.2 KB base and
7,450 / 5,980 / 73.7 KB / 19.1 KB stretch, which the 2026-09-01 diagnosis
([raptor3-restructuring-plan.md](./raptor3-restructuring-plan.md) §2.4, §7) showed to
price erased type unions and pure dispatch at the file-average density (they minify at
0.02 and about 2 gzip bytes per token-line) and to claim more deletion in the OwnWrite
and junction zones than those zones contain. The model partitions existing source into
non-overlapping ownership zones and prices the replacement code. A claim above about
10 KB gzip is unsupported unless the public behavior is reduced.

### 4.2 External design evidence

Three parallel Exa workstreams screened 227 result slots across 15 search angles. The
retained primary sources and the complete synthesis are in
[`exa-results/raptor3-code-reduction-2026-09-01.md`](../../exa-results/raptor3-code-reduction-2026-09-01.md).
They converge on five rules:

1. **Eliminate private producer-consumer carriers.** Deforestation and stream fusion
   remove an intermediate value when its sole purpose is to connect one producer to
   one consumer. `JunctionMutation` and `JunctionPlan` fit that test.
2. **Fuse the walk, not unrelated responsibilities.** Dotty's miniphases show that
   distinct transforms can retain separate logic while sharing one legal traversal.
   Executable lowering and OwnWrite remain separate responsibilities, but one relation
   walk can produce both results.
3. **Make the old vocabulary illegal.** MLIR dialect conversion treats successful
   lowering as the absence of illegal source operations. After VibORM lowers a relation
   entry, the public verb and its mirrored plan forms must no longer exist.
4. **Keep changing values out of the lifetime owner.** rustc queries, rustc MIR's
   explicit `BlockAnd<T>` result, GraphQL.js execution, and Go context guidance all
   separate stable operation services from the current semantic input and cursor.
5. **Dispatch the public operation once.** Prisma's nested-write builder chooses the
   verb handler once and creates executable graph behavior. VibORM should take that
   dispatch rule without taking Prisma's general graph or adding a generic write AST.

The direct consequence is that a god parameter is not the reduction. Outside the
larger owners it could remove only about 183 parser-owned propagation lines before
paying for its replacement. A behavioral `WriteCompilation` earns its place because
it enables the producer-consumer fusion and removes contradictory state, not because
`frame.foo` is shorter than positional arguments.

### 4.3 Where the accepted byte work improves elegance

The cache boundary is the clearest ownership mismatch in the accepted A-C byte work.
The cache guide says the cache layer owns detached snapshots and orchestration, yet
[`client.ts`](../../src/client/client.ts),
[`cache-flow.ts`](../../src/query-engine/cache-flow.ts),
[`ReadOperation.ts`](../../src/query-engine/write-engine/ReadOperation.ts), and
[`execution-context.ts`](../../src/query-engine/execution-context.ts) make ordinary
clients import that implementation. Phase C makes the already declared L10 owner also
own runtime reachability. This reduces both bundle size and the number of places that
know cache implementation details.

The CUID change is different. It is a deliberate byte/ownership trade: VibORM will own
a small CUID2-compatible implementation instead of importing a general arbitrary-
precision library for one exact integer conversion. It may not reduce source lines.
Its success criterion is smaller runtime bytes with one algorithm owner and stronger
compatibility evidence, not a LOC claim.

Phase D is a separate structural correction. It does not treat a class name as proof of
one owner. It admits a new owner only when a real lifetime or result is currently
missing, and only when the owner deletes an options mode, parameter cascade, mirrored
representation, shadow interpreter, or second compiler.

## 5. Elegance ledger for the accepted architecture

| Necessary truth | Sole owner after the plan | What disappears |
|---|---|---|
| representative consumer import cost | `scripts/check-bundle-size.mjs` plus tracked fixtures | entry-file-only size claims |
| CUID2 generation used by `StringScalar` | `src/schema/scalars/string/cuid2.ts` | production CUID2 and `bignumber.js` runtime dependencies |
| official-cache identity and admission | one dependency-light private capability bridge | heavy cache imports from generic extension admission |
| cache config, scope, storage, snapshot, SWR, and invalidation | `src/cache/**` | query-engine-owned cache flow and result codecs |
| ordinary read result parsing | existing query/result owners | cache-specific methods on `ReadOperation` |
| borrowed result transport for a cache-managed read | existing query executor ownership | cache implementation knowledge in the executor |

The capability bridge earns its place only if it replaces the existing cache WeakMap
registries and heavy imports. It must not coexist with the current
`getOfficialCache*` path or become a general optional-service registry.

## 6. Phase A — Make import size a release invariant

### 6.1 Add tracked public fixtures

Add package fixtures under `tests/package/fixtures/bundle-size/`:

1. `pg-one-model.mjs`: the exact aggregate-`s` fixture in Section 2.1;
2. `pg-one-model-cache.mjs`: the same client extended with `cache()` and
   `MemoryCache` from their existing public subpaths.

Do not add a named-scalar fixture. The accepted public behavior is the aggregate.

### 6.2 Replace the file-size runner

Add `scripts/check-bundle-size.mjs` and make `pnpm size` call it after
`package:build`.

The script must:

1. use an exact direct development dependency on the selected bundler rather than a
   transitive Wrangler dependency;
2. bundle from the built public package exports, not internal source aliases;
3. target Node 22, ESM, minification, and tree shaking;
4. run the ordinary fixture twice: once with all runtime dependencies and once with
   `pg` external;
5. bundle the cache-enabled fixture with the same settings;
6. sum raw bytes for every emitted JavaScript output;
7. gzip each emitted JavaScript output with one deterministic `gzipSync` configuration
   and sum those compressed byte counts;
8. fail with the fixture name, actual bytes, budget bytes, and delta;
9. optionally write an esbuild metafile for `pnpm size:why`, without opening a browser
   during release;
10. clean its temporary directory in success and failure paths.

If output splitting is enabled later, every chunk remains in the total. A dynamic
import is a loading-policy change, not a size reduction.

### 6.3 Introduce then ratchet budgets

| Gate stage | Full PG raw | Full PG gzip | `pg` external raw | `pg` external gzip |
|---|---:|---:|---:|---:|
| Phase A baseline ceiling | 960,000 | 273,000 | 877,000 | 247,000 |
| after Phase B | 940,000 | 264,000 | 858,000 | 239,000 |
| after Phase C | **925,000** | **258,000** | **842,000** | **232,000** |

Phase A must record the cache-enabled fixture's actual raw and gzip baseline before
code moves. Phase C may not increase either value by more than 1,000 bytes. This
prevents “ordinary clients got smaller” from hiding duplicated cache-user code.

Budgets live in one machine-readable object owned by the runner. Do not duplicate
them in `package.json`, a test, and the script. This plan records the decision; the
runner becomes the executable source.

### 6.4 Falsifiers

- Add 20 KB of reachable code to `pg-one-model.mjs`: `pnpm size` must fail.
- Emit a second dynamic chunk: its bytes must enter the total.
- Externalize `pg` only in the isolation leg: the full leg must still include it.
- Import an internal source module from the fixture: the package test must fail because
  the fixture must enter through public exports.
- Run the release artifact path: it must execute the same budget owner, not a second
  size command.

## 7. Phase B — Remove `bignumber.js` without changing CUID2

### 7.1 Necessary truth

[`autogenerate.ts`](../../src/schema/scalars/string/autogenerate.ts) statically imports
`@paralleldrive/cuid2`. The installed CUID2 3.3.0 implementation uses
`bignumber.js` only to fold a SHA3-512 byte sequence into a non-negative integer and
render it in base 36. Native `BigInt` represents that integer exactly on every runtime
VibORM supports.

The public truth is not “VibORM depends on CUID2.” It is that `.cuid()` produces the
same CUID2 identifier behavior. Therefore the scalar/string domain is the rightful
owner.

### 7.2 Implementation unit

1. Add one private `src/schema/scalars/string/cuid2.ts` implementation adapted from
   the installed MIT-licensed CUID2 algorithm, with source and license attribution.
2. Preserve its lazy singleton generator. It must not access Web Crypto while the
   module is collected; the existing D1 witness depends on request-context generation.
3. Preserve CUID2's SHA3-512 input, entropy construction, initial counter range,
   fingerprint, first-letter rule, 24-character default length, and base-36 slicing.
4. Replace only the arbitrary-precision byte accumulator with:
   `value = (value << 8n) + BigInt(byte)`.
5. Keep `defaultCuid(prefix)` in `autogenerate.ts` as the scalar-facing wrapper. No
   new public function or generator strategy is introduced.
6. Add `@noble/hashes` as the direct production dependency that owns SHA3. Move
   `@paralleldrive/cuid2` to development dependencies as the compatibility oracle, or
   remove it entirely after fixed oracle vectors are independently pinned. It must not
   remain a production dependency.
7. Remove `@paralleldrive/cuid2` from the package build external list and add the new
   direct SHA3 dependency where the build's dependency-identity rule requires it.

### 7.3 Behavioral falsifiers

Add a deterministic compatibility test that freezes `Date.now`, supplies a fixed
random sequence, counter, and fingerprint, and compares several generated identifiers
byte-for-byte with `@paralleldrive/cuid2.init`. Cover counter advancement and at least
one high-byte hash whose base-36 conversion would expose a precision loss.

Retain and strengthen:

- [`string-scalar-schemas.core.test.ts`](../../tests/unit/scalars/string-scalar-schemas.core.test.ts):
  optional create input and generated value;
- [`modifier-contracts.core.test.ts`](../../tests/unit/scalars/modifier-contracts.core.test.ts):
  prefixed and unprefixed defaults;
- [`format.core.test.ts`](../../tests/unit/schema-json/format.core.test.ts) and
  [`serialize.core.test.ts`](../../tests/unit/schema-json/serialize.core.test.ts):
  `{ kind: "cuid" }` metadata;
- [`d1.test.ts`](../../tests/providers/workers/d1.test.ts): generation occurs inside
  the Worker request context and matches `/^[a-z][0-9a-z]{23}$/`;
- generator-default identity: a user function default must not become an official
  generated default.

The bundle falsifier is structural as well as numerical: the esbuild metafile for the
ordinary fixture must contain neither `bignumber.js` nor production
`@paralleldrive/cuid2` inputs. Phase B then ratchets the budgets in Section 6.3.

## 8. Phase C — Make cache runtime truly optional

### 8.1 Necessary truth

An ordinary extension chain needs to know only whether it carries the authenticated
official cache capability. It does not need cache configuration parsing, cache drivers,
key encoding, SWR, result snapshot codecs, or cache instrumentation.

Today the dependency direction is reversed:

```text
ordinary client / generic extension chain / query engine
                         │
                         ├── cache extension implementation
                         ├── cache flow and driver
                         └── cache result codecs and instrumentation
```

The target is:

```text
ordinary client / generic extension chain
                         │
                         └── tiny authenticated cache capability bridge
                                                ▲
                                                │ registers callbacks
                                         cache() implementation
                                                │
                                                ├── cache flow and driver
                                                ├── result snapshot codecs
                                                └── cache instrumentation
```

This uses synchronous module reachability. It does not add a runtime dynamic import
and therefore does not change Promise timing, cold-cache behavior, or transaction
preparation.

### 8.2 Unit C1 — Extract the dependency-light admission bridge

Create one private cache capability module that:

- imports no cache driver, key, schema, validation, result codec, or instrumentation
  implementation at runtime;
- owns the existing query-function, definition-chain, and bound-chain WeakMap facts;
- authenticates by module-private identity exactly as today;
- carries the callbacks supplied by `cache()` for binding and execution;
- replaces the current registries in
  [`cache/extension.ts`](../../src/cache/extension.ts) rather than adding parallel
  registries.

[`extensions/chain.ts`](../../src/extensions/chain.ts) and
[`client.ts`](../../src/client/client.ts) may import this bridge. They may not import
the heavy cache extension or flow directly.

The bridge is not a generic service locator. Its exact purpose is the one official
cache definition already admitted by the extension chain.

### 8.3 Unit C2 — Move cache implementation to its declared owner

Move these responsibilities under `src/cache/`:

- hostile cache-option parsing and mutation-option stripping from
  [`query-engine/cache-flow.ts`](../../src/query-engine/cache-flow.ts);
- cached read execution and manual/mutation invalidation;
- the shape-compiled snapshot/materialization code currently in
  [`query-engine/result/cache-result-codec.ts`](../../src/query-engine/result/cache-result-codec.ts),
  `cache-value-codecs.ts`, and `cache-json-codec.ts`;
- cache-specific protected instrumentation currently imported by
  [`query-engine/execution-context.ts`](../../src/query-engine/execution-context.ts).

These moves follow the ownership already stated in
[`src/cache/AGENTS.md`](../../src/cache/AGENTS.md). They do not create a generic
serializer. Cache materialization remains shape-directed and continues to share the
normal result owner's scalar/aggregate classification.

### 8.4 Unit C3 — Remove cache-specific construction from read operations

[`ReadOperation`](../../src/query-engine/write-engine/ReadOperation.ts) already owns
the normalized operation, validated arguments, and expected result shape. It should
expose only the existing core read facts needed by a cache capability. Remove
`createCacheResultCodec()` and the cached codec field from the operation itself.

The cache capability compiles its codec from a read descriptor containing the existing
model, normalized operation, requested operation, and expected shape. This descriptor
is a view of existing facts, not a second result representation. It must not copy or
reinterpret selection meaning.

Remove `createRoutedCacheResultCodec()` from
[`routing.ts`](../../src/query-engine/write-engine/routing.ts). Pending-operation cache
access returns the trusted read facts; the bound cache capability creates and owns the
codec.

### 8.5 Unit C4 — Remove remaining heavy core imports

1. Make the client call methods carried by the bound official cache capability instead
   of statically importing `query-engine/cache-flow.ts`.
2. Replace `pending-operation.ts`'s import of `isCacheManagedExecution` with the core
   execution fact it already stores. Do not retain a cache module for a one-line
   `options?.skipSpan === true` predicate.
3. Let protected instrumentation obtain cache completion presentation through the
   bound capability. Ordinary instrumentation must not import cache instrumentation.
4. Keep the cache-managed borrowed-result executor rule. Renaming or relocating that
   small core execution fact is allowed only if it deletes cache implementation
   knowledge; do not add a second executor protocol.
5. Update [`src/cache/AGENTS.md`](../../src/cache/AGENTS.md), the root
   [`AGENTS.md`](../../AGENTS.md), and architecture census tests in the implementation
   commit so they name the new owners.

### 8.6 Cache falsifiers

The existing cache contracts are the behavioral gate:

- [`official-cache-extension.core.test.ts`](../../tests/contracts/public-client/official-cache-extension.core.test.ts):
  only an exact derived client gains `$withCache` and `$invalidate`;
- [`official-cache-reads.test.ts`](../../tests/contracts/public-client/official-cache-reads.test.ts):
  fresh detached graphs, malformed snapshots, and deliberate bypasses;
- [`cache-result-codec.core.test.ts`](../../tests/contracts/engine/query/cache-result-codec.core.test.ts)
  and [`cache-result-codec-boundaries.core.test.ts`](../../tests/contracts/engine/query/cache-result-codec-boundaries.core.test.ts):
  exact shape and hostile snapshot boundaries;
- [`decimal-cache-identity.core.test.ts`](../../tests/contracts/engine/query/decimal-cache-identity.core.test.ts):
  canonical private text and a fresh public Decimal per hit;
- [`official-cache-swr.core.test.ts`](../../tests/contracts/public-client/official-cache-swr.core.test.ts):
  stale return, one inner replay, scheduling, and cleanup failure ownership;
- [`official-cache-invalidation.test.ts`](../../tests/contracts/public-client/official-cache-invalidation.test.ts):
  commit/savepoint timing and exact target validation;
- [`official-cache-instrumentation.core.test.ts`](../../tests/contracts/public-client/official-cache-instrumentation.core.test.ts)
  and [`protected-cache-observers.core.test.ts`](../../tests/contracts/public-client/protected-cache-observers.core.test.ts):
  disclosure, ordering, and failure containment.

Add a static import census that fails if an ordinary core module imports any heavy
cache implementation. Add its own self-falsifier. A type-only import is allowed only
when emitted JavaScript and the public bundle prove it disappears.

The two bundle fixtures provide the reachability falsifiers:

- the ordinary fixture must omit cache driver, key, schema, codec, and instrumentation
  runtime inputs and meet the final budgets;
- the cache-enabled fixture must retain them, stay within 1,000 bytes of its Phase A
  baseline, and pass the full behavior suite.

## 9. Phase D — Raptor 3 structural compression

This is the Raptor 3 program. It is not permission for a wholesale rewrite: each unit
is a bounded, deletion-gated prototype. Phases A-C may ship independently, but this
plan's structural diagnosis is not closed until D1-D6 have each produced a retained
deletion or a measured rejection record. Cosmetic file splitting does not count as an
outcome.

### 9.1 Refresh the live responsibility census

Run [`scripts/query-engine-structure.mjs`](../../scripts/query-engine-structure.mjs)
and record physical lines, token-bearing lines, functions, high-parameter functions,
branch nodes, import cycles, and minified/gzip attribution after Phases A-C.

For each large owner, write a responsibility ledger before editing:

| Owner | Current physical lines | Current JS signal | Question to falsify |
|---|---:|---:|---|
| [`RecordUpdateCompiler.ts`](../../src/query-engine/write-engine/RecordUpdateCompiler.ts) | 5,803 | about 53.2 KB minified in bundle attribution | can an explicit selected-record result replace the scratchpad, and can one locator replace parallel ordinary/polymorphic arms? |
| [`CreateOperation.ts`](../../src/query-engine/write-engine/CreateOperation.ts) | 4,315 | about 38.0 KB minified in bundle attribution | can a fresh-record compiler delete all four constructor modes while leaving the public shell small? |
| [`RelationJunctionPart.ts`](../../src/query-engine/write-engine/RelationJunctionPart.ts) | 3,461 | about 32.4 KB minified in bundle attribution | can one construction-time specialization delete the mirrored input/plan unions and repeated dispatches? |
| OwnWrite subsystem | 1,868 | about 20.0 KB minified source-only, non-additive | can the executable lowering emit footprints and delete the second verb interpreter while retaining the ledger? |
| [`nested-target-parts.ts`](../../src/query-engine/write-engine/nested-target-parts.ts) | 808 | about 9.2 KB minified source-only, non-additive | can a staged fresh-record result preserve the junction insertion seam and delete the restricted compiler? |
| [`OperationExecutor.ts`](../../src/query-engine/write-engine/OperationExecutor.ts) | 3,315 | about 27.8 KB minified in bundle attribution | can a per-run progressive session remove the recursive parameter cascade without weakening execute -> proof -> parse? |

Do not use those line counts as automatic split thresholds. A file move can improve
navigability while changing bundle size by zero.

The Raptor 3 estimate uses these non-overlapping zones. New replacement code is
already deducted from each range; a line can belong to only one zone.

| Zone | Exact current denominator | Base net deletion | Base gzip estimate |
|---|---:|---:|---:|
| direct verb to executable Part | 7,962 physical / 6,494 token-lines | 450 token-lines | 1.1 KB |
| OwnWrite product fusion | 1,868 physical / 1,619 token-lines | 250 token-lines | 0.7 KB |
| staged fresh emission (incl. the inline-target machinery and `nestedBuilder` closures it deletes in other files) | 808 physical / 699 token-lines (+ about 300 token-lines elsewhere) | 450 token-lines | 1.45 KB |
| shared fresh/selected lowering and explicit products (locator union, exact to-one product, shells, compile products) | 10,118 physical / 7,563 token-lines | 870 token-lines | 2.7 KB |
| residual `WriteCompilation` propagation | 271 vanishing lines of 900 measured | 150 token-lines | 0.12 KB |
| progressive execution lifetime | 1,286 physical / 1,179 token-lines | 70 token-lines | 0.04 KB |

The denominators reproduce; the original deletion figures did not (the OwnWrite zone
claimed 800 net from a 663-line deletable file; the direct-lowering zone claimed more
than its entire switch, union and `txMode` inventory before replacement). The
line-range zones and overlap rules that produce the corrected column are in
[raptor3-restructuring-plan.md](./raptor3-restructuring-plan.md) §7. This accounting
still corrects the tempting but false parameter-cascade estimate: the stable bag is
re-spelled 911 times, mostly outside the large owners, and is worth about 0.2 KB.

### 9.2 Raptor 3 rule — every compiler phase must erase a decision

The roughly 79 KB-gzip delta over read routing is the complete complex-write compiler
counterfactual. It is not a claim that 79 KB is removable. The goal is to stop paying
for the same capability several times.

Do **not** start by inserting a relation-transition IR. If
`RelationMutationEntry`, `JunctionMutation`, `JunctionPlan`, `OwnWriteSteps`, and the
new form all coexist, Raptor 3 would add a fourth representation and make the problem
worse.

The governing rule is:

> A phase must discharge a semantic decision. If the next phase switches on the same
> discriminant, the additional representation needs measured proof that it is
> irreducible.

`Part` and `OperationStep` are already the target algebra. The target flow is:

```text
exact lazy mutation entry
          │
          ▼
one topology-aware product fold
          ├── existing Part continuation
          ├── root membership contribution
          └── OwnWrite facts applied to the existing ledger
                         │
                         ▼
              planning → compile(known)
```

Planning and compilation may remain separate because planning can repeat before a
taken arm compiles. They consume the same already-allocated behavior and must not
switch over the public verb again. After the fold, `connect`, `set`, `upsert`,
`JunctionMutation`, and `JunctionPlan` are illegal source vocabulary.

Small combinators such as `sequence`, a planned continuation, a branch, membership,
or record series are admissible only when they immediately construct an existing
`Part` and delete orchestration. They may not store an action union for another
visitor. A general write graph, transition IR, visitor, or renamed eleven-arm union is
rejected.

Four real lifetimes are currently missing and may earn explicit owners:

- `WriteCompilation`: one operation's engine, ID namespace, driver-derived execution
  mode, and recursive fresh/selected compilation behavior;
- `FreshRecordCompiler` / `SelectedRecordCompiler`: record lowering separated from
  public operation shells, with explicit compile products;
- `FreshRecordEmission`: guards, before-root work, root write, and after-root work,
  so a relation owner can compose at the real insertion seam;
- `ProgressiveExecution`: one execution run's driver, progress, visibility, path,
  commit, and notification invariants.

None may be an inert `Context`, options bag, strategy registry, or single-method
wrapper. Each must perform the behavior of its lifetime and delete the current
parameters, state channels, or duplicate compiler it replaces. Current model,
relation, mutation entry, selector, parent source, filter, and schedule cursor are not
lifetime state: they remain explicit semantic inputs.

### 9.3 Raptor 3 execution order

Each unit is independently reversible and must pass Section 9.4 before the next unit
starts.

#### D0 — Stop treating private implementation coordinates as public contracts

The write engine is not a package export, yet 123 test files import its internals, 79
directly construct operation/compiler classes, and 55 call `planning()` or `compile()`.
This estate is valuable for semantic falsification, but it also freezes allocation
coordinates and intermediate plan shapes.

Before each retained refactor, classify assertions into:

- public behavior: result, SQL semantics, parameter order, error, transaction and
  concurrency behavior;
- externally observable implementation behavior: statement order, provider effects,
  protected instrumentation;
- private coordinates: class constructor shape, intermediate union, or step ID with no
  observable consumer.

Preserve the first two. Replace the third with behavior probes when the coordinate
blocks deletion. Do not bulk-delete tests, and do not relax an exact assertion until a
repository search proves that coordinate is private.

#### D1 — Create the operation compilation owner

Turn `StepScope` into, or replace it with, a behavioral `WriteCompilation` that owns:

- the engine;
- step allocation;
- the one driver-derived execution mode;
- recursive `createFresh` and `updateSelected` entry points.

Remove `txMode` parameters and properties outside that owner, remove the ignored
operation argument from `selectExecutionMode`, and remove the repeated
`scope + engine + txMode + recordCompilers` bags. Consumers ask the owner to allocate,
compile a record, or answer the substrate; they do not unpack a shared-state record.

The owner is an active operation lifetime, not a universal parameter object. It must
not contain optional `kind`, `where`, `data`, `filter`, current model, current relation,
current mutation, current parent, or result fields. The intended call shape is
`lowerRelation(compilation, ownWrite, relation, entry)`, not `lower(context)`. Stable
Part scope is captured when the Part is constructed; `planning()` and
`compile(known)` must not receive the compilation owner merely to forward it.

OwnWrite stays with `OwnWriteRelation` and `OwnWriteLedger`. It is passed to the
topology fold as the exact legality owner; it is not hidden inside compilation just
because both lifetimes end with the operation.

Keep only if at least 90 net propagation token-lines disappear after paying for the
owner, no new generic context type is introduced, and SQL, parameters, observable step
IDs, and transaction/batch behavior remain exact.
The immediate gzip result may be sub-kilobyte; this unit earns its place by deleting
contradictory state and enabling the larger phase collapses.

**Ordering correction (2026-09-01):** on its own this unit deletes no representation
and no re-dispatch, so it fails the keep rule as a first unit. It is scheduled last, as
a byproduct of D2/D5, in
[raptor3-restructuring-plan.md](./raptor3-restructuring-plan.md) §6.5 and §10 (P7).

#### D2 — Separate operation shells from record compilers

Extract a real `FreshRecordCompiler` from `CreateOperation`. The public create shell
keeps public parsing, projection, direct scalar folds, terminal result parsing, and
root-level legality. Nested create, an upsert create arm, and a `createMany` member call
the record compiler directly through exact entry functions.

Delete `SubOperationOptions`, the `nestedFresh` and `parsedRoot` constructor modes,
terminal-suppression flags, empty placeholder arguments, deferred legality mode,
`buildFreshRecordPart`'s public-operation wrapper, and the compiled-root scalar side
channel. Give captured update-series members their own exact constructor input instead
of sharing a create/update options bag.

At the same time, make selected compilation return an immutable semantic product:

```ts
interface CompiledSelectedRecord {
  readonly steps: readonly OperationStep[];
  readonly finalFieldValues: ReadonlyMap<string, unknown>;
  readonly finalRowKey: Readonly<Record<string, unknown>>;
}
```

The exact local domain types and spelling may differ, but the result must carry the
new cursor and semantic values explicitly. `compiledFinalFieldValues`,
`compiledSelectedRowKey`, and `relationTransitionFinal` must not remain temporal output
channels. Deferred legality remains lazy so an untaken upsert arm stays inert.

#### D3 — Prove direct lowering with one vertical semantic slice

Prototype `connect`, `disconnect`, and `set` across the three storage shapes that
force the real distinctions:

1. a child-held foreign key;
2. a plural junction;
3. a singular junction inverse.

The singular inverse slice includes `connect` and `disconnect`; `set` remains
structurally impossible there. Use each verb only where that cardinality admits it.
The topology-bound handler
switches on the exact parsed entry once and directly returns an existing `Part`
continuation plus its root-membership contribution. Planning and compilation invoke
that continuation; they never recover the public verb.

For the migrated slice, delete rather than wrap:

- every corresponding `JunctionMutation` and `JunctionPlan` variant;
- their allocation, membership-site, planning, and compile switch cases;
- the equivalent downstream child-held and singular-junction redispatch;
- any parallel OwnWrite verb case once D4 joins the slice.

Do not introduce an action union, transition record, visitor, general dependency
graph, or `kind + options` carrier. If repeated physical sequencing remains, a local
combinator is allowed only when it returns a `Part` immediately and removes more
orchestration than it adds.

The slice is retained only if it preserves singular transfer, SQL and parameter
order, exact failure timing, batch guards, transaction locks, duplicate behavior, and
lazy untaken arms; removes at least 30% of the migrated slice's net token-lines after
replacement code; removes at least one complete downstream dispatch layer; and lowers
both minified and gzip bytes. Extend the pattern to the remaining verbs only after
that result. The measured slice design
([raptor3-restructuring-plan.md](./raptor3-restructuring-plan.md) §8) deletes about
580 token-lines and adds about 290, for **about 290 net token-lines** and
**380-470 physical lines** (35% of the migrated surface); the original 140-240 band
omitted `buildToManyLinkParts`, `membershipInsertWrites` and `junctionInsertManyWrites`
becoming fold-local. The completed direct-lowering zone targets 450 net token-lines and
about 1.1 KB gzip in the base case.

The narrow behavior anchors include `link-in-list-fold`, compound-junction,
polymorphic collection/write-family, OwnWrite linearization, update-many relation
series, captured row-key decode, create-many bind-budget, and namespace qualification
for all three verbs. The slice must exercise both transaction and forced-batch paths.

#### D4 — Make the same lowering own OwnWrite footprints

After D3 proves one topology-aware lowering, make that same product fold apply each
action's target and membership read/write facts to the existing `OwnWriteLedger`.
The ledger remains the legality owner. Delete the parallel verb traversal in
`OwnWriteSteps`, its recursive reparsing, and the footprint carrier when the fold can
apply the facts directly.

Adding footprints to current Parts while retaining the shadow traversal is an automatic
rejection. The falsifiers are exact refusal type/message/timing, branch-local upsert
legality, sibling order, and record-series member isolation. This is the highest-risk
unit and must start with the same three verbs and storage shapes before expanding. The
base target is 250 net token-lines and about 0.7 KB gzip after paying for footprint
emission (the per-verb fact vocabulary survives as emission code; only the walk, the
re-parse and the re-derived topology delete); moving `OwnWriteSteps` without deleting
it is zero progress. Single-walk emission preserves today's error precedence only with
the two ledger strengthenings in
[raptor3-restructuring-plan.md](./raptor3-restructuring-plan.md) §6.4 (facts before
construction with deferred construction refusals; recorded reads on a deferred fork),
which must land first.

#### D5 — Expose staged fresh-record emission and delete the second compiler

Make fresh-record compilation expose the phases it already owns:

```text
guards | before-root | root write/publication | after-root
```

Normal create concatenates those phases. A junction target composes its join after the
root write and before after-root descendants. This preserves the two current observable
orders without a lifecycle callback or placement boolean.

Keep only if it deletes all of the following rather than wrapping them:

- `nested-target-parts.ts`;
- `JunctionTargetRelationsBuilder` and repeated nested-builder closures;
- the `inline | record` prepared-target split;
- the restricted second relation-verb switch.

If the staged result cannot replace the 808-line restricted compiler, remove the new
seam. Changing statement order is a separate product decision and is not authorized by
this behavior-preserving plan; keeping both orders keeps
`requiresWholeFreshRecordCompiler` as the placement predicate. The base target is 450
net token-lines and about 1.45 KB gzip after paying for `FreshRecordEmission`, counting
the inline-target machinery and all six `nestedBuilder` closures this unit deletes
outside `nested-target-parts.ts`
([raptor3-restructuring-plan.md](./raptor3-restructuring-plan.md) §7 Z3, §10 P3). This
is the best deletion per line in the program and should run before D3 if D3 is
rejected.

#### D6 — Strengthen the trusted mutation value

Do not eagerly parse every nested record: client-side defaults must still rematerialize
per `updateMany` member, source transformations are not idempotent, and untaken arms
must remain inert. Within those constraints, the parse/topology boundary must publish
exact shapes for the path it has validated:

- one-item to-one suppliers and modifiers, not plural arrays plus `[0]`;
- correlated versus unique target forms that downstream code cannot confuse;
- exact to-one compositions rather than broad entries plus `ReadonlySet` classifiers;
- one parent-held locator shared by ordinary and polymorphic update/delete/upsert
  effects.

Remove an internal guard only when its impossible state becomes unrepresentable and a
falsifier proves the new boundary. This unit should delete downstream checks and the
parallel parent-held arms; it must not merely add branded aliases over the same broad
records. Together with the shell/result work in D2, this shared fresh/selected zone
targets 1,100 net token-lines and about 3.4 KB gzip in the base case.

#### D7 — Recut compile-local schedules

Create emission and selected-record compilation currently pass guard/write arrays as
output parameters through 7-10 argument methods. Use local closures for create where
the lifetime is one function. Use a behavioral selected-record schedule only if it
owns guard hoisting and the explicit `beforeRoot`, `root`, and `afterRoot` operations.
A bag named `EmissionContext` is rejected.

This unit should remove `bucketOperationSteps` call repetition and output-array
parameters. It is not a reason to inline every single-use private method.

#### D8 — Isolate progressive execution

Move the recursive progressive path from `OperationExecutor` into one per-run
`ProgressiveExecution` owner. Capture driver, request context, progress, bind limit,
visibility callbacks, and commit state once; pass only cursor-local operation, values,
guards, path, phase, and conflict state through recursion.

The unit must preserve retry attribution, committed-prefix counts, invalidation timing,
nested record series, generated-output fallback, and tracing. It targets cohesion and
about 140 net token-lines / 0.32 KB gzip in the base case, not the isolated
relation-kernel delta.

If the existing Part algebra is later proven unable to express a required behavior,
that evidence opens a separate architecture decision. This plan does not reserve a
future transition normal form as its default escape hatch.

### 9.4 Keep gate for every semantic prototype

A prototype is retained only when all statements are true:

1. It names the necessary truth and its first exact owner.
2. At least one existing representation, branch family, guard, or decision site is
   deleted.
3. No old and new mechanism coexist.
4. A static census proves that the migrated surface verbs and intermediate kinds do
   not survive past their lowering boundary.
5. Token-bearing lines fall; comment deletion does not count.
6. Minified bytes fall. Gzip bytes are reported even when the delta is below noise.
7. Function/branch/owner counts do not move complexity into a generic callback or
   options bag.
8. Public behavior, SQL bytes, parameter order, externally observable step IDs,
   failure type/timing, transaction semantics, and provider parity stay unchanged.
   A private coordinate may change only after D0 proves that no runtime, error,
   instrumentation, or public consumer observes it.
9. A named falsifier becomes red when the new owner is deliberately broken.

If a prototype improves organization but not concepts or bytes, record it separately;
do not claim it as bundle reduction. If it adds lines or slows the path, remove it. The
historical compiled-selection result in
[`distinct-truth-final-census.md`](./distinct-truth-final-census.md) is the model for
an honest rejected experiment.

## 10. Sequential validation gates

Never overlap the repository's Vitest or TypeScript processes.

### 10.1 Phase A

```bash
pnpm package:build
pnpm size
pnpm test:package
git diff --check
```

### 10.2 Phase B

```bash
pnpm test:layer:scalars
pnpm test:layer:schema-json
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=provider-d1
pnpm test:types
pnpm package:build
pnpm size
pnpm test:package
```

The D1 project uses its existing Worker configuration. Report it as not run if that
environment is unavailable; do not call it passed.

### 10.3 Phase C

```bash
pnpm test:layer:cache
pnpm test:layer:query-engine
pnpm test:layer:client
pnpm test:layer:instrumentation
pnpm test:coverage:cache
pnpm test:coverage:extensions
pnpm test:types
pnpm package:build
pnpm size
pnpm test:package
```

Then run the credential-free final gate:

```bash
pnpm test:all
```

### 10.4 Any retained Phase D unit

Run the narrow falsifiers first, then the query-engine and write-engine owners, then:

```bash
pnpm test:layer:query-engine
node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=layer-write-engine
pnpm test:layer:adapters
pnpm test:layer:drivers
pnpm test:layer:client
pnpm test:types
pnpm package:build
pnpm size
pnpm test:all
```

Run available PostgreSQL and MySQL provider suites for any retained write/compiler or
executor change. Record skipped provider legs explicitly.

## 11. Rejected designs

### Named per-scalar imports

Rejected by product decision. They measured about 4.1 KB gzip in the controlled
fixture, but they turn schema authoring into Drizzle-style import assembly. VibORM
keeps one coherent `s` vocabulary.

### Dynamic-import the write engine

Rejected as a size claim. It can change initial-load timing, but total deployed bytes
remain. It also conflicts with synchronous statement building and transaction-array
preparation in [`PendingOperation`](../../src/query-engine/pending-operation.ts).

### Split by operation name

Rejected by measurement. A single `CreateOperation` already adds about 66.4 KB gzip
over read-only routing because nested writes reach most relation compilation. Adding
all remaining CRUD shells after one complex write costs only about another 5.5 KB
gzip. Per-operation files or chunks do not remove the shared semantic kernel.

### Read-only or flat-CRUD public client

Not part of this plan. It could save roughly 79 KB gzip, but it creates a material
product boundary and a second capability surface. The user accepted the full cohesive
client, not an import matrix.

### File splitting to satisfy a LOC threshold

Rejected. It can improve navigation but does not reduce concepts, lines, or bundle
bytes. The write engine already has zero runtime import cycles. Any organization-only
proposal must state its independent ownership gain and must not be reported as this
plan's size result.

### Generic mutation DSL, transition IR, strategies, or table-driven switches

Rejected for this program. VibORM already has the target algebra in `Part` and
`OperationStep`; another stored action form would require another consumer and repeat
the failure. Generic visitors and tables also hide real topology, ordering, race, and
record-series differences. The accepted abstraction is a product fold that immediately
constructs the existing Part continuation and applies OwnWrite facts. Small local
combinators are allowed only when they return Parts and delete current orchestration.

### Remove guards to save bytes

Rejected unless the exact invariant becomes unrepresentable or another sole boundary
already fails loudly. The one-guard-per-invariant rule in [`AGENTS.md`](../../AGENTS.md)
requires a unique falsifier, not a byte quota.

### Stronger minification as the library result

Rejected as the primary claim. Terser reduced the final diagnostic bundle by about
13.3 KB gzip, but that is a consumer build choice and applies to competitors too. The
release fixture may use one pinned production-like minifier; the architecture budgets
must not depend on an application-specific second pass that users may not run.

## 12. Completion record

When the plan is implemented, append one short outcome section containing:

- exact before/after raw and gzip bytes for all three fixtures;
- the final esbuild metafile's largest retained owners;
- proof that `bignumber.js`, production CUID2, and heavy cache modules are absent from
  the ordinary fixture;
- cache-enabled fixture delta;
- CUID compatibility and Worker results;
- validation commands with pass/skip counts;
- any Phase D prototype kept or rejected, with token, branch, minified, gzip, and
  behavior evidence.

Do not rewrite the baseline after a regression. Ratchet a budget downward when a real
reduction lands; raise it only through an explicit architecture decision with measured
cause.
