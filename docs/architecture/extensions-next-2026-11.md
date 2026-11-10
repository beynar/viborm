# Extensions next: per-request actor, cascade, purge permission (2026-11)

Status: **proposal, nothing built.** Three decisions for the owner. Each
section states today's behaviour (checked in code on this branch), the
proposal, its alternatives, and what it costs. Bundle figures are estimates
from the lines each change adds to code already in the pg and D1 app
bundles; none is measured, and each would be measured with
`pnpm -s package:build && pnpm size` before landing.

Context: on this branch soft delete, ordering and permissions are one
`$extends` each, composable in any order (the chain no longer refuses
`rows` after methods; TypeScript owns that rule). The proposals below keep
that property.

## 1. A per-request actor for soft delete

### Today

- `softDelete({ models, actor })` writes `actor` into `deletedBy`. It is a
  constant of the definition: `deletion.models.<m>.assign` holds
  `{ [deletedBy]: config.actor ?? null }`
  (`src/soft-delete/index.ts`, `definitionOf`).
- Core writes `assign` as given: `Commands.tombstone()`
  (`src/query-engine/raptor3/commands/commands.ts`) spreads
  `tombstone.assign` and the call's instant, then admits it through the
  model's update schema. No value of the call reaches it.
- The `data` capability already resolves call values: a stamp field may be
  `{ control, path? }`, bound per call (`src/extensions/rows.ts`:
  `collectStampReferences`, `stampValue`, `boundStamps` in `callRows`). A
  field whose control the call did not pass is not written.
- Bound controls flow into interactive transactions: `db.$as(u)
  .$transaction(async (tx) => …)` binds `tx` too, and `tx.$as(other)` binds
  another view inside the same transaction (the scope's `$bind` rebuilds the
  transaction-bound view).
- So the documented workaround is one derived client per request
  (`softDelete({ models, actor: session.userId })(base)`, about 5.5 µs on
  this branch, one `$extends`), and one actor per transaction.

### Proposal

**Core:** let `deletion.models.<m>.assign` values be `{ control, path? }`
references, bound per call exactly as `data` stamps are.

- `rows.ts`: collect references from every `assign` beside the stamps'
  (`collectStampReferences` already walks nested values), and in `callRows`
  bind the call's tombstones through the same `stampValue` when the
  deletion names a control (`bindsStamps` becomes "binds stamps or
  assigns").
- `chain.ts`: `undeclaredControlReferencesOf` already scans a definition's
  references; it gains the assigns.
- `definition.ts`: `assign` is admitted by the same `fields()` as `data`;
  only the type (`DeletionContribution.assign`, today `ScalarData`) widens
  to `ScalarData | ControlReference` per field.
- An absent reference: `data` writes nothing for it. For a tombstone,
  writing nothing would keep whatever `deletedBy` held; proposed instead:
  an absent reference writes `null` on a tombstone (the "no actor" value
  today's `actor ?? null` writes). One rule, stated at `tombstone()`.

**Soft delete:** `actor` also takes a reference:

```ts
softDelete({
  models: { post: { deletedAt: "deletedAt", deletedBy: "deletedById" } },
  actor: { control: "actor", path: "userId" }, // permissions' bound actor
});
db.$as({ userId }).post.delete({ where: { id } }); // deletedById = userId
```

With permissions applied, one `$as` binds both: the policy's actor and the
tombstone's author. Without permissions, soft delete declares its own bound
control and a binding method (proposed name `$deletedBy(actor)`), so a
request binds once and every transaction opened from that view, or a
nested `tx.$deletedBy(other)`, carries it.

### The ordering question this raises

A definition may reference a control only an **earlier** extension declares
(`chain.ts`, "references undeclared control"). `actor: { control: "actor" }`
then needs permissions applied before soft delete, which brings back an
order rule the user must remember. Options:

1. **Forward references (recommended).** A reference may name a control
   declared anywhere in the chain. The check moves from application to the
   first call of a chain where the name is still undeclared (refused there,
   `ClientInitializationError`, naming the control and the extension), and
   to `$extends`, which re-checks the pending names against the controls it
   adds. Cost: the chain keeps one frozen list of pending names; about
   0.05 kB gzip.
2. Keep the rule; document "apply permissions before soft delete when the
   actor is permissions'". Zero cost, one order to remember.
3. Soft delete always declares its own control and never reads
   permissions': no order rule, but two bindings per request
   (`db.$as(u).$deletedBy(u.id)`).

### Cost

- Core, assigns bound per call: about 10–15 lines in `rows.ts` and
  `commands.ts`, reusing the stamp binder: **≈ +0.10 to +0.15 kB gzip** in
  the pg and D1 app bundles. A chain without references pays one boolean
  test per call (as `bindsStamps` does today).
- Forward references (option 1): ≈ +0.05 kB gzip.
- Soft delete entry: its own control and `$deletedBy`: ≈ +0.1 kB in
  `viborm/soft-delete` only (not in an app that does not import it).
- Types: `actor` widens to a union; a reference's `path` is checked against
  the control's schema as `data` checks it. Budget to re-measure
  (`tests/package/type-composition-budgets.json`).

## 2. Cascade

### Today

- Soft delete never cascades (`soft-delete.mdx`, "What happens to related
  rows"): an `onDelete: "cascade"` child stays live; `restrict` refuses the
  parent while a live child exists. Deleting children by hand gives each
  call its own `deletedAt`, so "restore what this delete removed" cannot be
  one `restoreMany`.
- **Restoring a child whose parent is a tombstone succeeds**, and its
  required to-one relation then reads `null` (typed `| null` on a soft-delete
  client). Verified path: `restore` is `update({ ...args, data, deleted:
  "only" })`; nothing reads the parent.

### Proposal: `cascade`

```ts
softDelete({
  models: {
    author: { deletedAt: "deletedAt" },
    post: { deletedAt: "deletedAt" },
  },
  cascade: { author: ["posts"] },
});
```

- **Delete.** A soft delete of an author tombstones its live posts in the
  same call, with the same `deletedAt` (the call's one instant), then the
  author. It recurses through the posts' own `cascade` entries. A child's
  own `restrict` relations still refuse the whole call while one of its
  live children exists.
- **Where it lives: core, as plain data.** `deletion.models.<m>.cascade:
  readonly string[]` names to-many (or child-held to-one) relations of a
  managed model whose target is managed too, checked at application (the
  relation exists, its target has a deletion entry, its foreign key is held
  by the target). Core honours it at every delete site, root and nested,
  `delete` and `deleteMany`, as it honours `at`/`assign`. Soft delete only
  writes the declaration. A cycle (`post.replies` on `post`) is refused at
  application unless the relation is the model's own self relation, which
  recurses by depth like the live-child check does today.
- **Order of statements** (inside the delete's own transaction): lock the
  parents (as today), tombstone each cascaded relation's live children
  (`UPDATE child SET deletedAt = t WHERE fk IN (locked keys) AND <child
  default domain>`, one statement per relation and level, which also locks
  them), then the live-child check of the relations that do not cascade,
  then the parents' tombstone. The check runs after the cascade so the
  children it just tombstoned no longer block; it still runs before the
  parents' UPDATE, so PostgreSQL's lock-then-check order holds.
- **Statements:** +1 UPDATE per cascaded relation per level reached. MySQL
  needs no extra read: the cascade's count is not part of the result.
- **Restore.** `restore`/`restoreMany` of an author also restores, through
  the same relations, the children whose `deletedAt` equals the author's
  (children deleted separately earlier, at another instant, stay deleted).
  This is the extension's, not core's: restore is an update. It becomes:
  read the targets' keys and `deletedAt` (`deleted: "only"`), restore the
  parents, then per relation `restoreMany({ where: { fk: { in: keys },
  deletedAt: t } })`, in one interactive transaction. `restore` is then a
  lazy thenable like `move`: refused inside an array transaction before any
  statement. Statements: 2 + 1 per cascaded relation per level.
- **Hooks and permissions:** each cascaded tombstone is an update of the
  child under the child's own rules (permissions judge it as a delete of
  the child, as a nested delete is today; a child the actor may not delete
  refuses the whole call). `on` hooks see each cascaded row.

### Restoring a child under a tombstoned parent

Options:

1. **Refuse (recommended)** when the child's relation to a managed parent is
   required: `restore` adds `{ [relation]: { is: {} } }` to its `where`.
   Under `deleted: "only"` a relation reads its related rows **live**
   (`only.related` is `deletedAt: null`), so the predicate holds only while
   the parent is live: no extra statement. The refusal is a
   `NotFoundError` ("restore"), as any restore that matches no tombstone;
   telling "parent deleted" apart costs one read, only on a miss
   (proposed: a `ForeignKeyError` naming the relation, from that read).
2. Restore the parent too (upward cascade): surprising, and restores rows
   the caller did not name.
3. Keep today's behaviour and document it.

Optional relations (`setNull`-like) are never refused: the child is
restored and reads `null` while the parent is a tombstone, as today.

### Cost

- Core cascade: the declaration's admission and one loop at the tombstone
  sites that already exist (`#unreferenced`, the nested delete in
  `relation-body.ts`): about 40–60 lines, **≈ +0.3 to +0.5 kB gzip** in the
  pg and D1 app bundles, paid by every application (the deletion capability
  is core). A chain without `cascade` takes one more property test per
  managed delete.
- Soft delete restore cascade: ≈ +0.3 kB in `viborm/soft-delete` only.
- Parent check on restore (option 1): one predicate per required relation,
  built at application: ≈ +0.05 kB in `viborm/soft-delete`.

## 3. Should purge be its own permission action?

### Today (this branch)

`purge`/`purgeMany` are `delete({ …, deleted: "only", mode: "hard" })`.
Permissions judges the call at the `delete` verb (`VERB_OF` in
`src/permissions/index.ts`): every holder of `delete` on a row may purge it
once it is a tombstone. A soft delete is also judged at `delete`, so the
two cannot be granted apart: whoever may move a document to the bin may
erase it for good.

### Options

1. **Keep `delete` for both (status quo).** No configuration; the bin is
   only as safe as the delete grant.
2. **A `purge` action, opt-in (recommended).** When a policy declares a
   rule for `purge` on a model, permissions judges a physical delete of a
   soft-deleted model (`mode: "hard"`) at `purge`, and a soft delete at
   `delete`; a policy that declares no `purge` keeps option 1. `purge`
   implies nothing and nothing implies it, unless the policy's graph says
   so. Mechanism: permissions reads the call's `mode` control in its
   query handler (it already maps operations to actions there); the
   control is soft delete's, so this needs forward control references
   (section 1, option 1) for any order of the two extensions, or
   permissions recognises `mode` by its declared values without
   referencing it. Cost: ≈ +0.1 kB in `viborm/permissions` only.
3. **Always a separate action.** Breaking for existing policies (every
   purge would need a new grant).

## Decisions requested

| # | Question | Recommendation |
|---|---|---|
| 1 | Bind the soft-delete actor per call (`assign` references)? | Yes |
| 1b | Forward control references, or keep "earlier only"? | Forward |
| 2 | `cascade` in core's deletion capability, restore cascade in soft delete? | Yes |
| 2b | Restoring a child whose required parent is a tombstone | Refuse |
| 3 | `purge` as its own permission action | Opt-in action |
