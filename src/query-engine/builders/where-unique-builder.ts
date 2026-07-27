/**
 * Where Unique Builder
 *
 * Builds WHERE clauses from unique selector objects.
 *
 * ## The two halves of a unique `where`, and why they are separate
 *
 * Since Prisma >= 4.5 a top-level unique `where` may carry, alongside its unique
 * DISCRIMINATOR (a single unique field, or a complete compound constraint),
 * ordinary non-unique scalar FILTERS and `AND` / `OR` / `NOT`. The two halves are
 * not interchangeable, and this module is where that distinction is enforced:
 *
 * - {@link buildWhereUnique} compiles **both** halves — the row a statement
 *   addresses is `discriminator ∧ filters`.
 * - {@link getWhereUniqueEntries} returns **only** the discriminator. Every
 *   consumer that reads a `where` as a set of compile-time LITERALS goes through
 *   it: the Pin Rule (a nested create pins the parent column the `where` fixes),
 *   `racePin` attribution (`uniqueConflictTarget`), upsert's probe-first locate,
 *   the own-write ledger's target constraints, and cursor comparison. An extra
 *   filter is a PREDICATE, not a value: it can never name the row, so it must
 *   never contribute a pin, a conflict target, or an identity.
 *
 * Keeping the split in the extraction function rather than at each call site is
 * deliberate: a new consumer that reaches for the discriminator gets the right
 * half by default, and forgetting to strip filters is not a thing one can do.
 *
 * **What the discriminator is NOT.** It names the row the caller ASKED FOR — it
 * does not name a row a statement WROTE. A write's own result must be addressed
 * by the identity of that write (a literal primary key, or the identity the
 * INSERT captured), never by the selector that chose its arm: `create` data is
 * under no obligation to satisfy `where`, so the two can name different rows.
 * That is why nothing here exposes "the discriminator as a where" — see
 * `UpsertOperation.createArmIdentity`.
 */

import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { getColumnName, isRelation } from "../context";
import { QueryEngineError, type QueryScope } from "../types";
import { buildScalarSqlValue } from "./values-builder";
import { buildWhere } from "./where-builder";

const LOGICAL_KEYS: ReadonlySet<string> = new Set(["AND", "OR", "NOT"]);

/**
 * Build WHERE from a unique input (for findUnique, update, delete)
 * Unique input can be a single field or compound key, optionally narrowed by
 * non-unique scalar filters and AND/OR/NOT (Prisma >= 4.5).
 *
 * Handles:
 * - Single field: { id: "123" }
 * - Compound ID: { email_orgId: { email: "a@b.com", orgId: "org1" } }
 * - Named compound: { uq_name_org: { name: "Alice", orgId: "org1" } }
 * - Extended: { id: "123", archived: { equals: false }, NOT: { role: "admin" } }
 */
export function buildWhereUnique(
  ctx: QueryScope,
  where: Record<string, unknown>,
  alias: string
): Sql {
  const { entries, filters } = partitionWhereUnique(ctx, where);
  const conditions = entries.map(({ fieldName, value }) =>
    buildUniqueEquality(ctx, fieldName, value, alias)
  );

  if (filters) {
    assertScalarOnlyFilter(ctx.model, filters);
    const filterSql = buildWhere(ctx, filters, alias);
    if (filterSql) conditions.push(filterSql);
  }

  return ctx.adapter.operators.and(...conditions);
}

export function getWhereUniqueFieldNames(
  ctx: QueryScope,
  where: Record<string, unknown>
): string[] {
  return getWhereUniqueEntries(ctx, where).map(({ fieldName }) => fieldName);
}

export type WhereUniqueEntry = {
  fieldName: string;
  value: unknown;
};

export type WhereUniquePartition = {
  /** The unique discriminator, flattened to one entry per constrained column. */
  readonly entries: WhereUniqueEntry[];
  /** The discriminator's own keys, as written (a compound stays one key). */
  readonly discriminator: Record<string, unknown>;
  /** The non-unique remainder: scalar filters and AND/OR/NOT. */
  readonly filters: Record<string, unknown> | undefined;
};

type WhereUniqueModelContext = { model: Model<any> };

/**
 * Split a unique `where` into its discriminator and its extra filters.
 *
 * A key is a discriminator iff it names a single-field unique or a compound
 * constraint; a compound must be COMPLETE (every field present) or this throws,
 * exactly as before — a half-specified compound names no row. Anything else is
 * filter material. At least one discriminator is required.
 */
export function partitionWhereUnique(
  ctx: WhereUniqueModelContext,
  where: Record<string, unknown>
): WhereUniquePartition {
  const entries: WhereUniqueEntry[] = [];
  const discriminator: Record<string, unknown> = {};
  let filters: Record<string, unknown> | undefined;

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) {
      continue;
    }

    if (isUniqueScalarDiscriminator(ctx, key)) {
      entries.push({ fieldName: key, value });
      discriminator[key] = value;
      continue;
    }

    const compoundConstraint = getCompoundUniqueConstraint(ctx, key);
    if (compoundConstraint) {
      entries.push(
        ...buildCompoundUniqueConditions(key, compoundConstraint, value)
      );
      discriminator[key] = value;
      continue;
    }

    // Not a discriminator: an extended `where`'s filter half. It narrows the row
    // the statement addresses and NEVER contributes a pin (see the module note).
    filters ??= {};
    filters[key] = value;
  }

  if (entries.length === 0) {
    throw new QueryEngineError(
      "whereUnique requires at least one unique discriminator."
    );
  }

  return { entries, discriminator, filters };
}

/** The extra (non-discriminator) filter half of a unique `where`, if any. */
export function getWhereUniqueFilters(
  ctx: WhereUniqueModelContext,
  where: Record<string, unknown>
): Record<string, unknown> | undefined {
  return partitionWhereUnique(ctx, where).filters;
}

/**
 * The unique discriminator of a `where`, flattened to one entry per constrained
 * column. Extra filters are NOT here, by construction — see the module note.
 */
export function getWhereUniqueEntries(
  ctx: WhereUniqueModelContext,
  where: Record<string, unknown>
): WhereUniqueEntry[] {
  return partitionWhereUnique(ctx, where).entries;
}

/**
 * The engine-side half of the relation refusal the extended-whereUnique schema
 * states (`src/validation/model/core/where.ts`). A unique `where`'s filter half
 * compiles into UPDATE / DELETE too, where the target table carries no alias and
 * MySQL rejects a subquery reading the table being mutated — so a relation
 * filter cannot be answered identically on every dialect from this position.
 * The schema rejects it first; this keeps the builder fail-closed for any
 * internally-constructed selector that never passed the schema.
 */
function assertScalarOnlyFilter(
  model: Model<any>,
  filter: Record<string, unknown>
): void {
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (LOGICAL_KEYS.has(key)) {
      const operands = Array.isArray(value) ? value : [value];
      for (const operand of operands) {
        if (operand !== null && typeof operand === "object") {
          assertScalarOnlyFilter(model, operand as Record<string, unknown>);
        }
      }
      continue;
    }
    if (isRelation(model, key)) {
      throw new QueryEngineError(
        `Relation filter '${key}' is not supported inside a unique 'where'. An extended unique 'where' accepts non-unique scalar filters and AND/OR/NOT only.`
      );
    }
  }
}

function isUniqueScalarDiscriminator(
  ctx: WhereUniqueModelContext,
  key: string
): boolean {
  return key in ctx.model["~"].state.uniques;
}

function getCompoundUniqueConstraint(
  ctx: WhereUniqueModelContext,
  key: string
): { entries: Record<string, unknown> } | undefined {
  const state = ctx.model["~"].state;
  return state.compoundId?.[key] ?? state.compoundUniques?.[key];
}

function buildCompoundUniqueConditions(
  key: string,
  compoundConstraint: { entries: Record<string, unknown> },
  value: unknown
): WhereUniqueEntry[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QueryEngineError(
      `Compound whereUnique field '${key}' must be an object.`
    );
  }

  const compound = value as Record<string, unknown>;
  const expectedFields = Object.keys(compoundConstraint.entries);
  const expectedFieldSet = new Set(expectedFields);

  for (const fieldName of Object.keys(compound)) {
    if (!expectedFieldSet.has(fieldName)) {
      throw new QueryEngineError(
        `Unknown field '${fieldName}' in compound whereUnique field '${key}'.`
      );
    }
  }

  const entries: WhereUniqueEntry[] = [];
  for (const fieldName of expectedFields) {
    const fieldValue = compound[fieldName];
    if (fieldValue === undefined) {
      throw new QueryEngineError(
        `Compound whereUnique field '${key}' requires '${fieldName}'.`
      );
    }

    entries.push({ fieldName, value: fieldValue });
  }

  if (entries.length === 0) {
    throw new QueryEngineError(
      `Compound whereUnique field '${key}' must include at least one field.`
    );
  }

  return entries;
}

function buildUniqueEquality(
  ctx: QueryScope,
  fieldName: string,
  value: unknown,
  alias: string
): Sql {
  const columnName = getColumnName(ctx.model, fieldName);
  const column = ctx.adapter.identifiers.column(alias, columnName);
  return ctx.adapter.operators.eq(
    column,
    buildScalarSqlValue(ctx, ctx.model, fieldName, value)
  );
}
