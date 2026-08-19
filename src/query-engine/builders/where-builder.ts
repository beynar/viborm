/**
 * Where Builder
 *
 * Builds WHERE clauses from filter objects.
 * Handles scalar filters, logical operators (AND/OR/NOT),
 * and delegates relation filters to relation-filter-builder.
 */

import {
  type AnyFieldRef,
  fieldRefPayload,
  formatFieldRef,
  isFieldRef,
} from "@schema/field-ref";
import type { ScalarState } from "@schema/scalars";
import { isSql, type Sql, sql } from "@sql";
import {
  createChildScope,
  getColumnName,
  getPolymorphicRelationInfo,
  getRelationInfo,
  isPolymorphicRelation,
  isRelation,
  isScalarField,
} from "../context";
import {
  isPolymorphicToOneRelationInfo,
  QueryEngineError,
  type QueryScope,
  type RelationInfo,
} from "../types";
import { assertExactDecimalOperation } from "./decimal-portability";
import { buildJsonFilter } from "./json-filter-builder";
import { buildPolymorphicCollectionFilterSql } from "./polymorphic-collection-filter-builder";
import { buildPolymorphicFilterSql } from "./polymorphic-read-builder";
import {
  type BuildNestedWhere,
  buildRelationFilterSql,
} from "./relation-filter-builder";
import { assertSupportedScalarFilterOperator } from "./scalar-filter-operators";
import { scalarValueLiteral } from "./values-builder";

/**
 * Build a WHERE clause from a where input object
 *
 * @param ctx - Query context
 * @param where - Where input object
 * @param alias - Current table alias
 * @returns SQL for WHERE clause or undefined if no conditions
 */
export function buildWhere(
  ctx: QueryScope,
  where: Record<string, unknown> | undefined,
  alias: string
): Sql | undefined {
  if (!where) {
    return undefined;
  }

  // Use Object.keys + direct access instead of Object.entries to avoid tuple allocation
  const keys = Object.keys(where);
  if (keys.length === 0) {
    return undefined;
  }

  const conditions: Sql[] = [];

  for (const key of keys) {
    const value = where[key];
    if (value === undefined) {
      continue;
    }

    // Handle logical operators
    if (key === "AND") {
      const andCondition = buildLogicalAnd(ctx, value, alias);
      if (andCondition) {
        conditions.push(andCondition);
      }
      continue;
    }

    if (key === "OR") {
      const orCondition = buildLogicalOr(ctx, value, alias);
      if (orCondition) {
        conditions.push(orCondition);
      }
      continue;
    }

    if (key === "NOT") {
      const notCondition = buildLogicalNot(ctx, value, alias);
      if (notCondition) {
        conditions.push(notCondition);
      }
      continue;
    }

    // Handle scalar filters
    if (isScalarField(ctx.model, key)) {
      const scalarCondition = buildScalarFilter(ctx, key, value, alias);
      if (scalarCondition) {
        conditions.push(scalarCondition);
      }
      continue;
    }

    // Handle relation filters
    if (isRelation(ctx.model, key)) {
      const relationInfo = getRelationInfo(ctx, key);
      if (!relationInfo) {
        throw new QueryEngineError(`Unknown relation '${key}'.`);
      }
      const relationCondition = buildRelationFilter(
        ctx,
        relationInfo,
        value as Record<string, unknown>,
        alias
      );
      if (relationCondition) {
        conditions.push(relationCondition);
      }
      continue;
    }

    if (isPolymorphicRelation(ctx.model, key)) {
      const relation = getPolymorphicRelationInfo(ctx, key);
      if (!relation) {
        throw new QueryEngineError(
          `Polymorphic relation '${key}' has no validated storage metadata.`
        );
      }
      // The two storages take different predicates: the row-held pair answers a
      // tagged `{type, is|isNot}` plus null presence, a collection answers the
      // ordinary quantifiers over one tagged member predicate and has no null
      // state at all.
      conditions.push(
        isPolymorphicToOneRelationInfo(relation)
          ? buildPolymorphicFilterSql(
              buildNestedWhere,
              ctx,
              relation,
              value,
              alias
            )
          : buildPolymorphicCollectionFilterSql(
              buildNestedWhere,
              ctx,
              relation,
              value,
              alias
            )
      );
      continue;
    }

    throw new QueryEngineError(`Unknown where field '${key}'.`);
  }

  if (conditions.length === 0) {
    return undefined;
  }

  return ctx.adapter.operators.and(...conditions);
}

const buildNestedWhere: BuildNestedWhere = (ctx, where) =>
  buildWhere(ctx, where, ctx.rootAlias);

/** Build a relation predicate while preserving the public advanced API. */
export function buildRelationFilter(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  filter: Record<string, unknown>,
  parentAlias: string
): Sql | undefined {
  const parentScope =
    parentAlias === ctx.rootAlias
      ? ctx
      : createChildScope(ctx, ctx.model, parentAlias);
  return buildRelationFilterSql(
    buildNestedWhere,
    parentScope,
    relationInfo,
    filter
  );
}

/**
 * Build AND logical operator
 */
function buildLogicalAnd(
  ctx: QueryScope,
  value: unknown,
  alias: string
): Sql | undefined {
  const items = Array.isArray(value) ? value : [value];
  const conditions: Sql[] = [];

  for (const item of items) {
    const condition = buildWhere(ctx, item as Record<string, unknown>, alias);
    if (condition) {
      conditions.push(condition);
    }
  }

  if (conditions.length === 0) {
    return undefined;
  }
  return ctx.adapter.operators.and(...conditions);
}

/**
 * Build OR logical operator
 */
function buildLogicalOr(
  ctx: QueryScope,
  value: unknown,
  alias: string
): Sql | undefined {
  if (!Array.isArray(value)) {
    throw new QueryEngineError("Logical OR requires an array value.");
  }

  const conditions: Sql[] = [];

  for (const item of value) {
    const condition = buildWhere(ctx, item as Record<string, unknown>, alias);
    if (condition) {
      conditions.push(condition);
    }
  }

  if (conditions.length === 0) {
    return ctx.adapter.literals.false();
  }
  return ctx.adapter.operators.or(...conditions);
}

/**
 * Build NOT logical operator
 */
function buildLogicalNot(
  ctx: QueryScope,
  value: unknown,
  alias: string
): Sql | undefined {
  // Prisma semantics: NOT: [c1, c2] negates each item and ANDs the
  // negations (NOT c1 AND NOT c2 — "all conditions must return false"),
  // not NOT (c1 AND c2). The object form NOT: { ... } is a single item,
  // so it becomes NOT (that object's implicit-AND) exactly as before.
  const items = Array.isArray(value) ? value : [value];
  const negations: Sql[] = [];

  for (const item of items) {
    const condition = buildWhere(ctx, item as Record<string, unknown>, alias);
    if (condition) {
      negations.push(ctx.adapter.operators.not(condition));
    }
  }

  if (negations.length === 0) {
    return undefined;
  }

  return ctx.adapter.operators.and(...negations);
}

/** Filter mode for case sensitivity */
type FilterMode = "default" | "insensitive";

/**
 * Build a scalar filter
 *
 * Schema validation normalizes all values to filter objects:
 * - Simple values become { equals: value }
 * - null becomes { equals: null }
 */
function buildScalarFilter(
  ctx: QueryScope,
  fieldName: string,
  value: unknown,
  alias: string
): Sql | undefined {
  const scalarState = getScalarState(ctx, fieldName);

  // Resolve field name to actual column name (handles .map() overrides)
  const columnName = getColumnName(ctx.model, fieldName);
  const column = ctx.adapter.identifiers.column(alias, columnName);

  // Schema validation guarantees value is always a filter object
  if (typeof value !== "object" || value === null) {
    throw new QueryEngineError(
      `Filter for '${fieldName}' must be a filter object (schema validation should have normalized this)`
    );
  }

  // Filter object with operations like equals, contains, gt, etc.
  const filter = value as Record<string, unknown>;

  // JSON documents get their own filter language (path-scoped operators)
  if (scalarState.type === "json" && !scalarState.array) {
    return buildJsonFilter(ctx, fieldName, scalarState, column, filter);
  }

  const conditions: Sql[] = [];

  // Extract mode for case-insensitive operations
  const mode: FilterMode =
    filter.mode === "insensitive" ? "insensitive" : "default";

  for (const [op, opValue] of Object.entries(filter)) {
    if (opValue === undefined) {
      continue;
    }
    assertSupportedScalarFilterOperator(fieldName, scalarState, op);
    if (op === "mode") continue;

    const condition = buildFilterOperation(
      ctx,
      fieldName,
      scalarState,
      column,
      op,
      opValue,
      alias,
      mode
    );
    if (condition) {
      conditions.push(condition);
    }
  }

  if (conditions.length === 0) {
    throw new QueryEngineError(
      `Filter for field '${fieldName}' must contain at least one operation.`
    );
  }
  return ctx.adapter.operators.and(...conditions);
}

/**
 * Resolve a field reference against the CURRENT query scope.
 *
 * This is where Prisma's same-model rule lives. It is a resolution constraint,
 * not a re-validation: the scope model is the only thing that can turn
 * `post.likes` into a column, and the scope is a property of the query (a nested
 * relation `where` re-scopes to the relation target) that the interned, model-blind
 * filter schemas cannot see. Runs at SQL-build time, before any I/O.
 */
function fieldRefColumn(ctx: QueryScope, ref: AnyFieldRef, alias: string): Sql {
  const payload = fieldRefPayload(ref);
  const scopeModel = ctx.model["~"].names.ts;
  if (payload.model !== scopeModel) {
    throw new QueryEngineError(
      `Field reference '${formatFieldRef(ref)}' cannot be used while filtering '${
        scopeModel ?? "unknown"
      }': a field reference may only compare columns of the same model.`
    );
  }
  if (!isScalarField(ctx.model, payload.field)) {
    throw new QueryEngineError(
      `Field reference '${formatFieldRef(ref)}' does not name a scalar field of '${scopeModel}'.`
    );
  }
  return ctx.adapter.identifiers.column(
    alias,
    getColumnName(ctx.model, payload.field)
  );
}

/**
 * Splice a caller-supplied fragment into an operand position.
 *
 * PARENTHESIZED, always: the fragment is an expression the caller wrote, and
 * the builder is about to wrap it in one (`col > <here>`, a case fold, a cast).
 * Without the parentheses a fragment like `` sql`a + b` `` would rebind against
 * the surrounding operator and answer a different question. The interpolations
 * ride along untouched — an `Sql` nested inside an `Sql` is spliced as text and
 * its values stay BOUND PARAMETERS (see `Sql.flatten`), so a value interpolated
 * into a fragment operand is never concatenated into the statement.
 *
 * The fragment's TEXT is the caller's responsibility, dialect and all — the same
 * trust model as `$queryRaw`, and outside the portability promise the rest of
 * the filter language keeps.
 */
const fragmentOperand = (fragment: Sql): Sql => sql`(${fragment})`;

/**
 * The operand as a COLUMN EXPRESSION, or `undefined` when it is an ordinary
 * value that has to be bound.
 *
 * A referenced column and a spliced fragment are the same thing to every
 * operator below — an expression rather than a parameter — so they resolve
 * together here and the operator-level branches stay one shape.
 */
function operandExpression(
  ctx: QueryScope,
  value: unknown,
  alias: string
): Sql | undefined {
  if (isFieldRef(value)) return fieldRefColumn(ctx, value, alias);
  if (isSql(value)) return fragmentOperand(value);
  return undefined;
}

/**
 * Build a single filter operation
 *
 * @param ctx - Query context
 * @param column - Column SQL expression
 * @param operation - Filter operation name
 * @param value - Filter value
 * @param alias - Table alias the filtered column is qualified with; a field
 *   reference operand resolves to a column on the SAME alias (same row)
 * @param mode - Case sensitivity mode (default or insensitive)
 */
function buildFilterOperation(
  ctx: QueryScope,
  fieldName: string,
  scalarState: ScalarState,
  column: Sql,
  operation: string,
  value: unknown,
  alias: string,
  mode: FilterMode = "default"
): Sql {
  const { adapter } = ctx;
  const lit = (v: unknown) => {
    if (isFieldRef(v)) {
      // Reached only from an operator the schemas do NOT open to references
      // (in/notIn/has/hasEvery/hasSome). Fail closed rather than bind the token.
      throw new QueryEngineError(
        `Field reference '${formatFieldRef(v)}' is not supported by the '${operation}' filter on '${fieldName}'.`
      );
    }
    if (isSql(v)) {
      // Same closure for the fragment: an operator that takes VALUES would
      // otherwise bind the fragment object itself as a parameter.
      throw new QueryEngineError(
        `An SQL fragment is not supported by the '${operation}' filter on '${fieldName}'.`
      );
    }
    return scalarValueLiteral(ctx, fieldName, v);
  };
  const isInsensitive = mode === "insensitive";
  const isTextScalar =
    !scalarState.array &&
    (scalarState.type === "string" || scalarState.type === "enum");
  const exactTextColumn = isTextScalar
    ? adapter.expressions.caseSensitiveText(column)
    : column;
  const foldedTextColumn = isTextScalar
    ? adapter.expressions.caseSensitiveText(
        adapter.expressions.asciiCaseFold(column)
      )
    : column;

  // Operand builders. Each mirrors the treatment its LHS gets at the call site,
  // so a referenced column is compared under the SAME collation/folding rules as
  // a bound literal would be.
  //
  // Two halves of that mirroring differ in kind, and the tests reflect it:
  //
  //  - The FOLD is load-bearing and behavioral. A referenced column that is not
  //    ASCII-folded compares against a folded LHS and stops matching, so
  //    `tests/drivers/field-reference-behavior.ts` discriminates it on every
  //    dialect with rows whose referenced column carries the upper case.
  //  - `caseSensitiveText` on the OPERAND is structural symmetry, not a second
  //    behavioral guard: all three dialects let a one-sided collation govern the
  //    whole comparison (MySQL's `BINARY` coerces the comparison, SQLite takes
  //    the left operand's explicit COLLATE, Postgres's is the identity), so with
  //    the LHS already wrapped no query result can tell the operand's wrapper
  //    apart. It is pinned as EMITTED SQL in
  //    `tests/query-engine/field-reference-sql.test.ts` instead of being claimed
  //    as behavior no test could actually witness.
  /** Raw operand — pairs with a bare `column` LHS (ordered comparisons, LIKE-free text predicates). */
  const plainOperand = (v: unknown) =>
    operandExpression(ctx, v, alias) ?? lit(v);
  /**
   * An enum column compared against ANOTHER COLUMN goes through text on every
   * dialect.
   *
   * PostgreSQL gives each enum field its own type, and `enum_a = enum_b` for
   * two different types has no operator — the comparison fails outright with
   * 42883, while SQLite and MySQL (which store the value as text) answer it
   * fine. That is a portability hole in the worst direction: the same query
   * that works on SQLite crashes on Postgres. Casting BOTH sides to text makes
   * every dialect answer the same question — enum values compare by their
   * spelling, which is what a literal operand already does.
   *
   * Only the referenced-column path takes the cast: `role = $1` still binds an
   * enum-typed parameter, so ordinary equality keeps using the column's index.
   */
  const isEnumScalar = !scalarState.array && scalarState.type === "enum";
  const comparableText = (expr: Sql) =>
    isEnumScalar ? adapter.expressions.cast(expr, "text") : expr;

  /**
   * The (LHS, operand) pair for an exact `equals`/`not` comparison. Both sides
   * are built together because a referenced enum operand changes the LHS too.
   */
  const exactComparison = (v: unknown): [Sql, Sql] => {
    const expr = operandExpression(ctx, v, alias);
    if (!expr) return [exactTextColumn, lit(v)];
    if (!isTextScalar) return [column, expr];
    const asExactText = (e: Sql) =>
      adapter.expressions.caseSensitiveText(comparableText(e));
    return [asExactText(column), asExactText(expr)];
  };

  /**
   * `equals` against a BOUND operand on a text column — the one shape a
   * planner can answer with an index lookup, and the one shape MySQL's
   * case-sensitive spelling costs it (plan §10.2). `exactTextEq` is where each
   * dialect writes that comparison in its own index-usable form.
   *
   * A referenced column keeps `exactComparison` unchanged, for the same reason
   * `startsWithPrefix` skips it: comparing two columns is not a lookup, so
   * there is no index to preserve and an accelerator conjunct would decide no
   * row's membership.
   */
  const exactEquals = (v: unknown): Sql =>
    isTextScalar && !operandExpression(ctx, v, alias)
      ? adapter.operators.exactTextEq(column, lit(v))
      : adapter.operators.eq(...exactComparison(v));
  /** Case-folded operand — pairs with `foldedTextColumn`. */
  const foldedOperand = (v: unknown) => {
    const expr = operandExpression(ctx, v, alias);
    if (!expr) return adapter.expressions.asciiCaseFold(lit(v));
    return isTextScalar
      ? adapter.expressions.caseSensitiveText(
          adapter.expressions.asciiCaseFold(expr)
        )
      : expr;
  };

  // Portable insensitive mode folds ASCII A-Z only, then uses exact text
  // predicates. This avoids provider-native Unicode/collation divergence.
  const insensitiveEq = (v: unknown) =>
    adapter.operators.eq(foldedTextColumn, foldedOperand(v));
  const insensitiveNeq = (v: unknown) =>
    adapter.operators.neq(foldedTextColumn, foldedOperand(v));

  switch (operation) {
    // Equality
    case "equals":
      if (value === null) {
        return adapter.operators.isNull(column);
      }
      // Whole-list and JSON document operands need the dialect's storage
      // format: a plain param compares as a string scalar on MySQL and is
      // unbindable on SQLite
      if (scalarState.array && Array.isArray(value)) {
        return adapter.operators.eq(column, adapter.arrays.value(value));
      }
      // JSON columns store serialized JSON for every value shape (primitives
      // included — see buildScalarSqlValue), so compare in the same format
      if (scalarState.type === "json") {
        return adapter.operators.eq(column, adapter.json.value(value));
      }
      // A reference is an OBJECT, so it has to be admitted to the insensitive
      // path explicitly: gating on `typeof value === "string"` alone dropped a
      // referenced-column operand straight through to the exact predicate and
      // silently ignored `mode` — `equals` stayed case-sensitive while
      // `contains`/`startsWith`/`endsWith` (which never had the guard) folded,
      // so the two disagreed on the same filter object.
      if (
        isInsensitive &&
        (typeof value === "string" || isFieldRef(value) || isSql(value))
      ) {
        return insensitiveEq(value);
      }
      return exactEquals(value);

    case "not":
      if (value === null) {
        return adapter.operators.isNotNull(column);
      }
      // List shorthand ({ not: [...] }) — before the nested-filter branch,
      // which would misread array indices as filter operations. JSON `not`
      // stays on the nested-filter path (its schema nests { equals: ... }).
      if (scalarState.array && Array.isArray(value)) {
        return adapter.operators.neq(column, adapter.arrays.value(value));
      }
      // A field reference and an SQL fragment are both OBJECTS, so they must be
      // recognized before the nested-filter branch — otherwise their own keys
      // would read as filter operations.
      if (isFieldRef(value) || isSql(value)) {
        return isInsensitive
          ? insensitiveNeq(value)
          : adapter.operators.neq(...exactComparison(value));
      }
      if (typeof value === "object" && value !== null) {
        // Nested filter: { not: { contains: "foo" } }
        const nested = buildScalarFilterObject(
          ctx,
          fieldName,
          column,
          value as Record<string, unknown>,
          alias,
          mode
        );
        return adapter.operators.not(nested);
      }
      if (isInsensitive && typeof value === "string") {
        return insensitiveNeq(value);
      }
      return adapter.operators.neq(...exactComparison(value));

    // Comparison. Ordering a decimal needs an exact decimal type to order it
    // WITH; where there is none the comparison is refused, never approximated.
    case "lt":
      assertExactDecimalOperation(ctx, fieldName, operation);
      return adapter.operators.lt(column, plainOperand(value));

    case "lte":
      assertExactDecimalOperation(ctx, fieldName, operation);
      return adapter.operators.lte(column, plainOperand(value));

    case "gt":
      assertExactDecimalOperation(ctx, fieldName, operation);
      return adapter.operators.gt(column, plainOperand(value));

    case "gte":
      assertExactDecimalOperation(ctx, fieldName, operation);
      return adapter.operators.gte(column, plainOperand(value));

    // Set membership
    case "in": {
      if (!Array.isArray(value)) {
        throw new QueryEngineError(
          `Filter operation '${operation}' for field '${fieldName}' requires an array value.`
        );
      }
      // Empty array should match nothing (always false)
      if (value.length === 0) {
        return adapter.literals.false();
      }
      if (isInsensitive) {
        return adapter.operators.or(...value.map(insensitiveEq));
      }
      const inValues = adapter.literals.list(value.map((v) => lit(v)));
      // `equals`' twin: the operands here are always bound (`lit` refuses a
      // reference), so this is the other membership test a planner can range
      // on — and the other one MySQL's case-sensitive spelling costs.
      return isTextScalar
        ? adapter.operators.exactTextIn(column, inValues)
        : adapter.operators.in(column, inValues);
    }

    case "notIn": {
      if (!Array.isArray(value)) {
        throw new QueryEngineError(
          `Filter operation '${operation}' for field '${fieldName}' requires an array value.`
        );
      }
      // Empty array for notIn should match everything (always true)
      if (value.length === 0) {
        return adapter.literals.true();
      }
      if (isInsensitive) {
        return adapter.operators.and(...value.map(insensitiveNeq));
      }
      const notInValues = value.map((v) => lit(v));
      return adapter.operators.notIn(
        exactTextColumn,
        adapter.literals.list(notInValues)
      );
    }

    // String operations use adapter-owned exact substring predicates (POSITION /
    // instr / LOCATE + LEFT/RIGHT), never LIKE patterns, so the operand may be a
    // referenced column as naturally as a bound literal.
    case "contains": {
      return isInsensitive
        ? adapter.operators.containsText(foldedTextColumn, foldedOperand(value))
        : adapter.operators.containsText(column, plainOperand(value));
    }

    case "startsWith": {
      if (isInsensitive) {
        return adapter.operators.startsWithText(
          foldedTextColumn,
          foldedOperand(value)
        );
      }
      // A literal string operand is the only shape that can be escaped into a
      // pattern here, and so the only one the index-usable spelling can serve.
      // The alternative is a field reference or an SQL fragment — an object,
      // with no client-side string to escape — which keeps the LEFT/substr
      // spelling and loses nothing: its operand is a column, so no planner
      // could have ranged the predicate either way.
      //
      // The COLUMN's type needs no check to go with this. `startsWith` is
      // admitted on a non-array string scalar and nowhere else; an enum or a
      // string list is refused at the parse boundary, which
      // `tests/query-engine/starts-with-prefix-sql.test.ts` pins as the
      // boundary's job rather than restating it here.
      if (typeof value === "string") {
        return adapter.operators.startsWithPrefix(column, value);
      }
      return adapter.operators.startsWithText(column, plainOperand(value));
    }

    case "endsWith": {
      return isInsensitive
        ? adapter.operators.endsWithText(foldedTextColumn, foldedOperand(value))
        : adapter.operators.endsWithText(column, plainOperand(value));
    }

    // Array operations (for array/list scalars)
    case "has":
      // `has: null` never matches on any dialect (Prisma/PG semantics:
      // NULL = element is never true). MySQL's JSON_CONTAINS would match
      // JSON null elements, so short-circuit before it diverges.
      if (value === null) {
        return adapter.literals.false();
      }
      return adapter.arrays.has(column, lit(value));

    case "hasEvery":
      if (!Array.isArray(value)) {
        throw new QueryEngineError(
          `Filter operation '${operation}' for field '${fieldName}' requires an array value.`
        );
      }
      return adapter.arrays.hasEvery(
        column,
        adapter.arrays.literal(value.map(lit))
      );

    case "hasSome":
      if (!Array.isArray(value)) {
        throw new QueryEngineError(
          `Filter operation '${operation}' for field '${fieldName}' requires an array value.`
        );
      }
      return adapter.arrays.hasSome(
        column,
        adapter.arrays.literal(value.map(lit))
      );

    case "isEmpty":
      return value
        ? adapter.arrays.isEmpty(column)
        : adapter.operators.not(adapter.arrays.isEmpty(column));

    default:
      throw new QueryEngineError(
        `Unknown filter operation '${operation}' for field '${fieldName}'.`
      );
  }
}

/**
 * Build a filter from an object (for nested not operations)
 */
function buildScalarFilterObject(
  ctx: QueryScope,
  fieldName: string,
  column: Sql,
  filter: Record<string, unknown>,
  alias: string,
  mode: FilterMode = "default"
): Sql {
  const scalarState = getScalarState(ctx, fieldName);
  const conditions: Sql[] = [];

  // Nested filter may also have mode
  const nestedMode: FilterMode =
    filter.mode === "insensitive" ? "insensitive" : mode;

  for (const [op, value] of Object.entries(filter)) {
    if (value === undefined) {
      continue;
    }
    assertSupportedScalarFilterOperator(fieldName, scalarState, op);
    if (op === "mode") continue;

    const condition = buildFilterOperation(
      ctx,
      fieldName,
      scalarState,
      column,
      op,
      value,
      alias,
      nestedMode
    );
    if (condition) {
      conditions.push(condition);
    }
  }

  if (conditions.length === 0) {
    throw new QueryEngineError(
      `Filter operation 'not' for field '${fieldName}' must contain at least one nested condition.`
    );
  }
  return ctx.adapter.operators.and(...conditions);
}

function getScalarState(ctx: QueryScope, fieldName: string): ScalarState {
  const scalar = ctx.model["~"].state.scalars[fieldName];
  if (!scalar) {
    throw new QueryEngineError(`Unknown scalar field '${fieldName}'.`);
  }
  return scalar["~"].state;
}
