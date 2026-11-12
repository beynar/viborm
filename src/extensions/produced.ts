/**
 * The row a write would leave, judged in the statement that writes it: the
 * SQL an extension's `place` and `moves` rules add to an INSERT or an UPDATE.
 * The engine lowers predicates and names rows; what is judged, and how the
 * judgement rides the write, is stated here, beside what declares it.
 */
import { assembleAdapterSelect } from "@adapters/adapter-internals";
import {
  NO_RELATIONS,
  type PreparedSelector,
  readsAny,
  rowValue,
  throughDerived,
  wholeValue,
} from "@query-engine/raptor3/shared/query";
import type { Input } from "@query-engine/raptor3/shared/schema";
import type { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import type { AnyModel } from "@schema/model";
import { Sql, sql } from "@sql";

/**
 * The rows of `model` a write produces, as ONE FROM item read under
 * `alias`: every stored field, each row's value as `row` lowers it (NULL
 * where it says nothing). The model's own columns type them, through an
 * empty read of the table, so a bound value takes its column's type where
 * PostgreSQL would resolve a bare parameter as text; how the rows follow
 * it is the dialect's (`setOperations.typedRows`), so a chunk is bounded
 * by its binds alone.
 */
function producedRows(
  q: SqlQueries,
  model: AnyModel,
  rows: readonly ((field: string) => Sql | undefined)[],
  alias: string
): Sql {
  const a = q.adapter;
  const fields = q.schema.storedFields(model);
  const typed = q.alias();
  const from = q.table(model, typed);
  const head = assembleAdapterSelect(a, {
    columns: sql.join(
      fields.map((field) => q.column(model, field, typed)),
      ", "
    ),
    from,
    where: a.literals.false(),
  });
  return a.setOperations.typedRows(
    {
      head,
      from,
      table: q.table(model),
      alias: typed,
      columns: fields.map((field) => q.columnName(model, field)),
    },
    rows.map((row) => fields.map((field) => row(field) ?? a.literals.null())),
    alias
  );
}
/**
 * `judged` over the produced row `from` reads (and, for each `acyclic`
 * relation, the row outside its own subtree), as the adapter's assertion:
 * 1, or the statement that carries it fails before it writes. `undefined`
 * where nothing is left to judge: the call drops every layer `judged` is
 * made of (R6).
 */
function holds(
  q: SqlQueries,
  model: AnyModel,
  judged: Pick<PreparedSelector, "model" | "predicate"> | undefined,
  alias: string,
  nulls: ReadonlyMap<string, boolean>,
  from?: Sql,
  acyclic: readonly string[] = NO_RELATIONS
): Sql | undefined {
  const a = q.adapter;
  const outer = q.known;
  q.known = { alias, nulls };
  let lowered: Sql | undefined;
  try {
    lowered = judged && q.lowerSelector(judged, alias);
  } finally {
    q.known = outer;
  }
  const conditions = [
    ...(lowered === undefined ? [] : [lowered]),
    ...acyclic.map((relation) => q.outsideOwnSubtree(model, relation, alias)),
  ];
  if (conditions.length === 0) return undefined;
  return a.subqueries.scalar(
    a.assertions.holds(a.operators.and(...conditions), from)
  );
}
/**
 * The SELECT an INSERT of `rows` reads its values from when the rows it
 * creates are judged (R4): each row a value of the derived table, kept
 * where `judged` holds of it and failing the statement where it does not,
 * before any row is written or any constraint is checked. One statement:
 * nothing it writes is visible to its own judgement.
 */
export function producedSource(
  q: SqlQueries,
  model: AnyModel,
  columns: readonly string[],
  rows: readonly Input[],
  judged: PreparedSelector
): Sql | undefined {
  const a = q.adapter;
  const alias = q.alias();
  const written = new Set(columns);
  const from = producedRows(
    q,
    model,
    rows.map(
      (row) => (field) =>
        written.has(field) ? q.fieldValue(model, field, row[field]) : undefined
    ),
    alias
  );
  // A field's nullness folds where every row states the same one; a field
  // no row writes is null in each.
  const nulls = new Map<string, boolean>();
  for (const field of q.schema.storedFields(model)) {
    const states = new Set(
      rows.map((row) => {
        const value = written.has(field) ? row[field] : null;
        return value instanceof Sql
          ? undefined
          : value === null || value === undefined;
      })
    );
    const [state] = states;
    if (states.size === 1 && state !== undefined) nulls.set(field, state);
  }
  return q.sharing(() => {
    const guard = holds(q, model, judged, alias, nulls);
    if (guard === undefined) return undefined;
    return assembleAdapterSelect(a, {
      columns: sql.join(
        columns.map((field) => q.column(model, field, alias)),
        ", "
      ),
      from,
      where: sql`${guard} = 1`,
    });
  });
}
/**
 * The WHERE of an UPDATE of `model` assigning `values` that judges the
 * rows it produces (R4): the keys of the rows `candidates` selects
 * (lowered at the alias it is handed; the first `limit` in key order),
 * read ONCE, before the statement writes any of them, each group of one
 * key kept where its produced row's assertion holds (the row as it stands
 * with the assignments applied, typed as {@link producedRows}): 1, or the
 * statement fails before it writes.
 *
 * An aggregate is computed over the rows its WHERE kept, so a row the
 * update does not write is never judged: a guard in a select list or a
 * WHERE is not, since PostgreSQL and MySQL flatten an `IN` subquery and
 * order its conditions by cost (measured: a viewed row's refused guard
 * raised before the predicate that excludes it). A set read once is
 * judged against the rows as they stand before the write, never against
 * a row the statement wrote earlier: SQLite and MySQL evaluate an
 * UPDATE's own SET row by row (measured: a team's lead demoted early made
 * its other members' new rows unwritable). On MySQL, which refuses to read
 * the written table from its own subquery, the set is a derived table,
 * materialized before the write (`#capped`'s form). `undefined` where
 * nothing is left to judge.
 */
export function producedWhere(
  q: SqlQueries,
  model: AnyModel,
  candidates: (alias: string) => Sql | undefined,
  values: Input,
  judged: PreparedSelector | undefined,
  acyclic: readonly string[] = NO_RELATIONS,
  limit?: number
): Sql | undefined {
  if (judged === undefined && acyclic.length === 0) return undefined;
  const a = q.adapter;
  const row = q.alias();
  const produced = q.alias();
  const current = (field: string) => q.column(model, field, row);
  const rowKeys = q.schema.keys(model);
  // A value only the database computes (a list append, an exact
  // decimal's multiply or divide) has no value to judge: it is refused
  // where the judgement reads it (`updateValue`), and stands as it was
  // where nothing does, since no answer depends on it.
  const unread = (field: string) =>
    !(
      q.namesUpdate(model, field, values[field]) ||
      (judged?.predicate &&
        readsAny(judged.predicate, new Set([field]), rowKeys)) ||
      acyclic.some((relation) => {
        const edge = q.schema.membership(model, relation);
        return (
          edge.kind === "reference" &&
          edge.pairs.some((pair) => pair.source === field)
        );
      })
    );
  const from = producedRows(
    q,
    model,
    [
      (field) =>
        values[field] === undefined || unread(field)
          ? current(field)
          : q.updateValue(model, field, values[field], current(field)),
    ],
    produced
  );
  const nulls = new Map<string, boolean>();
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const whole = wholeValue(value);
    if (whole && !(whole.value instanceof Sql))
      nulls.set(field, whole.value === null);
  }
  const judgedSet = (): Sql | undefined => {
    const guard = holds(q, model, judged, produced, nulls, from, acyclic);
    if (guard === undefined) return undefined;
    const keys = q.keyOrder(model).map(current);
    return assembleAdapterSelect(a, {
      columns: sql.join(keys, ", "),
      from: q.table(model, row),
      where: candidates(row),
      groupBy: sql.join(keys, ", "),
      having: sql`${a.aggregates.min(guard)} = 1`,
      ...(limit !== undefined && {
        orderBy: q.ascendingKeys(model, row),
        limit: q.value(limit),
      }),
    });
  };
  const set = q.sharing(judgedSet);
  if (set === undefined) return undefined;
  const table = model["~"].names.sql!;
  return a.operators.in(
    rowValue(q.keyOrder(model).map((field) => q.column(model, field, table))),
    a.subqueries.scalar(
      a.capabilities.supportsMutationTargetInSubquery
        ? set
        : throughDerived(a, set, q.alias())
    )
  );
}
