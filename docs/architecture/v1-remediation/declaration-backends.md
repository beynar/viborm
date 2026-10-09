# Declaration backend comparison

No tested backend alone fixes the exported cyclic inferred-schema backreference. The baseline experiment below retains the existing declaration backend: switching to native emission improves this isolated producer's emission time but preserves the correctness defect. OXC requires changing the unannotated producer contract. That comparison changed no library representation, annotation, dependency, shared build output, or repository source.

Arnaud subsequently supplied and authorized a type-only schema-key link carrier
at `createClient`. Artifact25 qualifies that representation across the complete
package suites and final compiler/backend/scaling matrix. Its acceptance gate is
exact unannotated exported clients and client factories. Rebuilding a client
from already-emitted cyclic models remains an explicitly accepted limitation,
checked independently by source-valid, emitted-semantic negative controls. The
baseline results below concern the original representation; the final results
follow the integrated correction.

## Controlled case and installed toolchain

The unchanged immutable VibORM artifact 17 was unpacked into this scratch project's node_modules. SHA256: `158b8252a4f04c56a5c27297bb43d8dab0c3e543ea71fbd6e3dc71b36da5a680`. The producer is the existing five-model related chain from `tests/package/declaration-consumer-smoke.mjs`, including exported inferred models, schema, client and load function. Separate downstream probes keep the valid string parent ID, invalid numeric ID, nested result string/number domains, missing result field refusal, and the explicitly documented nested-WHERE typo compiling pin. Additional `IsAny` probes check the client and inferred parent ID. Both TypeScript 5.8.3 and native TypeScript 7.0.2 pass these probes against producer source.

Installed: TypeScript JS 5.9.3, compatibility compiler 5.8.3, native TypeScript 7.0.2 (`typescript-native` alias); tsdown 0.19.0-beta.4; Rolldown 1.0.0-beta.58; rolldown-plugin-dts 0.20.0. OXC emission is available through `rolldown/experimental`; no separate oxc-transform dependency is needed.

The installed dts plugin exposes `tsgo:true`, hardcodes resolution of optional `@typescript/native-preview`, and labels it experimental/not recommended for production. That peer is absent. It exposes no executable override. The native alias comparison therefore copies tsdown and the declaration plugin into scratch and supplies a scratch-only native-preview alias pointing to the existing7.0.2 package. This proves loader compatibility, not stock installed support or a qualified production dependency combination. The plugin invokes native declaration emission with `--noCheck`; downstream checks remain strict.

## Results

| Producer declaration backend | Emission | Declaration bytes / elision comments | TS5.8 downstream | TS7 downstream | Required change |
|---|---:|---:|---|---|---|
| Direct current JS 5.9.3 | PASS,3.60s | 203453 /60 | FAIL,4.20s | FAIL,1.75s | None; baseline emitter |
| Direct native7.0.2 | PASS,1.53s | 146457 /28 | FAIL,4.62s | FAIL,1.71s | Different producer build command |
| tsdown current JS backend | PASS,0.97s | 144657 /60 | FAIL,4.81s | FAIL,1.73s | None; baseline bundler |
| tsdown stock `tsgo:true` | FAIL,0.16s | No output | Not possible | Not possible | Missing optional native-preview peer |
| tsdown native scratch alias | PASS,0.35s | 105265 /28 | FAIL,5.29s | FAIL,3.61s | Scratch loader alias; experimental unsupported combination |
| tsdown OXC `oxc:true` | FAIL,0.17s | No output | Not possible | Not possible | Explicit exported-variable type annotation, TS9010 at m0 |

All four emitted outputs fail the same meaningful downstream contract: a valid string `parent.is.id` is rejected (TS2322), while both nested result-negative directives become unused (TS2578). Numeric-ID rejection alone still holds, but cannot establish correctness when valid IDs are also rejected. Native emits fewer `/*elided*/ any` substitutions and smaller files; it does not preserve the recursive model graph sufficiently. The explicit `IsAny` checks do not independently fail; the positive and result-negative tests establish the lost domain. Raw `any` token counts are observations, not a diagnosis of every inferred leaf.

Emission timings are single observed wall times, not a benchmark. tsdown native explicitly skips checking, and these paths perform different bundling work. All compiler/build children used the existing ordinary1536MiB aggregate process-group ceiling,768MiB JS heap and30s child timeout with verified teardown. Final strict source/downstream runs peaked at863.6MiB sampled group RSS. The initial native CLI checks encountered TS5112 because a tsconfig was present; the final checks explicitly use native `--ignoreConfig` and retain the initial failure logs. Source strict checks then passed on both compilers; all final emitted downstream failures above are semantic diagnostics, not harness or resource failures.

## Library generation versus an application's own emission

The packed VibORM library's declaration representation was held constant. These checks exercise an application's inferred exported schema/client: producer TypeScript source -> declarations -> separate consumer. Merely changing VibORM's library-generation backend cannot change which backend that application's build uses. Neither changing its own backend to native nor bundling its declarations repairs this case.

This experiment does not qualify the entire VibORM library build under native or OXC. The current library config additionally uses JS TypeScript Compiler API calls (`createSourceFile` and AST guards) in its type-export preservation plugin. Native7.0.2 provides a native compiler and unstable native API modules, not a drop-in JS Compiler API. That tooling must retain JS TypeScript even if an emitter changes. OXC's syntax-only isolated-declaration path cannot infer `export const m0 = s.model(...)` unchanged: its actual TS9010 requires an explicit type annotation. Introducing model/schema/client annotations or generating them would change this tested zero-codegen inferred workflow; no such restructuring was performed.

## Evidence

`compare.mjs` and `comparison.log` hold sequential emission receipts; `recheck.mjs`, `strict-final-comparison.log`, and `strict-final-receipts.json` hold final strict source and downstream receipts. Each backend directory preserves its exact declaration output and downstream probe. `native-stock-emit.log` records the missing peer; `oxc-bundle-emit.log` records the annotation refusal. Producer SHA256: `950ff2ec53cb430b516f05773a70d4b35f169eb87145ca13989886d514839c8e`; final probe SHA256: `6f066e00474b8ec48c618c84db35de081db5f68441a4c40860e497dc40fbdfd5`.

The local evidence directory is `/tmp/viborm-v1-declaration-backends-20261008/`; the durable public-API case remains in `tests/package/declaration-consumer-smoke.mjs`.

## Verified getter-only mitigation

The same public producer passes when each relation thunk names its return type:
`s.toMany((): typeof m1 => m1)` and `s.toOne((): typeof m0 => m0)`.
Only eight getter return annotations changed. The exported models, schema, client,
scalar declarations and result functions remain inferred; no casts or `any` were
introduced. This is a consumer-side requirement, not a backend fix. The original
unannotated failure is unchanged.

| Producer emitter | Emission | Separate TS5.8 consumer | Separate TS7 consumer |
|---|---:|---:|---:|
| JS5.8.3 | PASS,3.72s | PASS,3.79s | PASS,1.52s |
| JS5.9.3 | PASS,3.38s | PASS,3.65s | PASS,1.44s |
| Native7.0.2 | PASS,1.48s | PASS,3.62s | PASS,1.43s |

All original positive and negative probes pass, including nested result domains
and missing-field rejection. Every output is29,525bytes with zero elisions and24
named model links. JS5.8 and5.9 outputs are identical; native differs in union
ordering. The existing nested-WHERE typo limitation remains explicitly pinned.

A dependency-free generic State/getter counterpart failed source checking on
both compilers with TS7022/TS7024, before emission. It therefore does not establish
that VibORM's narrower source-correct/emitted-incorrect behavior is an intrinsic
compiler-only limitation. That cause remains unsettled.

Evidence: `/tmp/viborm-v1-declaration-backends-20261008/followthrough.md`,
`annotated-getters/{receipts.json,ts58-receipts.json}` and exact saved producer,
consumer and emitted files. Arnaud explicitly rejected this annotation requirement for V1: the release is
held until fully unannotated cyclic emission preserves the original contract.
The integrated carrier below satisfies that declaration requirement without
adopting the getter annotations.

## Reduced failure boundary

The same defect survives a reduction to two unannotated exported models. Both
source compilers accept the original public query and result probes; both emitted
consumer compilers fail them. The five-model chain's size is not necessary.

Removing the inferred client and driver also preserves the defect. The remaining
probe follows the actual model state through `children` and back through `parent`,
then reads the parent's scalar keys and ID domain. Source checks pass under5.8
and7. JS emission takes3.26s and native emission1.37s; each emits6970bytes with two
elisions. All four separate emitted-consumer checks fail: a numeric ID and missing
scalar key become accepted, and an explicit `IsAny` check confirms the ID widened
to `any`. The failure therefore precedes client assembly and operation-input
inference. This narrower `IsAny` result does not replace the distinct findings on
the original client probe above.

Evidence is in `public-two-models/` and `model-facts-two-models/` beneath the same
scratch directory. These reductions change only the experiment; the original
package gate and the release requirement remain intact.

A final isolated candidate reused the existing `ModelTarget<G>` type alias in
the two relation factory return types, with type-only export visibility. Source
checks still passed, but both JS/native outputs retained the same failed strict
consumer contract (60/28 elisions, respectively). It was rejected without a
shared source edit. Evidence: `named-factory-target/`. Further type experiments
by this fleet stopped when Arnaud assigned the correction to a separate agent.

## Real dense-schema baseline before the client carrier

The later representation work uses immutable artifact 20 as its before case
(SHA256 `fa5d434d4bb5688891dc4aee607605a2ccea37ff6a6c6f11715afc0f5f6eae40`).
This separate producer has 12 densely related models and exports only the inferred
client and a query function. It is real VibORM, not the supplied mock library.

| Check | Result | Wall time | Instantiations |
|---|---|---:|---:|
| JS5.9 direct emission | TS7056; no usable declaration |3.86 s|1,009,051|
| Native7 direct emission | Emits 2,894,234 bytes, including 23 client elisions and 1,331 callable client getters |1.45 s|2,047,052|
| TS5.8 consumer of native output | TS2322 and unused negative probes (TS2578) |3.95 s|2,713,057|
| Native7 consumer of native output | Same semantic failures |1.49 s|2,131,784|

All four children completed under the unchanged ordinary limits with verified
teardown; the largest sampled child-group RSS was 882.6 MiB. A successful native
emit therefore still does not establish downstream fidelity, even when raw models
are not exported. Final carrier measurements must use the same source and probes.
Receipts and exact inputs are under
`/tmp/viborm-v1-linked-client-20261008/baseline/receipts-12-direct.json`.

## Integrated schema-key client representation

The implementation keeps the current declaration backend and preserves the
unannotated producer. It resolves literal schema keys while exact getter types
are available, then gives exported clients a flat schema plus an optional,
type-only `Links` table. `ClientSchema` restores target model types through the
exported `Linked` view. No runtime marker is installed; the original model and
schema objects remain the runtime authority.

The flat state retains scalar facts, compound IDs/uniques and their options,
indexes and tuple order, table mapping, omit/default metadata, modified states,
and both variant cardinalities. Core and all 11 provider factory returns
materialize the config anonymously: a named outer alias retained the original
recursive schema argument. Scalar-only and open schemas keep their original
view without unnecessary graph resolution. No caller annotation, cast, any
fallback, depth cap, getter wrapper, or new relation language is required.

The original emitted client contained recursive getters of this actual form
inside its schema argument:

```ts
readonly getter: () => import("viborm").Model<import("viborm").InitialModelState</*elided*/ any>>;
```

The flat client replaces that recursion with declared state and literal links.
These are actual excerpts from the final artifact25 JS-direct client argument:

```ts
readonly target: {
    readonly kind: "model";
    readonly getter: unknown;
};
```

```ts
    readonly " vibLinks"?: {
        m0: {
            children: "m1";
        };
        m1: {
            children: "m2";
            parent: "m0";
        };
        m2: {
            children: "m3";
            parent: "m1";
        };
        m3: {
            children: "m4";
            parent: "m2";
        };
        m4: {
            parent: "m3";
        };
    } | undefined;
```

The unknown flat getter is deliberate: the linked view derives its exact target
from those keys. Original files are retained in
`/tmp/viborm-v1-declaration-backends-20261008/js-direct/chain5.d.ts` and
`/tmp/viborm-v1-linked-client-20261008/final25/chain5/js-direct/producer.d.ts`.
The original exported model declarations still contain elisions; the corrected
client argument does not.

### Completing indexed modifier states

The new permanent indexed modifier case exposed a pre-existing TS5.8 defect on
original artifacts 20 and 22. A valid nested include exhausted the existing
5,000,000-instantiation count at depth 25, before result traversal or additional
argument guards. A bounded first-limit frequency profile counted 1.43 million
instantiations each of the initial state and original parent shape; repeated
completed `UpdateState`/`Omit` chains dominated. The terminal distinct/schema
normalization frames were not causal.

State is now completed inline at map, omit, both index overloads, id and unique
return boundaries. The exact Payload-only diagnostic fell from 8,848,387 total
instantiations with TS2589 to 2,846,311 without errors. Completing only the final
map or wrapping the old chain in another helper was insufficient.

Inline returns alone altered strict identity for the same value held under a
legacy `Model<ModelUpdateState<...>>` annotation. The public update-state alias
therefore publishes the same completed state. This restores the original full
model comparator's answer; equality itself was not weakened. Controls preserve
readonly/optional caller metadata, patch ownership, old correlated-union
merging, any/never names, generic assignments and inherited base-model returns.
Cyclic extends before and after map also passes. Runtime bodies and assertion
counts are unchanged. This final modifier correction adds 48 net production LOC;
it adds no runtime mechanism or extra helper alias.

### Cheap negative projection, exact final identity

Original artifact 23 passed all 51 package cases on Node 24, but its identical
Node22.12 TS5.9 chain 200 invocation exceeded 30 s after 21 passing cases. This is
one strict noEmit invocation, not repeated harness work or an OOM.

The necessary singular-field-tree prefilter now uses tuple-wrapped bidirectional
assignability. Matching that projection never establishes model identity: the
original full-model `IsIdentical` remained the sole match authority at this
stage. The subsequent correction below addresses its inference boundary.
Tuple wrappers avoid distributing a union target. Exact comparator
controls cover aliases, identical models, external targets, both variant
cardinalities, ordinary and singular rings, legacy annotation identities,
different table names under identical trees, and a union-typed model target plus
matching union schema entry.

| Isolated artifact 23 patch, exact Node22.12 fixture | Result | Wall / peak group RSS |
|---|---|---:|
| Unchanged TS5.9 chain 200 | PASS |7.76 s /880.6 MiB|
| Unchanged TS5.8 chain 200 | PASS |7.63 s /880.0 MiB|
| TS5.8 backreference source/emit/consumer | PASS |9.08 s /898.6 MiB|
| Native7 backreference source/emit/consumer | PASS |3.11 s /903.5 MiB|
| TS5.8 indexed modifiers source/emit/consumer | PASS |9.20 s /883.4 MiB|
| Native7 indexed modifiers source/emit/consumer | PASS |3.35 s /1147.8 MiB|

These are focused scratch receipts, not final package-suite completion. Every
child retains 768 MiB JS heap, 1536 MiB aggregate RSS and 30 s timeout, with verified
teardown. Evidence is in `/tmp/viborm-v1-node22-prefilter-candidate23/`, including
original-comparator controls and declaration/source hashes.

### Preventing redundant equality inference

Artifact 24 exposed a second Node22.12 boundary: the full package run passed
35 cases, then TS5.8 chain 200 overflowed the JavaScript stack. Focused and
single-test Vitest runs passed, but a fresh-process repeat reproduced the
failure. The rebuilt client declaration chunk was byte-identical to the earlier
passing scratch patch. The discrepancy was intermittent compiler inference,
not an assumed artifact equivalence.

A diagnostic copy of the installed compiler captured only the first thrown
inference stack, without changing checker limits or branches. It contained
602 source/target pairs inside `IsIdentical`'s conditional function returns,
repeatedly traversing identical model shapes and singular getter returns.
The field-tree accessor trial did not fix it and was rejected.

The correction prevents inference from reconstructing already supplied model
operands while retaining generic-function identity as the sole match authority:

```ts
type IsIdentical<A, B> =
  (<T>() => T extends NoInfer<A> ? 1 : 2) extends
  (<T>() => T extends NoInfer<B> ? 1 : 2) ? true : false;
```

An independent original-comparator corpus agrees on all 676 pairs among
26 plain types: readonly/optional properties, intersections, correlated unions,
any/unknown/never, indexed records, tuples and generic functions. Actual model
controls preserve aliases, twins/maps, external targets, variants, ordinary and
singular rings, union-typed targets and legacy modifier identities. Strong
chain 100 controls also retain exact root, middle and backreference target keys.
No assignability fallback, source annotation, stack-limit change or test
exemption was introduced. The installed TS5.8 implementation retains
`NoInfer`'s base type for relation normalization while stopping inference from
that target; independent read-only review found no blocker in these controls.

| Isolated artifact 24 patch on Node22.12 | Result | Wall / peak group RSS |
|---|---|---:|
| TS5.8 chain 200, three fresh processes | PASS | 4.96 s / 864.8 MiB; 4.97 s / 864.1 MiB; 4.92 s / 862.0 MiB |
| TS5.9 chain 200 | PASS | 4.84 s / 876.8 MiB |
| TS5.8 / native identity truth corpus | PASS | 4.44 s / 791.9 MiB; 1.49 s / 649.7 MiB |
| TS5.8 / native chain 100 literal controls | PASS | 4.31 s / 780.5 MiB; 1.55 s / 651.6 MiB |
| TS5.8 / native backreference source/emit/consumer | PASS | 9.00 s / 897.5 MiB; 3.15 s / 898.8 MiB |
| TS5.8 / native provider/generic factory source/emit/consumer | PASS | 9.20 s / 876.1 MiB; 3.51 s / 772.6 MiB |
| TS5.8 / native indexed modifiers source/emit/consumer | PASS | 9.19 s / 885.3 MiB; 3.49 s / 1128.4 MiB |

Every child retained 768 MiB JS heap, 1536 MiB aggregate RSS and 30 s timeout,
with verified teardown. Exact manifests and receipts remain in
`/tmp/viborm-v1-node22-noinfer24`; the original failure and bounded diagnostic
are retained in `/tmp/viborm-v1-node22-final24-differential` and
`/tmp/viborm-v1-node22-inference24`. These are focused qualifications, not
substitutes for the final integrated package run. This final equality correction
adds 4 production lines, including its comment and formatter line wraps; that
delta is separate from the 48-line modifier correction.

### Final artifact qualification

Immutable artifact 25 SHA256:
`5370aa3d244db77aebff9fb347d73df7ae102e5a39ad670a6d4839979013a5b9`.
Source manifest:
`cc208fb939bad29b6fbdf86e05e41477c83474aa467aee5512353af948c2eae4`.
The isolated build passed in 2.11 s at 1035.8 MiB. The unchanged full-estate
native41 program passed with zero diagnostics in 35.51 s at 6143.9 MiB,
under its 8192 MiB/300 s ceiling. The complete Node22.12 package suite
passed all 51 cases in 203.02 s at 1384.9 MiB under its unchanged 1536 MiB/300 s
limits, with verified teardown. Its TS5.8 chain100/chain200 cases took
4.283 s/5.075 s; native chain200 took 1.554 s. The exact terminal receipt is
`/tmp/viborm-v1-package25-node22.log`.
The same artifact also passed all 51 cases on Node24.14 in 187.93 s at
1433.6 MiB, with verified teardown and the same limits
(`/tmp/viborm-v1-package25-node24.log`).

The final source-shape chunk passed all 24 checks with zero failures and a
1049.0 MiB peak. It covers chain5 source, domain/result/key probes, source-valid
raw-model controls, generic/provider factories, self-junctions, both variant
cardinalities and full indexed modifiers under TS5.8 and native7. Exact receipts:
`final25/receipts-5-factories-self-variants-modifiers-source.json` beneath the
matrix directory below. The direct shapes emission/consumer chunk is now complete below.

#### Direct emission and strict consumers

The 38-row shapes chunk completed without unexpected failures: ten direct
emissions retain zero client elisions/getter functions and exact literal target
tables; all separate positive/negative consumers pass. Four raw-model rebuild
controls intentionally fail with their expected semantic diagnostics. Peak
sampled group RSS was 937.7 MiB.

For the unannotated chain5 client, cells show wall seconds and instantiations:

| Emitter | Emit | Total/client declaration bytes | TS5.8 consumer | Native7 consumer |
|---|---:|---:|---:|---:|
| JS5.9 direct | 3.61s / 1,044,717 | 163,394 / 31,667 | 3.81s / 2,896,928 | 1.49s / 2,238,769 |
| Native7 direct | 1.50s / 2,093,940 | 133,434 / 29,437 | 3.79s / 2,897,038 | 1.48s / 2,239,050 |

Whole-file elisions remain 40/24 respectively in exported raw models. Both
client arguments are clean and preserve the exact target table; unequal sizes
reflect different serialization, not an assumed byte-identical declaration.
Receipts: `final25/receipts-5-factories-self-variants-modifiers-direct.json`.

#### Dense source scaling

These are actual exported VibORM clients over dense paired FK/backreference graphs,
with separate source and domain/result probe programs. All 16 checks passed;
peak sampled group RSS was 927.2 MiB.
Cells show wall seconds and compiler instantiations, not inferred complexity.

| Models | TS5.8 source | TS5.8 probe | Native7 source | Native7 probe |
|---:|---:|---:|---:|---:|
| 12 | 3.78s / 3,205,338 | 4.13s / 4,165,182 | 1.48s / 2,125,056 | 1.50s / 2,448,046 |
| 24 | 3.80s / 3,258,378 | 4.27s / 4,224,313 | 1.46s / 2,146,968 | 1.50s / 2,491,870 |
| 48 | 4.00s / 3,373,098 | 4.54s / 4,339,033 | 1.47s / 2,199,432 | 1.50s / 2,596,798 |
| 96 | 4.21s / 3,637,098 | 5.25s / 4,603,033 | 1.48s / 2,338,920 | 1.50s / 2,875,774 |

Exact receipts: `final25/receipts-12-24-48-96-source.json`.

#### Dense emission and separate consumers

All 24 dense emission/consumer checks passed. These producers export the
inferred client and query, rather than mock aliases or separately annotated
models. Every emitted client has zero elisions/callable getters and the complete
exact literal target table. Cells show wall seconds and instantiations.

| Models | Emitter | Emit | Total/client bytes | TS5.8 consumer | Native7 consumer |
|---:|---|---:|---:|---:|---:|
| 12 | JS5.9 | 3.61s / 1,110,823 | 109,645 / 108,975 | 3.90s / 2,952,279 | 1.48s / 2,260,287 |
| 12 | Native7 | 1.51s / 2,168,234 | 104,293 / 103,623 | 3.92s / 2,937,259 | 1.55s / 2,253,439 |
| 24 | JS5.9 | 3.74s / 1,151,059 | 220,957 / 220,287 | 4.03s / 2,954,756 | 1.54s / 2,261,969 |
| 24 | Native7 | 1.59s / 2,208,518 | 210,253 / 209,583 | 3.99s / 2,939,335 | 1.49s / 2,254,867 |
| 48 | JS5.9 | 3.96s / 1,240,171 | 443,581 / 442,911 | 3.95s / 2,958,380 | 1.46s / 2,264,393 |
| 48 | Native7 | 1.62s / 2,297,726 | 422,173 / 421,503 | 4.04s / 2,943,487 | 1.47s / 2,257,723 |
| 96 | JS5.9 | 4.73s / 1,452,955 | 888,829 / 888,159 | 4.25s / 2,965,628 | 1.49s / 2,269,241 |
| 96 | Native7 | 1.84s / 2,510,702 | 846,013 / 845,343 | 4.22s / 2,951,791 | 1.48s / 2,263,435 |

Against the exact dense12 before case, JS5.9 now emits a usable 109,645-byte
declaration where it previously refused with TS7056. Native7 output shrinks
from 2,894,234 to 104,293 bytes and both previously failing separate consumers
now pass. This establishes client fidelity; it does not imply the separate
raw-model reconstruction limitation disappeared.

Receipts: `final25/receipts-12-24-direct.json` and
`final25/receipts-48-96-direct.json`.

For the preceding artifact 24, the unchanged whole-estate native40 program
passed in 35.91 s at 6112.9 MiB under its 8192 MiB/300 s ceiling; all 89 runtime
`.mjs` files were byte-identical to artifact23. Its chain 5 direct matrix also
retained all literal links with zero client elisions or getter functions and
passed all four separate strict consumers. That fidelity evidence does not
clear its independently reproduced chain 200 stack failure.

#### Bundled backend comparison

| tsdown backend | Emit wall | Total/client bytes | TS5.8 consumer | Native7 consumer | Outcome |
|---|---:|---:|---:|---:|---|
| Current JS | 0.77s | 118,182 / 23,635 | 3.73s / 2,914,455 | 1.44s / 2,259,069 | Exact client/keys; strict consumers pass |
| Native scratch alias | 0.28s | 97,320 / 22,085 | 3.76s / 2,910,577 | 1.46s / 2,253,767 | Exact client/keys; strict consumers pass |
| Stock native | 0.14s | No output | — | — | Missing optional native-preview peer |
| OXC | 0.13s | No output | — | — | TS9010: inferred exports require annotations |

Bundler emission does not expose instantiation statistics; those values are
not estimated. Native scratch alias support is an isolated loader experiment,
not stock support or a shipped dependency change. Its experimental plugin uses
`--noCheck`; separate consumers remain strict. Both successful bundled client
arguments retain the full literal table with zero elisions/getter functions.
The four bundled raw-model controls fail as expected. Receipts:
`final25/receipts-5-bundle.json`.

The final aggregator verified all 118 expected rows against one artifact25 SHA,
with zero unexpected failures. Ten failures are deliberate controls: eight
semantic raw-model reconstruction refusals, the stock native missing peer and
OXC's TS9010 annotation requirement. The largest child took 5.248 s and peak
sampled child-group RSS was 1049.0 MiB, under the unchanged ordinary
768 MiB heap/1536 MiB RSS/30 s limits; teardown was verified. Exact summary:
`/tmp/viborm-v1-linked-client-20261008/final25/verified-summary.json`.

The accepted boundary remains explicit: exported clients and factories carry
recoverable graph facts. An independently exported plain model/schema can still
serialize lossy recursive getters; rebuilding a client only from those emitted
models remains unsupported and is pinned by semantic-negative controls. Library
emission and an application's own inference emission are distinct checks.
Native compiler CLI use still does not replace JavaScript Compiler API tooling,
and OXC isolated declarations still require annotations for the original exports.

### Tested scope and source cost

These counts cover the complete remediation perimeter, not just declaration
work. They use physical LF lines including comments/blanks, exclude generated
or ignored outputs, and compare against baseline commit
`a4a5b8dc607a9a8db506bd60ddb5125519d8ab0b`.

| Perimeter | Baseline | Final perimeter | Net | Change |
|---|---:|---:|---:|---:|
| src/ | 141,375 | 147,279 | +5,904 | +4.1761% |
| tests/ | 445,456 | 459,403 | +13,947 | +3.1309% |
| scripts/ | 31,694 | 31,844 | +150 | +0.4733% |
| docs/content/ | 23,129 | 23,200 | +71 | +0.3070% |

The final live-doc count includes 11 subsequent authored JSON prose lines;
those change neither the published source nor artifact25.

The indexed modifier correction adds 48 production lines; the final NoInfer
correction adds 4, including comments and formatting. Those local deltas are
parts of the full source count, not additional totals. Census and per-file
manifest: `/tmp/viborm-v1-checkpoint6-loc-final25-docs.json` and
`/tmp/viborm-v1-checkpoint6-loc-final25-docs-manifest.json`.

Artifact25 preserves the unannotated exported client/factory workflow under
both direct emitters and both strict consumer compilers, including generic
provider factories, modifiers, variants, literal target identity and nested
backreference key refusals. Dense96 also passes source, emission and separate
consumers. The current JS declaration backend is retained; the correction is
the representation supplied to emitters, with no new runtime graph or caller
annotation. Plain-model reconstruction remains the separately tested accepted
limitation above.
