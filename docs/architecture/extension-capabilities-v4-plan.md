# Extension API v4: rows bound to the call, and data an extension writes

> Draft for the owner, 2026-09-30. Builds on PR #66 (v3.1 as shipped: `controls`, `rows`, `deletion`, trusted definitions). Nothing here is implemented. Every cost is a judgement unless marked MEASURED; the P1 spike in §5 turns the judgements into numbers before any unit is committed.

## 1. Goal and acceptance definitions

Two capabilities, so that these three extensions are declarations. Each is the acceptance test of the plan and must compile and run verbatim from public exports.

### 1.1 Tenancy (rows bound to the call)

```ts
export const tenancy = (models: readonly string[]) =>
  defineExtension({
    name: "tenancy",
    controls: { tenant: { schema: v.string(), required: true } },
    rows: {
      control: "scope",            // still one mode control per rows member
      default: "tenant",
      models: perModel(models, () => ({
        tenant: {
          root: { tenantId: { control: "tenant" } },
          related: { tenantId: { control: "tenant" } },
        },
        all: {},                    // an operator's view: the control is admitted, the filter is off
      })),
    },
    data: {
      models: perModel(models, () => ({
        create: { tenantId: { control: "tenant" } },
      })),
    },
  });

const db = base.$extends(tenancy(["post", "comment"]));
await db.post.findMany({ tenant: "acme" });                   // only acme's posts, comments included
await db.post.create({ data: { title }, tenant: "acme" });    // tenantId written by the extension
await db.post.findMany({ tenant: "acme", scope: "all" });     // every tenant, for an operator
await db.post.findMany();                                     // ValidationError: control "tenant" is required
```

### 1.2 Audit stamping (data from the call)

```ts
export const audit = (models: readonly string[]) =>
  defineExtension({
    name: "audit",
    controls: { actor: { schema: v.string(), required: true, on: "writes" } },
    data: {
      models: perModel(models, () => ({
        create: { createdBy: { control: "actor" } },
        update: { updatedBy: { control: "actor" } },
      })),
    },
  });
```

A tombstone is an update, so `updatedBy` is written on a soft delete too. `deletedBy` stays with `deletion.assign`.

### 1.3 Optimistic locking (both, on one field)

```ts
export const optimisticLock = (models: readonly string[]) =>
  defineExtension({
    name: "optimisticLock",
    controls: { expectedVersion: { schema: v.number(), on: ["update", "delete"] } },
    rows: {
      control: "versionCheck", default: "checked",
      models: perModel(models, () => ({
        checked: { root: { version: { control: "expectedVersion" } } },
        unchecked: {},
      })),
    },
    data: { models: perModel(models, () => ({ update: { version: { increment: 1 } } })) },
  });

await db.post.update({ where: { id }, data, expectedVersion: 3 }); // NotFoundError when the row moved on
```

The lock costs nothing new in the engine: a bound root predicate plus an update stamp. That is the test that the two capabilities compose.

## 2. The capabilities

### 2.1 A control value inside a `rows` predicate

**Declaration.** Anywhere a value stands in a rows predicate, `{ control: "<name>" }` names a declared control of the same extension. It may sit at any depth of the `where` tree: `{ tenantId: { control: "tenant" } }`, `{ tenantId: { in: { control: "tenants" } } }`, inside `OR`/`AND`/`NOT`. No other marker is added.

**Binding.** Today `bindRows` (src/extensions/rows.ts) precomputes one `RowDomain` per combination of the members' modes, and `callRows` picks one by index; the engine memoises a `PreparedDomain` per `RowDomain` object per engine view (src/query-engine/raptor3/commands/index.ts:162-170), so the engine never sees a control. That stays the path for every rows member without a reference, byte for byte.

A member with a reference gets a second step: `callRows` substitutes the admitted control values into a copy of the mode's predicates, one walk over the predicate tree, and memoises the resulting `RowDomain` per engine chain by (mode combination, canonical values of the referenced controls). The memo is a plain `Map` with a cap of 256 entries, oldest evicted (`// ponytail: per-value memo, LRU if a tenant count above 256 is measured`). The engine's own memo then hits on object identity as it does today, so a tenant's domains are prepared once per engine view, not per call.

**Absent value.** A reference to a control the call did not pass yields a predicate that filters nothing, the existing rule for an absent predicate. That is a silent hole for tenancy, so:

**`required` on a control** (new, one line of declaration, one refusal at admission): `controls: { tenant: { schema, required: true } }`. `admitControls` refuses a call on an operation the control is placed on when the value is absent, with a `ValidationError` at path `tenant`. A rows control (the mode) is never required: an absent one is its default.

**Cache key.** Already right: a read that admitted a control is keyed on `[args, controls, rows]` (src/client/client.ts:493-500), so two tenants never share an entry and the rows identity carries the reference marker, not a value.

**What the engine does not learn.** Nothing. `RowDomain` still holds plain `where` inputs. Preparation, correlation, lookups by purpose, the unique-key conjunction, the RETURNING decline (DC10), the ON CONFLICT gate (DC11), cursors and the M2 reference scopes are untouched.

**Not covered, stated:** a value computed from another value (`{ tenantId: { control: "tenant" } }` only, no functions); relation predicates in rows (v3.1 §2.2 unchanged); a rows predicate referencing another extension's control.

### 2.2 `data`: fields an extension writes

**Declaration.**

```ts
data: {
  models: {
    [model: string]: {
      create?: ScalarFields;   // written on every create of this model
      update?: ScalarFields;   // written on every update of this model, tombstones included
    };
  };
}
```

Values are constants, `{ control: "<name>" }` references (the same walker as §2.1), or the model's own update operators for `update` (`{ increment: 1 }`), since the stamp is admitted through the model's update-data schema.

**Semantics.**

- The stamp is generated once per call from the admitted controls, then admitted once per occurrence per attempt through the model's own `create` or `update` data schema, exactly as a tombstone is today (`Commands.tombstone`, src/query-engine/raptor3/commands/commands.ts:418-427: `schema.update(model, raw, true)`). `updatedAt` and the set envelopes come from that admission; the extension never writes them.
- **Sites, all of them:** every place the engine materialises one occurrence's data. Creates: root `create`, `createMany` rows, `upsert`'s create branch (commands.ts:1875, 1954, 2070), nested `create`/`createMany`/`connectOrCreate` (relation-body.ts:342, 415). Updates: root `update`/`updateMany`/`upsert`'s update branch, nested `update`/`updateMany`, captured series members (execution.ts:1529-1530), and the tombstone. The P1 spike confirms this list against the deletion Appendix of v3.1; a site the spike finds and this list lacks is a plan defect, not an implementation choice.
- **Collision.** A caller who passes a field the extension stamps is refused with a `ValidationError` at `data.<field>` ("set by extension audit"). One guard, one named coverage: without it a caller silently overrides a tenant stamp. This is the only runtime check the capability adds.
- **Two extensions on one model** merge per field; a later extension wins on the same field (same rule as `deletion`: later replaces).
- **Physical deletes** and `deleteMany` under `removeWhen` receive no stamp: nothing is written.
- **Raw SQL, statements, `link`/`unlink`** are untouched, as for rows.
- *(Corrected at U2, 2026-10-01, from the P1 spike's site probe.)* The site list above misses the relation-free fast paths and the nested `upsert`: the shipped sites are `Commands.create` (root create on the record route, `upsert`'s create arm, relation-bearing `createMany`, nested `create`/`createMany`/`connectOrCreate` and the nested `upsert`'s create arm), `Commands.update` (root update on the record route, `upsert`'s update arm, relation-bearing `updateMany`, nested `update` and the nested `upsert`'s update arm, every captured series member), the folds `rootCreate`, `rootUpdate` and both `rootUpsert` arms, relation-free root `createMany` rows and `updateMany`, the nested relation-free `updateMany`, and `Commands.tombstone` (plus a captured member a series tombstones, re-admitted from the tombstone's raw data). A `connect`/`set` that only moves a foreign key is **not** stamped, as no `updatedAt` moves there. A field the schema requires cannot be left to the stamp: whole-argument admission refuses it as missing before any site runs (P1, measured on four substrates), so such a field is declared nullable or with a default (decision U2-1; the §1 recipes' schemas do so).

**Where it lives.** The stamp facts travel with the call like `CallRows`: `CallScope` (src/query-engine/raptor3/shared/row-scope.ts) gains `stamps: ReadonlyMap<model, { create?: Input; update?: Input }>`, resolved by the chain per call next to `callRows`, substituted with the same walker. One engine method, `Commands.stamp(model, kind, admittedOccurrenceData)`, owns the merge and the collision refusal, and the sites call it. That is the one authority; the sites do not each know the rule.

**Types.** On a client whose chain declares `data` for a model, the fields the extension stamps leave the model's `create` and `update` input types (they are refused at runtime if passed), so a schema-required `tenantId` no longer has to be passed. This is one extension-state slot, `X["data"]`, read by `OperationPayload` (src/client/types.ts:127) as an `Omit` on the data member per model. It is the type-budget risk of this plan (§5.2) and is measured before the unit lands. If it breaches, the fallback is the v3.1 O1 pattern: no per-model narrowing, the stamped field stays in the type, the collision refusal stands, and the guide says to declare such fields optional in the schema.

## 3. What disappears, what does not

- Nothing is deleted. `deletion.assign` and `at` stay: they are a delete's own data, with the call's instant. A later plan may express `at` as `data.update` with an instant marker; not this one.
- `perModel` (shipped with soft delete) is reused by the three acceptance definitions as is.
- The v3.1 rule that a `rows` predicate is constant becomes: constant, or a control value bound at admission. Every other v3.1 rule holds.

## 4. Budgets and gates

Runtime lines are what counts (types stripped with esbuild, as the v3.1 final record §000 counts them).

| Item | Budget | Basis |
|---|---|---|
| Runtime lines, both capabilities | ≤ +350 over PR #66's head | judgement: one predicate walker (~40), per-value memo (~30), `required` (~10), stamp resolution (~40), `Commands.stamp` + site calls (~80), chain storage and placement (~50), `CallScope` plumbing (~30) |
| Base entry gzip | ≤ +1.5 KB over PR #66's head | judgement, same ratio as v3.1's engine share |
| Type budget | every client program ≤ +2% types and instantiations over PR #66's head, 1,280 MB heap, peak RSS ≤ 1,536 MiB | the v3.1 rule; the `data` Omit is the only new type work |
| Unextended client | allocates nothing new; a rows client without references keeps its exact path (the combination index) | v3.1's stability rule |
| Per-call cost of a bound rows client | one memo lookup per call after the first call per value | measured in P1 |

Stop and revise if: the `data` Omit breaches the type budget (fallback in §2.2 Types); the site list in §2.2 misses a site the spike finds; a bound predicate needs the engine to learn about controls.

## 5. Milestones

### 5.1 P1 spike (measure, no commit): 
1. Walker plus per-value memo on a scratch copy; tenancy §1.1 end to end on SQLite3 and PGlite; the per-call cost with and without the memo; the engine memo hit rate.
2. `data`: count the occurrence sites by running each verb under a stamp probe; confirm the list in §2.2.
3. The `OperationPayload` Omit on client-2 and the floor: types, instantiations, RSS.
4. Bundle of the three pieces.
Report: numbers against §4, one page.

### 5.2 M1: bound rows and `required` (unit 1), witnesses per §6.
### 5.3 M2: `data` runtime (unit 2), then `data` types (unit 3, separately committed so the budget verdict is its own).
### 5.4 M3: the three acceptance definitions as `viborm/tenancy`, `viborm/audit`, `viborm/optimistic-lock` entries (unit 4), or as documented recipes if the owner prefers not to ship them.

Each unit: implementer, adversarial executing reviewer, repair; lock scripts and budgets at the end; one PR.

## 6. Witnesses (the plan's contract, each on SQLite3, batch-only, no-RETURNING SQLite, PGlite; PostgreSQL and MySQL when a server is up)

Bound rows:
- Tenant A's reads never return B's rows: root reads, includes, to-one and to-many, quantifiers (`some`/`none`/`every`), counts, aggregates, ordering by a relation, cursors, recursion.
- Nested writes under A cannot reach B's rows: `connect`, `update`, `delete`, `set` through a relation give `NestedWriteError`, as a hidden row does today. (Corrected at the U1 repair: this line first said `NotFoundError`; today's class for a hidden nested target is `NestedWriteError`, and root writes give `NotFoundError`.)
- Unique lookups decline the RETURNING fast path under a bound domain (DC10) and `upsert` converges only within the tenant.
- The cache: A and B never share an entry; the same tenant on two clients from one config shares the key; a non-canonical value bypasses.
- `required`: an absent value is refused on every placed operation, with the path; not refused where the control is not placed.
- Memo: the same value on two calls gives the same `RowDomain` object; the 257th distinct value evicts the oldest; a rows member without a reference keeps v3.1's objects (pin by identity).
- Replan and array transactions: a bound domain is re-admitted from the same value on every attempt.

Data:
- Every site in §2.2 writes the stamp (one witness per site, create and update), including the tombstone and captured members.
- A caller's same field is refused with the path; a different field passes.
- Two extensions on one model: both fields written; the same field: the later wins.
- Physical delete writes nothing.
- `increment` on update works through the update schema (the lock).
- Types: on a `data` client the stamped field is not accepted in `data`; on the base client it is; a typo in the declaration's model key is an editor error.

Composition: §1.3 end to end, including the `NotFoundError` when the version moved.

## 7. Decisions for the owner

1. Collision rule for `data`: refuse the caller's same field (recommended, one guard), or let the extension silently win.
2. Ship the three acceptance extensions as entries, or keep them as guide recipes.
3. The memo cap (256) and eviction (oldest): fine as a documented ceiling, or measured against a tenant count you have in mind.
4. If the `data` type narrowing breaches the budget: accept the fallback (field stays in the type, refused at runtime), or drop `data` types altogether.
