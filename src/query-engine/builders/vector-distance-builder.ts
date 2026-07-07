import { FeatureNotSupportedError } from "@errors";
import type { Sql } from "@sql";
import { type QueryContext, QueryEngineError } from "../types";

type VectorDistanceMetric = "l2" | "cosine";
type VectorDistanceUsage = "orderBy" | "select";

type VectorDistanceField = {
  name: string;
  scalarState:
    | {
        type: string;
        dimension?: number | undefined;
      }
    | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isVectorDistanceMetric = (
  value: unknown
): value is VectorDistanceMetric => {
  return value === "l2" || value === "cosine";
};

const isNumberArray = (value: unknown): value is number[] => {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
};

const getUsageLabel = (usage: VectorDistanceUsage): string =>
  usage === "orderBy" ? "orderBy" : "select";

const getUnsupportedMessage = (usage: VectorDistanceUsage): string =>
  usage === "orderBy"
    ? "vector ordering requires a pgvector-enabled PostgreSQL driver"
    : "vector distance select requires a pgvector-enabled PostgreSQL driver";

export function buildVectorDistanceExpression(
  ctx: QueryContext,
  column: Sql,
  value: unknown,
  field: VectorDistanceField | undefined,
  usage: VectorDistanceUsage
): Sql {
  const label = getUsageLabel(usage);

  if (field?.scalarState?.type !== "vector") {
    throw new QueryEngineError(
      `Vector distance ${label} requires a vector scalar field.`
    );
  }

  if (!ctx.adapter.capabilities.supportsVector) {
    throw new FeatureNotSupportedError(
      "vector",
      usage,
      getUnsupportedMessage(usage)
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
  if (!isVectorDistanceMetric(metric)) {
    throw new QueryEngineError(
      `Vector distance ${label} metric must be 'l2' or 'cosine'.`
    );
  }

  const dimension = field.scalarState.dimension;
  if (dimension !== undefined && to.length !== dimension) {
    throw new QueryEngineError(
      `Vector distance ${label} dimension mismatch for '${field.name}': expected ${dimension} values, received ${to.length}.`
    );
  }

  return ctx.adapter.vector[metric](column, ctx.adapter.vector.literal(to));
}
