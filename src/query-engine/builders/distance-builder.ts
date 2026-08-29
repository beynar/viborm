import { FeatureNotSupportedError } from "@errors";
import type { Sql } from "@sql";
import { geoBoundsForDistance } from "@validation/primitives/geo-area-codec";
import type { GeoPoint } from "@validation/primitives/geo-point-codec";
import { isRecord } from "@validation/value-guards";
import { QueryEngineError, type QueryScope } from "../types";
import {
  buildCanonicalGeoPointValue,
  requireGeoPointSql,
  trustedGeoPoint,
} from "./geo-point-builder";

type DistanceUsage = "filter" | "orderBy" | "select";
const DISTANCE_COMPARISONS: readonly ("lt" | "lte" | "gt" | "gte")[] = [
  "lt",
  "lte",
  "gt",
  "gte",
];

export type DistanceField = {
  name: string;
  scalarState:
    | {
        type: string;
        dimension?: number | undefined;
        nullable?: boolean | undefined;
      }
    | undefined;
};

export function buildDistanceExpression(
  ctx: QueryScope,
  column: Sql,
  value: unknown,
  field: DistanceField | undefined,
  usage: DistanceUsage
): Sql {
  if (field?.scalarState?.type === "vector") {
    return buildVectorDistanceExpression(ctx, column, value, field, usage);
  }
  if (field?.scalarState?.type === "point") {
    return buildPointDistanceExpression(ctx, column, value, usage);
  }
  throw new QueryEngineError(
    `Distance ${usageLabel(usage)} requires a vector or GeoPoint scalar field.`
  );
}

export function buildPointDistancePredicate(
  ctx: QueryScope,
  column: Sql,
  value: unknown,
  field: DistanceField,
  allowPrefilter: boolean
): Sql {
  if (!isRecord(value)) {
    throw new QueryEngineError(
      `GeoPoint distance filter for '${field.name}' requires an object.`
    );
  }
  const resolved = resolvePointDistance(ctx, column, value, "filter");
  const comparisons: Sql[] = [];
  const upperBound = smallestUpperBound(value);
  if (allowPrefilter && upperBound !== undefined && upperBound > 0) {
    comparisons.push(
      resolved.geoPoint.withinBounds(
        column,
        geoBoundsForDistance(resolved.target, upperBound)
      )
    );
  }
  for (const operator of DISTANCE_COMPARISONS) {
    const meters = value[operator];
    if (meters === undefined) continue;
    const operand = ctx.adapter.literals.value(meters);
    comparisons.push(
      ctx.adapter.operators[operator](resolved.expression, operand)
    );
  }
  if (comparisons.length === 0) {
    throw new QueryEngineError(
      `GeoPoint distance filter for '${field.name}' requires a comparison.`
    );
  }
  return ctx.adapter.operators.and(...comparisons);
}

function buildPointDistanceExpression(
  ctx: QueryScope,
  column: Sql,
  value: unknown,
  usage: DistanceUsage
): Sql {
  return resolvePointDistance(ctx, column, value, usage).expression;
}

function resolvePointDistance(
  ctx: QueryScope,
  column: Sql,
  value: unknown,
  usage: DistanceUsage
): {
  readonly expression: Sql;
  readonly target: GeoPoint;
  readonly geoPoint: ReturnType<typeof requireGeoPointSql>;
} {
  if (!isRecord(value)) {
    throw new QueryEngineError(
      `GeoPoint distance ${usageLabel(usage)} requires an object.`
    );
  }
  const geoPoint = requireGeoPointSql(ctx.adapter, `distance ${usage}`);
  if (!geoPoint.distance) {
    throw new FeatureNotSupportedError(
      "point",
      `distance ${usage}`,
      "GeoPoint distance is not supported by this provider."
    );
  }
  const target = trustedGeoPoint(value.to);
  const targetSql = buildCanonicalGeoPointValue(ctx.adapter, target);
  return {
    expression: geoPoint.distance(column, targetSql),
    target,
    geoPoint,
  };
}

function smallestUpperBound(
  value: Readonly<Record<string, unknown>>
): number | undefined {
  const lt = value.lt;
  const lte = value.lte;
  if (typeof lt === "number" && typeof lte === "number") {
    return Math.min(lt, lte);
  }
  if (typeof lt === "number") return lt;
  return typeof lte === "number" ? lte : undefined;
}

function buildVectorDistanceExpression(
  ctx: QueryScope,
  column: Sql,
  value: unknown,
  field: DistanceField,
  usage: DistanceUsage
): Sql {
  const label = usageLabel(usage);
  if (usage === "select" && field.scalarState?.nullable === true) {
    throw new QueryEngineError(
      `Vector distance select does not support nullable vector field '${field.name}'.`
    );
  }
  if (!ctx.adapter.capabilities.supportsVector) {
    throw new FeatureNotSupportedError(
      "vector",
      usage,
      usage === "orderBy"
        ? "vector ordering requires a pgvector-enabled PostgreSQL driver"
        : "vector distance select requires a pgvector-enabled PostgreSQL driver"
    );
  }
  if (!isRecord(value)) {
    throw new QueryEngineError(`Vector distance ${label} requires an object.`);
  }

  const to = value.to;
  const metric = value.metric;
  if (!isNumberArray(to)) {
    throw new QueryEngineError(
      `Vector distance ${label} requires 'to' to be an array of finite numbers.`
    );
  }
  if (metric !== "l2" && metric !== "cosine") {
    throw new QueryEngineError(
      `Vector distance ${label} metric must be 'l2' or 'cosine'.`
    );
  }

  const dimension = field.scalarState?.dimension;
  if (dimension !== undefined && to.length !== dimension) {
    throw new QueryEngineError(
      `Vector distance ${label} dimension mismatch for '${field.name}': expected ${dimension} values, received ${to.length}.`
    );
  }
  return ctx.adapter.vector[metric](column, ctx.adapter.vector.literal(to));
}

function usageLabel(usage: DistanceUsage): string {
  return usage === "orderBy" ? "orderBy" : usage;
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}
