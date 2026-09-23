# Raptor 3 research — challenge-and-extend pass

**Date:** 2026-09-01

Second, adversarial research pass over the 2026-09-01 synthesis in [raptor3-code-reduction-2026-09-01.md](./raptor3-code-reduction-2026-09-01.md). Two workstreams, primary sources only (papers, official docs/repos, first-person maintainer material). Part A covers deforestation limits, pass/traversal fusion, IR lowering legality and single-pass construction; Part B covers lifetime/context ownership, explicit compile products, production nested-write dispatch in ORMs, and counterexamples. The decision codes referenced by both parts are defined at the top of each part. The synthesis that consumes this material is [docs/architecture/raptor3-restructuring-plan.md](../docs/architecture/raptor3-restructuring-plan.md).

---

# Part A — fusion, IR elimination, lowering legality


Scope: primary sources only (peer-reviewed papers, official docs, official repos/source, first-person maintainer writing). Purpose: inform the VibORM nested-write compiler refactor where one parsed mutation entry is re-dispatched by ~6 phases (parse -> bind topology -> allocate plan -> membership sites -> planning -> compile) plus a separate OwnWrite legality analyzer that re-walks the same tree.

Decision codes used below:
(A) delete JunctionMutation/JunctionPlan private carriers by fusing parser->Part construction
(B) fuse OwnWrite fact emission into the Part construction walk, keep the ledger separate
(C) make the public verb illegal after lowering (census test)
(D) return explicit compile products instead of temporal fields
(E) reject a table-driven/visitor design
(F) reject/accept a per-operation compilation owner
(G) limits: where fusion is NOT legal for VibORM (multiple consumers of an entry, ordering effects)

## 0. Method

Search angles tried (24 queries, ~150 results screened, 4 full-page fetches to verify wording):
- Stream 1: Wadler treeless/linear conditions; Gill/Launchbury/Peyton Jones limits section; Svenningsson destroy/unfoldr; Hinze/Harper/James recursive coalgebras; Voigtländer/Johann semantics of fusion under seq / general recursion.
- Stream 2: Sarkar/Waddell/Dybvig ICFP'04; Keep/Dybvig ICFP'13; Miniphases PDF (fetched, section 6 "Soundness and Limitations"); Kiama pure embedding of attribute grammars; Babel visitor merging / plugin ordering (maintainer writing + tracker issue).
- Stream 3: MLIR Dialect Conversion (fetched); MLIR DRR "Strengths and Limitations"; Cranelift ISLE RFC (fetched) + isle-integration.md; Roslyn LocalRewriter/PipelinePhaseValidator source; Swift SIL raw vs canonical.
- Stream 4: rustc-dev-guide query system + steal queries; V8 Maglev design doc / blog + Sparkplug blog; Go cmd/compile README; Zig AstGen.zig source; JastAdd (Hedin/Magnusson SCP 2003); Braun et al. SSA construction CC'13.

### Correction to the prior (2026-09-01) retained set
The prior list attributes "A Short Cut to Deforestation" to Wadler. It is Gill, Launchbury, Peyton Jones (FPCA'93). Wadler's paper is "Deforestation: transforming programs to eliminate trees" (ESOP'88 / TCS 1990). Both are retained below with the correct attribution; they say different things and both matter for (G).

## 1. Retained primary sources (14)

### S1. Wadler — Deforestation: transforming programs to eliminate trees
- Authors/org: Philip Wadler (Glasgow). Year: 1988 (ESOP), TCS 73:231-248, 1990.
- URL: https://doi.org/10.1007/3-540-19027-9_23 (ESOP PDF: https://link.springer.com/content/pdf/10.1007/3-540-19027-9_23.pdf); https://homepages.inf.ed.ac.uk/wadler/topics/deforestation.html
- Type: peer-reviewed paper.
- Gist: Defines treeless form: a term is treeless iff it is linear (no variable used more than once, and no variable in both a case selector and a branch), uses only treeless functions, and every function argument / case selector is a variable. The Deforestation Theorem holds only for linear terms; the paper states explicitly that the algorithm "does not apply to terms that traverse a data structure twice, such as sum xs / length xs". Linearity exists to prevent duplicated work when unfolding.
- Informs: (G) primary statement of the multiple-consumer limit. An entry consumed by both Part construction and OwnWrite is exactly "sum xs / length xs": two consumers of one producer is outside the theorem. Fusion of both consumers into one walk is not deforestation-legal unless the two consumers are first merged into one consumer (tupling), which is what (B) proposes; (B) is therefore the correct shape, but only if the merged consumer stays linear in the entry.

### S2. Gill, Launchbury, Peyton Jones — A Short Cut to Deforestation
- Org: Glasgow. Year: FPCA 1993.
- URL: https://doi.org/10.1145/165180.165214 (PDF mirror: https://users.cs.northwestern.edu/~robby/courses/395-495-2017-winter/deforestation-short-cut.pdf)
- Type: peer-reviewed paper.
- Gist: One local rule, foldr/build, valid only because build's argument is rank-2 polymorphic (free theorem). Its own "limitations" section lists exactly where it fails: (i) consumers that do not treat every constructor uniformly (tail, foldr1) "really need full scale deforestation" and "we should not expect to find short cuts"; (ii) zip: "there seems to be no easy way ... so that both input lists to zip may be deforested" — one input fuses, the other never does; (iii) no fusion across function boundaries unless the producer is inlined, "it seems impossible to do so without changing the type of the result of f".
- Informs: (G) and (A). For (A): fusing parser->Part is legal only if Part construction consumes every entry uniformly (a fold); if some verbs are special-cased by position (first/last sibling, "the connect that follows a create"), the paper says a local rule will not do it and you need the full-blown transformation. For (G): the cross-function-boundary limit is the argument against fusing across a public API seam — fusing changes the type of what the parser returns, which is exactly what (A) accepts as its cost.

### S3. Svenningsson — Shortcut fusion for accumulating parameters & zip-like functions
- Org: Chalmers. Year: ICFP 2002.
- URL: https://doi.org/10.1145/581478.581491
- Type: peer-reviewed paper.
- Gist: Dual rule destroy/unfoldr fuses producers rather than consumers; it removes all intermediate lists for zip-like functions and accumulating-parameter functions (foldl), which foldr/build cannot. But (per S4 and the Oxford thesis "Theory and Practice of Shortcut Fusion" that summarises it) filter — inherently a fold — does not fuse under destroy/unfoldr; neither scheme subsumes the other.
- Informs: (G) and (B). A walk that carries an accumulating ledger (OwnWrite facts) is the foldl / accumulating-parameter case: it fuses when the walk is organised around the producer (the parser's step function), not around a consumer fold. Concretely: (B) is legal if the fact emission is a function of the parser step + accumulator, illegal if the emitter needs to look back at already-built Part siblings (that becomes a zip of two consumers again).

### S4. Voigtländer — Proving Correctness via Free Theorems: The Case of the destroy/build-Rule (PEPM 2008); with Johann & Voigtländer — Free theorems in the presence of seq (POPL 2004) / The impact of seq on free theorems-based program transformations (Fund. Inf. 2009)
- Org: TU Dresden. Year: 2008 / 2004.
- URL: https://janis-voigtlaender.eu/papers/ProvingCorrectnessViaFreeTheorems.pdf ; https://janis-voigtlaender.eu/Voi08a.html ; https://dl.acm.org/doi/10.5555/2367480.2367488
- Type: peer-reviewed papers.
- Gist: In the presence of general recursion and mixed strict/non-strict evaluation the standard rules are only partially correct: destroy/unfoldr "can make a program more terminating than it originally was" and, with seq, can lose termination; for foldr/build "the potentially mixed strict/nonstrict nature of evaluation in Haskell breaks total correctness". Correctness proofs must be redone once effects/evaluation order are in play.
- Informs: (G) primary statement of the effects/ordering limit. VibORM's phases are effectful (allocation of plan ids, ledger appends, error throwing). The fusion theorems assume purity; once a phase observes the order in which earlier phases ran (e.g., an error must be raised before a later entry is allocated), fusing changes observable behaviour. Any fused walk must fix and test error-ordering explicitly.

### S5. Sarkar, Waddell, Dybvig — A Nanopass Infrastructure for Compiler Education
- Org: Indiana University. Year: ICFP 2004.
- URL: https://dl.acm.org/doi/10.1145/1016850.1016878 (PDF: https://www.cs.tufts.edu/comp/150FP/archive/kent-dybvig/nanopass.pdf)
- Type: peer-reviewed paper, first-person by the framework's authors.
- Gist: Micropass compilers (many hand-written small passes) fail on three counts stated by the authors: repetitive traversal code obscures the real transformation; output grammars are documented but not enforced so unhandled cases "fall through to a more general case"; and the compiler is slow. The nanopass fix is a DSL (define-language / define-pass) that generates the boilerplate and enforces the grammar. The authors also state what the generator cannot do: "the sizes of a few passes cannot be reduced. The code generator, for example, must explicitly handle every grammar element", and "the pass expander can fill in missing details only for passes ... insensitive to the order in which the pass recurs on subforms ... not for passes that perform a flow-sensitive analysis". Their proposed future work is "a pass combiner that can, when directed, fuse together a set of passes into a single pass, using deforestation techniques".
- Informs: (E) and (A). This is the direct answer to the stream-2 question: nanopass is NOT a counter-example to "fewer IRs, less code". Its code reduction comes entirely from a macro-level pass generator and enforced grammars; without that generator (TypeScript has no equivalent), you are back in the micropass regime whose failure modes the authors themselves list (boilerplate, unenforced grammars, silent fall-through). And the authors themselves reach for deforestation-style pass fusion as the remedy. For VibORM: without a generator, each extra private carrier (JunctionMutation/JunctionPlan) is micropass boilerplate; fusing is what the nanopass authors would do. Also (E): a hand-written visitor/table per phase is precisely the "micropass" pattern.

### S6. Keep, Dybvig — A Nanopass Framework for Commercial Compiler Development
- Org: Indiana / Cisco. Year: ICFP 2013.
- URL: https://doi.org/10.1145/2500365.2500618 (preprint: https://andykeep.com/pubs/np-preprint.pdf; slides: https://andykeep.com/slides/icfp13.pdf)
- Type: peer-reviewed paper, first-person (Dybvig is Chez Scheme's author).
- Gist: Replaces 5 of Chez Scheme's 10 back-end passes with ~50 nanopasses; compile time stays "within a factor of two", generated code 15-27% faster. The authors say the ICFP'04 committee did not believe nanopass suited commercial compilers, "principally concerned with the compile-time overhead of repeated traversals", and this paper is the rebuttal. The enabling machinery is again the DSL: "Formally defining the intermediate languages allows the framework to fill in boilerplate code in passes, permits passes to check that output-language terms are well formed, and allows the framework to represent language terms as records internally".
- Informs: (E), (A), (C). Confirms S5: many-IR designs are viable only with a generator plus per-IR well-formedness checking. The "check output-language terms are well formed" feature is the nanopass version of (C): a census/legality check that a lowered form no longer contains the input grammar's verbs. If VibORM keeps any phase boundary, it should keep the check, not the boilerplate.

### S7. Petrashko, Lhoták, Odersky — Miniphases (PLDI 2017), section 6 "Soundness and Limitations of Phase Fusion" [extends prior-retained source with its limits]
- URL: https://plg.uwaterloo.ca/~olhotak/pubs/pldi17b.pdf ; DOI 10.1145/3062341.3062346
- Type: peer-reviewed paper, first-person (Dotty compiler authors).
- Gist (verified by fetch): Fusion requires a uniform post-order traversal. A fused miniphase "sees the future": when phase m transforms node t, t's children have already been transformed by all phases fused with m, including later ones. Three sufficient criteria for fusibility: (1) a phase does not break invariants registered by previous phases in the block; (2) it can transform trees whose children were already transformed by future phases; (3) it "does not require that previous phases in the same block have finished transforming the entire compilation unit" — violations are "usually ... due to global data structures outside of the tree". Dotty needs 6 separate traversal blocks; pattern-matching and erasure force splits because they make non-local control-flow / type changes and erasure "has some global assumptions" (all union-type selections eliminated). Only 4 of ~54 phases needed ancestor context and got "prepare" hooks. Soundness is not proven; it is enforced by dynamic checkPostCondition checkers run between phases in the test suite, which localise interaction bugs to the offending phase.
- Informs: (G), (B), (C). (G): criterion 3 is the precise VibORM test — if the OwnWrite analyzer needs the whole tree (e.g., "is this the only writer of column X across all sites?"), it cannot be fused into the construction walk; if it only needs the current node plus an accumulator, it can. (B)'s "keep the ledger separate" is Miniphases' "global data structure outside the tree" — allowed, but it is the thing that forces a traversal split if any later step reads it before the walk finishes. (C): the checkPostCondition-between-phases mechanism is the model for a census test that a public verb no longer survives lowering.

### S8. Sloane, Kats, Visser — A Pure Embedding of Attribute Grammars (Kiama)
- Org: Macquarie / TU Delft. Year: Science of Computer Programming 78(10), 2013 (earlier LDTA 2009 / ENTCS 2010).
- URL: https://eelcovisser.org/publications/2013/SloaneKV13.pdf ; https://inkytonik.github.io/kiama/Attribution ; https://github.com/inkytonik/kiama
- Type: peer-reviewed paper + official project docs.
- Gist: JastAdd-style demand-driven, cached attributes implemented as a library in a host language with no generator; attribute equations are pattern-matching functions; "No explicit traversal is encoded; it is implicit in the dependencies between the attributes." Reference attributes may point into newly built trees, so a translation can be an attribute of the source tree. The authors note the embedding's cost: without grammar knowledge the host type system cannot check completeness (casts on parent references, "better static completeness guarantees" left as future work).
- Informs: (E) and (D). Attribute grammars are the principled alternative to both "visitor per phase" and "one giant fused walk": each fact (OwnWrite legality, plan allocation) is a memoised function of the node, evaluated on demand, with no phase ordering to get wrong. It is embeddable in TypeScript without a generator (unlike nanopass). It supports (D): an attribute is an explicit product keyed by node, not a temporal field mutated by phase k. It argues against (E)'s "visitor" but not necessarily against a table-driven equation set.

### S9. MLIR — Table-driven Declarative Rewrite Rule (DRR), "Strengths and Limitations"
- Org: LLVM/MLIR project. Year: current docs.
- URL: https://mlir.llvm.org/docs/DeclarativeRewrites/ (source: https://github.com/llvm/llvm-project/blob/main/mlir/docs/DeclarativeRewrites.md)
- Type: official doc.
- Gist (exact list): DRR is operation-DAG based, "good at expressing op to op conversions, but not that well suited for, say, converting an op into a loop nest." It "does not have good support for": matching and generating ops with regions; ops with block arguments; matching multi-result ops in nested patterns; variadic operand/result ops in nested patterns; packing/unpacking variadic operands/results during generation; NativeCodeCall returning more than one result. Result types of auxiliary ops cannot be deduced; a custom builder is required. The QuickstartRewrites tutorial adds: "input patterns cannot yet express constraints across multiple operands/attributes."
- Informs: (E). This is the MLIR team's own statement of when a table-driven rewriter is the wrong tool: whenever a rule needs region/scope context, variable arity, multiple results, or cross-operand constraints. VibORM's nested-write entries are all of those (an entry expands into a variable number of statements across scopes, with cross-sibling legality constraints). The table-driven design should be rejected for the expansion step and reserved, if at all, for 1:1 verb-to-verb rewrites.

### S10. MLIR — Dialect Conversion [prior-retained; verified wording for (C)]
- URL: https://mlir.llvm.org/docs/DialectConversion/
- Type: official doc.
- Gist (verified by fetch): Full conversion "is only successful if all operations are properly legalized to the given conversion target. This ensures that only known operations will exist after the conversion process." Ops marked Illegal "must always be converted for the conversion to be successful"; Partial conversion lets unknown ops remain; the framework walks ops in preorder; replacements are applied only if the whole conversion succeeds (transactional).
- Informs: (C). The census test is the ORM analogue of applyFullConversion with the public verb marked Illegal: after lowering, no instance of the public verb may exist. The Partial mode is what VibORM has today (unknown carriers survive), and the doc's transactional "apply only on success" also informs (D): products are returned whole or not at all.

### S11. Roslyn — LocalRewriter + PipelinePhaseValidator (C# compiler source)
- Org: .NET Foundation / Microsoft (dotnet/roslyn). Year: current main.
- URL: https://source.dot.net/Microsoft.CodeAnalysis.CSharp/Lowering/LocalRewriter/PipelinePhaseValidator.cs.html ; https://source.dot.net/Microsoft.CodeAnalysis.CSharp/Lowering/LocalRewriter/LocalRewriter.cs.html
- Type: official repo source.
- Gist: LocalRewriter.Rewrite is one bound-tree walk that discharges syntax forms (using, foreach, lock, ??, switch, string concat, local declarations...) and returns explicit products via out parameters: codeCoverageSpans, sawLambdas, sawLocalFunctions, sawAwaitInExceptionHandler, then feeds SpillSequenceSpiller only if _needsSpilling. Immediately after, PipelinePhaseValidator.AssertAfterLocalRewriting(loweredStatement) visits the tree and fails on any node kind whose DoesNotSurvive(kind) <= completed phase: "Bound nodes of kind {node.Kind} should not survive past {phase}". VisitOutVariablePendingInference throws Unreachable — a form that must have been discharged earlier.
- Informs: (C), (D), (F). (C): this is a shipping compiler's census test, expressed as a per-node-kind "does not survive past phase X" table checked in DEBUG after the lowering walk. (D): the walk's side results are returned explicitly (out params) rather than left as fields on the tree — the "explicit compile products" pattern. (F): one rewriter owns the lowering of all forms per method body; specialised rewriters (Lambda/Iterator/Async) run after it as separate owners only for whole-body state-machine transforms. Corroborated by Swift's SIL.rst: certain instructions "only valid in Raw SIL" and rewritten by the definite-initialization pass; canonical SIL "must not" contain dataflow errors (https://github.com/apple/swift/blob/main/docs/SIL.rst, https://github.com/swiftlang/swift/blob/main/docs/SIL/Instructions.md).

### S12. Bytecode Alliance — RFC: Cranelift ISLE (instruction-selection DSL) + isle-integration.md
- Org: Bytecode Alliance / Cranelift maintainers (Chris Fallin). Year: RFC accepted 2021; integration doc current.
- URL: https://github.com/bytecodealliance/rfcs/blob/main/accepted/cranelift-isel-isle-peepmatic.md ; https://github.com/bytecodealliance/wasmtime/blob/main/cranelift/docs/isle-integration.md ; https://github.com/bytecodealliance/wasmtime/tree/main/cranelift/isle
- Type: official RFC + official repo doc; first-person maintainer design writing (also Fallin's blog https://www.cfallin.org/blog/2023/01-20/cranelift-isle/).
- Gist (verified by fetch): "Single-pass lowering semantics via unrolling": rule chains are inlined ("elaboration") into one decision tree; "we disallow recursion in rewrite rules. This implies a stratification of term constructors: terms of one kind A can rewrite to B, but B cannot rewrite back to A." Evaluation has two phases: the pattern-match phase is fallible; "the expression-evaluating phase is infallible, and must complete once started. This is important because constructors ... may have side-effects, e.g. allocating temporary registers ... we do not want to call into the embedder to produce the final term until we know we have the correct rule". Recursion is broken by external constructors ("get input in reg" marks an instruction used; it "will be lowered later in the scan"). Lowering rules "must always be a pure mapping"; anything stateful is pushed below the rules into Rust glue.
- Informs: (F), (B), (G). (F): ISLE is a per-operation single owner — one entry point per root term, all rules for that term compiled into one function — i.e., accept a per-operation compilation owner, provided the owner is stratified (no verb re-enters an earlier layer). (B): the match/construct phase split is the rule for fusing legality into construction: decide legality (fallible, pure) fully before emitting anything effectful (plan ids, ledger rows). (G): the "lowered later in the scan" escape shows where single-pass fusion stops — an operand shared by multiple consumers is not lowered inline; it is marked and deferred. That is the multiple-consumer limit again, handled by deferral rather than duplication.

### S13. Braun, Buchwald, Hack, Leißa, Mallon, Zwinkau — Simple and Efficient Construction of Static Single Assignment Form
- Org: KIT / Saarland. Year: CC 2013.
- URL: https://doi.org/10.1007/978-3-642-37051-9_6 (PDF: http://c9x.me/compile/bib/braun13cc.pdf ; project: https://compilers.cs.uni-saarland.de/projects/ssaconstr/)
- Type: peer-reviewed paper.
- Gist: SSA is built directly from the AST in one walk with no prior analysis (no dominance / dominance frontiers), the IR is in SSA form even during construction, so "SSA-based optimizations [run] during construction", reducing IR footprint; a post pass restores minimality for irreducible control flow. Implemented in Clang and on par with Cytron's algorithm; 375 LOC vs 1141 LOC.
- Informs: (A), (B). The paper is the existence proof that a producer walk (parser/AST) can construct the final analysed form directly, deleting the intermediate non-SSA CFG carrier (the analogue of JunctionMutation/JunctionPlan), and that analyses can be folded into construction when they depend only on already-built predecessors. Its explicit limit — a fix-up post pass is needed when information arrives after the use (irreducible CFG) — is the (G) case where a fact depends on entries not yet walked.

### S14. V8 team — Maglev design doc + Maglev blog; Sparkplug blog
- Org: Google V8 team. Year: 2021 (Sparkplug), 2023 (Maglev blog), design doc current.
- URL: https://chromium.googlesource.com/v8/v8/+/refs/heads/main/docs/compiler/maglev/compiler-maglev.md (fetched revision: .../0cc5dcf12126.../docs/compiler/maglev/compiler-maglev.md) ; https://v8.dev/blog/maglev ; https://v8.dev/blog/sparkplug
- Type: official repo doc + first-person team blog.
- Gist: Maglev's stated design choices: "Minimize Phases", "Single IR ... from graph building to code generation. There are no multiple tiers of lowering (e.g., JS -> Simplified -> Machine)", "Direct Code Generation" (nodes emit code themselves, no separate instruction selection). But it still needs a prepass over the bytecode "to find branch targets, including loops, and assignments to variables in loop" so that loop phis can be pre-created and "SSA graph generation [can] be a single forward pass, without needing to 'fix up'"; and a separate phase after graph building for loop-phi representation selection, "the same 'back in time' problem". Sparkplug: "the entire compiler is a switch statement inside a for loop", no IR, but "we currently do two passes over the bytecode — one to discover loops".
- Informs: (F), (D), (G). (F): a production team chose one IR and per-node code ownership (each node "knows how to generate the code") — accept a per-operation owner. (G): even a deliberately single-pass design needs a cheap prepass whenever a fact depends on something later in the input (loop back-edges); for VibORM, any OwnWrite fact that depends on a later sibling (e.g., a later disconnect of the same row) forces either a prepass or a deferred fix-up — it cannot be emitted inline.

### S15. Rust compiler dev guide — Queries: demand-driven compilation; The Query Evaluation Model; MIR queries and passes (steal)
- Org: rust-lang compiler team. Year: current.
- URL: https://rustc-dev-guide.rust-lang.org/query.html ; https://rustc-dev-guide.rust-lang.org/queries/query-evaluation-model-in-detail.html ; https://rustc-dev-guide.rust-lang.org/mir/passes.html
- Type: official doc.
- Gist: rustc moved from "a series of passes ... which execute sequentially" to memoised queries: "The key and result must be immutable values", providers must be pure, results form a DAG. Intermediate MIR results are Steal<Body>: a later query takes ownership, and "Before a result is stolen, we make sure to eagerly run all queries that might ever need to read that result. This has to be done manually", with an ICE if a stolen result is read. The guide calls this "not an ideal setup because of the manual intervention needed".
- Informs: (D) and (G). (D): explicit immutable products per query key are the rustc replacement for temporal fields mutated pass-by-pass. (G): the steal mechanism is the documented cost of ordering effects between consumers of one intermediate — exactly VibORM's "entry consumed by phase k then mutated by phase k+1" hazard. Where two consumers of the same product must be ordered, rustc's answer is to run all readers eagerly before the writer and crash on violation, not to fuse.

### S16. Babel — plugin handbook "Merge visitors whenever possible" (Jamie Kyle) + "Babel Plugin Ordering" (Jamie Kyle) + babel/babel issue #5854 "Plugin Ordering (Part 2)"
- Org: Babel maintainers. Year: 2016-2017.
- URL: https://github.com/jamiebuilds/babel-handbook/blob/master/translations/en/plugin-handbook.md ; https://jamie.build/babel-plugin-ordering.html ; https://github.com/babel/babel/issues/5854 ; https://babeljs.io/docs/plugins#plugin-ordering
- Type: first-person maintainer writing + official tracker + official docs.
- Gist: Babel merges all plugin visitors and does one traversal ("Babel is single pass traversal so top level ordering isn't a thing ... mergedVisitors = merge(visitors); traverse(ast, mergedVisitors)"). Consequences stated by the maintainer: there is "no true 'order' of plugins at the top level", ordering exists only per node; plugins that need to run first "race to the bottom" by hooking Program and re-traversing; "There's no real 'fix' to this problem." The tracker issue asks whether "minification/info gathering plugin[s] require a different approach/multiple passes again" because they need to run before/after "everything else".
- Informs: (B), (E), (G). This is the closest real-world analogue to fusing OwnWrite fact emission into the construction visitor in a JS/TS codebase: it works, is the documented best practice for performance, and its known failure is that an "info gathering" consumer that needs whole-tree facts cannot live in the merged traversal. (B) is endorsed for per-node facts; (G) says whole-tree legality stays a separate pass; (E) the merged-visitor model is a single dispatch, not a table per phase.

(Sources S10 Dialect Conversion and S7 Miniphases were in the prior set; they are re-listed because this pass verified additional wording that changes what they support. Net new: 14.)

## 2. Decision map

(A) Delete JunctionMutation/JunctionPlan by fusing parser->Part construction
- For: S13 (SSA built directly from AST, intermediate CFG carrier deleted, 3x less code); S5/S6 (without a pass generator, each extra grammar is unenforced micropass boilerplate; the nanopass authors themselves propose deforestation-style fusion); S2 (fusion across a function boundary requires changing the producer's result type — that is the accepted cost).
- Against / conditions: S1 (legal only if Part construction is a single linear consumer of each entry); S2 (if any verb is positionally special-cased — first/last sibling — a local fusion rule will not express it).
- Verdict: supported, conditional on Part construction being a uniform fold over entries.

(B) Fuse OwnWrite fact emission into the construction walk, keep the ledger separate
- For: S16 (merged visitors, single traversal, per-node facts); S3 (accumulating-parameter fusion is legal when the fact is a function of the current step + accumulator); S12 (decide legality in the fallible match phase before any effectful construction); S7 (the ledger is a "global data structure outside the tree" — allowed).
- Against / conditions: S7 criterion 3 and S16 (any fact needing the whole tree — "is this the only writer of column X across all sites" — cannot be emitted inline); S14 (facts that depend on later siblings need a prepass or deferred fix-up); S1 (two consumers of one entry must be tupled into one consumer, not run twice).
- Verdict: supported for node-local facts; whole-tree legality must remain a separate consumer of the ledger, run after the walk.

(C) Make the public verb illegal after lowering (census test)
- For: S10 (applyFullConversion with the verb marked Illegal: "only known operations will exist after"); S11 (Roslyn's PipelinePhaseValidator "should not survive past" table, run in DEBUG after LocalRewriter; Swift raw vs canonical SIL); S7 (checkPostCondition run between phases localises the phase that reintroduced a form); S6 (nanopass checks output terms are well formed).
- Verdict: strongly supported by four independent production compilers/frameworks; implement as a per-kind "does not survive past" census.

(D) Return explicit compile products instead of temporal fields
- For: S11 (LocalRewriter returns sawLambdas/needsSpilling as out products, not tree fields); S15 (query results immutable, keyed, memoised; temporal mutation needs the manual steal protocol the guide calls not ideal); S8 (attributes are keyed products of nodes); S10 (conversion applies replacements only on whole success).
- Verdict: supported.

(E) Reject a table-driven/visitor design
- Nuanced. Reject a table-driven rewriter for expansion: S9 lists exactly why (regions, variadic, multi-result, cross-operand constraints unsupported). Reject a visitor-per-phase: S5/S6 (micropass boilerplate without a generator), S8 and JastAdd (Hedin/Magnusson SCP 2003, https://doi.org/10.1016/s0167-6423(02)00109-0: aspect/attribute weaving is "a safer and more powerful alternative to the Visitor pattern"). Do NOT reject a single merged dispatch (S16, S12): one switch/decision tree per root term is what every retained single-pass design uses.
- Verdict: reject per-phase visitors and rule tables for expansion; accept one merged dispatch per operation.

(F) Per-operation compilation owner
- For: S12 (one ISLE entry point per root term, all rules for it compiled to one function, stratified so no re-entry into an earlier layer); S14 (Maglev nodes own their own codegen; one IR); S11 (one LocalRewriter owns all local forms per body; separate owners only for whole-body state machines). Go's cmd/compile README (https://go.dev/src/cmd/compile/README) states the same direction: some lowerings "happen before the conversion to SSA due to historical reasons, but the long-term plan is to move all of them here" — one owner.
- Condition: S12's stratification — a per-verb owner must not produce a form that re-enters a public-verb owner (that is what the census in (C) checks).
- Verdict: accept, with stratification enforced by (C).

(G) Where fusion is NOT legal for VibORM
1. Multiple consumers of one entry (S1 linearity; S2 zip; S12 deferral): do not run Part construction and OwnWrite as two walks over the same entry, and do not duplicate the entry to feed both; tuple them into one consumer or defer one.
2. Facts that need the whole tree or later siblings (S7 criterion 3; S14 prepass; S16 "info gathering" plugins; S13 irreducible fix-up): these need a prepass or a post-walk pass over the ledger; inline emission is unsound.
3. Ordering effects (S4 strictness/termination; S15 steal protocol; S12 fallible-match-then-infallible-construct): error emission order and allocation order become observable once fused; either pin the order in the fused walk and test it, or keep the effectful step after all fallible checks.
4. Non-uniform consumers (S2 tail/foldr1): verbs whose meaning depends on sibling position are outside local fusion; they need explicit handling in the single owner, not a rule.
5. Phase splits are normal (S7: 6 traversal blocks in Dotty; S11: LocalRewriter then Spiller then state-machine rewriters): expect at least two walks — construction + legality-over-ledger — and treat any third as a smell.

## 3. Rejected sources (one line each)
- Matt Warren, "Lowering in the C# Compiler" (mattwarren.org, 2017): third-party blog summarising Roslyn folders; replaced by Roslyn source (S11).
- Mitchell Hashimoto, "Zig AstGen / Zig Sema" (mitchellh.com, 2022): high-quality but third-party walkthrough; not maintainer writing. Zig's own AstGen.zig/Zir.zig headers were checked and only confirm a prepass (AstRlAnnotate) exists — folded into (G) point 2 without a separate entry.
- DeepWiki "Zig Compiler Pipeline": auto-generated summary, not primary.
- "Go: Under the Hood" (golang.design) 3.2: secondary textbook; the Go README it cites is used directly.
- ResearchGate / Sciweavers / MaRDI / researchr / dblp mirrors of S1-S6: index pages, not the papers.
- Hinze, Harper, James, "Theory and Practice of Fusion" (IFL 2010): peer-reviewed and correct, but it unifies existing rules under recursive coalgebras and adds no new limit statement beyond S1-S4; noted, not retained.
- Voigtländer FLOPS'08 slides ("Semantics and Pragmatics of New Shortcut Fusion Rules"): slides only; the PEPM'08 paper (S4) is retained instead.
- Ignition blog (v8.dev/blog/ignition-interpreter): about interpreter design, not pass structure.
- "Land ahoy: leaving the Sea of Nodes" (v8.dev, 2025): about IR shape (CFG vs sea of nodes), not about pass fusion; screened, not retained.
- Andrew Kelley "Zig Compiler Internals" (YouTube 2020): stage1 tour, not a design statement on pass structure.
- Swift DebuggingTheCompiler.md: tooling flags only; SIL.rst wording used as corroboration under S11 instead of a standalone entry.
- MLIR Toy tutorial Ch-3/Ch-5: tutorials restating S9/S10; the normative docs are retained.

## 4. Gaps not closed by this pass
- No primary source was found that gives a formal soundness criterion for fusing an analysis walk into a construction walk in an effectful host language; Miniphases (S7) explicitly declines to formalise it and relies on dynamic post-condition checkers. VibORM should do the same: the (C) census plus per-walk post-conditions are the evidence, not a proof.
- Superfusion (PLDI'24) and "Postcondition-preserving fusion of postorder tree transformations" from the prior set were not re-verified here; their claims are consistent with S7's three criteria and should be cited for the "postcondition" vocabulary only.

---

# Part B — ownership, explicit products, production nested-write dispatch


Research date: 2026-09-01. Primary sources only (official docs/repos, papers, maintainer writing). Every file size below was measured by downloading the raw file from GitHub today (`wc -l`), not taken from a search snippet. Raw copies are in `scratchpad/raw/`.

Decision keys used throughout:
(F) per-operation WriteCompilation owner — what it may/may not contain
(D) explicit compile products replacing temporal fields
(H) Prisma-style dispatch-once as the model for direct verb → Part lowering
(I) whether a general write graph/IR is justified at VibORM's scope (3 storage shapes × 11 verbs)
(E) rejecting table-driven/visitor design
(J) progressive-execution per-run session

## Method

26 searches, ~165 results screened, 40 raw files fetched and grepped. Search angles per workstream:

- W1 (5 searches): rustc TyCtxt/GlobalCtxt/Session split; Go team first-person on `context.Value` (blog + golang/go proposals #28342, #21355, #27987, #49189, #33283, #17302); TypeScript `checker.ts` closure rationale; Roslyn `Compilation` immutability; LLVMContext ownership.
- W2 (4 searches): rustc `BlockAnd`/`unpack!`; Cranelift `FunctionBuilder` cursor; "monadic builder"/(cursor,value) products in compilers; LLVM Kaleidoscope insert-point hazard.
- W3 (9 searches + raw fetches): Prisma `query_graph_builder/write/*`, Hasura `RQL.IR.Insert` + `Postgres.Execute.Insert`, PostGraphile nested mutations (v4 plugin, v5 status), EdgeDB/Gel `edgeql/compiler/stmt.py`, Ent `sqlgraph/graph.go`, TypeORM `persistence/*`, MikroORM `unit-of-work/*`, Sequelize `model.js` include-on-create, Drizzle nested-write issues.
- W4 (8 searches): Dotty Miniphases paper; MLIR DRR limitations; Nanopass (Keep & Dybvig ICFP 2013 + dissertation); Babel traverse context/visitor-merge PRs; Roslyn BoundNodes generated visitors; Swift SIL/SILGen; GHC simplifier/inliner; Scala 2 typer "megaphase" (typelevel phases doc, scala-internals thread).

Note on Prisma paths: `query-engine/core/...` no longer exists; commit f645173 "chore: remove query engine (#5685)" renamed everything to `query-compiler/core/...`. Prior research URLs pointing at `query-engine/` are stale.

---

## Retained primary sources (27)

### W1 — What belongs in a context vs explicit parameters

**1. `TyCtxt` / `GlobalCtxt` doc comments — rust-lang/rust, `compiler/rustc_middle/src/ty/context.rs`**
- Org: Rust compiler team. Type: source doc comment + rustdoc. Year: current (main).
- URL: https://github.com/rust-lang/rust/blob/main/compiler/rustc_middle/src/ty/context.rs ; https://doc.rust-lang.org/nightly/nightly-rustc/rustc_middle/ty/context/struct.GlobalCtxt.html
- Gist: `TyCtxt<'tcx>` is a `Copy` handle to `GlobalCtxt` (27 fields: arenas, interners, `sess: &Session`, `dep_graph`, `query_system`, `untracked`, and ~8 memo caches). A `TyCtxt` is obtained by `GlobalCtxt::enter`, which also installs an `ImplicitCtxt` in TLS, but "Explicit access is preferred when possible." The dev guide adds that query results must "(a) not use `RefCell` or other interior mutability and (b) be cheaply cloneable" (https://rustc-dev-guide.rust-lang.org/query.html), and that `'tcx` means "arena-allocated data (or data that lives as long as the arenas)" (https://rustc-dev-guide.rust-lang.org/memory.html).
- Informs: (F). CHALLENGE to the prior framing: there is no "Session vs TyCtxt regret split" in current rustc — `Session` is a *field of* `GlobalCtxt`. The real boundary rustc enforces is (a) lifetime: everything in the owner lives as long as the compilation arena; (b) tracked-vs-`untracked` for incremental purity; (c) memo caches keyed by immutable keys, results with no interior mutability. Anything per-node/temporal (current block, current scope) lives in the MIR `Builder`, not `TyCtxt` (see #7). Translation for VibORM: WriteCompilation may own schema refs, dialect, interners/param allocators, memo caches; it must not own cursors, "current parent id", or phase flags.

**2. TypeScript wiki "Codebase: Compiler: Checker" + issues #45005 and #40937 — microsoft/TypeScript**
- Org: TypeScript team (Ryan Cavanaugh, Andrew Branch). Type: official wiki + maintainer issue replies. Years: wiki current; issues 2021 / 2020.
- URLs: https://github.com/microsoft/TypeScript/wiki/Codebase-Compiler-Checker ; https://github.com/microsoft/TypeScript/issues/45005 ; https://github.com/microsoft/TypeScript/issues/40937
- Gist: The 40k+ line checker is one `createTypeChecker` closure because "Lots of these functions need to know a lot about each other, the top of the function `createTypeChecker` has a set of variables which are global within all of these functions and are liberally accessed. Switching to different files means probably making god objects." Cavanaugh: "The file is this large because it's faster to have more functions in the same closure when sharing state." Branch: "we cannot reduce the amount of code or its conceptual complexity by splitting it into different files."
- Informs: (F). CHALLENGE: a single shared-state owner is not itself the smell; the TS team argues splitting it *creates* god objects. The criterion is whether the state is genuinely shared by everything (checker: yes) or only by one temporal slice (a nested-write cursor: no). Also warns that a size reduction goal is not served by moving code between files.

**3. Go `context` package doc + golang/go #28342 "proposal: context/v2" — Go team**
- Org: Go team (package doc; issue opened by Ian Lance Taylor; comment by Bryan Mills). Type: official API doc + design-discussion issue. Years: doc current; issue 2018–2023.
- URLs: https://go.dev/pkg/context/ ; https://github.com/golang/go/issues/28342
- Gist: Package doc: "Use context Values only for request-scoped data that transits processes and APIs, not for passing optional parameters to functions." Taylor's issue enumerates known pain: "`Context.WithValue` ... is easy to misuse"; "Context values are passed everywhere explicitly, which troubles some people. Some explicitness is clearly good." Mills (Go team), closing the door on a redesign: "I don't mean any of this to say that I wouldn't *like* to redo parts of this API if it were feasible... I just don't think it *is* feasible." Related: #27987 (rename/trim to a `cancel` package) was closed into #28342; #21355 (goroutine-local storage instead of Context) was rejected: "Being explicit in the code tends to be clearer than implicit."
- Informs: (F), (J). Extends prior Go source with first-person Go-team regret. Rule for the owner: it may carry cross-cutting, *optional*, pass-through data (dialect, diagnostics sink, tracing); anything a lowering function cannot work without is a parameter.

**4. Roslyn `Compilation` — dotnet/roslyn `Compilation.cs` + Microsoft Learn "Work with semantics"**
- Org: .NET compiler team. Type: source doc comment + official docs. Year: current.
- URLs: https://github.com/dotnet/roslyn/blob/main/src/Compilers/Core/Portable/Compilation/Compilation.cs ; https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/work-with-semantics
- Gist: "The compilation object is an immutable representation of a single invocation of the compiler. Although immutable, a compilation is also on-demand, and will realize and cache data as necessary. A compilation can produce a new compilation from existing compilation with the application of small deltas."
- Informs: (F), (J). Model: inputs immutable per invocation; derived facts memoized lazily; a "changed" compilation is a *new* object, not mutation. A per-run session (J) fits this shape exactly: immutable inputs + lazy caches, no temporal fields.

**5. `LLVMContext` class doc — llvm/llvm-project `LLVMContext.h`**
- Org: LLVM. Type: header doc. Year: current.
- URL: https://llvm.org/doxygen/LLVMContext_8h_source.html
- Gist: "a container of 'global' state in LLVM, such as the global type and constant uniquing tables ... LLVMContext itself provides no locking guarantees, so you should be careful to have one context per thread." Also holds diagnostic handler and yield callback.
- Informs: (F) (minor). The context is interning + diagnostics; insertion position lives in `IRBuilder` (see #8). Two objects, two lifetimes.

**6. Typelevel "The Phases" doc + scala-internals "Compiler internal typechecker architecture" thread (2014)**
- Org: Typelevel Scala contributors; scala-internals (scalac maintainers). Type: contributor documentation; mailing-list thread. Years: doc current; thread 2014.
- URLs: https://typelevel.org/scala/docs/phases.html ; https://groups.google.com/g/scala-internals/c/Z0kV6iDam0c
- Gist: Phases doc: "namer, packageobjects, and typer (phases 2,3, and 4) are effectively a single phase ... In other cases some phases do more than advertised." Thread: the typechecker is a cake of hundreds of mutually dependent methods; a maintainer reply concedes that adding required interfaces "won't make it significantly smaller, because of the transitive semantic dependencies" and that "if you want to change implicit search competently you need to understand Typer, TypeAssigner and Applications as well." (Author of that reply not verifiable from the archive rendering; treat as maintainer-side, not Odersky-attributed.)
- Informs: (I), (E). The "megaphase" cost is real but the Scala maintainers' own view is that interface-splitting does not shrink it; the fix that worked was Miniphases (#21), i.e., a uniform traversal contract, not more objects.

### W2 — Explicit cursor/value products

**7. rustc MIR construction: `BlockAnd<T>` + `#[must_use]` — rustc-dev-guide + `rustc_mir_build/src/builder/mod.rs`**
- Org: Rust compiler team. Type: dev guide + source. Year: current (file: 1,183 lines).
- URLs: https://rustc-dev-guide.rust-lang.org/mir/construction.html ; https://github.com/rust-lang/rust/blob/master/compiler/rustc_mir_build/src/builder/mod.rs
- Gist (extension over prior research): the type is `#[must_use = "if you don't use one of these results, you're leaving a dangling edge"] struct BlockAnd<T>(BasicBlock, T);` with `into_block()` also `#[must_use]`. The guide states the two function patterns: statement-only functions take a block and return a plain value; functions that may create blocks "take a basic block where their code starts and return a (potentially) new basic block where the code generation ends."
- Informs: (D). The enforcement is the point: the cursor is a *value the type system forces you to consume*, so a forgotten cursor update is a compile error, not a latent wrong-parent bug. In TypeScript the analogue is a readonly product type returned from every lowering function plus a lint against unused results.

**8. LLVM Kaleidoscope tutorial ch. 5 — Control Flow (IRBuilder insert point)**
- Org: LLVM (originally Chris Lattner, 2008; maintained). Type: official tutorial. Year: current.
- URL: https://llvm.org/docs/tutorial/MyFirstLanguageFrontend/LangImpl05.html
- Gist: After `Then->codegen()`: "Codegen of 'Then' can change the current block, update ThenBB for the PHI ... Because calling `codegen()` recursively could arbitrarily change the notion of the current block, we are required to get an up-to-date value for code that will set up the Phi node."
- Informs: (D). This is the canonical statement of the hazard of keeping the cursor in a shared builder: every caller must re-read builder state after every recursive call, and forgetting is silent. It is the "before" picture of which rustc's `BlockAnd` is the "after."

**9. Cranelift `FunctionBuilder` — bytecodealliance/wasmtime `cranelift/frontend/src/frontend.rs`**
- Org: Bytecode Alliance. Type: source + rustdoc. Year: current (file: 2,055 lines).
- URLs: https://docs.rs/cranelift-frontend/latest/cranelift_frontend/struct.FunctionBuilder.html ; https://github.com/bytecodealliance/wasmtime/blob/main/cranelift/frontend/src/frontend.rs
- Gist: The builder *does* keep a mutable cursor (`position: PackedOption<Block>`) and pays for it with a per-block status machine (`Empty/Partial/Filled`, `is_pristine`, `is_filled`) and debug assertions: "you have to fill your block before switching", "you cannot switch to a block which is already filled", "Please call switch_to_block before inserting instructions". `cursor()` hands out a `FuncCursor` "that doesn't need to know about FunctionBuilder at all."
- Informs: (D). The honest counterexample: builder-owned cursors are workable, but only with an explicit status lattice and runtime asserts — i.e., the temporal state comes back as more code. Choose (D) unless you are willing to also write the status machine.

**10. Tahboub, Essertel, Rompf — "How to Architect a Query Compiler, Revisited" (SIGMOD 2018)**
- Org: Purdue. Type: peer-reviewed paper. Year: 2018.
- URL: https://www.cs.purdue.edu/homes/rompf/papers/tahboub-sigmod18.pdf
- Gist: "we demonstrate how intricate compilation patterns that were previously used to justify multiple compiler passes can be realized in one single, straightforward, generation pass." Contrasts DBLAB ("up to 5 intermediate languages and a multitude of intricate compiler passes") with LB2 ("implements all optimizations in a single generation pass, using nothing but high-level programming"), on par with HyPer on TPC-H.
- Informs: (I), (H). Database-domain evidence that a multi-IR pipeline is a choice, not a necessity, even for optimizing query compilers; a direct generation pass with good abstractions matched it.

**11. Peyton Jones & Marlow — "Secrets of the Glasgow Haskell Compiler inliner" (JFP 2002)**
- Org: Microsoft Research / GHC. Type: peer-reviewed paper, first-person. Year: 2002.
- URL: https://www.microsoft.com/en-us/research/wp-content/uploads/2002/07/inline.pdf
- Gist: Many local transformations "are collected together into a single pass, called the simplifier ... There is no separate pass that deals with inlining." On state invalidated by mutation: naively merging two inlining decisions was "a huge, but rather subtle, mistake" because "a's occurrence information was rendered invalid by our decision to inline b"; the attempted fixes "were all complicated, and the result was a bug farm. We finally discovered the three-phase inline mechanism ... It is simple, and obviously correct."
- Informs: (D), (J). Pre-computed facts stored on a shared structure go stale the moment a sibling mutates; the cure was explicit, staged decisions (Pre/Post/CallSite) rather than fixing up cached fields. Also a first-person defence of one big pass (I) when transformations cascade.

### W3 — Nested-write dispatch in production ORMs

**12. Prisma — `prisma-engines/query-compiler/core/src/query_graph_builder/write/nested/mod.rs` (+ siblings)**
- Org: Prisma. Type: source. Year: current (main).
- URLs: https://github.com/prisma/prisma-engines/blob/main/query-compiler/core/src/query_graph_builder/write/nested/mod.rs ; .../write/nested/create_nested.rs ; .../write/utils.rs ; https://github.com/prisma/prisma-engines/blob/main/query-compiler/core/src/query_graph/mod.rs
- Dispatch: `connect_nested_query` is a single `match field_name` with 11 arms — `create, createMany, update, upsert, delete, connect, disconnect, set, updateMany, deleteMany, connectOrCreate` — exactly VibORM's verb set. Each arm calls one function; the verb is never re-switched later. BUT each verb file then switches on **storage shape** (create_nested.rs L55–109: `is_many_to_many` / `is_one_to_many` + `relation_is_inlined_in_child` / else 1:1 → `handle_many_to_many`, `handle_one_to_many`, `handle_one_to_one`, plus bulk variants). So the code is an 11-verb × 3-shape matrix written out by hand.
- IR: yes — a petgraph `QueryGraph` with `Node::{Query, Flow(If/Return), Computation, Empty}` and typed edges, interpreted afterwards. Maintainer comment in `query_graph/mod.rs`: "Todo this strongly indicates that the query graph has to change, probably towards a true AST for the interpretation, instead of this unsatisfying in-between of high-level abstraction over the incoming query and concrete interpreter actions."
- Size (measured): `write/nested/` = 3,227 lines over 9 files (connect_or_create 868, connect 590, create 570, set 340, upsert 267, disconnect 213, update 163, delete 162, mod 54); `write/` total incl. top-level verbs and `utils.rs` (1,139 lines, mostly emulated referential actions) = 5,561; `query_graph/mod.rs` = 1,150. Roughly 6.7k lines for the write side of 11 verbs × 3 shapes, plus the interpreter (not counted).
- Informs: (H), (I). (H): dispatch-once is confirmed and is the right model. (I): the maintainers themselves call the graph IR "unsatisfying"; and Prisma's line count is dominated not by the graph but by per-verb-per-shape handlers and referential-action emulation — the same axis VibORM must budget.

**13. Hasura — `Hasura.RQL.IR.Insert` + `Hasura.Backends.Postgres.Execute.Insert`**
- Org: Hasura. Type: source (Haddock + GitHub). Year: current (master).
- URLs: https://github.com/hasura/graphql-engine/blob/master/server/src-lib/Hasura/RQL/IR/Insert.hs ; https://github.com/hasura/graphql-engine/blob/master/server/src-lib/Hasura/Backends/Postgres/Execute/Insert.hs ; https://hasura.io/docs/2.0/mutations/postgres/insert/
- Dispatch: only one verb (insert, with `on_conflict` upsert). The IR is a plain tree: `AnnotatedInsertField = AIColumn | AIObjectRelationship | AIArrayRelationship` (159-line module; its header: "What makes this specific mutation tricky is that we support recursive insertions, across local relationships"). Execution (`insertObject`, 483-line module) is direct recursion, no graph: partition object relationships by `riInsertOrder` into `beforeInsert`/`afterInsert`; run `insertObjRel` for the before-set and collect FK columns; insert the row via CTE; then `insertArrRel` for array rels and after-parent object rels, passing the parent's key columns down as `additionalColumns`. M2M is expressed as array-rel → object-rel nesting (docs describe the 4-step order). Verb decided once at schema-parse time (`mkDefaultRelationshipParser`); execution re-switches only on relationship *kind* (object vs array), never on verb.
- Size: IR 159 + Translate 121 + Execute 483 = 763 lines for the PG backend nested insert.
- Informs: (H), (I). Direct emission with a before/after partition handles all three storage shapes for the create verb in <800 lines. The explicit product is `(affectedRows, Maybe ColumnValues)` returned up the recursion, not a mutable context.

**14. Ent — `dialect/sql/sqlgraph/graph.go`**
- Org: ent (Facebook/Ariga). Type: source. Year: current (2,076 lines).
- URL: https://github.com/ent/ent/blob/master/dialect/sql/sqlgraph/graph.go
- Dispatch: generated `createSpec()` per entity builds a `CreateSpec{Fields, Edges}`; `creator.node` groups edges once with `EdgeSpecs.GroupRel()` into a `map[Rel][]*EdgeSpec` (O2O/O2M/M2O/M2M), then: `setTableColumns` (FK-held edges become insert columns), `insert`, `addM2MEdges(edges[M2M])`, `addFKEdges(append(edges[O2M], edges[O2O]...))`. Verbs on edges are only add/remove IDs (no nested create/update/upsert). Direct SQL emission, no IR.
- Informs: (I), (H). Three storage shapes handled by a single classification into a `Rel`-keyed map computed once, then three emitters. This is the cheapest correct shape-dispatch found.

**15. TypeORM — `src/persistence/*`**
- Org: TypeORM. Type: source. Year: current.
- URLs: https://github.com/typeorm/typeorm/blob/master/src/persistence/EntityPersistExecutor.ts ; .../SubjectExecutor.ts ; .../subject-builder/{Cascades,OneToMany,OneToOneInverseSide,ManyToMany}SubjectBuilder.ts ; .../Subject.ts
- Dispatch: verbs are implicit (save/remove/soft-remove/recover; changes are diffed against loaded DB entities). Builds an IR: a flat `Subject[]` graph with `changeMaps`, then `SubjectTopologicalSorter` for inserts and deletes; `SubjectExecutor` recomputes update subjects after inserts ("insertion can create updation operations for the properties it wasn't able to handle on its own"). Per-relation-kind builders (1:m, 1:1 inverse, m:m) each mutate the shared subject list. Comment in `ManyToManySubjectBuilder`: "this is temporary solution, later we need to implement proper sorting of subjects before their removal."
- Size (measured): EntityPersistExecutor 215 + SubjectExecutor 1,130 + Subject 336 + Cascades 174 + OneToMany 231 + OneToOneInverse 185 + ManyToMany 306 = 2,577 lines.
- Informs: (I). The IR exists *because* verbs are implicit and order must be discovered by diffing and toposort. With explicit verbs (VibORM), that justification disappears.

**16. MikroORM — `packages/core/src/unit-of-work/*`**
- Org: MikroORM (B4nan). Type: source + commit message. Year: current.
- URLs: https://github.com/mikro-orm/mikro-orm/blob/master/packages/core/src/unit-of-work/UnitOfWork.ts ; .../ChangeSetComputer.ts ; .../ChangeSetPersister.ts ; .../CommitOrderCalculator.ts ; commit 02303e8 (2026-04-08)
- Dispatch: implicit verbs via `ChangeSetComputer` (diff vs snapshot); five change-set types `CREATE, UPDATE, DELETE, UPDATE_EARLY, DELETE_EARLY` plus `extraUpdates` for FK cycles; `CommitOrderCalculator` (a Doctrine port) toposorts by entity *metadata*, then `persistToDatabase` runs DELETE_EARLY → UPDATE_EARLY → creates → updates → deletes per entity class. Batched per class.
- Size (measured): UnitOfWork 1,731 + ChangeSetComputer 265 + ChangeSetPersister 720 + CommitOrderCalculator 149 = 2,865 lines.
- Informs: (I), (J). Same conclusion as TypeORM: the change-set IR and commit-order graph are the price of *implicit* verbs and arbitrary entity graphs. Also (J): the UoW is a per-flush session object (`#changeSets`, `#extraUpdates`, `#collectionUpdates`) that is reset after commit — a working model for a per-run session that is distinct from long-lived metadata.

**17. Sequelize — "Creating with Associations" docs + `src/model.js` (v6) + PR #3386 discussion**
- Org: Sequelize. Type: official docs + source + maintainer PR thread. Years: docs current; PR 2015.
- URLs: https://sequelize.org/docs/v6/advanced-association-concepts/creating-with-associations/ ; https://github.com/sequelize/sequelize/blob/v6/src/model.js ; https://github.com/sequelize/sequelize/pull/3386
- Dispatch: one verb only. Docs: "An instance can be created with nested association in one step, provided all elements are new. In contrast, performing updates and deletions involving nested objects is currently not possible." `bulkCreate` (model.js ~L2750–2900, file 4,754 lines): `BelongsTo` includes are created *before* the rows and their FKs set on the parent; all other includes (HasMany/HasOne/BelongsToMany) are created *after* with the parent key copied onto the child. No IR. Maintainer (mickhansen) on why connect/update never came: "quite a few edge cases we need to consider, raw data vs instances, AI PKs vs UUID pks ... for non AI PK's we have no idea if the content needs to be created, updated or no-op'ed."
- Informs: (H), (I). With one verb, a two-phase before/after split over the relation kind is the entire dispatcher. The maintainer quote shows *why* verbs must be explicit (Prisma/VibORM style) rather than inferred.

**18. Drizzle — issues #2921 and #4393 (no nested writes; confirmed)**
- Org: drizzle-team. Type: issue tracker with maintainer reply. Years: 2024–2026.
- URLs: https://github.com/drizzle-team/drizzle-orm/issues/2921 ; https://github.com/drizzle-team/drizzle-orm/issues/4393
- Gist: Maintainer reply on #2921: "There are currently no plans to have an RQB-like API for mutation queries." #4393 (nested insert/update, 2025) remains open; #6127 (2026, relational `returning`) explicitly says "This request does not concern nested relational writes."
- Informs: (I). Scope calibration: the nearest TypeScript competitor has zero of this surface; VibORM's 34k lines cannot be benchmarked against it.

**19. PostGraphile — v4 `postgraphile-plugin-nested-mutations` (mlipscombe) + v5 status**
- Org: community plugin (mlipscombe); PostGraphile docs (Graphile). Type: source + official docs. Years: plugin 2018–; docs 2026.
- URLs: https://github.com/mlipscombe/postgraphile-plugin-nested-mutations ; https://postgraphile.org/postgraphile/5/community-plugins (lists it as "Not yet ported to V5") ; https://registry.npmjs.org/%40litewarp%2Fgraphile-relation-inputs-plugin (v5 port, 0.0.3-alpha, disconnect/delete unimplemented)
- Dispatch: verbs `connectByNodeId/connectBy<key>`, `create`, `deleteBy*`, `updateBy*`, `deleteOthers` per relation field, forward *and* reverse FK direction. Dispatch is by presence of the field (`if (fieldValue.create)`, `if (fieldValue.updateById || fieldValue.updateByNodeId)`) and is written twice — once for forward (FK on this table, resolved before insert) and once for reverse (FK on the other table, resolved after) — so the verb switch is duplicated per direction rather than once. No IR; issues SQL through the v4 lookahead resolver.
- Size (measured): 1,999 lines over 5 plugin files (Mutations 746, Types 374, Updaters 373, Connectors 258, Deleters 248), of which ~750 is GraphQL type generation.
- Informs: (I), (H). Second-closest verb set to VibORM after Prisma; ~1.2k lines of actual dispatch/execution for 6 verbs × 2 directions with no graph. Its duplication of the verb switch per direction is the anti-pattern (H) warns about.

**20. EdgeDB/Gel — `edb/edgeql/compiler/stmt.py` (`compile_InsertQuery`) and `viewgen.py`**
- Org: Gel (EdgeDB). Type: source. Year: current (stmt.py 1,646 lines; viewgen.py 2,700).
- URLs: https://github.com/geldata/gel/blob/master/edb/edgeql/compiler/stmt.py ; https://docs.geldata.com/reference/edgeql/insert
- Dispatch: `@dispatch.compile.register(qlast.InsertQuery)`; nested inserts are ordinary sub-expressions inside the shape (`compile_query_subject(... shape=expr.shape ...)`), recorded in `ctx.env.dml_exprs`; storage shape (inline single link vs link table) is decided later by the SQL compiler. Full expression IR (`irast`), scope tree, and separate `pg` compiler — because EdgeQL is a whole query language, not a verb set. Its own comment on the ELSE-clause re-compilation: "This feels like somewhat of a hack."
- Informs: (I). The only ORM-adjacent system here whose IR is justified — and it is justified by compiling a general language, not by nested writes.

### W4 — Counterexamples and megaphase accounts

**21. Petrashko, Lhoták, Odersky — "Miniphases: Compilation using Modular and Efficient Tree Transformations" (PLDI 2017)**
- Org: EPFL / Waterloo (Dotty authors). Type: peer-reviewed, first-person history of scalac. Year: 2017.
- URL: https://plg.uwaterloo.ca/~olhotak/pubs/pldi17b.pdf (DOI 10.1145/3062341.3062346)
- Gist: §2.1: "To improve performance, consecutive phases have been joined at the source level by hand ... performance considerations pressured the developers to mix unrelated transformations in individual phases ... Over the years, this has led to a code-base that is hard to maintain and evolve." Examples: `uncurry` also lifts `try` blocks; `refchecks` "was intended to only inspect but not modify the tree" yet now performs three transformations. The fix: each Miniphase is a per-node-type `transform` override with an imposed uniform postorder traversal so the framework fuses them (54 phases, 35% faster tree transforms).
- Informs: (E), (I). Two-sided: hand-fused megaphases rot; but the modular alternative *requires* a uniform traversal + per-node dispatch (a visitor) so that fusion is mechanical. Without a fusion framework, the modular version is just N traversals.

**22. Keep & Dybvig — "A Nanopass Framework for Commercial Compiler Development" (ICFP 2013) + Keep dissertation**
- Org: Indiana / Cisco (Chez Scheme). Type: peer-reviewed + dissertation. Year: 2013.
- URLs: https://legacy.cs.indiana.edu/~dyb/pubs/commercial-nanopass.pdf ; https://andykeep.com/pubs/dissertation.pdf
- Gist: "Constructing a compiler with many single-task passes, however, can require excessive boilerplate code to recur through unchanging forms, increasing compiler size and thus failing to decrease maintenance and extension overhead." Solved only via a DSL that generates the boilerplate (`define-language`/`define-pass`); 5 passes → ~50 passes over ~35 IRs at <2x compile time. Dissertation: the nanopass student compiler "shrinks the source code for passes by 21% by eliminating boilerplate code" — i.e., the boilerplate is on the order of a fifth of a hand-written multi-pass compiler.
- Informs: (E), (I). One-IR-per-pass is only cheap with a boilerplate generator. TypeScript has none; each extra IR/pass costs hand-written recursion over unchanged forms.

**23. MLIR "Table-driven Declarative Rewrite Rule (DRR)" — Strengths and Limitations**
- Org: LLVM/MLIR. Type: official docs. Year: current.
- URL: https://mlir.llvm.org/docs/DeclarativeRewrites/
- Gist: "it is good at expressing op to op conversions, but not that well suited for, say, converting an op into a loop nest." No support for regions, block arguments, multi-result nested patterns, variadics in nested patterns, `NativeCodeCall` returning >1 result; result-type deduction needs custom C++ builders.
- Informs: (E). Table-driven rewriting fails exactly where the target has control structure and multiple outputs — which is what a nested write is (parent row, FK back-patch, junction rows).

**24. Roslyn `BoundNodes.xml.Generated.cs` / `BoundTreeRewriter.cs`**
- Org: .NET compiler team. Type: source. Year: current.
- URLs: https://github.com/dotnet/roslyn/blob/main/src/Compilers/CSharp/Portable/BoundTree/BoundTreeRewriter.cs ; https://source.dot.net/Microsoft.CodeAnalysis.CSharp/Generated/BoundNodes.xml.Generated.cs.html
- Gist: every bound node's `Accept`, `Update`, visitor and rewriter methods are generated from `BoundNodes.xml`; and even so the team hand-writes `BoundTreeRewriterWithStackGuardWithoutRecursionOnTheLeftOfBinaryOperator` to unroll left-recursion for binary operators, if-chains, and binary patterns.
- Informs: (E). Generic visitors in a production compiler need (a) a code generator and (b) hand-written escape hatches for the shapes the generic walk handles badly.

**25. Kysely `operation-node-transformer.ts` (measured extension of the prior counterexample)**
- Org: kysely-org. Type: source. Year: current.
- URL: https://github.com/kysely-org/kysely/blob/master/src/operation-node/operation-node-transformer.ts
- Gist: 1,404 lines; a `#transformers` table of 100 node kinds mapped to 102 `transformXxx` methods, each a mechanical `freeze({ ...node, child: this.transformNode(node.child) })`. Useful for the one use documented (identifier renaming) and nothing else.
- Informs: (E). Quantifies the visitor tax: ~14 lines per node kind of pure plumbing before any semantics.

**26. Babel PR #13813 "Restore traversal context after enter / traverse"**
- Org: Babel (JLHwung). Type: maintainer PR. Year: 2021.
- URL: https://github.com/babel/babel/pull/13813
- Gist: "The current AST operations we provided did not guarantee that the traversal context is preserved ... The traversal context is crucial to sub-traverse in order to isolate visitors / traverse states from the root traverse." Leaked context "causes confusing errors" (#13801); the fix saves/restores context around every `call("enter")` and sub-traversal at ~10% worst-case cost.
- Informs: (F), (J) (minor). A traversal cursor stored on a shared context must be saved/restored around every nested traversal; that is the failure mode a per-operation owner with explicit products avoids by construction.

**27. Swift `docs/SIL/SIL.md` + `OptimizerDesign.md`**
- Org: Swift project. Type: official design docs. Year: current.
- URLs: https://github.com/swiftlang/swift/blob/main/docs/SIL/SIL.md ; https://github.com/swiftlang/swift/blob/main/docs/OptimizerDesign.md
- Gist: "SILGen generates raw SIL from an AST" by walking the type-checked AST directly; "Raw SIL ... may not have a fully-constructed SSA graph ... Some instructions may be represented in non-canonical forms"; a fixed set of mandatory passes then produce canonical SIL.
- Informs: (H), (I) (minor). Emit directly, permit a non-canonical output, normalize with a few small mandatory passes over the *emitted statements* — rather than building a separate plan graph before emission.

---

## Workstream 3 comparison table

| System | Dispatch file(s) | Verb dispatched once? | Graph IR or direct emission | Storage shapes | Measured size |
|---|---|---|---|---|---|
| Prisma | `query-compiler/core/src/query_graph_builder/write/nested/mod.rs` (+8 verb files) | Yes, one `match` over 11 verb names; shape re-switched inside each verb | Graph IR (`QueryGraph`, petgraph, Flow nodes) then interpreter | m2m, 1:m inlined-child, 1:1/inlined-parent | nested 3,227; write/ 5,561; query_graph 1,150 |
| Hasura (PG) | `Hasura/Backends/Postgres/Execute/Insert.hs` | Yes (insert only; decided at schema parse) | Direct recursive execution, tree IR only | object rel (before), array rel (after), m2m via nesting | 159 + 121 + 483 = 763 |
| Ent | `dialect/sql/sqlgraph/graph.go` `creator.node` | n/a (edge add/remove only) | Direct SQL; edges grouped once by `Rel` | O2O/O2M/M2O/M2M | 2,076 (whole graph pkg) |
| TypeORM | `persistence/EntityPersistExecutor.ts` → subject builders → `SubjectExecutor.ts` | Verbs implicit (diff) | Subject-graph IR + toposort | 1:m, 1:1 inverse, m:m builders | 2,577 |
| MikroORM | `unit-of-work/UnitOfWork.ts` (+ computer/persister/order) | Verbs implicit (diff) | ChangeSet IR + commit-order toposort | to-one owner, to-many, pivot | 2,865 |
| Sequelize | `src/model.js` `bulkCreate`/`save` include branches | Yes (create only) | Direct; BelongsTo before, others after | belongsTo / hasMany+hasOne / belongsToMany | ~150 lines inside 4,754-line model.js |
| PostGraphile v4 plugin | `src/PostgraphileNestedMutationsPlugin.js` | Verb switch duplicated per FK direction | Direct SQL via resolver | forward FK, reverse FK | 1,999 (5 files) |
| EdgeDB/Gel | `edb/edgeql/compiler/stmt.py` `compile_InsertQuery` | Single-dispatch on AST node | Full language IR (`irast`) → pg compiler | inline link vs link table (decided in pg compiler) | stmt 1,646 + viewgen 2,700 (full language) |
| Drizzle | — | — | — | — | No nested writes (maintainer: "no plans") |

Closest in scope to VibORM: **Prisma** (identical 11-verb set, 3 storage shapes; VibORM adds polymorphic). Second: the PostGraphile v4 plugin (6 verbs × 2 directions, ~2k lines, no IR). Every system that builds a graph/IR (Prisma, TypeORM, MikroORM, EdgeDB) does so for a reason VibORM does not share: implicit verbs needing diff+toposort (TypeORM, MikroORM), a general query language (EdgeDB), or — in Prisma's case — a design the maintainers themselves label "unsatisfying."

---

## Rejected sources (one line each)

- Kameyama/Kiselyov/Shan, "Combinators for Impure yet Hygienic Code Generation" — about binder hygiene in staged code, not cursor/value products.
- Harrison & Kamin, monad-transformer modular compilers (1998/2000) — academic pass-separation; no bearing on write dispatch.
- Dave Cheney "Context is for cancelation"/"Context isn't for cancellation", Peter Bourgon, rednafi, willem.dev, dev.to `context.Value` posts — secondary opinion; the rule is already in the official package doc and Go-team issue (#3).
- BestHub "Uncovering the 50,000-line checker.ts"; DeepWiki TypeScript page — secondary/AI-generated.
- golang/go #49189 (generic `context.Key`), #33283 (Value perf doc), #17302 (key types) — API-detail proposals, no ownership rationale beyond #3.
- Drizzle #2317, #1395, #3019, #6127 — user questions; only used to confirm absence of nested writes.
- scala/scala PR #6618 "Reduce the bulk of Typer / Inferencer" — a refactor that collapses two classes into one, but carries no design statement; scala/bug #10794 — about plugin phase slots.
- Scala Center "scalac-profiling" blog — implicit-search performance, not architecture.
- Roslyn #62647 (`SyntaxVisitor<TArgument,TResult>`) — allocation-free reuse; tangential to E.
- MLIR "Generic DAG Rewriter Infrastructure Rationale" — argues *for* declarative patterns over hand-written matchers in instruction selection; a different problem shape (op→op), already bounded by #23.
- Babel #15702/#15593/#15587 visitor-merge PRs, #16965 traverse perf — bug fixes/perf; no design rationale beyond #26.
- PostGraphile v5 "Custom mutations"/"CRUD mutations" docs — recommend DB functions; no dispatch code.
- Hasura `Hasura.RQL.DML.Insert` (old non-recursive path) — superseded by #13.
- Heist.Compiled, th-builder, "Lazy v. Yield" — unrelated hits from the "monadic builder" query.
- Chris Lattner/Joe Groff "Swift Intermediate Language" 2015 LLVM dev-meeting slides — same content as #27, less precise.

---

## Synthesis per VibORM decision (what the sources add or overturn)

**(F) WriteCompilation owner — may/may not contain.**
Sources #1, #2, #3, #4, #5, #26. Converging rule from rustc, Roslyn, LLVM, Go: the owner is (a) immutable-for-the-run inputs (schema/models, dialect, options), (b) interners/allocators (param slots, alias counters — LLVM's uniquing tables, rustc's `CtxtInterners`), (c) memo caches keyed by immutable keys whose values have no interior mutability (rustc query rule), (d) cross-cutting optional pass-through (diagnostics sink, tracing — Go's only sanctioned `Value` use). It must not contain the traversal cursor (LLVM keeps it in `IRBuilder`, rustc in `Builder`, Babel's leak of it cost a save/restore protocol), the current verb, parent-key placeholders, or phase flags. CHALLENGE to prior framing: rustc did not split `Session` out of the context in regret — `Session` is inside `GlobalCtxt`; and the TypeScript team explicitly rejects "split the owner" as a size or clarity win. The size argument for VibORM is therefore not "fewer fields on the owner" but "no temporal fields on the owner," which is (D).

**(D) Explicit compile products replacing temporal fields.**
Sources #7, #8, #9, #11. rustc's `BlockAnd<T>` with `#[must_use = "... dangling edge"]` is the enforced form; Kaleidoscope documents the hazard it removes ("calling codegen() recursively could arbitrarily change the notion of the current block"); Cranelift shows the price of keeping a builder cursor (a block-status lattice plus asserts); GHC shows that cached facts on shared structure "rendered invalid" by sibling mutation became "a bug farm" until decisions were made explicit and staged. Recommendation unchanged, strengthened: each lowering returns `{ parts, cursor/anchor, produced keys }` as a readonly product; callers thread it; no `this.currentParent`.

**(H) Dispatch-once verb → Part lowering.**
Sources #12, #13, #14, #17, #19. Prisma's 54-line `connect_nested_query` is the model: one `match` on the verb, one function per verb, no later re-switch on verb. Extension: what Prisma re-switches on is *storage shape*, inside every verb (11 × 3 hand-written). Ent shows the cheaper form — classify relation shape once (`GroupRel`) and pass the classification as data into three emitters; Hasura shows that ordering can be a data attribute of the relation (`riInsertOrder` → before/after partition) rather than code. PostGraphile's duplicated switch per FK direction is the anti-pattern. For VibORM: verb switch once at the top; shape (FK-held-on-parent / FK-held-on-child / junction / polymorphic) computed once per relation into a small record consumed by verb handlers; ordering derived from that record.

**(I) Is a general write graph/IR justified at 3 shapes × 11 verbs?**
Sources #10, #12, #13, #14, #15, #16, #17, #19, #20, #22, #27. No. Every direct-emission system in the survey (Hasura 763 lines, Ent ~2k for the whole graph package, Sequelize ~150 lines of include handling, PostGraphile plugin ~1.2k of execution) handles its shapes with before/after partitions. Systems with an IR either have implicit verbs and need diff+toposort (TypeORM 2.6k, MikroORM 2.9k), compile a general language (EdgeDB), or — Prisma — carry a maintainer TODO calling the graph "unsatisfying" and spend most of their 6.7k write-side lines in per-verb-per-shape handlers and referential-action emulation anyway. Tahboub/Rompf shows a single generation pass matching multi-IR query compilers; Keep & Dybvig quantify multi-IR boilerplate (~21% of pass source) and note it is only cheap with a generator TypeScript lacks. Swift's raw→canonical SIL suggests the right "IR" is the emitted statement list itself, normalized by a couple of tiny passes (FK back-patch, junction batching).

**(E) Rejecting table-driven/visitor design.**
Sources #21, #22, #23, #24, #25. MLIR's own docs bound table-driven rewriting to op→op with no regions/multi-results; Roslyn needs a code generator *and* hand-unrolled visitors; Kysely's transformer is 1,404 lines of 100-way mechanical plumbing; nanopass boilerplate is a measured fifth of pass code; and Miniphases — the successful modular design — only works because a framework fuses uniform-traversal visitors, which VibORM would have to build. Rejection stands, with the caveat from #21 that hand-fused "megaphases" also rot; the mitigation is small verb handlers sharing a shape record (H), not a visitor.

**(J) Progressive-execution per-run session.**
Sources #3, #4, #11, #16. Roslyn: an immutable per-invocation object with on-demand caches; MikroORM: a per-flush `UnitOfWork` holding change sets, extra updates, and collection updates, cleared after commit and separate from long-lived metadata; GHC: per-iteration occurrence analysis recomputed before each simplifier run rather than patched; Go: request-scoped values are optional and transit-only. Model for VibORM: a session object created per `run()` that owns produced keys, deferred FK back-patches, and the statement cursor, and that dies with the run; the WriteCompilation (F) stays immutable and reusable across runs.
