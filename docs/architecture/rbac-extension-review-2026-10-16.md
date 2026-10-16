# RBAC extension: independent review (2026-10-16)

Perimeter: branch `rbac` at `2999badd6`, the diff from 1.2.4 (`2fcaa26a8`): 203 files, `src/` +7,286 / −964 over 62 files, plus docs and tests. Plan: `rbac-extension-plan.md`; guide: `docs/content/docs/extensions/rbac.mdx`.

## Method

Five independent lenses were briefed on the frozen source: security, as an attacker holding every call argument; engine SQL correctness; first principles and ELEGANCE.md; docs and public API, every example run from the packed build; cost and provider limits. Each finding above `low` went to two skeptics, one refuting by reading and one by reproducing. A finding survives when at least one confirms it with a run or an exact code path.

**Coverage gap: two lenses did not run.** The engine-SQL and cost lenses, and the synthesis, stopped on the agent budget (it resets 2026-10-20). Their scope (shared relation bodies, produced-row lowering, refusal sentinels, parameter exactness, D1 and Neki limits under pathological policies) has the wave-4 and wave-5 witnesses but no independent review yet. They run before the PR is merged.

## Verdict

No finding bypasses a policy written as intended. The high findings were fail-open on a definition mistake, or answered for a row the caller did not name. They and the medium ones are fixed or documented in the commit that adds this file, each fix with a witness that fails on `2999badd6` (plan §11.4). Ship after the two missing lenses run.

## Findings and dispositions

| Id | Lens | Reported | After skeptics | Finding | Disposition |
|---|---|---|---|---|---|
| Fprinciples-1 | principles | high | confirmed high/high | Ordered $access and can/assert on a list infer lower actions from declaration order, a second authority beside P(M,a) | Fixed: `can`/`assert` ask each level by itself on a leveled model (W-CAN8); `$access` documented as the highest level held. Closing P under the levels is an owner question (plan §11.4). |
| Fprinciples-2 | principles | high | confirmed high/high | A BigInt constant in a placement crashes rbac(...)(base) with a raw TypeError | Fixed: values compare structurally (bigint, NaN, ±Infinity, dates); a bigint constant compiles. |
| Fprinciples-3 | principles | high | confirmed high/high | A declared ceiling carries a hidden top-level wildcard; a higher non-top role can see less than a lower one | Fixed: a declared cap the model does not declare is refused when applied; the top-level rule is stated in the guide and A1. |
| Fprinciples-4 | principles | medium | confirmed medium | Stored and declared ceilings have two implication rules for one concept | Fixed: a stored ceiling row allows its action and every one implying it (A1 amended). |
| Fprinciples-5 | principles | medium | confirmed medium/medium | can/assert judge an arbitrary first row of a non-unique where (plan D8 says findUnique) | Fixed: `can`/`assert` take a unique selector and run over `findUnique` (W-CAN7). |
| Fprinciples-6 | principles | medium | confirmed critical/medium | An unplanned implication prover is a second owner of where semantics | Fixed: the prover is kept as a declared mechanism (plan §11.4, D13), since deleting it put the grant writes back over D1's limits (measured). Its R6 safeguard now counts only actor values read outside every `$if` arm, its equality is structural; both skeptics' cases are witnesses. |
| Fprinciples-7 | principles | medium | refuted | One extra rule key flips a model's delete verb and the shape of $access | Refuted by both skeptics: the specified behaviour (OD-3, D6), documented. |
| Fprinciples-8 | principles | medium | confirmed low/low | The composed acceptance case is not the §1.1 text and does not read as derived from the same words | Fixed in the plan: §11.4 records the shipped §1.1 spelling. |
| Fprinciples-9 | principles | low | low (not verified) | The policy's `{ actor: "path" }` marker captures JSON literals | Open (low): listed for a later pass. |
| Fprinciples-10 | principles | low | low (not verified) | A friend type import and an underived public surface (compile, config, CompiledPolicy/CompiledModel) | Open (low): listed for a later pass. |
| Fprinciples-11 | principles | low | low (not verified) | refuseUnreachable keeps its own operation-to-verb table, which omits upsert | Open (low): listed for a later pass. |
| Fprinciples-12 | principles | low | low (not verified) | Framing names leak into core | Open (low): listed for a later pass. |
| Fprinciples-13 | principles | low | low (not verified) | Blog readability: `create:` is a placement key beside action keys, judged at an action no rule names | Open (low): listed for a later pass. |
| FDOCS-1 | docs-api | high | confirmed high/high | A misspelt reserved key in a model's policy becomes an action that implies view, so a typo widens reads | Fixed: unlisted keys beside `actions`, and keys spelled like a declaration key or a level, are refused (runtime; types for `actions` models). |
| FDOCS-2 | docs-api | high | confirmed high/high | Unknown top-level config keys and unknown model names in keyLimit ids are silently ignored, which drops the API-key limit | Fixed: unknown policy keys refused (runtime and types); `keyLimit` `ids` models checked against the schema (runtime). |
| FDOCS-3 | docs-api | high | confirmed medium/low | 'A revoked key reaches nothing at once' is false for an actor that also carries a live session | Documented: a revoked key cuts access only for a key-only actor; bind one credential per request. |
| FDOCS-4 | docs-api | high | confirmed high/high | A unique scalar can be read-gated, and a write's unique constraint then confirms the gated value on a visible row | Fixed: unique and compound-unique fields cannot be read-gated (K5 admission). |
| FDOCS-5 | docs-api | medium | confirmed medium/medium | can/assert accept any where, and assert passes when the first matching visible row holds the action | Fixed with Fprinciples-5. |
| FDOCS-6 | docs-api | medium | confirmed medium/medium | Misspelt keys inside a `fields` entry are ignored at runtime: the gate is silently off | Fixed: a `fields` entry takes only `read` and `write`. |
| FDOCS-7 | docs-api | medium | confirmed medium/medium | 'An application that does not import it pays nothing for it' is false: core grew about 10 KB gzip for every application | Documented with the measured numbers (about 10 kB gzip on every application bundle). Whether core should shed it for applications without rbac is an owner question. |
| FDOCS-8 | docs-api | low | low (not verified) | 'Built only from public extension capabilities' while the compiler reads private schema state and an unexported core type | Open (low): listed for a later pass. |
| FDOCS-9 | docs-api | low | low (not verified) | A to-one `delete: true` gives ForbiddenError, not the documented NestedWriteError, when the key it nulls is read by placement | Open (low): listed for a later pass. |
| FDOCS-10 | docs-api | low | low (not verified) | The caching example throws TypeError unless the cache extension is applied, which the guide does not say | Open (low): listed for a later pass. |
| FDOCS-11 | docs-api | low | low (not verified) | `distinct` over a read-gated field drops rows, contradicting 'Rows are never dropped for it' | Open (low): listed for a later pass. |
| FDOCS-12 | docs-api | low | low (not verified) | `$access` on a leveled model is typed `Level \| null`; a subset returns null when unheld, which is undocumented | Open (low): listed for a later pass. |
| FDOCS-13 | docs-api | low | low (not verified) | 'Every actor path ... is checked in TypeScript' does not hold for function rules | Open (low): listed for a later pass. |
| FDOCS-14 | docs-api | low | low (not verified) | Numbers and labels in CHANGELOG and the guide disagree with the plan or are stale | Open (low): listed for a later pass. |
| FDOCS-15 | docs-api | low | low (not verified) | Error descriptions and paths name things the caller did not write | Open (low): listed for a later pass. |
| FDOCS-16 | docs-api | low | low (not verified) | Public surface exports undocumented internals and omits a type the guide implies | Open (low): listed for a later pass. |
| Fsecurity-1 | security | high | confirmed medium/medium | A caller-written soft-delete marker tombstones and restores a row at the update action, not the delete action | Fixed: an update writing a tombstone-managed field, and `restore`, also take the delete verb (W-C9, W-C1). |
| Fsecurity-2 | security | high | confirmed high/high | can/assert answer for whatever row comes first when `where` is undefined, empty or not unique | Fixed with Fprinciples-5 (W-CAN7). |
| Fsecurity-3 | security | low | low (not verified) | The guide's list of existence disclosures leaves out updates over a unique key a hidden row holds | Open (low): listed for a later pass. |

## Found during the fix round

- **A value walked as a clause (high, fixed).** The compiler took any object for a clause, so a policy constant such as `{ createdAt: { gt: date } }` lowered to `{ gt: {} }`, and a `Decimal` or bytes constant likewise lost its value. Found while covering the prover's structural equality; `isRecord` now means a plain object. Witness: the Date cases in `compile.core.test.ts` (on `2999badd6` the two different dates compile to the same `{}` and one is dropped).
- **Deleting the prover put the grant writes back over D1's limits (measured).** W-W3 and W-P10's update form returned `QueryError` on D1 with placement and moves as plain conjunctions, so the prover is kept as a declared mechanism with its defects fixed (plan §11.4, D13).

## Detail

### Fprinciples-1: Ordered $access and can/assert on a list infer lower actions from declaration order, a second authority beside P(M,a)

- Where: src/rbac/index.ts:570 (holds), src/query-engine/raptor3/shared/query.ts:6207 (ordered evidence)
- Claim: On a model whose actions are the levels, `$access` reports only the last level that holds and `can`/`assert` with a list decide a lower action by index, but R1 does not make P monotone in the level order (an arm, `within` or `limit` written as a function of the action can hold at `full` and not at `edit`), so one row gets two answers.
- Evidence: principles/monotone.probe.ts (SQLite3, levels view/edit/full, post arm `(a) => a === "full" ? { id: "p1" } : { OR: [] }`): `$access` = "full"; can("edit") false; can(["edit","full"]) {edit:true,full:true}; assert(["edit","full"]) passed; assert("edit") ForbiddenError; findMany({as:"edit"}) []; update(title) NotFoundError. W-CAN6 only exercises single-action can on a monotone policy.
- Proposed fix: Make P monotone by construction (R1: P(M,a) = ⋁_{b ⊒ a} [within(b) ∧ limit(b) ∧ (rule(b) ∨ arms(b))]), or have can/assert read per-name booleans instead of inferring from the ordered value.
- Skeptic 1: confirmed, high. I reran the probe at 2999badd6 and the claim holds. R1 evaluates each arm, `within` and `limit` separately at each action, and rbac.mdx:165 says so ("evaluated once per declared action"). So an action-dependent arm can make P(full) hold where P(edit) does not. The plan's R2 (line 249) even says "no monotonicity obligation falls on authors". Two places still assume a monotone ladder anyway:
- The engine's ordered evidence (query.ts `#projectEvidence`, the ordered branch around line 6207) returns only the last listed level that holds.
- `holds` in src/rbac/index.ts:566-570 then decides any lower action by `names.indexOf(value) >= names.indexOf(action)`.

`can`/`assert` with a list therefore an
- Skeptic 2: confirmed, high. I confirmed this with a run and by reading the code. R1 (plan:248, rbac.mdx:160) evaluates arms, `within` and `limit` at each action `a` and allows each to be "a function of the action". Only rules get the `⋁_{b ⊒ a}` closure, so nothing makes P(M, a) monotone along `levels`, and I found no check in `rbac()` that refuses a non-monotone declaration. R2 only puts every action under `view`. It does not tie `edit` to `full`. On an ordered model, `#projectEvidence` (src/query-engine/raptor3/shared/query.ts:6189-6219) projects one enum: the last listed name that holds. `holds` in src/rbac/index.ts:566-570 then turns that value into a per-action answer with `names.indexOf(value) >= names.indexOf(ac

### Fprinciples-2: A BigInt constant in a placement crashes rbac(...)(base) with a raw TypeError

- Where: src/rbac/compile.ts:576 (same → JSON.stringify)
- Claim: The implication prover compares clauses with JSON.stringify, which throws on BigInt, so a policy with BigInt constants under the same field in two conjuncts cannot be applied, and the error is not the ClientInitializationError §5.3 promises.
- Evidence: principles/bigint.probe.ts: post { within: { quota: { lt: 10n } }, create: { quota: { gte: 1n }, authorId: { actor: "userId" } } } → `TypeError Do not know how to serialize a BigInt at text (compile.ts:576) / same (compile.ts:580) / provable (compile.ts:527) / implies (compile.ts:500)`.
- Proposed fix: Compare values structurally (a deep equality that handles bigint, Date, Decimal and Uint8Array), or delete the prover (see Fprinciples-6).
- Skeptic 1: confirmed, high. I confirmed this with a run. The implication prover in src/rbac/compile.ts compares two record clauses with `same` (lines 568-582), which calls JSON.stringify on each side (line 576). When the same scalar field appears in two conjuncts, the path is provable → (key === wanted, both records, no relation target) → same(given, value), at line 527. JSON.stringify throws on a bigint, so rbac(...)(base) dies with a raw `TypeError: Do not know how to serialize a BigInt`. Nothing in src/rbac wraps compilePolicy in a try/catch, so this is not the ClientInitializationError that plan §5.3 and the mdx error table promise for definition errors.

The trigger is narrower than a policy that merely contains a
- Skeptic 2: confirmed, high. I reproduced it with my own probe at 2999badd6. When the implication prover in src/rbac/compile.ts gets two record clauses on the same scalar field, it goes `provable` (:527) → `same(given, value)` (:580) → `text` (:576) → `JSON.stringify`, and `JSON.stringify` throws on BigInt.

- **Failing policy:** `within: { quota: { lt: 10n } }` plus `create: { quota: { gte: 1n }, authorId: {actor:"userId"} }`. `rbac(...)(base)` throws a raw `TypeError: Do not know how to serialize a BigInt`. §5.3 (plan line 471) promises a `ClientInitializationError` for definition errors at `rbac(...)(base)`.
- **The literal is the natural spelling:** a plain number on the bigint field is refused by admission with `Cl

### Fprinciples-3: A declared ceiling carries a hidden top-level wildcard; a higher non-top role can see less than a lower one

- Where: src/rbac/helpers.ts:181
- Claim: `member({ ceiling })` admits a role when its ceiling is the top level (every action of every model) or when the ceiling is in ↑a. On a model with its own `actions` a ceiling naming a non-top level that the model does not declare admits nothing, not even view, while a lower `view` ceiling does. This rule is in neither R1 nor the guide.
- Evidence: principles/ceiling.probe.ts: ceiling {reader:"view", editor:"edit", admin:"full"} on document with actions {view, publish}: view → role in ["reader","admin"] (editor excluded), publish → ["admin"]. The guide's "a reader granted edit holds view because edit implies view" does not hold for an editor here.
- Proposed fix: Read a ceiling in the levels order (it admits a when some level ⊑ ceiling is an action of the model that a implies), or refuse at rbac() a ceiling level a model does not declare, and state the top-level rule in R1 and the guide, or delete it.
- Skeptic 1: confirmed, high. I confirmed this by reading the code and running my own probe. In src/rbac/helpers.ts:177-183, `member()` with a declared ceiling admits a role at action `a` in only two cases: when `ceiling[name] === model.levels.at(-1)` (the top level), or when `model.above(a).includes(ceiling[name])`. `model.above` is built in compile.ts:283-300 from the model's own action map, not from `levels`. So on a model with its own `actions` that leaves out a middle level (`edit`), a role capped at `edit` matches neither case and is admitted at no action. A role capped at the lower `view` is admitted at `view`, and the top `full` passes everywhere through the special case.

The ceiling is therefore not monotone in
- Skeptic 2: confirmed, high. Confirmed by running it, and the problem is worse than the claim says. The code at src/rbac/helpers.ts:177-183 admits a role when `ceiling[name] === model.levels.at(-1)` or when `model.above(action).includes(ceiling[name])`. `above()` only knows the model's own action graph. So on a model with its own `actions`, a ceiling level the model does not declare implies nothing there, while whatever level is last in `levels` admits every action. `rbac()` does not refuse an undeclared ceiling level, and `Ceiling` is untyped. Neither R1 (plan line 248: "a ceiling admits a role iff its allowed set contains a") nor the guide (rbac.mdx:200, 211-215: "`ceiling` caps each role at an action") states the top

### Fprinciples-4: Stored and declared ceilings have two implication rules for one concept

- Where: src/rbac/helpers.ts:172
- Claim: A declared ceiling is upward-closed (a role capped at edit holds view). A stored ceiling admits a role at a only when a rolePermission row names exactly a, so a stored role holding only `edit` cannot view. The W-A6 seed stores closed sets (reader: view; others: every action), so the witness cannot tell the two rules apart.
- Evidence: principles/batch2.probe.ts: declared {editor:"edit"} at view → `role: { in: ["editor"] }`; stored at view → `permissions: { some: { role: "editor", action: "view" } }`. seed.ts:377-381 stores ALL_ACTIONS for member/admin and ["view"] for reader.
- Proposed fix: Make the stored ceiling match `action: { in: ↑a }`, and seed a role whose stored set is not closed so that W-A6 can tell the two rules apart.
- Skeptic 1: refuted, low. The code does what the reviewer says, but that behaviour is the specified one, so this is not a defect. At src/rbac/helpers.ts:167-174 the stored branch emits `{ [relation]: { some: { role: name, [action]: action } } }`, an exact match. The declared branch at :176-181 admits a role when `above(action)` includes its level. Both apply one rule, written in plan R1 (rbac-extension-plan.md:248): "a ceiling admits a role iff its allowed set contains a". Only the way each kind gets its allowed set differs. A declared level L allows ↓L. A stored ceiling allows exactly the rows it has. The hand-written truth names this reading as A1 (tests/package/fixtures/rbac-app/oracle.ts:20-24): "Stored, iff a ro
- Skeptic 2: confirmed, medium. Confirmed by reading the code and by an end-to-end run. In src/rbac/helpers.ts:162-174, a stored ceiling emits `[ceiling.relation]: { some: { role: name, [ceiling.action]: action } }`, which matches only the exact action. A declared ceiling (helpers.ts:176-181) admits a role when `model.above(action).includes(ceiling[name])`, so a role capped at `edit` also holds `view`. The same file also matches stored action lists the closed way: `grant.to` uses `actions: { hasSome: ↑a }` (helpers.ts:218), and keyLimit scopes are closed under `implies` too. So stored action data follows two implication rules depending on the helper. The seed (seed.ts:377-381) stores closed sets (reader: [view]; admin and

### Fprinciples-5: can/assert judge an arbitrary first row of a non-unique where (plan D8 says findUnique)

- Where: src/rbac/index.ts:586
- Claim: `ask` runs `findFirst({ where, select: { $access } })` with no orderBy, and its `where` type is a non-unique filter, so `can`/`assert` on a filter that matches several rows answer for whichever row the database returns first.
- Evidence: principles/bigint.probe.ts (second test): u2 authors p2, u1 authors p1, both titled "x"; can("edit", { title: "x" }) → false and assert("edit", { title: "x" }) → ForbiddenError, while updateMany({ where: { title: "x" } }) → { count: 1 }.
- Proposed fix: Type and run `where` as the model's unique selector (findUnique) as D8 specifies, or define and document an "every matching row" meaning.
- Skeptic 1: confirmed, medium. Confirmed by the code and by a run. At src/rbac/index.ts:586-589, `ask` runs `read.findFirst({ where, select: { [EVIDENCE_KEY]: asked } })` with no orderBy and no uniqueness check. Its `where` type, `WhereOf` at index.ts:337-340, is the where of the `"exist"` operation payload: a plain, non-unique filter. Plan D8 (rbac-extension-plan.md:319-324) says the methods run "over the model's `findUnique`". So the answer belongs to whichever matching row the database returns first. My run: posts p1 (author u1) and p2 (author u2) are both titled "x", and edit means `authorId = actor.userId`. For u1, `can("edit", {title:"x"})` is true and `assert` passes, though u1 cannot edit p2. For u2, the same call
- Skeptic 2: confirmed, medium. Confirmed, both by reading the code and by running it. At src/rbac/index.ts:586, `ask` runs `read.findFirst({ where, select: { $access: asked } })` and judges only the single row that comes back. The `where` type (`WhereOf`, src/rbac/index.ts:337-340) is the "exist" operation's non-unique filter, not a unique selector, so the types accept any filter. Plan D8 says the methods go "over the model's `findUnique`", and the docs only show `{ id }`. So when a filter matches several visible rows, `can`/`assert` answer for whichever row the engine puts first, not for any defined set. On SQLite that turned out to be primary-key order. Two runs show it. In the first, u2's post has the higher id: u2 get

### Fprinciples-6: An unplanned implication prover is a second owner of where semantics

- Where: src/rbac/compile.ts:490-628 (implies/provable/narrower/same/conjoin)
- Claim: About 140 lines restate filter semantics in JS (in/hasSome narrowing, contrapositive NOT, quantifier monotonicity) to drop placement and move conjuncts. Any unsound step fails open. No section of the plan specifies it, and its comment cites D9, which is about permissions as data. The overlap it removes comes from the design: a move restates within and limit, which WITH CHECK already judges.
- Evidence: Reading, plus the BigInt crash (Fprinciples-2) that the prover alone raises. My soundness checks of OR/AND/NOT/is/some/every/in/hasSome/$if found no unsound drop.
- Proposed fix: Compile moves from the create rule and the key clauses without within and limit (which every P already conjoins) and let the engine dedupe by predicate name, then delete the prover, or record it in the plan as a capability with its own soundness witnesses.
- Skeptic 1: confirmed, critical. Confirmed, and worse than claimed. The prover (src/rbac/compile.ts:483-628, used for placement at :809 and moves at :838) appears in no section of the plan. The plan's only "dedupe" is K2(d), which is about binding equal values once. Its comment cites D9, which covers permissions as data and ABAC, not placement. It also restates filter semantics in JS. The reviewer found no unsound drop, but there is one, and it fails open.

The cause is in conjoin's R6 safeguard (:598-623). It drops a member M when another conjunct implies it and "reads" every actor path M reads. references() (:584-596) counts a parameter anywhere in the other conjunct, including inside an OR arm guarded by an actor conditi
- Skeptic 2: confirmed, medium. Confirmed, both from the code and with a run. src/rbac/compile.ts:482-628 (implies/provable/conjuncts/narrower/same/references/conjoin) is about 145 lines that reason about `where` semantics in JS: in/hasSome subset narrowing, contrapositive NOT, quantifier monotonicity and OR/AND distribution. They are used at compile.ts:809 (place) and :838 (each move:<field>) to drop conjuncts. The only design source cited is "(D9)" at compile.ts:14 and :486. Plan D9 (rbac-extension-plan.md:326-331) covers permissions as data and ABAC and says nothing about implication or dedupe. Grepping the plan for implies/provable/drop/conjunct/"said once" finds no section that specifies this mechanism, including 11.2

### Fprinciples-7: One extra rule key flips a model's delete verb and the shape of $access

- Where: src/rbac/compile.ts:638, src/rbac/compile.ts:226-236 (evidenceOf.ordered)
- Claim: "Ordered" is decided by whether the model's action count equals the number of levels. Adding any rule key (for example `invite`) to a model that only takes the levels removes its delete verb (nobody can delete) and turns `$access` from a level string into a record, with no refusal.
- Evidence: principles/extra-action.probe.ts on rbac-app pageGroup: levels only → `delete: full`, evidence ordered:true; with `invite: owner("createdById")` → `delete: undefined`, evidence unordered over [view, edit, full, invite].
- Proposed fix: Derive the delete default and the projection shape from an explicit declaration (an `ordered`/`delete` choice), not from counting actions, or refuse the ambiguous case at rbac().
- Skeptic 1: refuted, none. The code path is real, but it is the specified and documented behaviour, not a defect. In src/rbac/compile.ts:179-206 (actionsOf), a rule key that is not a level becomes an action implying view. evidenceOf (compile.ts:214-228) sets ordered only when there is no `actions` block and the action count equals the number of levels. verbsFor (compile.ts:631-643) uses the last level as the delete action only when ordered, and otherwise uses "delete". The type side agrees: Ordered in src/rbac/index.ts:268-276 is false once ActionsOf is not a subset of Levels, so there is no mismatch between types and runtime.

This is exactly what the specification and the user docs promise:
(1) Plan line 287, D (OD-
- Skeptic 2: refuted, low. The behaviour reproduces, but it is what the spec and the docs say should happen, so it is not a defect. Code path: evidenceOf (src/rbac/compile.ts:214-228) sets ordered = policy.actions === undefined && names.length === levels.length. actionsOf (compile.ts:180-191) adds any rule key that is not a level as an action implying view. verbsFor (compile.ts:631-643) then maps delete to levels.at(-1) only when ordered is true, and otherwise to "delete", which the model does not declare, so no delete verb is set.

Why this is not a bug:
- Plan OD-3 (rbac-extension-plan.md:287 and :624) says "when the model's actions are exactly the levels chain, delete → its last level", and that an undeclared opera

### Fprinciples-8: The composed acceptance case is not the §1.1 text and does not read as derived from the same words

- Where: docs/architecture/rbac-extension-plan.md:113,126; docs/content/docs/extensions/rbac.mdx:518
- Claim: §1.1 still spells `policy(tombstones(base)).$extends(audit)`, `v.string().optional()` and a stored variant without `roles`. The shipped spelling is `policy.methods(tombstones.methods(policy.rows(tombstones.rows(base)).$extends(audit)))`, and `$as` sits in the rows step, so rbac's rows step must be the last rows step. The M2 exit's "§1.1 verbatim" cannot hold, and §11.3 does not record it.
- Evidence: tests/package/rbac-consumer-smoke.mjs:232-236 asserts the §1.1 spelling is refused and uses the four-call form; tests/types/rbac/acceptance-policy.ts header lists three departures from §1.1.
- Proposed fix: Amend §1.1 and §11.3 to the shipped spelling, and give official entries one composition helper (or let $bind live on the methods step) so that the composed case is one call per extension.
- Skeptic 1: confirmed, low. The finding is partly confirmed, but its main point is overstated. This is plan drift, not a defect: no policy bypass and no broken user promise. rbac.mdx:505-524 documents the shipped four-call spelling, says `policy(tombstones(base))` is refused, and says stored ceilings list their roles. The code matches all of this.

Two of the three departures are recorded, so "§11.3 does not record it" misses where they are.
(1) Composition. §1.1 line 126 already flags its own line: "needs OD-1 (K7(b)): refused in both orders today". §11.2 F6 then falsifies OD-1 option (1) and adopts option (2): "official entries expose their rows step and methods step, applied rows first". §11.2's preamble says "the u
- Skeptic 2: confirmed, low. Confirmed in the plan text and in a run. The plan's §1.1 was never amended. It still spells `session: v.string().optional()` and `key: v.object({...}).optional()` (rbac-extension-plan.md:29,34). It still gives `const db = policy(tombstones(base)).$extends(audit)` at :126, with its own comment "refused in both orders today". Its stored-role variant at :113 has no `roles`, but tests/types/rbac/acceptance-policy.ts:180 needs `roles: ["admin","member","reader"]`.

The shipped spelling, in rbac.mdx:516-518 and rbac-consumer-smoke.mjs:236, is `policy.methods(tombstones.methods(policy.rows(tombstones.rows(base)).$extends(audit)))`. In the code, `$as` is defined in the rows step (src/rbac/index.ts:5

### Fprinciples-9: The policy's `{ actor: "path" }` marker captures JSON literals

- Where: src/rbac/compile.ts:358
- Claim: `value()` rewrites any one-key object `{ actor: string }` at any depth of a value position into an actor parameter, so a JSON equality literal of that shape silently becomes the actor's value, or is refused as an unknown actor path.
- Evidence: principles/jsonmarker.probe.ts: document.view { attributes: { equals: { actor: "userId" } } } compiles to `{"attributes":{"equals":{"control":"actor","path":"userId"}}}`; with "system" → ClientInitializationError (unknown actor path).
- Proposed fix: Do not rewrite inside JSON-typed field filters (the compiler already reads scalar types), or spell the marker with a key no where value can hold.

### Fprinciples-10: A friend type import and an underived public surface (compile, config, CompiledPolicy/CompiledModel)

- Where: src/rbac/index.ts:13, src/rbac/compile.ts:17, tests/package/public-surface-golden.mjs:713-743
- Claim: The entry imports `RowsVerbs` from the non-public `../extensions/controls` (AGENTS.md:297 says never a friend import; soft delete imports none), and it exports `Policy.compile`, `Policy.config`, `CompiledPolicy` and `CompiledModel extends RowsVerbs`. That makes the core verbs shape a public contract by proxy. Neither the plan nor the guide asks for it.
- Evidence: grep: `RowsVerbs`/`RowsContribution` are not re-exported by src/index.ts or src/extensions/index.ts; the golden lists CompiledModel and CompiledPolicy; rbac.mdx never mentions compile or config.
- Proposed fix: Export the verbs types from the public extension entry or stop exposing compile and the compiled types (keep them internal for tests).

### Fprinciples-11: refuseUnreachable keeps its own operation-to-verb table, which omits upsert

- Where: src/rbac/index.ts:419
- Claim: VERB_OF restates which verb each operation takes, beside the engine's own verb choice (K3), and it has no `upsert`. An upsert on a model with no update verb is not refused before any statement (R9) and is decided by the engine after a statement.
- Evidence: Reading only, not run: Operations (src/client/types.ts:75-91) includes upsert; VERB_OF does not.
- Proposed fix: Derive the root verb from the engine's routed-operation facts (one table), or add upsert under update and create.

### Fprinciples-12: Framing names leak into core

- Where: src/errors/query.ts:128, src/errors/base.ts:511, src/drivers/d1/index.ts:192-193, src/extensions/admission.ts:202, src/rbac/index.ts (ForbiddenError(model, action))
- Claim: Core comments name "policy", "assert" and rbac test files, and rbac's can/assert put an action name into ForbiddenError's `operation` meta field, so a core error field carries rbac's vocabulary.
- Evidence: git grep on 2999badd6 outside src/rbac: "A policy refused the operation … or an explicit `assert`" (errors/query.ts:128); "d1-rbac-verbs W-W3" (d1/index.ts:192); "Policies may be data built at runtime" (admission.ts:202). index.ts throws `new ForbiddenError(model, action)`.
- Proposed fix: Word core comments in terms of judgements and predicates, and carry the action in its own meta key, not `operation`.

### Fprinciples-13: Blog readability: `create:` is a placement key beside action keys, judged at an action no rule names

- Where: src/rbac/compile.ts:133 (PLACE = "create"), docs/content/docs/extensions/rbac.mdx blog
- Claim: In `post: { view, edit, delete, create }`, `delete:` is an action rule while `create:` is the reserved placement. The create operation is gated at `operations.create` (default `edit`) through within and limit only, so `edit: owner("authorId")` does not apply to creates. The simplest case fits in 8 lines but one key means two different things.
- Evidence: Reading only, not run: RESERVED includes "create"; at() lowers within, limit and the create rule at operations.create ?? "edit" without P(edit).
- Proposed fix: Name the placement key apart from the operation (for example `place:`), or document in the blog that `create:` is the placement and not an action.

### FDOCS-1: A misspelt reserved key in a model's policy becomes an action that implies view, so a typo widens reads

- Where: src/rbac/compile.ts:189-192 (actionsOf); src/rbac/index.ts:89-91 (ActionsOf); docs/content/docs/extensions/rbac.mdx:113-116
- Claim: Any model key that is not reserved (for example `whithin`, `crate`, `arm`) becomes an action that implies `view`. Its rule is OR'd into `P(M, view)` and the misspelt conjunct disappears. Neither TypeScript nor `rbac()(base)` refuses it, even when the model declares its own `actions` map.
- Evidence: p4.ts on SQLite3, packed tarball. Correct `{ within: member({via:'organization'}), view: owner('authorId') }` returns ["p1"]. The typo `whithin:` returns ["p1","p2"], and so does the typo with `levels` and with an `actions: { view: [], edit: ['view'] }` map. t1.ts under tsc --strict 5.9.3 gives no error for `whithin` (T1) or for `edti` beside an actions map (T6). By contrast the CHANGELOG says core `rows.verbs` refuses unknown entry keys because 'a misspelt `writes` would judge its fields at `update`'.
- Proposed fix: Refuse at application, and in DeclarationCheck, any model key that is neither reserved nor a level nor a key of the model's `actions` map (rule keys outside `levels` must be listed in `actions`, or in an explicit `extraActions`).
- Skeptic 1: confirmed, high. I confirmed this by running it. In src/rbac/compile.ts:189-192 (actionsOf), every model key that is not in RESERVED and not already an action becomes a new action that implies `view`. This happens even when the model declares its own `actions` map. The rule under that key is then OR'd into P(M, view). TypeScript does not catch it either: ActionsOf in src/rbac/index.ts:89-91 counts every non-reserved key as an action, so DeclarationCheck on rbac(config) stays silent.

What the run showed:
- A typo of `within` turns the conjunct within ∧ view into the disjunction within ∨ view. The tenancy guard disappears.
- In a model with an explicit actions map, a misspelt action key `edti: {}` makes view
- Skeptic 2: confirmed, high. Confirmed by running it and by the exact code path. At src/rbac/compile.ts:189-192, actionsOf adds every model key that is not in RESERVED and not already an action as a new action that implies "view". It does this even when the model declares its own `actions` map. P(M, view) takes in every action that implies view, so a misspelt `within` stops being a conjunct and becomes one more OR'd arm. A misspelt action key next to an `actions` map does the same. On the type side, ActionsOf in src/rbac/index.ts:89-91 includes `Exclude<keyof M & string, Reserved>`, so UnknownActions can never flag such a key, and `rbac()` does not refuse it. The docs (rbac.mdx:113-116) describe this for `levels` ("a ru

### FDOCS-2: Unknown top-level config keys and unknown model names in keyLimit ids are silently ignored, which drops the API-key limit

- Where: src/rbac/helpers.ts:319 (`ids?.[model.name]`); src/rbac/compile.ts:83-96 (RbacConfig, no key check)
- Claim: The errors table promises that 'an unknown model ... is ClientInitializationError when the policy is applied'. Yet `keyLimit({ ids: { pots: ... } })` and a top-level typo `limits:` both pass tsc and `rbac()(base)`. In both cases the key's row-id or scope restriction is silently gone.
- Evidence: p4.ts: correct `ids: { post: { path: 'key.ids' } }` with key ids ['p1'] returns ["p1"]. `ids: { pots: ... }` returns ["p1","p2"]. `limits: keyLimit(...)` with an empty-scope key returns ["p1","p2"]. p3.ts: 'keyLimit ids misspelt model => applied (NOT refused)', 'unknown top key => applied (NOT refused)'. t1.ts: no tsc error for T2 (`limits`) or T3 (`ids.pots`). Fails open.
- Proposed fix: Refuse unknown top-level keys and `keyLimit.ids` model names that the schema lacks when the policy is applied, and constrain `ids` keys to the listed models in the types.
- Skeptic 1: confirmed, high. Confirmed by a run and by the code. In src/rbac/helpers.ts:303-319, `KeyLimit.ids` is typed `{ readonly [model: string]: ... }`, and `limit()` only looks up `ids?.[model.name]`. An `ids` key that names no model of the schema is never visited, so nothing checks it. compilePolicy (src/rbac/compile.ts:254-256) checks only the keys of `config.models` against the schema. It reads `config.limit` at lines 333 and 802 and never looks at any other top-level key, so `limits:` (or any other typo) is dropped without a word. `rbac` takes `Config extends RbacConfig` as an inferred generic, so TypeScript runs no excess-property check. SchemaCheck (index.ts:225-228) covers only `keyof Config["models"]`. The
- Skeptic 2: confirmed, high. Confirmed by running it. When the policy is compiled against the rbac-app schema (compilePolicy, which is what rbac()(base) runs), an unknown model name in `models` is refused ("models.pgae: the schema has no such model"). An unknown actor path inside keyLimit ids is also refused. But a model name inside keyLimit `ids` that the schema lacks is never checked: src/rbac/helpers.ts:319 `const listed = ids?.[model.name]` only looks up real model names, so the misspelt entry is skipped. The compiled page.view predicate then drops the `id in key.resources.document` restriction. A top-level typo `limits:` is likewise ignored, because the compiler reads only `config.limit` (compile.ts:333 `config.lim

### FDOCS-3: 'A revoked key reaches nothing at once' is false for an actor that also carries a live session

- Where: docs/content/docs/extensions/rbac.mdx:473-475; src/rbac/helpers.ts:63-82 (session())
- Claim: `session()` ORs the session arm and the key arm. An actor that binds both a disabled or expired key and a live session id keeps every right through the session, narrowed only by the key's scopes. The guide states without qualification that a revoked key reaches nothing.
- Evidence: p1.ts on the rbac-app fixture: `k02-disabled-key` alone gives 0 pages. `{ ...k02-disabled-key, session: 'ses-02-live' }` gives 62 pages, the same as the session-only actor. p11.ts: the same actor gets `page.can('full', { id: 'page-001' })` true. The fixture's own comment says 'Session and key at once: either credential keeps the membership active'.
- Proposed fix: Make `session()` require the key arm whenever the actor carries `key` (key live AND, if present, session live), or state in bold that an actor must carry exactly one credential and the key is only revoked for key-only actors.
- Skeptic 1: confirmed, medium. I confirmed the behaviour, but I rate it medium rather than high. In `src/rbac/helpers.ts:63-82`, `session()` builds an OR of two arms: a live session (`$if` the actor carries `session`) and a live key (`$if` it carries `key`). An actor that carries a revoked key plus a live session therefore passes through the session arm. My probe confirms this on SQLite with the rbac-app seed: the key row key-02-b has enabled=false, the key alone gives 0 pages, and the same key plus ses-02-live gives 62 pages, the same as the session alone. `page.can('full')` turns from false to true, and the expired key-03 goes from 0 pages to 6 once its session is added. So the guide's unqualified sentence at `docs/cont
- Skeptic 2: confirmed, low. The behaviour is real, but it is the design the owner chose, not a policy bypass. Only the guide's wording is wrong.

The code path is exact. In src/rbac/helpers.ts:63-82, `session()` is `OR[ {$if carries(session), sessions.some(id = actor.session, live)}, {$if carries(key), apiKeys.some(id = actor.key.id, enabled, unexpired)} ]`. `keyLimit` (helpers.ts:313-346) checks only the key's scopes and `ids`, never whether the key is live. So once the actor also carries a live session, the key's liveness drops out of the predicate.

My SQLite3 probe on the rbac-app fixture (rbac rows/methods over soft delete, as in rbac-entry-behavior.ts) gives:
- `k02-disabled-key` alone: 0 pages, `can(full)` false

### FDOCS-4: A unique scalar can be read-gated, and a write's unique constraint then confirms the gated value on a visible row

- Where: docs/content/docs/extensions/rbac.mdx:436-451 (field levels) and 647-654 (Existence); reads admission in src/extensions (only keys and foreign keys refused)
- Claim: `fields: { email: { read: 'full' } }` on a `.unique()` column is admitted. A caller lacking `full` sees the field omitted and `findUnique({ where: { email } })` reads it as absent. But updating its own row to a guessed value raises UniqueConstraintError exactly when another visible row holds it. That reveals the gated value, which the residual-disclosure list does not mention.
- Evidence: p10.ts: 'gating a unique scalar: accepted'. u2's row reads `{id:'u2',name:'b'}` (email omitted). `findUnique by gated email => null`. `update own email to 'secret@corp' => UniqueConstraintError`. `update own email to 'nope@corp' => ok`.
- Proposed fix: Refuse `read` gating on a scalar that is part of any unique constraint (as keys are), or list 'a unique constraint on a read-gated field reveals its value' among the bold residual disclosures.
- Skeptic 1: confirmed, high. I reproduced this against the clone's source at 2999badd6, not the packed dist (the dist was built at 23:17 and the commit is from 23:35). rbac() accepts `fields: { email: { read: "full" } }` on an `s.string().unique()` column. Only keys, foreign keys and relations are refused (rbac.mdx:450-451). For a caller without `full`, u2's row comes back without email, and `findUnique({ where: { email } })` and `where: { email: { startsWith } }` both read the field as absent. But `update` of the caller's own row to a guessed value raises UniqueConstraintError exactly when the guess matches u2's hidden email, and succeeds otherwise. That is a guess-and-confirm oracle on the field's value, not on whethe
- Skeptic 2: confirmed, high. Confirmed by reading the code and by an independent run. The only read-gating refusal is keyFields in src/extensions/admission.ts:61-77, which covers id fields, compound-id fields and relation foreign-key fields. Single and compound unique scalars are not refused, and src/rbac/compile.ts:784-786 admits `fields.<f>.read` for them. A read-gated unique field still acts as a guess oracle through the database constraint. A create or update that writes a guessed value raises UniqueConstraintError exactly when some row holds that value. The docs' Existence list (rbac.mdx:647-654) and plan 5.2:462 cover only "a unique constraint on create or upsert over a hidden key". They promise each residual "rev

### FDOCS-5: can/assert accept any where, and assert passes when the first matching visible row holds the action

- Where: src/rbac/index.ts:349-356 (types: W is the `exist` where) and 586-592 (`findFirst`)
- Claim: `can` and `assert` answer for an arbitrary first row of a non-unique `where`. `assert('edit', { organizationId })` resolves although some matching rows are not editable, which contradicts the JSDoc 'Resolves when can holds for every action' as a user would read it for a set.
- Evidence: p6.ts: u01 views 62 pages and may edit 61 (page-009 is view only). `call.page.assert('edit', { organizationId: 'org-1' }) => ok`. `call.page.can('edit', {}) => true`. blog-probe.ts gives the same result (`can non-unique where {} => ok true`).
- Proposed fix: Type the argument as the model's unique `where` (and refuse a non-unique one at runtime), or define and implement can/assert over every matching row (count of rows lacking the action = 0).
- Skeptic 1: confirmed, medium. Confirmed by reading the code and by a run. At src/rbac/index.ts:586-589, `ask` calls `read.findFirst({ where, select: { $access: asked } })` and judges only the one row that comes back. It has no uniqueness check and no orderBy. The `where` type (WhereOf, src/rbac/index.ts:337-340) is the `exist` operation's where, so the type checker accepts non-unique filters. This departs from the plan: D8's O says the methods run "over the model's `findUnique`". The JSDoc ("the row `where` selects") and the guide's examples (`{ id }`) also assume a single row. With a where that matches several rows, the answer comes from whichever matching visible row the database returns first, which is arbitrary. So `
- Skeptic 2: confirmed, medium. I reproduced the claim. `ask` in src/rbac/index.ts:577-591 calls `read.findFirst({ where, select: { $access: asked } })` and reads only that one row. The `where` type at :337-340 and :349-356 is the model's `exist` where, not its unique where, so a non-unique filter type-checks and runs. With such a filter, `can` and `assert` report on whichever visible row comes first. This also departs from the normative plan: D8 (rbac-extension-plan.md:321) says the methods go "over the model's `findUnique`". The JSDoc promise "Resolves when `can` holds for every action" holds for a single row but not for a set. I put it at medium, not high or critical. No data is disclosed and nothing is written outside

### FDOCS-6: Misspelt keys inside a `fields` entry are ignored at runtime: the gate is silently off

- Where: src/rbac/compile.ts (fields entries read without key validation); docs/content/docs/extensions/rbac.mdx:427-451
- Claim: `fields: { salary: { reed: 'full' } }` exposes salary to every viewer, and `{ wirte: 'full' }` lets an editor write it. Only TypeScript's excess-property check catches these, so a JS caller or a config built from a non-literal value fails open.
- Evidence: p9.ts: correct read gate returns rows without `salary`, the typo 'reed' returns `salary: 99`. The typo 'wirte' lets an editor set salary to 1, while the correct `write: 'full'` gives NotFoundError. t2.ts: tsc reports TS2353/TS2561 on the literal.
- Proposed fix: Refuse unknown keys in `fields` entries (and in `operations`) when the policy is applied, with a ClientInitializationError naming the path.
- Skeptic 1: confirmed, medium. I confirmed the claim from the code and with a run against the clone at 2999badd6. In src/rbac/compile.ts:768-787 the loop `for (const [field, { read, write }] of Object.entries(policy.fields ?? {}))` checks only that the field name exists on the model (line 779). It destructures `read` and `write` and never looks at the entry's other keys. A misspelt key gives `read === undefined` and/or `write === undefined`, so the field gets no gate in `reads`/`writes` and the policy is accepted without error.

This is inconsistent with the rest of the compiler. `operations` keys are refused (compile.ts:755-759, "models.X.operations.Y: not an operation"), model keys are checked through RESERVED/implies (
- Skeptic 2: confirmed, medium. I reproduced it. src/rbac/compile.ts:768-786 destructures each `fields` entry as `{ read, write }` and never checks for other keys. It also does not check that the entry is an object at all. So `{ reed: "full" }` and `{ wirte: "full" }` compile to `reads: {}` and `writes: {}`, and the gate is off without any error. `operations` gets different treatment: compile.ts:755-759 refuses an unknown key ("not an operation"). Only the `fields` part of the proposed fix is needed, because `operations` is already guarded. The asymmetry is real and it fails open. I rate it medium rather than high for three reasons. TypeScript catches the literal (TS2353/TS2561 per the reviewer). The values can only come f

### FDOCS-7: 'An application that does not import it pays nothing for it' is false: core grew about 10 KB gzip for every application

- Where: docs/content/docs/extensions/rbac.mdx:21-22; package.json size-limit messages
- Claim: The capabilities added for rbac live in core. Every pg application now carries +1,900 +1,440 +5,650 +1,278 = 10,268 B gzip (170 → 179.12 kB), and about the same on D1. Each client also retains +250-300 B (plan §8).
- Evidence: package.json at 2999badd6, 'pg application (viborm/pg)' message: 'Raised 170 → 171.9 ... 173.34 ... 178.2 ... 179.5 kB by the measured +1,900/+1,440/+5,650/+1,278 B of RBAC'. 'D1 Worker' message: 170 → 179 kB. Plan §8: 'createClient ... retained per client 11,145-11,198 B (+250-300 B)'.
- Proposed fix: Say that the entry is opt-in but its capabilities cost every application about 10 KB gzip, or drop the sentence.
- Skeptic 1: confirmed, medium. Confirmed. docs/content/docs/extensions/rbac.mdx:20-22 says the extension "is built only from public extension capabilities (`controls`, `rows` and its `verbs`, ...)" and "lives in its own entry point, so an application that does not import it pays nothing for it". The core capabilities written for RBAC (K1-K7, E5, OD-10) are paid by every application, including ones that never import viborm/rbac.
(1) The bundle fixtures scripts/bundle-fixtures/pg-representative.mjs and d1-worker.mjs import only dist/pg.mjs (or dist/d1.mjs) and dist/schema.mjs. They are unchanged in 2fcaa26a8..2999badd6, and the built bundles contain no "rbac" string.
(2) The plan's own measurements (rbac-extension-plan.md:2
- Skeptic 2: confirmed, medium. I confirmed this by building both commits myself, without trusting the package.json messages. I extracted 2fcaa26a8 (1.2.4) and 2999badd6 into scratch with git archive, built each with tsdown, and emitted the consumer bundles with scripts/measure-bundle.mjs. The pg-representative and d1-worker fixtures are the same in both commits and import ../../dist directly, so the comparison is clean. All 9 commits in the perimeter are RBAC work.

Results in gzip -9 bytes, for applications that never import viborm/rbac:
- pg application: 168,610 → 178,939 (+10,329)
- D1 Worker: 167,957 → 178,447 (+10,490)
- pg + soft delete: 168,935 → 179,321 (+10,386)

The pg application bundle at HEAD contains RBAC ca

### FDOCS-8: 'Built only from public extension capabilities' while the compiler reads private schema state and an unexported core type

- Where: src/rbac/compile.ts:262-310, 652-710 (`["~"].state`, `settleTarget()`); src/rbac/index.ts:13 and compile.ts:17 (`RowsVerbs`); docs/content/docs/extensions/rbac.mdx:19-22; AGENTS.md:305-306
- Claim: The rbac compiler introspects models through the internal `~` accessor (foreign keys, nullability, enum values, `settleTarget`), which docs/internals/scalars.mdx calls an 'Internal pattern'. Its public `CompiledModel extends RowsVerbs` while `RowsVerbs` is exported from no entry. A third-party author therefore cannot rebuild it from documented exports.
- Evidence: grep of src/rbac: compile.ts:262 `schema[name]!["~"].state as unknown as ModelFacts`, :268 `settleTarget()`. The public-surface golden has no `RowsVerbs` in any entry. dist/rbac.d.mts:1 imports `qt as RowsVerbs` from an internal chunk.
- Proposed fix: Export a documented schema-introspection surface and `RowsVerbs` (or `RowsVerbsContribution`), or qualify the claim to 'public extension capabilities plus schema introspection'.

### FDOCS-9: A to-one `delete: true` gives ForbiddenError, not the documented NestedWriteError, when the key it nulls is read by placement

- Where: docs/content/docs/extensions/rbac.mdx:375-380
- Claim: When the parent's `create` rule reads the foreign key, a nested `author: { delete: true }` (and `disconnect`, and even a no-op delete with no target) is refused as a root move with ForbiddenError. The guide promises NestedWriteError for a target the caller may not delete. No disclosure: hidden and visible give the same class.
- Evidence: p12.ts with `post.create = { authorId: { actor } }`: visible undeletable author `delete:true => ForbiddenError "The update on post is not permitted"`. Hidden author gives the same. No author gives the same. With `create: {}` the same calls give NestedWriteError. p6.ts on the fixture: `document.update({ data: { parent: { delete: true } } }) => ForbiddenError`.
- Proposed fix: Document that a nested write which changes a key placement reads is judged as a move first (ForbiddenError), or report it as NestedWriteError.

### FDOCS-10: The caching example throws TypeError unless the cache extension is applied, which the guide does not say

- Where: docs/content/docs/extensions/rbac.mdx:551-556
- Claim: `await call.$withCache().page.findMany(); // ValidationError` is only true when `cache()` is in the chain. Otherwise `$withCache` is undefined.
- Evidence: blog-probe.ts: `withCache => TypeError "call.$withCache is not a function"`. cache-probe.ts with cache below or above: ValidationError 'Control "actor" is not cacheable' (correct).
- Proposed fix: Show the cache in the chain in that snippet (`blog(base.$extends(cache({...})))`).

### FDOCS-11: `distinct` over a read-gated field drops rows, contradicting 'Rows are never dropped for it'

- Where: docs/content/docs/extensions/rbac.mdx:436-443
- Claim: Gated values read as NULL, so `distinct: ['budget']` collapses every lacking row into one.
- Evidence: p2.ts: u01 lacks `full` on col-1-05 (budget 53864) and col-1-08 (48253). `findMany({ where: { id: { in: lack } }, distinct: ['budget'] })` returns `[{id:'col-1-05'}]`.
- Proposed fix: Say that `distinct` and `groupBy` over a gated field merge the lacking rows into one NULL group.

### FDOCS-12: `$access` on a leveled model is typed `Level | null`; a subset returns null when unheld, which is undocumented

- Where: docs/content/docs/extensions/rbac.mdx:421-425; src/rbac/index.ts (ModelVerbs evidence typing)
- Claim: The guide says `$access` is the highest level held and `view` is always held on a read row, yet the type includes `null` even for `$access: true`. With `$access: ['edit']` a leveled model returns `'edit'` or `null`, never the record or the true highest level, and nothing documents this.
- Evidence: t1.ts / guide-types.ts tsc: "Type 'null' is not assignable to type '\"view\" | \"edit\" | \"full\"'" for `rows[0].$access` with `$access: true`. p5.ts: page-001 (full) `$access ['edit'] => "edit"`, `['view'] => "view"`. page-009 (view) `['edit'] => null`.
- Proposed fix: Type `$access: true` on a read row as non-null, and document that a named subset on a leveled model returns the highest named level held, or null.

### FDOCS-13: 'Every actor path ... is checked in TypeScript' does not hold for function rules

- Where: docs/content/docs/extensions/rbac.mdx:101-103; src/rbac/index.ts:116-140 (SpelledActorPaths skips functions)
- Claim: A misspelt actor path inside a rule function, an arm function or a helper result type-checks. Only the runtime refusal catches it.
- Evidence: t1.ts T4 `view: (a) => ({ authorId: { actor: 'usrId' } })` gives no tsc error. T5, the same path in a literal, errors as expected. p3.ts: runtime gives ClientInitializationError 'reads actor path "usrId"'.
- Proposed fix: Say 'in TypeScript for literal rules, and for every rule when the policy is applied'.

### FDOCS-14: Numbers and labels in CHANGELOG and the guide disagree with the plan or are stale

- Where: CHANGELOG.md Unreleased 'A read allocates no more per call'; docs/content/docs/extensions/rbac.mdx:578-587
- Claim: The CHANGELOG gives 1.2.4's `findMany` with two includes as 106,744 B, while plan §8 measured 106,664 B at 2fcaa26a8. The JIT table is from E4.2 at 89936c45d plus E4.1 (M1, before K4/K5 and shared bodies) but is presented as current. The user-facing CHANGELOG also cites internal labels (OD-7, OD-10, OD-11).
- Evidence: Plan §8: '`findMany` with two includes 106,664 → 108,352'. CHANGELOG: '106,744 → 106,616 B'. scratchpad/rbac/e4/pg-cost.md: 'HEAD 89936c45d plus E4.1'.
- Proposed fix: Reconcile the baseline figure, date the JIT measurement to its commit or re-measure at 2999badd6, and remove OD-n labels from the CHANGELOG.

### FDOCS-15: Error descriptions and paths name things the caller did not write

- Where: docs/content/docs/client/errors.mdx:214; docs/content/docs/extensions/rbac.mdx:530-541
- Claim: errors.mdx describes ForbiddenError only as a refused produced row or assertion, but it is also raised before any statement (unlisted model, undeclared verb or `as` mode, `can` with an undeclared action). `$as` validation reports 'Validation failed for $bind', a method the caller never called. `omit: { budget: false }` fails at `select.budget`, which the guide's table does not mention. The table's 'When' for `assert` says 'in the statement, before the write'.
- Evidence: blog-probe.ts: `$as wrong type => ValidationError V4002 "Validation failed for $bind: actor: ..."`, `as on user: edit => ForbiddenError ... stmts 0`, `can undeclared action => ForbiddenError ... stmts 0`. p8.ts: `omit budget:false => ValidationError "... select.budget: is not readable"`.
- Proposed fix: Extend the errors.mdx row, name `$as` (or the operation) in the validation message, report the `omit` path, and fix the `assert` timing cell.

### FDOCS-16: Public surface exports undocumented internals and omits a type the guide implies

- Where: tests/package/public-surface-golden.mjs:713-744; src/rbac/index.ts:36-63, 434-440
- Claim: `compile`, `CompiledModel`, `CompiledPolicy`, `ActorPaths` and `Policy.config` are public, but the guide never mentions them. `CompiledModel` exposes the compiler's predicate encoding (`$if`, `{control,path}`, `move:<field>`). `PolicyModel`, the second argument of every rule function, is exported but the guide shows only `(a) => ...`. `RowsVerbs` is not exported.
- Evidence: The golden './rbac' types list includes CompiledModel, CompiledPolicy, ActorPaths and PolicyModel. grep shows no 'compile' or 'PolicyModel' in rbac.mdx. dist/rbac.d.mts exports `compile<S>(schema): CompiledPolicy`.
- Proposed fix: Either document `compile` and `PolicyModel` (the rule function's `(action, model)` signature) or mark them internal and drop them from the golden; export `RowsVerbs` from the root.

### Fsecurity-1: A caller-written soft-delete marker tombstones and restores a row at the update action, not the delete action

- Where: src/rbac/compile.ts (verbsOf/writes: marker fields take operations.update); src/extensions/controls.ts RowsVerbs (a tombstone takes delete only through the deletion capability)
- Claim: Writing `deletedAt` directly in an update (and soft delete's `restore`) is judged at `operations.update`, so an actor who holds `edit` but not `full` on a page can delete and undelete it, although the guide says a delete and a soft delete's tombstone take `operations.delete`.
- Evidence: Probe soft.probe.ts on SQLite3, fresh seeded DB per attack. u03 holds edit but not full on page-013. `page.delete({where:{id:'page-013'}})` gives NotFoundError (correct). `page.update({where:{id:'page-013'}, data:{deletedAt:new Date()}})` succeeds; raw read after: deletedAt set. Same result for u05. `page.restore` on tombstoned page-003 succeeds for u03 and u05 (view+edit, not full) and is refused for u04 (view only), so restore is judged at edit.
- Proposed fix: Judge any caller write of a field a `deletion` capability manages (to a value or to null) at the delete verb, or have rbac compile each tombstone marker's write action to operations.delete.
- Skeptic 1: confirmed, medium. Reproduced on SQLite3 at 2999badd6, with a fresh seeded database per attack and the state read raw afterwards, using the §1.1 acceptance policy composed as the guide says (policy.rows(tombstones.rows(base)), then the two methods steps). u03 and u05 hold edit but not full on page-013 (oracle). page.delete gives NotFoundError. page.update and page.updateMany with data {deletedAt: new Date()} both succeed and the row is tombstoned. page.restore on the tombstoned page-003 succeeds for u03 and u05 and is refused for u04 (view only). So writing the marker yourself, and restore (which src/soft-delete/index.ts builds as update({data:{deletedAt:null}, deleted:"only"})), are judged at operations.updat
- Skeptic 2: confirmed, medium. I reproduced the behavior, but I rate it medium, not high. On the §1.1 acceptance policy composed with soft delete as the guide shows, u03 holds edit but not full on page-013. `page.delete` gives NotFoundError. `page.update` and `page.updateMany` writing `deletedAt` both succeed, and the raw row is then tombstoned. `page.restore` on the tombstoned page-003 succeeds for u03 as well.

The code path: soft delete's `restore` (src/soft-delete/index.ts:127-137) is a plain `update({ data: { deletedAt: null }, deleted: "only" })`. rbac compile (src/rbac/compile.ts:766-784) fills `writes` only from `policy.fields.*.write`, and every unlisted field takes `verbs.update`. So a caller-written marker, set

### Fsecurity-2: can/assert answer for whatever row comes first when `where` is undefined, empty or not unique

- Where: src/rbac/index.ts:577-612 (ask -> findFirst({ where, select: { $access } }); WhereOf is the exist payload's where, not a unique where)
- Claim: `assert(action, where)` resolves when the first visible row it finds holds the action, so `{ id: undefined }`, `{}`, `undefined` or an OR pass the check for a row the caller never named.
- Evidence: Probe can.probe.ts on SQLite3, actor u03. `document.assert('share', {id: notShareDoc})` gives ForbiddenError (correct). `document.assert('share', {id: undefined})` resolves; `document.assert('share', undefined)` resolves; `document.can('share', {})` returns true; `document.can('share', {OR:[{id: notShareDoc},{id: aShareDoc}]})` returns true.
- Proposed fix: Require a unique where (findUnique semantics, refuse undefined values), or answer for every row the where selects and fail unless exactly one row is selected.
- Skeptic 1: confirmed, high. Confirmed. I ran it on SQLite3 at 2999badd6 with actor u03 (views 9 documents, can share 6 of them). `ask` (src/rbac/index.ts:580-593) runs `read.findFirst({ where, select: { $access: asked } })` and answers from whichever row comes back first. The where has the `exist` payload type (WhereOf, index.ts:337-340), not a unique where, and nothing checks that exactly one row is selected. So `assert('share', { id: undefined })` and `assert('share', undefined)` both resolve, while `assert('share', { id: 'doc-017' })` throws ForbiddenError. `can('share', {})` returns true. `can('share', { OR: [hidden doc-001, share doc] })` returns true. The answer also depends on row order: `can('share', { id: { in
- Skeptic 2: confirmed, high. Confirmed by reading the code and by a run. src/rbac/index.ts:580-591 `ask` calls `read.findFirst({ where, select: { $access: asked } })` and answers for whichever visible row comes back. The type `WhereOf` (index.ts:337-340) is the `exist` payload's non-unique where, so `{}`, `{ id: undefined }`, OR and `in` all typecheck and run. This breaks the spec. Plan D8 (rbac-extension-plan.md:321) says the methods run "over the model's `findUnique`", and the guide (rbac.mdx:393-405) presents `assert(action, { id })` as "ForbiddenError unless held" on the row named. With findUnique, `{ id: undefined }` fails closed (ValidationError: "whereUnique requires at least one unique discriminator", seen in th

### Fsecurity-3: The guide's list of existence disclosures leaves out updates over a unique key a hidden row holds

- Where: docs/content/docs/extensions/rbac.mdx:648-654 (Boundaries: Existence)
- Claim: The guide lists unique-constraint disclosures only for creates and upserts, but an update that writes a unique column (accessGrant.key, page.id) to a value a hidden row holds should also surface UniqueConstraintError, which a missing value does not.
- Evidence: unverified, reasoning only: R4 judges only placement fields before the constraint; the hidden-vs-missing probes (exist.probe.ts) confirmed UniqueConstraintError on create/upsert/connectOrCreate over a hidden key; the update path was not run.
- Proposed fix: Add updates of unique columns to the documented residual disclosures, next to creates and upserts.

## Attacks that did not land

### principles

- `$`-prefixed model member colliding with the `$access` key: the schema identifier rule refuses `$access` (ClientInitializationError), so PROJECTION_KEY's unique-coverage claim holds (principles/collide.probe.ts)
- Unsound conjunct drops in the implication prover: OR/AND/NOT contrapositive, is/some/every with the same rest, in/hasSome narrowing, $if hasSome, FALSE as coverer, mutual-equivalent drops, actor-reference retention; also JsonNull vs DbNull (distinct toJSON) and Decimal (has toJSON)
- Engine skipping WITH CHECK (`unchanged`) combined with compile dropping move conjuncts implied by the judged predicates: sound, since unchanged fields make the judged predicates hold on the new row
- Framing names (rbac, grant, role, permission, $access, actor, action) in core code identifiers outside src/rbac: none, only comments and docs
- New numeric caps in src: none beyond the known MySQL 3143; D1 balanced conjunctions use halving, not a cap; MAX_FILTER_DEPTH lifted for domain predicates only, as F3 says
- Providers named by the engine: only in comments and AGENTS.md as provider facts; behaviour hangs on adapter facts (sharedRelationBodies, deepExpressions)
- Ordered `$access` types vs runtime: KeyResult (Names|null, Some|null) matches the decoder's nullable enum; Ordered type matches evidenceOf
- Witness ids of §7 present in tests (W-R1..9, W-K1a..g, W-K2a..g, W-W1..12, W-P1..16, W-AS1..7, W-CAN1..6, W-EV1..4, W-F1..8, W-L1..8, W-N1..4, W-D1..12, W-C1..8, W-X1, W-H1, W-A1..6), presence only
- K7(a) duplicate control refusal and K7(c) earlier-control references are built in chain.ts as planned; definition-time undeclared-reference check correctly moved
- depth>16 rows refusal and BOUND_LIMIT FIFO deleted as K1/K2 say
- Single-action can() on a non-monotone policy: correct (asks only that name)
- Blog length: 8 lines in the plan, within the 10-line budget

### docs-api

- The guide's intro blog example type-checks with tsc --strict 5.9.3 against the packed tarball and runs on SQLite3: an id is generated, an own create succeeds, another author's create gives ForbiddenError V13001, an update of a hidden row gives NotFoundError, and $queryRaw returns every row.
- No actor gives ValidationError at actor with 0 statements. `actor` in the arguments gives a ValidationError (also a type error). An extra actor key, a wrong type and null are each refused by $as with ValidationError.
- Bound views: an interactive transaction, a derived $extends and call.$as(other) all keep or replace the actor as documented. An array transaction that mixes two views judges each for its own actor. A db operation without an actor inside an array transaction is refused.
- $withCache with a cache configured is refused below and above rbac with ValidationError 'not cacheable'. cache: "allow" keeps actors apart and serves a stale entry after a transfer, as documented.
- Definition refusals all raise ClientInitializationError: misspelt literal, condition, $if and raw control paths; keyLimit when and scopes paths; recurse: true; a self-cycle; an action or domain named default; a read-gated id, foreign key or relation; an unknown model or field; operations naming an undeclared action; a non-strict actor; a non-object actor; a record actor root; member via an unknown relation; owner of an unknown column; a keyLimit `through` typo.
- An `as` value no model declares gives ValidationError. One the model does not declare gives ForbiddenError with 0 statements. A domain narrows reads and counts.
- can and assert: a hidden row gives false, or ForbiddenError from assert. An undeclared action gives ForbiddenError with 0 statements. A list returns a record. Each is one statement.
- $access: a leveled model gets its highest level; other models get a record of booleans; a subset reports only the named actions; it works on rows a write returns.
- Field levels: a gated field is omitted. where, NOT, aggregate, groupBy (null key), orderBy, count, nested include where, relation filters, _count and $access treat it as absent. An explicit select, or one nested in an include, gives ValidationError at select.<field>, and the write rolls back on SQLite3 in both interactive and array transactions.
- Produced rows: a forbidden create over a hidden unique key gives ForbiddenError before the constraint. A missing FK target gives ForbiddenError. A hidden key set by a scalar or by connect gives the same class as a missing one. A cursor on a hidden row returns []. findUniqueOrThrow on a hidden row gives NotFoundError. connectOrCreate and skipDuplicates disclose existence as the guide documents.
- Nested writes: set: [] refuses a visible non-writable link. disconnect of a non-writable link gives NestedWriteError. A hidden tag keeps its link. Nested update or connect of a hidden or missing target gives NestedWriteError with an identical message.
- Composition: policy(tombstones(base)) and tombstones.rows(policy.rows(base)) both give ClientInitializationError. The documented chain policy.methods(tombstones.methods(policy.rows(tombstones.rows(base)).$extends(audit))) type-checks and runs.
- Unlisted models: a root call gives ForbiddenError with 0 statements; through a relation they read [].
- The guide's code blocks type-check over the fixture schema, apart from page.create, whose fixture requires `position`; the guide's schema is not shown, so this is not a defect.
- D1 and Neki figures in the guide (83 values, 18.9 KB, 98 values, 35 KB, 44.6 KB at depth 80, 241 → 41 relations) match plan §8. The JIT table matches scratchpad/rbac/e4/pg-cost.md.
- PgDriver accepts { databaseUrl, sharedRelationBodies: true } as the guide spells it.
- Every bold boundary the plan asks for is present: raw SQL next to the first example, call is not a sandbox, database cascades, mode: "hard", existence residuals, tenant-scoped unique keys, bearer secrets, cache.

### security

- Read-gated field (collection.budget) through where/NOT/gte, orderBy asc/desc and to-one orderBy, distinct, aggregate _sum/_avg/_min/_max/_count, groupBy by/having/_sum, relation filters (organization.collections, user.ownedCollections, accessGrant.collection), include where, _count where, cursor, findUniqueOrThrow extra filter, can where: all read the field as absent (gated.probe.ts, order.probe.ts)
- Explicit select of the gated field on reads, nested select, update/upsert results: ValidationError; on SQLite3 the update is rolled back; error metadata holds no value (gatedwrite.probe.ts)
- Unlisted models through relations: sessions/apiKeys some/none/every filters, include, _count, orderBy _count, organization.permissions; root calls refused with ForbiddenError (reads2.probe.ts)
- Smuggled markers: {control,path} in where and data, $if in where, {now:true}, marker inside in, actor in arguments and in where: all ValidationError (reads2.probe.ts)
- `as` mode: arrays, objects, __proto__, constructor, create, move:* names: refused; default narrows nothing (reads2.probe.ts)
- Upsert over hidden or view-only rows: UniqueConstraintError, row unchanged (documented); root update/updateMany/delete on view-only or hidden rows: NotFound or count 0 (writes1.probe.ts)
- Field write actions: ownerId through scalar, owner connect/disconnect, updateMany, nested update/updateMany/connect under an editable group; document children updateMany ownerId; archive-only actor writes archivedAt only, title/{}/archivedAt+title refused (writes1, nested.probe.ts)
- Moves: page group set [] refused by placement; connect of hidden/view-only page into an editable group refused (writes1.probe.ts)
- Parent cycles: scalar, updateMany, self, to-one connect, to-many connect/set from the descendant, self connect, nested parent update: all refused, state unchanged outside a transaction (writes2, writes3.probe.ts)
- Grant escalation: sharer creating an export grant (root, nested, createMany mixed, skipDuplicates), push/set export, nested update/updateMany, upsert, move to a view-only document, adding a non-administered page to the arc, disconnecting the document: all refused with no partial writes (writes2, writes3.probe.ts)
- Existence oracles hidden vs missing vs other-org: to-many connect/disconnect/set/update/delete, root update/delete, can/assert, written key targets (document parent, page group), creates under a hidden parent, polymorphic subject connect: identical class and message; only the documented unique-constraint cases differ (exist.probe.ts)
- Soft delete: deleted:'with'/'only' updates, restore and hard delete on hidden tombstones refused; hard delete by an editor without full refused (soft.probe.ts)
- Actor object: __proto__ and extra keys, wrong types, arrays, null optional, mutation after $as (top-level and nested key), getter re-read, scopes with __proto__/constructor: refused or snapshotted (actor.probe.ts)
- Concurrency: 30 actors under Promise.all, array transaction across 30 views, $extends from a bound view, unbound client and its transaction refused: all match the oracle (can.probe.ts)
- $access with unknown or prototype names, can with an undeclared action or 'default': refused (can.probe.ts)
