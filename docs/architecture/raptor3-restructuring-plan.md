# Raptor 3 — is it real, and what is the smallest path that proves it

**Date:** 2026-09-01

**Status:** Diagnosis and implementation-grade plan. No production code was changed.

**Supersedes:** the Raptor 3 numbers in
[bundle-size-reduction-plan.md](./bundle-size-reduction-plan.md) §4.1 and §9.1–9.3.
That document remains the owner of Phases A–C; its Phase D section now points here.

**Evidence base:** nine bounded audits (phase census, parameter lifetime,
mega-owner and temporal state, OwnWrite and duplicate compiler, weak values and
execution cascade, adversarial accounting, vertical-slice design, two primary-source
research streams), every decisive finding re-verified by hand against the working tree
at `5988a20e`. Research is filed under
[exa-results/raptor3-research-challenge-2026-09-01.md](../../exa-results/raptor3-research-challenge-2026-09-01.md).
Measurement scripts and the raw audit reports are in the session scratchpad; the
reproducible parts (bundle fixtures, census method) are described in §2 so they can
be re-run.

---

## 1. Verdict

**Raptor 3 is real as a structural program and not real as a bundle program.**

The relation-aware write kernel is large for one reason that the plan named only
partially: **the parent's state was made a copy axis of the verb table instead of an
input to it.** There are six hand-written "public verb → executable behavior"
tables — junction (`RelationJunctionPart.ts:2692`), singular junction inverse
(`RelationJunctionToOnePart.ts:1034`), child-held under a selected parent
(`RecordUpdateCompiler.ts:2403`), child-held under a fresh parent
(`CreateOperation.ts:2346`), child-held under an inline-literal junction target
(`nested-target-parts.ts:346`), and the OwnWrite shadow walk (`OwnWriteSteps.ts:170`)
— plus two polymorphic twins of the parent-held tables (`RecordUpdateCompiler.ts:1571`,
`CreateOperation.ts:1176`) and a private second `connect` leaf for the create root
(`CreateOperation.ts:4129`). Each copy re-binds topology, re-establishes the same
parse-boundary invariants (59 of 93 internal refusals restate a fact the schema already
decided), threads the same stable bag (911 spellings of engine / scope / txMode /
seam / nestedBuilder), and returns to a Part that then re-switches on the verb it
already discharged (the junction owner five times, 55 labels).

That is the structural finding, and it is measured, not felt. But the bytes are not
where the plan put them. Type unions are erased (the two twelve-arm junction unions
are worth 2 gzip bytes); pure dispatch minifies at about 2 bytes per token line;
forwarding parameters at 0.6. The bytes of the 78.6 KB write-kernel counterfactual
live in per-(verb × storage × substrate) statement construction — probes, guards,
race pins, bind-budget chunks, singular-transfer protocol — which survives any design
that keeps the behavior. The plan's base case (4,300 token-lines, 12.2 KB gzip) is
roughly 2× what a behavior-preserving program can deliver; its stretch (19.1 KB) is
not reachable without removing capability; the "20 KB ceiling" was not derived from
anything.

| | plan base | plan stretch | **this plan low** | **this plan base** | **this plan stretch** |
|---|---:|---:|---:|---:|---:|
| physical lines removed | 5,350 | 7,450 | 1,500 | **3,000** | 4,800 |
| parser token-lines removed | 4,300 | 5,980 | 1,130 | **2,240** | 3,600 |
| minified bytes removed | 51.3 KB | 73.7 KB | 13 KB | **25 KB** | 40 KB |
| gzip bytes removed | 12.2 KB | 19.1 KB | 3.2 KB | **6.1 KB** | 9.7 KB |
| share of the 271 KB fixture | 4.5% | 7.1% | 1.2% | **2.2%** | 3.6% |

The adversarial accounting (§7.2) lands lower still — 1,560 token-lines / 4.4 KB base
— because it scores only dispatch scaffolding inside the plan's zones and does not
credit the cross-zone unifications this plan adds (locator union, exact to-one product,
child-held table unification). Treat 4.4 KB as the floor of the base band.

So the decision is not "is 12 KB worth it"; it is "is a kernel with three verb tables
instead of six, zero decision-free re-switches, zero restated parse invariants, no
shadow interpreter, no duplicate compiler, no mutable-after-construction compile
outputs, and no four-mode constructor worth about 3,000 lines and 6 KB". This plan
says yes, and gives the smallest slice that proves or rejects it (§8) before anything
larger is touched. The success metric for Phase D must be re-baselined on the
structural counts in §9, with bytes reported and ratcheted, not promised.

---

## 2. Measured map

### 2.1 Bundle baseline, reproduced

esbuild 0.25.4 from the pnpm store, ESM, minify, tree-shake, node22, one output, gzip
level 9, fixture = bundle-size plan §2.1, `dist` built from `5988a20e`.

| fixture | raw | gzip | plan claim |
|---|---:|---:|---|
| aggregate `s` + one model + `viborm/pg` | 957,177 | 271,052 | 956,782 / 270,809 |
| same, `pg` external | 873,905 | 245,263 | 873,510 / 245,019 |
| `createClient` re-export only | 928,424 | 264,388 | 928,044 / 264,150 |
| empty schema | 928,492 | 264,433 | 928,097 / 264,190 |

All within 0.1%. The plan's baseline is truthful.

### 2.2 Counterfactuals, reproduced and extended

Bundled from `src` through `tsconfig` paths (+1,527 B gzip over `dist`, as the plan
noted) with an esbuild plugin that replaces named modules by throwing stubs.

| bundle | raw | gzip | delta vs baseline |
|---|---:|---:|---|
| src baseline | 959,684 | 272,772 | — |
| nine write shells stubbed (read-only routing) | 637,898 | 194,170 | **−321,786 / −78,602** |
| read + `CreateOperation` only | 909,745 | 261,393 | −49,939 / −11,379 |
| relation kernel stubbed (five Parts, singular transfer, nested-target-parts, series Parts, relation-membership, OwnWrite ×4, JunctionStatements, parser, to-one composition, m2m utils) | 807,512 | 236,717 | −152,172 / −36,055 |
| relation kernel + both record compilers stubbed | 706,981 | 212,456 | −252,703 / −60,316 |

The plan's 324.7 KB / 79 KB counterfactual reproduces (321.8 KB / 78.6 KB). Two
corrections: the eight shells beyond `CreateOperation` cost 11.4 KB gzip, not the 5.5 KB
the plan states; and the split is now known — the relation kernel *excluding* the two
record compilers is 36 KB gzip, the compilers add 24 KB, the shells and routing the rest.
Marginal gzip of write code is 0.24 × minified.

### 2.3 Per-file census

Repo method (`scripts/query-engine-structure.mjs`: parser-owned token lines, functions,
≥5-parameter functions, branch nodes) plus switch/case counts and `bytesInOutput` from
the source-bundle metafile.

| file | lines | token | fn | ≥5p | branch | switch/case | minified | B/token |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| RecordUpdateCompiler.ts | 5,803 | 4,399 | 182 | 15 | 421 | 3 / 25 | 53,395 | 12.1 |
| CreateOperation.ts | 4,315 | 3,164 | 129 | 11 | 342 | 3 / 12 | 38,161 | 12.1 |
| RelationJunctionPart.ts | 3,461 | 3,043 | 165 | 13 | 270 | 5 / 55 | 32,439 | 10.7 |
| OperationExecutor.ts | 3,315 | 2,849 | 145 | 18 | 385 | 0 / 0 | 27,764 | 9.7 |
| RelationWritePart.ts | 1,650 | 1,268 | 54 | 0 | 98 | 0 / 0 | 17,587 | 13.9 |
| UpsertOperation.ts | 1,550 | 1,099 | 53 | 0 | 116 | 0 / 0 | 14,846 | 13.5 |
| RelationJunctionToOnePart.ts | 1,200 | 981 | 42 | 1 | 71 | 3 / 23 | 12,427 | 12.7 |
| RelationUpsertPart.ts | 1,131 | 798 | 33 | 7 | 70 | 0 / 0 | 8,576 | 10.7 |
| relation-membership.ts | 1,047 | 866 | 65 | 10 | 70 | 0 / 0 | 7,316 | 8.4 |
| nested-target-parts.ts | 808 | 699 | 33 | 4 | 42 | 1 / 11 | 7,303 | 10.4 |
| OwnWriteSteps.ts | 754 | 663 | 34 | 1 | 84 | 1 / 7 | 8,235 | 12.4 |
| relation-mutation-parser.ts | 1,190 | 950 | 41 | 1 | 102 | 3 / 28 | 8,291 | 8.7 |
| RelationLinkPart.ts | 520 | 404 | 20 | 1 | 27 | 0 / 0 | 4,681 | 11.6 |
| OwnWriteAnalyzer / Ledger / Relation | 1,114 | 956 | 54 | 3 | 70 | 0 / 0 | 9,397 | 9.8 |
| JunctionStatements.ts | 560 | 485 | 20 | 0 | 54 | 1 / 8 | 6,038 | 12.4 |
| other audited (shared, Update/Delete shells, series, transfer, collection, m2m utils, data builder, to-one composition) | 5,176 | 3,915 | 174 | 9 | 348 | 0 / 0 | 33,916 | 8.7 |
| **total, 26 files** | 32,594 | 25,539 | 1,244 | 94 | 2,464 | 20 / 169 | 286,376 | **11.2** |

Conversion used throughout: one deleted token-line ≈ 11 minified bytes ≈ 2.7 gzip
bytes on average, but see §2.4 — deleted lines are not average lines.

### 2.4 What a deleted line is worth

Measured by deleting exact ranges and re-minifying the 47-file write concat (adversarial
accounting, `marginal-slice.mjs`):

| kind of line | example range | gzip B / token-line |
|---|---|---:|
| type-only union | `RelationJunctionPart.ts:246-306`, `:396-421` (87 tl) | **0.02** |
| pure dispatch switch | `:766-828` compile | 1.9 |
| allocation switch | `:1381-1475` | 2.85 |
| forwarding parameters | executor progressive path (99 lines) | **0.6** |
| per-verb preparation with real decisions | `:2692-3103` buildJunctionParts | 3.7 |
| per-verb SQL / guard bodies | `:831-1343` compileX | 3.2 |

The zone denominators of the plan reproduce exactly (five Part files = 7,962 / 6,494;
compilers = 10,118 / 7,563; OwnWrite = 1,868 / 1,619; nested-target-parts = 808 / 699).
The "183 residual propagation token-lines" cannot be reproduced by any published rule
(61–101 by the rules tried); the parameter audit measures 509 propagation lines outside
the three large owners and 391 inside, of which 271 vanish under an owner — the
majority of propagation lives outside the large owners, contrary to the plan's §9.1
footnote, but it is worth about 0.2 KB either way.

### 2.5 Structural counts (the numbers Phase D should ratchet)

| signal | measured | source |
|---|---:|---|
| verb-shaped switches / case labels on the audited path | 21 / 170 (plan: 18 / 161) | phase census |
| if-chains on verb discriminants / conditions | 36 / 91 | phase census |
| labels that carry no decision the previous form on the same discriminant had not fixed | **66** (`allocatePlan` wrapper, `membershipAddSites`, junction `planning`/`compile`, singular `planning`/`compile`, duplicate polymorphic source table) | phase census §5 |
| hand-written verb → Part tables | **6** (+2 polymorphic twins, +1 private create-root connect leaf) | §1 |
| internal `QueryEngineError` refusal sites in the write path | 93; 59 restate a parse/registry fact, 24 first-knowable, 10 exhaustiveness | weak-values audit §c |
| `[0]` reads of entry/items/targets arrays | 37 (30 with a guard throw three lines away) | weak-values audit §a |
| writers of the to-one (vacate, supplier, modify) classification | 3 (`to-one-composition.ts:72`, `RecordUpdateCompiler.ts:3518`, `to-one-mutation-schema.ts:183`) | weak-values audit §b |
| `CreateOperation` constructor modes / mode-flag tests outside the constructor | 4 / 24 | mega-owner audit A.2 |
| `RecordUpdateCompiler` mutable-after-construction fields (incl. mutated `readonly`) / mode tests | 4 / 36 | mega-owner audit A.1, B |
| private methods with exactly one caller | RUC 40/74, CO 28/51, RJP 31/61 | mega-owner audit |
| stable-bag spellings (engine, StepScope, txMode, seam, nestedBuilder) | 911 on 900 lines, 640 sites | parameter audit |
| executor progressive path: per-run values threaded | 23 of 43 parameter slots, six values, up to six levels | execution audit |
| test files importing write-engine internals / constructing classes / calling planning-compile / asserting literal step ids | 123 / 70 / 55 / 35 | D0 census |

Step IDs surface only in internal-invariant error messages and malformed-result
diagnostics (`OperationExecutor.ts:1584`, `:1936`, `:2004`), never in public results,
instrumentation events or progress metadata: they are private coordinates under D0,
but 13 test files pin about 170 of them, so allocation order is preserved by every unit
below rather than re-pinned.

---

## 3. One verb through every phase

Junction `connect` under an `update` root:
`db.post.update({ where, data: { tags: { connect: [{ id: 1 }, { id: 2 }] } } })`.

```text
validated args
  │
  ├─ P1  relation-mutation-parser.ts:268  switch(kind)
  │      → RelationMutationEntry { kind:"connect", targets:[…,…] }        DECIDES: envelope, kind order, duplicates kept
  │
  ├─ O   UpdateOperation.ts:246 assertUpdateOwnWriteSafety  (BEFORE any Part exists)
  │      → OwnWriteAnalyzer:166 bindRelation (again)
  │      → OwnWriteSteps.ts:170 switch(entry.kind) → :210 processConnect
  │        appendMembership("connect", selector)                          RESTATES: position, membership scope
  │
  ├─ T   RecordUpdateCompiler.ts:2045 bindRelation → position "junction" (:2058)
  │      → :2078 isSingularCollectionInverse? no → buildJunctionParts       DECIDES: storage shape
  │
  ├─ C1  RelationJunctionPart.ts:2692 switch(entry.kind)
  │      → new RelationJunctionPart(scope, {…base, kind:"connect", targets})  DECIDES: nothing for connect (rename)
  │
  ├─ C2  :1386 allocatePlan switch(input.kind)
  │      → JunctionPlan { kind:"connect", slots:[TargetSlot ×2] }          DECIDES: step ids tag.find / tag.guard.exists /
  │                                                                                  tag.connect / tag.delete.child, per slot
  ├─ C4  :516 membershipAddSites switch(plan.kind)   (cardinality "one" only)  DECIDES: nothing new
  │
  ├─ PL  :708 planning switch(plan.kind) → [slot.probe ×2]                DECIDES: nothing new (slot type already says)
  │
  ├─ CM  :773 compile switch(plan.kind) → :831 compileConnect
  │        requireTarget ×2 · batch guards ×2 · junctionInsertMany chunks   DECIDES: guards, chunking, order
  │
  ├─ J   JunctionStatements.ts:130 switch(operation) "junctionInsertMany"  DECIDES: SQL spelling (legitimate adapter seam)
  │
  └─ X   OperationExecutor: step.kind ∈ {read, write, guard, recordSeries}  verb-free
```

Seven dispatches on the same verb after parsing; two decide something (C2 ids, CM
behavior), one restates (O), four rename or re-derive (C1, C4, PL, and the second bind
in O). The same shape recurs on the singular inverse (`:1034 → :293 → :324`) and on
the child-held path (`RecordUpdateCompiler.ts:2403` → `RelationLinkPart` if-chains).

---

## 4. Multiplication patterns, ranked by measured cost

1. **Parent state as a copy axis** (≈1,000 token-lines duplicated). Five verb → Part
   tables where three storage shapes require three. `nested-target-parts.ts:346` is
   `RecordUpdateCompiler.ts:2403` minus transitions and continuity, admitted only for a
   single-literal-key target; `CreateOperation.ts:2346` is the same table with a fresh
   parent; `CreateOperation.ts:4129` is a second `connect` leaf beside
   `RelationLinkPart`. `delete: true → deleteMany [{}]` is spelled at three sites
   (`RelationJunctionPart.ts:2728`, `RecordUpdateCompiler.ts:2639`,
   `nested-target-parts.ts:445`).
2. **Ordinary / polymorphic parallel arms** (≈810 token-lines polymorphic against a
   near-equal ordinary half). `RecordUpdateCompiler` holds six parallel parent-held arms
   on both interpret and compile sides (`:1571-1976`, `:4446-4612`) with the blocker
   stated at `:697-724`; `CreateOperation` unified its emit half (`ParentHeldArm`,
   `:273-313`) but keeps a 284-line parallel interpret arm (`:1176-1459`). The measured
   semantic difference is one locator (per-member FK correlation with rebind vs. a
   single identity member plus a discriminator premise) and where a vacate lands.
3. **Shadow OwnWrite interpreter** (663 token-lines walk + handlers). `OwnWriteSteps`
   re-walks every entry, re-binds topology at eleven decision sites the Parts also
   derive, re-parses nested programs (`OwnWriteAnalyzer.ts:59`, `:85`) that the nested
   `CreateOperation` constructor parses again (`CreateOperation.ts:620`). The ledger's
   invariant is read-after-write in append order over a fork tree with no global-result
   dependency, so it does not need the whole program before the first fact.
4. **Verb retained past its decision point** (66 decision-free labels, 87 zero-byte
   union lines, eight re-switches). Cheap in bytes (§2.4), expensive in change surface:
   adding one junction behavior touches five methods and two unions.
5. **Weak to-one value** (37 `[0]` reads, 59 restated refusals). The parser manufactures
   a plural array at one site (`relation-mutation-parser.ts:1130-1138`) and thirty-seven
   consumers un-manufacture it; the `correlated | unique` and `current | selectors`
   unions exist only because one entry type serves both cardinalities.
6. **Mode-flag constructors and temporal outputs.** Four `CreateOperation` modes
   consulted deep inside the compiler (24 tests); three `RecordUpdateCompiler` fields
   valid only after `compile()` and reset on re-entry (`:1379-1387`) because compile is
   re-entered on race retry; one dead channel (`compiledRootScalarValues`,
   `CreateOperation.ts:499`; its only reader `UpsertOperation.ts:838` sits on a path the
   create-arm branch at `:722-731` has already returned from).
7. **Stable-bag threading** (911 spellings, 271 vanishing lines, ≈0.2 KB). A symptom of
   1–3, not a cause; the plan is right that renaming it `Context` is not a fix.
8. **Progressive-executor cascade** (23 of 43 slots, ≈0.06 KB). Real cohesion debt, no
   byte story; the executor is already verb-free.

---

## 5. Is ELEGANCE.md wrong, or misapplied?

Not wrong. Misapplied in three specific ways.

1. **Owner granularity was set at the file and class.** "One owner per necessary truth"
   was satisfied by having one file called `RecordUpdateCompiler`; inside it live four
   owners (selected row, root assignment, parent-held edges, child-held edges + root
   order) whose data already exist as separate unions and a ledger but whose methods and
   fields were left on one class. ELEGANCE's own rule 4 ("derived from existing truth
   whenever it does not represent an independently changing responsibility") was never
   asked of a *method*.
2. **"The same fact interpreted in multiple places" was not asked across the
   parent-state axis.** Each copy of the verb table was rationalized as a distinct owner
   ("fresh record compiler", "selected record compiler", "junction inline target",
   "OwnWrite legality") when the fact — what verb X does on storage Y — is one fact with
   the parent's state as an input.
3. **ATOM §21 turned the principle into a ban list and thereby preserved the
   duplicate.** Rejecting "lifecycle callbacks around record inserts" and "placement
   booleans for junction attachment" (ATOM §16, §21) removed the only cheap seam that
   would have let the junction owner compose at the real insertion point, and the
   808-line restricted compiler grew in its place. ELEGANCE prefers "composing existing
   owners" to "introducing a new concept"; a staged emission product is the former.

One secondary misapplication: the one-guard-per-invariant rule is enforced by census
only for `UnsupportedOperationError` (8 live sites, ledger + inventory test) while 93
`QueryEngineError` "internal:" sites — 59 of them restating one invariant ("the parser
and this dispatch agree") — sit outside any ledger.

---

## 6. Target ownership model

Everything below either deletes a representation, a re-dispatch, a copy, or a
temporal channel, or it is not in this plan.

### 6.1 The parse boundary publishes exact shapes

- `RelationMutationEntry` stays the canonical to-many entry (it adds real information:
  envelope normalization, current/selectors, correlated/unique, no-op removal).
- For `cardinality === "one"` the parser publishes an **exact to-one product**:
  `{ kind: "single"; intent } | { kind: "composed"; vacate?; supplier; modify? }` with
  single (not plural) payloads. `classifyToOneComposition` becomes its only producer;
  the parent-held re-classification (`RecordUpdateCompiler.ts:3518-3527`) and the
  lattice copy in validation consume it. The `correlated | unique` and
  `current | selectors` unions, `ComposedToOnePayload`, `parentHeldUpdateTarget`,
  `requireCorrelatedToOneTarget`, `requireCurrentTarget`, the 37 `[0]` reads and their
  30 guards disappear by construction.
- The duplicate direct-polymorphic source table (`relation-mutation-parser.ts:1095`,
  byte-identical to `polymorphic-mutation.ts:141`) is deleted.

### 6.2 Three lowering tables, parent state as input

One table per storage shape — parent-held, child-held, junction (the singular inverse
is the junction table with `cardinality: "one"` in the stretch case) — each spelled as
`lower<Storage>(compilation, relation, entry, parentState)` where

```ts
type ParentState =
  | { kind: "fresh";    identity: RecordIdentity; coverage: BeforeParentCoverage }
  | { kind: "selected"; projection: TargetProjection; phase: () => "captured" | "final"; continuity?: … };
```

Each table switches on the exact parsed entry **once** and returns

```ts
interface Lowered {
  readonly part: Part;                                  // existing algebra, verb-free closures
  readonly rootMembership: RootMembershipAssignment | undefined;   // parent-held only
}
```

and, in the same module, a pure `facts<Storage>(relation, entry, family)` that appends
to the caller's `OwnWriteRelation`. Planning and compilation invoke the closures; no
`JunctionMutation`, `JunctionPlan`, `ToOnePlan` arm, or `entry.kind` switch survives
below the table. The record-compiler-specific facts (adopt-vs-current placement, the
transition reroute, the fresh coverage set) are computed *before* the table is called,
as `ChildHeldDispatch` already does today (`RecordUpdateCompiler.ts:836`), and passed
in.

The collection coordinator keeps its `set → connect + clear` rewrite: it rewrites the
parsed entry before the table, which is legal vocabulary.

### 6.3 Two record compilers, each split into its real owners

- **Fresh record**: shell (public parse, terminal, fold, arm legality) separated from
  the record plan, the produced-field publication registry (with a per-compile freeze
  refusing a demand after the INSERT is built — the one missing guard, B.9), and
  emission. Emission returns a **staged product**
  `{ guards, beforeRoot, root, afterRoot }`; the shell concatenates, the junction owner
  composes its join at the seam. `SubOperationOptions`, the four constructor modes,
  `suppressTerminal`, `buildFreshRecordPart`'s shell-with-empty-args, and
  `compiledRootScalarValues` go.
- **Selected record**: selected row, root assignment (the existing
  `FinalAssignmentLedger` absorbs `relationTransitionFinal`, `sharedKeyMembers`,
  `updatedFieldValue`), parent-held edges (data union already at `:610-715`), child-held
  edges + root order. `compile(known)` returns
  `{ steps, finalFieldValues, finalRowKey }`; the tier-(iii) transition values that
  closures capture at construction travel through `known` under
  `planningKey(writeId, field)` instead of a mutated field; `relationTransitionSeed` and
  the reset block at `:1379-1387` go.
- **One `ParentHeldLocator` union** — `{ kind: "foreignKey", correlation } |
  { kind: "polymorphic", edge }` — threaded through the three ordinary interpret arms,
  three compile arms, `planning()` and the probe builder deletes the six polymorphic
  parallel arms (ATOM §7 already names this as the intended direction).

### 6.4 OwnWrite: ledger kept, interpreter deleted, precedence preserved

`OwnWriteLedger` and `OwnWriteRelation` remain the legality owners. Two small
strengthenings make single-walk emission legal without moving any failure:

1. **Deferred construction refusals.** The record compiler's relation loop calls
   `facts` (which may throw the "split these operations" refusal, verified incrementally
   as today) *before* it constructs the Part; a construction-time refusal is caught,
   the walk continues in facts-only mode, and the first captured refusal is raised after
   the walk. Precedence on a double-fault payload is therefore exactly today's (any
   OwnWrite conflict wins over any construction refusal), timing is unchanged (both are
   pre-planning, pre-provider), and no test moves. This is a sequencer rule, not a
   representation.
2. **Recorded reads on a deferred fork.** For an upsert found arm (Parts constructed
   eagerly, legality deferred — `UpsertOperation.ts:478-494`, `:853`) the arm's fork
   records reads as well as writes and `verify()` replays the same `assertIndependent`
   at arm selection. Untaken arms stay inert; the fork machinery already exists
   (`fork`, `checkpoint`, `deltaSince`, `mergeDeltas`).

What is deleted: `OwnWriteSteps.ts` in full, the traversal half of `OwnWriteAnalyzer`,
both re-parse sites, the eleven re-derived topology decisions. What survives, moved
beside the lowering tables: the per-verb fact vocabulary (which is *policy*, not
probes — child-held `set` asserts a membership read even when the nullable-FK path
plans no departing read; deriving facts from probes would silently admit a
`{deleteMany, set}` pair the analyzer refuses today).

### 6.5 `WriteCompilation` — challenged, and demoted

The brief allows a narrow lifetime owner for engine, execution mode, step namespace, and
the two recursive compilation entry points. Measured: it removes 271 propagation lines
(≈0.2 KB), 13 recomputations of a fixed driver fact, four constructions of an identical
seam, and six byte-equivalent `nestedBuilder` closures. It deletes no representation and
no re-dispatch on its own, so **it fails the brief's own keep rule as a standalone
unit**. It is retained only as a byproduct of 6.2/6.3: once the lowering tables and the
staged product exist, the seam, the closures and the mode recomputations have nowhere
else to live. It must not be scheduled first (the plan's D1) and must not carry
relation, payload, planning-known, result, or legality state. Prior art agrees:
rustc keeps `sess` *inside* `GlobalCtxt` and never split it out in regret; the win is
"no temporal fields on the owner", not "fewer fields".

### 6.6 Progressive execution

One per-run owner with the six per-run values as fields (`context`, `driver`,
`bindLimit`, `progress`, `committedWriteSegment`, `writeMayBeVisible`) and the two
derived driver facts; cursor-local values (`runtimeValues`, `inheritedGuards`,
`memberPath`, `memberPhase`, `commitState`, `rootConflict`) stay explicit. It swallows
no relation semantics because the executor has none. Cohesion only; ≈0.06 KB.

---

## 7. Reduction model — non-overlapping zones

Zones are defined by file ranges; a line belongs to exactly one zone; replacement code
is deducted inside the zone that causes it; bytes use the measured density of the
*kind* of line deleted (§2.4), not the file average.

| zone | denominator (ranges) | low | **base** | stretch | gzip B/tl | gzip low / **base** / stretch |
|---|---|---:|---:|---:|---:|---|
| **Z1 junction verb dispatch** | `RelationJunctionPart.ts` unions 199-306, 396-421; switches 510-557, 705-764, 766-828, 1381-1475; wrapper cases in 2692-3103; `RelationJunctionToOnePart.ts` 143-213, 293-342, 905-1156 (≈1,076 tl gross) | 250 | **450** | 750 | 2.4 | 0.6 / **1.1** / 1.9 KB |
| **Z2 OwnWrite interpreter** | `OwnWriteSteps.ts` 1-754; `OwnWriteAnalyzer.ts` 144-405 traversal (≈780 tl gross); ledger, relation, fact vocabulary stay | 120 | **250** | 400 | 2.85 | 0.35 / **0.7** / 1.15 KB |
| **Z3 inline junction target + restricted compiler** | `nested-target-parts.ts` 65-544; `RelationJunctionPart.ts` 200-217, 1761-1849, 1962-2091, 2524-2534, 2558-2637; `nestedBuilder` closures `CreateOperation.ts` 1737-1753, 1846-1862, `RecordUpdateCompiler.ts` 2001-2017, 2117-2133, `PolymorphicCollectionPart.ts` 39/94/203 (≈720 tl gross); staged product costs 60-100 | 250 | **450** | 550 | 3.2 | 0.8 / **1.45** / 1.75 KB |
| **Z4 polymorphic parallel arms** | `RecordUpdateCompiler.ts` 697-748, 1571-1976, 4446-4612, 4631-4677, planning tests in 1167-1197; `CreateOperation.ts` 1176-1459 (≈700 tl gross); locator union costs 100-150 | 250 | **450** | 600 | 3.2 | 0.8 / **1.45** / 1.9 KB |
| **Z5 exact to-one product** | `relation-mutation-parser.ts` 116-145, 1095-1121, 1130-1138; `RecordUpdateCompiler.ts` 3509-3571, 5650-5719; `RelationWritePart.ts` 1445-1455; `RelationJunctionToOnePart.ts` 1169-1177; the 37 `[0]` sites and 30 guards *outside* Z4 ranges (≈330 tl gross); parser product costs 100-150 | 120 | **200** | 280 | 2.7 | 0.3 / **0.55** / 0.75 KB |
| **Z6 shells, compile products, output params** | `CreateOperation.ts` 184-221, 529-701 mode branches, 499/756-758/772/807 dead channel, `emitParentHeldArm`/`compileParentHeldTargets` output-array params, `ChildConnectPart` 4129-4254 (conditional on byte-identical SQL); `RecordUpdateCompiler.ts` 934, 1130, 1348-1372, 1379-1387, 1468; `UpsertOperation.ts` 838 | 100 | **220** | 400 | 3.2 | 0.3 / **0.7** / 1.3 KB |
| **Z7 child-held table unification** | `CreateOperation.ts` 2318-2453 folded into the child-held table with a fresh `ParentState` (stretch only) | 0 | **0** | 250 | 3.2 | 0 / **0** / 0.8 KB |
| **Z8 stable-bag propagation** | 911 spellings / 900 lines across the estate; 271 vanish | 0 | **150** | 250 | 0.8 | 0 / **0.12** / 0.2 KB |
| **Z9 progressive run** | `OperationExecutor.ts` 464-1076, 1419-1476, 2177-2350 (99 forwarding lines measured at 59 gzip B total) | 40 | **70** | 120 | 0.6 | 0.02 / **0.04** / 0.07 KB |
| **total** | | **1,130** | **2,240** | **3,600** | | **3.2 / 6.1 / 9.7 KB** |

Physical ≈ 1.33 × token (the write engine's 34,075 / 25,907); minified ≈ gzip / 0.24.

Overlap rules applied: Z3 owns every `nestedBuilder` and inline-target line even where
it sits in a Z1 or Z6 file; Z5 excludes `[0]` sites inside Z4 ranges; Z6's
`ChildConnectPart` is not counted in Z7; Z8 counts only lines that vanish, never lines
that become `ctx.engine`; OwnWrite fact emission added beside the tables is charged to
Z2, not to Z1.

Why the plan's numbers do not survive: Z2's 800 exceeds the 663-line deletable file;
Z1's 1,650 exceeds the entire gross switch + union + txMode inventory (≈1,015) before
replacement; the plan's own D3 slice (140-240 for three of eleven verbs) extrapolates to
510-880 for the zone, not 1,650; the "20 KB" stretch would need one of: a generic
topology-parametrised lowering replacing five Part families (rejected as a DSL),
collapsing every polymorphic arm including the collection coordinator and singular
transfer (a product decision), dropping the forced-batch spelling (capability loss), or
removing the untaken-arm legality machinery (forbidden). The behavior-preserving ceiling
is 9-10 KB.

---

## 8. The vertical falsification slice

Verbs `connect`, `disconnect`, `set` on a child-held foreign key and a plural junction;
`connect`, `disconnect` on a singular junction inverse (`set` has no case there —
`RelationJunctionToOnePart.ts:1151-1155`). Eight cells. Full per-cell trace, signatures
and pseudo-code are in the slice report; the load-bearing facts follow.

### 8.1 Producer → consumer today

| cell | owner | construction | ids allocated (order) | planning | compile | OwnWrite |
|---|---|---|---|---|---|---|
| FK connect | `RelationLinkPart` (+ `ChildConnectPart` under a create root) | `RecordUpdateCompiler.ts:2480` → `buildToManyLinkParts` `RelationLinkPart.ts:466` | `<c>.find`, `<c>.connect`, `<c>.guard.exists`×N per key-shape group | uncorrelated probe `:157` | `:210` found-all, batch guards, IN-list write | `OwnWriteSteps.ts:210` |
| FK disconnect | `RelationLinkPart` | `:2497` (read source) | same shape; `<c>.find` consumed even for `disconnect: true` (`:130`) | correlated probe `:180` | `:251`; `disconnectAll` one UPDATE | `:229` |
| FK set | `RelationSetPart` | `:2649` → `buildToManySetPart` `RelationWritePart.ts:1594` | per target find/set/guard.exists, then departing/guard.departing/orphan | `:1110` | `:1130` captured rows, departing, split-witness guards, one reparent | `:289` |
| junction connect | `RelationJunctionPart` | `:2693` → `allocatePlan :1387` | per slot find, guard.exists, connect, **delete.child** (consumed for every kind, `:1552`) | `:709` | `:831` requireTarget, guards, `junctionInsertManyWrites` bind-budget chunks | `:210` |
| junction disconnect | same | `:2702` (current → refusal `m2mDisconnectRequiresSelector`) | `<c>.disconnect` per target | none | `:861` idempotent deletes | `:229` (junction skips read) |
| junction set | same | `:2718` | slots, then `set.clear`, `set.insert` | as connect | `:874` clear then chunks; collection rewrites to connect + clear | `:289` |
| singular connect | `RelationJunctionToOnePart` | `:1035` ownerProbe + `junction.insert`; `allocateTransfer :261` (none when pre-vacated) | find, guard.target, junction.insert, then slot.owners/vacate/guard.slot/guard.held | `:294` | `:348` + transfer protocol (`junction-singular-transfer.ts:139-176`) | `:210` |
| singular disconnect | same | `:1048` | `junction.delete` | none | `:624` | `:229` |

### 8.2 Proposed flow

Three functions in one module (`write-engine/relation-link-lowering.ts`):
`lowerChildHeldLink(base, entry, { adoptWrite })`, `lowerJunctionLink(leaf, entry)`,
`lowerSingularInverseLink(context, ownerScope, entry, scope)`, each returning
`{ part, rootMembership: undefined }` with `planning`/`compile` as verb-free closures,
plus `linkFacts(relation, entry, family)` beside them. `JunctionLeaf` is the five fields
`RelationJunctionPart` already holds; ten private leaf helpers (`membershipRead`,
`junctionWrite`, `junctionInsertManyWrites`, `joinInsert`, `capturedSelectorRead`,
`targetPresenceGuard`, `requireTarget`, `capturedRowKeys`, parent/membership literal
spellings) become module functions over it — a move, ≈45 call sites in the remaining
eight verbs gain an argument on the same line, zero token-line change. `sequence(parts)`
is the one local combinator (flat-maps planning and compile) and deletes the caller-side
push loops. Step-id labels and order are reproduced exactly, including the two
consumed-but-unused labels.

### 8.3 Exact spans

Deleted (token-bearing lines, counted with `sed | grep -v comment | wc -l`):

| file | ranges | tl |
|---|---|---:|
| `RelationJunctionPart.ts` | 247-258, 397-404, 517-524+550, 592-631, 709-713 partial+758, 774-784, 831-908, 1387 partial+1395-1411, 1908-1932, 2224-2240, 2693-2726 | 245 |
| `RelationLinkPart.ts` | 46-79, 113-149, 423-457, 466-520 | 128 |
| `RelationJunctionToOnePart.ts` | 166-171, 264-271 partial, 294-297 partial+308+325-328, 348-370, 1035-1054 | 59 |
| `OwnWriteSteps.ts` | 171-176+180-182, 210-252, 289-307 | 65 |
| `RecordUpdateCompiler.ts` | 2480-2516, 2649-2657 | 35 |
| `nested-target-parts.ts` | 347-362, 459-461 | 20 |
| `RelationWritePart.ts` | 1594-1626 (moves into the fold) | 28 |
| **deleted** | | **≈580** |

Added: product + entry type 12; child-held lowering 118; junction lowering 86; singular
lowering 40; parent-held link fact emitters 8 (needed because `processConnect` /
`processDisconnect` also serve the parent-held storage — without them the old case and
the new emitter coexist, which the reject gate forbids); call-site replacements 24 —
**≈290**. Optional: `ChildConnectPart` (`CreateOperation.ts:4129-4254`, ≈110 tl) folds
into `lowerChildHeldLink` only after the `link-in-list-fold.test.ts:497` witness proves
its SQL byte-identical.

### 8.4 Removed representations and cases

- `JunctionMutation` arms connect / disconnect / set; `JunctionPlan` arms connect /
  disconnect / set; `ToOnePlan` arms connect / disconnect; `RelationLinkConfig` union.
- Switch cases: `buildJunctionParts` ×3, `allocatePlan` ×3, `membershipAddSites` ×2,
  `planning` ×3 + ×2, `compile` ×3 + ×2, `buildEntryPart` ×2, `OwnWriteSteps.process`
  ×3, `interpretChildHeldEntry` ×3, `foldJunctionChildHeldEntry` ×3 — 30 labels, 8
  switches touched, 0 new switches below the table.
- OwnWrite traversal: `processConnect`, `processDisconnect`, `processSet` and their
  `process` cases; the walk itself survives until the other eight verbs migrate.

### 8.5 Net and bytes

Net ≈ **−290 token-lines** (−380 with `ChildConnectPart`), ≈ −380 to −470 physical.
Ratio against the migrated surface (≈830 tl touched): 35%, meeting the ≥30% bar without
margin. Predicted bytes at §2.4 densities: ≈ −3 KB minified, ≈ −0.7 KB gzip; the Phase A
fixture measures the truth. The plan's 140-240 band was too low because it omitted
`buildToManyLinkParts`, `membershipInsertWrites` and `junctionInsertManyWrites` becoming
fold-local.

### 8.6 Behavioral tests (the slice's proof obligations)

Public behavior, untouched: `nested-write-behavior.ts` (9 slice tests), `m2m-mutation.test.ts`
(8), `own-write-linearization-behavior.ts` (10), `polymorphic-collection-write-family.test.ts`
(12), `compound-junction.test.ts` (4), `pk-transition-junction-mixed-edge.test.ts` (2),
`staleness-injection-premise-classes.test.ts` (3), `create-many-bind-budget.test.ts:436, 639`,
`own-write-dependency.core.test.ts`, `own-write-ledger.core.test.ts`.

Externally observable implementation, preserved with at most one-line edits:
`link-in-list-fold.test.ts` (27), `polymorphic-write-plan.core.test.ts` (12),
`relation-mutation-scenario-matrix.core.test.ts`, `captured-row-key-decode.core.test.ts`,
`record-compiler-contract.core.test.ts` (18), `relation-junction-singular-coverage.core.test.ts`,
`relation-junction-collection-coverage.core.test.ts`, `relation-write-parity-anchors.core.test.ts`,
the six `parity-*.core.test.ts` files, `nested-series-coverage.core.test.ts`,
`progressive-parent-rowkey.test.ts`; `architecture-gates.core.test.ts:238-256` names
`RelationLinkPart.ts` (one-line edit if the file goes); `parse-boundary-gate.core.test.ts`
ratchets (`as Record` ≤ 6, shape throws ≤ 3) must not move;
`operation-construction-inventory.core.test.ts` must count the same eight sites.

Private coordinates needing rewrite: **0** if allocation order is preserved; 13 files /
≈170 id assertions if it is not.

Deliberate-break falsifiers (each names the test that goes red):

| invariant | break | red test |
|---|---|---|
| singular transfer | drop `membershipAddMode` from the junction lowering | `polymorphic-collection-write-family.test.ts:546` |
| SQL / parameter order | address the FK write by captured PK instead of the caller's key columns | `link-in-list-fold.test.ts:221` |
| failure timing | move `requireFoundAll` after the guards | `link-in-list-fold.test.ts:788` |
| batch guards | emit one grouped guard | `link-in-list-fold.test.ts:273`, `staleness-injection-premise-classes.test.ts:99` |
| lazy untaken arm | apply facts eagerly inside an upsert found arm | `record-compiler-contract.core.test.ts:783` |
| duplicate behavior | stop allocating `<c>.delete.child` for connect slots | `record-compiler-contract.core.test.ts:1301-1319` |
| OwnWrite precedence | construct the Part before applying facts | new double-fault test (§10 P1) |

Plus the census gate: no `connect | disconnect | set` arm in `JunctionMutation` /
`JunctionPlan` / `ToOnePlan`; no `processConnect | processDisconnect | processSet`; no
`switch`/`if` on those three kinds below the lowering table.

### 8.7 What the slice cannot prove

The `rootMembership` channel (all eight cells contribute `undefined`); the adopt family;
staged fresh emission. Its completion record must say so.

---

## 9. Keep and reject gates

A unit is **kept** only when all hold:

1. It names the necessary truth and its first exact owner (§6).
2. At least one of: a union arm, a switch case, a copy of a verb table, a temporal
   field, a constructor mode, a restated refusal, or a duplicate compiler is deleted.
3. Old and new mechanism do not coexist past the unit.
4. A static census proves the migrated verbs and intermediate kinds do not survive past
   their lowering boundary (extend `scripts/query-engine-structure.mjs` with the counts
   in §2.5 and ratchet them: verb-shaped labels 170 → −30 per slice; decision-free
   labels 66 → 0; verb tables 6 → 3; internal refusals 93 → ≤ 34; `[0]` entry reads
   37 → 0; mutable-after-construction compile fields 4 → 0; constructor modes 4 → 1).
5. Token-lines fall; minified and gzip bytes are reported from the Phase A fixture;
   gzip may be inside noise for a sub-kilobyte unit but must not rise.
6. Function / branch / owner counts do not move into a callback, options bag, or
   registry.
7. SQL bytes, parameter order, step-id allocation order, failure type / message /
   timing, transaction and forced-batch behavior, locking, and provider parity are
   unchanged; a private coordinate changes only after D0 proves no runtime, error,
   instrumentation or public consumer observes it.
8. A named falsifier goes red when the new owner is deliberately broken.

A unit is **rejected** when any holds: a migrated verb survives in `JunctionMutation`,
`JunctionPlan`, or `ToOnePlan`; a migrated verb is switched on after direct lowering;
the corresponding `OwnWriteSteps` handler remains; a new persistent Intent / Effect /
Transition / Plan / Context / action union appears; `WriteCompilation` accumulates
relation, payload, known, result, or legality state; token-lines, minified, or gzip
rise; an OwnWrite refusal moves after a provider call or changes precedence; statement
order, transaction, forced-batch, or locking behavior changes; facts are derived from
probes instead of stated (§6.4).

---

## 10. Phased plan, ordered by deletion leverage and risk

Each phase is independently reversible and passes §9 before the next starts. Bytes are
reported per phase against the Phase A fixture; never overlap Vitest and TypeScript
runs.

**P0 — Gates and classification (no deletion).** Land the bundle-size gate (Phase A of
the bundle plan). Extend the structure census with §2.5's counts. Classify the 123
write-engine test files by D0 category; record the 13 id-pinning files. Add the
double-fault error-precedence test (an OwnWrite conflict beside a construction refusal
in a later relation) so §6.4 has a witness before anything moves.

**P1 — Ledger strengthening (enabling; ≈+40 lines).** `OwnWriteLedger` records reads on
a fork and gains `verify()`; the record compilers' relation loops adopt facts-first with
deferred construction refusals. Falsifiers: P0's double-fault test, the found-arm
deferral tests (`record-compiler-contract.core.test.ts:471, 783`). No `OwnWriteSteps`
change yet; this only makes P2's deletion legal.

**P2 — The slice (§8; Z1 + Z2 seed; ≈−290 tl).** Highest information per line: it
proves or rejects direct lowering, single-walk fact emission, and step-id-stable
construction on the three hardest storage shapes. If it lands under §9, continue; if it
lands under the −140 floor or trips a gate, record the rejection and stop Raptor 3 at
P3–P5, which do not depend on it.

**P3 — Staged fresh emission; delete the restricted compiler (Z3; ≈−450 tl, ≈1.45 KB).**
Best leverage per line and lowest semantic risk: the phases already exist
(`CreateOperation.ts:1093-1172`, `:2840-2866`); the junction owner composes
`[…beforeRoot, root, join, …afterRoot]` for the previously-inline shape and
`[…subtree, join]` for the delegated one, keeping `requiresWholeFreshRecordCompiler`
(`RelationJunctionPart.ts:2558`) as the placement predicate. Deletes
`nested-target-parts.ts:65-544`, the inline machinery, `JunctionTargetRelationsBuilder`,
and all six `nestedBuilder` closures. **Product decision offered, not assumed:** unifying
on the delegated order (subtree, then join) deletes the predicate and ≈60 more lines; no
behavior test pins the inline order (only DB-state
`junction-adopt-create-relations.test.ts:292`), but the provider-visible statement order
changes for inline targets with descendants.

**P4 — Parent-held locator union (Z4; ≈−450 tl, ≈1.45 KB).** ATOM §7 names it as the
blocker to remove. Three ordinary interpret arms, three compile arms, `planning()` and
the probe builder take `ParentHeldLocator`; the six polymorphic arms and
`CreateOperation`'s parallel interpret arm go. Retires the two artifact refusals
(`RecordUpdateCompiler.ts:4732`, `:5312`). Risk: the polymorphic `delete` vacate is a
root fold, the ordinary one a statement — the union must carry that as a locator
property, not a verb branch.

**P5 — Exact to-one product (Z5; ≈−200 tl, ≈0.55 KB).** Parser change with the widest
blast radius but the most mechanical: every deleted line is a `[0]`, a guard three lines
below it, or a `find` over kinds. Falsifiers: the to-one lattice files
(`parity-h-to-one-lattice.core.test.ts`, `vacate-then-supply-*`), `decline-surface-gate`.
Also delete the duplicate polymorphic source table.

**P6 — Remaining eight verbs through the tables (Z1 rest; stretch shares leaf helpers
between the junction and singular-inverse owners).** Only after P2 is kept.

**P7 — Shell / record-compiler split, explicit compile products, output parameters, and
`WriteCompilation` as a byproduct (Z6 + Z8; ≈−370 tl, ≈0.8 KB).** Four constructor modes
→ one; `CompiledSelectedRecord`; `known`-carried transition values; delete the dead
scalar channel; absorb the seam and mode recomputations into the owner. This is the
plan's D1 + D2 + D7 collapsed and moved last, because it is the largest test-estate
touch (70 files construct these classes) for the least deletion.

**P8 — Stretch: child-held table unification with a fresh `ParentState` (Z7) and the
progressive run owner (Z9).** Cohesion; report bytes, expect ≈0.9 KB.

Validation per retained unit: narrow falsifiers, then
`pnpm test:layer:query-engine`, the `layer-write-engine` project, adapters, drivers,
client, `pnpm test:types`, `pnpm package:build`, `pnpm size`, `pnpm test:all`;
PostgreSQL and MySQL provider suites for any P2–P6 unit, with skipped legs recorded.

---

## 11. Attractive designs, rejected

- **Universal `Context` / god parameter.** Removes ≈271 lines and hides the cascade;
  Go's own maintainers regret `context.Value`; keeps every re-dispatch.
- **`WriteCompilation` as the first unit (plan D1).** Fails the brief's keep rule
  (deletes no representation or re-dispatch); ≈0.2 KB. Byproduct of P7 only.
- **A transition IR, action union, write graph, or generic visitor.** Would be a fourth
  representation beside three that already re-switch; Prisma's own maintainers call
  their query graph an "unsatisfying in-between"; Kysely's transformer (1,404 lines / 100
  node kinds) is the measured cost of a universal node vocabulary. `Part` and
  `OperationStep` are the algebra.
- **Table-driven / declarative rewriting.** MLIR's DRR documents exactly the shapes it
  cannot express — variadic, multi-result, region-bearing, cross-operand-constrained —
  which is every nested-write expansion.
- **Nanopass-style many small IRs.** Its savings come from a pass generator TypeScript
  lacks; the authors themselves reach for deforestation to fuse the boilerplate away.
- **Deriving OwnWrite facts from the Part's probes.** Silently admits pairs the analyzer
  refuses today (child-held `set` on a nullable FK plans no departing read but asserts a
  membership read). Facts are policy and are stated.
- **Amending ATOM §19 to accept reordered double-fault refusals instead of P1.** Smaller
  code, but it changes failure identity for a reachable payload class; P1 costs ≈40 lines
  and keeps the contract. Offered only if the maintainers prefer the doctrine change.
- **Unifying junction statement order without a product decision.** Provider-visible
  order changes for inline targets with descendants; offered in P3 as a choice.
- **Removing the 59 restated refusals by deletion alone.** They vanish only when the
  exact to-one product makes the state unrepresentable (P5); deleting them first
  weakens a boundary.
- **Dynamic-importing the write engine, a read-only client, per-scalar imports, file
  splitting, stronger minification.** Already rejected in the bundle plan §11; nothing
  here reopens them.
- **Counting erased types, comments, or moved files as reduction.** They are 0 bytes.

---

## 12. Uncertainties and the measurement that resolves each

| uncertainty | resolves with |
|---|---|
| Real byte delta of the slice (predicted −0.7 KB gzip, could be inside noise) | P2 on the Phase A fixture with the metafile diff |
| Whether `processUpdate`'s 84-line read-declaration logic can be stated at the Part (the only route to a Z2 above 400) | P6's `update`/`upsert` migration; until then Z2 base is 250 |
| `ChildConnectPart` SQL byte-identity with `RelationLinkPart` | the `link-in-list-fold.test.ts:497` witness run against a dual-lowering oracle before folding |
| Locator union expressing the vacate-as-fold vs vacate-as-statement difference without a verb branch | P4 prototype on `delete` first |
| Inline-vs-delegated junction order: keep both (predicate stays) or unify (product decision) | maintainer decision at P3; either way the delegated pins (`record-compiler-contract.core.test.ts:1223-1229, 1316-1322`) stay |
| Test-estate cost of P7 (70 files construct shells/compilers) | D0 classification in P0; if more than ≈20 files pin private constructor shapes, P7 is deferred behind a behavior-probe rewrite |
| Whether the 24 first-knowable internal refusals need ledger entries under the one-guard rule | P0 extends the guard-ownership census to `QueryEngineError` internals |
| Compression interaction between phases (gzip is not additive) | ratchet the budget after each retained phase from the measured fixture; never sum predictions |
| The parameter audit's 509 vs the plan's 183 (definition mismatch, not a deletion claim) | irrelevant to bytes (≈0.2 KB); resolved by publishing the counting rule in the census |

---

### Appendix — method

- Bundles: esbuild 0.25.4 (`node_modules/.pnpm/esbuild@0.25.4`), `stdin` fixture,
  `absWorkingDir` = repo, `tsconfig` for source bundles, `write:false`, all non-map
  outputs summed, `gzipSync` level 9. Counterfactuals via an `onLoad` plugin that
  replaces listed modules with throwing exports parsed from their real export names.
- Census: TypeScript AST, token-bearing lines as in `scripts/query-engine-structure.mjs`
  (JSDoc excluded, template tails handled by walking tokens, not the scanner);
  switch/case and class-member counts added.
- Byte density: esbuild `transform` per range, gzip of the 47-file write concat with the
  range deleted (marginal), reported per token-line.
- Audit reports (phase census, parameter lifetime, mega-owner/temporal, OwnWrite and
  duplicate compiler, weak values and execution, adversarial accounting, slice design)
  cite file:line for every claim; the decisive ones were re-read by hand.
