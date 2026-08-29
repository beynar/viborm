/**
 * Mutation Projection Fold — query-performance-plan Phase 8.1.
 *
 * A mutation that must answer with a RELATION projection used to send its write
 * and then a separate terminal `SELECT` to shape the answer. On a dialect whose
 * `WITH` accepts a data-modifying statement, the two are one statement:
 *
 * ```sql
 * WITH "__viborm_mutation" AS (UPDATE "t" SET … WHERE … RETURNING <every column>)
 * SELECT "t0"."a" AS "a", <correlated relation reads>
 * FROM "__viborm_mutation" AS "t0"
 * ```
 *
 * Why the CTE rather than relation subqueries inside `RETURNING`: an `UPDATE`
 * has no table alias, so an outer column reference emitted inside a `RETURNING`
 * subquery goes out BARE and binds to whatever the subquery's own `FROM` calls
 * that name. That is the `_count` defect `delete-fold.test.ts` documents —
 * `note.id = note.accountId` instead of `account.id = note.accountId`. Here the
 * projection is built over a real aliased `FROM`, so it is the SAME projection
 * the terminal read builds, from the same builder, correlated the same way. The
 * only difference is which relation the rows come from.
 *
 * WHAT THIS BUILDER DOES NOT DECIDE: whether folding is LEGAL. In PostgreSQL
 * every sub-statement of one command sees the same snapshot, so the outer
 * `SELECT` reads the tables as they were BEFORE the mutation. The fold therefore
 * holds only while the projection reads nothing the statement changes. The
 * operation layer answers that — `projectionReadsMutatedModel` and
 * `setCanFireReferentialAction` in `query-engine-v2/shared.ts`, which are the
 * ones that know the projection tree and the `SET`.
 */

import {
  assembleAdapterSelect,
  type QueryParts,
} from "@adapters/adapter-internals";
import { getColumnName } from "@schema/model";
import { Sql, sql } from "@sql";
import { buildSelectWithAliases } from "../builders/select-builder";
import { getScalarFieldNames, variantCarrier } from "../context";
import { isVariantRowCarrier, type QueryScope } from "../types";
import {
  isOperationValueReference,
  statementHasReferences,
  type WriteStep,
} from "../write-engine/OperationFragment";

/**
 * The CTE the folded mutation lands in. Reserved-prefixed like every other
 * viborm-owned SQL name (`__viborm_batch_refs`, `__viborm_assert__`) so it can
 * never shadow a user table the projection's own subqueries read.
 */
const MUTATION_CTE = "__viborm_mutation";

/** Phase 8.2 — the further writes of a folded tree, each its own CTE. Nothing in
 *  the outer query reads them; PostgreSQL runs a data-modifying `WITH` arm
 *  exactly once and to completion whether or not the primary query touches its
 *  output, which is what carries the child INSERTs. */
const SIBLING_CTE_PREFIX = "__viborm_write_";

/**
 * The mutation's `RETURNING` list for the fold: every scalar column, under its
 * COLUMN name.
 *
 * Not `buildSelect`'s projection, which aliases each column to its FIELD name —
 * a `.map()`ed field would then leave the CTE carrying a name the outer
 * projection (which addresses columns) cannot find. Not the `.omit()`-filtered
 * set either: the CTE is plumbing, and what reaches the caller is decided by the
 * outer `SELECT`, which applies `.omit()` exactly as the terminal read does.
 */
function returningEveryColumn(
  ctx: QueryScope,
  select: Record<string, unknown> | undefined,
  include: Record<string, unknown> | undefined
): Sql {
  const columns = getScalarFieldNames(ctx.model).map((field) =>
    ctx.adapter.identifiers.escape(getColumnName(ctx.model, field))
  );
  for (const relationName of ctx.model["~"].relationNames) {
    const selected = select?.[relationName];
    const included = include?.[relationName];
    if (
      (selected === false || selected === undefined) &&
      (included === false || included === undefined)
    ) {
      continue;
    }
    const relation = variantCarrier(ctx, relationName);
    // A COLLECTION key contributes no private columns: its membership lives in
    // member junction tables, not on the mutated row, so the CTE has nothing to
    // carry for it and the outer projection reads the junctions directly. An
    // ordinary key contributes none either — its foreign key is already a
    // declared scalar above.
    if (!(relation && isVariantRowCarrier(relation))) continue;
    const { storage } = relation.edge;
    columns.push(
      ctx.adapter.identifiers.escape(storage.typeColumn.name),
      ctx.adapter.identifiers.escape(storage.idColumn.name)
    );
  }
  return sql.join(columns, ", ");
}

/**
 * Fold a mutation and the read that shapes its answer into one statement.
 *
 * @param ctx - the mutated model's scope; its `rootAlias` names the CTE in the
 *   outer query, so the projection correlates against the mutated ROW
 *   (post-mutation values, straight out of `RETURNING`).
 * @param args.mutation - the mutating statement WITHOUT a `RETURNING` clause.
 * @param args.siblings - Phase 8.2: further self-contained writes of the same
 *   operation, carried as unread CTE arms. They must reference no value from
 *   another arm — a `WITH` gives every arm the same snapshot, so an arm cannot
 *   read what a sibling wrote. Their caller answers for that.
 * @param args.select / args.include - the same projection the terminal read
 *   would have carried.
 */
export function buildMutationProjectionFold(
  ctx: QueryScope,
  args: {
    mutation: Sql;
    siblings?: readonly Sql[];
    select?: Record<string, unknown>;
    include?: Record<string, unknown>;
  }
): Sql {
  const { adapter, rootAlias } = ctx;
  const cte = adapter.cte.with([
    {
      name: MUTATION_CTE,
      query: sql`${args.mutation} ${adapter.mutations.returning(
        returningEveryColumn(ctx, args.select, args.include)
      )}`,
    },
    ...(args.siblings ?? []).map((query, index) => ({
      name: `${SIBLING_CTE_PREFIX}${index}`,
      query,
    })),
  ]);
  const projection = buildSelectWithAliases(
    ctx,
    args.select,
    args.include,
    rootAlias
  );
  // No WHERE and no LIMIT: the CTE already IS the affected rows, and the callers
  // that fold address a unique row, so there is exactly one. A LIMIT here would
  // be a second spelling of a cardinality the mutation's own `where` fixes.
  const parts: QueryParts = {
    columns: projection.sql,
    // Statement-local: the CTE lives in this statement, not in the adapter's
    // namespace, so it must not go through the persistent-table renderer.
    from: adapter.identifiers.aliased(
      adapter.identifiers.escape(MUTATION_CTE),
      rootAlias
    ),
  };
  if (projection.lateralJoins.length > 0) {
    parts.joins = projection.lateralJoins;
  }
  return sql`${cte} ${assembleAdapterSelect(adapter, parts)}`;
}

/**
 * The write-dependency lowering that amends the sentence on `args.siblings` above: an arm MAY now reference a value another arm
 * produced, because PostgreSQL's `RETURNING` relation is a channel the shared
 * snapshot does not close.
 *
 * ```sql
 * WITH "__viborm_mutation" AS (INSERT INTO parent … RETURNING "id", "name"),
 *      "__viborm_write_0"  AS (INSERT INTO child ("id", "parentId")
 *                              VALUES ($2, CAST((SELECT "id" FROM "__viborm_mutation") AS INTEGER)))
 * SELECT "t0"."id" FROM "__viborm_mutation" AS "t0"
 * ```
 *
 * It is a VALUE substitution and nothing else: every `OperationValueReference`
 * riding in `Sql.values` — the same marker the executor materializes from a
 * previous statement's result — is replaced by the SQL that reads the producing
 * arm's CTE column. The surrounding text, including the destination column's
 * `CAST`, is the statement the portable path already built. This function knows
 * about steps, outputs and columns; it does not know what a relation is, which
 * arm is a child, or what verb produced any of them.
 *
 * MEASURED on PGlite (PostgreSQL 16) before this was written, because the plan's
 * canonical form is `INSERT … SELECT c.id FROM c` and the form that falls out of
 * a value substitution is a scalar subquery inside `VALUES`:
 *  · both spellings insert the same rows and run each arm exactly once;
 *  · a chain — root arm, a sibling reading it and publishing its own key, a
 *    third arm reading THAT — resolves correctly;
 *  · two arms reading one producer both get its single row, and the producer
 *    still runs once;
 *  · an arm reading a LATER arm fails with `relation "…" does not exist`. That
 *    is a SQL-emission law, not a graph property, and it is why a reference must
 *    name a STRICTLY EARLIER arm here rather than merely a different one;
 *  · a producer returning two rows fails with `more than one row returned by a
 *    subquery used as an expression`, where the multi-statement path would have
 *    silently taken row 0. Nothing in a foldable tree can be that producer —
 *    see the note on {@link armColumnSql}.
 *
 * @param scope - the ROOT model's scope. Its model names the columns of the
 *   `__viborm_mutation` arm and its adapter quotes them. It does NOT re-ask
 *   whether the dialect has data-modifying CTEs: the caller must already have
 *   established that to build the enclosing `WITH` at all, and one invariant
 *   gets one owner.
 * @param writes - the arms in the order {@link buildMutationProjectionFold} will
 *   place them: `writes[0]` becomes `__viborm_mutation`, the rest become
 *   `__viborm_write_0…`.
 * @returns the SIBLING statements (`writes.slice(1)`), index-aligned, with every
 *   reference lowered — or `undefined` if any reference cannot be spelled, in
 *   which case the caller keeps its multi-statement series. The root's own
 *   statement is not returned: the caller rebuilds it with this file's
 *   all-columns `RETURNING`, and a reference inside it would have to name an arm
 *   before the first one, which the ordering law above forbids.
 *
 * Deviation from §4.5's sketch, recorded rather than silent: the sketch returns
 * a merged `WriteStep`. Building that step is already `CreateOperation`'s
 * `buildTreeFold` — id, outputs and postcondition included — so returning one
 * here would make two owners of one step. This returns the arms; the caller
 * hands them to `buildMutationProjectionFold` exactly as it hands the arms it
 * did not have to lower.
 */
export function compileMutationDependencyFold(
  scope: QueryScope,
  writes: readonly WriteStep[]
): readonly Sql[] | undefined {
  const siblings: Sql[] = [];
  for (const [index, step] of writes.entries()) {
    const lowered = lowerArmReferences(scope, writes, index, step);
    if (!lowered) return undefined;
    if (index > 0) siblings.push(lowered);
  }
  return siblings;
}

/** One arm, with every reference in it replaced. Returns the ORIGINAL `Sql` when
 *  the arm holds no reference, so an arm the portable path already folded stays
 *  byte-identical rather than being rebuilt. */
function lowerArmReferences(
  scope: QueryScope,
  writes: readonly WriteStep[],
  index: number,
  step: WriteStep
): Sql | undefined {
  const values = step.statement.values;
  if (!statementHasReferences(step.statement)) return step.statement;
  const lowered: unknown[] = [];
  for (const value of values) {
    if (!isOperationValueReference(value)) {
      lowered.push(value);
      continue;
    }
    const producer = writes.findIndex(
      (candidate) => candidate.id === value.step
    );
    // A reference to an arm that is not in this fold, to the arm itself, or to a
    // LATER arm: the first has no column to read, and the other two are the
    // forward reference PostgreSQL rejects. One test, three refusals, because
    // "strictly earlier in this list" is one fact.
    if (producer < 0 || producer >= index) return undefined;
    const column = armColumnSql(scope, writes, producer, value.output);
    if (!column) return undefined;
    lowered.push(column);
  }
  return new Sql(step.statement.strings, lowered);
}

/**
 * `(SELECT <column> FROM <arm>)` for one produced value.
 *
 * TWO NAMING CONVENTIONS, and getting them the wrong way round is silent on any
 * field whose column name matches it. The root arm's `RETURNING` is rebuilt by
 * {@link returningEveryColumn}, which emits bare COLUMN names, so the root is
 * addressed by `getColumnName`. A sibling arm keeps the `RETURNING` its own
 * builder emitted — `"<column>" AS "<field>"` — so a sibling is addressed by the
 * FIELD name.
 *
 * `firstRowField` is the only output kind that has a column at all: `insertId`
 * is a driver channel, `rows`/`rowCount` are whole results. An `optional` one
 * belongs to a read whose emptiness picks a branch, and a branch is not
 * something one statement chooses — both decline here.
 *
 * WHY NO SEPARATE "the producer returns exactly one row" CHECK, which §4.5 lists:
 * requiring the producer to DECLARE this output as `firstRowField` already is
 * that check. The multi-row writes a create tree can contain are `createMany`
 * group statements, and they declare `outputs: {}` — so they fail this test by
 * publishing nothing, not by being multi-row. A guard for the same fact spelled
 * twice would have no coverage of its own to name.
 */
function armColumnSql(
  scope: QueryScope,
  writes: readonly WriteStep[],
  producer: number,
  output: string
): Sql | undefined {
  const source = writes[producer]?.outputs[output];
  if (source?.kind !== "firstRowField" || source.optional === true) {
    return undefined;
  }
  const arm =
    producer === 0 ? MUTATION_CTE : `${SIBLING_CTE_PREFIX}${producer - 1}`;
  const column =
    producer === 0 ? getColumnName(scope.model, source.field) : source.field;
  const { identifiers, subqueries } = scope.adapter;
  return subqueries.scalar(
    sql`SELECT ${identifiers.escape(column)} FROM ${identifiers.escape(arm)}`
  );
}
