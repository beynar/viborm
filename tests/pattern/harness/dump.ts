/**
 * K4 — the fragment-dump format and the oracle harness
 * (pattern-engine-ideal-state.md §13.2, unit A).
 *
 * One canonical JSON form for a compiled operation, emitted by today's engine
 * (through `routing.ts` → `planning()` on the planning driver → `compile(known)`)
 * and, later, by the pattern engine. The differential is a byte comparison of
 * two dumps. Keys are sorted, references are rendered as `{ref: "step.output"}`,
 * SQL is the adapter's prepared text with its parameter list.
 */
import type { AnyDriver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import {
  isOperationValueReference,
  type OperationFragment,
  type OperationStep,
  type PlanningFragment,
  type StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { isRecordSeries } from "@src/query-engine/write-engine/record-series";
import { constructRoutedOperation } from "@src/query-engine/write-engine/routing";
import {
  type PlanningDialect,
  PlanningDriver,
} from "@tests/fixtures/drivers/planning";
import { publishedOutputs } from "@tests/fixtures/planning-published";
import { createSchemaRegistry } from "@validation";

export type Substrate = "transaction" | "batch";

/**
 * The world the planning reads observe. Compile-level dumps are taken in both:
 * every decision read finds its row (`found`) or none does (`missing`). Both
 * engines receive the identical synthesized `known`, so the differential
 * compares the arm each one selects and the statements it packs for it.
 */
export type KnownWorld = "found" | "missing";

function sentinelFor(
  schema: Record<string, Model<any>>,
  modelName: string | undefined,
  field: string,
  stepId: string
): unknown {
  const scalar =
    modelName === undefined
      ? undefined
      : schema[modelName]?.["~"].state.scalars[field];
  const type: string | undefined = scalar?.["~"].state.type;
  const tag = `${stepId}.${field}`;
  switch (type) {
    case "int":
    case "number":
      return 1;
    case "bigint":
      return 1n;
    case "boolean":
      return true;
    case "dateTime":
    case "date":
    case "time":
      return new Date("2026-01-01T00:00:00.000Z");
    case "decimal":
      return "1.00";
    case "json":
      return { tag };
    case "blob":
      return new Uint8Array([1]);
    default:
      return tag;
  }
}

/**
 * The columns a flat planning probe requests, read from its prepared select
 * list (`… AS "alias"`). Harness-only: planning reads are flat probes, so the
 * first FROM closes the select list. Anything more elaborate would need the
 * compiler to publish its projection, which is exactly what K1's `Projection`
 * does in the pattern engine.
 */
function selectAliases(sql: string): readonly string[] {
  const upper = sql.toUpperCase();
  const start = upper.indexOf("SELECT");
  const end = upper.indexOf(" FROM ");
  if (start < 0 || end < 0) return [];
  const list = sql.slice(start + 6, end);
  const aliases: string[] = [];
  const pattern = /\sAS\s+(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))/g;
  for (const match of list.matchAll(pattern)) {
    aliases.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return aliases;
}

/**
 * Synthesize the planning outputs `compile` consumes. A `rows` output becomes
 * one row carrying every column the probe requests plus every `firstRowField`
 * it declares, or an empty array in the `missing` world for branch reads. Other
 * output kinds are exposed as references, exactly as the executor exposes them
 * under `planningKey(step, name)`.
 */
export function synthesizeKnown(
  schema: Record<string, Model<any>>,
  driver: PlanningDriver,
  planning: PlanningFragment,
  world: KnownWorld
): Readonly<Record<string, unknown>> {
  const known: Record<string, unknown> = { ...publishedOutputs(planning) };
  for (const step of planning.steps) {
    const declared = Object.values(step.outputs).flatMap((source) =>
      source.kind === "firstRowField" ? [source.field] : []
    );
    const requested = selectAliases(driver._prepare(step.statement).sql);
    const fields = [...new Set([...requested, ...declared])];
    // A read with a postcondition is required (ATOM §11): it finds its row in
    // every world. Only branch reads (no postcondition) are emptied.
    const found = world === "found" || step.expects !== undefined;
    for (const [name, source] of Object.entries(step.outputs)) {
      if (source.kind !== "rows") continue;
      const row = Object.fromEntries(
        fields.map((field) => [
          field,
          sentinelFor(schema, step.model, field, step.id),
        ])
      );
      known[`${step.id}.${name}`] = found ? [row] : [];
    }
  }
  return known;
}

export interface DumpStep {
  readonly position: number;
  readonly id: string;
  readonly kind: "read" | "write" | "guard" | "recordSeries";
  readonly sql?: string;
  readonly params?: unknown;
  readonly outputs?: unknown;
  readonly expects?: unknown;
  readonly racePin?: unknown;
  readonly onUniqueConflict?: unknown;
  readonly model?: string;
  readonly premise?: {
    readonly kind: string;
    readonly sql: string;
    readonly params: unknown;
  };
  readonly failure?: unknown;
  readonly progressive?: unknown;
}

export interface Dump {
  readonly operation: string;
  readonly model: string;
  readonly substrate: Substrate;
  readonly dialect: PlanningDialect;
  readonly world: KnownWorld;
  readonly kind: "operation" | "recordSeries";
  readonly planning: readonly DumpStep[];
  readonly final: readonly DumpStep[];
  readonly outputs: unknown;
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly code?: unknown;
  };
}

export function planningDriver(
  dialect: PlanningDialect,
  substrate: Substrate
): PlanningDriver {
  return substrate === "transaction"
    ? new PlanningDriver(dialect)
    : new PlanningDriver(dialect, {
        supportsTransactions: false,
        supportsBatch: true,
      });
}

export function engineFor(
  schema: Record<string, Model<any>>,
  driver: AnyDriver
): QueryEngine {
  return new QueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

function canonical(value: unknown): unknown {
  if (isOperationValueReference(value))
    return { ref: `${value.step}.${value.output}` };
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return { date: value.toISOString() };
  if (typeof value === "bigint") return { bigint: value.toString() };
  if (value instanceof Uint8Array)
    return { bytes: Buffer.from(value).toString("base64") };
  if (!(value && typeof value === "object")) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => [key, canonical(member)])
  );
}

function statement(
  driver: PlanningDriver,
  step: StatementStep
): { sql: string; params: unknown } {
  const query = driver._prepare(step.statement);
  return { sql: query.sql, params: canonical(query.params) };
}

function dumpStep(
  driver: PlanningDriver,
  step: OperationStep,
  position: number
): DumpStep {
  if (step.kind === "guard") {
    const query = driver._prepare(step.premise.statement);
    return {
      position,
      id: step.id,
      kind: "guard",
      premise: {
        kind: step.premise.kind,
        sql: query.sql,
        params: canonical(query.params),
      },
      failure: canonical(step.failure),
    };
  }
  if (step.kind === "recordSeries") {
    return {
      position,
      id: step.id,
      kind: "recordSeries",
      progressive:
        step.progressive.kind === "guarded"
          ? {
              kind: "guarded",
              guard: dumpStep(driver, step.progressive.guard, -1),
            }
          : canonical(step.progressive),
    };
  }
  return {
    position,
    id: step.id,
    kind: step.kind,
    ...statement(driver, step),
    outputs: canonical(step.outputs),
    expects: canonical(step.expects ?? null),
    racePin: step.kind === "write" ? canonical(step.racePin ?? null) : null,
    onUniqueConflict:
      step.kind === "write" ? (step.onUniqueConflict ?? null) : null,
    model: step.model,
  };
}

function dumpFragment(
  driver: PlanningDriver,
  fragment: PlanningFragment | OperationFragment
): readonly DumpStep[] {
  return fragment.steps.map((step, index) => dumpStep(driver, step, index));
}

/**
 * Dump one operation on today's engine. Errors thrown before I/O (validation,
 * legality, construction, packing-time refusals) are part of the contract and
 * are dumped as such rather than propagated.
 */
export function dumpOperation(
  schema: Record<string, Model<any>>,
  model: Model<any>,
  modelName: string,
  operation: string,
  args: Record<string, unknown>,
  dialect: PlanningDialect,
  substrate: Substrate,
  world: KnownWorld = "found"
): Dump {
  const driver = planningDriver(dialect, substrate);
  const engine = engineFor(schema, driver);
  const base = {
    operation,
    model: modelName,
    substrate,
    dialect,
    world,
  } as const;
  try {
    const routed = constructRoutedOperation(engine, model, operation, args);
    if (!routed) throw new Error(`not a routed operation: ${operation}`);
    if (isRecordSeries(routed)) {
      return {
        ...base,
        kind: "recordSeries",
        planning: [],
        final: [],
        outputs: null,
      };
    }
    const planning = routed.planning();
    const known = synthesizeKnown(schema, driver, planning, world);
    const final = routed.compile(known);
    return {
      ...base,
      kind: "operation",
      planning: dumpFragment(driver, planning),
      final: dumpFragment(driver, final),
      outputs: canonical(publishedOutputs(final)),
    };
  } catch (error) {
    const e = error as { name?: string; message?: string; code?: unknown };
    return {
      ...base,
      kind: "operation",
      planning: [],
      final: [],
      outputs: null,
      error: {
        name: String(e?.name ?? "Error"),
        message: String(e?.message ?? error),
        code: e?.code,
      },
    };
  }
}

export function serializeDump(dump: Dump): string {
  return JSON.stringify(canonical(dump), null, 2);
}
