# Declaration backend comparison

No tested backend alone fixes the exported cyclic inferred-schema backreference. The baseline experiment below retains the existing declaration backend: switching to native emission improves this isolated producer's emission time but preserves the correctness defect. OXC requires changing the unannotated producer contract. That comparison changed no library representation, annotation, dependency, shared build output, or repository source.

Arnaud subsequently supplied and authorized a type-only schema-key link carrier
at `createClient`. Integration and verification are in progress. Its acceptance
gate is exact unannotated exported clients and client factories. Rebuilding a
client from already-emitted cyclic models is explicitly accepted as a remaining
limitation and will be checked independently. The baseline results below are
evidence for that comparison, not results for the new representation.

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
