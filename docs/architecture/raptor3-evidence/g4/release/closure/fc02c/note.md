# FC-02C — a found target must represent the requested relation

The handoff's FC-02 C, closed at one owner. N5 had recorded, unmeasured, that a
found `connectOrCreate` whose referenced column reads NULL writes that NULL and
DISCONNECTS the holder; this unit executed it, located the shared requirement
the retired engine already stated, moved it out of the one arm Raptor 3 had
narrowed it to, and deleted the verb gate and the per-verb wording that
narrowing had introduced.

Branch `fc-02c` from `7c3c33a4e`, worktree `/private/tmp/viborm-fc02c`.
Nothing committed, staged, checked out or pushed; no existing file formatted.

## The witness

Schema: `badge { id, slug @unique, code String? @unique, note String? }` and
`holder { id, name, badgeCode String?, badge -> badge.fields(badgeCode).references(code) }`
— a parent-held edge onto a NULLABLE unique the payload does not address.
Seed: `b1 { slug: "codeless", code: null }`, `b2 { slug: "gold", code: "GOLD" }`,
`h1 { name: "one", badgeCode: "GOLD" }` — so `h1` IS a member of `b2`.

```ts
await client.holder.update({
  where: { id: "h1" },
  data: {
    name: "renamed",
    badge: {
      connectOrCreate: {
        where: { slug: "codeless" },
        create: { id: "b9", slug: "codeless", code: "NEW", note: null },
      },
    },
  },
});
```

**At the base (`7c3c33a4e`):** resolves. `h1` becomes
`{ name: "renamed", badgeCode: null }` — the payload asked to CONNECT and the
operation disconnected the holder from `b2`, silently, with the sibling scalar
written beside it. Receipt:
`receipts/base-red-reference-representability.log` (4 cells red, 8 controls
green, exit 1).

**After:** `NestedWriteError: Cannot connect relation 'badge': the located
target's referenced field 'code' is null.`, `h1` unchanged
(`{ name: "one", badgeCode: "GOLD" }`), `b9` never created. Receipt:
`receipts/after-green-reference-representability.log` (12 / 12, exit 0).

The same witness on a COMPOUND edge — `pass { zone, serial String? } @@unique([zone, serial])`,
addressed by `id`, one member of the referenced pair NULL — is red at the base
and green after, in both routes.

## The fact, and who already owned it

**The fact.** *A concrete reference that becomes a relation must be
representable.* The value a holder writes for an edge is the value the located
row holds for the referenced column; a nullable referenced unique can hold
NULL there, and writing that NULL does not connect the relation — it
disconnects the holder from whatever it pointed at, and no provider error
reports it, because NULL in a nullable foreign key is a legal absence.

**Its owner — the retired engine states it as the relation's, not a verb's.**
`write-engine/messages.ts:lookupKeyIsNull` (revision `0cc61e61f`, the census's
shipped corpus) spells one sentence with the verb FIXED at `connect`:

```
Cannot connect relation '${relationName}': the located target's referenced field '${referencedField}' is null.
```

and its docblock names both verbs ("A to-one `connect`/`connectOrCreate`
addressed its target by a unique the foreign key does NOT reference"). Its
enforcer `RecordUpdateCompiler.assertLookupKeyPresent` is called from TWO
places — `compileToOneConnect` (plain `connect`, `:5243`) and
`compileParentHeldConnectOrCreate`'s FOUND branch (`:4693`). So the requirement
was never the `connect` arm's; the inherited contract already covered the found
arm of `connectOrCreate` with this exact sentence.

**What Raptor 3 had done with it.** N5 folded the parent-held `connect`'s value
into the holder's own SET (`Queries.locatedValue`, read where it is spent) and
put the NULL check INSIDE that fold's arm gate
(`CommandExecution.folded`: `origin.operation !== "connect" ||
lookup.membershipOnly !== false` → return unchanged), and re-spelled the
sentence with `${origin.operation}` interpolated. N5's own note records the
consequence as an unrepaired residual ("a parent-held `connectOrCreate` whose
FOUND row's referenced column reads NULL writes that NULL and disconnects the
holder, the pre-N5 behaviour, with no cell"). This unit is that cell plus its
repair.

## The hunk

One file, one method: `src/query-engine/raptor3/commands/execution.ts`.
`folded` → `supplied`, with the two facts separated inside it.

- **The requirement runs first, for every demanded field, with NO verb gate**
  and no `membershipOnly` gate: every field the choice supplies out of its
  located row is asked, ahead of every write of the unit — the sibling scalars
  of the same SET included, which is what makes the atomicity claim below true
  on every route rather than only on a rolling-back one.
- **The fold stays the arm's**, behind its unchanged gate
  (`origin.operation === "connect" && lookup.membershipOnly === false`): a
  parent-held `connect`'s value is the one a consumer's own SET writes, so it
  is read inside that statement over the arm's own selector. Every other arm
  still binds what the probe read, unchanged.
- **Deleted:** the verb gate on the refusal, and the `${origin.operation}`
  interpolation in the sentence. The sentence is the inherited one, fixed at
  `connect`, because what is refused is the CONNECTION and not the verb that
  spelled it — which is also why the existing pin's exact string is unchanged
  and the census is unmoved.
- `if (!origin) return captured;` keeps today's answer for a choice with no
  relation origin (the ROOT `upsert`'s `Choose`, `commands.ts:1826`); it always
  has a found arm and never reaches this method anyway.

The call site is one line (`this.supplied(...)`), the `choose` case's
located-supply bind. Nothing else in the engine moved: no new parameter, no
policy bit, no second reader, no mode branch, no cache.

## The second consumer / second placement

The requirement is stated once and exercised at four placements the repair did
not have to name individually, because they are the same bind:

| placement | before | after |
| --- | --- | --- |
| parent-held plain `connect` | refuses (the arm's own check) | refuses, same sentence, same state (`keeps the plain connect's own sentence…`, and the 56-cell E1 bed) |
| parent-held `connectOrCreate`, FOUND arm | **writes NULL, disconnects** | refuses (**the witness**) |
| COMPOUND parent-held edge, one member of the pair NULL | **writes NULL, disconnects** | refuses, naming the unrepresentable member (`serial`) |
| junction choice (`through`) | connects | connects — its demanded fields are the endpoints' ROW KEYS, which no schema makes nullable, so the requirement asks and passes |

## Capability change

None gained, none lost. No public sentence added, removed or reworded (census
identical, below). One silent data-loss defect removed: a `connectOrCreate`
that reported success while disconnecting the holder now refuses by name.
No valid case acquires a blanket refusal — the pin's own controls prove a
nullable referenced unique is still a legal schema, a row holding NULL in one
is still legally updatable, a holder is still creatable with a NULL foreign
key, and both verbs still connect a representable target.

## Registrations owed (the manifest was NOT edited)

`scripts/raptor3-manifest.mjs`, `G4_PARITY_COUNTS`:

```
"tests/raptor3/g4/parity/reference-representability.test.ts": 12,
```

(6 cells × 2 routes.) Until the integrator adds it the file is collected by
`extended-local` only; every other `g4/parity` file also runs under `raptor3`
and `coverage-raptor3`.

## Runs

One vitest at a time, in this worktree, with `TMPDIR=/private/tmp/viborm-fc02c-tmp`.
No wide run, no fixed lane, no `g2-baseline`/`g1-compare`.

| file | result | receipt |
| --- | --- | --- |
| `tests/raptor3/g4/parity/reference-representability.test.ts` (new) | 12 / 12 | `receipts/after-green-reference-representability.log` |
| … the same file at the base engine | **4 failed / 8 passed**, exit 1 | `receipts/base-red-reference-representability.log` |
| `tests/contracts/engine/write/parent-held-lookup.test.ts` (the sentence's existing pin, E1 bed, live PGlite) | 56 / 56 | `receipts/parent-held-lookup.log` |
| `tests/raptor3/g4/parity/correlated-membership.test.ts` (N5's `commands/` pin) | 10 / 10 (both projects) | `receipts/correlated-membership.log` |
| `tests/raptor3/g4/parity/suppressed-membership-target.test.ts` (N5's `execution.ts` pin) | 14 / 14 | `receipts/suppressed-membership-target.log` |
| `tests/raptor3/g4/parity/published-key.test.ts` (the other `execution.ts` pin with nullable uniques) | 24 / 24 | `receipts/published-key.log` |
| `tests/raptor3/g4/parity/lane-x-set-mutations.test.ts` (the `set` verb also reaches this bind, through `setTargets`' armless choices) | 10 / 10 | `receipts/lane-x-set-mutations.log` |
| `tests/contracts/engine/query/nested-write-conformance-to-one.test.ts` (neighbour family, live PGlite) | 19 / 19 | `receipts/nested-write-conformance-to-one.log` |

The two live-PGlite files ran through
`scratchpad/run-shared-family-cwd.mjs` (the sanctioned raised ceiling); all
others through `node scripts/run-vitest-safe.mjs run <file>`.

### Falsification (in a backup copy, restored by `cp`)

`src/query-engine/raptor3/commands/execution.ts` was copied to
`$TMPDIR/backup/execution.ts.base` before the hunk and restored by `cp`, never
by `git checkout`. Dropping the shared check (restoring the base file) turns
the found-arm cell and the compound cell red on BOTH routes — 4 red — while the
8 control cells stay green, which is the discrimination the pin owes: the
controls do not smuggle the repair.

## Typecheck, census, Biome, LOC

- **Typecheck:** `node scripts/run-typecheck.mjs` → **0 errors**, exit 0
  (`receipts/typecheck.log`).
- **Census:** `node scripts/raptor3-refusal-census.mjs` on the working tree and
  `--at 7c3c33a4e` are **identical**: 23 public (30 sites) / 72 registered /
  21 invariant / 11 internal / 192 total sites.
  (`receipts/census-after.md`, `receipts/census-base.md`.) The sentence stays
  REGISTERED because it is now spelled exactly as the shipped corpus spells it;
  the interpolated `${origin.operation}` form it replaces matched on the same
  static fragment, so the count did not move in either direction.
- **Biome:** `commands/execution.ts` — base copy (`git show HEAD:<file>`) and
  working copy both report the same 4 diagnostics
  (`useDefaultSwitchClause`, `noParameterProperties`, `noCommaOperator`,
  `organizeImports`): unchanged. The new test file is clean, formatted with
  `node_modules/.bin/biome format --write` (a new file, as the rules allow).
  (`receipts/biome.txt`.)
- **LOC** (`node scripts/query-engine-structure.mjs`, whole query-engine
  perimeter): token-bearing lines **16,064 → 16,064 (+0)**; physical lines
  20,430 → 20,439 (+9, all docblock). The deleted gate and interpolation pay
  for the loop the requirement needs.
  (`receipts/structure-base.json`, `receipts/structure-after.json`.)

## Unverified, and the compatibility questions

Measured on the REPAIRED tree and recorded, not pinned:
`receipts/residual-probe.log` (source preserved as
`receipts/residual-probe.test.ts.txt`, outside test discovery).

**R1 — the `connectOrCreate` CREATE arm (the compatibility question).** A
create arm whose own payload spells the referenced field NULL still resolves
and still disconnects the holder: `connectOrCreate { where: { slug: "fresh" },
create: { id: "b9", slug: "fresh", code: null } }` creates `b9` and leaves
`h1.badgeCode` NULL. This is NOT the located supply — the value comes from the
arm's own INSERT — and it already has an owner: the SAME payload under a plain
nested `create` is refused by `Commands.assignMembership` ("query-engine-v2
create cannot resolve the parent id for relation 'badge': referenced field
'code' is neither this record's primary key nor a knowable value in its own
create data.", measured as R1's control). The rule misses the choice because
its `producer` is the CHOICE's `Assignments` (`operation: "select"`), which
merely FORWARDS demands to the create arm, so `producer.operation === "create"`
is false and the create's own payload is never read. Repairing it means
rejecting on the ARM rather than on the holder — `missing.fields.reject(...)`,
so an untaken create arm refuses nothing — and the arm's `Assignments` is
`deferred` only when its parent's is (`relation-body.ts:553`), so making that
rejection arm-conditional is a change to how the create arm is constructed, not
a line inside this unit's owner. **Decision owed:** repair it in
`Commands.assignMembership` + the missing arm's deferral (FC-04's or a
follow-up's scope), or record the create arm's NULL as an accepted limit.

**R2 — the CHILD-held direction.** `badge.update({ where: { id: "b1" }, data: {
holders: { connect: { id: "h1" } } } })` with `b1.code` NULL writes NULL into
`h1.badgeCode`: the holder is not a member of `b1` and is disconnected from
`b2`. The same fact, a different supplier — here the concrete reference is the
holder's PARENT's own value, spent by the MEMBER's statement
(`association`'s `conditionalParentBinding` → `assignMembership(reference,
foundArm.fields, source.fields)`), not by a choice's supply. It cannot be
reached from this unit's owner: the refusal would have to stand before the
found arm's UPDATE, i.e. at `CommandAttempt.values(foundArm.fields)`, and a
check there cannot see the parent-held `connect`'s value at all, because the
fold has already replaced it with a scalar sub-select. Unifying the two
directions therefore means moving the fold's substitution from the choice's
bind to the destination's statement — a change of the fold's owner, outside
this brief. **Decision owed** as a bounded follow-up.

**R3 — the genuinely ambiguous placement, deliberately not touched.** A nested
`update`/`upsert` FOUND arm that nulls the referenced column under a live
member (`badge: { update: { code: null } }`) answers `ForeignKeyError` today.
The user explicitly asked for that NULL, and the provider's own constraint is a
defensible answer, so the requirement is not extended to the `found` branch's
bind: stricter semantics there would replace a provider verdict with an engine
one on a payload nobody has called wrong. Recorded, unchanged.

**Not measured.** Only in-process SQLite (both routes) and the E1 bed's live
PGlite legs ran. No MySQL, no Docker `pg`, no native batch transport: the
requirement is a plan-time comparison of a captured value against `null`, with
no SQL of its own, so no dialect is implicated — but that is an argument, not a
receipt. The segmented route's progress claim ("the operation's own segment was
never dispatched") is proved by the pin's state assertions on
`BatchOnlyDriver`, not by a statement count.

## Blockers

None. No public-contract change, no new recovery authority, no
numerical-semantics change: the sentence, its class (`NestedWriteError`) and
its relation meta are the inherited ones, and the only behavior that changed is
a refusal the retired engine already made.

## Commit message draft

```
fix(raptor3): a concrete reference that becomes a relation must be representable (FC-02C)

N5 narrowed the located-NULL refusal to the one arm Raptor 3 FOLDS — a
parent-held `connect` — so a `connectOrCreate` whose FOUND row holds NULL in
the referenced column wrote that NULL and silently DISCONNECTED the holder
the payload had asked to connect, with the sibling scalars of the same SET
committed beside it. N5 recorded the consequence as an unrepaired residual
with no cell; this is that cell and its repair.

The requirement was never the arm's. The retired engine states it once, with
the verb FIXED at `connect` (`write-engine/messages.ts:lookupKeyIsNull`), and
asserts it from BOTH `compileToOneConnect` and the parent-held
`connectOrCreate`'s found branch. `CommandExecution.folded` becomes
`supplied`, and the two facts it had merged are separated: the REQUIREMENT
asks every field the choice supplies out of its located row, with no verb gate
and ahead of every write of the unit; the FOLD stays behind its own unchanged
gate, because only a parent-held `connect`'s value is the one a consumer's SET
writes. The verb gate on the refusal and the `${origin.operation}`
interpolation are deleted — what is refused is the CONNECTION, not the verb
that spelled it — so the existing sentence is unchanged and the census is
unmoved.

Pins: new credential-free `tests/raptor3/g4/parity/reference-representability.test.ts`
(6 cells × interactive and segmented routes = 12): both verbs connect a
representable target; the found `connectOrCreate` refuses and disconnects
nothing, with no sibling write and no create-arm row; the plain connect keeps
its own sentence and state; a COMPOUND edge refuses on the unrepresentable
member and still connects the representable pair; a nullable scalar nothing
consumes as a reference stays legal; a junction choice is asked and passes.
4 red at the base, 12 green after. `parent-held-lookup` 56/56,
`correlated-membership` 10/10, `suppressed-membership-target` 14/14,
`published-key` 24/24, `lane-x-set-mutations` 10/10,
`nested-write-conformance-to-one` 19/19. Typecheck 0,
census 23 public / 72 registered (identical to the base), Biome per file
unchanged, engine token lines 16,064 → 16,064.

Registration owed (the manifest was not edited): G4_PARITY_COUNTS +=
"tests/raptor3/g4/parity/reference-representability.test.ts": 12.

Residuals, measured and recorded in the note: the `connectOrCreate` CREATE
arm's own NULL (owned by `Commands.assignMembership`, which the choice's
`select` producer hides from it) and the CHILD-held direction (the reference is
the parent's own value, spent by the member's statement) both still write NULL;
a nested update arm that nulls the referenced column under a live member keeps
its provider `ForeignKeyError`.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
