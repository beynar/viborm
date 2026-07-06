/**
 * Where Unique Builder
 *
 * Builds WHERE clauses from unique selector objects.
 */

import type { Sql } from "@sql";
import { getColumnName } from "../context";
import { type QueryContext, QueryEngineError } from "../types";
import { buildScalarSqlValue } from "./values-builder";

/**
 * Build WHERE from a unique input (for findUnique, update, delete)
 * Unique input can be a single field or compound key
 *
 * Handles:
 * - Single field: { id: "123" }
 * - Compound ID: { email_orgId: { email: "a@b.com", orgId: "org1" } }
 * - Named compound: { uq_name_org: { name: "Alice", orgId: "org1" } }
 */
export function buildWhereUnique(
  ctx: QueryContext,
  where: Record<string, unknown>,
  alias: string
): Sql {
  const entries = getWhereUniqueEntries(ctx, where);
  const conditions = entries.map(({ fieldName, value }) =>
    buildUniqueEquality(ctx, fieldName, value, alias)
  );

  return ctx.adapter.operators.and(...conditions);
}

export function getWhereUniqueFieldNames(
  ctx: QueryContext,
  where: Record<string, unknown>
): string[] {
  return getWhereUniqueEntries(ctx, where).map(({ fieldName }) => fieldName);
}

export type WhereUniqueEntry = {
  fieldName: string;
  value: unknown;
};

export function getWhereUniqueEntries(
  ctx: QueryContext,
  where: Record<string, unknown>
): WhereUniqueEntry[] {
  const entries: WhereUniqueEntry[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) {
      continue;
    }

    if (isUniqueScalarDiscriminator(ctx, key)) {
      entries.push({ fieldName: key, value });
      continue;
    }

    const compoundConstraint = getCompoundUniqueConstraint(ctx, key);
    if (compoundConstraint) {
      entries.push(
        ...buildCompoundUniqueConditions(ctx, key, compoundConstraint, value)
      );
      continue;
    }

    throw new QueryEngineError(
      `whereUnique field '${key}' is not a unique discriminator.`
    );
  }

  if (entries.length === 0) {
    throw new QueryEngineError(
      "whereUnique requires at least one unique discriminator."
    );
  }

  return entries;
}

function isUniqueScalarDiscriminator(ctx: QueryContext, key: string): boolean {
  return key in ctx.model["~"].state.uniques;
}

function getCompoundUniqueConstraint(
  ctx: QueryContext,
  key: string
): { entries: Record<string, unknown> } | undefined {
  const state = ctx.model["~"].state;
  return state.compoundId?.[key] ?? state.compoundUniques?.[key];
}

function buildCompoundUniqueConditions(
  ctx: QueryContext,
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
  ctx: QueryContext,
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
