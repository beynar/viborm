import { type JsonNullKind, jsonNullKindOf } from "@schema/json-null";
import type { ScalarState } from "@schema/scalars";
import type { Sql } from "@sql";
import { QueryEngineError, type QueryScope } from "../types";
import { assertSupportedScalarFilterOperator } from "./scalar-filter-operators";

/**
 * What `path` and `mode` scope for one JSON filter object. Both are
 * modifiers, not operations: they are inherited by a nested `not` filter
 * unless that filter sets its own.
 */
type JsonFilterScope = {
  path: string[];
  mode: "default" | "insensitive";
};

const ROOT_SCOPE: JsonFilterScope = { path: [], mode: "default" };

/**
 * The operators `mode: "insensitive"` governs. `equals`/`not`/`array_*`
 * compare whole JSON values, not text, so folding them would be meaningless
 * — which is why an inert `mode` is refused rather than ignored.
 */
const MODE_GOVERNED_OPERATORS = [
  "string_contains",
  "string_starts_with",
  "string_ends_with",
] as const;

/**
 * A filter object's own `mode` wins over the inherited one in BOTH
 * directions, so `not: { string_contains: "x", mode: "default" }` really does
 * restore exact matching on that arm. (The scalar where-builder only lets a
 * nested mode upgrade to insensitive; JSON honors the key as written rather
 * than accepting it and doing nothing.)
 */
function resolveJsonFilterMode(
  declared: unknown,
  inherited: JsonFilterScope["mode"]
): JsonFilterScope["mode"] {
  if (declared === "insensitive") return "insensitive";
  if (declared === "default") return "default";
  return inherited;
}

const JSON_PATH_ARRAY_INDEX = /^\d+$/;

function rejectJsonPathString(
  fieldName: string,
  raw: string,
  reason: string
): never {
  throw new QueryEngineError(
    `JSON filter for field '${fieldName}' has an unsupported path string '${raw}': ${reason}. The supported grammar is '$', '$.key', '$.key[0]' and nothing else; use the array form (path: ['a', 'b']) for keys containing '.', '[' or ']'.`
  );
}

/**
 * Parse Prisma-MySQL's string path form ('$.a.b', '$.arr[0]') into the array
 * form the rest of the builder and every adapter already speak.
 *
 * The grammar is DELIBERATELY small: '$' root, '.key' object steps, '[N]'
 * array indices. Quoted labels ('$."a b"'), wildcards ('$.*', '$**', '[*]'),
 * '[last]' and negative indices are REFUSED rather than half-supported —
 * SQLite's path grammar has no escape syntax inside quoted labels, so a
 * larger grammar could not stay portable. A '.' inside a key is a separator
 * here and can only be spelled with the array form (path: ['weird.key']).
 * Segments carrying '"' or '\\' fall through to assertPortableJsonPath,
 * which refuses them exactly as it does for the array form.
 */
function parseJsonStringPath(fieldName: string, raw: string): string[] {
  if (!raw.startsWith("$")) {
    rejectJsonPathString(fieldName, raw, "a path string must start with '$'");
  }
  const segments: string[] = [];
  let index = 1;
  while (index < raw.length) {
    const char = raw[index];
    if (char === ".") {
      index += 1;
      const start = index;
      while (index < raw.length && raw[index] !== "." && raw[index] !== "[") {
        index += 1;
      }
      const key = raw.slice(start, index);
      if (key.length === 0) {
        rejectJsonPathString(fieldName, raw, "an object key may not be empty");
      }
      if (key.includes("*")) {
        // '$.*' means "any member" in MySQL's JSONPath. Reading it as a key
        // literally named '*' would silently answer a different question,
        // so refuse it; a real '*' key is addressable via the array form.
        rejectJsonPathString(fieldName, raw, "wildcards are not supported");
      }
      segments.push(key);
      continue;
    }
    if (char === "[") {
      const close = raw.indexOf("]", index);
      if (close === -1) {
        rejectJsonPathString(fieldName, raw, "an unclosed '['");
      }
      const digits = raw.slice(index + 1, close);
      if (!JSON_PATH_ARRAY_INDEX.test(digits)) {
        rejectJsonPathString(
          fieldName,
          raw,
          `'[${digits}]' is not a non-negative integer array index`
        );
      }
      segments.push(digits);
      index = close + 1;
      continue;
    }
    rejectJsonPathString(fieldName, raw, `unexpected '${char}'`);
  }
  return segments;
}

/** Both Prisma path spellings normalize to the array form here. */
function resolveJsonPath(
  fieldName: string,
  declared: unknown,
  inherited: string[]
): string[] {
  if (Array.isArray(declared)) return declared.map(String);
  if (typeof declared === "string") {
    return parseJsonStringPath(fieldName, declared);
  }
  return inherited;
}

/**
 * Build a JSON scalar filter. `path` scopes every other operator in the
 * filter object to the value at that path (Prisma semantics); without a
 * path, operators apply to the document root. A nested `not` filter
 * inherits the outer path and mode unless it sets its own.
 */
export function buildJsonFilter(
  ctx: QueryScope,
  fieldName: string,
  scalarState: ScalarState,
  column: Sql,
  filter: Record<string, unknown>,
  inherited: JsonFilterScope = ROOT_SCOPE
): Sql {
  const scope: JsonFilterScope = {
    path: resolveJsonPath(fieldName, filter.path, inherited.path),
    mode: resolveJsonFilterMode(filter.mode, inherited.mode),
  };
  assertPortableJsonPath(fieldName, scope.path);
  assertModeGovernsSomething(fieldName, filter);
  // Root comparisons keep the bare column (same SQL as before path filters
  // existed); extraction only happens once a path scopes the target
  const target = scope.path.length
    ? ctx.adapter.json.extract(column, scope.path)
    : column;
  const conditions: Sql[] = [];

  for (const [op, value] of Object.entries(filter)) {
    if (value === undefined || op === "path" || op === "mode") {
      continue;
    }
    assertSupportedScalarFilterOperator(fieldName, scalarState, op);
    conditions.push(
      buildJsonFilterOperation(
        ctx,
        fieldName,
        scalarState,
        column,
        target,
        scope,
        op,
        value
      )
    );
  }

  if (conditions.length === 0) {
    throw new QueryEngineError(
      `Filter for field '${fieldName}' must contain at least one operation.`
    );
  }
  return ctx.adapter.operators.and(...conditions);
}

/**
 * Fail closed on an inert `mode: "insensitive"`. A mode declared on THIS
 * object must govern a string operator here, or a nested `not` that inherits
 * it; otherwise the engine would accept the key and silently do nothing.
 * Inherited modes are exempt — `{ mode, string_contains, not: { equals } }`
 * is legitimate, and only the arm that spelled `mode` has to justify it.
 *
 * A SENTINEL `not` (`not: DbNull`) is not an exemption: it inherits nothing
 * and case-folds nothing, so a mode declared beside it governs exactly
 * nothing and has to be refused like any other inert one.
 */
function assertModeGovernsSomething(
  fieldName: string,
  filter: Record<string, unknown>
): void {
  if (filter.mode !== "insensitive") return;
  if (filter.not !== undefined && jsonNullKindOf(filter.not) === undefined) {
    return;
  }
  const governed = MODE_GOVERNED_OPERATORS.some(
    (operator) => filter[operator] !== undefined
  );
  if (governed) return;
  throw new QueryEngineError(
    `JSON filter for field '${fieldName}' sets mode: 'insensitive' but has no string_contains/string_starts_with/string_ends_with operation for it to apply to.`
  );
}

function assertPortableJsonPath(fieldName: string, path: string[]): void {
  const invalidSegment = path.find(
    (segment) => segment.includes('"') || segment.includes("\\")
  );
  if (invalidSegment === undefined) return;
  throw new QueryEngineError(
    `JSON filter for field '${fieldName}' requires a portable JSON path; segments containing '"' or '\\' are not supported.`
  );
}

/**
 * JSON lt/lte/gt/gte. THE PINNED SEMANTICS (identical on every dialect):
 *
 * - The operand's JS type picks the comparison class. A number compares
 *   numerically and ONLY against JSON numbers; a string compares
 *   lexicographically by code point and ONLY against JSON strings. A JSON
 *   string "42" never satisfies `gt: 40`, and the number 42 never satisfies
 *   `gt: "40"` — Prisma's JsonFilter has one operand slot per class, and
 *   cross-class coercion is where the dialects diverge (MySQL coerces,
 *   PG raises, SQLite type-orders).
 * - A row whose path is absent, whose column is NULL, or whose value at the
 *   path is of the other class (or bool/null/object/array) NEVER matches and
 *   NEVER errors: `numberAtPath`/`stringAtPath` yield SQL NULL there, and
 *   NULL fails every comparison.
 * - Ordering is byte/code-point ordering, not the database's locale
 *   collation — see the adapters' `stringAtPath`.
 */
function buildJsonComparison(
  ctx: QueryScope,
  fieldName: string,
  column: Sql,
  path: string[],
  operation: "lt" | "lte" | "gt" | "gte",
  value: unknown
): Sql {
  const { adapter } = ctx;
  const compare = adapter.operators[operation];

  if (typeof value === "number") {
    return compare(
      adapter.json.numberAtPath(column, path),
      adapter.literals.value(value)
    );
  }
  if (typeof value === "string") {
    return compare(
      adapter.json.stringAtPath(column, path),
      adapter.literals.value(value)
    );
  }
  throw new QueryEngineError(
    `JSON filter '${operation}' for field '${fieldName}' requires a number or string operand.`
  );
}

/**
 * THE JSON NULL TRUTH TABLE (identical on PostgreSQL, MySQL and SQLite).
 *
 * A nullable JSON column has two nulls; these are the six predicates that tell
 * them apart. `column IS NULL` is the SQL NULL; `column = <json null>` is the
 * stored JSON document `null` (`'null'::jsonb`, `CAST('null' AS JSON)`, the
 * canonical text `null` — whatever `adapter.json.value` binds, which is exactly
 * what the write path stores for `JsonNull`).
 *
 *   equals: DbNull    ->  col IS NULL
 *   equals: JsonNull  ->  col = 'null'
 *   equals: AnyNull   ->  col IS NULL OR col = 'null'
 *   not: DbNull       ->  col IS NOT NULL                (matches JSON nulls)
 *   not: JsonNull     ->  col <> 'null'                  (SQL NULLs excluded)
 *   not: AnyNull      ->  col IS NOT NULL AND col <> 'null'
 *
 * `not: JsonNull` excluding SQL-NULL rows is not an oversight: a value
 * comparison against a SQL NULL is UNKNOWN, and this codebase already pins that
 * for JSON (`not: { equals: <doc> }` excludes NULL rows too — see the shared
 * driver suite). `not: DbNull` is the one that CAN be total, because
 * `IS NOT NULL` is never unknown, and it is spelled that way.
 *
 * Under a `path` the sentinels are REFUSED rather than reinterpreted: `DbNull`
 * would have to ignore the path (it is a property of the column, not of the
 * value at the path), and "the value at this path is the JSON null" already has
 * a pinned spelling — `path: [...], equals: null`. Answering a different
 * question than the one asked is what the refusal exists to prevent.
 */
function buildJsonNullSentinelFilter(
  ctx: QueryScope,
  fieldName: string,
  column: Sql,
  path: string[],
  kind: JsonNullKind,
  negated: boolean
): Sql {
  if (path.length > 0) {
    throw new QueryEngineError(
      `JSON filter for field '${fieldName}' cannot combine 'path' with the ${kind} sentinel: the sentinels distinguish the database NULL from the JSON null value of the WHOLE column. Use 'path' with 'equals: null' to test for a JSON null at that path.`
    );
  }
  const { adapter } = ctx;
  const jsonNull = () => adapter.json.value(null);

  switch (kind) {
    case "DbNull":
      return negated
        ? adapter.operators.isNotNull(column)
        : adapter.operators.isNull(column);
    case "JsonNull":
      return negated
        ? adapter.operators.neq(column, jsonNull())
        : adapter.operators.eq(column, jsonNull());
    default:
      return negated
        ? adapter.operators.and(
            adapter.operators.isNotNull(column),
            adapter.operators.neq(column, jsonNull())
          )
        : adapter.operators.or(
            adapter.operators.isNull(column),
            adapter.operators.eq(column, jsonNull())
          );
  }
}

function buildJsonFilterOperation(
  ctx: QueryScope,
  fieldName: string,
  scalarState: ScalarState,
  column: Sql,
  target: Sql,
  scope: JsonFilterScope,
  operation: string,
  value: unknown
): Sql {
  const { adapter } = ctx;
  const { path } = scope;
  // Extracted values compare in the dialect's JSON format on every side
  // (jsonb param on PG, CAST(? AS JSON) on MySQL, canonical text on SQLite)
  const jsonValue = (v: unknown) => adapter.json.value(v);
  // Portable insensitive mode folds ASCII A-Z on BOTH sides, then uses the
  // same exact-text predicates as default mode — the identical trick the
  // where-builder plays on string scalars, so JSON and scalar insensitive
  // filters agree with each other and across dialects.
  const fold = (expr: Sql) =>
    scope.mode === "insensitive"
      ? adapter.expressions.asciiCaseFold(expr)
      : expr;
  // string_* params are plain text compared against extractText output.
  const textValue = (v: unknown) => fold(adapter.literals.value(v));
  const textTarget = () => fold(adapter.json.extractText(column, path));

  // A sentinel IS an object, so both arms have to recognize it before the
  // generic branches below would read its keys as filter operations.
  const sentinel = jsonNullKindOf(value);

  switch (operation) {
    case "equals":
      if (sentinel) {
        return buildJsonNullSentinelFilter(
          ctx,
          fieldName,
          column,
          path,
          sentinel,
          false
        );
      }
      if (value === null && path.length === 0) {
        return adapter.operators.isNull(column);
      }
      // With a path, null compares against JSON null at that path; missing
      // keys extract to SQL NULL and never match
      return adapter.operators.eq(target, jsonValue(value));

    case "not":
      if (sentinel) {
        return buildJsonNullSentinelFilter(
          ctx,
          fieldName,
          column,
          path,
          sentinel,
          true
        );
      }
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        return adapter.operators.not(
          buildJsonFilter(
            ctx,
            fieldName,
            scalarState,
            column,
            value as Record<string, unknown>,
            scope
          )
        );
      }
      if (value === null && path.length === 0) {
        return adapter.operators.isNotNull(column);
      }
      return adapter.operators.neq(target, jsonValue(value));

    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return buildJsonComparison(
        ctx,
        fieldName,
        column,
        path,
        operation,
        value
      );

    case "string_contains":
      return adapter.operators.containsText(textTarget(), textValue(value));

    case "string_starts_with":
      return adapter.operators.startsWithText(textTarget(), textValue(value));

    case "string_ends_with":
      return adapter.operators.endsWithText(textTarget(), textValue(value));

    case "array_contains": {
      // Scalar candidates normalize to one-element arrays so every dialect
      // shares PG's array-containment semantics
      const candidate = Array.isArray(value) ? value : [value];
      return adapter.json.contains(target, jsonValue(candidate));
    }

    case "array_starts_with":
      return adapter.operators.eq(
        adapter.json.extract(column, [...path, "0"]),
        jsonValue(value)
      );

    case "array_ends_with":
      return adapter.operators.eq(
        adapter.json.lastElement(target),
        jsonValue(value)
      );

    default:
      throw new QueryEngineError(
        `Unknown filter operation '${operation}' for field '${fieldName}'.`
      );
  }
}
