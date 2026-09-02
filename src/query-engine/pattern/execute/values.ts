/**
 * Unit F — the runtime vocabulary every enforcer shares
 * (pattern-engine-ideal-state.md §8, §13.3).
 *
 * A fragment's statements bind values (a matched row, a returned key, an
 * insert id, a row count) and consume them (as parameters). This module owns
 * how a bound value is stored, how a consuming statement is materialized, how a
 * statement's declared outputs are read from a provider result, how a
 * postcondition is enforced, and how the program's terminal outputs resolve.
 * The three enforcers differ only in WHEN they do these things and under which
 * atomicity; none of them re-spells any of it.
 *
 * Everything here is a port of the observable behavior of
 * `write-engine/OperationExecutor.ts` (its `RuntimeValues`, `extractOutputs`,
 * `enforcePostcondition`, `materialize*Sql`, `resolveFragmentOutputs`), kept
 * byte-compatible in error text so the differential (K4) compares equal.
 */
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { deriveStatementExecutionContext } from "@drivers/execution-context";
import type { QueryResult } from "@drivers/types";
import { QueryEngineError, TransactionError } from "@errors";
import { isSql, Sql } from "@sql";
import type { ResultParser } from "../../result/ResultParser";
import {
  assertExpectedRowKeys,
  normalizeResultRows,
} from "../../result/result-parser-contract";
import type { ExpectedResultShape, Operation } from "../../types";
import {
  createFailureError,
  isOperationValueReference,
  type OperationValueReference,
  ref,
  type StatementOutputSource,
  type StatementStep,
  statementHasReferences,
} from "../../write-engine/OperationFragment";
import type { Fragment, Program } from "../fragment";

/** `step id → output name → value`: what the run has bound so far. */
export type RuntimeValues = Map<string, Map<string, unknown>>;

/** Attribution for engine-owned failures: the public model and operation. */
export interface Attribution {
  readonly model: string;
  readonly operation: string;
}

export function attributionOf(program: Program): Attribution {
  return { model: program.model, operation: program.operation };
}

export function cloneRuntimeValues(values: RuntimeValues): RuntimeValues {
  const cloned: RuntimeValues = new Map();
  for (const [step, outputs] of values) {
    cloned.set(step, new Map(outputs));
  }
  return cloned;
}

export function mergeRuntimeValues(
  target: RuntimeValues,
  source: RuntimeValues
): void {
  for (const [step, outputs] of source) {
    target.set(step, new Map(outputs));
  }
}

export function setRuntimeValue(
  values: RuntimeValues,
  step: string,
  output: string,
  value: unknown
): void {
  let outputs = values.get(step);
  if (!outputs) {
    outputs = new Map();
    values.set(step, outputs);
  }
  outputs.set(output, value);
}

export function resolveRuntimeValue(
  reference: OperationValueReference,
  values: RuntimeValues
): unknown {
  const outputs = values.get(reference.step);
  if (!outputs?.has(reference.output)) {
    throw new QueryEngineError(
      `Operation reference '${reference.step}.${reference.output}' is unresolved.`
    );
  }
  return outputs.get(reference.output);
}

/**
 * Materialize a statement for its own round trip: every reference becomes the
 * concrete value the run bound. An optional `firstRowField` that matched no row
 * is the ONE source that resolves to `undefined`, and its meaning is SQL NULL
 * (the untaken arm of a two-arm write must match nothing on every driver).
 */
export function materializeLinearSql(
  statement: Sql,
  values: RuntimeValues
): Sql {
  if (!statementHasReferences(statement)) return statement;
  return new Sql(
    statement.strings,
    statement.values.map((value) => {
      if (!isOperationValueReference(value)) return value;
      const resolved = resolveRuntimeValue(value, values);
      if (isSql(resolved)) {
        throw new QueryEngineError(
          `Operation reference '${value.step}.${value.output}' is not a concrete runtime value.`
        );
      }
      return resolved ?? null;
    })
  );
}

/**
 * Materialize a statement for an atomic unit: a reference may resolve to a
 * batch-local scratch expression (the adapter's `batchRefs.read`), which is
 * spliced as SQL rather than bound.
 */
export function materializeBatchSql(
  statement: Sql,
  values: RuntimeValues
): Sql {
  if (!statementHasReferences(statement)) return statement;
  return new Sql(
    statement.strings,
    statement.values.map((value) =>
      isOperationValueReference(value)
        ? resolveRuntimeValue(value, values)
        : value
    )
  );
}

/**
 * Read a statement's declared outputs from its provider result. A write whose
 * skip effect absorbed a unique violation made no row and so produced no
 * insert id: that absence IS the skip, and the output resolves to `undefined`.
 */
export function extractOutputs(
  step: StatementStep,
  result: QueryResult<unknown>,
  values: RuntimeValues
): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  const skipped =
    step.kind === "write" &&
    step.onUniqueConflict === "skip" &&
    result.rowCount === 0;
  for (const [name, source] of Object.entries(step.outputs)) {
    if (skipped && source.kind === "insertId") {
      outputs.set(name, undefined);
      continue;
    }
    outputs.set(name, extractOutput(step.id, source, result, values));
  }
  return outputs;
}

export function extractOutput(
  step: string,
  source: StatementOutputSource,
  result: QueryResult<unknown>,
  values: RuntimeValues
): unknown {
  if (source.kind === "rows") return result.rows;
  if (source.kind === "rowCount") return result.rowCount;
  if (source.kind === "consumedValue") {
    return resolveConsumedValue(source.source, values, false);
  }
  if (source.kind === "insertId") {
    if (result.insertId === undefined) {
      throw new TransactionError(
        `Step '${step}' did not produce an insert id.`
      );
    }
    return result.insertId;
  }
  const row = result.rows[0];
  if (
    !(isRecord(row) && Object.hasOwn(row, source.field)) ||
    row[source.field] === undefined
  ) {
    if (source.kind === "firstRowField" && source.optional) return undefined;
    throw new TransactionError(
      `Step '${step}' did not produce row field '${source.field}'.`
    );
  }
  return row[source.field];
}

/** Merge one atomic unit's result into the run, keeping scratch SQL private. */
export function mergeBatchOutputs(
  step: StatementStep,
  result: QueryResult<unknown>,
  values: RuntimeValues
): void {
  for (const [name, source] of Object.entries(step.outputs)) {
    if (source.kind === "consumedValue") {
      const resolved = resolveConsumedValue(source.source, values, true);
      if (isSql(resolved)) continue;
      setRuntimeValue(values, step.id, name, resolved);
      continue;
    }
    if (source.kind === "insertId" && result.insertId === undefined) {
      const existing = values.get(step.id)?.get(name);
      if (isSql(existing)) continue;
    }
    setRuntimeValue(
      values,
      step.id,
      name,
      extractOutput(step.id, source, result, values)
    );
  }
}

export function resolveConsumedValue(
  source: Extract<StatementOutputSource, { kind: "consumedValue" }>["source"],
  values: RuntimeValues,
  allowScratchSql: boolean
): unknown {
  const resolved =
    source.kind === "reference"
      ? resolveRuntimeValue(source.reference, values)
      : source.value;
  if (isSql(resolved) && !allowScratchSql) {
    throw new QueryEngineError(
      "A consumed-value output did not resolve to a concrete runtime value."
    );
  }
  return resolved;
}

/** A postcondition, enforced in JS after the statement's own round trip. */
export function enforcePostcondition(
  step: StatementStep,
  result: QueryResult<unknown>,
  attribution: Attribution
): void {
  const expects = step.expects;
  if (!expects) return;
  if (expects.kind === "exactlyOneRow") {
    if (result.rows.length !== 1) {
      throw createFailureError(
        expects.failure,
        attribution.model,
        attribution.operation
      );
    }
    return;
  }
  const satisfied =
    typeof expects.expected === "number"
      ? result.rowCount === expects.expected
      : result.rowCount >= expects.expected.min;
  if (!satisfied) {
    throw createFailureError(
      expects.failure,
      attribution.model,
      attribution.operation
    );
  }
}

/**
 * The attribution one statement executes under (§8.3): a statement compiled
 * for a nested record names that record's model, so a provider failure names
 * the model whose table the provider already named. A statement naming no
 * model, or the operation's own, runs under the operation context unchanged.
 */
export function statementExecutionContext(
  step: { readonly model?: string } | undefined,
  context: QueryExecutionContext
): QueryExecutionContext {
  const model = step?.model;
  if (model === undefined || model === context.model) return context;
  return deriveStatementExecutionContext(context, model);
}

// ---------------------------------------------------------------------------
// Program outputs
// ---------------------------------------------------------------------------

/**
 * A K3 program publishes STEP IDS. A step with exactly one declared output
 * publishes that value; a step with several publishes its `rows` output when it
 * has one, else its `rowCount`. Anything else is a typed error, never a guess.
 * (The report proposes `Program.outputs` carry `OperationValueReference`s, the
 * existing fragment contract, which would make this rule unnecessary.)
 */
export function publishedReference(
  program: Program,
  stepId: string
): OperationValueReference {
  const step = findStatementStep(program, stepId);
  if (!step) {
    throw new QueryEngineError(
      `Program output names step '${stepId}', which the program does not carry.`
    );
  }
  const names = Object.keys(step.outputs);
  const [only] = names;
  if (only !== undefined && names.length === 1) return ref(stepId, only);
  const preferred = names.find((name) => step.outputs[name]?.kind === "rows");
  const counted = names.find((name) => step.outputs[name]?.kind === "rowCount");
  const chosen = preferred ?? counted;
  if (chosen === undefined) {
    throw new QueryEngineError(
      `Program output names step '${stepId}', which declares no single publishable output.`
    );
  }
  return ref(stepId, chosen);
}

export function findStatementStep(
  program: Program,
  stepId: string
): StatementStep | undefined {
  for (const fragment of program.fragments) {
    const found = statementStepsOf(fragment).find((step) => step.id === stepId);
    if (found) return found;
  }
  return undefined;
}

export function statementStepsOf(fragment: Fragment): StatementStep[] {
  const steps: StatementStep[] = [];
  for (const level of fragment.matches) steps.push(...level);
  for (const step of fragment.writes) {
    if (step.kind === "read" || step.kind === "write") steps.push(step);
  }
  return steps;
}

/**
 * Resolve the program's terminal outputs. An ordered list of step ids resolves
 * by concatenating rows or summing counts; mixing the two is a typed error.
 */
export function resolveProgramOutputs(
  program: Program,
  values: RuntimeValues,
  rows: RowsBoundary
): Readonly<Record<string, unknown>> {
  const outputs: Record<string, unknown> = {};
  for (const [name, source] of Object.entries(program.outputs)) {
    outputs[name] =
      typeof source === "string"
        ? resolveSingleOutput(program, name, source, values, rows)
        : resolveOutputList(program, name, source, values, rows);
  }
  return outputs;
}

function resolveSingleOutput(
  program: Program,
  name: string,
  stepId: string,
  values: RuntimeValues,
  rows: RowsBoundary
): unknown {
  const value = resolveRuntimeValue(
    publishedReference(program, stepId),
    values
  );
  if (isSql(value) || isOperationValueReference(value)) {
    throw new QueryEngineError(
      `Fragment output '${name}' did not resolve to a runtime value.`
    );
  }
  return Array.isArray(value) ? rows.check(stepId, value) : value;
}

function resolveOutputList(
  program: Program,
  name: string,
  stepIds: readonly string[],
  values: RuntimeValues,
  rows: RowsBoundary
): unknown {
  const resolved = stepIds.map((stepId) =>
    resolveSingleOutput(program, name, stepId, values, rows)
  );
  if (resolved.every(Array.isArray)) {
    return resolved.flat();
  }
  if (resolved.every((value) => typeof value === "number")) {
    return (resolved as number[]).reduce((sum, value) => sum + value, 0);
  }
  if (resolved.every((value) => typeof value === "bigint")) {
    return (resolved as bigint[]).reduce((sum, value) => sum + value, 0n);
  }
  throw new QueryEngineError(
    `Fragment output '${name}' names sources that neither all concatenate as rows nor all sum as counts.`
  );
}

// ---------------------------------------------------------------------------
// The rows boundary (§9.2 — decoding is match backwards; F owns only the floor)
// ---------------------------------------------------------------------------

/**
 * The one place provider rows are checked before they leave the executor:
 * every row is a non-null object, and when the caller states the projection's
 * raw keys for a step, every row carries exactly those keys. Both refusals are
 * the existing parser contract's (`result-parser-contract.ts`), so the error
 * class and text are the ones the current parser raises.
 */
export interface RowsBoundary {
  check(stepId: string, rows: unknown[]): Record<string, unknown>[];
}

export function rowsBoundary(
  driver: AnyDriver,
  operation: string,
  expectedRows: Readonly<Record<string, readonly string[]>> | undefined
): RowsBoundary {
  // `malformedResult` reads only `providerName` from its parser argument; the
  // executor has no parser (decoding is unit G), so it hands the one fact the
  // contract consumes. The report proposes narrowing that parameter to
  // `Pick<ResultParser, "providerName">`.
  const parser = { providerName: driver.driverName } as unknown as ResultParser;
  const named = operation as Operation;
  return {
    check(stepId, rows) {
      const normalized = normalizeResultRows(parser, named, rows);
      const rawKeys = expectedRows?.[stepId];
      if (!rawKeys) return normalized;
      const shape: ExpectedResultShape = {
        carrier: "rows",
        rawKeys,
        relations: new Map(),
        polymorphic: new Map(),
        aggregates: new Map(),
        relationCounts: new Set(),
      };
      for (const row of normalized) {
        assertExpectedRowKeys(parser, named, row, shape);
      }
      return normalized;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
