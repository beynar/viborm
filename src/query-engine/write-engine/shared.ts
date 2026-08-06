import { TransactionError } from "@errors";
import type { Model } from "@schema/model";
import { isSql } from "@sql";
import { partitionWhereUnique } from "../builders/where-unique-builder";
import {
  createChildScope,
  getRelationInfo,
  getTableName,
} from "../context/query-scope";
import type { QueryEngine } from "../query-engine";
import { getForeignKeyTargetFields } from "../TargetConstraint";
import type { QueryScope } from "../types";
import type {
  FinalReferenceSource,
  ForeignKeyMember,
} from "./foreign-key-reference";
import type { TargetConstraintPin } from "./OperationFragment";
import type { StepScope } from "./StepScope";

/**
 * X1c — how a nested UPDATE target (a to-many / inverse-to-one child, or a
 * parent-held to-one) whose data carries a mechanism the child-Part builder cannot
 * fold in place — a **parent-held to-one write** (its identity folded into the
 * target's OWN update SET — child-SET folding) or a **non-PK / compound referenced
 * edge** (D4) — is located and correlated by the delegated {@link UpdateOperation}.
 * The correlation is the ONE piece the located-target reuse adds over `nestedFresh`
 * (a fresh create needs no locate): the target is verified to belong to the
 * enclosing parent by `child.<childFields[i]> = parent.<parentFields[i]>` (a SQL
 * `Ref` to the enclosing locate for a `planned` parent — technique #1 — or an
 * inlined literal), ANDed with the target's own unique `where` when it has one (a
 * child-held to-many `update`; a to-one / parent-held target locates by correlation
 * alone). A located miss is the target's own `Cannot … relation` not-found, not the
 * root not-found.
 */
export interface NestedTargetLocate {
  /** The target's unique selector (child-held to-many `update`); absent for a
   *  to-one / parent-held target located by correlation alone. */
  readonly where?: Record<string, unknown>;
  /** The enclosing parent's id — a `planned` locate (a SQL `Ref`) or a compile-time
   *  literal (a depth-composed literal-parent target). */
  readonly parentId: FinalReferenceSource;
  /** The target's correlation columns (child-held: its FK; parent-held: the columns
   *  the parent's FK references), index-aligned with {@link parentFields}. */
  readonly childFields: readonly string[];
  /** The enclosing parent's columns the correlation reads (child-held: the parent's
   *  referenced columns; parent-held: the parent's FK columns). */
  readonly parentFields: readonly string[];
  /** M1 — the FINAL value of a {@link parentFields} column the SAME enclosing update
   *  rebinds to a literal, keyed by that column's name. The parent-held twin that folds
   *  in place has always correlated on the POST-SET FK value ("the parent's FK value is
   *  its FINAL value"); this is the delegated path's channel for the same contract. A
   *  column named here overrides the locate row for BOTH consumers (the correlated
   *  locate and the batch presence guard); an unnamed one reads the located row, which
   *  stays the only source for a column this update does not touch. Without it the
   *  delegated sub-op would locate — and mutate — the row the parent is moving away
   *  from, with the presence guard confirming that same stale row. */
  readonly parentFieldOverride?: Readonly<Record<string, unknown>>;
  /** W4-U3 — the to-one `update: { where, data }` wrapper's NON-unique filter on the
   *  currently connected record. ANDed into the locate (and the batch presence guard)
   *  alongside the correlation: a connected row that fails it makes the locate empty,
   *  so the target's own not-found fires and the whole operation aborts atomically,
   *  state unchanged. Absent for the bare `update: <data>` spelling — then the locate
   *  is byte-identical to pre-W4-U3. Never compiled into the WRITE (which addresses
   *  the captured primary key), so a relation filter here is portable. */
  readonly filter?: Record<string, unknown>;
  readonly relationName: string;
  /** V1's byte-identical `Cannot … relation … for this parent` not-found message
   *  the enclosing caller sources from `relationTargetNotFound(info, "update")`. */
  readonly notFoundMessage: string;
}

/**
 * How a root operation is reused as one arm of a composing operation (T3c — the
 * top-level `upsert`'s create/update arms compose the create-root / update-root
 * machinery, TO-ONE.md §7.8). A `CreateOperation`/`UpdateOperation` constructed
 * with these options is NOT a standalone operation: it shares the enclosing
 * operation's {@link StepScope} (so no two arms collide on a step id), and it
 * defers the analyses the enclosing operation must run **per-arm** — V1's upsert
 * runs the own-write barrier inside the taken branch only, so a violation in an
 * un-taken arm must not reject the whole tree (`skipOwnWrite` hands that timing to
 * the caller). The absent-row postcondition is dropped for the update arm
 * (`locateNotFoundOptional`): under an upsert a located-miss is the CREATE
 * decision, not a not-found error.
 */
export interface SubOperationOptions {
  /** Share the enclosing operation's id allocator instead of minting a fresh one. */
  readonly scope?: StepScope;
  /** Skip the constructor own-write preflight; the caller runs it per-arm (deferred). */
  readonly skipOwnWrite?: boolean;
  /** Reuse a caller-owned target read and root write. */
  readonly selectedTargetReadId?: string;
  readonly selectedWriteId?: string;
  /** Drop the locate's exactly-one-row postcondition (upsert: absent → create arm). */
  readonly locateNotFoundOptional?: boolean;
  /**
   * Skip the constructor payload-legality analyses (whole-args validation, PK-arithmetic
   * portability, relation-key-update legality) and expose them as a method the caller runs
   * per-arm. V1's upsert validates its update branch INSIDE the whenTrue branch only — an
   * invalid UNTAKEN update branch (the create arm is taken) must not reject the whole tree.
   */
  readonly deferArmLegality?: boolean;
  /**
   * X1b — a nested fresh `create` at DEPTH: this `CreateOperation` is not a standalone
   * operation but a create SUBTREE spliced under a located target's write (a nested
   * `create` arm one or more levels deep). It carries the ALREADY-VALIDATED create data
   * (`data` — the enclosing operation's whole-args parse validated the whole tree, so this
   * subtree does NOT re-parse; re-parsing a schema's transformed output is non-idempotent,
   * X2). It emits NO terminal read (the enclosing operation owns the result), and it folds
   * field-bound incoming foreign-key members into its ROOT record's INSERT. Every
   * mechanism the create ROOT already
   * supports — a database-generated / compound PK (backward `Ref` / per-field identity),
   * a parent-held-FK to-one grandchild (before-parent create), the fresh-parent adopt
   * family and M2M — falls out unchanged, one architecture, at any depth.
   */
  readonly nestedFresh?: {
    readonly data: Record<string, unknown>;
    readonly incomingForeignKey: readonly ForeignKeyMember[];
    readonly relationName: string;
    /**
     * N4-U2 — the raceable missing-premise pin of an enclosing adopt arm. A nested
     * `upsert`/`connectOrCreate` whose probe found nothing takes its CREATE arm, and
     * that arm's missing premise is enforced by the fresh row's own unique constraint
     * (the Pin Rule, `whenMissing: "constraint"`): a concurrent writer that created
     * the row between the probe and the write makes this INSERT violate the pinned
     * unique, which is the raceable signal `race-retry.ts` matches. When the arm's
     * payload carries relations the whole arm is this create SUBTREE, so the pin has
     * to ride the subtree's ROOT record INSERT — the one statement that used to be
     * the arm's own leaf. Absent for every other `nestedFresh` caller (a nested
     * `create` is unconditional: its violation is a genuine error, never a race).
     */
    readonly rootRacePin?: TargetConstraintPin;
  };
  /**
   * X1c — a nested UPDATE target at DEPTH whose data carries the located-target
   * projection of mechanism 1/2 (a parent-held to-one write needing child-SET
   * folding, or a non-PK / compound referenced edge — D4) is not folded in place by
   * the child-Part builder; the whole target UPDATE delegates to this operation, the
   * update-root analogue of `nestedFresh`. It carries the ALREADY-PARSED update
   * `data` — the enclosing operation's relation-schema parse produced it, and that
   * schema IS this target's `core.update`, so every scalar SET and relation payload
   * below is already in post-transform form and NOTHING here parses again (a
   * transform is not idempotent: a JSON write's `{ set: … }` envelope is itself a
   * legal JSON document, so a second pass persists the ORM's envelope as the user's
   * data). It emits NO terminal read (the enclosing op owns the result), it shares the
   * enclosing `StepScope`, and it LOCATES + CORRELATES the target to its enclosing
   * parent ({@link NestedTargetLocate}). Every mechanism the update ROOT already
   * carries — a parent-held to-one before-root write folded into the SET, a
   * generated / D4 referenced identity threaded from the located row, the PK-transition
   * reorder, the child-held / m2m families — falls out unchanged, one architecture,
   * at any depth.
   */
  readonly nestedTarget?: {
    readonly data: Record<string, unknown>;
    readonly locate: NestedTargetLocate;
    readonly targetReadId?: string;
    readonly writeId?: string;
  };
  /** Field-bound assignments derived by the relation owner after user scalar data. */
  readonly incomingForeignKey?: readonly ForeignKeyMember[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Does this `select` project a RELATION rather than scalars alone?
 *
 * Two keys spell one projection and both are it: a relation key, and `_count` — a
 * relation-derived projection built by the same correlated-subquery machinery, and
 * NOT a member of `relationSet`.
 *
 * One home (X2), because four fold gates ask it and must answer alike:
 * `CreateOperation.foldStep`, `UpdateOperation.directWrite`,
 * `UpsertOperation.canFoldUpdateArm` and `DeleteOperation.foldStep`. Each folds its
 * operation into ONE `… RETURNING <select>` statement, and **a relation subquery in
 * a RETURNING list has no table alias to correlate against**: its outer column
 * reference is emitted bare and binds by NAME, so the inner table captures it
 * whenever both tables carry a column of that name. This is the identical defect
 * `restrictToScalarProjection` (`validation/model/args/bulk-write-projection.ts`)
 * refuses outright on bulk writes.
 *
 * Measured on PGlite (PG 17) and better-sqlite3 3.51, an `author` with three `post`
 * children and a `post` table that has its own `id`, `findUnique` as the control:
 *
 *   findUnique({ select: { id, _count: { select: { posts } } } })   -> { posts: 3 }
 *   delete    (same select, folded)                                 -> { posts: 0 }
 *   update    (same select, folded)                                 -> { posts: 0 }
 *   create    (pure scalar, folded, one child row whose own id equals
 *              its FK)                                              -> { posts: 1 }, truth 0
 *
 * The correlation degrades to `post.id = post.authorId`, so the answer is not even
 * reliably empty — it counts whatever the captured name happens to make true, which
 * is why a child table without an `id` column would have looked correct. Answer "yes,
 * a relation" here and the gate declines the fold; the unfolded path reads the
 * projection through an aliased SELECT, which correlates and answers the truth.
 */
export function selectProjectsRelation(
  model: Model<any>,
  select: Readonly<Record<string, unknown>> | undefined
): boolean {
  if (!select) return false;
  return Object.keys(select).some(
    (key) => key === "_count" || model["~"].relationSet.has(key)
  );
}

/**
 * THE whole-projection question, in one place: does this result shape name NO
 * relation at all?
 *
 * A projection names a relation through EITHER half — a relation (or `_count`)
 * key inside `select`, or an `include` at all — and the two halves are not
 * interchangeable. Every caller that needs "scalars only" needs both, so the
 * conjunction lives here rather than being re-spelled at each site: the four
 * mutation operations were each writing `!selectProjectsRelation(…) &&
 * !parsedInclude` in their fold gates, and `DeleteOperation`'s terminal read
 * asked the SAME question with the `!parsedInclude` half alone. That half is a
 * proxy, not the invariant: a relation nested in `select` slipped past it and the
 * read emitted a LATERAL join under `FOR UPDATE`, which PostgreSQL rejects with
 * 0A000 — the delete crashed. One spelling, so a caller cannot hold a correct
 * expression of this invariant at one site and a wrong proxy for it at another.
 */
export function projectionNamesNoRelation(
  model: Model<any>,
  select: Readonly<Record<string, unknown>> | undefined,
  include: Readonly<Record<string, unknown>> | undefined
): boolean {
  if (include) return false;
  return !selectProjectsRelation(model, select);
}

/**
 * PHASE 8.1, INVARIANT 1 — does this projection read the table the statement is
 * MUTATING?
 *
 * In PostgreSQL every sub-statement of one command sees the same snapshot, so
 * the `SELECT` on the outer side of `WITH u AS (UPDATE … RETURNING *) SELECT …`
 * reads every table as it stood BEFORE the statement. The mutated row is the one
 * exception: it arrives through `u`, post-mutation, out of `RETURNING`. Any
 * OTHER row of that same table is read stale.
 *
 * A projection that never reaches the mutated model therefore reads only
 * untouched tables and answers exactly what the unfolded terminal read answers.
 * One that does — a self-relation (`employee.manager`, `category.parent`) — can
 * address the mutated row itself and would hand back its pre-mutation shape, so
 * the fold declines. Walks the whole projection, at every depth, because a
 * self-relation two levels down reads the same table a top-level one does.
 *
 * ### The walk is over the WHOLE payload, not over `select`/`include` alone
 *
 * This first shipped walking each relation payload's `select` and `include` and
 * nothing else, which is a hole, because a relation payload's `where` compiles
 * to a correlated subquery that reads a table — and when that table is the
 * mutated one, the folded answer is filtered on the PRE-statement value.
 * MEASURED on PGlite against the same update run with the fold forced off
 * (`acct` 1-N `memo`; every `acct` starts at tier `T`; memos 10 and 11 belong to
 * acct 3):
 *
 *   update({ where: { id: 3 }, data: { tier: "gold" },
 *            include: { memos: { where: { acct: { tier: "gold" } } } } })
 *     folded -> memos: []           unfolded -> memos: [10, 11]
 *   …the same update with the filter on the OLD value (`tier: "T"`)
 *     folded -> memos: [10, 11]     unfolded -> memos: []
 *
 * Symmetric in both directions: the folded arm filtered on the pre-update tier.
 * `_count: { select: { memos: { where: … } } }` answered 0 against 2 the same
 * way, and `orderBy` / `cursor` reach a table by the identical mechanism.
 *
 * So the walk asks the question the invariant actually asks — *can any read this
 * payload compiles to land on the mutated table* — of EVERY key, at every depth,
 * and it needs no list of which payload keys carry a read. A key that names a
 * relation of the current model moves the scope to that relation's target; every
 * other key (`where`, `orderBy`, `cursor`, `_count`, `AND`/`OR`/`NOT`,
 * `some`/`every`/`none`, `is`/`isNot`, an operator envelope, an array element)
 * keeps the scope and is walked through, so a relation named anywhere under it
 * is found wherever it sits.
 *
 * It over-approximates in one direction only, which costs a statement and never
 * an answer: a literal inside a JSON-column filter whose own key happens to
 * spell a relation name (`where: { meta: { equals: { memos: 1 } } }`) is read as
 * a relation traversal and declines a fold that would have been legal.
 *
 * `_count` gets NO case of its own, and that is measured rather than assumed.
 * The shorthand `_count: true` never arrives here — `CountSchema`
 * (`validation/model/core/select.ts`) coerces it to `{ select: { <every to-many
 * relation>: true } }` at the parse boundary, so what this walks is the object
 * form, whose relation names sit under `select`, one scope-preserving hop down.
 * And a `_count` that is NOT that object form reads nothing to guard: the
 * projection builder emits a count only when `_count.select` is a record
 * (`select-builder.ts` — `buildCountPairs` is reached through that test alone),
 * and it is the SAME builder on the folded and the unfolded path, so both answer
 * without the key. A guard for `_count: true` here therefore declines folds that
 * are legal and covers nothing — removing it leaves the `_count` shorthand
 * witness below green, which is what says the coverage was not its own.
 */
export function projectionReadsMutatedModel(
  scope: QueryScope,
  select: Readonly<Record<string, unknown>> | undefined,
  include: Readonly<Record<string, unknown>> | undefined
): boolean {
  const table = getTableName(scope.model);
  return (
    payloadReachesTable(scope, select, table) ||
    payloadReachesTable(scope, include, table)
  );
}

function payloadReachesTable(
  scope: QueryScope,
  value: unknown,
  table: string
): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => payloadReachesTable(scope, entry, table));
  }
  if (!isRecord(value)) return false;
  for (const [key, entry] of Object.entries(value)) {
    // A key that projects nothing and filters nothing reads nothing. `null` is
    // NOT in this set: `where: { manager: null }` is a to-one absence filter,
    // which reads the related table to establish the absence.
    if (entry === false || entry === undefined) continue;
    const relation = getRelationInfo(scope, key);
    if (relation) {
      if (getTableName(relation.targetModel) === table) return true;
      const child = createChildScope(
        scope,
        relation.targetModel,
        scope.rootAlias
      );
      if (payloadReachesTable(child, entry, table)) return true;
      continue;
    }
    if (payloadReachesTable(scope, entry, table)) return true;
  }
  return false;
}

/**
 * PHASE 8.1, INVARIANT 2 — can this `SET` fire a referential action?
 *
 * `ON UPDATE CASCADE` / `SET NULL` / `SET DEFAULT` rewrite rows in a CHILD table
 * as part of the same statement. The outer `SELECT` of the fold reads that table
 * from the pre-statement snapshot, so it would hand back the children as they
 * were before the cascade — where the unfolded terminal read, running after the
 * `UPDATE`, sees them after it. That is a wrong answer, not a slower one.
 *
 * A foreign key may only point at a UNIQUE column set, so a `SET` that rewrites
 * no unique-participating field can fire no action at all. That is the test, and
 * `getForeignKeyTargetFields` is the one home for which column sets those are.
 * It asks a WIDER question than `getTargetIdentityFields`, deliberately: a
 * `whereUnique` can only address a declared unique CONSTRAINT, but PostgreSQL
 * (and MySQL) accept a unique INDEX as an FK target too, and viborm's migration
 * driver emits `.index([...], { unique: true })` as exactly that. Asking the
 * narrower question here was a hole — `update({ data: { code } })` on a model
 * whose `code` is a unique index cascaded into the child table mid-statement and
 * the folded arm answered with the pre-cascade children, i.e. an EMPTY list.
 *
 * It over-approximates in one direction only — a unique column that NOTHING
 * references declines a fold that would have been legal — which costs a
 * statement, never an answer. Deciding it exactly would mean scanning every
 * model in the schema for an inbound reference, and the mainstream `update`
 * rewrites ordinary scalars.
 */
export function setCanFireReferentialAction(
  model: Model<any>,
  set: Readonly<Record<string, unknown>>
): boolean {
  return getForeignKeyTargetFields(model).some((field) =>
    Object.hasOwn(set, field)
  );
}

/**
 * Whether a referenced-key transition is a NO-OP — an `increment: 0` or a `set` to the
 * value the key already carries. The SET writes something, but the key does not MOVE, so
 * no slot is vacated, no child is stranded, and the ordinary parts hold unchanged: no
 * occupied guard, no post-transition ordering, no reorder.
 *
 * One home (X2), because two levels ask it of the same payload and must answer alike:
 * the ROOT's `interpretReferencedKeyTransition` ({@link UpdateOperation}, whose
 * `{ regime: "none" }` this decides) and the nested update TARGET's
 * `interpretChildParts` ({@link RelationWritePart}, deciding whether its own primary key
 * transitions at all). Split, the root accepted a same-value SET on an occupied relation
 * — pinned by `relation-key-update-legality.test.ts` — while depth rejected it with a
 * message asserting a transition that is not happening.
 *
 * Both operands are compile-time literals (the where-pinned pre-value and
 * `getUpdatedPrimaryKeyValue`), so an int/bigint/string key compares by value and a Date
 * by instant.
 */
export function sameScalarValue(before: unknown, after: unknown): boolean {
  if (before instanceof Date && after instanceof Date) {
    return before.getTime() === after.getTime();
  }
  if (typeof before === typeof after) return before === after;
  // Cross-type numeric identity. From the public client this branch is UNREACHABLE, and
  // that — not the exactness of `String()` — is what makes the string compare safe. The
  // typed parse boundary refuses a number wherever a bigInt field is addressed and a
  // bigint wherever an int field is addressed, in `where` and in `data` alike, so the
  // field's declared type governs BOTH operands and they arrive the same type. Measured
  // on PGlite against `s.bigInt().id()`: `where: { id: 42 }` → "ValidationError:
  // Validation failed for update: Expected bigint"; `data: { id: 42 }` → "… Expected
  // bigint, Expected object"; `data: { id: { increment: 0 } }` → "… Expected bigint,
  // Expected bigint" — and the int model mirrors it for a bigint literal. The arithmetic
  // route is closed twice over: `toBigInt` (`mutation-identity.ts`) converts a number
  // only when `Number.isSafeInteger`, and every safe integer stringifies to its exact
  // decimal, so String() there answers what BigInt() would.
  //
  // `String()` is NOT exact in general — it prints the SHORTEST round-tripping decimal.
  // `String(18014398509481992)` is "18014398509481990" while `String(18014398509481992n)`
  // is "…992", and 2^54+8 is well inside an int64 key (this client stores it as a
  // `s.bigInt().id()` on PG and SQLite). So if the parse boundary is ever loosened to
  // accept numbers for bigInt fields, a `set` at an unsafe magnitude reaches here as a
  // divergent pair and this compare must become `BigInt(before) === after`: otherwise a
  // same-value SET reads as a TRANSITION and fires an occupied guard the root does not.
  if (
    (typeof before === "bigint" || typeof before === "number") &&
    (typeof after === "bigint" || typeof after === "number")
  ) {
    return String(before) === String(after);
  }
  return false;
}

/**
 * Can this create-data value address the written row in a compile-time `where`?
 *
 * A NULL never can: SQL unique constraints do not equate NULLs, so a nullable
 * unique the create data sets to null names no row. Neither can a value the engine
 * resolves later (raw `Sql`, a batch-value reference — what a later statement
 * compares against need not be what the INSERT wrote), nor a structured value (a
 * list, a JSON object): those are not columns a unique constraint of this schema
 * spans, and equality on them is dialect business. Everything else — strings,
 * numbers, bigints, booleans, `Date`, `Decimal`, byte arrays — is the literal the
 * INSERT writes verbatim.
 */
function isAddressableLiteral(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (isSql(value) || Array.isArray(value)) {
    return false;
  }
  if (typeof value !== "object") return true;
  const prototype = Object.getPrototypeOf(value);
  return !(prototype === Object.prototype || prototype === null);
}

/**
 * The `whereUnique` for a COMPLETE unique constraint of `model` whose every column
 * `createData` supplies as an addressable literal — **W4's create-data-unique
 * identity source**: a create arm whose payload spells a whole unique NAMES the row
 * it is about to insert, at compile time, without reading anything back. Single-column
 * `.unique()`s first (declaration order), then compound uniques; `undefined` when none
 * is complete.
 *
 * `state.uniques` is the model's single-column unique/id scalars, so a compound PK's
 * members never appear there individually — half a compound key is a filter, never an
 * identity.
 *
 * One home (X2): the root `upsert`'s create arm ({@link UpsertOperation}) and the
 * junction upsert's create arm ({@link RelationJunctionPart}) ask the same question of
 * the same payload, so they ask it here. The two differ only in what they DO with the
 * answer — a read-back `where` there, a dedup-ledger key plus a duplicate-item UPDATE
 * `where` here.
 */
export function createDataUniqueWhere(
  model: Model<any>,
  createData: Record<string, unknown>
): Record<string, unknown> | undefined {
  const state = model["~"].state;
  for (const field of Object.keys(state.uniques)) {
    const value = createData[field];
    if (isAddressableLiteral(value)) return { [field]: value };
  }
  // Each compound unique is an ObjectSchema whose `entries` are its columns — the
  // same shape `where-unique-builder` reads to compile a compound selector.
  const compoundUniques: Record<string, { entries: Record<string, unknown> }> =
    state.compoundUniques ?? {};
  for (const [name, constraint] of Object.entries(compoundUniques)) {
    const fields = Object.keys(constraint.entries);
    if (fields.length === 0) continue;
    const values: Record<string, unknown> = {};
    let complete = true;
    for (const field of fields) {
      const value = createData[field];
      if (!isAddressableLiteral(value)) {
        complete = false;
        break;
      }
      values[field] = value;
    }
    if (complete) return { [name]: values };
  }
  return undefined;
}

/**
 * A nested target selector, as CONJUNCTS for a locate or a guard: the unique
 * discriminator flattened to one equality per constrained column, plus — since
 * N6-U1 — the extended selector's non-unique FILTER half appended whole.
 *
 * One home, because four seams address "the row the caller named" and must address
 * the SAME row: `RelationWritePart`'s correlated probe and batch guard,
 * `RelationUpsertPart`'s found guard, `RelationJunctionPart`'s captured-selector
 * guard, and the nested-target delegation's locate + guard ({@link
 * NestedTargetLocate}). Before N6-U1 each built the list itself from
 * `getWhereUniqueEntries`; that was complete only while a nested selector was
 * unique-only, and the day the selectors widened, the two that were NOT updated
 * silently dropped the filter half — an excluding filter still wrote (measured: a
 * nested `update` whose filter excluded its target renamed it anyway, and a nested
 * `delete` removed it). A dropped predicate is not a refusal, it is the WRONG ROW,
 * so the assembly lives here rather than at each seam.
 *
 * The split is the module contract of `where-unique-builder`: the discriminator is
 * the only half anything compile-time may read (pins, `racePin` attribution,
 * identity), and the filter half can only ever NARROW which row is addressed. Both
 * halves belong in a locate; only the first may name a value.
 */
export function uniqueSelectorConjuncts(
  scope: { model: Model<any> },
  where: Record<string, unknown>
): Record<string, unknown>[] {
  const { entries, filters } = partitionWhereUnique(scope, where);
  const conjuncts: Record<string, unknown>[] = entries.map(
    ({ fieldName, value }) => ({ [fieldName]: { equals: value } })
  );
  if (filters) conjuncts.push(filters);
  return conjuncts;
}

export type ExecutionMode = "transaction" | "batch";

/**
 * Pick the compile-time execution substrate from driver capability. A driver
 * with neither substrate gets the nominal `"transaction"` mode rather than a
 * throw here: a **single-statement** operation (a read, a scalar bulk write)
 * runs directly with no atomic envelope on any driver (V1's statement-atomicity),
 * so it must be constructible. The executor enforces the capability requirement
 * for a **multi-statement** operation, failing closed with V1's byte-identical
 * {@link TransactionError} (see `OperationExecutor.execute`).
 */
export function selectExecutionMode(
  engine: QueryEngine,
  _operation: string
): ExecutionMode {
  if (engine.driver.supportsBatch && !engine.driver.supportsTransactions) {
    return "batch";
  }
  return "transaction";
}

/**
 * V1's byte-identical "no atomic substrate" failure, raised by the executor when
 * a multi-statement operation cannot run (a single-statement one runs directly).
 */
export function noAtomicSubstrateError(
  driverName: string,
  operation: string
): TransactionError {
  return new TransactionError(
    `Driver '${driverName}' supports neither transactions nor atomic batch execution.`,
    { meta: { driver: driverName, operation } }
  );
}

/**
 * Thrown by a concrete operation's constructor when the requested payload shape is
 * outside V2's supported family (a wrong argument key, an unsupported relation kind, a
 * compound key or a non-literal fold at a documented boundary, …). **Post-P6 there is no V1
 * and no fallback:** this error PROPAGATES as a typed refusal — the pre-P6 framing (the P2a
 * proxy switched on it to "let V1 handle this whole tree") describes a mechanism deleted at
 * P6. Every shape that raises it is either a PARITY REFUSAL V1 also rejected, or a DOCUMENTED
 * narrower boundary reached by no conformance scenario (route-inventory category iii); the
 * decline-surface gate proves no accept-and-execute shape raises it. Any other construction
 * error (a `ValidationError` from the parse boundary, the own-write preflight rejection) is a
 * real failure the schema / preflight raises and likewise propagates.
 *
 * The class itself lives in `src/errors/query.ts` (public surface: its own
 * `diagnosticName` and `V8003 UNSUPPORTED_OPERATION` code, exported from the
 * package root so users can `instanceof` a deliberate capability boundary
 * instead of seeing a `V9001` engine crash); re-exported here so every engine
 * throw site and test keeps one import home.
 */
export { UnsupportedOperationError } from "@errors";

export function getStepModelName(model: Model<any>, fallback: string): string {
  return model["~"].names.ts ?? model["~"].names.sql ?? fallback;
}
