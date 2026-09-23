# Closure-final — the integrated rounds

This directory records the rounds that act on the INTEGRATED tree (branch
`closure-r`), after the six units R1, R3, R2a, R2b, R2c and R4 landed. Each
round has its own dated section below; the unit notes beside this one are not
reopened.

## Integrated repair round (2026-09-21)

Six findings from the integrated adversarial review, applied exactly as
requested. One is an engine repair with a native witness; five are documents
made to agree with the tree.

### 1. The third arm the withdrawn probe lock reaches (major)

**The failing witness.** `owner.update({ where: { id: "o1" }, data: { name:
"Renamed", profile: { upsert: { create: …, update: { bio: "Updated" } } } } })`
on a CHILD-HELD to-one edge, with the found profile DELETED and committed
between the unlocked plan-time probe and the found arm's UPDATE. Measured on
the lane's MySQL 8.4 at the base copy of `relation-body.ts`: the operation
**RESOLVED**, returning `{ id: "o1", name: "Renamed" }`, while the profile it
was told to update was gone and nothing had been written — silent success, the
same class the postwave round closed for the child-held `connectOrCreate`.

**Why no existing reader caught it.** Three facts had to hold at once, and
they did. The arm carries a `create`, so
`RelationBody` sets `Selection.insertsWhenAbsent` and the probe reads
UNLOCKED. It carries no `where`, so `foundMembership` (and therefore
`foundRequirement`) is never built and the locking
`Selection.inspectMembership` read the guide leaned on is never issued. And
its found arm is `Commands.update(lookup, …)` whose `fields.demands` nothing
populates, so `OperationContext.update` takes the `effect()` path and never
asks which row its UPDATE wrote. The postwave guard is gated on
`!conditionalParentBinding.target.found`, so it never reaches an arm that
already HAS a found command.

**The fact and its owner.** The fact is the one the postwave round already
states: *an arm whose probe did NOT lock its answer demands the target's own
keys*. Its owner is unchanged — `RelationBody.association`, the one place a
child-held binding arm is finished. The repair applies that same rule to the
found command that already exists instead of only to the one the binding
builds:

```ts
if (
  target.kind === "choose" &&
  target.found &&
  target.lookup.insertsWhenAbsent &&
  target.foundRequirement === undefined
)
  target.found.command.fields.select(
    this.commands.context.schema.keys(target.model)
  );
```

**The second consumer.** `OperationContext.update`'s CURRENT stored-row read —
the non-RETURNING `SELECT … FOR UPDATE` of the row this UPDATE just wrote,
already built and already raising `UPDATE did not produce the required record`
for the root `upsert` and for the child-held `connectOrCreate`. No lock is
restored, no statement owner is introduced and no new error class is added.
The `foundRequirement === undefined` clause is what keeps the CORRELATED
to-many arm — the one that carries its own `where` and therefore issues the
locking membership confirmation — on the reader it already has.

**Actual deletion:** none. This shares an existing rule with a third arm; it
replaces no narrower rule.

**Witness registered.** `tests/providers/docker/mysql2-concurrency-policy.test.ts`
section 4 gains its third row, beside the root `upsert` and the child-held
`connectOrCreate`: *"a nested to-ONE upsert whose found target is deleted
before the update arm loses nothing silently"*. It asserts the schedule really
ran (`deleted`, exactly one UPDATE of the profiles table), that the probe still
carries **no `FOR UPDATE`** — the fact the cell is the price of — that the
operation fails with `UPDATE did not produce the required record` and with
neither a `UniqueConstraintError` nor a `DEADLOCK` `TransactionError` among its
composed failures, and that nothing committed under either id: the profile
stays deleted, no INSERT was sent (the create arm was not adopted as a recovery
from a row that vanished), and the parent's own rename in the same operation is
rolled back with it. The file's schema gains the to-ONE inverse pair it needs
(`r2c_policy_owners` / `r2c_policy_profiles`); the other ten cells are
untouched.

**Red before / green after.** With the base copy of `relation-body.ts` restored
over the path, 10 passed / **1 failed** — `expected { id: 'o1', name:
'Renamed' } to be undefined`, which is the silent success itself. With the
repair, **11 / 11**. The backup was restored by `cp`; the worktree diff for
the file is unchanged afterwards.

**Registration.** `mysql2-concurrency-policy.test.ts` **10 → 11 cells**. It is
a docker suite and is not registered in `scripts/raptor3-manifest.mjs` (no
docker provider file is), so no manifest line changed.

### 2. The guide's enumeration of readers (minor)

`src/query-engine/raptor3/AGENTS.md` asserted that "A nested `upsert`'s found
membership confirmation (`Selection.inspectMembership`) keeps `forUpdate`" —
a protection a to-ONE `upsert` does not have, because that confirmation is
built only for `verb === "upsert" && conditional.where !== undefined`. The
sentence is narrowed to the arm it is true of (a CORRELATED `upsert` carrying
its own `where`, the to-many arm, through `foundRequirement`), and the to-ONE
arm is named as the one the demanded target keys answer. A second dated
addendum beside the postwave one records the rule's reach over that third arm
and names its witness.

### 3. The D-65 addendum's cell count (minor)

`AGENTS.md` still read "(16 cells on native PostgreSQL" for
`pg-captured-set-concurrency.test.ts`; the postwave round added the 17th and
updated only the ledger. The file declares 17 `test(` cells. Changed to 17.

### 4. D-66 resolved to two contracts (minor)

`g4.md` carried two adopted §1 decisions under D-66: R2a's "MySQL" row
(`:3079`) and R2c's "MySQL deadlocks" row (`:3225`). Both records anticipated
the collision and left the renumbering to the integrator. The deadlock
adoption is now **D-67**; its provisional-number sentence is settled with the
reason; the R2C ledger record names D-67 explicitly (it named no number
before) and `closure-final/r2c/note.md` records that its provisional D-66 was
settled to D-67. R2a's and R2b's references to D-66 are unchanged, and no
sealed receipt was edited.

### 5–6. The two `[closure-final]` markers (minor)

R1, R2 and R3 have all landed on `closure-r`, so both documents stated the
tree's shipped behaviour in the future tense behind a "pending the units'
landing" flag. `CHANGELOG.md` loses the block quote and the three
`**[closure-final]**` prefixes, leaving three ordinary Unreleased entries;
`docs/content/docs/drivers/index.mdx` loses the `:::info` admonition over
"Captured-set mutations, per route" and the prefix on "MySQL, locally
qualified", leaving both sections as stated guarantees. No sentence of either
contract changed.

### Retained cost

Engine perimeter (`node scripts/query-engine-structure.mjs`, this round's
before = the tree as the postwave round left it):

| | files | physical lines | token-bearing lines | functions | branch nodes |
| --- | --- | --- | --- | --- | --- |
| before | 38 | 20,679 | **16,089** | 1,096 | 2,571 |
| after | 38 | 20,700 | **16,098** | 1,096 | 2,575 |

**+9 token-bearing lines** (the four-clause condition, the `select` call and
its two wrapped arguments), +21 physical (the remainder is the docblock that
says why), functions unchanged, +4 branch nodes (the condition's own clauses).
No deletion.

Non-engine files, this round only (`diff` against the backup copies taken
before editing, added/removed):

| file | +/- |
| --- | --- |
| `tests/providers/docker/mysql2-concurrency-policy.test.ts` | +118 / -7 |
| `src/query-engine/raptor3/AGENTS.md` | +34 / -15 (the narrowed paragraph rewraps) |
| `docs/architecture/raptor3-evidence/g4.md` | +13 / -6 |
| `CHANGELOG.md` | +6 / -9 |
| `docs/content/docs/drivers/index.mdx` | +4 / -10 |
| `.../closure-final/r2c/note.md` | +5 / -2 |

### Runs

One vitest at a time, one docker file per invocation, from
`/private/tmp/viborm-rint` with `TMPDIR=/private/tmp/viborm-rint-tmp`.

| file | result |
| --- | --- |
| `tests/providers/docker/mysql2-concurrency-policy.test.ts` (native MySQL 8.4) | **11 passed / 11** |
| the same file, base copy of `relation-body.ts` restored (falsification) | **1 failed / 10 passed** — the new cell, on the silent success |
| `tests/contracts/engine/query/nested-write-conformance-to-one.test.ts` | 19 passed / 19 |
| `tests/contracts/engine/write/child-held-to-one-multi-kind.test.ts` | 7 passed / 7 |
| `tests/contracts/engine/write/junction-upsert-arm-probe.test.ts` | 10 passed / 10 |
| `tests/providers/local/pglite-nested-writes.test.ts` | 126 passed / 126 |
| `docs/` blume validator | 11 warnings, identical to R4's receipt |

`junction-upsert-arm-probe` and `pglite-nested-writes` exceeded
`run-vitest-safe.mjs`'s ordinary 1,536 MiB ceiling and were run through the
sanctioned raised-ceiling shard runner (`run-shared-family-cwd.mjs`, 2,560 MiB
— the same bounded-process library and lock); no ceiling was weakened.

**Typecheck:** `node scripts/run-typecheck.mjs` → **0 diagnostics**, exit 0.
(Run twice in fact: the first invocation printed only the resource line, the
second was repeated to capture the exit code. Same result.)

**Census:** not owed and not run — no refusal sentence and no error class was
added, removed or reworded; the repair reuses
`UPDATE did not produce the required record`, which already exists.

**Biome:** per changed file, against the backup copy taken before editing.
`relation-body.ts` is rule-for-rule identical (1 `format`, 1
`lint/correctness/noUnusedVariables`, 5 `lint/style/noParameterProperties`),
and its single pre-existing `format` diagnostic is the SAME hunk before and
after (`requested: !premise || (…)`, 20 lines above the edit) — the added lines
are format-clean, and the file was never formatted.
`mysql2-concurrency-policy.test.ts` is clean before and after. The Markdown and
MDX files are not files this Biome configuration checks.

### Unverified / blockers

- Only the files above were re-run, per the no-wide-runs rule. Native
  PostgreSQL was not re-run: nothing in this round touches it — finding 3 is a
  cell COUNT in a guide sentence, and `pg-captured-set-concurrency.test.ts` is
  unchanged (its 17 `test(` declarations were counted statically, and the
  postwave round's own receipt records 17 / 17 green).
- The finding for D-66 named "the R2C record's own text" among the references
  to update. The R2C narrative record named no D number at all before this
  round; it now names **D-67** explicitly, which is the only way that
  reference can be made true.
- The lane's assigned MySQL container publishes an EPHEMERAL host port and had
  been restarted, so the port recorded in `/private/tmp/viborm-fc-env/mysql-g3`
  was stale — the same fault R2c recorded. A corrected connection file was
  written into this unit's own TMPDIR and substituted into one command at a
  time; no connection string was printed, and no database or schema this round
  did not create was dropped (the approved fixtures' own setup/teardown did all
  of it).

**Blockers:** none.

### Commit message draft

```
fix(raptor3): the third arm whose probe let go — a nested to-one upsert demands its target's keys

The withdrawn probe lock reaches one more arm than the postwave round
counted. A nested to-ONE `upsert` carries a `create`, so its probe reads
unlocked (`Selection.insertsWhenAbsent`); it carries no `where`, so no found
membership confirmation is built and the locking `inspectMembership` read is
never issued; and its found arm's payload demands nothing back, so
`OperationContext.update` took the effect path and never asked which row its
UPDATE wrote. Measured on native MySQL 8.4: with the found profile deleted
between the probe and that UPDATE, the operation RESOLVED, returning the
renamed parent, while nothing was written.

The rule is the one already stated — an arm whose probe did NOT lock its
answer demands the target's own keys — now applied in `RelationBody.association`
to the found command that already exists, not only to the binding arm it
builds. That reuses the CURRENT stored-row read and raises `UPDATE did not
produce the required record`. No lock restored, no new statement owner, no new
error class, no deletion. The correlated to-many arm, which has its own
locking confirmation, is excluded by `foundRequirement === undefined`.

Witness: mysql2-concurrency-policy section 4 gains its third row (10 -> 11
cells, 11/11 native; 1 red at the base copy of relation-body.ts, on the silent
success itself).

The five document findings: the guide's reader enumeration narrowed to the
arm it is true of, with an addendum for the third; the D-65 addendum's cell
count corrected to 17; the deadlock adoption renumbered D-66 -> D-67 because
R2a's MySQL row had taken 66; and the [closure-final] markers struck from the
CHANGELOG and the drivers page now that R1, R2 and R3 have landed.

Engine 16,089 -> 16,098 token-bearing LOC (+9), 1096 functions unchanged.
Typecheck 0; census not owed; Biome per changed file identical to its base
copy.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
