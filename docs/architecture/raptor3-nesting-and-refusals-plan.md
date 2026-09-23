# Raptor 3 — any nesting executes, and fewer refusals (plan, revision 2 — decided 2026-09-20)

Arnaud, 2026-09-19/20, after the gate triage (`raptor3-evidence/g4/release/gate/`)
and an external review of the first revision
(`raptor3-evidence/g4/release/plan/review-external.md`), whose corrections
this revision applies.

## 0. The rulings and the principle

- **D-51 — any nesting of nested writes executes.** A later nested operation
  whose target an earlier member of the same nested write creates, moves or
  removes is executed, never refused with "depends on an earlier … write in
  the same nested write. Split these operations". This reverses, by name,
  the retired design's §6.2 "uniform own-write preflight"
  (`engine-unification/DESIGN.md:876-921`): neither retired generation
  executed such shapes; the design vetoed them so the live and the batch
  route could never differ. They keep one result; the physical packaging
  differs (ELEGANCE §7) and the diagnostics say so (`committedSegments`).
- **D-52 — fewer refusals.** An admitted payload is executed one way or
  another; a refusal is kept where it names an execution fact (existence,
  membership, concurrency, cardinality, a provider's or a transport's
  genuine limit) that no owner can execute around. Three outcomes are
  reported apart and never traded against each other: supported behaviour
  that increased; dead or internal diagnostics removed or reclassified;
  integrity and provider boundaries that remain. A count is a result, not a
  target, and a valid schema never becomes illegal to move a sentence out of
  the runtime.
- **D-54 — the private recursive read stays private**, and N1's contract
  is written with it in mind: a recursive traversal is one more consumer of
  an ordered observation (a seed read, then rows valid after the effects
  that produced them), so the observation-validity rule and the barrier N1
  states are the seam a recursive operation would consume, with no second
  policy.
- **D-53 — PGlite establishes PostgreSQL SQL behaviour, not every driver's
  transport.** SQL tests are shared through PGlite; session lifetime,
  failure attribution and commit certainty are transport facts with their
  own witnesses per driver. A driver without such a witness stays
  unqualified for a behaviour that depends on them.

**The principle every unit below is built on** (the reviewer's, adopted):
*every consumer receives a value or an observation that is valid at its
execution point, after its prerequisite effects, with the required
protection, within the caller's authority.* Producer references, ordered
reads, membership requirements and segmentation are four cases of that one
rule, not four policies.

The standard is `ELEGANCE.md`; the owners are `src/query-engine/raptor3/AGENTS.md`'s.
Each unit answers its five questions, lands as one reviewed commit with a
ledger record, and re-expresses a pinned expectation only where a ruling
above changed the answer, naming it.

## 1. N1 — a dependent lookup is an ordered observation or an established producer

**What must be expressed.** A nested lookup's answer is valid at the point
its consumer executes: after the sibling writes that can change it, with
the premises that protect those writes still riding with them.

**Owner.** The dependency pass (`commands/commands.ts:536-693`,
`checkPair` → `readTarget` / `readMembership`) already computes the overlap
between a lookup and an earlier write — *disjoint*, *equal*, *unknown* —
and today spends it on a refusal. It keeps computing the fact and, with the
occurrence tree it already owns, decides the lookup's source and placement.

**The contract, three cases:**

1. **Disjoint** — unchanged: a capture-phase read.
2. **Established producer.** The lookup reuses an earlier write's row only
   when that write's *executed outcome* establishes the consumer's identity
   and conditions: an unconditional record write (not an arm of a `Choose`,
   not a suppressed or skip-eligible insert, not a delete, not a set
   mutation, not a write another sibling moves before the consumer) whose
   known literals cover every field of the lookup's selector, for a
   consumer whose selector has no remaining condition
   (`selection.facts.fields.size === 0`) — the terms the existing
   producer-sourced selection already demands on the live route
   (`execution.ts:236-248`). Then the lookup is that selection: no read,
   no premise, and on the batch route the produced key rides the reference
   scratch exactly as a child's foreign key does (D-50) — this batch leg is
   new work at the same owner, not a wiring of the existing shortcut, and
   it is what the `connectOrCreate` first-create-wins rule
   (`relation-body.ts:416-440`) already is for one verb, generalised.
3. **Ordered observation.** Otherwise the lookup is placed after its
   prerequisite effects and read there. The placement is the occurrence
   tree's: the lookup leaves the capture phase and becomes an effect-phase
   read ordered after the write it depends on, so no earlier capture can
   have cached an answer for it (`runSelection` keeps its positive cache;
   a dependent selection has none to keep because it is never read early).
   On the live route the read simply runs in order. On the batch route the
   read is a **barrier that submits the queued unit with its premises** —
   not `flush`, whose premise-withholding is right for a planning read
   (D-29) and wrong for a dependent one: the writes it dispatches must go
   with the premises that protect them, in one native batch, and the read
   follows in the next. That barrier is `submit` at a unit boundary, the
   same boundary a record series already crosses member by member; on a
   batch-only transport it is a committed segment, the "succession of
   statements" D-51 accepts.

**What each observation is valid for.** An observation made before a
sibling write of the same target is stale for every consumer placed after
that write; the pass gives such a consumer its own observation point rather
than a shared one. An observation taken after a write stays valid for the
consumers that follow it until the next overlapping write.

**Protection.** A dependent observation on the batch route is taken after
the unit that precedes it committed; what it then requires (the row's
presence at the consuming mutation, membership) is a premise of the NEXT
unit, asserted inside that unit's batch (`requirePresent`, `requireAbsent`,
`assertPremise` — statements that abort the batch before the write), never
a JavaScript check after the fact.

**Authority.** The array route (`$transaction([…])`) on a batch-only
transport refuses a member that would need a second segment (D-46's
unbatchable answer, unchanged). A scratch reference never crosses a segment
on a driver that cannot pin its session (§4, the transport fact).

**What disappears.** The two inherited sentences "depends on an earlier …
target / membership write" and their meta; DESIGN §6.2's uniformity as a
contract; the dead comparison specimen `src/query-engine/raptor3/program/`
(no consumer in the shipped graph; a third copy of the refusal).

**Reachable paths, walked.** The `Choose` arms and `activeRefusal`
(`commands.ts:874-884`); the six nested-target sites in `relation-body.ts`
(disconnect/delete, connect/update, the upsert found requirement, the
connectOrCreate retained row, the member sets), each for its result mode,
its empty case and repeated placements. The retained-row re-check
(`relation-body.ts:504-508`) is a same-lookup race, not a dependency, and is
not touched.

**Witnesses.** The nested-write conformance suites (37 cells): every
"allows" cell as written; every "rejects" cell that pinned §6.2's veto
re-expressed to the executed end state, named per cell; the tx-versus-batch
parity booleans (same rows, same identities). The D-16 family-5 cells. New
pins on a recording batch-only driver, one per case: an established
producer (no read, the scratch reference in the dependent statement, the
ineligible producers — a `Choose` arm, a suppressed insert, a delete —
falling to case 3); an ordered observation (the premises of the preceding
unit in ITS batch, the read in the next, `committedSegments` reported); a
disjoint read unchanged; the stale-observation case (two consumers of one
target across a write, two observation points). `g29-dependency-boundaries`
keeps its measurement.

**1 as landed (commit 24, branch `n1`).** The dependency pass keeps computing
the overlap and spends it on placement: `Commands.depend` finds the write's
and the read's execution points (a membership contribution executing with the
record whose fields carry it) in the run order of `CommandExecution.run` and
the relation body's canonical verb order, marks a read already behind its
write `dependent`, moves a read that would run first to the `after` phase at
its consumer's execution point (every effect carries its mutation's origin;
each payload entry is its own mutation; a set's targets share the set's), and
keeps the inherited sentence only for a read the ancestor's own write
consumes. Case 3 on the batch route is `flush` — its withhold is trailing
premises only, so the queued unit's premises ride — with the consumer's
requirement asserted inside the batch (`ObservationPremise`: the row present,
or no row outside the membership, NULL-safe). Case 2 is not a mechanism: an
observation answers it; the scratch leg is an optimisation to be measured.
A junction membership observes any link, removal or member set of its table;
a membership read observes a write of the fields it is read through unless
the written literal cannot be this parent's key. The ladder attributes the
one premise behind the unit's own writes when the re-probe clears the rest.
The `program/` specimen is a separate commit. Note and receipts under
`g4/release/n1/`.

## 2. N2 — the lax to-one no-op

**What must be expressed.** DESIGN §5.3: `disconnect: true` and
`delete: true` are lax (an empty slot is a no-op); an explicit `{ where }`
is strict (the correlated not-found refusal). The emission
(`relation-body.ts:218-240`) builds the same required lookup for both.

**Owner and rule.** The emission decides `required` from the payload form,
the one place the form is known. The consumers do NOT yet tolerate an
absent selection — the deletion passes `attempt.rows.get(located)!` to
`ctx.delete` (`execution.ts:535-541`) and the removal reads the target's
identity — so N2 states one **absent-selection consumption rule** at the
consumers: a command whose located selection bound no row emits no
statement (deletion), and a removal whose target bound no row is emitted
without a target only where the payload was lax (the set-based membership
clear the `Removal` type already allows), including the junction removal
that precedes a junction target's delete. The FK-holder side of
`disconnect: true` contributes its null literals as today and needs no
lookup; the batch presence premise is not asserted for a lax lookup
(`retained ??= required` stays undefined).

**Witnesses.** The three to-one cells in both modes; the polymorphic
"EMPTY slot writes nothing" cells; a pin on both routes that the lax forms
write nothing on an empty slot and delete the member when the slot is
occupied, and that the strict form still refuses — on the to-many edge,
since admission allows only `true`/`false` for a to-one `delete`.

## 3. N3 — attribution first, then recovery eligibility

Two problems the first revision folded into one:

**3a. Attribution.** `m8-race-retry` pins that an un-attributable planned
abort produces the typed, non-raceable `NestedWriteError` floor in exactly
one attempt — not a retry. Today an internal `NestedWriteAssertionError`
leaks. The owner is the assertion attribution
(`operation-context.ts:1243-1294`): when no failure can be attributed, the
error is translated to the floor there. No recovery is involved. (The five
legality "QueryError" cells the triage filed under attribution were not:
a probe showed a nested lookup naming the parent's post-transition key
through the batch scratch before the batch — N3c, below.)

**3 as landed (commit 23).** Two probes (`g4/release/n3/`) placed the facts:
the raceable premise WAS attributed, and the recovery was refused because a
premise placed after the parent's own write, or a batch reporting no
statement index, made the rejection "uncertain". So (3a) the floor is
translated at the ladder; (3b) attribution comes first, and where the
provider reports no index the re-probe's answer is a sentence: the claim
"nothing but premises ahead of the rejection" is bounded by the LAST premise
in the batch; and the premise about a captured member is asserted
where the observation is taken — `retained` on the deletion lookup for the
LAX form (the strict form keeps its identity sentence, D-34), per-member
presence at the series capture — never at the consuming deletion or removal
(a premise after the parent's UPDATE forfeits the recovery on a weak batch).
The deletion command asserts nothing; N2's disclosed exposure closes with it.
The update-member premise stays the non-raceable not-found at the record
(unchanged; D-32's application to update members is its own decision).

**3c — withdrawn into N1.** The five legality "QueryError" cells were
never attribution: the nested child's lookup, placed AFTER the parent's write
(`relation-body.ts:870-871`), is dispatched on the batch route as a planning
read before the batch, naming the parent's post-transition key through a
scratch reference no read can carry there (42P01). A value swap at the
emission (the located key for child-held edges) closed those five cells and
was BLOCKED by its Opus review: on the live route the same read runs after
the write, where the provider's cascade has already moved the child's key,
so the post-write assignments are the valid value and the swap refused a
shape HEAD executes (`g4/release/n3c/`). The rule the reviewer stated is
N1's case 3 verbatim: the membership names the parent's key as it is at the
lookup's own execution point; the batch route must dispatch that read where
its value is valid — behind a `submit` barrier after the queued write, or
through the reference scratch. N1 inherits the five legality cells and the
cascade cell as witnesses and the two pins under `g4/release/n3c/pins/`.

**Instrument rule, from here on:** every unit's estate comparison lists
failing cell identities and messages, not per-file counts; a pin is red at
HEAD for the reason the unit names.

## 4. N4 — the refusal census

The 63 "unmatched" entries are 59 on disk, four of them comment fragments:
**55 sentences**, mapped one by one (`g4/release/plan/refusals-map.md`).

| kind | count | disposition |
|---|---|---|
| Internal invariants | 21 | 20 stop being refusals: first strengthen the representation so the state cannot exist; where the type cannot say it, a narrow assertion of the invariant established upstream (ELEGANCE §5). One (`atomic-array execution is not implemented`) guards a binding variant nothing constructs: deleted. |
| Dead specimen (`program/`) | 3 | deleted with the specimen (N1) |
| Integrity facts (a captured set changed under its locked mutation, a member added after the plan-time read, a provider row the codec was not told about, a produced record the INSERT did not return) | 20 | kept: each names one execution fact at its trust boundary |
| Capability boundaries | 8 | three executed through N1's ordered observation, one through the scratch's cast, four kept (below) |
| Not implemented (a variant carrier's membership, a physical field, a non-junction `set`) | 3 | reachability through the schema builder is established first; a reachable shape is implemented at its owner. It is never refused at the schema to move a sentence. |

**The capability boundaries executed.**

- `Cannot publish the updated value of 'X.f' inside an atomic batch`
  (a computed non-integer value) and `Cannot name the updated value under
  multiply / divide` (the provider owns the rounding): the dependent that
  needs the value takes an ordered observation of the row after the write
  (N1 case 3). The scratch keeps carrying the integer keys it carries today.
- `Driver cannot atomically capture selected updateMany / deleteMany rows`
  (a relation-bearing selected bulk mutation on a batch-only driver). The
  JavaScript row-count check after the mutation (`operation-context.ts:2043-2050`)
  is a detection, not a guard, and does not replace a protected capture: a
  row can change membership or values without changing the count, and a
  mismatch found after a committed segment is found too late. The execution
  is therefore: the capture is a segment of its own, and the mutation's
  segment carries, as statements inside its batch, the premises the
  observation requires — the captured identities still present and still
  members of the parent (`requirePresent` with the membership selector,
  `requireNoAddedMember` for the set) — so the batch aborts before the write
  when the observation went stale. The row-count check stays as the
  detection it is.
- `G1 atomic output requires exact identity scratch or segmented RETURNING`
  after D-50 fires for a produced field that is not one increment key. On
  PostgreSQL the CTE store carries any RETURNING column once the scratch
  reads a value back at the column's declared type (the D-50 width rule
  extended from `integer` / `bigint` to the declared type, one cast owner);
  on MySQL, which returns nothing, it stays.

**Kept, as provider limits:** GeoPoint distance on an adapter without the
tier; `createMany({ select })` and the interactive `create` on a provider
with no RETURNING whose generated key is not one increment field (MySQL);
the cache result codec for a verb the cache cannot carry.

**The transport fact.** The D-50 scratch table lives on a pinned session;
the driver already declares session pinning as a capability
(`driver.ts:194-226`, `pinnedSession`). Neon HTTP dispatches each batch as
its own non-interactive transaction and pins nothing, so a scratch reference
cannot cross a segment there. The engine states that once: a unit that
would carry a scratch reference into a later segment is refused on a driver
without a pinned session (the existing sentence, at its existing site), and
Neon HTTP gains a transport-boundary witness — a batch-only driver that
pins no session and discards temporaries between batches — under D-53. Until
that witness runs, Neon HTTP is unqualified for cross-segment scratch; a
one-segment nested write (D-50's first pin) is within what PGlite proves.

**D-53 as landed (commit 28, branch `d53` from `32aa01d8a`).** The witnesses
are built and the qualification table for all eleven drivers is stated once, in
`raptor3-evidence/g4/release/d53/note.md` §2; the private guide states the rule
beside the N1–N5 paragraphs and points at it. Session lifetime bites exactly
the two drivers a nested write SEGMENTS on — the standalone physical batch
route a driver takes when it declares no interactive transaction (`usesBatch`'s
standalone arm; the array route's `batch-preparation` arm never dispatches,
`submit` refuses it), so Neon HTTP and D1 — and on no other: every remaining
driver runs the same write inside one interactive transaction. The
transport-boundary witness this section asked for exists as
`SessionlessBatchOnlyDriver` (batch-only, atomic, pins no session, discards its
temporaries between batches) beside the session-keeping `BatchOnlyDriver`, with
six credential-free cells, two live-PGlite cells for the seam's
`statementIndex`, and three cells gated on `NEON_TEST_DATABASE_URL`, unset in
the authoring environment and therefore skipped and UNVERIFIED. No capability
flag moved.

Two corrections to this paragraph, both measured. First, **the engine does not
state the consequence** and there is no "existing sentence, at its existing
site": `pinnedSession` / `_canPinSession` has no reader anywhere under
`src/query-engine/`, and the sentence this paragraph remembers is the retired
engine's `insertId-scratch` refusal, which the candidate deleted on purpose
(`raptor3/AGENTS.md`: "Do not re-introduce that refusal in the route"). What a
cross-segment scratch does today is the bare provider failure after a committed
segment — and, in the shape where only the scratch CLEANUP falls outside the
session, every write commits and the operation still reports failure. Second,
**stating it is not free**: the smallest statement (in `OperationContext.submit`,
the one owner that sees both the attempt's scratch and the driver's session)
needs a NEW PUBLIC sentence — the shipped corpus at `0cc61e61f` carries none for
this fact, so the census would go 23 → 24 — and, keyed on `_canPinSession()`,
it turns eight registered cells red — six of them on a fixture whose single
connection genuinely keeps the scratch, because that hook's absence conflates "no session"
with "a session this hook does not reserve" (`driver.ts:194-200` says so). Both
are a ruling for Arnaud in the note's §5, with the alternative that needs no
new sentence — each dispatch carrying its own scratch setup, leaving only a
value stored in one segment and read in a later one, which the engine already
derives at `readsBatchReference` — stated beside it. Until one of them lands,
this section's verdict stands unchanged: Neon HTTP and D1 are unqualified for a
cross-segment scratch, and a one-segment nested write (D-50's first pin) is
within what PGlite proves — now measured on the sessionless transport itself.

**D-58 as landed (commit 30, branch `d58` from `33f4478b6`).** Arnaud took the
alternative: EXECUTE by carrying the VALUE. The verdict above is therefore
SUPERSEDED for the engine — nothing carries a scratch reference across a
segment any more. The D-50 table is a session-scoped temporary, so it belongs
to the DISPATCHED UNIT: `ensureScratch` mints one per unit, `submit` reads back
every value that unit stored (one SELECT through `referenceProjection`, inside
the same batch, at its end) and drops the table there, and the next unit binds
the literal — `TransportAttempt.carried` beside the scratch id,
`CommandAttempt.read` the one reader, `Queries.fieldValue` binding it exactly
as a spelled key. The one eager capture that outlived the value, a membership
continuation's query, is now STATED when its guard is built. The operation's
terminal statements are the one unit with no next, so they read nothing back
and a one-segment nested write costs what it always cost; a unit that crosses a
boundary costs one SELECT more, measured per cell on `BatchOnlyDriver` with the
dispatched-unit count unchanged. There is NO transport branch and NO new
sentence: `_canPinSession()` gains no engine reader and the census stays at 23
public sentences at 30 sites (only the rethrow column moves, 55 → 56). D-53's cells 1–2 are re-expressed to the executed
end state on `SessionlessBatchOnlyDriver` and a three-segment cell is added;
the gated `neon-http-transport.test.ts` stays the PROVIDER's live witness and
still skips. The drivers themselves — Neon HTTP and D1 — remain UNVERIFIED
live: the shape is qualified on the Neon-shaped fixture. Unit note:
`raptor3-evidence/g4/release/d58/note.md`.

**The recursive read.** Eleven of the 55 guard `Queries.recursive`, the
private recursive-read fit (`AGENTS.md:636-640`): built, tested, wired to
no public verb. They are internal until a public argument reaches them.
**D-54 for Arnaud:** wire the fit as a feature (with its admission) or keep
it private.

**Reported apart.** Supported behaviour increased: the two dependency
sentences and the four capability boundaries executed. Dead or internal
diagnostics reclassified: 21 invariants, 4 dead sentences, 11 private ones.
Integrity and provider boundaries remaining: the 20 facts, the four limits,
the transport fact. The census tool (`refusals2.mjs`) gains the distinction
it lacks — an invariant assertion is not a refusal, and a sentence no
admitted payload reaches is not a public one — so the three outcomes stay
apart in the next census.

**4 as landed (commit 26, branch `n4`).** The census tool
(`scripts/raptor3-refusal-census.mjs`) tells the three outcomes apart by
construction, never by message text: an invariant throws through
`shared/invariant.ts` (`EngineInvariantError`, deliberately not a
`VibORMError`; `assertInvariant(condition, message)`, `unreachable(value:
never, message)`), an internal sentence lies inside a declared private fit
whose privacy every run re-checks against the tree (D-54's recursive read,
eleven sentences), a refusal is everything else — registered when the shipped
corpus, pinned at `0cc61e61f`, spells it, public when it does not. The first
census's 63 / 59 / 55 reconciled: eight doc-comment fragments of a line-regex
extractor, which a parser cannot produce. Public refusals 47 → 23
distinct sentences (the base's 46 had one hidden in a method); invariants
0 → 21. Closed by the type where the
type could say it: `admittedOperation`'s switch over the client's
`Operations` (`unreachable`, the `resolve` fallback deleted), the relation
body's switch over `RelationVerb` derived from its own two order arrays,
`Aggregate` derived from `AGGREGATES` at the one payload-keyed site, the
delete series' `origin` required. Asserted where the type could not without
a second enumeration of an admitted vocabulary (the filter, JSON and relation
quantifier operators, the cache codec's scalar-less leaf, the occurrence-tree
facts of `commands.ts`, the storage resolver's two sentences — unreachable
through the schema builder, established three ways). Deleted with their dead
owners: the `atomic-array` binding variant and `OperationContext.clear`
(#32 was not unreachable but implemented — at `remove`'s junction arm;
`clear` was its orphaned twin). #48's one admitted reach — a scalar named
like a combinator, which validation lets win the key — closed at the engine's
combinator read (`Queries.combinator`), pinned. Executed: #23, the batch publication of a
non-int updated value is an ordered observation at the row's post-update
identity through `flush`, the provider computing the row the shipped engine
computed in JavaScript; #25, the capture is a segment of its own and the
mutation's batch carries its premises — every captured identity present and
still a member, no row joined an unlimited capture — and answers its row count
by its own position, the cardinality sentence kept as the detection. Measured
and NOT executed: #16 — the ruling's shape, a produced field that is not one
increment key, is unreachable (a referenced non-key field is refused by the
parent-id resolver first); the reachable shape is a composite generated key,
which needs a multi-column store across the adapter seam, so it is a corrected
ruling for Arnaud, pinned as the boundary it is. #13 refined: reachable only as
a decimal PRIMARY key on a relation-free upsert found arm without RETURNING,
where what is needed is the row's ADDRESS after the key moved — no observation
supplies it; the execution is D-50's scratch at the declared type at
`updatedIdentity`'s owner, and the sentence stays a transport boundary until
then. Nothing was refused at the schema. Note, five group notes, receipts and
the census under `g4/release/n4/`.

**Rulings after N4 (Arnaud, 2026-09-21).** D-55: #16 is KEPT as a documented
transport limit (a composite primary key of several database-generated columns
on a PostgreSQL batch-only transport; the multi-column scratch is not built).
D-56: #13 is KEPT as a documented MySQL rule (a decimal primary key moves by
`set` or `increment`; `multiply` / `divide` on a provider without RETURNING
stays refused). D-57: #26 and #33 are EXECUTED by one mechanism — the
database-generated key a MySQL provider cannot return is OBSERVED before the
insert (`SELECT UUID()` and its kin, an N1-style observation) and inserted as
a literal — as one unit ("M1") after the D-53 transport witnesses and before
the perf lane, pinned on the MySQL Docker lane; both sentences leave the
census. The public refusals then read 21.
D-58 (Arnaud, 2026-09-21): the cross-segment scratch on a sessionless
batch-only transport that D-53 measured is EXECUTED by carrying the VALUE, not a
reference — each dispatched unit its own scratch, a value produced in one
segment read back at the boundary and bound as a literal in the next; no new
sentence; a unit after M1, before the perf lane.
D-59 (Arnaud, 2026-09-21): after M1's measurement — no database-side
default exists in this ORM, so #26 / #33 are reachable only by two `increment`
columns on a provider without RETURNING, which MySQL refuses at DDL — both
sentences are KEPT and the refusals-map's reachable column corrected (the
review then measured that the declaration alone reaches them on mysql2 against
a table the ORM did not create; the disposition stands); the census stays 23
and D-57's 21 is withdrawn.

**M1 as landed (commit 29, branch `m1` from `fd406f2ed`; ruling D-59: keep
both, the map corrected).** D-57's mechanism has nothing
to observe, and the unit says so with the measurement the brief asked for. The
correction is to the ruling's PREMISE: **this ORM has no spelling for a
database-side default.** A declared default is `DefaultValue<T> = T | (() => T)`;
every generator except `increment` installs a JavaScript closure
(`generatorDefault` — `uuid`, `ulid`, `nanoid`, `cuid`, `now`, `updatedAt`, and
`s.string().id()`'s own ULID), `.nullable()` installs `null`, `.default(v)`
installs `v`, and a scalar that is neither defaulted nor optional must be
supplied (`mustBeSuppliedOnCreate`), so a scalar absent from an ADMITTED create
payload is an `increment` column and nothing else — measured on every create
route, and falsified by removing `.id()`'s closure, after which three cells
answer with the two sentences under study. The DDL defaults the migration
drivers write (`gen_random_uuid()`, `NOW()`, `CURRENT_TIMESTAMP`; MySQL
deliberately declines `UUID()`) are never the value a row receives. With N4's
row-16 measurement, #26 and #33 therefore reduce to ONE shape — more than one
`increment` column among the fields the operation must know, which is #16's
shape (D-55) — and no schema this ORM can push to a shipped non-RETURNING
provider holds that shape: MySQL is the only `supportsReturning: false` adapter
and refuses a second AUTO_INCREMENT column with errno 1075 / SQLSTATE 42000
(measured, MySQL 8.4.11); the guard reads the declaration before any statement,
so a schema declaring two `.increment()` columns still reaches both sentences on
mysql2 against a table the ORM did not create (the review's measurement).
An AUTO_INCREMENT is precisely the brief's own exception, a default that cannot
be observed apart from its insert: `SELECT UUID()` is an ordinary observation,
but the catalog's next auto-increment is a statistic, not a reservation (two
reads, same number). So **both shapes keep their sentence, no engine change,
census unchanged at 23 public** — not the 21 this section predicted. Pinned
instead, as the boundary it is: seven credential-free cells in
`g4/parity/generated-key-reach.test.ts` (in `G4_PARITY_COUNTS`; the family
135 / 135) and five gated cells in
`tests/providers/docker/mysql2-generated-key.test.ts` on the live lane, which
owns four `m1gk_*` tables and drops only those; the lane is identical before and
after by cell identity (161 non-passing both sides, NEW [], HEALED []). The
disposition is a ruling, `g4/release/m1/note.md` §6: KEEP both with the map's
*reachable* column corrected to "no schema this ORM can push holds the shape;
the declaration alone reaches it on mysql2"; or tell them apart by
construction as invariants, the only route to 21, whose objection is that half
of what forecloses the state is a PROVIDER fact and not an owner in this tree;
or add the public spelling the ruling assumes, which is a public-contract
change and would make the observation mechanism real.

## 5. N5 — the rest of the gate

- **A (26):** the retired root alias `t0` → `q0` (protocol §7.2) in
  `progressive-parent-rowkey` and `starts-with-prefix-plan`; the retired CTE
  fold's statement-count pins in `mutation-projection-cte-fold` (D-15). Each
  re-expressed with its ruling named.
- **B ruled (16):** re-expressed to the registered refusal (G3P-04, D-46,
  D-50's boundary) or green already.
- **C, the remaining mechanisms:** the batch route's typed errors lost to
  `QueryError` (the attribution owner of N3a, six cells); the shared
  primary-key root transition addressing the pre-transition key (six cells,
  one owner: the transition's published key); `adoptSuppressed` conflating
  "own key spelled" with "row exists" (three cells); the M7 disjoint
  two-upsert guard; the skipDuplicates adopt shape; the SQLite
  nested-connect "known" value; the parent-row-changed guard for one schema
  shape; `updateMany` no longer refusing a child-held connect across two
  matched rows. Each a unit at its owner; N1 removes the false positives
  that hid some of them.
- **D (11):** the retired internals' names and wordings; the CS-02 measure's
  manifest ownership (one list owns "runner-only"); the retired
  instrumentation attribute.


**5 as landed (commit 27, branch `n5`).** The 99 red gate cells after N1
closed in three waves, each cell derived before it was measured. Wave 1
(tests only, by triage family): 54 re-expressed with the ruling named — the
retired CTE fold's statement counts to the scalar RETURNING fold that shipped
(D-15), the `t0` alias to `q0` (§7.2), the borrowed `skipDuplicates` member on
the atomic-batch leg to G3P-04, the array route's unbatchable write to D-46,
the retired polymorphic `set` sentence to D-50 / D-52, the own-write veto's
sentences to the executed end state (D-51), the retired internals' names —
and 45 class-C cells left red with their mechanism and owner
named. Wave 2a (four owners, disjoint files) and 2b (the shared-primary-key
transition, one owner across `commands/`) and 2c (the facts that span
`execution.ts`, `operation-context.ts`, `query.ts`) repaired fourteen
mechanisms at one owner each, every one with a pin red at the base, and no
contract file edited for a class-C cell: the member boundary and the packaging
rule (`holdsWrite`), the singular slot vacated once, the ladder's skip as the
fact (`readsBatchReference`), the located adoption of a suppressed member, the
exclusive-member cardinality refusal (V1's registered sentences restated), the
held key of a correlated arm and the placement rule for its lookup, the
supplied referenced field (`writesField`), the located value read where it is
spent (`locatedValue` / `folded`) and the located-NULL refusal, the created
member's parent re-pinned in every later segment, the temporal identity
through the admission boundary, and the transport corpus's script re-derived
from the rule. The census holds at 23 public (72 registered, the two re-added
sentences among them); Arnaud's D-55 to D-57 decide the four capabilities.
Note, briefs, the groups' reports, receipts and the census under
`g4/release/n5/`.
## 6. Sequencing and the gate

The maps behind this plan: `g4/release/plan/dependency-map.md`,
`refusals-map.md`, and the external review `review-external.md`.

N2 first (small, its consumption rule pinned). N3a next (attribution, no
recovery change), then N3b once its investigation names the wrong owner.
N1 in a worktree, contract before code: the three cases and the
observation-validity rule written in the guide and pinned on a recording
driver before the conformance suites are run against it, through the
shared-family stage's ceiling (`run-credential-free-tests.mjs`; the
launcher narrows it to one file). N4's executed boundaries follow N1
(they are its cases); the invariant reclassification and the census tool
are pins-only units that can run in parallel; the transport witness for
Neon HTTP before any cross-segment behaviour is called supported there.
N5 in parallel as pins-only units. Exit: `pnpm test:all` green end to end
on the head, the raptor3 fixed stage, the fixed modes, the Docker `pg` and
`mysql` lanes with no regressions against the recorded red sets, the
coverage floors held, the three census outcomes reported apart, then the
size and performance re-measure on a quiet machine.
