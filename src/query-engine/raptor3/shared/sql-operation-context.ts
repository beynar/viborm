/**
 * One call in SQL: what it is, where its statements go, and what a read or a
 * write asks of both. A read is one statement, sent and decoded here; a write
 * is the write path's (`../write`), which asks this for what a statement can
 * answer and for the failure a caller sees.
 */
import type { DatabaseAdapter } from "@adapters/database-adapter";
import type { AnyDriver } from "@drivers/driver";
import {
  borrowPositionalResult,
  resolvePositionalResultDriver,
} from "@drivers/positional-result";
import { transferPreparedStatement } from "@drivers/prepared-statement-provenance";
import type { QueryExecutionContext, SqlDialect } from "@drivers/types";
import {
  QueryError,
  retainWriteOutcomeFailure,
  TransactionError,
  VibORMErrorCode,
} from "@errors";
import { type AnyModel, getModelKeyCatalog } from "@schema/model";
import { Sql, sql } from "@sql";
import {
  compileBindBudgetChunks,
  normalizedBindParameterLimit,
} from "../../bind-budget";
import type { PreparedBatchOperation, PreparedGuardFailure } from "../../types";
import { InsertValue } from "./insert-value";
import {
  GatedFieldRefusal,
  InvalidScalarResult,
  type PreparedProjection,
  type Query,
  type Read,
  RecursiveOutputOverBudget,
  refusesWhileDecoding,
  returningSafeProjection,
  throughDerived,
} from "./query";
import type { CallScope, RowJudgement } from "./row-scope";
import {
  type EngineSchema,
  type Input,
  type Operation,
  record,
} from "./schema";
import { SqlQueries } from "./sql-queries";

/** The rows a write returns, named where a statement answers over them. */
const MUTATION_ROWS = "__viborm_mutation";
/** That answer, kept apart where it opens a CTE of its own. */
const MUTATION_ANSWER = "__viborm_answer";

const ATOMIC_RESOLUTION_OPERATIONS: ReadonlySet<string> = new Set([
  "update",
  "delete",
  "upsert",
]);

/** One member of a caller's unit, run so that its failure undoes only itself. */
export type MemberRollback = <T>(
  execute: (driver: AnyDriver) => Promise<T>,
  context: QueryExecutionContext
) => Promise<T>;

/** Where a write says what it left durable: the cache listens. */
export interface WriteOutcomeSeam {
  readonly committedSegment?: () => Promise<void>;
  readonly mayBeVisible?: () => Promise<void>;
}

/** Whose unit the call runs in: its own, or a transaction its caller holds. */
export type ExecutionBinding =
  | {
      readonly kind: "borrowed-transaction";
      readonly driver: AnyDriver;
      readonly memberRollback?: MemberRollback;
      readonly operationRegion?: MemberRollback;
      readonly writeOutcome?: WriteOutcomeSeam;
    }
  | { readonly kind: "standalone"; readonly writeOutcome?: WriteOutcomeSeam };

/** A nested write's refusal of the row it produces. */
export function nestedRefusal(
  verb: string,
  relation: string
): PreparedGuardFailure {
  return {
    kind: "nestedWrite",
    relation,
    message: `Cannot ${verb} relation '${relation}': the record it writes is not permitted.`,
    raceable: false,
  };
}

export class SqlOperationContext {
  readonly schema: EngineSchema;
  readonly scope: CallScope | undefined;
  readonly modelName: string;
  readonly operation: Operation;
  readonly driver: AnyDriver & { readonly adapter: DatabaseAdapter };
  readonly queries: SqlQueries;
  /** Whether the call owns its unit, or prepares a package for an owner. */
  readonly #owner: "standalone" | "borrowed-transaction" | "batch-preparation";
  readonly #caller: QueryExecutionContext | undefined;
  #correlation: string | undefined;
  #package: PreparedBatchOperation<unknown> | undefined;

  constructor(
    schema: EngineSchema,
    factoryDriver: AnyDriver,
    modelName: string,
    operation: Operation,
    binding?: ExecutionBinding,
    preparing = false,
    caller?: QueryExecutionContext,
    scope?: CallScope
  ) {
    this.schema = schema;
    this.scope = scope;
    this.modelName = modelName;
    this.operation = operation;
    this.#caller = caller;
    this.#owner = preparing
      ? "batch-preparation"
      : (binding?.kind ?? "standalone");
    this.driver = (
      binding?.kind === "borrowed-transaction" ? binding.driver : factoryDriver
    ) as this["driver"];
    this.queries = new SqlQueries(
      schema,
      this.driver.adapter,
      this.driver.result,
      scope?.domain,
      scope
    );
  }

  /** What every statement of the call is attributed to. */
  get attribution(): QueryExecutionContext {
    return this.#caller ?? this.#own;
  }

  /** The call's own record of itself: an error's meta, whoever the caller is. */
  get #own(): QueryExecutionContext {
    return {
      model: this.modelName,
      operation: this.operation,
      correlationId: (this.#correlation ??= crypto.randomUUID()),
    };
  }

  /** The failure a caller sees: a value the result could not hold says so in the call's words. */
  failure(error: unknown): unknown {
    if (error instanceof InvalidScalarResult) {
      const driver = this.driver.driverName;
      const model = this.modelName;
      const operation = this.operation;
      const { scalarType, reason } = error;
      return new QueryError(
        `The "${operation}" result is incompatible with the ${scalarType} scalar domain: ${reason}.`,
        {
          code: VibORMErrorCode.QUERY_RESULT_INVALID,
          meta: { driver, model, operation, scalarType, reason },
        }
      );
    }
    return error instanceof RecursiveOutputOverBudget ||
      error instanceof GatedFieldRefusal
      ? error.refusal(this.operation, this.modelName)
      : error;
  }

  async run<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (error) {
      throw this.failure(error);
    }
  }

  /** A read's rows as the call publishes them. */
  #published(read: Read, rows: Input[]): Input[] {
    this.queries.assertExpectedRows(read.query, rows.length);
    return this.queries.decodeResult(rows, this.operation, (raw) =>
      this.queries.decodeProjection(read.query.shape, raw)
    );
  }

  /**
   * One read: its one statement sent, or queued for the owner the call
   * prepares for, and its rows decoded and decided once.
   */
  async publish(read: Read, missing?: () => Error): Promise<unknown> {
    if (this.#owner === "batch-preparation")
      return this.publishPrepared(read, missing);
    const positional =
      this.#owner === "standalone" && read.value.kind === "collection"
        ? resolvePositionalResultDriver(this.driver)
        : undefined;
    if (positional === undefined) {
      const response = await this.driver._execute<Input>(
        read.query.sql,
        this.attribution
      );
      return decide(read, missing, this.#published(read, response.rows));
    }
    const response = await positional(read.query.sql, this.attribution);
    if (
      response.kind === "positional" &&
      resolvePositionalResultDriver(this.driver) === positional
    ) {
      this.queries.assertExpectedRows(read.query, response.rows.length);
      return decide(
        read,
        missing,
        this.queries.decodeProjection(
          read.query.shape,
          response.rows,
          false,
          response.columns
        )
      );
    }
    const borrowed =
      response.kind === "borrowed"
        ? response.result
        : borrowPositionalResult(response);
    return decide(
      read,
      missing,
      this.#published(read, borrowed.rows.map(record))
    );
  }

  /** The read as a package: its statement, and the parser of its one result. */
  publishPrepared(read: Read, missing?: () => Error): undefined {
    const context = this.attribution;
    const prepared = this.driver._prepare(read.query.sql, context);
    // The driver owns the query's identity: what it registered against the
    // object it returned travels with the copy that carries the context.
    const query = transferPreparedStatement(prepared, {
      sql: prepared.sql,
      params: prepared.params ?? [],
      context,
    });
    this.#package = {
      queries: [query],
      parseResult: (results) => {
        const response = results[0];
        if (!response)
          throw new TransactionError(
            `Driver '${this.driver.driverName}' omitted the prepared result for operation '${this.operation}'.`,
            { meta: { ...this.#own } }
          );
        try {
          return decide(
            read,
            missing,
            this.#published(read, response.rows.map(record))
          );
        } catch (error) {
          throw this.failure(error);
        }
      },
    };
    return undefined;
  }

  preparedBatch(): PreparedBatchOperation<unknown> | undefined {
    return this.#package;
  }

  /** A read prepares whole: nothing of it waits for an answer. */
  isIncompletePreparation(_error: unknown): boolean {
    return false;
  }

  /** A write of several statements needs a unit that takes all or none. */
  requireAtomicUnit(): void {
    if (this.#owner !== "standalone") return;
    const driver = this.driver;
    const meta = { driver: driver.driverName, operation: this.operation };
    if (!(driver.supportsTransactions || driver.supportsBatch))
      throw new TransactionError(
        `Driver "${driver.driverName}" supports neither transactions nor atomic batch execution.`,
        { meta }
      );
    if (
      driver.supportsBatch &&
      !driver.supportsTransactions &&
      !driver.adapter.capabilities.supportsReturning &&
      ATOMIC_RESOLUTION_OPERATIONS.has(this.operation)
    )
      throw new TransactionError(
        this.operation === "upsert"
          ? "cannot execute non-returning upsert writes atomically because public result parsing cannot be rolled back after an atomic batch commits"
          : `Driver '${driver.driverName}' cannot execute '${this.operation}' because public result parsing cannot be rolled back.`,
        { meta }
      );
  }

  /** Says what the write left durable; a failure to say it rides the write's own. */
  async stateWriteOutcome(
    say: (() => Promise<void>) | undefined,
    primary?: unknown
  ): Promise<void> {
    if (!say) return;
    try {
      await say();
    } catch (outcomeFailure) {
      if (primary === undefined) throw outcomeFailure;
      throw retainWriteOutcomeFailure(primary, outcomeFailure);
    }
  }

  /** The reads of the rows a many-row write names, each within the bind budget. */
  seriesQueries(
    projection: PreparedProjection,
    identities: Input[],
    operation: "createMany" | "updateMany" = "createMany"
  ): Query[] {
    if (identities.length === 0) return [];
    const queries = new Map<Sql, Query>();
    return compileBindBudgetChunks(
      identities.length,
      normalizedBindParameterLimit(this.driver.maxBindParametersPerStatement),
      (start, end) => {
        const query = this.queries.selectSeries(
          projection,
          identities.slice(start, end),
          operation
        );
        queries.set(query.sql, query);
        return query.sql;
      }
    ).map(({ statement }) => queries.get(statement)!);
  }

  /** The rows with every value an extension computes put in. */
  async computed(model: AnyModel, rows: Input[]): Promise<Input[]> {
    let computed: Input[] | undefined;
    const fields = new Map<string, { value: InsertValue; at: number[] }>();
    for (const [index, row] of rows.entries())
      for (const [field, value] of Object.entries(row))
        if (value instanceof InsertValue) {
          const entry = fields.get(field) ?? { value, at: [] };
          entry.at.push(index);
          fields.set(field, entry);
        }
    for (const [field, { value, at }] of fields) {
      computed ??= rows.map((row) => ({ ...row }));
      const values = await value.compute(
        {
          model,
          rows: computed,
          field,
          queries: this.queries,
          dialect: this.driver.dialect as SqlDialect,
        },
        at
      );
      for (const [position, index] of at.entries())
        computed[index]![field] = values[position];
    }
    return computed ?? rows;
  }

  /** {@link answersInStatement}'s projections over a write. */
  #overWrites:
    | WeakMap<
        PreparedProjection,
        { readonly answer: Sql; readonly folds: boolean }
      >
    | undefined;

  /**
   * Whether the statement that writes can answer `projection` itself: where
   * the provider returns rows, the projection does not refuse while it
   * decodes, and nothing it reads is a row the statement is still writing.
   */
  answersInStatement(
    model: AnyModel,
    projection: PreparedProjection,
    effect: "insert" | "update" | "delete",
    written?: Input
  ): boolean {
    const capabilities = this.driver.adapter.capabilities;
    if (!capabilities.supportsReturning) return false;
    if (returningSafeProjection(projection)) return true;
    if (refusesWhileDecoding(projection)) return false;
    if (effect === "delete") return capabilities.supportsCteWithMutations;
    if (written !== undefined) {
      const keys = getModelKeyCatalog(model).referenceableKeys;
      if (
        keys.some((key) => key.some((field) => Object.hasOwn(written, field)))
      )
        return false;
    }
    return this.#overWrite(model, projection).folds;
  }

  #overWrite(
    model: AnyModel,
    projection: PreparedProjection
  ): { readonly answer: Sql; readonly folds: boolean } {
    const known = this.#overWrites?.get(projection);
    if (known !== undefined) return known;
    const a = this.driver.adapter;
    const table = model["~"].names.sql!;
    const name = Sql.leafText(a.identifiers.escape(table))!;
    let answer: Sql;
    let folds = true;
    if (a.capabilities.supportsCteWithMutations) {
      answer = this.queries.select(model, {}, undefined, {
        projection,
        source: MUTATION_ROWS,
      }).sql;
      if (a.cte.opens(answer))
        answer = throughDerived(a, answer, MUTATION_ANSWER);
    } else {
      answer = this.queries.sharing(() =>
        sql.join(this.queries.lowerProjection(projection, table), ", ")
      );
      folds = !a.cte.opens(answer);
    }
    // A relation read from the written table would see it before the write.
    folds &&= !Sql.peek(answer).strings.some((text) => {
      for (
        let at = text.indexOf(name);
        at !== -1;
        at = text.indexOf(name, at + 1)
      )
        if (text[at + name.length] !== ".") return true;
      return false;
    });
    const over = { answer, folds };
    (this.#overWrites ??= new WeakMap()).set(projection, over);
    return over;
  }

  /** `statement`, answering `projection` over the rows it writes. */
  answering(
    model: AnyModel,
    statement: Sql,
    projection: PreparedProjection,
    extra: Sql[] = []
  ): Sql {
    const a = this.driver.adapter;
    if (returningSafeProjection(projection))
      return sql`${statement} ${a.mutations.returning(
        sql.join([...this.queries.lowerProjection(projection), ...extra], ", ")
      )}`;
    const { answer } = this.#overWrite(model, projection);
    if (!a.capabilities.supportsCteWithMutations)
      return sql`${statement} ${a.mutations.returning(answer)}`;
    return sql`${a.cte.with([
      {
        name: MUTATION_ROWS,
        query: sql`${statement} ${a.mutations.returning(sql.raw("*"))}`,
      },
    ])} ${answer}`;
  }

  /** What a write says when the row it would leave is refused. */
  refusalOf(model: AnyModel, judgement?: RowJudgement): PreparedGuardFailure {
    const forbidden: PreparedGuardFailure = {
      kind: "forbidden",
      message: `${this.operation} produced a row that is not permitted.`,
      raceable: false,
    };
    const layers =
      judgement && this.scope?.rows.domain.verbs?.get(model["~"].names.ts!);
    if (!(judgement && layers)) return forbidden;
    const moved = judgement.writes.filter((field) =>
      layers.some((layer) => layer?.moves.has(field) === true)
    );
    if (moved.length === 0) return forbidden;
    const relations = model["~"].state.relations;
    const through = judgement.writes.filter(
      (field) =>
        Object.hasOwn(relations, field) &&
        relations[field]!["~"].state.foreignKey?.fields.some((key) =>
          moved.includes(key)
        ) === true
    );
    return {
      ...forbidden,
      reason: `the row it would leave, judged again because it writes ${moved.join(", ")}${through.length > 0 ? ` (through ${through.join(", ")})` : ""}, is refused`,
    };
  }
}

/** A read's value; the error of a required row that is not there. */
function decide(
  read: Read,
  missing: (() => Error) | undefined,
  rows: Input[]
): unknown {
  const value = read.result(rows);
  if (value === null && missing) throw missing();
  return value;
}
