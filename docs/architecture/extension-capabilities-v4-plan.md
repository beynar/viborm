# Extension API v4: rows bound to the call, and data an extension writes

> Draft for the owner, 2026-09-30. Builds on PR #66 (v3.1 as shipped: `controls`, `rows`, `deletion`, trusted definitions). Nothing here is implemented. Every cost is a judgement unless marked MEASURED; the P1 spike in §5 turns the judgements into numbers before any unit is committed.

## 1. Goal and acceptance definitions

Two capabilities, so that these three extensions are declarations. Each is the acceptance test of the plan and must compile and run verbatim from public exports.

Each takes its model names through `perModel`, which keeps them, so the client types know which models a recipe writes (owner ruling, 2026-10-01, §7.5; unit T2 made these blocks byte-identical to the guide and to `tests/fixtures/extension-recipes.ts`):

```ts
/**
 * The same entry for each model named. `Object.fromEntries` forgets the
 * names, so the cast gives them back: the types then know which models a
 * recipe writes.
 */
export const perModel = <Models extends readonly string[], T>(
  models: Models,
  build: () => T
) =>
  Object.fromEntries(models.map((model) => [model, build()])) as {
    readonly [Model in Models[number]]: T;
  };
```

### 1.1 Tenancy (rows bound to the call)

```ts
export const tenancy = <const Models extends readonly string[]>(
  models: Models
) =>
  defineExtension({
    name: "tenancy",
    controls: { tenant: { schema: v.string(), required: true } },
    rows: {
      control: "scope", // still one mode control per rows member
      default: "tenant",
      models: perModel(models, () => ({
        tenant: {
          root: { tenantId: { control: "tenant" } },
          related: { tenantId: { control: "tenant" } },
        },
        all: {}, // an operator's view: the control is admitted, the filter is off
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
export const audit = <const Models extends readonly string[]>(models: Models) =>
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
export const optimisticLock = <const Models extends readonly string[]>(
  models: Models
) =>
  defineExtension({
    name: "optimisticLock",
    controls: {
      expectedVersion: { schema: v.number(), on: ["update", "delete"] },
    },
    rows: {
      control: "versionCheck",
      default: "checked",
      models: perModel(models, () => ({
        checked: { root: { version: { control: "expectedVersion" } } },
        unchecked: {},
      })),
    },
    data: {
      models: perModel(models, () => ({
        update: { version: { increment: 1 } },
      })),
    },
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

*(Owner ruling, 2026-10-01; R1.)* A `required` control is asked for only on the models its own extension names: the keys of that extension's `rows.models`, `data.models` and `deletion.models`. On a model outside them the control is still accepted wherever its `on` places it, and checked, but a call that leaves it out is not refused, so tenancy asks for a tenant on the models it filters and nowhere else, and audit asks for an actor on the writes of the models it stamps. An extension that names no model at all (only controls) keeps the first rule: the value is asked for on every model its `on` covers. The placement owns the rule (`placeControls` gives each control the models that require it, `ResolvedControl.required`); admission only reads it. Types: nothing a caller writes changes, since every control is already optional in the types. The type checker does a little more work: 9 more types and 4 more instantiations, both on the client-2 type tests and on the one-schema floor probe (measured at the rulings repair, far inside the +2% budget).

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
- *(Replaced by the owner, 2026-10-02, unit S1; see §7.1.)* There is no collision refusal. Per occurrence, an extension writes a field only when the caller's own data for that occurrence wrote neither that field nor a relation whose foreign key on this model holds it; otherwise the caller's value stands, on a create and on an update alike. A tombstone has no caller data, so it is always stamped.
- **Two extensions on one model** merge per field; a later extension wins on the same field (same rule as `deletion`: later replaces).
- **Physical deletes** and `deleteMany` under `removeWhen` receive no stamp: nothing is written.
- **Raw SQL, statements, `link`/`unlink`** are untouched, as for rows.
- *(Corrected at U2, 2026-10-01, from the P1 spike's site probe.)* The site list above misses the relation-free fast paths and the nested `upsert`: the shipped sites are `Commands.create` (root create on the record route, `upsert`'s create arm, relation-bearing `createMany`, nested `create`/`createMany`/`connectOrCreate` and the nested `upsert`'s create arm), `Commands.update` (root update on the record route, `upsert`'s update arm, relation-bearing `updateMany`, nested `update` and the nested `upsert`'s update arm, every captured series member), the folds `rootCreate`, `rootUpdate` and both `rootUpsert` arms, relation-free root `createMany` rows and `updateMany`, the nested relation-free `updateMany`, and `Commands.tombstone` (plus a captured member a series tombstones, re-admitted from the tombstone's raw data). A `connect`/`set` that only moves a foreign key is **not** stamped, as no `updatedAt` moves there. A field the schema requires cannot be left to the stamp: whole-argument admission refuses it as missing before any site runs (P1, measured on four substrates), so such a field is declared nullable or with a default (decision U2-1; the §1 recipes' schemas do so).
- *(Checked at U4, 2026-10-01.)* The U2 correction above matches the P1 spike's site table (its stamp probe: 40 verbs on three SQLite substrates and 7 tombstone verbs, 128 of 134 written rows stamped, the six others the membership moves that must not be): no site is missing. The line numbers in the site bullet are those of the draft, and P1 found them wrong at 6ee4c4592: nested `create`, `createMany` and `connectOrCreate` (with the nested `upsert`'s create arm) reach `Commands.create` from relation-body.ts:400, 420 and 492, not 342 and 415; the tombstone is reached from four places, the root delete (commands.ts:1929), a nested `delete` (relation-body.ts:279), a nested `deleteMany` (relation-body.ts:770) and a captured delete member (execution.ts:1491).
- *(Corrected at the U2 repair, 2026-10-01.)* **Collision covers every declared field of the kind**, written on this call or not: a field whose control the call did not pass is not written, and the caller may not write it either (the refusal reads the stamp's owners, not its bound values), so the runtime agrees with the types U3 will narrow. **A later extension owns a field on every call**: when it names a control there and the call does not pass it, neither its value nor an earlier extension's is written (the merge is per field, at chain time, as `deletion`'s later-replaces). The refusal's path is `data.<field>` at every depth, as written above: it names the field, not the occurrence's position (a nested create or an `upsert` arm), and the guide says so.

**Where it lives.** The stamp facts travel with the call like `CallRows`: `CallScope` (src/query-engine/raptor3/shared/row-scope.ts) gains `stamps: ReadonlyMap<model, { create?: Input; update?: Input }>`, resolved by the chain per call next to `callRows`, substituted with the same walker. *(U2 repair, 2026-10-01: stamps that name a control are bound per call and never enter the §2.1 per-value memo, whose key holds only the controls the domain and default domain name; otherwise tenancy plus audit would build one `RowDomain` per tenant and actor and push a tenant's read facts out of the 256 entries.)* One engine method, `Commands.stamp(model, kind, admittedOccurrenceData)`, owns the merge and the collision refusal, and the sites call it. That is the one authority; the sites do not each know the rule.

**Types.** On a client whose chain declares `data` for a model, the fields the extension stamps leave the model's `create` and `update` input types (they are refused at runtime if passed), so a schema-required `tenantId` no longer has to be passed. This is one extension-state slot, `X["data"]`, read by `OperationPayload` (src/client/types.ts:127) as an `Omit` on the data member per model. It is the type-budget risk of this plan (§5.2) and is measured before the unit lands. If it breaches, the fallback is the v3.1 O1 pattern: no per-model narrowing, the stamped field stays in the type, the collision refusal stands, and the guide says to declare such fields optional in the schema.

*(Amended at the U2 repair, 2026-10-01; OPEN OWNER DECISION.)* The promise "a schema-required `tenantId` no longer has to be passed" is not reachable with the U2 runtime: whole-argument admission refuses a required field as missing before any stamp site runs (P1 §2, decision U2-1, option (c) taken as the plan's own fallback). Until the owner chooses otherwise, U3 removes a stamped field from the `data` input types only where the runtime can fill it, a field that is nullable or has a default; a schema-required stamped field is a declaration the guide tells the reader not to write (every create of it is refused as missing). Reaching the original promise needs P1's option (a), a pre-admission stamp walk over the raw arguments, or (b), a validator per chain, in a dedicated unit: §7.5.

*(Shipped at U3, 2026-10-01.)* The slot is `X["data"]` (`StampedFields` per model and kind). It is read by the extended client's model delegate, not by `OperationPayload` and not as a `Client` parameter: as a `Client` parameter it cost the instrumentation type program +13.9% types and +26.1% instantiations (MEASURED), and `OperationPayload` stays the public schema-only payload. A field is made unwritable with `?: never`, not removed with `Omit` (P1-7: the plain `Omit` does not refuse it), so a schema-required stamped field keeps `required` and accepts no value: every create of it is an editor error, as it is refused at runtime under option (c). Nested inputs are narrowed too, by a guard that follows the relations and verbs the call spells and finds a target by its shallow surface; a relation with variants is not narrowed. A misspelt `data.models` key is an editor error at `$extends` and `defineExtension<S>()`; a `string[]` recipe narrows every model (reversed at the U3 repair, below). Type budget, three alternating rounds against 6ee4c4592 in 6ee4c4592's chunking: client-1..4 +0.64 / +1.18 / +0.60 / +0.82% types and +0.89 / +1.59 / +0.81 / +1.11% instantiations, instrumentation +0.65 / +0.40%, floor +0.66 / +0.93%, peak RSS 1,472.2 MiB (HEAD 1,491.6): within §4, so the §7.4 fallback was not taken.

*(U3 repair, 2026-10-01.)* Three corrections to the U3 note, for the owner. (1) **A definition whose model names are lost narrows nothing.** The §1 recipes take `readonly string[]`, so their `perModel` map is keyed by `string` and the types cannot tell which models they name; U3 refused their fields on every model, which made a create of any other model with a required `createdBy`, `tenantId` or `version` impossible on the extended client although the runtime accepts it. Such a definition now adds nothing to `X["data"]`: its fields stay in the payloads and the runtime collision refusal stands alone, the permissive direction of this section's fallback and of §7.4. A `data` entry written inline keeps its names and is narrowed as before; the recipes stay verbatim. (2) **The required-field rule departs from the U2-repair amendment's wording**, which says U3 narrows only fields the runtime can fill (nullable or defaulted). U3 also marks a schema-required stamped field `?: never`, so every create of it is an editor error, as it is refused at runtime under option (c). This is not settled by the U3 note: it is part of §7.5. (3) **The place moved.** The narrowing is read by the extended client's model delegate, not by `OperationPayload` as this section says, so what reads `OperationPayload` directly (a query handler's argument type, for one) is not narrowed; the runtime refusal covers it. The owner acknowledges the move when closing §2.2.

*(Unit T2, 2026-10-01: the owner's ruling "Recipes keep model names, field becomes optional" in the types.)* Two corrections to the notes above. (1) **A stamped field is optional and accepts no value**, no longer "keeps `required`": the extended client's payload rebuilds each create and update row without the stamped fields and offers each back as `?: never` (`StampedPayload`, `StampedRow`), so a schema-required `tenantId` may be left out and may not be passed, at the root (`create`, `createMany` rows, `upsert`'s arms) and in every create and update nested through a relation, at any depth (`StampedRelation`, `StampedVerb`, `StampedArms`). The same rebuilt row type replaces U3's `NestedStampGuard`: one mechanism for root and nested. A relation with variants is still not rebuilt, so a create nested through one still asks for a required stamped field the call accepts left out (stated in the guide). (2) **The recipes keep their model names** (U3 repair item (1) reversed by the owner): each recipe takes `<const Models extends readonly string[]>`, so the reader writes no `as const`, and `perModel` keys its map by those names with one cast (`as { readonly [Model in Models[number]]: T }`, the cast the soft-delete entry's `perModel` already holds; user-land code, not `src`). A recipe now narrows the models it names and no other, and a misspelt model in its list is an editor error at `$extends`. A recipe called with a plain `string[]` still compiles and narrows nothing. To let a recipe's generic keys compile inside `defineExtension`, the misspelt-model check (`DataModelsGuard`) resolves first on whether the schema is known: a definition built before any schema had nothing to compare with. Type budget (MEASURED, two alternating rounds, typescript 5.9 `--extendedDiagnostics`, 1,280 MB heap, 6ee4c4592's chunking): in §7.5. A first version with a conditional type at the payload level cost +14k instantiations on client-2, a program that declares no `data`; the payload level is a plain mapped type for that reason.

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

*(Owner ruling, 2026-10-01.)* The base bundle limit over main is the measured figure, +5.4 KB gzip (final record §0000.4: +5,395 to +5,466 B on pg-representative), in place of the v3.1 §5.2 "+5 KB over main" bar. STOP U3R-1 is closed by the owner.

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

*(U4, 2026-10-01.)* Recipes, per the owner decision taken for this run on §7.2: the guide page `docs/content/docs/extensions/recipes.mdx` carries the three definitions as `tests/fixtures/extension-recipes.ts` writes them (the behaviour tests run that file), and `tests/package/extension-recipes-consumer-smoke.mjs` builds them from the packed tarball, checks the page carries each block of the file verbatim, type-checks them and runs §1.1's calls (the first read with an `include` added, to observe the related filter) with audit and the lock applied over tenancy. *(U4 repair.)* It also runs the page's three use blocks verbatim, each in a scope of its own over the plain client, and checks what they wrote.

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
  *(S1, 2026-10-02: replaced by the owner's ruling, §7.1. A caller's same field, or the relation holding it, keeps its value at every site; a row that leaves it out takes the stamp.)*
- Two extensions on one model: both fields written; the same field: the later wins.
- Physical delete writes nothing.
- `increment` on update works through the update schema (the lock).
- Types: on a `data` client the stamped field is not accepted in `data`; on the base client it is; a typo in the declaration's model key is an editor error.
  *(S1, 2026-10-02: on a `data` client a stamped create field is optional and keeps its own type; a value of the wrong type is an editor error.)*

Composition: §1.3 end to end, including the `NotFoundError` when the version moved.

## 7. Decisions for the owner

1. Collision rule for `data`: refuse the caller's same field (recommended, one guard), or let the extension silently win.
   *(Owner ruling, 2026-10-02, unit S1; replaces the refusal taken for this item and the ruling 2 repair's refusal of a relation that holds a stamped foreign key, item 5.)* The owner: "in such case where an extension is writing a connection automatically like in the multi-tenancy extension, the extension should step back whenever a tenant ID or a connect tenant ID is written by hand", and for updates "the same logic could apply". Neither alternative of this item is kept: the extension neither refuses the caller nor wins; it steps back. Per occurrence, an extension's `data` writes a field only when the caller's own data for that occurrence wrote neither that field nor a relation whose foreign key on this model holds it; otherwise the caller's value stands and the extension writes nothing for that field. An explicit `undefined` counts as not written. It holds for creates and updates at every site `Commands.stamp` serves (root and nested creates, updates, `upsert` arms, captured members); a tombstone has no caller data and is always stamped. Among extensions the later still wins a field; the caller wins over all of them; the optimistic lock's increment gives way to a `version` the caller writes. Consequence, stated in the guide: under tenancy reads stay with the call's tenant, but writes are not enforced; a caller who writes `tenantId`, or connects a tenant, by hand writes into that tenant, on a create and on an update. Code: the refusal and its `taken` relation arm are deleted with `Stamp.owners` (the stamp is now the declared `Input` itself); on a data client a stamped create field is optional with its own type and the relation that holds it is writable again (`HoldsField` and `Unwritable` deleted; update rows narrow nothing, so the type slot keeps create fields only). T1's rule stays: a required stamped field may still be left out. MEASURED: runtime lines (esbuild) −29 (commands.ts −23, chain.ts −6); pg-representative 562,898 / 166,101 → 562,384 / 165,924 (−514 raw / −177 gzip; +5,858 gzip over main's 160,066); types over HEAD (9005c76fb), two alternating rounds, deterministic: client-1 −75 / −996, client-2 −89 / −1,374, client-3 −79 / −1,014, client-4 −82 / −1,197, instrumentation −79 / −1,014, floor −79 / −1,014 (types / instantiations); cumulative over 6ee4c4592: client-1 +0.82% / +1.15%, client-2 +1.06% / +1.50%, client-3 +0.77% / +1.02%, client-4 +1.01% / +1.40%, instrumentation +0.82% / +1.07%, floor +0.85% / +1.21%; peak RSS 1,476.3 MiB.
2. Ship the three acceptance extensions as entries, or keep them as guide recipes.
3. The memo cap (256) and eviction (oldest): fine as a documented ceiling, or measured against a tenant count you have in mind.
   *(Owner ruling, 2026-10-01: kept as is.)* One 256-entry memo per extended client, shared by every value a `rows` filter names, as the U4 repair below describes.
   *(U4 repair, 2026-10-01.)* The ceiling counts every value a `rows` filter names, not tenants alone: a memo key holds each control the combination's filters or the default filters name. On a chain with tenancy and the optimistic lock, each update or delete with a new `expectedVersion` takes an entry, so steady writes push tenants out of the 256 (results stay correct; only the cost claim "128 tenants" fails there). recipes.mdx and create.mdx now say so, with the remedy: apply the lock on a client of its own (`db.$extends(lock)` builds its own memo, `db` keeps its tenants). Witness: extension-controls.core.test.ts, "the lock's version takes room beside the tenant". Still the owner's call if one shared ceiling for tenants is wanted (for instance a memo per rows member).
4. If the `data` type narrowing breaches the budget: accept the fallback (field stays in the type, refused at runtime), or drop `data` types altogether.
5. *(Added at the U2 repair, 2026-10-01; open.)* A schema-required stamped field: keep option (c) (declare stamped fields nullable or with a default; U3 narrows only those), or fund option (a) (stamp the raw arguments before admission) or (b) (a validator per chain) in a dedicated unit so a required `tenantId` need not be passed. *(U3 repair: also open under this item.)* U3 shipped a stricter type than "narrows only those": a schema-required stamped field accepts no value and stays required, so every create of that model is an editor error on a client whose types know the model. Keep it (types and runtime agree that such a create cannot succeed), or narrow only nullable and defaulted fields as the U2-repair wording says (the required field then compiles and is refused when the call runs).
   *(Owner ruling 2, 2026-10-01, and unit R2: stopped, waiting on the owner.)* The owner ruled that a field an extension writes and the schema requires must work without the caller passing it. The running code can do it: design B tells validation which fields the call's extension writes, so a required one may be left out (+18 runtime lines; pg-representative +364 raw / +101 gzip; types +21 / +76 on the client-2 and floor programmes; measured at the rulings repair). It also covers the most common tenancy schema, where `tenantId` is a required foreign key to a tenant table: the "one of tenantId or tenant" check now counts a written field as given too (root create, createMany, upsert and nested creates, on SQLite3, batch-only and no-RETURNING SQLite). Nothing has landed, because TypeScript callers would still be stuck: with the `string[]` recipes the field stays required in the types (leaving it out does not compile, passing it is refused), and with a `data` entry written inline the whole create becomes impossible to type. The choice left to the owner: (1) land design B for the running code only and keep telling TypeScript users to declare the field nullable or with a default; (2) also fund a types unit (let inline entries leave the field out at the top level; nested creates have no cheap design yet; for recipes either make their field names optional on every model or revisit ruling 5 so recipes keep their model names); (3) keep today's rule (nullable or default). The design-B patch and its probes are not in the repository; they are held with this run's working files until the owner decides.
   *(Owner ruling, 2026-10-01, replacing the "recipes keep `string[]`" ruling of item 6: "Recipes keep model names, field becomes optional".)* The recipes remember the model names they are given, without `as const` from the reader, so the editor knows which models have a stamped field and lets the caller leave it out; and the running code lets a schema-required stamped field be left out. Nested creates are included only if the type budget allows, measured before landing.
   *(Unit T1, 2026-10-01: the running code landed; the types are unit T2's.)* Design B as repaired, plus one site it missed: a relation-bearing `updateMany`, or a nested `updateMany`, admits each captured row's data again when it runs, and a nested create in that data was refused as missing. Validation is told, for one synchronous parse, which fields of which model the call's create stamps write (`parseProviding`, option `provides` set to the model's name on the create, bulk-create and scalar-create schemas; nested copies keep it); the engine sets that context only on a call that has stamps (`parseStamped`: the call's admission and a captured row's re-admission). The required-field check and the "one of the foreign key or its relation" check count such a field as given; everything else refuses as before, with the same message. Measured: +41 runtime lines (esbuild); pg-representative +512 raw / +149 gzip; +27 types / +81 instantiations on every client program and the floor (cumulative over 6ee4c4592: client-2 +1.19% / +1.60%, the largest); witnesses `tests/contracts/engine/write/stamped-required-behavior.ts` (7 cells on SQLite3, batch-only, no-RETURNING and PGlite). Open, measured, for the owner: a caller who writes the stamped foreign key's relation (`tenant: { connect: … }`) instead of the field is not refused and that tenant is stored, as before T1 with a nullable field (guard ledger, T1 addendum).
   *(Unit T2, 2026-10-01: the types landed; ruling 5 as revised by the owner.)* On a client whose chain declares `data` for a model the types can name, a stamped field is optional and accepts no value in that model's create and update rows, at the root and nested through relations (a relation with variants excepted); the three recipes keep their model names through a `const` type parameter, with one key-map cast in `perModel`. The packed consumer and the guide's use blocks now run with a required `tenantId` under `tsc --strict` (the guide's audit use block applies tenancy first, since its schema requires `tenantId`). Nested creates are included: the cumulative budget holds (MEASURED, two alternating rounds, deterministic; types / instantiations over 6ee4c4592: client-1 +0.82% / +1.18%, client-2 +1.07% / +1.54%, client-3 +0.78% / +1.05%, client-4 +1.02% / +1.44%, instrumentation +0.82% / +1.10%, floor +0.85% / +1.24%; peak RSS 1,479 MiB). Not changed: the relation of a stamped foreign key stays writable in the types, as at runtime (the open item above).
   *(Ruling 2 repair, 2026-10-01, after the executing review of T1 and T2.)* The open item is closed in the code: a create that writes the stamped foreign key through its relation (`tenant: { connect }`, `create`, `connectOrCreate`) is refused at `data.<relation>` with the same message as the field (`Commands.stamp`), and on the extended client that relation accepts no value in the rows of the models the chain names (`HoldsField` in `StampedRow`). Under tenancy a create therefore writes neither the key nor its relation; with a composite foreign key that includes `tenantId`, the caller writes the other key column instead. Not changed, documented: the types find a nested create's target by its shallow surface, so an unnamed model with a named model's surface is narrowed with it (the editor lets a required stamped field be left out there and the call refuses it). `provides` left the public `ObjectOptions`. MEASURED: +16 runtime lines (esbuild; T1 and the repair together +57 over 8dce0d121, budget +60); pg-representative +300 raw / +112 gzip over T2 (+812 / +247 over 8dce0d121, budget +400); types over 6ee4c4592: client-1 +0.83% / +1.18%, client-2 +1.07% / +1.54%, client-3 +0.78% / +1.05%, client-4 +1.02% / +1.44%, instrumentation +0.83% / +1.10%, floor +0.86% / +1.24%; peak RSS 1,491.2 MiB.
   *(Owner ruling, 2026-10-02, unit S1.)* The refusal above is withdrawn: "in such case where an extension is writing a connection automatically like in the multi-tenancy extension, the extension should step back whenever a tenant ID or a connect tenant ID is written by hand", and for updates "the same logic could apply". A create that writes the stamped foreign key, or the relation that holds it (`connect` by any unique field, `create`, `connectOrCreate`), keeps what it wrote, and the extension writes nothing for that key; on the extended client the field is optional and passable with its own type and the relation is writable, so a required key is satisfied by neither or by either, as the base type's key-set rule allows. A field the schema requires may still be left out (T1, unchanged). The rule and its numbers are in item 1.
6. *(Owner ruling, 2026-10-01: kept as is.)* The §1 recipes keep taking `readonly string[]`: they narrow nothing in the types (U3 repair note in §2.2), and the runtime refusal of a stamped field stands alone for them.
   *(Replaced by the owner, 2026-10-01: "Recipes keep model names, field becomes optional", item 5. Unit T2 owns it.)*
   *(Unit T2, 2026-10-01.)* Done: the recipes take `<const Models extends readonly string[]>(models: Models)` and narrow the models they name; a plain `string[]` argument compiles and narrows nothing (guide, recipes page).
7. *(Owner ruling, 2026-10-02, unit S2.)* Which rows a limited `deleteMany` takes. The owner: "every post that is not soft deleted already ... like we do in findMany we order shallowly by id, so the ten first will be the ten first not deleted ordered by id". What `findMany` does: with `take` (or a cursor) and no `orderBy` it orders by the model's key, ascending (`Queries.page` → `totalOrder` → `completeOrder`); with neither it states no order. The key is a bare scalar id, else the row key's fields in DECLARATION order, which differs from the constraint's order when `.id([...])` lists them otherwise. Rule: every limited set write takes the first `limit` rows it may take in that order: hard delete, soft delete with or without a restricting slot (its candidates, so tombstones are skipped), `updateMany` scalar and relation-bearing, top-level, batch-only, array transaction, with and without RETURNING. One owner: `Queries.lowerMutationLimit` (the ordered keyed subquery `Queries.capped`, which `Queries.window` lowers to too; MySQL's `ORDER BY keys LIMIT n` on the statement), and one key order, `Queries.keyOrder` (formerly the private `identityOrder`), read by `capped`, `through` and the relation-bearing series capture. The unordered branch of `capped` is deleted. Found on the way: `through` and the batch window compared the row key in constraint order against a read ordered in declaration order, so on such a key the interactive soft delete took 400 rows of a window of 500 and the batch one was refused by a reference outside the window (the deletion witness's `shelf` now declares `.id(["b", "a"])`). MEASURED: runtime lines (esbuild, non-blank) +8 (query.ts +9, commands.ts −1; +4 without comments); pg-representative 562,384 / 165,924 → 562,488 / 165,942 (+104 raw / +18 gzip; +5,876 gzip over main's 160,066); refusal census 203 → 203, line shifts only.
