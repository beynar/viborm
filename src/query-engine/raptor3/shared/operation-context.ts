import {
  assembleAdapterSelect,
  getAdapterInternals
} from "@adapters/adapter-internals";
import type { AnyDriver } from "@drivers";
import { batchMayContainAssertionCollision } from "@drivers/error-mapping";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult
} from "@drivers/types";
import {
  attachRecordSeriesProgress,
  NestedWriteAssertionError,
  NestedWriteError,
  QueryEngineError,
  type RecordSeriesProgress,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError
} from "@errors";
import type { AnyModel } from "@schema/model";
import { Sql, sql } from "@sql";
import {
  compileBindBudgetChunks,
  normalizedBindParameterLimit
} from "../../bind-budget";
import type { PreparedBatchOperation } from "../../types";
import {
  InvalidScalarResult,
  Queries,
  type PreparedProjection,
  type PreparedSelector,
  type Query
} from "./query";
import {
  type EngineSchema,
  type Input,
  type Operation,
  record
} from "./schema";
import { type Membership, physicalField } from "./storage";
import { TransportAttempt } from "./transport-attempt";

export type Member = object;

export type MemberRollback = <T>(
  execute: (driver: AnyDriver) => Promise<T>,
  context: QueryExecutionContext
) => Promise<T>;

export type ExecutionBinding =
  | {
      readonly kind: "borrowed-transaction";
      readonly driver: AnyDriver;
      readonly memberRollback?: MemberRollback;
    }
  | { readonly kind: "atomic-array" };

type ExecutionOwnership =
  | "standalone"
  | "borrowed-transaction"
  | "batch-preparation";

/** One operation owns its SQL scopes, transport binding, and batch scratch lifetime. */
export class OperationContext {
  readonly queries: Queries;
  readonly driver: AnyDriver;
  readonly usesBatch: boolean;
  private readonly ownership: ExecutionOwnership;
  private readonly memberRollback?: MemberRollback;
  private transport: AnyDriver;
  private attempt = new TransportAttempt();
  private readonly committedMembers = new Set<Member>();
  private readonly memberAttribution = new WeakMap<
    Member,
    { readonly path: readonly number[]; readonly totalMembers: number }
  >();
  private readonly continuations: { query: Query; model: AnyModel }[] = [];
  private committedSegments = 0;
  private mayHaveCommittedSegment: true | undefined;
  private completedMembers = 0;
  private memberAdmissionStarted = false;
  private atomicAssertionRejection?: unknown;
  private readonly incompletePreparation = new Error(
    "Raptor 3 operation requires dynamic execution"
  );
  private preparedParser?: (results: QueryResult<unknown>[]) => unknown;
  private readonly correlationId = crypto.randomUUID();
  constructor(
    readonly schema: EngineSchema,
    factoryDriver: AnyDriver,
    readonly modelName: string,
    readonly operation: Operation,
    binding?: ExecutionBinding,
    prepareBatch = false
  ) {
    if (binding?.kind === "atomic-array") {
      throw new TransactionError(
        "Raptor 3 atomic-array execution is not implemented.",
        {
          meta: {
            driver: factoryDriver.driverName,
            model: modelName,
            operation,
            method: "$transaction([...])"
          }
        }
      );
    }
    this.ownership = prepareBatch
      ? "batch-preparation"
      : (binding?.kind ?? "standalone");
    this.driver = binding?.driver ?? factoryDriver;
    this.memberRollback =
      binding?.kind === "borrowed-transaction"
        ? binding.memberRollback
        : undefined;
    this.transport = this.driver;
    this.usesBatch =
      this.ownership === "batch-preparation" ||
      (this.ownership === "standalone" && !this.driver.supportsTransactions);
    this.queries = new Queries(schema, this.driver.adapter);
  }
  get attribution() {
    return {
      model: this.modelName,
      operation: this.operation,
      correlationId: this.correlationId
    };
  }
  private statementContext(
    model: AnyModel,
    operation: string
  ): QueryExecutionContext {
    return {
      model: model["~"].names.ts!,
      operation,
      correlationId: this.correlationId
    };
  }
  private queue(
    statement: Sql,
    context: QueryExecutionContext = this.attribution,
    member?: Member
  ): BatchQuery {
    const query = {
      ...this.transport._prepare(statement, context),
      context
    };
    this.attempt.pending.push(query);
    if (member) this.attempt.pendingMembers.add(member);
    return query;
  }
  prepareMembers<T extends Member>(prepare: () => T[], parent?: Member): T[] {
    this.memberAdmissionStarted = true;
    try {
      const members = prepare();
      const path = parent
        ? (this.memberAttribution.get(parent)?.path ?? [])
        : [];
      for (const [index, member] of members.entries())
        this.memberAttribution.set(member, {
          path: [...path, index],
          totalMembers: members.length,
        });
      return members;
    } catch (error) {
      throw this.failure(error, "planning", parent);
    }
  }
  async executeMember<T>(
    execute: () => Promise<T>,
    member?: Member
  ): Promise<T> {
    try {
      const output = await execute();
      if (this.ownership !== "batch-preparation") {
        await this.flush(undefined, member);
        this.completedMembers++;
      }
      return output;
    } catch (error) {
      throw this.failure(error, "member", member);
    }
  }
  async executeSkippableMember(
    execute: () => Promise<void>,
    rootProducer: object,
    member: Member
  ): Promise<boolean> {
    const refusal = this.suppressionRefusal();
    if (refusal) throw refusal;
    return this.executeMember(async () => {
      try {
        await this.withMemberRollback(async () => execute());
        return true;
      } catch (error) {
        if (
          error instanceof UniqueConstraintError &&
          this.rejectedProducer(error) === rootProducer
        )
          return false;
        throw error;
      }
    }, member);
  }
  private async withMemberRollback<T>(
    execute: (driver: AnyDriver) => Promise<T>
  ): Promise<T> {
    const outer = this.transport;
    const withinRollback = async (transaction: AnyDriver) => {
      this.transport = transaction;
      try {
        return await execute(transaction);
      } finally {
        this.transport = outer;
      }
    };
    return this.memberRollback
      ? this.memberRollback(withinRollback, this.attribution)
      : outer.withTransaction(withinRollback, undefined, this.attribution);
  }
  suppressionRefusal(): TransactionError | undefined {
    return (this.ownership === "borrowed-transaction" && !this.memberRollback) ||
      this.ownership === "batch-preparation" ||
      this.usesBatch
      ? new TransactionError(
          "Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.",
          {
            meta: {
              driver: this.driver.driverName,
              model: this.modelName,
              operation: this.operation
            }
          }
        )
      : undefined;
  }
  requireSuppression(): void {
    const refusal = this.suppressionRefusal();
    if (refusal) throw refusal;
  }
  failure(
    error: unknown,
    phase: RecordSeriesProgress["phase"],
    member?: Member
  ): unknown {
    let failure = error;
    if (error instanceof InvalidScalarResult) {
      const driver = this.driver.driverName;
      const operation = this.operation;
      const scalarType = error.scalarType;
      failure = new QueryEngineError(
        `Driver "${driver}" returned a malformed ${scalarType} scalar for operation "${operation}": ${error.reason}.`,
        { meta: { driver, operation, scalarType } }
      );
    }
    const attribution = member ? this.memberAttribution.get(member) : undefined;
    return this.usesBatch &&
      (phase === "prefix" ||
        this.committedSegments > 0 ||
        this.mayHaveCommittedSegment)
      ? attachRecordSeriesProgress(failure, {
          atomicity: "segment",
          phase,
          committedSegments: this.committedSegments,
          committedWriteMembers: this.committedMembers.size,
          completedMembers: this.completedMembers,
          ...(attribution?.path.length ? { memberPath: attribution.path } : {}),
          ...(attribution ? { totalMembers: attribution.totalMembers } : {}),
          ...(this.mayHaveCommittedSegment
            ? { mayHaveCommittedSegment: this.mayHaveCommittedSegment }
            : {})
        })
      : failure;
  }
  async run<T>(body: () => Promise<T>): Promise<T> {
    try {
      if (this.ownership === "batch-preparation") return await body();
      if (
        this.operation === "findMany" ||
        this.operation === "findUnique" ||
        this.operation === "groupBy"
      )
        return await body();
      if (this.ownership === "borrowed-transaction") return await body();
      if (this.usesBatch) return await body();
      return await this.driver.withTransaction(
        async (transaction) => {
          this.transport = transaction;
          try {
            return await body();
          } finally {
            this.transport = this.driver;
          }
        },
        undefined,
        this.attribution
      );
    } catch (error) {
      if (
        error instanceof InvalidScalarResult ||
        (this.usesBatch &&
          (this.continuations.length || this.committedSegments > 0))
      )
        throw this.failure(
          error,
          error instanceof InvalidScalarResult ? "result" : "member"
        );
      throw error;
    }
  }
  async read(query: Query, internal = false): Promise<Input[]> {
    if (this.ownership === "batch-preparation") {
      throw this.incompletePreparation;
    }
    const response = await this.transport._execute<Input>(
      query.sql,
      this.attribution
    );
    return this.queries.decodeQuery(query, response.rows, internal);
  }
  referenceProjection(model: AnyModel, values: Input): Query {
    const adapter = this.driver.adapter;
    const select = Object.fromEntries(
      Object.keys(values).map((field) => [field, true])
    );
    const projection = this.queries.prepareProjection(model, { select });
    return {
      shape: projection.shape,
      sql: adapter.clauses.select(
        sql.join(this.queries.lowerProjectionValues(projection, values), ", ")
      )
    };
  }
  async flush(query?: Query, member?: Member): Promise<Input[]>;
  async flush(queries: Query[], member?: Member): Promise<Input[][]>;
  async flush(
    query?: Query | Query[],
    member?: Member
  ): Promise<Input[] | Input[][]> {
    const projections = Array.isArray(query) ? query : query ? [query] : [];
    if (!this.usesBatch) {
      const rows: Input[][] = [];
      for (const projection of projections)
        rows.push(await this.read(projection, true));
      return Array.isArray(query) ? rows : (rows[0] ?? []);
    }
    const resultIndex = this.attempt.pending.length;
    for (const projection of projections) this.queue(projection.sql);
    if (this.attempt.pending.length === 0) return [];
    const responses = await this.submit(false, member);
    try {
      const rows = projections.map((projection, index) =>
        this.queries.decodeQuery(
          projection,
          responses[resultIndex + index]!.rows,
          true
        )
      );
      return Array.isArray(query) ? rows : (rows[0] ?? []);
    } catch (error) {
      throw this.failure(error, "result", member);
    }
  }
  async requireAbsent(query: Query, failure: Error): Promise<void> {
    if (this.usesBatch) {
      this.attempt.assertionFailures.set(
        this.queue(this.driver.adapter.assertions.notExists(query.sql)),
        { query, present: false, failure }
      );
      return;
    }
    if ((await this.read(query, true)).length) throw failure;
  }
  requirePresent(query: Query, failure: Error): void {
    this.attempt.assertionFailures.set(
      this.queue(this.driver.adapter.assertions.exists(query.sql)),
      { query, present: true, failure }
    );
  }
  private async submit(publishingGeneratedOutput = false, member?: Member) {
    if (this.ownership === "batch-preparation") {
      throw this.incompletePreparation;
    }
    const attempt = this.attempt;
    this.atomicAssertionRejection = undefined;
    attempt.rejectedInsert = undefined;
    const precedingSegments = this.committedSegments;
    const guards = this.continuations.map(({ query, model }) => {
      const context = this.statementContext(model, this.operation);
      return {
        ...this.transport._prepare(
          this.driver.adapter.assertions.exists(query.sql),
          context
        ),
        context
      };
    });
    const statements = [...guards, ...attempt.pending.splice(0)];
    const insertProducers = new Map(attempt.insertProducers);
    attempt.insertProducers.clear();
    const assertionFailures = new Map(attempt.assertionFailures);
    attempt.assertionFailures.clear();
    for (const [index, guard] of guards.entries())
      assertionFailures.set(guard, {
        query: this.continuations[index]!.query,
        present: true,
        failure: new TransactionError(
          `Created record '${this.continuations[index]!.model["~"].names.ts!}' changed across a generated-output segment boundary.`,
          { meta: { model: this.modelName, operation: this.operation } }
        )
      });
    const members = [...attempt.pendingMembers];
    attempt.pendingMembers.clear();
    const acknowledged = async () => {
      if (members.length === 0) return;
      this.committedSegments++;
      for (const member of members) this.committedMembers.add(member);
    };
    try {
      const responses = await this.transport._executeBatch<Input>(
        statements,
        undefined,
        this.attribution,
        this.driver.supportsOrderedCommittedSegments ? acknowledged : undefined
      );
      if (!this.driver.supportsOrderedCommittedSegments) await acknowledged();
      return responses.slice(guards.length);
    } catch (error) {
      // Atomic rejection is retryable only with exact effect attribution and a
      // direct provider cause. Cleanup aggregation retains an extra cause link.
      if (
        this.driver.supportsBatch &&
        this.committedSegments === 0 &&
        !this.memberAdmissionStarted &&
        !this.mayHaveCommittedSegment &&
        error instanceof UniqueConstraintError &&
        error.meta.commitCertainty === undefined &&
        error.originalCause &&
        error.originalCause.cause === undefined &&
        typeof error.meta.statementIndex === "number"
      ) {
        const producer = insertProducers.get(
          statements[error.meta.statementIndex]!
        );
        if (producer) attempt.rejectedInsert = { error, producer };
      }
      // A weak native batch cannot prove rollback merely by rejecting after dispatch.
      if (
        members.length > 0 &&
        !this.driver.supportsOrderedCommittedSegments &&
        this.committedSegments === precedingSegments &&
        !(error instanceof UniqueConstraintError)
      )
        this.mayHaveCommittedSegment = true;
      let attributedError = error;
      if (error instanceof NestedWriteAssertionError) {
        const statementIndex = error.meta.statementIndex;
        let failure =
          typeof statementIndex === "number"
            ? assertionFailures.get(statements[statementIndex]!)?.failure
            : undefined;
        if (statementIndex === undefined) {
          // Fresh-state diagnostics after rollback refine the error, not its original statement index.
          for (const statement of statements) {
            const assertion = assertionFailures.get(statement);
            if (!assertion) continue;
            const present = (await this.read(assertion.query, true)).length > 0;
            if (present !== assertion.present) {
              failure = assertion.failure;
              break;
            }
          }
        }
        // Unindexed native failures identify our sole guard only when ordinary SQL cannot collide.
        if (
          statementIndex === undefined &&
          !failure &&
          assertionFailures.size === 1 &&
          !batchMayContainAssertionCollision(statements, this.driver.dialect)
        )
          failure = assertionFailures.values().next().value?.failure;
        if (failure) {
          attributedError = failure;
          if (
            this.driver.supportsBatch &&
            this.committedSegments === 0 &&
            !this.memberAdmissionStarted &&
            !this.mayHaveCommittedSegment &&
            error.meta.commitCertainty === undefined
          )
            this.atomicAssertionRejection = failure;
        }
      }
      throw publishingGeneratedOutput || this.continuations.length > 0
        ? this.failure(
            attributedError,
            this.committedSegments > precedingSegments ? "result" : "member",
            member
          )
        : attributedError;
    }
  }
  rejectedProducer(error: unknown): object | undefined {
    return this.attempt.rejectedInsert &&
      this.attempt.rejectedInsert.error === error
      ? this.attempt.rejectedInsert.producer
      : undefined;
  }
  recoveryRejection(
    error: unknown
  ):
    | { readonly kind: "assertion" }
    | { readonly kind: "insert"; readonly producer: object }
    | undefined {
    if (this.ownership !== "standalone" || !this.usesBatch) return undefined;
    if (this.atomicAssertionRejection === error) return { kind: "assertion" };
    const producer = this.rejectedProducer(error);
    return producer ? { kind: "insert", producer } : undefined;
  }
  get transportAttempt(): TransportAttempt {
    return this.attempt;
  }
  restartRejectedInsert(attempt: TransportAttempt): void {
    this.attempt = attempt;
    this.atomicAssertionRejection = undefined;
  }
  emptyBulkResult(select?: Input): unknown {
    const result = () => (select ? [] : { count: 0 });
    if (this.ownership === "batch-preparation") {
      this.preparedParser = result;
      return undefined;
    }
    return result();
  }
  seriesQueries(
    projection: PreparedProjection,
    identities: Input[],
    operation: "createMany" | "updateMany" = "createMany"
  ): Query[] {
    if (identities.length === 0) return [];
    const limit = normalizedBindParameterLimit(
      this.driver.maxBindParametersPerStatement
    );
    const preparedQueries = new WeakMap<Sql, Query>();
    const chunks = compileBindBudgetChunks(
      identities.length,
      limit,
      (start, end) => {
        const query = this.queries.selectSeries(
          projection,
          identities.slice(start, end),
          operation
        );
        preparedQueries.set(query.sql, query);
        return query.sql;
      }
    );
    return chunks.map(({ statement }) => preparedQueries.get(statement)!);
  }
  finish(): Promise<void> {
    return this.finishValue(undefined);
  }
  finishValue<T>(value: T): Promise<T> {
    return this.finishTerminals([], () => value);
  }
  finishOne(query: Query): Promise<Input | undefined> {
    return this.finishTerminals([query], (rows) => rows[0]);
  }
  finishMany(queries: readonly Query[]): Promise<Input[]> {
    return this.finishTerminals(queries, (rows) => rows);
  }
  private decodeTerminalResults(
    queries: readonly Query[],
    results: readonly QueryResult<unknown>[],
    resultIndex: number
  ): Input[] {
    const output: Input[] = [];
    for (const [offset, terminal] of queries.entries()) {
      const response = results[resultIndex + offset];
      if (!response)
        throw new TransactionError(
          `Driver '${this.driver.driverName}' omitted the ${this.ownership === "batch-preparation" ? "prepared" : "terminal"} result for operation '${this.operation}'.`,
          { meta: this.attribution }
        );
      output.push(
        ...this.queries.decodeQuery(terminal, response.rows.map(record))
      );
    }
    return output;
  }
  private async finishTerminals<T>(
    queries: readonly Query[],
    result: (rows: Input[]) => T
  ): Promise<T> {
    if (!this.usesBatch) {
      const output: Input[] = [];
      for (const terminal of queries) output.push(...(await this.read(terminal)));
      return result(output);
    }
    const resultIndex = this.attempt.pending.length;
    for (const terminal of queries) this.queue(terminal.sql);
    if (this.attempt.scratchId)
      this.queue(
        getAdapterInternals(this.driver.adapter).batchRefs.cleanup(
          this.attempt.scratchId
        )
      );
    if (this.ownership === "batch-preparation") {
      this.preparedParser = (results) =>
        result(this.decodeTerminalResults(queries, results, resultIndex));
      return result([]);
    }
    if (this.attempt.pending.length === 0) return result([]);
    const responses = await this.submit();
    try {
      return result(
        this.decodeTerminalResults(queries, responses, resultIndex)
      );
    } catch (error) {
      throw queries.length ? this.failure(error, "result") : error;
    }
  }
  isIncompletePreparation(error: unknown): boolean {
    return error === this.incompletePreparation;
  }
  preparedBatch(): PreparedBatchOperation<unknown> | undefined {
    if (this.preparedParser === undefined) return undefined;
    if (this.attempt.assertionFailures.size > 0) return undefined;
    return {
      queries: this.attempt.pending.map((query) => ({
        sql: query.sql,
        params: query.params ?? [],
        context: query.context ?? this.attribution
      })),
      parseResult: this.preparedParser
    };
  }
  private async setMutation(
    statement: Sql,
    context: QueryExecutionContext,
    parse: (result: QueryResult<unknown>) => unknown
  ): Promise<unknown> {
    return this.setMutations([{ sql: statement, context }], (results) => {
      const result = results[0];
      if (!result)
        throw new TransactionError(
          `Driver '${this.driver.driverName}' omitted the result for operation '${this.operation}'.`,
          { meta: this.attribution }
        );
      return parse(result);
    });
  }
  private async setMutations(
    statements: readonly {
      readonly sql: Sql;
      readonly context: QueryExecutionContext;
    }[],
    parse: (results: readonly QueryResult<unknown>[]) => unknown
  ): Promise<unknown> {
    if (this.ownership === "batch-preparation") {
      const firstResult = this.attempt.pending.length;
      for (const statement of statements)
        this.queue(statement.sql, statement.context);
      this.preparedParser = (results) => {
        const window = results.slice(
          firstResult,
          firstResult + statements.length
        );
        if (window.length !== statements.length) {
          throw new TransactionError(
            `Driver '${this.driver.driverName}' omitted a prepared result for operation '${this.operation}'.`,
            { meta: this.attribution }
          );
        }
        return parse(window);
      };
      return undefined;
    }
    if (this.usesBatch) {
      const windowMember: Member = {};
      for (const statement of statements)
        this.queue(statement.sql, statement.context, windowMember);
      const results = await this.submit(true, windowMember);
      try {
        return parse(results);
      } catch (error) {
        throw this.failure(error, "result", windowMember);
      }
    }
    const results: QueryResult<unknown>[] = [];
    for (const statement of statements)
      results.push(
        await this.transport._execute(statement.sql, statement.context)
      );
    return parse(results);
  }
  async createMany(
    model: AnyModel,
    rows: Input[],
    select?: Input,
    skipDuplicates = false
  ): Promise<unknown> {
    if (rows.length === 0) return this.emptyBulkResult(select);
    const q = this.queries;
    const adapter = this.driver.adapter;
    const projection = select
      ? q.prepareProjection(model, { select })
      : undefined;
    if (skipDuplicates && rows.some((row) => Object.keys(row).length === 0))
      throw new UnsupportedOperationError(
        "createMany with skipDuplicates cannot include a row with no explicit scalar values; no portable duplicate-only DEFAULT VALUES primitive exists."
      );
    const buildInsert = (
      columns: readonly string[],
      members: readonly Input[],
      applySqlSkip: boolean
    ) => {
      if (columns.length === 0)
        return adapter.mutations.insertDefault(q.table(model));
      const duplicate = applySqlSkip
        ? adapter.mutations.skipDuplicates(q.columnName(model, columns[0]!))
        : undefined;
      const mutation = adapter.mutations.insert(
        q.table(model),
        columns.map((field) => q.columnName(model, field)),
        members.map((row) =>
          columns.map((field) => q.fieldValue(model, field, row[field]))
        ),
        duplicate?.prefix
      );
      return duplicate?.suffix
        ? sql`${mutation} ${duplicate.suffix}`
        : mutation;
    };
    const recoverableSkip =
      skipDuplicates &&
      adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError";
    if (
      recoverableSkip ||
      (projection && !adapter.capabilities.supportsReturning)
    ) {
      if (this.ownership === "batch-preparation") throw this.incompletePreparation;
      if (recoverableSkip) this.requireSuppression();
      const identityPlans = projection
        ? rows.map((row) => {
            const missing = this.schema
              .keys(model)
              .filter((field) => row[field] === undefined);
            const generated = this.insertIdField(model, missing);
            if (missing.length > 0 && generated === undefined)
              throw new TransactionError(
                `Driver '${this.driver.driverName}' cannot locate one selected createMany row after insertion.`,
                { meta: this.attribution }
              );
            return generated;
          })
        : undefined;
      const members = this.prepareMembers(() => rows);
      const identities: Input[] = [];
      let count = 0;
      for (const [index, row] of members.entries()) {
        const columns = Object.keys(row);
        const statement = buildInsert(columns, [row], false);
        const context = this.statementContext(model, "createMany");
        let response: QueryResult<unknown> | undefined;
        if (recoverableSkip) {
          response = await this.executeMember(async () => {
            try {
              return await this.withMemberRollback((driver) =>
                driver._execute(statement, context)
              );
            } catch (error) {
              if (error instanceof UniqueConstraintError) return undefined;
              throw error;
            }
          }, row);
        } else {
          response = await this.executeMember(
            () => this.transport._execute(statement, context),
            row
          );
        }
        if (!response) continue;
        count += response.rowCount;
        if (!identityPlans) continue;
        const generated = identityPlans[index];
        if (generated && response.insertId === undefined)
          throw new TypeError("INSERT did not produce the required record identity");
        identities.push({
          ...this.schema.identity(model, row),
          ...(generated ? { [generated]: response.insertId } : {})
        });
      }
      return projection
        ? identities.length
          ? this.finishMany(this.seriesQueries(projection, identities))
          : []
        : { count };
    }
    const returning = projection
      ? adapter.mutations.returning(
          sql.join(q.lowerProjection(projection).columns, ", ")
        )
      : undefined;
    const groups: { readonly columns: string[]; readonly rows: Input[] }[] = [];
    for (const row of rows) {
      const columns = Object.keys(row);
      const preceding = groups.at(-1);
      if (
        columns.length === 0 ||
        !preceding ||
        preceding.columns.length !== columns.length ||
        columns.some((column, index) => preceding.columns[index] !== column)
      )
        groups.push({ columns, rows: [row] });
      else preceding.rows.push(row);
    }
    const limit = normalizedBindParameterLimit(
      this.driver.maxBindParametersPerStatement
    );
    const statements: { sql: Sql; context: QueryExecutionContext }[] = [];
    for (const group of groups) {
      if (group.columns.length === 0) {
        for (const _row of group.rows) {
          let statement = adapter.mutations.insertDefault(q.table(model));
          if (returning) statement = sql`${statement} ${returning}`;
          statements.push({
            sql: statement,
            context: this.statementContext(model, "createMany")
          });
        }
        continue;
      }
      const chunks = compileBindBudgetChunks(
        group.rows.length,
        limit,
        (start, end) => {
          const mutation = buildInsert(
            group.columns,
            group.rows.slice(start, end),
            skipDuplicates
          );
          return returning ? sql`${mutation} ${returning}` : mutation;
        }
      );
      for (const chunk of chunks)
        statements.push({
          sql: chunk.statement,
          context: this.statementContext(model, "createMany")
        });
    }
    return this.setMutations(statements, (results) => {
      if (!projection)
        return {
          count: results.reduce((count, result) => count + result.rowCount, 0)
        };
      const output: Input[] = [];
      for (const result of results)
        output.push(
          ...q.decodeProjection(projection.shape, result.rows.map(record))
        );
      return output;
    });
  }
  async updateMany(
    model: AnyModel,
    selector: PreparedSelector,
    values: Input,
    limit?: number,
    select?: Input
  ): Promise<unknown> {
    const q = this.queries;
    const adapter = this.driver.adapter;
    const assignments = Object.entries(values).map(([field, value]) =>
      adapter.set.assign(
        q.column(model, field),
        q.updateValue(model, field, value)
      )
    );
    const projection = select
      ? q.prepareProjection(model, { select })
      : undefined;
    if (projection && !adapter.capabilities.supportsReturning) {
      const identities = await this.captureMutationIdentities(
        model,
        selector,
        limit
      );
      if (identities.length === 0) return [];
      const statement = adapter.mutations.update(
        q.table(model),
        sql.join(assignments, ", "),
        adapter.operators.or(
          ...identities.map((identity) => q.lowerIdentity(model, identity))
        )
      );
      const response = await this.transport._execute(
        statement,
        this.statementContext(model, "updateMany")
      );
      if (response.rowCount !== identities.length)
        throw new TransactionError(
          "updateMany selected-row cardinality changed during its locked mutation.",
          { meta: this.attribution }
        );
      return this.finishMany(
        this.seriesQueries(
          projection,
          identities.map((identity) =>
            this.updatedIdentity(model, identity, values)
          ),
          "updateMany"
        )
      );
    }
    const limited = q.lowerMutationLimit(model, selector, limit);
    const mutation = adapter.mutations.update(
      q.table(model),
      sql.join(assignments, ", "),
      limited.where
    );
    let statement = limited.suffix
      ? sql`${mutation} ${limited.suffix}`
      : mutation;
    if (projection)
      statement = sql`${statement} ${adapter.mutations.returning(
        sql.join(q.lowerProjection(projection).columns, ", ")
      )}`;
    return this.setMutation(
      statement,
      this.statementContext(model, "updateMany"),
      (result) =>
        projection
          ? q.decodeProjection(projection.shape, result.rows.map(record))
          : { count: result.rowCount }
    );
  }
  async deleteMany(
    model: AnyModel,
    selector: PreparedSelector,
    limit?: number,
    select?: Input
  ): Promise<unknown> {
    const q = this.queries;
    const adapter = this.driver.adapter;
    const projection = select
      ? q.prepareProjection(model, { select })
      : undefined;
    if (projection && !adapter.capabilities.supportsReturning) {
      const identities = await this.captureMutationIdentities(
        model,
        selector,
        limit
      );
      if (identities.length === 0) return [];
      const rows: Input[] = [];
      for (const query of this.seriesQueries(projection, identities))
        rows.push(...(await this.read(query)));
      const response = await this.transport._execute(
        adapter.mutations.delete(
          q.table(model),
          adapter.operators.or(
            ...identities.map((identity) => q.lowerIdentity(model, identity))
          )
        ),
        this.statementContext(model, "deleteMany")
      );
      if (response.rowCount !== identities.length)
        throw new TransactionError(
          "deleteMany selected-row cardinality changed during its locked mutation.",
          { meta: this.attribution }
        );
      return rows;
    }
    const limited = q.lowerMutationLimit(model, selector, limit);
    const mutation = adapter.mutations.delete(
      q.table(model),
      limited.where
    );
    let statement = limited.suffix
      ? sql`${mutation} ${limited.suffix}`
      : mutation;
    if (projection)
      statement = sql`${statement} ${adapter.mutations.returning(
        sql.join(q.lowerProjection(projection).columns, ", ")
      )}`;
    return this.setMutation(
      statement,
      this.statementContext(model, "deleteMany"),
      (result) =>
        projection
          ? q.decodeProjection(projection.shape, result.rows.map(record))
          : { count: result.rowCount }
    );
  }
  private async captureMutationIdentities(
    model: AnyModel,
    selector: PreparedSelector,
    limit: number | undefined
  ): Promise<Input[]> {
    if (this.ownership === "batch-preparation")
      throw this.incompletePreparation;
    if (this.usesBatch)
      throw new TransactionError(
        `Driver '${this.driver.driverName}' cannot atomically capture selected ${this.operation} rows.`,
        { meta: this.attribution }
      );
    const keys = this.schema.keys(model);
    const rows = await this.read(
      this.queries.select(
        model,
        {
          select: Object.fromEntries(keys.map((field) => [field, true])),
          take: limit
        },
        undefined,
        { selector, forUpdate: true }
      ),
      true
    );
    return rows.map((row) => this.schema.identity(model, row));
  }
  private updatedIdentity(
    model: AnyModel,
    identity: Input,
    values: Input
  ): Input {
    const q = this.queries;
    return Object.fromEntries(
      this.schema.keys(model).map((field) => [
        field,
        Object.hasOwn(values, field)
          ? q.updateValue(
              model,
              field,
              values[field],
              q.fieldValue(model, field, identity[field])
            )
          : identity[field]
      ])
    );
  }
  private ensureScratch(): string {
    const attempt = this.attempt;
    if (attempt.scratchId) return attempt.scratchId;
    const references = getAdapterInternals(this.driver.adapter).batchRefs;
    attempt.scratchId = crypto.randomUUID();
    for (const setup of references.setup(attempt.scratchId)) this.queue(setup);
    this.queue(references.clear(attempt.scratchId));
    return attempt.scratchId;
  }
  private insertIdField(
    model: AnyModel,
    produced: readonly string[]
  ): string | undefined {
    if (produced.length !== 1) return undefined;
    const field = produced[0]!;
    return model["~"].state.scalars[field]!["~"].state.autoGenerate?.kind ===
      "increment"
      ? field
      : undefined;
  }
  async insert(
    model: AnyModel,
    values: Input,
    demanded: ReadonlySet<string>,
    member: Member,
    operation = "create",
    producer?: object
  ): Promise<Input> {
    const q = this.queries;
    const adapter = this.driver.adapter;
    const fields = Object.keys(values);
    let statement = fields.length
      ? adapter.mutations.insert(
          q.table(model),
          fields.map((field) => q.columnName(model, field)),
          [fields.map((field) => q.fieldValue(model, field, values[field]))]
        )
      : adapter.mutations.insertDefault(q.table(model));
    const produced = [...demanded].filter(
      (field) => values[field] === undefined
    );
    const context = this.statementContext(model, operation);
    if (!this.usesBatch) {
      const producedProjection = produced.length
        ? q.prepareProjection(model, {
            select: Object.fromEntries(produced.map((field) => [field, true]))
          })
        : undefined;
      const insertIdField = adapter.capabilities.supportsReturning
        ? undefined
        : this.insertIdField(model, produced);
      if (
        produced.length &&
        !adapter.capabilities.supportsReturning &&
        insertIdField === undefined
      )
        throw new Error(
          "Raptor 3 interactive output requires RETURNING or one generated increment field"
        );
      if (producedProjection && adapter.capabilities.supportsReturning)
        statement = sql`${statement} ${adapter.mutations.returning(
          sql.join(q.lowerProjection(producedProjection).columns, ", ")
        )}`;
      this.attempt.rejectedInsert = undefined;
      let response: QueryResult<Input>;
      try {
        response = await this.transport._execute<Input>(statement, context);
      } catch (error) {
        if (producer && error instanceof UniqueConstraintError)
          this.attempt.rejectedInsert = { error, producer };
        throw error;
      }
      const producedRows =
        insertIdField === undefined
          ? response.rows
          : response.insertId === undefined
            ? []
            : [{ [insertIdField]: response.insertId }];
      const producedValues = producedProjection
        ? q.decodeProjection(producedProjection.shape, producedRows, true)[0]
        : undefined;
      if (produced.length && producedValues === undefined)
        throw new TypeError("INSERT did not produce the required record");
      return {
        ...values,
        ...producedValues
      };
    }
    const published: Input = { ...values };
    if (produced.length) {
      const references = getAdapterInternals(adapter).batchRefs;
      if (
        this.insertIdField(model, produced) === undefined ||
        !references.storeLastInsertId
      ) {
        if (
          !adapter.capabilities.supportsReturning ||
          adapter.capabilities.supportsCteWithMutations
        )
          throw new Error(
            "Raptor 3 G1 atomic output requires exact identity scratch or segmented RETURNING"
          );
        // The next segment must prove the actual stored owner, including supplied row-key fields.
        const returned = [
          ...new Set([...this.schema.keys(model), ...demanded])
        ];
        const select = Object.fromEntries(
          returned.map((field) => [field, true])
        );
        const projection = q.prepareProjection(model, { select });
        const resultIndex = this.attempt.pending.length;
        const inserted = this.queue(
          sql`${statement} ${adapter.mutations.returning(
            sql.join(q.lowerProjection(projection).columns, ", ")
          )}`,
          context,
          member
        );
        if (producer) this.attempt.insertProducers.set(inserted, producer);
        const responses = await this.submit(true, member);
        let stored: Input;
        try {
          const rows = q.decodeProjection(
            projection.shape,
            responses[resultIndex]!.rows,
            true
          );
          if (!rows[0])
            throw new TypeError(
              "INSERT RETURNING did not produce the required record"
            );
          stored = rows[0];
        } catch (error) {
          throw this.failure(error, "result", member);
        }
        this.continuations.push({
          model,
          query: q.select(model, {}, undefined, {
            projection,
            identity: stored,
          })
        });
        return { ...values, ...stored };
      }
      const scratchId = this.ensureScratch();
      const inserted = this.queue(statement, context, member);
      if (producer) this.attempt.insertProducers.set(inserted, producer);
      const key = String(this.attempt.nextField++);
      this.queue(references.storeLastInsertId(scratchId, key));
      published[produced[0]!] = adapter.expressions.cast(
        references.read(scratchId, key),
        "integer"
      );
    } else {
      const inserted = this.queue(statement, context, member);
      if (producer) this.attempt.insertProducers.set(inserted, producer);
    }
    return published;
  }
  async update(
    model: AnyModel,
    where: Input,
    values: Input,
    member: Member,
    operation = "update",
    demanded: ReadonlySet<string> = new Set(),
    captured: Input = where
  ): Promise<Input> {
    if (Object.keys(values).length === 0) return {};
    const q = this.queries;
    const adapter = this.driver.adapter;
    const written = { ...values };
    if (this.usesBatch) {
      for (const field of demanded) {
        const value = values[field];
        if (value === null || typeof value !== "object" || value instanceof Sql)
          continue;
        const state = physicalField(this.schema, model, field).scalar["~"]
          .state;
        if (state.type !== "int")
          throw new Error(
            "Raptor 3 update expression publication requires an integer field"
          );
        const references = getAdapterInternals(adapter).batchRefs;
        const scratchId = this.ensureScratch();
        const key = String(this.attempt.nextField++);
        // The UPDATE and every consumer use this one evaluated value in the same batch.
        this.queue(
          references.store(
            scratchId,
            key,
            q.updateValue(
              model,
              field,
              value,
              q.fieldValue(model, field, captured[field])
            )
          )
        );
        written[field] = adapter.expressions.cast(
          references.read(scratchId, key),
          "integer"
        );
      }
    }
    const assignments = Object.entries(written).map(([field, value]) =>
      adapter.set.assign(
        q.column(model, field),
        q.updateValue(model, field, value)
      )
    );
    const statement = adapter.mutations.update(
      q.table(model),
      sql.join(assignments, ", "),
      q.lowerIdentity(model, where)
    );
    const context = this.statementContext(model, operation);
    if (!this.usesBatch && demanded.size) {
      const fields = [...demanded];
      const select = Object.fromEntries(fields.map((field) => [field, true]));
      const projection = q.prepareProjection(model, { select });
      if (!adapter.capabilities.supportsReturning) {
        await this.transport._execute(statement, context);
        // The mutation's locked capture remains protected through this stored-row read.
        const rows = await this.read(
          q.select(model, {}, undefined, {
            projection,
            identity: this.updatedIdentity(model, captured, values),
          }),
          true
        );
        if (!rows[0])
          throw new TypeError("UPDATE did not produce the required record");
        return { ...written, ...rows[0] };
      }
      const response = await this.transport._execute<Input>(
        sql`${statement} ${adapter.mutations.returning(
          sql.join(q.lowerProjection(projection).columns, ", ")
        )}`,
        context
      );
      const rows = q.decodeProjection(projection.shape, response.rows, true);
      if (!rows[0])
        throw new TypeError(
          "UPDATE RETURNING did not produce the required record"
        );
      return { ...written, ...rows[0] };
    }
    await this.effect(statement, context, member);
    return written;
  }
  async associate(
    edge: Membership,
    source: Input,
    target: Input,
    member: Member
  ): Promise<void> {
    if (edge.kind === "reference") {
      const model = edge.owner === "source" ? edge.source : edge.target;
      const row = edge.owner === "source" ? source : target;
      const values = Object.fromEntries(
        edge.pairs.map((pair) =>
          edge.owner === "source"
            ? [pair.source, target[pair.target]]
            : [pair.target, source[pair.source]]
        )
      );
      await this.update(
        model,
        this.schema.identity(model, row),
        values,
        member
      );
      return;
    }
    await this.link(
      edge,
      Object.fromEntries([
        ...edge.sourceSide.members.map((pair) => [
          pair.junctionField,
          source[pair.referencedField]
        ]),
        ...edge.targetSide.members.map((pair) => [
          pair.junctionField,
          target[pair.referencedField]
        ])
      ]),
      member
    );
  }
  async link(
    edge: Extract<Membership, { kind: "junction" }>,
    values: Input,
    member: Member,
    captured?: Input
  ): Promise<void> {
    const adapter = this.driver.adapter;
    const q = this.queries;
    const columns = [
      ...edge.sourceSide.members,
      ...edge.targetSide.members
    ].map((pair) => pair.junctionField);
    if (captured) {
      if (columns.every((field) => Object.is(captured[field], values[field]))) {
        return;
      }
      const remove = adapter.mutations.delete(
        adapter.identifiers.table(edge.table),
        q.junctionWhere(edge, captured)
      );
      const context = this.statementContext(edge.source, "update");
      if (this.usesBatch) this.queue(remove, context, member);
      else {
        const response = await this.transport._execute(remove, context);
        if (response.rowCount !== 1) {
          const failure = new TransactionError(
            `Concurrent membership change on the singular polymorphic member of relation '${edge.name}': the captured owner's membership was already removed; retry to converge.`
          );
          failure.meta.raceable = true;
          throw failure;
        }
      }
    }
    const operands = [edge.sourceSide, edge.targetSide].flatMap((side) =>
      side.members.map((pair) =>
        q.fieldValue(
          side.model,
          pair.referencedField,
          values[pair.junctionField]
        )
      )
    );
    if (!adapter.capabilities.supportsTargetedUpsert) {
      const targetAlias = q.alias();
      const membershipAlias = q.alias();
      // The target membership is an outer join, not a target-table subquery.
      const select = assembleAdapterSelect(adapter, {
        columns: sql.join(operands, ", "),
        from: q.table(edge.target, targetAlias),
        joins: [
          adapter.joins.left(
            adapter.identifiers.table(edge.table, membershipAlias),
            q.junctionWhere(edge, values, membershipAlias)
          )
        ],
        where: adapter.operators.and(
          ...edge.targetSide.members.map((pair) =>
            adapter.operators.eq(
              q.column(edge.target, pair.referencedField, targetAlias),
              q.fieldValue(
                edge.target,
                pair.referencedField,
                values[pair.junctionField]
              )
            )
          ),
          adapter.operators.isNull(
            adapter.identifiers.column(membershipAlias, columns[0]!)
          )
        )
      });
      await this.effect(
        adapter.mutations.insert(
          adapter.identifiers.table(edge.table),
          columns,
          { select }
        ),
        this.statementContext(edge.source, "update"),
        member
      );
      return;
    }
    const insert = adapter.mutations.insert(
      adapter.identifiers.table(edge.table),
      columns,
      [operands]
    );
    await this.effect(
      sql`${insert} ${adapter.mutations.onConflict(
        sql.join(
          columns.map((column) => adapter.identifiers.escape(column)),
          ", "
        ),
        sql`NOTHING`
      )}`,
      this.statementContext(edge.source, "update"),
      member
    );
  }
  async captureMembership(
    edge: Extract<Membership, { kind: "junction" }>,
    addressed: Input
  ): Promise<Input | undefined> {
    const query = this.queries.junction(edge, addressed, !this.usesBatch);
    const rows = await this.read(query, true);
    const captured = rows[0] ? { ...addressed, ...rows[0] } : undefined;
    if (this.usesBatch) {
      const failure = new NestedWriteError(
        `Concurrent membership change on the singular polymorphic member of relation '${edge.name}': ${captured ? "the captured membership is gone" : "another owner holds the target"}; retry to converge.`,
        edge.name
      );
      if (captured)
        this.requirePresent(this.queries.junction(edge, captured), failure);
      else {
        failure.meta.raceable = true;
        await this.requireAbsent(query, failure);
      }
    }
    return captured;
  }
  async clear(edge: Membership, source: Input, member: Member): Promise<void> {
    if (edge.kind !== "junction")
      throw new Error("Raptor 3 G1 set requires junction storage");
    const a = this.driver.adapter;
    await this.effect(
      a.mutations.delete(
        a.identifiers.table(edge.table),
        a.operators.and(
          ...edge.sourceSide.members.map((pair) =>
            a.operators.eq(
              a.identifiers.escape(pair.junctionField),
              this.queries.fieldValue(
                edge.source,
                pair.referencedField,
                source[pair.referencedField]
              )
            )
          )
        )
      ),
      this.statementContext(edge.source, "update"),
      member
    );
  }
  async remove(
    edge: Membership,
    source: Input | undefined,
    target: Input | undefined,
    keep: Input[],
    member: Member
  ): Promise<void> {
    const a = this.driver.adapter;
    const q = this.queries;
    if (edge.kind === "junction") {
      const conditions: Sql[] = [];
      for (const [side, values] of [
        [edge.sourceSide, source],
        [edge.targetSide, target]
      ] as const) {
        if (!values) continue;
        for (const pair of side.members)
          conditions.push(
            a.operators.eq(
              a.identifiers.escape(pair.junctionField),
              q.fieldValue(
                side.model,
                pair.referencedField,
                values[pair.referencedField]
              )
            )
          );
      }
      if (keep.length)
        conditions.push(
          a.operators.not(
            a.operators.or(
              ...keep.map((row) =>
                q.junctionWhere(
                  edge,
                  Object.fromEntries(
                    edge.targetSide.members.map((pair) => [
                      pair.junctionField,
                      row[pair.referencedField]
                    ])
                  )
                )
              )
            )
          )
        );
      await this.effect(
        a.mutations.delete(
          a.identifiers.table(edge.table),
          a.operators.and(...conditions)
        ),
        this.statementContext(edge.source, "update"),
        member
      );
      return;
    }
    const where = a.operators.and(
      ...edge.pairs.map((pair) =>
        a.operators.eq(
          q.column(edge.target, pair.target),
          q.fieldValue(edge.target, pair.target, source![pair.source])
        )
      ),
      ...(edge.discriminator
        ? [
            a.operators.eq(
              q.column(edge.target, edge.discriminator.field),
              q.value(edge.discriminator.value)
            )
          ]
        : []),
      ...(target
        ? [
            q.lowerIdentity(
              edge.target,
              this.schema.identity(edge.target, target)
            ),
          ]
        : []),
      ...(keep.length
        ? [
            a.operators.not(
              a.operators.or(
                ...keep.map(
                  (row) =>
                    q.lowerIdentity(
                      edge.target,
                      this.schema.identity(edge.target, row)
                    )
                )
              )
            )
          ]
        : [])
    );
    const clearability = edge.clearability as Extract<
      Membership["clearability"],
      { kind: "columns" }
    >;
    const values = clearability.fields.map((field) =>
      a.set.assign(q.column(edge.target, field), a.literals.null())
    );
    await this.effect(
      a.mutations.update(q.table(edge.target), sql.join(values, ", "), where),
      this.statementContext(edge.target, "update"),
      member
    );
  }
  async delete(model: AnyModel, row: Input, member: Member): Promise<void> {
    await this.effect(
      this.driver.adapter.mutations.delete(
        this.queries.table(model),
        this.queries.lowerIdentity(model, this.schema.identity(model, row))
      ),
      this.statementContext(model, "delete"),
      member
    );
  }
  private async effect(
    statement: Sql,
    context: QueryExecutionContext,
    member: Member
  ): Promise<void> {
    if (this.usesBatch) this.queue(statement, context, member);
    else await this.transport._execute(statement, context);
  }
}
