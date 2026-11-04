# Junction as an ordinary declared model: plan (November 2026, target 1.12.0)

`s.toMany(() => team).name("teamGraph").through(() => teamParent).source("child").target("parent")`:
a many-to-many whose junction is a model the schema already declares. The edge
stays `kind: "junction"`, so reads, filters, `recurse`, `selective`, `fewRows`
and counts keep their one path. What changes is where the two sides' members
come from (each to-one's stored reference, not generated columns) and who owns
the table (the model, not the junction serializer).

Absent means identical: a schema with no model junction sends the same bytes.

## The shape

- `ModelToManyState.junction.model`: the thunk. `RelationInternal` gains a
  once-cell beside `settleTarget`. The state generic carries nothing about it,
  so no comparison reaches into a mutually recursive model const.
- `ResolvedJunctionTopology.declared?: { model, key }`: the one fact the rest
  of the engine asks. `key` is the physical conflict target of a link.
- `ResolvedJunctionSide.members`: `junctionField` is the physical column of the
  to-one's foreign field (`.map()` respected), `referencedField` its field on
  the endpoint model. A shared column appears in both sides' members.
- A side to-one with no inverse of its own publishes a foreign-key edge whose
  second endpoint is the collection slot that hops through it (`team.parents`
  for `teamParent.child`). That is a real slot, not a synthetic one: it holds
  on the side's model, so every `edge.endpoints` reader answers the right
  target, and the slot itself still resolves to the junction edge.

## Sites that assume members are the row key

Found by reading each `junctionField` / `referencedField` / `schema.keys` use.

| Site | Assumption | Answer |
| --- | --- | --- |
| `query.ts` `#hopFields`, `#sharedWalk` | carried hop columns | Already reads non-key fields; prove with a shared-body walk |
| `query.ts` `#joinsPredecessor`, `#predecessor` | `into(field)` holds only keys | Guarded by `every(keys.includes)`: joins the row otherwise; prove |
| `query.ts` `#memberSource` comment | "PK spans both sides, each references a complete row key" so a member is read once | Holds under the covering-key rule; the rule is what makes it hold |
| `operation-context.ts` `link`, `#linkOperands`, `#linkStatement` | columns are distinct, conflict target is every column | Distinct columns once, conflict on `declared.key`, defaults filled |
| `operation-context.ts` `remove` | `target` values are the identity | Fed by `execution.ts`, see next row |
| `execution.ts` `case "remove"` | `this.identity(command.target)` | Read the target side's referenced fields |
| `execution.ts` `#linkValues` (held member) | `Object.fromEntries` last-wins | First side wins: membership already proved agreement |
| `selection.ts` `junctionPairs` | one writer per column | Plan keeps the second side's value; link refuses a disagreement |
| `relation-body.ts` disconnect / delete | outgoing row's key suffices | Demand the target side's fields on `outgoing` |
| `relation-body.ts` `#setTargets` | `select(keys)` | `#linkFields` already demands the side's fields |
| `schema.ts` `restrictingSlots` | `junctionOnDelete` default CASCADE | A declared side states its to-one's own action, so the answer is that action |
| `resolution` `resolveOrdinaryPair` | to-one side always has an inverse | Side exemption, verdict stays "missing" but no R002 |
| `serializer.ts` `stageEdges` | every junction edge owns a table | A declared edge owns none |

The reachable shared-column case is `organizationId`: a `connect` given `{ id }`
must obtain it from the located row, and a target in another organization must
be refused, never written with whichever side was read last.

## Rules the resolver refuses, JT family, each with a repair

- JT004: `.through(() => m)` names an unregistered model, or its thunk threw.
- JT005: a side relation is missing, not a to-one with a stored reference,
  nullable, or aimed at the wrong model; or both sides name one relation.
- JT006: a side cannot be chosen: a self relation states none, or several
  candidates remain.
- JT007: polymorphic: the junction model carries variant storage.
- JT008: no primary key or unique over the pair. A key must lie inside the
  union of both sides' columns and hold every non-shared column. It may omit a
  shared column only where that column follows from a side's remaining fields,
  because otherwise `DO NOTHING` silently drops a link in another tenant.
- JT009: one model is the junction of two pairs.
- JT010: `.onDelete()` / `.onUpdate()` beside a model: the to-one owns the action.

A required column with no default is legal: a write that states it through
`$through` links it, and one that does not is refused.

A shared column whose two sides reference different types gets no code of its
own. The stored-reference check of the side it disagrees with (FK003) and the
identifier domains already refuse it, so a JT check could never fire.

## Extensions

A hop is storage. `rows`, soft delete, hooks and stamps apply to the junction
model's own delegate. The `deletion` capability refuses a junction model where
`validateNamedPolicies` already reads its model names: a tombstoned link hops
still follow would be wrong, and that owner covers both `softDelete` forms and
any other extension declaring `deletion`.

## Order of work

1. Builder, state, once-cell, JSON document (read, serialize, interpret, docs).
2. Resolver: settlement, side exemption, rules, topology, one-sided edges.
3. Serializer and the migration path; generated → model plan test on PGlite.
4. Engine writes, then shared-column refusal, then defaults and conflict target.
5. Read proofs: filters, `recurse`, `selective`, `fewRows`, counts, Neki form.
6. Extensions: `deletion` refusal; `permissions({ tenant })` walks and negatives.
7. Studio, surface golden, docs, changelog.
8. Provider matrix; acceptance EXPLAIN ANALYZE; absent-means-identical capture.

## `$through`: added by the owner mid-build

`include: { parents: true }` stays the target rows. `$through` is the explicit
way to read, filter or write the link row. It is the slot's key, mounted where a
declared model holds the slot, so the target model's shared schemas stay as they
are and a schema that never asks pays nothing.

- **Read.** The page already reads `FROM link JOIN target` (`#memberSource`), so
  the columns come from the row that produced each target, flat in the page and
  an object above it. A key holds at most one row per pair, so a target is read
  once.
- **Filter.** The body is joined to the link (`#junctionJoin`, forced) so the
  target's and the link's conditions test one pair, under `some`, `none` and
  `every` alike. `mergeQuantifiers` leaves a link condition its own range.
- **Write.** Stated columns pass each scalar's own create schema, kept apart from
  defaults so an existing link takes only what was stated. PostgreSQL, SQLite and
  D1: one `ON CONFLICT (key) DO UPDATE`. MySQL: the anti-join insert, then one
  UPDATE. `set` keeps the links it retains rather than deleting them.
- **Name.** `$` is no part of a field name (F001), so a member can never take the
  key. `rows.verbs.*.evidence.as` refuses it for an extension's projection key.
- **Extensions.** What a direct call on the model would hide or judge refuses
  `$through` instead of being passed by: `rows` that can leave a row out, a read
  gate on a named field, verbs, a stamp, a write hook. A rule that hides nothing
  (`read: true`) admits a read. `defaultOmit` is honoured on `$through: true`.

## The tenant bound on a link

The first acceptance measurement read as many links through the model as through
a generated junction (109,070 each). The correlation `link.org = row.org` changes
what matches, not what is read. What the earlier proof had written by hand was a
constant on each link alias, and the existing bound says the same thing:
`#linkBound` applies `#setBound` at every hop's link alias, so it holds only while
a layer's predicates lower and never under a negation. Measured on PGlite at 40
organizations of 30 teams: 109,070 → 94 link rows read, same answers. Rows read,
not time.
