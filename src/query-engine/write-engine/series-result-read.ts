import { QueryEngineError } from "@errors";
import type { Model } from "@schema/model";
import type { PolymorphicStorageColumn } from "@schema/relation";
import type { Sql } from "@sql";
import { buildPrimaryKeyWhereUnique } from "../builders/correlation-utils";
import { createQueryScope } from "../context/query-scope";
import { buildFind, buildFindUnique } from "../operations";
import type { QueryEngine } from "../query-engine";
import { ResultParser } from "../result/ResultParser";
import type { Operation, QueryScope } from "../types";
import type { ExecutableOperation } from "./OperationExecutor";
import {
  createFailureError,
  type OperationFragment,
  type PlanningFragment,
  type ReadStep,
  ref,
} from "./OperationFragment";
import type { StepScope } from "./StepScope";
import { getStepModelName, isRecord } from "./shared";
import {
  buildTargetProjection,
  capturedTargetSetWhere,
  readRowKey,
  rowKeysEqual,
  rowKeyToken,
} from "./target-projection";

type SeriesReturningOperation = "createManyAndReturn" | "updateManyAndReturn";

export interface SeriesResultReadInput {
  readonly engine: QueryEngine;
  readonly model: Model<any>;
  /** Already-validated public bulk args. `omit` is already a public `select`. */
  readonly args: Readonly<Record<string, unknown>>;
  readonly select: Readonly<Record<string, unknown>>;
  readonly expectedRowKeys: readonly Readonly<Record<string, unknown>>[];
  readonly operation: SeriesReturningOperation;
  readonly scope: StepScope;
  readonly stepLabel: string;
  readonly missingRowMessage: string;
}

/**
 * Build ordinary final reads for one record series.
 *
 * The only optimization here is set coalescing. Unknown provider capacity keeps
 * one read per row. Known capacity uses the compiled statement's actual value
 * count, so select/include predicates consume the same budget as row-key values.
 */
export function buildSeriesResultReads(
  input: SeriesResultReadInput
): readonly ExecutableOperation[] {
  if (input.expectedRowKeys.length === 0) return [];
  const ctx = createQueryScope(input.engine, input.model);
  const internalSelect = seriesResultSelect(input.model, input.select);
  const chunks = resultReadChunks(
    ctx,
    internalSelect.select,
    input.expectedRowKeys,
    input.engine.maxBindParametersPerStatement
  );
  return chunks.map(
    (rowKeys) =>
      new SeriesResultReadOperation(
        input,
        internalSelect,
        rowKeys,
        input.scope.allocate(input.stepLabel),
        buildResultReadStatement(ctx, internalSelect.select, rowKeys)
      )
  );
}

/**
 * Decode grouped reads once, restore member order, and remove only fields this
 * owner injected to address rows. Database row order is never observed.
 */
export function parseSeriesResultReads(
  input: SeriesResultReadInput,
  resultReadResults: readonly unknown[]
): readonly Readonly<Record<string, unknown>>[] {
  if (input.expectedRowKeys.length === 0) return [];
  const rows: Readonly<Record<string, unknown>>[] = [];
  for (const readResult of resultReadResults) {
    if (!Array.isArray(readResult)) {
      throw new QueryEngineError(
        "query-engine-v2 record series lost a grouped final read."
      );
    }
    for (const row of readResult) {
      if (!isRecord(row)) {
        throw new QueryEngineError(
          "query-engine-v2 record series final read did not decode to a row."
        );
      }
      rows.push(row);
    }
  }

  if (rows.length < input.expectedRowKeys.length) throw missingSeriesRow(input);
  if (rows.length > input.expectedRowKeys.length) {
    throw new QueryEngineError(
      "query-engine-v2 record series final reads returned inconsistent row counts."
    );
  }
  return rows;
}

/**
 * Decode row keys through the normal scalar-result boundary and keep the
 * PRIVATE representation of each one.
 *
 * These values address later SQL and decide which member a returned row is, so
 * they are the codec's canonical private text for a decimal — not the public
 * `Decimal`, whose equality is reference identity and whose rendering an
 * application's own Decimal.js configuration can move. A row key spelled by the
 * public value would fail to match itself.
 */
export function parseSeriesRowKeys(
  engine: QueryEngine,
  model: Model<any>,
  operation: SeriesReturningOperation,
  rawRows: readonly unknown[]
): readonly Readonly<Record<string, unknown>>[] {
  return decodeRowKeys(engine, model, operation, rawRows);
}

/**
 * Decode the rows a write-engine PROBE captured into complete row keys.
 *
 * The same decode as {@link parseSeriesRowKeys}, for the other half of the
 * engine. A planning probe publishes its rows exactly as the provider spelled
 * them, and every captured member is then RE-ADDRESSED: it goes back into a
 * `whereUnique`, a filter, or a junction insert through the ordinary
 * where/values builder, which lowers a LOGICAL value. The two spellings are not
 * the same value on every provider — a SQLite decimal column answers with its
 * unscaled coefficient, so re-binding the captured spelling as a logical value
 * addresses `captured x 10^scale`: a different row, silently. Decoding first
 * makes the captured member the codec's canonical private text, which is what
 * the whole identity estate (row-key tokens, equality, sorting, the where
 * builder) is defined over.
 *
 * `findMany` is the shape every one of these probes has — `buildFind`/
 * `buildFindUnique` over the target with the row-key `select` — and the raw
 * output is a row array either way.
 */
export function parseCapturedRowKeys(
  engine: QueryEngine,
  model: Model<any>,
  rawRows: readonly unknown[]
): readonly Readonly<Record<string, unknown>>[] {
  return decodeRowKeys(engine, model, "findMany", rawRows);
}

/**
 * Decode every selected scalar a captured probe will consume again.
 *
 * A target projection can publish more than the row key: relation compilers also
 * consume referenced fields and foreign-key members from that same physical row.
 * Those values cross the same logical SQL boundary as a row key, so decoding only
 * the key would still re-bind a SQLite decimal coefficient as a logical decimal.
 * `select` is the probe's one declared public-field projection and therefore the
 * one source of which model scalars are decoded and retained.
 *
 * Explicit internal columns carry their scalar beside their physical name.
 * They have no public model field, so this owner asks the same ResultParser for
 * their private captured representation directly. Every other extra provider
 * column is discarded.
 *
 * The complete raw row set passes through ResultParser before any returned row is
 * observable. The returned values are its private captures — canonical decimal
 * text included — and never the public Decimal instances from the first tuple.
 */
export function parseCapturedRows(
  engine: QueryEngine,
  model: Model<any>,
  rawRows: readonly unknown[],
  select: Readonly<Record<string, unknown>>,
  internalColumns: readonly PolymorphicStorageColumn[] = [],
  fieldSources?: Readonly<Record<string, string>>
): readonly Record<string, unknown>[] {
  const fields = Object.entries(select).flatMap(([field, included]) =>
    included === true ? [field] : []
  );
  const sources =
    fieldSources ?? Object.fromEntries(fields.map((field) => [field, field]));
  return new ResultParser(engine, model, engine.driver).parseCapturedProjection(
    "findMany",
    rawRows,
    { select },
    sources,
    internalColumns
  );
}

function decodeRowKeys(
  engine: QueryEngine,
  model: Model<any>,
  operation: Operation,
  rawRows: readonly unknown[]
): readonly Readonly<Record<string, unknown>>[] {
  const identityFields = buildTargetProjection(model).identityFields;
  const select = Object.fromEntries(
    identityFields.map((field) => [field, true])
  );
  const keyRows = new ResultParser(
    engine,
    model,
    engine.driver
  ).parseCapturedProjection(
    operation,
    rawRows,
    { select },
    Object.fromEntries(identityFields.map((field) => [field, field]))
  );
  return keyRows.map((row) => readRowKey(model, row));
}

function parseResultReadChunk(
  input: SeriesResultReadInput,
  internalSelect: InternalSeriesSelect,
  expectedRowKeys: readonly Readonly<Record<string, unknown>>[],
  rawRows: unknown
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(rawRows)) {
    throw new QueryEngineError(
      "query-engine-v2 record series lost a grouped final read."
    );
  }
  const identityFields = buildTargetProjection(input.model).identityFields;
  const [publicRows, keyRows] = new ResultParser(
    input.engine,
    input.model,
    input.engine.driver
  ).parseRowsWithRowKeys<unknown[]>(
    input.operation,
    rawRows,
    {
      ...input.args,
      select: internalSelect.select,
    },
    identityFields
  );
  if (publicRows.length !== keyRows.length) {
    throw new QueryEngineError(
      "query-engine-v2 record series final read decoded inconsistent row counts."
    );
  }

  const rowsByToken = new Map<
    string,
    {
      readonly key: Readonly<Record<string, unknown>>;
      readonly row: Readonly<Record<string, unknown>>;
    }[]
  >();
  for (const [index, keyRow] of keyRows.entries()) {
    const publicRow = publicRows[index];
    if (!isRecord(publicRow)) {
      throw new QueryEngineError(
        "query-engine-v2 record series final read did not decode to a row."
      );
    }
    const rowKey = readRowKey(input.model, keyRow);
    const token = rowKeyToken(input.model, rowKey);
    const bucket = rowsByToken.get(token);
    const indexed = { key: rowKey, row: publicRow };
    if (bucket) bucket.push(indexed);
    else rowsByToken.set(token, [indexed]);
  }

  return expectedRowKeys.map((expected) => {
    const expectedKey = readRowKey(input.model, expected);
    const candidates = rowsByToken.get(rowKeyToken(input.model, expectedKey));
    const match = candidates?.find((candidate) =>
      rowKeysEqual(input.model, expectedKey, candidate.key)
    );
    if (!match) throw missingSeriesRow(input);
    return stripInjectedFields(match.row, internalSelect.injectedFields);
  });
}

function missingSeriesRow(input: SeriesResultReadInput): Error {
  return createFailureError(
    {
      kind: "query",
      message: input.missingRowMessage,
      raceable: false,
    },
    getStepModelName(input.model, "unknown"),
    input.operation === "createManyAndReturn" ? "createMany" : "updateMany"
  );
}

interface InternalSeriesSelect {
  readonly select: Record<string, unknown>;
  readonly injectedFields: ReadonlySet<string>;
}

function seriesResultSelect(
  model: Model<any>,
  publicSelect: Readonly<Record<string, unknown>>
): InternalSeriesSelect {
  const select = { ...publicSelect };
  const injectedFields = new Set<string>();
  for (const field of buildTargetProjection(model).identityFields) {
    if (select[field] === true) continue;
    select[field] = true;
    injectedFields.add(field);
  }
  return { select, injectedFields };
}

function resultReadChunks(
  ctx: QueryScope,
  select: Record<string, unknown>,
  rowKeys: readonly Readonly<Record<string, unknown>>[],
  capacity: number | undefined
): readonly (readonly Readonly<Record<string, unknown>>[])[] {
  if (capacity === undefined) return rowKeys.map((rowKey) => [rowKey]);

  const chunks: Readonly<Record<string, unknown>>[][] = [];
  let start = 0;
  while (start < rowKeys.length) {
    const remaining = rowKeys.length - start;
    let accepted = 1;
    let rejected = 0;

    // Find an upper bound exponentially. This keeps a 65k-bind provider from
    // rebuilding a growing SELECT once per input row.
    while (accepted < remaining) {
      const candidate = Math.min(remaining, accepted * 2);
      if (
        resultReadValueCount(ctx, select, rowKeys, start, candidate) > capacity
      ) {
        rejected = candidate;
        break;
      }
      accepted = candidate;
    }

    // Refine only the final boundary. A single over-budget row is retained so the
    // provider reports the same capacity failure as before.
    if (rejected > 0) {
      let low = accepted;
      let high = rejected - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (
          resultReadValueCount(ctx, select, rowKeys, start, middle) <= capacity
        ) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      accepted = low;
    }

    chunks.push(rowKeys.slice(start, start + accepted));
    start += accepted;
  }
  return chunks;
}

function resultReadValueCount(
  ctx: QueryScope,
  select: Record<string, unknown>,
  rowKeys: readonly Readonly<Record<string, unknown>>[],
  start: number,
  count: number
): number {
  return buildResultReadStatement(
    ctx,
    select,
    rowKeys.slice(start, start + count)
  ).values.length;
}

function buildResultReadStatement(
  ctx: QueryScope,
  select: Record<string, unknown>,
  rowKeys: readonly Readonly<Record<string, unknown>>[]
): Sql {
  const projection = buildTargetProjection(ctx.model);
  const singleRowKey = rowKeys.length === 1 ? rowKeys[0] : undefined;
  if (singleRowKey) {
    const rowKey = readRowKey(ctx.model, singleRowKey);
    return buildFindUnique(ctx, {
      where: buildPrimaryKeyWhereUnique(ctx.model, { ...rowKey }),
      select,
    });
  }
  return buildFind(ctx, {
    where: capturedTargetSetWhere(ctx.model, projection, rowKeys),
    select,
  });
}

function stripInjectedFields(
  row: Readonly<Record<string, unknown>>,
  injectedFields: ReadonlySet<string>
): Readonly<Record<string, unknown>> {
  if (injectedFields.size === 0) return row;
  return Object.fromEntries(
    Object.entries(row).filter(([field]) => !injectedFields.has(field))
  );
}

class SeriesResultReadOperation implements ExecutableOperation {
  readonly mode = "transaction" as const;
  private readonly input: SeriesResultReadInput;
  private readonly internalSelect: InternalSeriesSelect;
  private readonly expectedRowKeys: readonly Readonly<
    Record<string, unknown>
  >[];
  private readonly step: ReadStep;

  constructor(
    input: SeriesResultReadInput,
    internalSelect: InternalSeriesSelect,
    expectedRowKeys: readonly Readonly<Record<string, unknown>>[],
    id: string,
    statement: Sql
  ) {
    this.input = input;
    this.internalSelect = internalSelect;
    this.expectedRowKeys = expectedRowKeys;
    this.step = {
      id,
      kind: "read",
      statement,
      outputs: { rows: { kind: "rows" } },
    };
  }

  planning(): PlanningFragment {
    return { steps: [] };
  }

  compile(): OperationFragment {
    return {
      steps: [this.step],
      outputs: { result: ref(this.step.id, "rows") },
    };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    return parseResultReadChunk(
      this.input,
      this.internalSelect,
      this.expectedRowKeys,
      outputs.result
    ) as T;
  }
}
