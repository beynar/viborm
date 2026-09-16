# G4-04 root integrated review — checklist (opened 08:10, 2026-09-15)

Applied by the root on the frozen integrated source before any full
qualification run (plan §6.3 step 3). Each line is closed with a receipt or
a finding; findings return to the owning unit under the bounded repair rules.

## A. Source and ownership

- [ ] Combined diff against `0cc61e61`: exactly the accepted unit patches
      (G4-01 r5, G4-03 r3 + G4-03b, G4-02 phase 1 + phase 2, harness units);
      no file outside the declared ownership; no staged files; unrelated dirty
      files untouched.
- [ ] One authority per fact: `Queries.read` for cardinality/shape; one
      prepared predicate vocabulary (`where`/`having`/nested); one page owner;
      one projection owner; one leaf decoder; one carrier transport rule; one
      counted-slot owner; `Queries.updateValue` for every scalar operator and
      symbolic key; `fieldValue` for value lowering; one envelope rule in
      `OperationContext.run`; `operationRegion` versus `memberRollback`
      ownership stated, not inferred.
- [ ] No legacy import or fallback in `src/query-engine/raptor3/**` and
      `route/` (grep `write-engine`, `builders/`, `result/`, `operations/`,
      `pattern/` — only `parse-boundary` retention allowed).
- [ ] Deletions verified gone (`lowerValuePredicate`, `grouped` shape
      assembly, entry `take: 1`, `publishesSingleRow`, `statementAtomic`,
      `namesRelation`, the `findMany/findUnique/groupBy` triple, the
      `parseResult` guard, the second read entry in `program/index.ts`).
- [ ] Private guide (`raptor3/AGENTS.md`) updated for the new owners and
      rules from every unit's proposed paragraphs.

## B. Regressions and reconciliation

- [ ] `g2-mysql-contracts` 13/13 on the frozen tree (G4 regression repaired).
- [ ] CS-03 extension-campaign self-test 42/42 with §5.4 eliminated-cut
      records where applicable; `cs03-*-seeds` green.
- [ ] `g3-generated-transport-smoke`, `g3-generated-smoke`,
      `g3-generated-minimization` green; transport plans revised for the new
      physical shape without thinning fault coverage.
- [ ] Every registered G4 fixed mode green; the reviewer-probe modes green
      except pins that document a recorded decision (none expected after
      G4-03b).
- [ ] Whole-estate typecheck: only the two Pattern errors.

## C. Contracts and decisions

- [ ] No public API, argument, result shape or error class changed; every
      refusal wording restored to the shipped text; recorded diagnostic-meta
      differences (RF-15) listed, none silent.
- [ ] Decisions taken by the integrator listed with their justification:
      `operationRegion` grant; root create fold; single-statement meta parity;
      refusal precedence by parity; program specimen through `Queries.read`;
      witness harness edits accepted. Decisions still owed to Arnaud: none
      expected; list any.

## D. Evidence and cost

- [ ] Identity captured after the last edit; every unit receipt names its
      identity; failed attempts kept as failed.
- [ ] Census on the frozen tree: core and complete charged LOC / tokens /
      bytes with the same charged file lists as G3 (`support/source-cost.json`
      recipe); cumulative deltas per unit reconciled; growth explained.
- [ ] Bundle fixtures measured on the candidate-only package (comparable
      engine and full public PostgreSQL client) against the frozen baseline.

## E. Qualification launch conditions

- [ ] Free disk ≥ 8 GiB; providers answering with recorded ports.
- [ ] One short output/reporter check per lane before long runs.
- [ ] Serial execution plan written with the exact command list.
