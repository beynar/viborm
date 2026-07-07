import type { Model } from "@schema/model";
import { isSql, type Sql } from "@sql";
import { getPrimaryKeyFields } from "../../builders/correlation-utils";
import {
  buildConnectFkValues,
  type FkDirection,
} from "../../builders/relation-data-builder";
import { buildWhereUnique } from "../../builders/where-unique-builder";
import { createChildContext, getTableName } from "../../context";
import {
  NestedWriteError,
  type QueryContext,
  type RelationInfo,
} from "../../types";
import type { Guard, GuardFailure } from "./effects";
import type { Expr } from "./expr";
import type { Interp } from "./interpreter";
import type { Mode } from "./mode";
import { recordNotFoundError } from "./record-access";

// ===========================================================================
// Helpers shared by every interpret-*.ts family module: guard constructors and
// emitters, the child-context hop, and the Expr ↔ raw-carrier plumbing
// (Axis A). No semantic decision lives here — these are the leaves the family
// bodies compose.
// ===========================================================================

// --- guards -----------------------------------------------------------------

export function existsGuard(
  model: Model<any>,
  where: Sql,
  error: () => NestedWriteError,
  raceable: boolean
): Guard {
  return {
    premise: { kind: "exists", model, where },
    failure: { error, raceable },
  };
}

export async function emitTargetExistsGuard(
  interp: Interp,
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>,
  operation: string
): Promise<void> {
  const target = relationInfo.targetModel;
  const targetCtx = childCtx(ctx, relationInfo);
  const whereSql = buildWhereUnique(
    targetCtx,
    connectInput,
    getTableName(target)
  );
  await interp.emit({
    kind: "guard",
    guard: existsGuard(
      target,
      whereSql,
      () =>
        recordNotFoundError({
          relationName: relationInfo.name,
          operation,
          kind: "target",
        }),
      false
    ),
  });
}

export async function emitGuard(
  interp: Interp,
  guard: Guard | undefined
): Promise<void> {
  if (guard) {
    await interp.emit({ kind: "guard", guard });
  }
}

export function correlatedFailure(
  relationName: string,
  operation: string
): GuardFailure {
  return {
    error: () =>
      recordNotFoundError({ relationName, operation, kind: "correlated" }),
    raceable: false,
  };
}

/** The found-branch pin of a connectOrCreate probe: the probed target row must
 *  still exist where the connect lands (Pin Rule 1, kind by direction:
 *  `target`). The missing branch is never pinned (Pin Rule 2) — the create
 *  branch's own INSERT constraint enforces it. One constructor so every
 *  connectOrCreate site (before-parent, after-parent, parent-holds-FK update,
 *  m2m) carries the same typed error. */
export function connectOrCreateFoundPin(
  relationInfo: RelationInfo,
  whereSql: Sql
): Guard {
  return existsGuard(
    relationInfo.targetModel,
    whereSql,
    () =>
      recordNotFoundError({
        relationName: relationInfo.name,
        operation: "connectOrCreate",
        kind: "target",
      }),
    false
  );
}

// --- FK expr leaves ----------------------------------------------------------
// The parent's FK column Exprs resolved from the three sources a relation step
// can bind them from. The create family assigns them into the parent INSERT
// data; the update family SETs them on the existing parent row — same values,
// same missing-PK errors, resolved once here.

export function parentFkExprsFromIdentity(
  fkDir: FkDirection,
  childIdentity: Record<string, Expr>
): Record<string, Expr> {
  const fkExprs: Record<string, Expr> = {};
  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    const value = childIdentity[pkField];
    if (value === undefined) {
      throw new NestedWriteError(
        `Cannot connect relation: child is missing primary key field '${pkField}'.`,
        fkField
      );
    }
    fkExprs[fkField] = value;
  }
  return fkExprs;
}

export function parentFkExprsFromRecord(
  fkDir: FkDirection,
  record: Readonly<Record<string, unknown>>,
  relationName: string
): Record<string, Expr> {
  const fkExprs: Record<string, Expr> = {};
  for (let i = 0; i < fkDir.fkFields.length; i++) {
    const fkField = fkDir.fkFields[i]!;
    const pkField = fkDir.pkFields[i]!;
    const value = record[pkField];
    if (value === undefined) {
      throw new NestedWriteError(
        `Cannot connect relation '${relationName}': target record is missing primary key field '${pkField}'.`,
        relationName
      );
    }
    fkExprs[fkField] = { kind: "lit", value };
  }
  return fkExprs;
}

export function parentFkExprsFromConnect(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  connectInput: Record<string, unknown>
): Record<string, Expr> {
  const fkValues = buildConnectFkValues(ctx, relationInfo, connectInput);
  const fkExprs: Record<string, Expr> = {};
  for (const [field, valueSql] of Object.entries(fkValues)) {
    fkExprs[field] = { kind: "sql", sql: valueSql };
  }
  return fkExprs;
}

// --- small helpers ----------------------------------------------------------

export function childCtx(
  ctx: QueryContext,
  relationInfo: RelationInfo
): QueryContext {
  return createChildContext(ctx, relationInfo.targetModel, ctx.nextAlias());
}

/** Lower an identity Expr map to a raw carrier record keyed by field name, so the
 *  junction builders read each value as a JS literal (live mode) or a
 *  BatchValueRef carrier (planned mode) through `buildScalarSqlValue`. Used to
 *  thread both the parent PK (junction source) and a created child PK (junction
 *  target) into junction writes (§9 m2m). */
export function identityCarrierRecord(
  mode: Mode,
  identity: Record<string, Expr>
): Record<string, unknown> {
  const carrier: Record<string, unknown> = {};
  for (const [field, expr] of Object.entries(identity)) {
    carrier[field] = exprToCarrier(mode, expr);
  }
  return carrier;
}

export function hasPrimaryKeyUpdate(
  model: Model<any>,
  data: Record<string, unknown>
): boolean {
  return getPrimaryKeyFields(model).some(
    (pkField) => data[pkField] !== undefined
  );
}

/** A raw parent carrier value (literal / Sql / BatchValueRef) as an Expr for
 *  the effect `set` lowering. A Sql passes through as a `sql` Expr; everything
 *  else (including a BatchValueRef, which buildScalarSqlValue lowers) as `lit`. */
export function carrierToExpr(value: unknown): Expr {
  if (isSql(value)) {
    return { kind: "sql", sql: value };
  }
  return { kind: "lit", value };
}

export function exprToCarrier(mode: Mode, expr: Expr): unknown {
  switch (expr.kind) {
    case "lit":
      return expr.value;
    case "sql":
      return expr.sql;
    case "sym":
      return mode.symbolCarrier(expr.sym);
    default: {
      const exhaustive: never = expr;
      return exhaustive;
    }
  }
}

export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
