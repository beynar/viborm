import {
  assembleAdapterSelect,
  getAdapterInternals,
} from "@adapters/adapter-internals";
import type { AnyDriver } from "@drivers";
import { batchMayContainAssertionCollision } from "@drivers/error-mapping";
import type {
  BatchQuery,
  QueryExecutionContext,
  QueryResult,
} from "@drivers/types";
import {
  attachRecordSeriesProgress,
  NestedWriteAssertionError,
  NestedWriteError,
  QueryEngineError,
  type RecordSeriesProgress,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
} from "@errors";
import type { AnyModel } from "@schema/model";
import { Sql, sql } from "@sql";
import type { PreparedBatchOperation } from "../../types";
import { InvalidScalarResult, Queries, type Query } from "./query";
import {
  type EngineSchema,
  type Input,
  type Operation,
  record,
} from "./schema";
import { type Membership, physicalField } from "./storage";
import { TransportAttempt } from "./transport-attempt";

export type Member = object & { readonly memberPath?: readonly number[] };

export type ExecutionBinding =
  | { readonly kind: "borrowed-transaction"; readonly driver: AnyDriver }
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
  private transport: AnyDriver;
  private attempt = new TransportAttempt();
  private readonly committedMembers = new Set<Member>();
  private readonly continuations: { query: Query; model: AnyModel }[] = [];
  private committedSegments = 0;
  private mayHaveCommittedSegment: true | undefined;
  private completedMembers = 0;
  private totalMembers: number | undefined;
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
            method: "$transaction([...])",
          },
        }
      );
    }
    this.ownership = prepareBatch
      ? "batch-preparation"
      : (binding?.kind ?? "standalone");
    this.driver = binding?.driver ?? factoryDriver;
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
      correlationId: this.correlationId,
    };
  }
  private statementContext(
    model: AnyModel,
    operation: string
  ): QueryExecutionContext {
    return {
      model: model["~"].names.ts!,
      operation,
      correlationId: this.correlationId,
    };
  }
  private queue(
    statement: Sql,
    context: QueryExecutionContext = this.attribution,
    member?: Member
  ): BatchQuery {
    const query = {
      ...this.transport._prepare(statement, context),
      context,
    };
    this.attempt.pending.push(query);
    if (member) this.attempt.pendingMembers.add(member);
    return query;
  }
  beginSeries(): void {
    this.totalMembers = undefined;
  }
  prepareMembers<T extends Member>(prepare: () => T[], parent?: Member): T[] {
    this.memberAdmissionStarted = true;
    try {
      const members = prepare();
      if (parent) {
        const path = parent.memberPath ?? [];
        this.totalMembers = path.length === 0 ? members.length : undefined;
        for (const [index, member] of members.entries())
          Object.assign(member, { memberPath: [...path, index] });
      }
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
      await this.flush(undefined, member);
      this.completedMembers++;
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
      const outer = this.transport;
      try {
        await outer.withTransaction(
          async (transaction) => {
            this.transport = transaction;
            try {
              await execute();
            } finally {
              this.transport = outer;
            }
          },
          undefined,
          this.attribution
        );
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
  suppressionRefusal(): TransactionError | undefined {
    return this.ownership !== "standalone" || this.usesBatch
      ? new TransactionError(
          "Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.",
          {
            meta: {
              driver: this.driver.driverName,
              model: this.modelName,
              operation: this.operation,
            },
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
    return this.usesBatch &&
      (phase === "prefix" ||
        this.committedSegments > 0 ||
        this.mayHaveCommittedSegment)
      ? attachRecordSeriesProgress(error, {
          atomicity: "segment",
          phase,
          committedSegments: this.committedSegments,
          committedWriteMembers: this.committedMembers.size,
          completedMembers: this.completedMembers,
          ...(member?.memberPath?.length
            ? { memberPath: member.memberPath }
            : {}),
          ...(this.totalMembers === undefined
            ? {}
            : { totalMembers: this.totalMembers }),
          ...(this.mayHaveCommittedSegment
            ? { mayHaveCommittedSegment: this.mayHaveCommittedSegment }
            : {}),
        })
      : error;
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
      if (this.usesBatch) {
        try {
          return await body();
        } catch (error) {
          throw this.continuations.length
            ? this.failure(error, "member")
            : error;
        }
      }
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
      if (!(error instanceof InvalidScalarResult)) throw error;
      const driver = this.driver.driverName;
      const operation = this.operation;
      const scalarType = error.scalarType;
      throw new QueryEngineError(
        `Driver "${driver}" returned a malformed ${scalarType} scalar for operation "${operation}": ${error.reason}.`,
        { meta: { driver, operation, scalarType } }
      );
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
    return this.queries.decode(query, response.rows, internal);
  }
  referenceProjection(model: AnyModel, values: Input): Query {
    const adapter = this.driver.adapter;
    const select = Object.fromEntries(
      Object.keys(values).map((field) => [field, true])
    );
    return {
      shape: this.queries.select(model, { select }).shape,
      sql: adapter.clauses.select(
        sql.join(
          Object.entries(values).map(([field, value]) =>
            adapter.identifiers.aliased(
              this.queries.fieldValue(model, field, value),
              field
            )
          ),
          ", "
        )
      ),
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
        this.queries.decode(
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
        context,
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
        ),
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
  async finish(query?: Query): Promise<Input[]> {
    if (!this.usesBatch) return query ? this.read(query) : [];
    const resultIndex = this.attempt.pending.length;
    if (query) this.queue(query.sql);
    if (this.attempt.scratchId)
      this.queue(
        getAdapterInternals(this.driver.adapter).batchRefs.cleanup(
          this.attempt.scratchId
        )
      );
    if (this.ownership === "batch-preparation") {
      this.preparedParser = query
        ? (results) => {
            const response = results[resultIndex];
            if (!response) {
              throw new TransactionError(
                `Driver '${this.driver.driverName}' omitted the prepared result for operation '${this.operation}'.`,
                { meta: this.attribution }
              );
            }
            return this.queries.decode(query, response.rows.map(record))[0];
          }
        : () => undefined;
      return [];
    }
    if (this.attempt.pending.length === 0) return [];
    const responses = await this.submit();
    try {
      return query
        ? this.queries.decode(query, responses[resultIndex]!.rows)
        : [];
    } catch (error) {
      throw this.continuations.length ? this.failure(error, "result") : error;
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
        context: query.context ?? this.attribution,
      })),
      parseResult: this.preparedParser,
    };
  }
  private async setMutation(
    statement: Sql,
    context: QueryExecutionContext,
    parse: (result: QueryResult<unknown>) => unknown
  ): Promise<unknown> {
    if (this.ownership === "batch-preparation") {
      const resultIndex = this.attempt.pending.length;
      this.queue(statement, context);
      this.preparedParser = (results) => {
        const result = results[resultIndex];
        if (!result) {
          throw new TransactionError(
            `Driver '${this.driver.driverName}' omitted the prepared result for operation '${this.operation}'.`,
            { meta: this.attribution }
          );
        }
        return parse(result);
      };
      return undefined;
    }
    return parse(await this.transport._execute(statement, context));
  }
  async createMany(
    model: AnyModel,
    rows: Input[],
    select?: Input
  ): Promise<unknown> {
    if (rows.length === 0) {
      if (this.ownership === "batch-preparation") {
        this.preparedParser = select ? () => [] : () => ({ count: 0 });
        return undefined;
      }
      return select ? [] : { count: 0 };
    }
    const columns = Object.keys(rows[0]!);
    if (columns.length === 0) {
      throw new UnsupportedOperationError(
        "Raptor 3 G3P-03 default-only createMany is not implemented."
      );
    }
    for (const row of rows) {
      const names = Object.keys(row);
      if (
        names.length !== columns.length ||
        columns.some((name) => !Object.hasOwn(row, name))
      ) {
        throw new UnsupportedOperationError(
          "Raptor 3 G3P-03 createMany requires one scalar row shape."
        );
      }
    }
    const q = this.queries;
    const adapter = this.driver.adapter;
    let statement = adapter.mutations.insert(
      q.table(model),
      columns.map((field) => q.columnName(model, field)),
      rows.map((row) =>
        columns.map((field) => q.fieldValue(model, field, row[field]))
      )
    );
    let projection: Query | undefined;
    if (select) {
      const fields = Object.entries(select)
        .filter(([, included]) => included === true)
        .map(([field]) => field);
      const returning = adapter.mutations.returning(
        sql.join(
          fields.map((field) =>
            adapter.identifiers.aliased(q.projectedColumn(model, field), field)
          ),
          ", "
        )
      );
      if (!adapter.capabilities.supportsReturning) {
        throw new TransactionError(
          `Driver '${this.driver.driverName}' cannot execute Raptor 3 createMany returning in G3P-03.`,
          { meta: this.attribution }
        );
      }
      statement = sql`${statement} ${returning}`;
      projection = q.select(model, { select });
    }
    return this.setMutation(
      statement,
      this.statementContext(model, "createMany"),
      (result) => {
        return projection
          ? q.decode(projection, result.rows.map(record))
          : { count: result.rowCount };
      }
    );
  }
  async updateMany(
    model: AnyModel,
    where: Input | undefined,
    values: Input
  ): Promise<unknown> {
    const q = this.queries;
    const adapter = this.driver.adapter;
    const assignments = Object.entries(values).map(([field, value]) =>
      adapter.set.assign(
        q.column(model, field),
        q.updateValue(model, field, value)
      )
    );
    const statement = adapter.mutations.update(
      q.table(model),
      sql.join(assignments, ", "),
      q.where(model, where)
    );
    return this.setMutation(
      statement,
      this.statementContext(model, "updateMany"),
      (result) => ({ count: result.rowCount })
    );
  }
  async deleteMany(
    model: AnyModel,
    where: Input | undefined
  ): Promise<unknown> {
    return this.setMutation(
      this.driver.adapter.mutations.delete(
        this.queries.table(model),
        this.queries.where(model, where)
      ),
      this.statementContext(model, "deleteMany"),
      (result) => ({ count: result.rowCount })
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
      if (produced.length && adapter.capabilities.supportsReturning)
        statement = sql`${statement} ${adapter.mutations.returning(
          sql.join(
            produced.map((field) =>
              adapter.identifiers.aliased(
                q.projectedColumn(model, field),
                field
              )
            ),
            ", "
          )
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
      const projection = produced.length
        ? q.select(model, {
            select: Object.fromEntries(produced.map((field) => [field, true])),
          })
        : undefined;
      const producedValues = projection
        ? q.decode(projection, producedRows, true)[0]
        : undefined;
      if (produced.length && producedValues === undefined)
        throw new TypeError("INSERT did not produce the required record");
      return {
        ...values,
        ...producedValues,
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
          ...new Set([...this.schema.keys(model), ...demanded]),
        ];
        const projection = Object.fromEntries(
          returned.map((field) => [field, true])
        );
        const resultIndex = this.attempt.pending.length;
        const inserted = this.queue(
          sql`${statement} ${adapter.mutations.returning(
            sql.join(
              returned.map((field) =>
                adapter.identifiers.aliased(
                  q.projectedColumn(model, field),
                  field
                )
              ),
              ", "
            )
          )}`,
          context,
          member
        );
        if (producer) this.attempt.insertProducers.set(inserted, producer);
        const responses = await this.submit(true, member);
        let stored: Input;
        try {
          const rows = q.decode(
            q.select(model, { select: projection }),
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
          query: q.select(model, { where: stored, select: projection }),
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
      q.where(model, where)
    );
    const context = this.statementContext(model, operation);
    if (!this.usesBatch && demanded.size) {
      const fields = [...demanded];
      const select = Object.fromEntries(fields.map((field) => [field, true]));
      if (!adapter.capabilities.supportsReturning) {
        await this.transport._execute(statement, context);
        const finalKey = Object.fromEntries(
          this.schema
            .keys(model)
            .map((field) => [
              field,
              Object.hasOwn(values, field)
                ? q.updateValue(
                    model,
                    field,
                    values[field],
                    q.fieldValue(model, field, captured[field])
                  )
                : captured[field],
            ])
        );
        // The mutation's locked capture remains protected through this stored-row read.
        const rows = await this.read(
          q.select(model, { where: finalKey, select }),
          true
        );
        if (!rows[0])
          throw new TypeError("UPDATE did not produce the required record");
        return { ...written, ...rows[0] };
      }
      const response = await this.transport._execute<Input>(
        sql`${statement} ${adapter.mutations.returning(
          sql.join(
            fields.map((field) =>
              adapter.identifiers.aliased(
                q.projectedColumn(model, field),
                field
              )
            ),
            ", "
          )
        )}`,
        context
      );
      const rows = q.decode(q.select(model, { select }), response.rows, true);
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
          source[pair.referencedField],
        ]),
        ...edge.targetSide.members.map((pair) => [
          pair.junctionField,
          target[pair.referencedField],
        ]),
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
      ...edge.targetSide.members,
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
          ),
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
        ),
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
        [edge.targetSide, target],
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
                      row[pair.referencedField],
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
            ),
          ]
        : []),
      ...(target
        ? [q.where(edge.target, this.schema.identity(edge.target, target))!]
        : []),
      ...(keep.length
        ? [
            a.operators.not(
              a.operators.or(
                ...keep.map(
                  (row) =>
                    q.where(
                      edge.target,
                      this.schema.identity(edge.target, row)
                    )!
                )
              )
            ),
          ]
        : [])
    );
    const values = [
      ...edge.pairs.map((pair) =>
        a.set.assign(q.column(edge.target, pair.target), a.literals.null())
      ),
      ...(edge.discriminator
        ? [
            a.set.assign(
              q.column(edge.target, edge.discriminator.field),
              a.literals.null()
            ),
          ]
        : []),
    ];
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
        this.queries.where(model, this.schema.identity(model, row))
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
