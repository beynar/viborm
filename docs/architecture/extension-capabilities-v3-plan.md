# Extension API v3.1: the same soft delete, after the owner's rulings

> Implemented on branch `extension-capabilities` (2026-09-29/30). §2.2 and §2.4 carry the two wording amendments the units required; the qualification is in `extension-capabilities-final-record.md`, the decisions taken while the owner was away in `extension-capabilities-decisions.md`.

Status: **v3.1, 2026-10-01: rulings O1 and O8 accepted, O2 and O3 rejected**
(`rulings.md`, last section), so `restore`/`restoreMany` and `mode: "hard"`
stay. v3 revised `extension-capabilities-v2-plan.md` after the owner's "seems
like a lot already; look at ELEGANCE.md and do a clean-up pass". Nothing is
implemented or approved; O4-O7 are open (§6). Base `30ff17e69` (the P1 base).
Rulings bind. Labels: **measured** (P1 report, "P1 §n/item n", or the
executing review, "review"), **source** (file:line at `30ff17e69` unless a
tree is named), **judgement** (basis given). Method: ELEGANCE §Apply for every
v2 concept. Required behaviour is unchanged unless §6 says so.

## 1. Goal and acceptance definition

Goal, unchanged: extend the extension API "to the point where building the
soft delete extension is only a matter of a few lines and definition. We
won't rewrite the engine for that." The capabilities are the deliverable, the
soft-delete extension the acceptance test; a soft-delete branch in core stops
the work (§5.4).

### 1.1 The whole soft-delete extension (changed: 75 lines; v2 77, v3 34)

The rulings (§6) keep what O2 and O3 would have removed: `restore` methods
(step B) and `mode: "hard"` on the same client (`removeWhen`). O1 (`deleted`
on every model, no closure) and O8 (no `eligible`) stand.

```ts
// viborm/soft-delete: the entire extension.
import type { ExtendedOperationResult, ExtensionState, PendingOperation,
  VibORMClient, VibORMConfig } from "viborm";
import type { OperationPayload } from "viborm/client"; // public today

export interface SoftDeleteModel {
  readonly deletedAt: string;  // a DateTime field of this model
  readonly deletedBy?: string; // optional scalar field for the actor
}
export interface SoftDeleteConfig {
  readonly models: Readonly<Record<string, SoftDeleteModel>>;
  readonly actor?: string | number | bigint; // bound per derived client
}
type Names<Config extends SoftDeleteConfig> = keyof Config["models"] & string;

// One value per configured model, keys kept: step B types `db.post.restore`
// from them. The cast is TypeScript's own limit: Object.fromEntries forgets keys.
const perModel = <Config extends SoftDeleteConfig, T>(
  config: Config, build: (m: SoftDeleteModel) => T,
) => Object.fromEntries(
  Object.entries(config.models).map(([k, m]) => [k, build(m)]),
) as { readonly [K in Names<Config>]: T };

// restore takes the model's own update arguments, minus `data`; other keys are flagged.
type RestoreArgs<C extends VibORMConfig, K, O extends "update" | "updateMany"> =
  Omit<OperationPayload<O, C["schema"][K & keyof C["schema"]]>, "data">;
type NoExtra<A, R> = A & Record<Exclude<keyof A, keyof R>, never>; // flags data and typos
type RestoreModels<M, C extends VibORMConfig, Config extends SoftDeleteConfig> = {
  readonly [K in Names<Config>]: (delegate: M[K & keyof M]) => {
    restore<A extends RestoreArgs<C, K, "update">>(
      args: NoExtra<A, RestoreArgs<C, K, "update">>,
    ): PendingOperation<ExtendedOperationResult<M, K, "update", A>>;
    restoreMany<A extends RestoreArgs<C, K, "updateMany">>(
      args: NoExtra<A, RestoreArgs<C, K, "updateMany">>,
    ): PendingOperation<ExtendedOperationResult<M, K, "updateMany", A>>;
  };
};

export const softDelete =
  <const Config extends SoftDeleteConfig>(config: Config) =>
  <C extends VibORMConfig, X extends ExtensionState>(base: VibORMClient<C, X>) => {
    // Step A: controls, rows and deletion, checked against base's schema.
    const managed = base.$extends({
      name: "viborm.softDelete",
      controls: { mode: { oneOf: ["soft", "hard"] } }, // deletion places it on managed deletes
      rows: {
        control: "deleted", // the call argument that picks a mode
        default: "without",
        models: perModel(config, ({ deletedAt }) => ({
          without: { root: { [deletedAt]: null }, related: { [deletedAt]: null } },
          with: {},
          only: { root: { [deletedAt]: { not: null } }, related: { [deletedAt]: null } },
        })),
      },
      deletion: {
        removeWhen: { mode: "hard" }, // this call deletes physically
        models: perModel(config, ({ deletedAt, deletedBy }) => ({
          at: deletedAt, // receives the call's one timestamp
          assign: deletedBy ? { [deletedBy]: config.actor ?? null } : {},
        })),
      },
    });
    // Step B: restore methods, typed against the client that carries step A.
    const model: RestoreModels<typeof managed, C, Config> = perModel(config,
      ({ deletedAt, deletedBy }) => (delegate: { update: unknown; updateMany: unknown }) => {
        const data = { [deletedAt]: null, ...(deletedBy ? { [deletedBy]: null } : {}) };
        const update = delegate.update as (args: object) => never;         // one cast
        const updateMany = delegate.updateMany as (args: object) => never; // one cast
        return {
          restore: (args: object) => update({ ...args, data, deleted: "only" }),
          restoreMany: (args: object) => updateMany({ ...args, data, deleted: "only" }),
        };
      });
    return managed.$extends({ name: "viborm.softDelete.restore", model });
  };
```

**Counted:** 75 lines (`wc -l`): 4 blank, 6 comment-only, 65 code-bearing.
Casts: one per generated method and `perModel`'s key map (§2.5); two
`$extends`. **Measured** (P1 item 1, compile-only, DC1 typing): v2's block
compiled generic over `C` from public exports with no other cast, `restore`
narrowed, `defaultOmit` held (1c, 1d, 1f). **Unmeasured:** this block, its
`NoExtra` guard (DC3, §2.5) and any end-to-end run; M1 unit 1 compiles it
held. Use (`post` has `deletedAt: s.dateTime().nullable()`, `deletedById:
s.string().nullable()`):

```ts
const db = softDelete({
  models: { post: { deletedAt: "deletedAt", deletedBy: "deletedById" } },
  actor: session.userId,
})(base);
await db.user.findMany({ include: { posts: true } }); // each user's live posts
await db.post.findMany({ deleted: "only" });          // recycle bin
await db.post.delete({ where: { id: "p1" } });        // tombstones p1, returns it
await db.post.restore({ where: { id: "p1" }, select: { id: true } }); // { id }
// Purge, same client. WARNING (ruling 8): `mode: "hard"` keeps the live
// default. Without `deleted: "only"` this deletes nothing; filtered on
// `createdAt` instead, it deletes old LIVE posts and keeps the tombstones.
await db.post.deleteMany({ where: { deletedAt: { lt: cutoff } },
  deleted: "only", mode: "hard" });
```

Guides print ruling 8's warning beside it (§2.3) and **one actor per
transaction** (ruling 4, measured, v2 §3.6) beside `actor`.

Core derives the rest (`restrict` relations, nested deletes, quantifiers,
counts, the cache key); M1 changes no result type. **Done:** §2's
contracts hold at every scope they name and a third-party fixture reproduces
§1.1 from public exports (witnesses: v2 §6 with the Appendix deltas).

## 2. The capability set after compression

Three members beside the shipped six (AGENTS.md Rule 6 changes after acceptance).

### 2.1 `controls`: arguments an extension declares

```ts
controls: { [name: string]: ({ oneOf: readonly (string | number | boolean)[] }
  | { schema: StandardSchemaV1 }) & { on?: "reads" | "writes" | "all" | readonly Operations[] } }
```

- **Contract.** An optional argument on the operations `on` names, on every
  model, except the control `deletion.removeWhen` names: `deletion` places it
  and it may not say `on` (§2.3, v2 §3.1). Core removes it and admits it once,
  before request patches, memoised with the operation's first preparation
  (`client.ts:569-590`). A patch naming a control is refused; the declaring
  extension's handlers read it in `context.controls`, nobody else sees it
  (measured ledger, P1 item 2). One name space per chain covers `controls`
  keys and `rows.control`; core argument names come from the operation-schema
  owner (DC19). Held values need `as const`, like enum clauses (v2 §3.1).
  Users: the official cache, third parties and soft delete's `mode` (§2.3);
  `rows` declares its own.
- **Errors, derived (was DC5).** A control is an argument, so a bad value is
  a `ValidationError` at its path, as argument validation reports today. Its
  validator is extension code, so an unreadable value or a failing or async
  validator is a `QueryError`, as a failing request transform is; a
  `VibORMError` it throws passes through. No new scheme.
- **One owner per fact.** Declarations: the chain, snapshotted by **new
  application-time code** (the shipped normalization, `definition.ts:225-302`,
  freezes function maps but copies no data; the controls lane added its own,
  `definition.ts:332-420` on `p1-controls`), which also copies a `Date` or
  `Uint8Array` in `assign` (E5). Admitted values: the pending operation's
  admission record, one map by name, handed to query contexts through the
  prepare options (`admitControls`, `request.ts:485` on `p1-controls`).
  Types: the extension state, read by the model delegate (`OperationControls`,
  `controls.ts:270` on `p1-types`), not the payload type (§3 row 1).
- **`cache` (ruling 7).** Declared `cache: { schema, on: "writes" }`;
  `prepareMutationCacheInput` deleted (−103 code lines, measured); pinned test
  re-pinned (`official-cache-invalidation.test.ts:122, :172`, 12/12 measured);
  the cache reads the admitted `cache` by name (P1 §2 flagged the
  per-extension read, `client.ts:649` on `p1-controls`).
- **Cost.** Payload form +3.5-4.3% types, +3.7-4.5% instantiations per client
  program (measured, P1 §4.1), a breach; extension-state form measured only
  in the types lane with DC1 (§2.5), never joined (M1 unit 1). Floor:
  about +14k types, +100k instantiations (review prototype).
- **Amended 2026-09-30 (owner decision): the definition is trusted.** Nothing
  checks `controls`, `rows` or `deletion` at runtime; TypeScript is their only
  check, and a wrong declaration misbehaves at its first call. Gone: the
  hostile-definition boundary for the three members (`copyData`,
  `readGuarded`, `ControlValidator`) and every declaration check
  (`assertControl`; `snapshotRows`' modes, default and field checks;
  `assertRemoveWhen`; `assertDeletionEntry`; the core-argument-name refusal
  with `SchemaRegistry.argumentNames`; the chain's one-name-space and
  one-entry-per-model refusals; the admission of a row predicate through the
  model's `where`, since preparation reads a predicate as written). Kept: the call-time
  admission of every control value, placement, the `rows` and `deletion`
  binding, the cache key, the official-extension admission, the
  duplicate-extension-name check, the `rows` order guard and the types. No
  capability changes.

### 2.2 `rows`: which rows an operation sees

```ts
rows: { control: string; default: string;
  models: { [model: string]: { [mode: string]: { root?: ScalarWhere; related?: ScalarWhere } } } }
```

- **Contract.** `rows` declares its control, placed on every
  candidate-selecting operation (reads, `count`, `aggregate`, `groupBy`,
  `update`, `updateMany`, `upsert`, `delete`, `deleteMany`) of **every**
  model (O1). **Every model entry declares the same mode names, `default`
  among them** (checked at application); those names are the control's
  values, and an absent value means `default`. `root` filters the call's own
  candidates, `related` rows reached through a relation; **an absent
  predicate filters nothing**, so on a model with no entry every mode reads
  as today. Predicates are constant scalar `where` data (rulings 2, 5),
  checked at application, prepared at most once per engine view, model, mode
  and purpose; they AND with each other and the caller's.
- **Not (ruling 2, unchanged):** the read-candidate slice of the §14.2 graph
  policy, same owner; not create, update data, link/unlink, field use, raw
  SQL or statements; never tenant isolation or authorization (docs: v2 §3.3).
- **Owner and invariants.** `rows.ts` computes each mode's row domain (the
  admitted predicate lists) at binding; `chain.ts` stores them, and its frozen
  `rows` declarations are the row identity a cached read's key carries
  (amended at compression C3: the key reads `chain.rows` itself, not a second
  stored copy); the engine prepares each domain at most once per engine view,
  model and purpose (`PreparedDomain`, memoized in `commands/index.ts`);
  `select()` takes the lookup's purpose and reads the domain from its
  `Queries` (amended after U4, U4R-4: prepared meaning belongs to the
  engine's adapter-free `Queries`, never to the extension side). Every lookup is classed root,
  related, premise or never (v2 Appendix A). The related domain lives in
  `Queries.correlation()` (six callers), outside quantifier negation (without
  it 8 of 12 witnesses fail, measured, P1 item 3). A `Queries` is scoped to
  one domain: order terms need no parameter, `page()` and `cursorCondition()`
  take a purpose, `select()` a domain (DC9, measured). The unique-key
  conjunction keeps `uniqueKey`; the RETURNING fast path declines under a
  domain, else a racing soft delete is overwritten, and the loser gets
  `NotFoundError`, the existing race rule (DC10, measured); the `ON CONFLICT`
  fold is gated (DC11, measured). Domain fields enter dependency facts at
  prepare time (P1 item 3). A hidden cursor anchor gives an empty page
  (measured) as a missing one does today, the anchor being a scalar subquery
  (`query.ts:3159-3190`): derived, not a decision (was DC18).
- **Order guard, kept in M1** (v2 §3.6): `rows` after a result consumer is
  refused like `defaultOmit` (`chain.ts:295-300`), so a chain M1 accepts
  stays accepted in M2. **Cost:** Raptor 3 share +443 net code lines
  (measured, P1 §5.2); runtime unmeasured, gated in §5.2.

### 2.3 `deletion`: what a delete does

```ts
deletion: { removeWhen?: { [control: string]: string | number | boolean };
  models: { [model: string]: { at?: string; assign?: ScalarData } } }
```

- **Contract.** Where core deletes a row of a model with an entry (root and
  nested `delete`/`deleteMany`, captured series members), unless the root
  call's admitted controls match `removeWhen`, it issues an update
  with data `assign` plus `{ [at]: callTime }`, admitted per occurrence per
  attempt through `EngineSchema.update(model, data, true)`, which refreshes
  `updatedAt` (#55; `updatedAt` stays its own sample, documented, v2 §3.2).
  The logical operation stays `delete` for observers, errors and hooks; the
  UPDATE carries the caller's attribution. Record and set paths stay distinct
  (E2). Measured (P1 item 5): post-image returned, repeat not-found, a
  statement transform sees `{model: comment, operation: delete}`, captured
  re-admission 0 lines.
- **`removeWhen` (kept, O3).** If the root call's controls match it, the call
  is today's physical delete: no assignment, candidates = caller selector ∧
  call's domain, the database's referential actions; nested occurrences never
  see `mode` (v2 §3.2). **Placement (v2 §3.1):** the control `removeWhen`
  names goes only on `delete`/`deleteMany` of models with a `deletion` entry
  and may not say `on`; `deletion.ts` computes it at binding from the
  `deletion.models` keys and the types read the same keys, a key lookup, not a
  closure, so O1 is untouched. Elsewhere it is refused as an unknown key is
  today, and TypeScript flags it in your editor (`user.delete({ mode: "hard"
  })`, measured under v2's typing, P1 1h). **Purge hazard (ruling 8, v2 §4.7),
  documented, not refused:** `deleteMany({ where: { createdAt: { lt: cutoff }
  }, mode: "hard" })` deletes old **live** rows and keeps the tombstones; a
  purge says `deleted: "only"`.
- **Candidates: a new rule, replacing `eligible`.** A soft delete's candidates
  are caller selector ∧ call's domain ∧ **the model's default domain** (same
  purpose) ∧ referential requirement. A decision, not an invariant: nothing
  checks that `at`/`assign` make the default predicate false (§1.1 does).
  Under the default mode both domains are one predicate, conjoined once,
  removing the spike's `WHERE ((id=? AND deletedAt IS NULL) AND deletedAt IS
  NULL)` (measured, P1 item 5); §1.1's candidates under every mode equal v2's.
  A `deletion` entry with no `rows` entry makes every row eligible, so a
  repeat delete re-stamps instead of giving not-found. Ruling 5's relation
  predicate goes: O8, accepted.
- **Referential requirement (ruling 5).** Incoming `restrict`/`noAction`
  relations (FK and #46 junction keys) are listed at binding; a soft delete is
  refused while a child in the child model's **default** related domain
  exists, with `ForeignKeyError` and a core message (measured on SQLite, P1
  item 7; DC17). A nested `delete` keeps its link, so the parent's own
  membership does not block, as a hard nested delete removes it first (DC13).
- **Timestamp (ruling 6):** once per root call, shared by nested and captured
  occurrences; a replan re-admits with the same instant (DC15, P1 item 6).
- **Checks at application:** `removeWhen` names declared controls and `oneOf`
  values, and those controls say no `on`; `at` names a non-list DateTime
  field; `assign` names scalars, never the `at` field (R6: two values for one
  field); one entry per model per chain; `assign` values copied (E5, §2.1).
  The rest is update admission's (§3 rows 14-17).
- **Verbs and cost.** `NotFoundError(…, "update")` (`commands.ts:1559, 1907,
  1936`) and the `"updateMany"` literals read the verb from the attribution
  the context already carries (`operation-context.ts:503-515`; judgement).
  Four sites plus captured members (measured, P1 item 5; DC12). On
  PostgreSQL/MySQL restrict may need `FOR UPDATE` (DC14, judgement): an M1
  witness, fixed at the lock if it fails.

### 2.4 Keyed cache (ruling 3)

A read that admitted a control value is keyed `[preparedArgs,
canonical(admitted controls)]`, and `[preparedArgs, canonical(admitted
controls), rowIdentity]` when the chain also declares rows; every other read
keeps today's key, byte for byte (DC7 minus its closure clause). Amended after
U2 (U2R-6): since ruling 7 made `cache` a control, "if the chain declares
controls" would have re-keyed every cached read on every cache chain and
broken DC7's byte-identity. A plain control that is absent
is omitted from the key (DC7). The rows control resolves to its mode at
admission, so absent and explicit default share a key (measured: 4 calls, 3
keys); row identity is equal across processes (measured, `cmp` of two runs);
a control value that is not plain data bypasses (measured); statement
transforms keep bypassing. Every model of a rows client is keyed so (O1):
never under-keys, and entries are not shared with the plain client (measured,
P1 item 8). Invalidation unchanged; cross-model staleness equals a hard
delete's today (measured C10-C11, review). `$withCache()` carries extension
state: measured for the payload form only (reverting `CachedClient<…,
X["controls"]>`, `client.ts:394` on `p1-controls`, gives TS2353); the
extension-state form is compiled in M1 unit 1.

### 2.5 Typing (O2 ruling: v2 §3.6 as P1 amended it)

- **Two steps (ruling 4):** `base.$extends(A).$extends(B)`; one definition
  cannot type its factories against its own contributions (measured, v2 §3.6).
  A per-request `softDelete(…)(base)` costs about 11 µs (estimate: two views
  at 5.5 µs per `$extends` view, measured, one noisy run, v2 §3.6).
- **Five client-type changes (DC1; each simpler variant failed, P1 item 1):**
  `$` members in an interface outside the extension-state `Omit` (1a); the
  model map deferred for a generic config (1b); F-bounded `$extends` model
  keys in a per-schema factory table, factories declared as methods, so
  bivariant (1c); the model-factory guard a target shape without conditional
  types (1c). `VibORMClient<C, X>["post"]` becomes TS2536 (plugins write
  `M[K & keyof M]`). **Measured** (types lane as a whole, P1 §4.1; DC1 not
  isolated, DC8): instantiations −2.05% to −12.55% on all six gate programs;
  types +2.33% on client-2, +1.11% on client-3.
- **Two exports:** `ExtensionState` (`methods.ts:43`) and
  `ExtendedOperationResult<Client, Model, Operation, Args>`, which sees the
  extension state `ClientOperationResult` cannot (measured); `RestoreArgs`
  uses the public `OperationPayload`. Measured (1d, 1f) on v2's signature,
  without the guard; re-measured in M1 unit 1: `restore` with `select: { id:
  true }` was exactly `{ id: string }`, `include` narrowed, `db.user.restore`
  was TS2339, a preceding `defaultOmit` was kept.
- **Casts:** one per generated method (a literal is TS2345,
  `types.ts:1150-1176`, measured) and `perModel`'s key map. **DC3 guard:**
  without it, `data` and a misspelt key compile and `data` is silently
  overridden (measured, 1e); with `NoExtra` TypeScript should flag both in
  your editor (unmeasured). **Limit:** the guard reads the schema-only
  payload, so another extension's control on `restore` (the official
  `cache`) is flagged too, where v2 let it through (decided 7; witness in
  M1 unit 1).
- **DC2:** replacing another extension's model method is refused when
  applied, no longer in your editor (core operations, `then`, unknown models
  still are); re-pin `extensions.core.types.ts:704`; the runtime pin stays
  (`extensions-foundation.core.test.ts:587`).
- **DC22, static replay refusal given up:** built for `base` and applied to
  `omitted`, a definition's result shows `secret`, which the runtime omits
  (measured); a plain-function factory restores the refusal and breaks step
  B (TS2345, nine TS2339, measured). §1.1 binds both steps to its receiving
  client, as guides tell plugins to. Runtime owner: the order guard (§2.2,
  `chain.ts:295-300`) refuses the one observable hazard, a result-shaping
  contribution after a result consumer; no replay guard (ruling 4).

## 3. What disappears, what the rulings keep, and why

| # | Removed | Invariant that makes it unnecessary | Evidence |
| --- | --- | --- | --- |
| 1 | Controls typed through the operation payload | The extension state already carries chain facts to the delegate; one type owner | Breach: types +3.53 to +4.25%, instantiations +3.67 to +4.48% (P1 §4.1, DC8) |
| 2 | Second index of admitted controls (`byExtension`), name-keyed cache read | Names are unique per chain: a map by name is complete | `request.ts` on `p1-controls`; P1 §2 |
| 3 | `resolveRowScope` and the spike registry | One admission owner (`admitControls`) | Excluded in P1 §5.2 (33 + 26 lines) |
| 4 | `controls.deleted`, `rows.by`, the rows control's "may not say `on`" rule (kept for the `removeWhen` control, §2.3), the `oneOf`-matches-modes check | The mode names are the control's values: each entry repeats one list, checked equal at application, owned by `rows` | v2 §3.1; DC19 (never built) |
| 5 | "Absent entry = as in the default mode" | An absent predicate filters nothing | v2 §3.3 |
| 6 | `eligible` | **New rule, not an invariant:** a soft delete's candidates are the model's default domain (§2.3); restrict comes from the schema. Ruling 5's relation predicate: O8, accepted | Duplicate predicate, P1 item 5 |
| 7 | Type-level reachability closure | O1 (accepted): types and runtime agree on "every model" | +8.13% / +9.75% instantiations, 47 code lines (P1 item 9) |
| 8 | Runtime closure and the rows control's stored placement, per-root mode subsets | Same; "connected" is the connected component anyway (R002, DC4). `only` on an ungoverned model becomes `without`: O1's cost | 46 code lines (P1 §5.2); `only` on `user` was TS2322 (P1 1g) |
| 9 | **Kept by ruling O2:** DC1's five type changes; `ExtensionState` and `ExtendedOperationResult` exported in M1; DC2, DC3 (guard added), DC22 | Removal rejected: `restore` needs a plugin body generic over the client (§2.5) | Instantiations −2.05 to −12.55% on all six gate programs, types +2.33% (client-2) and +1.11% (client-3), lane as a whole (P1 §4.1); each simpler variant failed (1a-1c); replay refusal lost; replacement check runtime-only; guard unmeasured |
| 10 | **Kept by ruling O2:** step B, `restore`/`restoreMany`, sequential application, three casts | Removal rejected | §1.1 at 75 lines, not 34; two `$extends`; P1 item 1 (1c-1e) |
| 11 | **Kept by ruling O3:** `mode`, `removeWhen`, v2's placement of `mode` on managed deletes only | Removal rejected; ruling 8 stands | One control, one member, one rule; the purge hazard, documented (§2.3, v2 §4.7); `mode` on an unmanaged delete flagged in your editor (P1 1h) |
| 12 | Order rule `defaultOmit` → A → B | `softDelete` applies A then B itself; the rows order guard (§2.2) is the one order users meet: `defaultOmit` after soft delete is refused (P1 1f) | v2 §3.6 |
| 13 | Refusing a callable given to `$extends` | Not needed by any capability; runtime refuses today (`definition.ts:229`) | Review; separate fix if wanted |
| 14 | E7 generated-data portability guard | `assign` is constant data. `keyPortabilityRefusal` runs in `admit` for `update`/`updateMany` (`schema.ts:204-207`) and fires on **any non-array object** in a key field (`schema.ts:276-300`, `value-guards.ts:5`), a `Date` or `Uint8Array` included: row 15's witness covers both | P1 item 5 |
| 15 | DC16's "may not name a key field" | A constant key update is an ordinary `set`, which core performs; no failure it alone owns | `schema.ts:276-300`; judgement |
| 16 | JSON-field refusal in `assign` (E1) | E1 came from the removed `deletedBy` alias; constant JSON data follows update admission (§6, decided) | Never exercised (P1 §2) |
| 17 | `at` must be nullable | Nullability is the rows predicates' business | judgement |
| 18 | Five `Queries` signatures | A `Queries` per domain | DC9, measured |
| 19 | Decisions DC5, DC10, DC14, DC18 | Derived from existing rules (arguments, races, missing anchors) or made a witness | §2.1-2.3 |
| 20 | The driver-cast row of the ownership map | The 11 casts compile unchanged | DC20, P1 1i |

**Kept** (necessary): the purpose census, the key-preserving conjunction, the
fast-path decline, the `ON CONFLICT` gate, the referential requirement, one
timestamp per call, row identity in the key, `$withCache` threading, the R6
check, the E5 copy, the rows order guard, the bypass for non-plain control
values, the `removeWhen` control's placement on managed deletes. **`rows` and
`deletion` stay two capabilities:** rows answers "which rows are candidates"
(read side, per engine view, mode and purpose, in the cache key), deletion
"what a delete does" (write side, per occurrence per attempt, at the command
owners). `at`/`assign` is "an update with fixed data", so its admission is
update admission. Their shared fact, the default domain, has one owner
(`rows`).

## 4. Concept census, before → after

Public concepts: what an extension author or a user learns. Grouping is
judgement; every item is listed so the count can be redone.

| Kind | v2 + P1 | v3 as proposed | v3.1, after the rulings |
| --- | --- | --- | --- |
| Members and options | 14: `controls`, `oneOf`, `schema`, `on`, `context.controls`, `rows`, `rows.by`, `rows.default`, root/related, `deletion`, `at`, `assign`, `eligible`, `removeWhen` | 12: the same minus `rows.by`, `eligible`, `removeWhen`, plus `rows.control` | 13: v3's 12 plus `removeWhen` |
| Soft-delete surface | 5: `deleted`, `mode`, `restore`, `restoreMany`, `actor` | 2: `deleted`, `actor` | 5: as v2 |
| Helpers and casts | 4: `ExtensionState`, `ExtendedOperationResult`, a cast per generated method, `perModel`'s key-map cast | 0 in M1 (`ExtendedOperationResult` in M2) | 5: v2's 4 plus the `RestoreArgs` guard (DC3) |
| Rules | 12: `cache` is a control; absent entry = default mode; A then B; placement by closure; per-root mode subsets; order `defaultOmit` → A → B with its guard; a rows control may not say `on`; `oneOf` matches the modes; unique control names; a purge says `deleted: "only"`; one actor per transaction; held values need `as const` | 11: `cache` is a control; an absent predicate filters nothing; every entry declares the same modes; `deleted` on every model (O1); delete candidates = default domain; restore is an `update` with `deleted: "only"` (O2); a purge through `base` filters tombstones itself (O3); one client per transaction; one name space for `controls` and `rows.control`; `rows` after a result consumer is refused; held values need `as const` | 14: `cache` is a control; an absent predicate filters nothing; every entry declares the same modes; `deleted` on every model (O1); a soft delete's candidates = default domain (O8); A then B; the `removeWhen` control goes only on managed deletes and may not say `on`; a purge says `deleted: "only"`; one actor per transaction; one name space for `controls` and `rows.control`; `rows` after a result consumer is refused; held values need `as const`; a definition binds to its receiving client (DC22); replacing another extension's model method is refused at application, not in your editor (DC2) |
| **Public total** | **35** (29 before the rules were listed) | **25** | **37** |
| Open decisions | 29: DC1-DC22, 4 v2 owner items, 3 P1 extras | 8 (§6), plus 6 decided in this text (§6) | 4 (O4-O7), plus 7 decided in this text; 4 rulings recorded (§6) |
| Acceptance definition | 77 lines, 3 casts, 2 `$extends` | 34 lines, 0 casts, 1 `$extends` | 75 lines, 3 casts, 2 `$extends` |

Like for like (judgement): accepting DC2, DC3 and DC22, as O2 does, puts v2 at
38; v3.1 is that with `rows.control` for `rows.by`, less `eligible`, mode
subsets and the rows-control `on` rule, plus O8's rule and the `removeWhen`
placement rule (stated in v2 §3.1, not listed in v2's census): 37. Internal
mechanisms are not counted (grouping too judgemental; §3 lists what goes).
**M1 size (judgement, from P1 §5's 2,000-2,250):** minus about 130: closures
47 (measured) + 46 (counted); `eligible`, JSON, key checks about 30; mode
subsets about 10; equal-modes check +5. DC1 (types-lane `client.ts` +37/−12,
`methods.ts` +46/−42, `types.ts` +16/−2, measured, DC1 share not isolated) and
v3.1's soft-delete entry, 65 code-bearing lines (v2: 66), counted, stay. About
1,870-2,120 code lines; tests about 4,000 (v3's 3,800 plus the returning
witnesses, Appendix).

## 5. Milestones and exit gates

### 5.1 P0 and M1
P0: the owner takes §6; fresh worktree of main, anchors re-pinned. M1 units:

1. **Joined type and bundle budget, a gate.** Type surface only (DC1, two
   exports, three members, extension-state slot, `cache` through it,
   `$withCache`, `deleted` on every model, `mode` on managed deletes only);
   **§1.1 as it now stands (steps A and B, generic over `C`) compiled held in
   a consumer package from public exports**, use block included (narrowing,
   `defaultOmit`, three casts, no other); **DC3:** `data` and a misspelt key
   flagged in your editor, `restore` with `cache` on a cached chain flagged
   (decided 7), narrowing kept under the guard, and the guard's type and
   instantiation delta without it; the six v2 §7 programs, five alternating
   runs against `30ff17e69`. **Dense program:** `spike/p1-dense/dense.ts` (64
   models, 122 relations) imports the v2 extension and cannot compile at
   `30ff17e69`: rewritten to §1.1's shape, against the same schema and calls
   without extension or `deleted` at `30ff17e69`, so its +3% measures the
   whole feature, not the closure (never measured). **Bundle:** base entry,
   base with extension, `viborm/soft-delete` entry (P1 decision 16). **Stop
   and ask** if §5.2 breaks. Lever then (judgement): the types lane as a whole
   (its measured deltas in §2.5); nothing isolates the interface split (DC8).
2. **Controls runtime and `cache` migration** (controls lane minus §3 row 2;
   re-pins as P1 item 2). 3. **Rows at set scopes** (engine lane on the chain,
   DC9-DC11). 4. **Deletion** (DC12, DC13, timestamp, verbs; PostgreSQL/MySQL
   races, DC14, docker). 5. **Cache key.** 6. **Extension, docs, fixture.**

**Exit, all executed:** every M1 witness on PostgreSQL, MySQL and SQLite
through public entry points; §1.1 run end to end by the fixture; §5.2 holds,
the runtime gate included; an unextended client allocates nothing new, and a
chain without rows or controls keeps today's path; no result type changes;
the framing grep (P1 §2) finds no soft-delete branch; independent review of
the changed perimeter and required gates on frozen source; extensions and
soft-delete guides (v2 §4 in user words; `restore`; the `mode: "hard"` purge
with ruling 8's warning beside it; one actor per transaction beside `actor`;
plugins bind to their receiving client, DC22).

### 5.2 Budgets (v2 §7, compressed)

TypeScript 5.9.3, gate heap 1,280 MB, peak RSS ceiling 1,536 MiB.

| Program | M1 | M2 |
| --- | --- | --- |
| Schema-only floor | ≤ +15k types, ≤ +110k instantiations (basis: +14k/+100k, review) | plus ≤ +30k types (basis: +29,169, review) |
| Each client program | ≤ +3% types and instantiations (judgement) | ≤ +6% types, ≤ +3.5% instantiations (basis: review prototype) |
| Dense program, whole feature (unit 1) | ≤ +3% (judgement; unmeasured comparison) | same as client programs |
| Instrumentation program | ≤ +2% (judgement) | ≤ +4% (basis: +3.7%, review) |
| Peak RSS | median of 5 alternating runs ≤ main + 30 MiB; no run over 1,536 MiB | same |
| Base entry, pg-representative | ≤ +5 KB gzip (O7; basis: each lane about +2.3 KB, P1 §4.3); extension and soft-delete entries recorded | same |

**Runtime gate (v2 §7, restored).** No extension, controls only, rows read,
nested read, single and bulk soft delete, callback transaction, array
transport; alternating fresh processes against main. P1's bench varied 2-3x
(P1 §1), so (judgement) a benchmark gates only once main against main agrees
within 10% of the median over 7 samples; then "no extension" and "controls
only" stay within main's spread, and the rest is recorded for the owner.

A breach is a design signal, never permission to raise a ceiling; large
programs already sit at 91-97% of the gate heap (measured, P1 item 9).

### 5.3 M2: reference scopes (pending O4)

To-one edges in `correlation()`, then `is`/`isNot`, to-one order, upward
recursion; nullable result context per O4; the arm CASE and decoder tell
hidden (null) from missing (corruption; R1 reproduced, P1 item 3);
`ExtendedOperationResult` (exported in M1, §2.5) learns hidden references,
because the schema-only helpers (`OperationResult`, `InferDatabase`,
`renderOperationResultType`) are wrong for rows clients and
`ClientOperationResult` cannot see extension state (measured, v2 §3.4, §3.6).
Exit: v2 §6 M2 rows, §5.2 M2 budgets, per-arm EXISTS cost measured. Publishing
is a separate release.

### 5.4 Stop and revise if

A capability needs a soft-delete branch or an extension-name case in core;
deletion needs a public execution token, copied assignment semantics, repeated
full validation or a second query interpreter; a nested shape reaches a
physical delete of a managed model or bypasses its parent scope; §1.1 needs a
cast beyond its three, or a type disagrees with the runtime beyond DC22's
replay case and the refusals recorded as application-only (DC2, decided 2-3);
a §5.2 budget breaks; the scope changes (authorization, cross-model
invalidation).

## 6. Owner decisions

**Recorded rulings (Arnaud, 2026-10-01, `rulings.md`), costs accepted.**

- **O1 accepted:** `deleted` on every model, no closure (ruling 9 withdrawn).
  Costs: `only` on a model with no `rows` entry acts as `without`; base and
  derived clients share no cache entries (never a wrong one, P1 item 8).
- **O2 rejected:** `restore`/`restoreMany` stay. Costs (§2.5, §3 rows 9-10),
  measured in P1 unless marked: five changes to how the client type is built;
  TypeScript stops flagging an extension built for one client applied to
  another (the result then shows a field the runtime omits) and a later
  extension replacing an earlier one's model method (the runtime still
  refuses it); two exported helper types, three casts, two steps (A then B),
  §1.1 at 75 lines; and an extra guard so that TypeScript flags `data` or a
  misspelt key on `restore` (unmeasured), which also flags another
  extension's control there (decided 7).
- **O3 rejected:** `mode: "hard"` stays (`removeWhen`), same client and
  transaction; ruling 8 stands: no refusal, the warning by the example.
- **O8 accepted:** no `eligible`; soft-delete candidates are the default
  domain, restrict comes from the schema (ruling 5's relation predicate
  withdrawn), a `deletion` entry without `rows` makes every row eligible.

**Open, as v3 stated them.** O6 and O7 block M1; O5 confirms; O4 blocks only M2.

**O4. Nullable references in M2 (ruling 1: per-target), asked once more,
not before M2.** Per-target adds 29,169 types (+3.8%) to the schema-only
floor, paid by every program even without an extension; "every to-one is
nullable on a soft-delete client" adds 232 (both measured, review). P1 showed
the type budget binds everywhere. Keep per-target, or the simple rule?

**O5.** Confirm v2 §4.6 (a): `set` over a required foreign key keeps today's
refusal ("Delete them instead"), with no soft delete there (assumed in P1 and
held, `set-cleanup.test.ts`, P1 §2).

**O6. The `cache` changes to announce.** Of DC6's eight, four break users:
patches can no longer inject or replace `cache`; request handlers no longer
see it; an unreadable `cache` getter raises `QueryError`, not
`CacheConfigurationError`; an invalid `cache` fails before request handlers,
and a throwing request transform no longer stops `cache` from being read.
Two are additions (`cache()` and query contexts gain `controls`). Two likely
go (judgement): `Client`'s third type parameter changed only for the payload
form (§3 row 1); the message can keep naming the operation.

**O7. Budgets:** accept §5.2, including the bundle line, the dense program
measured as the whole feature, and the runtime gate's stability rule.

**Decided in this text** (say so to reopen): (1) JSON actor field: constant
JSON follows update admission, so with no `actor` a JSON `deletedBy` gets
JSON `null` (judgement), where v2 refused it (P1 decision 15). (2) Wrong
field names in `rows`/`deletion` are refused when the extension is applied,
naming model and field; TypeScript does not flag them in your editor (v2
§3.2). (3) Marker and actor on one field (R6): refused at application only.
(4) An upsert losing a race to a soft delete gets `NotFoundError` (DC10; the
create-arm alternative costs a replan, unmeasured). (5) A nested `delete`
excludes the parent's own link (DC13; the alternative refused the call).
(6) Every entry declares the same modes (§2.2), not a union. (7) `restore`
takes the model's own update arguments only, so TypeScript flags another
extension's control on it (the official `cache`, say) in your editor, where
v2's unguarded signature passed it on to `update` (judgement: the DC3 guard
reads the schema-only payload; letting controls through needs an exported
per-operation controls type, one more public helper).

## Appendix: where the detail lives

- **v2 plan:** §4 soft-delete semantics (operation matrix, nested writes,
  referential table, timestamps, unique keys, adopter checklist,
  non-coverage), valid with §3's removals (rows 1-8, 12-20; `restore`, `mode:
  "hard"` and §4.7's hazard stand as written); §6 witness matrix; §8.1
  ownership map; Appendix A census, with DC12's correction: the nested
  `Deletion` placement gains values and updates by identity
  (`execution.ts:1079`), so a lax `delete: true` over an empty slot stays a
  no-op.
- **Witness deltas vs v2 §6.** Drop: placement, `only` on ungoverned roots,
  callable refusal, JSON-field, `at`-nullable, `eligible` and `by` validation;
  "replay refused" becomes "replay compiles, documented" (DC22). Keep:
  sequential typing (narrowing, `defaultOmit`, three casts), `mode` rows
  (flagged in your editor on an unmanaged delete, P1 1h), `removeWhen`
  validation; rows after a result consumer refused; an `assign` `Date` mutated
  after binding changes nothing (E5). Add: §1.1 compiles held and runs; DC3
  flags `data` and a misspelt key; `deleted` on an unconnected model is a
  no-op, `only` on a connected ungoverned one equals `without`; `restore` with
  `cache` on a cached chain flagged (decided 7); unequal mode sets and a
  `rows.control` equal to a `controls` name refused; deletion without rows
  re-stamps on repeat; both purge hazards (§1.1, documented); `assign` on a
  DateTime and a bytes key behaves as the equal `update`; DC13;
  PostgreSQL/MySQL restrict and upsert races (DC14, DC10); per-attempt
  re-admission, one instant (DC15); unextended key byte-identical (DC7),
  nothing new allocated.
- **P1 report:** verdicts and commands (§1), framing grep (§2), DC1-DC22 (§3),
  type and bundle tables (§4), line estimate (§5); lanes `p1-types`,
  `p1-controls`, `p1-engine` and `scratchpad/softdelete/p1/` are read-only
  evidence. **Executing review:** floor costs, one-bit rule, 5.5 µs per
  derived view, correlation placement.
