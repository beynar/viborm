# P1 falsification spike: report

Date 2026-09-29. Base `origin/main` `30ff17e69`. Plan under test: `extension-capabilities-v2-plan.md` (§1.1, §3, §5.1 items 1-10, Appendix A). Three disposable lanes; commits on local branches only, nothing pushed:

| Lane | Worktree / branch | Items | Commits |
| --- | --- | --- | --- |
| types | `/Users/arnaud/code/viborm-p1-types` / `p1-types` | 1, 10, type half of 9, budget | `31a1e75f3`..`98e07e9e7` (8) |
| controls | `/Users/arnaud/code/viborm-p1-controls` / `p1-controls` | 2, 8 | `417e3c56f`..`f74f83dfa` (4) |
| engine | `/Users/arnaud/code/viborm-p1-engine` / `p1-engine` | 3-7, runtime half of 9 | `b39cd4380`..`05a22a3fa` (8) |

Labels: **measured** (run in a lane; command and output below) or **judgement** (opinion, basis given). Raw outputs are in `scratchpad/softdelete/p1/{types,controls,engine}/`. This report's recount is `p1/report/codelines-all.txt`.

**Repair pass (2026-09-29, after review).** New probes ran in `/Users/arnaud/code/viborm-review` on local branch `p1-report` (from `98e07e9e7`, the types-lane head): `afe62e16a` replay probe, `3f4181a0a` closure programs. Outputs, probe sources, scratch tsconfigs and backups are in `scratchpad/softdelete/p1/report-repair/`. Re-measured or new: item 1 replay (now FAIL), item 9 closure cost against error-free baselines plus a denser schema (still a §7 breach), per-lane bundle sizes, the framing grep, and the Raptor 3 line count. Relabelled: items 1, 5, 9 and 10; DC8's attribution.

## 0. For the owner: can M1 start?

**No, not yet.** Two measured §7 budget breaches hit stop condition §8.3.7, and one guarantee the plan relies on is refuted. The owner must rule on these three first (§6, decisions 1-3). The rest of the plan survives after the revisions below.

All ten items were tried. No probe needed a soft-delete-specific branch in core, so the framing holds. The grep over every lane's `src` diff finds one hit, a doc comment in a SPIKE file, and no branch (§2). The §1.1 extension compiles at 77 lines with no extra cast. It was never run end to end.

**Blocking (measured):**

A. **The type closure breaks the §7 client budget (§8.3.7; §5.1.9 says stop and ask).** Measured against error-free no-closure baselines: on a 61-model chain the closure costs **+8.13% instantiations** (+1.91% types); on a denser 64-model schema with 122 relations, **+9.75%** (+1.75% types). The budget is +3%. Every one of these programs runs at 91-97% of the 1,280 MB gate heap, with or without the closure. The closure costs nothing on programs that apply no rows extension, which is why none of the six §7 gate programs shows it. Options are in DC21.

B. **The controls-lane slot breaks the §7 client budget (§8.3.7).** It costs +3.5 to +4.3% types and +3.7 to +4.5% instantiations on each of the four client programs. DC8 is the revision. The joined form is unmeasured.

C. **The typing that makes §1.1 compile loses the static replay refusal (§3.6 "measured t2").** To let step B compile, the model factory is declared as a method, which makes it bivariant (DC1). As a result, a definition built for `base` can now be applied to `omitted`. Its result type then shows `secret`, which the runtime omits. If the factory is a plain function type, the refusal comes back, but §1.1 step B stops compiling (`soft-delete.ts(76,29)` TS2345). In the measured designs, the two contracts cannot both hold. See DC22.

**Changes the probes force (accept before M1):**

1. **The typing is more work than "export two helpers".** Making §1.1 compile needed five changes to how the client type is built (measured: each simpler variant failed). They lower instantiations on every test program (−2.05 to −12.55%), but types rise on two of them: client-2 +2.33% and client-3 +1.11%. A side effect: a plugin generic over `C` can no longer write `VibORMClient<C, X>["post"]` (TS2536). It must index the way §1.1 does.
2. **One TypeScript check becomes runtime-only.** A later extension that replaces an earlier extension's model method is refused when it is applied. TypeScript no longer flags it in your editor.
3. **The cache migration breaks more than "patching `cache`".** There are eight observable changes (DC6), including the third type parameter of the public `Client`.
4. **Two engine claims in the plan are wrong** (measured):
   - The upsert fast path must switch itself off under a domain. Otherwise a soft delete that races an upsert gets overwritten.
   - Under `restrict`, a nested junction `delete` is always blocked by its own link.
5. **"Only models that reach a managed model" means, in practice, "every model connected to it".** Ordinary relations always have both sides. Ruling 9 still holds, but it saves less than hoped.
6. **PostgreSQL and MySQL were not run** (docker was down). Restrict atomicity and the live upsert race are measured on SQLite only. On PostgreSQL the restrict check probably needs a row lock (judgement).
7. **The three lanes were never joined.** The extension compiles, and each runtime piece works in its own lane, but nothing ran §1.1 end to end. The combined type cost is unmeasured. Items 1 and 10 are compile-only.
8. **Bundle: only the per-lane base-entry growth is measured.** Controls lane +8.7 KB raw / +2.3 KB gzip; engine lane +7.9 KB / +2.3 KB; types lane 0 (§4.3). The joined base entry, base with the extension, and the soft-delete entry are unmeasured. That makes it an M1 gate item.

**M1 size:** about **2,000-2,250 production code lines** (about 1,614 derived from measured spike code, the rest judgement) and about **4,250 test lines** (judgement). §5 has the build-up. The estimate assumes the closure is kept as built (DC21 option a) or dropped from types (option b). A new closure design (option c) is not in it. The decisions you must take are in §6.

## 1. Per item: verdict, command, observed, contract

Every command runs in its lane's worktree. `V` = `pnpm exec vitest run`. The engine suites run with `--config vitest.spike-p1.config.ts` on sqlite3 in memory.

**Item 1, sequential typing (types lane): PARTIAL, compile-only.** §1.1 compiles, but only with forced core changes. The replay sub-contract FAILS on that typing (measured in the repair pass). 1e is partial. §1.1 was never run. Contract (§5.1.1): §1.1 exactly as written, generic over `C`, in a consumer package. `perModel` keeps keys; `RestoreModels` is accepted with no further cast; `restore` narrows; `defaultOmit` is kept; `deleted` is flagged on unreachable models; replay is refused statically; the 11 driver casts compile; §1.1 is re-counted.

Command: `node node_modules/typescript-native/bin/tsc --project node_modules/.viborm-p1-consumer/tsconfig.json --noEmit`. The consumer is `spike/p1-types/soft-delete.ts` plus `use.ts`. The same command also ran on the root `tsconfig.json`, every `tests/types/*/tsconfig.json` and `node_modules/.viborm-p1-src`.

| Sub | Verdict | Observed |
| --- | --- | --- |
| 1a exports only | FAIL | At `31a1e75f3`: `soft-delete.ts(41,21)` TS2722/TS18048 (`base.$extends` possibly undefined); `(41,26)` TS2349 (resolved to a model delegate). The `$` members sit inside `Omit<…, HasExtensionCache<X> extends true ? …>`. With `X` generic that Omit exposes nothing, so the lookup falls to the model index (`probe1-helpers-only.txt`) |
| 1b `$extends` callable | PASS | `$` members moved to `interface VibORMClientMembers<C,X>` (`client.ts:343-411`); model map deferred by `[C["schema"]] extends [Schema]` (`methods.ts:101-118`). Rejected, measured: `string extends keyof …` broke `untyped-client.core.types.ts:161-179`; `C["schema"] extends Schema` broke `src/cli/utils.ts:197`; no deferral gave TS2589 |
| 1c annotation, no cast | PASS | F-bounded `const Definition extends OfficialAwareDefinition<C,X,Definition>` (`client.ts:199-206, 236, 402-404`). Model keys come from a schema factory table (`definition.ts:315-374`). The factory is declared as a method, so bivariant (`:342-344`); a plain function type fails, measured. `ModelFactoryGuard` becomes a target shape (`methods.ts:191-195`). Cost: pin `extensions.core.types.ts:704` moved to runtime (`8cf5d3fb0`) |
| 1d narrowing | PASS | `Equal<typeof restored, { id: string }>`. `include: { author: true }` gives `author.name: string`. `restoreMany` gives `{ count }` or `{ id: string }[]`. `user.restore` is TS2339 |
| 1e args = update minus `data` | PARTIAL | `restore({ where, data: {…} })` and `restore({ where, wher: {} })` both compile. The body silently overrides the caller's `data` |
| 1f `defaultOmit` kept | PASS | `.secret` is TS2339. `defaultOmit` after softDelete is refused, TS2345 |
| 1g placement | PASS | `deleted` accepted on `user`, `profile` (2 hops), `post` and `tx.post`. Refused (TS2353) on `tag`, `label`, `tx.tag` and the base client. `only` on the ungoverned `user` is TS2322 |
| 1h held values, `mode` | PASS | Held `'onyl'` is TS2345. `user.delete({ mode: 'hard' })` is TS2322. `post.findMany({ mode })` is TS2353 |
| 1i whole repo | PASS | 0 errors at `98e07e9e7` on the root, all `tests/types/*`, and the src program. The driver casts are untouched |
| replay refused | **FAIL** (repair pass) | §1.1 itself never replays: steps A and B stay inside `softDelete`. But plan §3.6 claims static replay refusal for every definition, and DC1 changed the typing that claim rests on. Probe `spike/p1-replay/t2b.ts` is `api/t2.ts` with one change, indexing the generic client as §1.1 does (`M["post" & keyof M]`). Verbatim t2 gives TS2536 at `(31,24)` on the DC1 typing. **At `30ff17e69`:** REPLAY-1 (built for `base`, applied to `omitted`) is refused, TS2345 at `(68,32)`: `Property 'secret' is missing`. **On `p1-report` (DC1 typing):** REPLAY-1 compiles, its `@ts-expect-error` at `:59` is unused, and `unsound()` types `r.secret` as `string`, which the runtime omits. The public-exports probe `replay.ts` agrees (`:66`). **Falsified:** with `ModelMethodFactory` as a plain function type (`definition.ts:342-344`), REPLAY-1 is refused again, and the §1.1 consumer fails at `soft-delete.ts(76,29)` TS2345 plus nine TS2339 on `restore`. REPLAY-2 (built for `omitted`, applied to `base`, the sound direction) compiles on both trees. Outputs: `report-repair/replay-{base,p1types}-*.txt`, `replay-falsify-plainfn.txt` |
| re-count | PASS | 77 lines (`p1/types/soft-delete.verbatim.ts`) |

**Item 2, `cache` migration (controls lane): PASS; the breaking surface is larger than the plan records.** Contract: `cache` is a descriptor control; handlers cannot see or patch it; invalidation is otherwise unchanged.

Commands:
- `V --workspace vitest.workspace.ts --project layer-client tests/contracts/public-client/spike-p1-controls.core.test.ts`
- `--project extended-local …/official-cache-invalidation.test.ts`
- the projects layer-cache, layer-client, layer-query-engine, coverage-extensions and coverage-cache

Observed:
- The baseline was green. After the change: spike test 10/10; invalidation 12/12 (the old `:122-171` is replaced by `:122` and `:172`); layer-client 611/611; everything else green.
- Visibility ledger: `['owner-request:false:{"deleted":"with"}', 'other-request:false:undefined', 'owner-query:false:{"deleted":"with"}', 'other-query:undefined']`.
- A patch that names a control gives QueryError `named control "deleted"`. An async validator gives QueryError `returned a promise`.
- Unplaced or unknown keys (`mode` on findMany, held `{delted}`, `deleted` on the base client, `deleted:'all'`) give ValidationError.
- Falsified: removing the patch refusal turned this test and invalidation `:172` red.
- Before re-pinning, four tests failed. Those failures are the breaking surface (DC6).
- Root tsc passes, apart from `query-interceptors.core.types.ts:40`, re-pinned because the handler context now carries `controls`.

Seams: snapshot `definition.ts:332-420`; chain storage and duplicate refusal `chain.ts:246-303`; `admitControls` `request.ts:485`; patch refusal `request.ts:~316-333`; official cache `cache/extension.ts:67-111, 260`; `prepareMutationCacheInput` deleted (`cache-flow.ts`, −103 code lines).

**Item 3, correlation placement (engine lane): PASS on SQLite.** Command: `V … tests/spike-p1/item3-placement.test.ts tests/spike-p1/item3-dependencies.test.ts` gives 12/12 and 2/2.

Observed (domain vs base):

| Query | Domain | Base |
| --- | --- | --- |
| count | 3 | — |
| groupBy | `[[1,2],[2,1]]` | `[[1,3],[2,4]]` |
| cursor on a hidden anchor | `[]` | `[11,12]` |
| `every in [a,d]` | `[1,4]` | `[4]` |
| negated tagged `_count` | `[0,0,0]` | `[1,1,0]` |
| polymorphic tagged `every` | `[2]` | `[]` |
| recursion, hidden middle node | `{1:[4]}` | `{1:[2:[3],4]}` |

- Falsified: with the domain removed from `correlation()`, 8 of 12 fail. Anchors: `query.ts:788` (`domainSelector`) and `:810` (`candidates`).
- R1 reproduced: an emulated hidden to-one polymorphic arm throws "references a missing 'post' record". That is M2 scope, as planned.

**Item 4, key-preserving conjunction (engine lane): PARTIAL; one plan claim refuted.** Command: `V … tests/spike-p1/item4-unique.test.ts` gives 6/6.
- `candidates()` keeps `uniqueKey`/`uniqueValues`; plain `andSelectors` drops them.
- **Consumer 1 is refuted.** With the key kept, `identityOnly()` stays true and the confirmation read is skipped. A soft delete that lands between the probe and the UPDATE is then overwritten: the tombstone gets title "raced" with `deletedAt` still set. The spike declines the fast path under a domain (`selection.ts:195`, `!this.domained`): the result is NotFoundError, at 4 statements instead of 3.
- Consumers 2 (adoption) and 4 (a hidden conflict gives UniqueConstraintError): PASS.
- ON CONFLICT gate (`commands.ts:1736`): without it, batch-only sqlite runs `INSERT … ON CONFLICT(id) DO UPDATE` and changes tombstone 11 to "folded". With it, the result is UniqueConstraintError.
- **Consumer 3 (a live race converges) is BLOCKED on SQLite.** The injected row rolls back with the operation's region. Only a unit witness exists.

**Item 5, deletion at the four sites (engine lane): PARTIAL. The E7 contract is refuted; everything else passes.** Command: `V … tests/spike-p1/item5-deletion.test.ts` gives 9/9.
- Root SQL: `UPDATE post SET deletedAt=?, deletedById=?, updatedAt=? WHERE ((id=? AND deletedAt IS NULL) AND deletedAt IS NULL) RETURNING …`.
- A delete returns the post-image with the actor set and `updatedAt` refreshed. A repeat gives NotFoundError. No DELETE is issued.
- `include` takes the record route. `deleteMany` gives `{count:2}`, then `{count:0}`. `mode:'hard'` is physical.
- Nested writes: a nested delete keeps the FK in both directions. A nested `deleteMany` issues one UPDATE. A junction `deleteMany` updates per member, keeps the links and shares one `deletedAt`.
- A statement transform sees `{model:comment, operation:delete}`.
- Captured-member re-admission needed 0 lines.
- **E7:** `keyPortabilityRefusal` reacts only to operator records, so it cannot fire on constant scalars (DC16).

**Item 6, one timestamp per call (engine lane): PASS; one wording change.** Command: `V … tests/spike-p1/item6-timestamp.test.ts` gives 5/5.
- Nested record, set mutation and series members share one instant.
- Separate calls in one callback transaction get different instants.
- A full replan re-admits the deletion data twice, both at the same instant (DC15).
- Production lines: 0 beyond the seam (`rows.ts:219`).

**Item 7, restrict eligibility (engine lane): PARTIAL, SQLite only.** Command: `V … tests/spike-p1/item7-restrict.test.ts` gives 9/9.
- Restricted-slot lists: author `[posts]`, post `[comments, tags]`.
- Hard and soft deletes both raise ForeignKeyError.
- A tombstoned child does not block. `deleted:'with'` is still blocked by live children.
- Bulk: one blocked row fails the whole call and nothing is tombstoned.
- The effect's WHERE carries `NOT EXISTS(… comment … deletedAt IS NULL) AND NOT EXISTS(… post_tag …)`.
- Gap: a nested junction `delete` from `tag` succeeds as a hard delete and raises ForeignKeyError as a soft delete (DC13).
- The error message is written by core (`commands.ts:444`).
- PostgreSQL and MySQL atomicity: unmeasured (DC14).

**Item 8, cache key identity (controls lane): PARTIAL.** Cross-process check: `SPIKE_KEYS_OUT=<scratch>/keys-proc{1,2}.json … -t 'key dump'`, run twice, then `cmp`.
- **PASS:** equal declarations give identical keys, across two clients and across two processes (`viborm:cache:r3:d:…:post:findMany:{9101d05bc5924311, …}`).
- **PASS:** four calls wrote three keys, because an absent control and its explicit default share one key. Each mode and each other declaration gets its own key. Falsified by ignoring controls and rows.
- **PASS:** a control value that is not plain data bypasses the cache.
- **PASS:** `$withCache` carries the controls. Reverting `client.ts:394` gives TS2353.
- **FAIL:** unreachable models do not keep the base key. The rows identity keys every model, and the rows control is placed everywhere (`chain.ts:266-268`, `client.ts:456-470`). This over-keys but never under-keys.
- Key composition: `composeCacheKeyArgs`, `client.ts:456`, used at `:774`.

**Item 9, reachable-model placement: runtime PASS. Types FAIL against §7: under §5.1.9 this is stop and ask. The cache half FAILS (item 8). Not integrated.**
- Runtime (`V … tests/spike-p1/item9-placement.test.ts`): placement is `[author, org, pin, post]`. `audit` and `note` report "Unknown key: deleted". `bindRows` runs once per `$extends` (0.95 ms cold).
- A one-sided relation fails schema validation (`[R002] … has no inverse`), so reachability is symmetric (DC4).
- Types: the closure is `controls.ts:74-143`. Comparing models by identity hit **TS2321** on a 61-model chain. It was replaced by shallow result-surface matching (`:100`).
- Cost, closure against no closure. The first-pass numbers were taken against baselines that exited 2: each lacked the closure, so its `@ts-expect-error` placement witnesses were unused (TS2578 at `big.ts(131,3)` and `use.ts(128|130|145,3)`). **Re-measured in the repair pass** against error-free baselines. The no-closure variant replaces `ReachingModels<S, keyof Rows["models"]>` at `controls.ts:223` with `keyof S`, which places `deleted` on every model (`report-repair/noclos.diff`). Its programs are copies without those four directives (`big-noclos.ts`, `use-noclos.ts`, `dense-noclos.ts`). Command: `report-repair/closure-meas.sh`, which runs `node --max-old-space-size=1280 node_modules/typescript/bin/tsc -p node_modules/.viborm-p1-meas/<p>.json --noEmit --extendedDiagnostics` in 3 alternating rounds. All 18 runs exited 0 with 0 errors (`closure-meas.log`):

| Program | Types | Instantiations | Memory used, max (% of 1,280 MB) | RSS median / max (MiB) | §7 (≤ +3%) |
| --- | --- | --- | --- | --- | --- |
| small (`use.ts`, 7 models) | 775,466 → 776,758 (+0.17%) | 3,101,076 → 3,112,870 (+0.38%) | 96.7% → 91.1% | 1442.7 → 1437.6 / 1474.3 | PASS |
| 61-model chain (`big.ts`, 60 edges, 1 governed) | 798,942 → 814,195 (+1.91%) | 3,302,406 → 3,570,731 (**+8.13%**) | 96.1% → 94.7% | 1466.6 → 1477.6 / 1487.7 | **FAIL** |
| 64-model dense (`dense.ts`, 122 relations, 6 governed, 4-model island) | 791,690 → 805,515 (+1.75%) | 3,226,982 → 3,541,674 (**+9.75%**) | 92.4% → 95.6% | 1469.3 → 1505.2 / 1508.0 | **FAIL** |

  - Memory used is dominated by GC timing: the no-closure small program reached the highest value, 96.7%. The first pass's "97.6%" was one run. What is measured is that these programs sit at 91-97% of the gate heap either way. Peak RSS stays under the 1,536 MiB ceiling.
  - Check time rises by 0.3-0.6 s (big 6.56 → 7.11 s, dense 6.32 → 6.76 s, medians).
  - The closure cannot be measured against `30ff17e69`, because §1.1 does not compile there (1a FAIL). The six §7 gate programs apply no rows extension, so they never instantiate the closure. Their PASS rows in §4 say nothing about its cost.
- The cache half fails (item 8).

**Item 10, step A generic with no cast (types lane): PASS, compile-only.** The runtime still rejects the members (`DEFINITION_KEYS`, `definition.ts:49-57`). At `ad7766291` (`probe2-stepA.txt`):
- Before the members existed, `controls`, `rows` and `deletion` each gave TS2322 (not assignable to `never`).
- After, step A has no error.
- The members are typed as plain data (`definition.ts:356-358`, `controls.ts:15-73`), so stop condition 2 is not hit.

**Not covered by any lane:**
- a §1.1 end-to-end run: the types lane's runtime still refuses the new members (`DEFINITION_KEYS` at `definition.ts:49-57` has no `controls`, `rows` or `deletion`), and the engine lane reads rows from a spike registry;
- PostgreSQL and MySQL;
- bundle sizes for the joined base entry, the base with the extension, and the soft-delete entry (only the per-lane base entry is measured, §4.3);
- fast-path benchmarks (the engine's rough bench varied 2-3x, so it is invalid);
- the packaging fixture (D10).

**Regressions (engine lane):**
- layer-client: 601/601.
- layer-query-engine plus write-engine: 813/814. The one failure is `contract-matrix.core.test.ts:325`, which refuses the unclassified spike files.
- raptor3: 2004/2011. Six fail on missing seeds (sparse checkout), and `cs02-structure-measure` is also red on base.

## 2. Framing check: did any probe need a soft-delete-specific branch in core?

**No.** Measured, repair pass: `git diff 30ff17e69 <lane> -- src | grep -E '^\+[^+]' | grep -niE 'soft|deletedAt|deletedBy|tombstone|restore|\bdeleted\b|\bmode\b'` for each lane (`report-repair/framing-grep.txt`).
- One hit for `deleted`: `p1-engine:src/extensions/rows.ts:11`, a doc comment in a SPIKE file ("declaration, typing and admission of `deleted`/`mode`"). It is not a branch.
- There are no hits for soft, deletedAt, deletedBy, tombstone or restore in any lane's `src`.
- `mode` appears only as the generic rows-mode identifier (`rows.models.<model>.<mode>`, `binding.modes`).
- **Engine lane.** It reads definitions from `SPIKE_ROW_EXTENSIONS`, keyed by extension name (`rows.ts:40`). That registry stands in for the public members the other lanes built. Shipped as is, it would trip stop condition 4 (an extension-name special case). `resolveRowScope` (`rows.ts:188-221`) is generic over `by` and `removeWhen`.
- **Controls lane, checked against §8.3.4 (extension-name special case in core).** `p1-controls:src/client/client.ts:649` reads `admitted?.byExtension[OFFICIAL_CACHE_NAME]?.cache` by extension name. That pattern already exists: `30ff17e69:src/extensions/chain.ts:278` (`officialName: OFFICIAL_CACHE_NAME`) and `cache/extension.ts:21`. Judgement: this is the pre-existing official-cache identity, not a new soft-delete special case, so §8.3.4 is not tripped. It does widen a name-keyed read by one site, which the owner may prefer to keep behind the chain's `officialName` seam.
- **Assumptions.** §4.6(a) held (`set-cleanup.test.ts`). A rows client tolerated a statement transform. JSON actor refusal was **not exercised by any lane**.

## 3. Design changes the probes force (plan section → proposed text)

These are measured unless marked otherwise.

**DC1 · §3.6 "Two exported helpers", and D6.** Replace the bullet's first sentence with: "Two exported helpers, and a client type that a plugin generic over the client can call. `ExtensionState` and `ExtendedOperationResult` are exported. The client's `$` members live in an interface outside the extension-state `Omit`. The model map is deferred for a generic config. The model keys of `$extends` are F-bounded and looked up in a per-schema factory table. Model factories are declared as methods, which makes them bivariant. The model-factory guard is a target shape with no conditional types. Each simpler variant failed in P1." In D6, add `client/client.ts` to the owner column. Also record two measured consequences. First, a client generic over `C` cannot be indexed by a literal model key (`VibORMClient<C, X>["post"]` is TS2536; plugins index with `M[K & keyof M]`). Second, the bivariant factory gives up the static replay refusal (DC22).

**DC2 · §3.6, new bullet, and §8.2.** "A later extension's model method that replaces an earlier extension's method is refused when the extension is applied, no longer by TypeScript: a plugin that is generic over `X` cannot prove the collision. Collisions with core operations and `then`, and model keys outside the schema, are still flagged in your editor. Re-pin `extensions.core.types.ts:704`; the runtime refusal stays at `extensions-foundation.core.test.ts:587`."

**DC3 · §1.1 `RestoreArgs`, and §6 "Sequential typing".** Choose one:
- guard the argument with `args: A & Record<Exclude<keyof A, keyof RestoreArgs<C, K, "update">>, never>` (unmeasured);
- export an exactness helper (a third export);
- state in §1.1: "extra keys compile, and `data` is overridden".

Add the witness: "`restore({ where, data })` and a typo are flagged".

**DC4 · §3.1 Placement, D9.** Append: "Ordinary relations always have an inverse (R002), so the closure is symmetric. In practice it is the connected component of a governed model, minus polymorphic variant targets that have no inverse. In types, models are compared by their shallow result surface, because identity comparison overflows the stack on a 60-model chain. As a result, same-shaped models are treated as one: TypeScript may offer `deleted` where the runtime refuses it, never the reverse."

**DC5 · §3.1 Admission, new text.** "The chain stores the declarations. The pending operation owns the admission record and hands it to query contexts through the prepare options. Error classes:
- A value outside `oneOf`, or one that fails its schema, raises a `ValidationError` whose path is the control name.
- An unreadable value, an async or malformed validator, or a validator that throws something other than a VibORM error raises a `QueryError`.
- A `VibORMError` thrown by a validator passes through unchanged."

**DC6 · §3.1 "Breaking change, recorded".** Replace with: "Breaking changes, recorded:
- A request patch that injects or replaces `cache` is refused.
- Request handlers no longer see `cache` in their input.
- An unreadable `cache` getter raises `QueryError`, no longer `CacheConfigurationError`.
- An invalid `cache` now fails before request handlers run, and a throwing request transform no longer stops `cache` from being read.
- The `cache()` value gains a `controls` member.
- Query handler contexts gain an optional `controls`.
- The third type parameter of `Client` and `CachedClient` changes from a boolean to a controls object.
- The validator's message no longer names the operation."

**DC7 · §3.5 Key.** Replace the composition with: "If the chain declares controls or rows, the key is `[preparedArgs, canonical(admitted controls), rowIdentity[]]`; otherwise it is today's key, byte-identical. The rows control resolves to its default at admission. A plain control that is absent is omitted from the key. `appendResolvedExtension` computes the closure from the relation index, and a model outside the closure keeps the base key and path."

**DC8 · §7 Client-program budget.** Add: "The controls slot must not make the model delegate depend on the extension state through the payload type. That form costs +3.5 to +4.3% types and +3.7 to +4.5% instantiations per client program (measured). The types lane as a whole lowers instantiations by 2.05 to 12.55% (measured). M1's first gate measures the joined form." **Judgement, not measured:** that the saving comes from the DC1 interface split. The types-lane candidate `98e07e9e7` also contains the deferred model map, the F-bounded keys and factory table, the `controls`/`rows`/`deletion` members and the closure. The split and the members landed together in `ad7766291`, and no measurement isolates the split.

**DC9 · §3.3 Threading, and Appendix A "Five signatures".** Replace with: "A `Queries` instance is scoped to a row domain. Reads get one per engine view and domain (a WeakMap in `commands/index.ts`); writes get one per context. The order terms need no parameter. `page()` and `cursorCondition()` take a purpose, and `select()` takes a domain."

**DC10 · §4.5, consumer 1.** Replace the fast-path clause with: "the RETURNING confirmation fast path declines under a domain, at the cost of one extra confirmation read. If it were kept, a soft delete landing between the unlocked probe and the UPDATE would be overwritten." The alternative is to put the domain in the found UPDATE's WHERE.
- **Error class (measured):** the upsert that loses this race surfaces **`NotFoundError`** ("No post record found for update"). That matches §6 "Races … the other not-found".
- §4.5 does not state it: "Upsert over a tombstone. Conflicts by default" describes a tombstone present at planning, not one that appears mid-call.
- **Owner decision:** add "an upsert that loses a race to a soft delete surfaces `NotFoundError`" to §4.5. Or re-route it to the create arm, which conflicts on the tombstone and gives `UniqueConstraintError`, consistent with "conflicts by default". The second costs a replan (unmeasured).

**DC11 · §3.3 Unique keys.** Add: "The targeted `ON CONFLICT` fold is reachable only on batch-preparation routes; the gate is needed there."

**DC12 · Appendix A, nested `delete` and `captureSeries`.**
- Nested delete: "The `Deletion` placement gains `values` and updates by identity (`execution.ts:1079`), rather than becoming a record command, so a lax `delete: true` over an empty slot stays a no-op."
- Captured members: "No change needed: an update series mutation re-admits each member through `schema.member`."

**DC13 · §4.3, new rule.** "A nested `delete` keeps its link, so the parent's own membership is excluded from the target's junction requirement."

**DC14 · §4.3 Mechanism** (judgement, unmeasured). "On PostgreSQL under READ COMMITTED, a `NOT EXISTS` inside the UPDATE does not block a concurrent child insert, because `FOR NO KEY UPDATE` and `KEY SHARE` do not conflict. Lock the candidates `FOR UPDATE` before evaluating the requirement." Measure this on PostgreSQL and MySQL.

**DC15 · §3.7 and §6 Ledgers.** Replace "generated data once per occurrence" with "generated data once per occurrence per attempt; a full replan re-admits it with the same timestamp".

**DC16 · §3.2 E7 sentence.** Replace it with: "`assign` and `at` may not name a key field; this is refused at application." That is one guard per invariant; the generated-data guard is dead.

**DC17 · §4.3 and §6 Referential.** Replace "same error class" with "the same class (`ForeignKeyError`) and a core-authored message".

**DC18 · §6 Pagination.** Add: "A cursor anchor outside the domain is treated as a missing anchor, giving an empty page." This is a product choice.

**DC19 · §3.1 Collisions.** Add: "Core argument names are derived from the operation-schema owner." Also: TypeScript flagging `on` on a rows-owned control was not built in P1; it is still to do in M1.

**DC20 · §8.1 Driver row.** Delete it: the 11 driver casts compile unchanged (item 1i).

**DC21 · §5.1.9, §7 and ruling 9: the type closure over budget (stop and ask).** Measured: +8.13% and +9.75% instantiations on the two schema-scale programs (item 9). The options, for the owner:
- **(a) Keep the closure and give it its own budget.** Add a closure gate program to §7: §1.1 over a 40-80 model schema such as `spike/p1-dense/dense.ts`, with the error-free no-closure baseline. Its budget would be about +10% instantiations. That is a ceiling raise, which §7 forbids ("never permission to raise a ceiling"), so only the owner can grant it.
- **(b) Drop the closure from types; keep it at runtime.** This is measured: the no-closure variant is `keyof S` at `controls.ts:223`. Costs: +0 types and instantiations over the no-closure baseline, and 47 fewer production code lines (`controls.ts:74-143`, counted with the token rule, `report-repair/count.mjs`). TypeScript offers `deleted` on every model of a rows client, and the runtime refuses unreachable ones (item 9 runtime: "Unknown key: deleted"). Four type witnesses are lost (`use.ts:128, 130, 145`, `big.ts:131`). Ruling 9's "exact base client surface" then holds at runtime and in the cache path, but not in the editor.
- **(c) A cheaper closure** (judgement, unmeasured). For example: tag each relation's target with its schema key when the schema is built, so the closure never compares result surfaces. `SchemaKeyOf` compares every relation target with every model, which is about models² surface comparisons. That is the likely cost centre (judgement, not profiled). This needs a new probe before it can be budgeted.

**DC22 · §3.6 "Replay into another client is refused statically (measured t2)".** This is refuted on the DC1 typing (item 1, replay row). Replace it with one of:
- "Replay is not refused. A definition built generic over one client and applied to another is typed from the first. §1.1 cannot replay because it binds to its receiving client, and plugin authors must do the same." This states the measured behaviour.
- A per-definition brand that the receiving client must match (unmeasured).
- A runtime replay guard. The plan has none today, and a definition carries no client identity at runtime (`definition.ts` normalizes to a plain object).

The plain-function factory is not an option: it restores the refusal but breaks §1.1 step B (measured).

## 4. Type budget, before → after

**4.1 The §7 gate programs.** TypeScript 5.9.3, `--extendedDiagnostics`, base `30ff17e69`. Both lanes measured the same four client programs, so their numbers can be compared directly.

**Types lane.** It includes the DC1 restructure and the typing for controls, rows, deletion and the closure. None of these six programs applies a rows extension, so the closure is compiled but never instantiated here; its cost is in item 9 and §4.2. It does not include the cache migration. Measured with a 1,280 MB heap, 5 alternating runs per program; all 60 runs exited 0.

| Program | Types | Instantiations | RSS median (MiB) | Max RSS (MiB) | Budget |
| --- | --- | --- | --- | --- | --- |
| schema-only floor | 773,810 → 767,483 (−0.82%) | 3,326,322 → 3,036,993 (−8.70%) | 1419.1 → 1402.0 | 1410.3 | PASS |
| client-1 | 802,129 → 795,875 (−0.78%) | 3,466,692 → 3,177,648 (−8.34%) | 1463.9 → 1468.5 | 1481.8 | PASS |
| client-2 | 850,210 → 870,018 (+2.33%) | 3,871,678 → 3,767,258 (−2.70%) | 1441.7 → 1441.9 | 1457.6 | PASS |
| client-3 | 833,677 → 842,921 (+1.11%) | 3,817,198 → 3,739,074 (−2.05%) | 1416.8 → 1431.2 | 1471.8 | PASS |
| client-4 | 781,169 → 774,850 (−0.81%) | 3,404,399 → 3,115,213 (−8.49%) | 1424.1 → 1419.5 | 1460.9 | PASS |
| instrumentation | 922,065 → 871,707 (−5.46%) | 5,064,021 → 4,428,394 (−12.55%) | 1430.1 → 1426.8 | 1477.4 | PASS |

**Controls lane.** Here the slot runs through `ClientOperationPayload`, with `cache` typed through the slot and `$withCache` threading. Counts come from single runs with a 4,096 MB heap.

| Program | Types | Instantiations | Budget |
| --- | --- | --- | --- |
| floor (its own program) | 920,160 → 930,598 (+10,438) | 5,064,307 → 5,117,955 (+53,648) | PASS |
| client-1 | 802,129 → 831,619 (+3.68%) | 3,466,692 → 3,607,769 (+4.07%) | FAIL (≤ +3%) |
| client-2 | 850,210 → 886,335 (+4.25%) | 3,871,678 → 4,044,987 (+4.48%) | FAIL |
| client-3 | 833,677 → 863,118 (+3.53%) | 3,817,198 → 3,957,197 (+3.67%) | FAIL |
| client-4 | 781,169 → 810,656 (+3.77%) | 3,404,399 → 3,545,437 (+4.14%) | FAIL |

Peak RSS, client-2 only (1,280 MB heap, 5 alternating runs): median 1400.7 → 1414.0 MiB (+13.3), max 1448.6 MiB. PASS.

Reading (judgement):
- The controls lane pays a roughly constant +29.5k types per program in payload plumbing that depends on the extension state `X`.
- Its own ablation without that dependence measured the floor 124k types below base.
- The types lane removes that dependence.
- **The joined form is unmeasured.** Measuring it is the first M1 gate.
- Measured: the types lane lowers instantiations on all six programs but raises types on client-2 (+2.33%) and client-3 (+1.11%). Both are inside the +3% budget.
- The controls lane's four client rows are a **§7 breach** (stop condition §8.3.7), revised by DC8.

**4.2 Closure-exercising programs (repair pass).** The §7 gate set has no program that instantiates the closure. The item 9 table is the only measurement: +8.13% and +9.75% instantiations, a **§7 breach**. Proposed gate addition (DC21a): `spike/p1-dense/dense.ts` against `dense-noclos.ts`.

**4.3 Bundle (repair pass, measured).** Command at each tree: `node scripts/run-node-safe.mjs 1280 300000 node_modules/tsdown/dist/run.mjs && node scripts/measure-bundle.mjs --out <scratch>/<tree>.json`, run in `viborm-review`, detached at each head in turn, with `dist/` removed afterwards. Outputs: `report-repair/bundle/{base,p1-types,p1-controls,p1-engine}.json`, `summary.txt`. Bytes, raw/gzip:

| Fixture | `30ff17e69` | types lane | controls lane | engine lane |
| --- | --- | --- | --- | --- |
| ids-only | 93,221 / 27,891 | +0 / +0 | +0 / −27 | +0 / +0 |
| decimal-only | 93,072 / 27,867 | +0 / +0 | +0 / −13 | +0 / +0 |
| pg-representative | 543,896 / 160,066 | +0 / +0 | +8,738 / +2,294 | +7,930 / +2,255 |
| full | 917,160 / 267,890 | +0 / +0 | +8,611 / +2,490 | +7,930 / +2,266 |

- These figures are for the base entry only. They include spike-only code: the engine lane's `SPIKE_ROW_EXTENSIONS` registry, and the controls lane's hardening gaps.
- The joined base entry, the base with the extension, and the `viborm/soft-delete` entry are unmeasured, because no joined build exists.
- §7 sets no numeric bundle budget, so there is no PASS or FAIL. The summed lane growth, about +16.7 KB raw / +4.5 KB gzip on pg-representative, is an upper-bound guess (judgement: the lanes overlap in `rows.ts`).

## 5. Milestone 1 line estimate

The unit is code-bearing lines in production `src`, counted with the TypeScript token-line rule over all three lanes from `30ff17e69`.

**5.1 Measured, per file (+added/−removed):**
- **types** (+377/−63, net +314):
  - `client/client.ts` +37/−12
  - `client/types.ts` +16/−2
  - `extensions/controls.ts` (new) +237/−0
  - `extensions/definition.ts` +39/−7
  - `extensions/methods.ts` +46/−42
  - `index.ts` +2/−0
- **controls** (+1,032/−172, net +860):
  - `cache/extension.ts` +73/−1
  - `client/client.ts` +77/−25
  - `client/types.ts` +29/−20
  - `extensions/chain.ts` +89/−0
  - `extensions/definition.ts` +239/−0
  - `extensions/methods.ts` +69/−11
  - `extensions/query.ts` +15/−3
  - `extensions/request.ts` +225/−8
  - `extensions/rows.ts` (new) +196/−0
  - `query-engine/cache-flow.ts` +1/−104
  - `query-engine/pending-operation.ts` +12/−0
  - `query-engine/types.ts` +7/−0
- **engine** (+710/−55, net +655):
  - `client/client.ts` +2/−1
  - `extensions/chain.ts` +9/−1
  - `extensions/rows.ts` (new) +190/−0
  - `query-engine/pending-operation.ts` +18/−5
  - `raptor3/commands/commands.ts` +161/−6
  - `raptor3/commands/execution.ts` +12/−2
  - `raptor3/commands/index.ts` +35/−7
  - `raptor3/commands/relation-body.ts` +105/−10
  - `raptor3/commands/selection.ts` +10/−1
  - `raptor3/route/client-route.ts` +6/−3
  - `raptor3/shared/operation-context.ts` +14/−4
  - `raptor3/shared/query.ts` +130/−15
  - `raptor3/shared/row-domain.ts` (new) +18/−0
- **Raw sum: +2,119/−290, net +1,829.**

**5.2 Deduplicated measured base** (the overlaps are judgement; the basis is given for each):

| Part | Net | Basis |
| --- | --- | --- |
| Types lane, kept whole | +314 | measured |
| Controls lane minus type commit `f21e14484` (+136/−33, duplicates the types lane's slot) | +757 | 860 − 103 |
| Engine lane: Raptor 3 only | +443 | measured: `codelines.mjs … 30ff17e69 p1-engine src/query-engine/raptor3` gives +491/−48 (`report-repair/codelines-engine.txt`). Excluded: `rows.ts` (190); `client.ts` +1 (relation index passed to the binding, now under "closure at binding"); `chain.ts` +8 (`SPIKE_ROW_EXTENSIONS` wiring); `pending-operation.ts` +13 (the `resolveRowScope` call site, which duplicates `admitControls` wiring). The last two are now under "joining the lanes" |
| Unique part of engine `rows.ts`: closure 46, restricted slots 28, domain/deletion binding ~25 | ~+100 | per-member counts (`p1/engine/permember.txt`). Drops: registry 26, `resolveRowScope` 33 (duplicates `admitControls`), ~30 of snapshot overlapping controls' `snapshotRows` |
| **Subtotal** | **~+1,614** | |

**5.3 Parts no probe built** (judgement):

| Part | Estimate | Basis |
| --- | --- | --- |
| `deletion` validation at application: `at` type; `assign` not JSON, not `at`, not a key; `eligible` as `where`; one entry per model; copy | +120 to +180 | the controls descriptor snapshot and refusals take about 130 lines |
| `rows` validation: scalar-only `where` (the controls lane's `snapshotRows`, `rows.ts:127-218`, already validates `by`, `default`, models, mode names, root/related and `on`) | +15 to +25 | same basis, where-only |
| Joining the lanes: runtime accepts the new members; chain instead of registry; `cache`/`$withCache` typing on the types-lane slot | +30 to +60 | about 20 cache/withCache lines in `f21e14484`, plus glue |
| Closure at binding feeding the cache key (DC7) | +15 to +25 | wiring only |
| Order guard extended to rows | +5 to +10 | existing guard size |
| Type-level refusals (duplicate or core-named control, `on` on a rows control), derived core names, typed `context.controls` | +40 to +70 | comparable guards in `methods.ts` |
| Verb sentences (6 census sites) | +20 to +30 | Appendix A |
| Nested junction rule (DC13) | +15 to +30 | `requireUnblocked` is 31 lines |
| PostgreSQL/MySQL restrict locking (DC14) | +15 to +30 | unmeasured |
| Hardening spike code: getter error wrapping, SPIKE comments, redundant predicate | +50 to +100 | the controls lane's own note |
| `src/soft-delete/` and its export entry | +65 to +75 | §1.1 is 77 lines, about 60 of them code |
| **Subtotal** | **+390 to +635** | |

**M1 production estimate: about +2,000 to +2,250 net code-bearing lines (1,614 + 390 = 2,004 to 1,614 + 635 = 2,249) across about 25 files.** The file count is the 23 distinct measured files, plus the new `deletion` owner and the soft-delete entry. The Raptor 3 core share is about 520: 443 measured plus about 75 judgement (DC13, DC14, verb sentences). With DC21 option (b), subtract 47. With option (c), add an unmeasured amount. M2 is excluded.

**5.4 Tests** (rough, judgement):
- §6 has **29 M1 rows** containing **109 witness clauses**.
- Measured test sizes in this repo, in lines per test:
  - `official-cache-invalidation.test.ts`: 60
  - `extensions-foundation.core.test.ts`: 42
  - `default-omit-extension.test.ts`: 55
  - spike engine suite: 25
  - spike controls suite: 42
  - type witnesses: about 8
- Build-up:

| Part | Lines |
| --- | --- |
| About 90 runtime clauses × 25-55 | 2,250 to 4,950 |
| About 19 type clauses × 8 | about 150 |
| About 10 new witnesses from the design changes (now including the DC21 gate program and the DC22 replay witness) × 40 | about 400 |
| Re-pins (the cache test, `extensions.core.types.ts:704`, `query-interceptors.core.types.ts:40`, `official-cache-extension.core.test.ts:76`, contract-matrix classification) | about 100 |
| **Total** | **about 2,900 to 5,600, midpoint about 4,250** |

- Judgement: the three providers come from the existing provider matrix, not from copied files.

## 6. Decisions the owner must take before M1

Decisions 1-3 are the blocking ones.

1. **The type closure over budget (DC21, stop condition §8.3.7 / §5.1.9):** (a) a dedicated closure gate with its own budget, which is a ceiling raise only the owner can grant; (b) the closure at runtime only, with `deleted` offered on every model in the editor (measured, +0); or (c) fund a cheaper-closure probe before M1.
2. **The controls-lane budget breach (DC8, §8.3.7):** accept DC8's revision, and make the joined-form measurement the first M1 gate.
3. **Replay (DC22):** accept "not refused; plugins bind to their receiving client", or ask for a brand or runtime-guard probe. The plain-function factory is excluded, because it breaks §1.1.
4. **Accept DC1 and DC2**: the typing restructure, and refusing a later extension's override of an earlier model method when it is applied rather than in the editor.
5. **`restore` extra keys (DC3):** add a guard, add a third export, or document the behaviour.
6. **Placement precision (DC4):** accept that same-shaped models are treated as one, and that placement is effectively the connected component.
7. **Control error classes (DC5).**
8. **The cache breaking list (DC6)**, including the public type parameter and the changelog wording.
9. **Upsert fast path (DC10):** decline under a domain, or put the domain in the found UPDATE's WHERE. Also name the class a race-losing upsert surfaces: `NotFoundError` (measured) or `UniqueConstraintError` via the create arm.
10. **Restrict on PostgreSQL/MySQL (DC14):** lock `FOR UPDATE`, or measure first. Docker is needed either way: items 4 (consumer 3) and 7 are SQLite-only.
11. **Nested junction delete (DC13):** exclude the parent's own link, or refuse the operation.
12. **Hidden cursor anchor gives an empty page (DC18),** and the core-authored restrict message (DC17).
13. **§4.6:** confirm option (a); it was assumed in P1 and held.
14. **Replan wording (DC15).**
15. **JSON actor refusal:** confirm it for M1; no lane exercised it.
16. **Bundle (§7):** set a numeric base-entry budget. Make "base, base with extension, soft-delete entry" an M1 gate item alongside the joined type measurement. Per-lane base-entry growth is measured (§4.3); the rest is not.
17. **Sequencing** (judgement): make the types-lane restructure (DC1) the first M1 unit. Then join the lanes and measure §7, including the closure gate from decision 1, before any engine unit. Basis: the types lane as a whole lowers instantiations. Whether the interface split alone does is not measured (DC8).
