# FC-00 — the short list for Arnaud

Everything else in the closure inventory has an owner and an action. These are
the only items that need **you**. Each one names the nearest behaviour that is
already accepted, and what each answer costs. Nothing here is a request to
reopen resolved work: **no D-16 family is awaiting you** (see
[inventory §M](inventory.md#m-d-16-reconciliation--by-current-family-status)).

Source: `pattern-engine` @ `29a7bf9d8`, Node `v24.21.0`.

---

## R-1 — The public build contract (D-14). **Blocking FC-04.**

**The question.** Should `PendingOperation.buildStatement()` and
`QueryEngine.build()` answer the one `Sql` of a write that compiles to exactly
one statement, or is building explicitly a read-only contract?

**Where it stands.** D-14 (2026-09-16, 22:25) decided *"every read, a folded
single-statement write"*. Cutover round 3 shipped only the read half, and the
CHANGELOG now documents the opposite: *"Every write now answers the `does not
compile to one SQL statement` refusal — including a write the previous engine
could fold into a single statement, such as a scalar `delete` on a driver with
`RETURNING`."* The old rationale — "all writes need asynchronous preparation" —
no longer holds: `commands/index.ts:228 prepareSingle` already prepares
eligible writes **synchronously**, reaching no driver (that is D-20, which you
accepted, and it is how `$transaction([…])` runs a write today).

**Measured this unit** (`receipts/probe-d14-build-contract.log`, in-process
SQLite with RETURNING):

| verb | `buildStatement()` | statements actually executed |
| --- | --- | --- |
| `findMany` | an `Sql` | 1 |
| `create` | `undefined` | **1** |
| `update` | `undefined` | **1** |
| `delete` | `undefined` | **1** |
| `deleteMany` (no relation) | `undefined` | **1** |

**Nearest accepted neighbour.** D-20: the same one-statement package is already
published to the array owner, and its `Sql` and its parser come from that one
preparation. Nothing would be prepared twice.

**Option A — restore the eligible single-statement write contract.**
*Code*: `route/client-route.ts:193` answers the single package's one query when
`prepared.read` is absent and `prepareSingle` publishes exactly one — the same
`Sql`, no second lowering, no driver reached, no change to the synchronous API.
*Tests*: pin representative single-statement `create` / `update` / `delete` /
set-bulk writes, a read control, and a genuinely multi-statement refusal,
through the public methods; cover the extension and preparation lifecycle.
*Docs*: the CHANGELOG paragraph above is rewritten; the engine guide and
`src/query-engine/README.md:92` gain the eligibility rule.
*Cost*: `build()` must not execute anything, so the probe-and-discard shape of
`prepareSingle`'s write arm (`plan.run().catch(() => undefined)`) has to be
inspected — this is the one real risk in Option A and FC-04 owes it a witness.

**Option B — declare building read-only.**
*Code*: none. *Tests*: pin the refusal per write verb as an accepted limit.
*Docs*: D-14 is superseded by a dated ruling; the inventory moves L-1 from
class 5 to class 4; the CHANGELOG paragraph stands.
*Cost*: a capability the previous engine had stays lost, and it stays lost for
the one shape users most often build — a keyed `delete` or `update`.

**Recommendation on the table (the handoff's, not a decision):** Option A.
**Not chosen here.** FC-04 will implement whichever you name; if you leave it
open, the work continues around it and the item is reported as pending.

---

## R-2 — The private recursive-read fit (D-54): wire it, or keep it private?

Answered 2026-09-21: public `recurse`; see the inventory addendum.

**The question.** `Queries.recursive`, `decodeRecursive` and the route's
recursive cache codec are fully built and unit-tested. No public verb, argument
or schema option reaches them — privacy re-verified by the census at this HEAD.
Do you want a public recursive read?

**Nearest accepted neighbour.** Nested to-many reads with their own pagination
window: the same projection, correlation and decode owners, at a fixed depth.

**Cost of "wire it".** A **new public language** — a verb or argument, its
validation schema, its result types, its cache shape and its documentation.
The eleven internal sentences become real admission facts. This is a program,
not an FC-04 refusal removal, and it is not in the closure plan's scope.

**Cost of "keep private".** Roughly 400 lines of built, tested, unreachable
engine stay in the perimeter and in every LOC and bundle count. The honest
alternative is deletion, which costs the work if you later want the feature.

**Default if unanswered.** Keep private, unchanged, as D-54 already says.
FC-06 states it as a declared private fit, not as a capability.

---

## R-3 — A database-side default spelling (recorded, already declined once)

**The question.** Every key generator the schema offers is a JavaScript closure
evaluated at admission; there is no way to declare a server-side default. This
is *why* the two MySQL sentences you kept under D-59 are unreachable in any
schema this ORM can push.

**Nearest accepted neighbour.** `.increment()`, the one generator the database
evaluates.

**Cost of "add it".** A public schema-vocabulary change plus adapter DDL work —
a separate program. **Cost of "no".** Nothing changes; D-59 stands and J-3/J-4
remain accepted limits.

**You declined this once (D-59).** It is listed only so the closure inventory
does not silently re-derive it. **Default: unchanged.**

---

## R-4 — Conditional: a stronger consumption-time membership guarantee

**Not a question yet.** FC-03 must first execute a local native PostgreSQL
lock schedule against the captured-set premises (inventory row F-8) and take
the correct expected result from the operation contract. If — and only if —
that witness shows the current premises do not establish membership at the
moment the mutation runs, FC-03 will bring you **one bounded question**: a
stronger public guarantee, or a new recovery authority.

It will not arrive as a blanket `FOR UPDATE`, global serializable isolation or
a post-commit count check; those were ruled out in advance.

**Nearest accepted neighbour.** The interactive path, where `FOR UPDATE` holds
the capture until its mutation and the guarantee is real today.

---

## R-5 — Confirm one authority limit is the rule, not a gap

**The question.** `Raptor 3 borrowed createMany skipDuplicates requires an
operation-owned member rollback region.` (inventory row D-9) is classified here
as an **accepted** limit under your standing rule that borrowing grants no
lifecycle or recovery authority — but unlike D-55/D-56/D-59 it has no ruling of
its own.

**Nearest accepted neighbour.** Standalone `createMany skipDuplicates`, which
works because the operation owns its region.

**Cost of "confirm".** Nothing; it becomes a named limit and FC-04 stops
looking at it. **Cost of "no, execute it".** An implicit savepoint inside a
borrowed transaction — exactly what the design contract forbids — so this is a
contract change, not a repair.

**Default if unanswered:** confirmed as an authority limit; FC-04 records it as
such and does not implement it.

---

## Not on this list, deliberately

- **The three executed failures** (E-1, E-2, E-3) and the two residuals (F-4,
  F-6) are defects with owners (FC-01, FC-02A, FC-03, FC-02B, FC-02C). They are
  work, not decisions.
- **Hosted Neon and D1** are deferred by you already and are not a gate.
- **The pg `batchPrimaryKeyDataflowContract` registration** kept red at the
  cutover: FC-06 measures it once on the frozen tree. If D-58 made it green, the
  "kept red" record is retired with a dated line — no decision needed.
- **D-55, D-56, D-59** stay binding. Nothing in this inventory erases them to
  make a count look better.
