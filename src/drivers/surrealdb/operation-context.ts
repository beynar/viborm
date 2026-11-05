/**
 * PROTOTYPE: `docs/architecture/query-backend-frontier.md` step 5.
 *
 * The four root writes `Commands` folds, in SurrealQL. `Commands`, admission,
 * stamps, the envelope and decoding stay shared. A nested write reaches a method
 * this does not override, whose first adapter read refuses: this driver holds
 * no SQL.
 */

import { UnsupportedOperationError } from "@errors";
import { InsertValue } from "@query-engine/raptor3/shared/insert-value";
import {
  OperationContext,
  type StatementAnswer,
} from "@query-engine/raptor3/shared/operation-context";
import {
  type PreparedProjection,
  type PreparedSelector,
  type Queries,
  returningSafeProjection,
  wholeValue,
} from "@query-engine/raptor3/shared/query";
import type { Input } from "@query-engine/raptor3/shared/schema";
import type { Membership } from "@query-engine/raptor3/shared/storage";
import { writeSinks } from "@query-engine/write-sinks";
import { type Sql, sql } from "@sql";
import { SurrealQueries } from "./queries";
import { SurrealReadBackend } from "./read-backend";

type AnyModel = PreparedProjection["model"];

const ARITHMETIC: Readonly<Record<string, string>> = {
  increment: "+",
  decrement: "-",
  multiply: "*",
};

const UNSUPPORTED_TYPES = new Set([
  "decimal",
  "blob",
  "json",
  "point",
  "vector",
]);

function refuse(what: string): never {
  throw new UnsupportedOperationError(
    `The SurrealDB write backend does not support ${what} yet.`
  );
}

function fieldName(identifier: string): Sql {
  return sql.raw(identifier);
}

export class SurrealOperationContext extends OperationContext {
  constructor(...args: ConstructorParameters<typeof OperationContext>) {
    super(...args);
    const { adapter, result } = this.driver;
    (this as { queries: Queries }).queries = new SurrealQueries(
      args[0],
      adapter,
      result
    );
  }

  get #lowering(): SurrealReadBackend {
    return new SurrealReadBackend(this.queries);
  }

  /**
   * Preparing an array transaction queues statements, and this writes through
   * none: running here would write outside the transaction, so it declines and
   * the array runs each member inside it instead.
   */
  #declinePreparation(): void {
    if (this.preparesBatch) throw this.incompletePreparation;
    if (writeSinks.get(this.attribution)) refuse("a write a hook observes");
  }

  /** `RETURN` reads any row after a write; `RETURN BEFORE` only its own. */
  override answersInStatement(
    _model: AnyModel,
    projection: PreparedProjection,
    effect: "insert" | "update" | "delete"
  ): boolean {
    return effect !== "delete" || returningSafeProjection(projection);
  }

  #checked(model: AnyModel, values: Input): void {
    for (const [field, value] of Object.entries(values)) {
      if (value instanceof InsertValue) refuse(`a computed value ('${field}')`);
      const type = model["~"].state.scalars[field]?.["~"].state.type;
      if (type === undefined) refuse(`the relation '${field}' in a write`);
      if (UNSUPPORTED_TYPES.has(type)) refuse(`the type '${type}' in a write`);
      if (model["~"].state.scalars[field]?.["~"].state.array)
        refuse(`the list '${field}' in a write`);
    }
  }

  /** One row as an object literal: an absent or null field stores nothing. */
  #row(model: AnyModel, row: Input): Sql {
    this.#checked(model, row);
    const keys = this.queries.keyOrder(model);
    if (keys.some((key) => row[key] === undefined))
      refuse("a key the database generates");
    const members = Object.entries(row)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(
        ([field, value]) =>
          sql`${fieldName(this.queries.columnName(model, field))}: ${this.#lowering.value(model, field, value)}`
      );
    return sql`{ ${sql.join(members, ", ")} }`;
  }

  #assignments(model: AnyModel, values: Input): Sql {
    this.#checked(model, values);
    const keys = this.queries.keyOrder(model);
    const q = this.queries;
    return sql.join(
      Object.entries(values).map(([field, given]) => {
        if (keys.includes(field)) refuse("changing a record's key");
        const column = fieldName(q.columnName(model, field));
        const whole = wholeValue(given);
        if (whole) {
          return whole.value === null
            ? sql`${column} = NONE`
            : sql`${column} = ${this.#lowering.value(model, field, whole.value)}`;
        }
        const [operator, operand] = Object.entries(given as Input)[0]!;
        const sign = ARITHMETIC[operator];
        if (!sign) refuse(`the '${operator}' update`);
        const change = sql`${column} ${sql.raw(sign)} ${operand as number}`;
        // SQL leaves NULL as it is, where NONE would refuse the arithmetic.
        return model["~"].state.scalars[field]?.["~"].state.nullable
          ? sql`${column} = (IF ${column} = NONE { NONE } ELSE { ${change} })`
          : sql`${column} = ${change}`;
      }),
      ", "
    );
  }

  #returning(projection?: PreparedProjection): Sql {
    return projection
      ? sql`RETURN ${this.#lowering.columns(projection)}`
      : sql`RETURN id`;
  }

  #where(selector: PreparedSelector, limit: number | undefined): Sql {
    const { model, predicate } = selector;
    const lowered = predicate && this.#lowering.predicate(predicate, true);
    const table = fieldName(model["~"].names.sql!);
    if (limit === undefined)
      return lowered ? sql`WHERE ${lowered}` : sql.raw("");
    const order = this.#lowering.order(model, undefined);
    const inner = lowered ? sql`WHERE ${lowered} ` : sql.raw("");
    return sql`WHERE id IN (SELECT VALUE id FROM ${table} ${inner}ORDER BY ${order} LIMIT ${sql.raw(String(Number(limit)))})`;
  }

  async #finish(
    model: AnyModel,
    statement: Sql,
    projection: PreparedProjection | undefined,
    single: (() => Error) | undefined
  ): Promise<unknown> {
    const shape = projection?.shape ?? {
      kind: "object" as const,
      fields: {},
    };
    const { rows } = await this.answer({ sql: statement, shape }, true, model);
    if (!projection) return { count: rows.length };
    return this.published(
      this.publishedProjection(projection.shape, rows as Input[]),
      single
    );
  }

  override async createMany(
    model: AnyModel,
    given: Input[],
    projection?: PreparedProjection,
    skipDuplicates = false,
    single?: () => Error
  ): Promise<never> {
    this.#declinePreparation();
    if (given.length === 0) return { count: 0 } as never;
    const table = fieldName(model["~"].names.sql!);
    const rows = sql.join(
      given.map((row) => this.#row(model, row)),
      ", "
    );
    const verb = sql.raw(skipDuplicates ? "INSERT IGNORE" : "INSERT");
    const statement = sql`${verb} INTO ${table} [${rows}] ${this.#returning(projection)}`;
    return (await this.#finish(model, statement, projection, single)) as never;
  }

  override async updateMany(
    model: AnyModel,
    selector: PreparedSelector,
    given: Input,
    limit?: number,
    projection?: PreparedProjection,
    single?: () => Error,
    captured?: readonly Input[]
  ): Promise<unknown> {
    this.#declinePreparation();
    if (captured) refuse("a tombstone");
    const table = fieldName(model["~"].names.sql!);
    const statement = sql`UPDATE ${table} SET ${this.#assignments(model, given)} ${this.#where(selector, limit)} ${this.#returning(projection)}`;
    return await this.#finish(model, statement, projection, single);
  }

  override async deleteMany(
    model: AnyModel,
    selector: PreparedSelector,
    limit?: number,
    projection?: PreparedProjection,
    single?: () => Error
  ): Promise<unknown> {
    this.#declinePreparation();
    const table = fieldName(model["~"].names.sql!);
    const statement = sql`DELETE ${table} ${this.#where(selector, limit)} RETURN BEFORE`;
    const { rows } = await this.answer(
      {
        sql: statement,
        shape: projection?.shape ?? { kind: "object", fields: {} },
      },
      true,
      model
    );
    if (!projection) return { count: rows.length };
    // BEFORE is the whole row, and a row carries no key for a field it lacks.
    const q = this.queries;
    const named = (rows as Input[]).map((row) =>
      Object.fromEntries(
        projection.fields.map((field) => [
          field.name,
          row[q.columnName(model, field.name)] ?? null,
        ])
      )
    );
    return this.published(
      this.publishedProjection(projection.shape, named),
      single
    );
  }

  /** One record's write, inside the transaction `Commands` opened. */
  override async insert(
    model: AnyModel,
    given: Input,
    demanded: ReadonlySet<string>,
    _member: unknown,
    _operation = "create",
    _producer?: object,
    _membership?: unknown,
    _refusal?: unknown,
    answer?: StatementAnswer
  ): Promise<Input> {
    this.#declinePreparation();
    const table = fieldName(model["~"].names.sql!);
    const produced = [...demanded].filter(
      (field) => given[field] === undefined
    );
    const { response, decoded } = await this.#written(
      model,
      sql`INSERT INTO ${table} [${this.#row(model, given)}]`,
      produced,
      answer
    );
    if (produced.length && !response.rows[0])
      throw new TypeError("INSERT did not produce the required record");
    return { ...given, ...decoded };
  }

  override async update(
    model: AnyModel,
    current: Input,
    given: Input,
    _member: unknown,
    _operation = "update",
    demanded: ReadonlySet<string> = new Set(),
    missing?: () => Error,
    _judgement?: unknown,
    _refusal?: unknown,
    answer?: StatementAnswer
  ): Promise<Input> {
    this.#declinePreparation();
    if (Object.keys(given).length === 0) return {};
    const table = fieldName(model["~"].names.sql!);
    const identity = this.#lowering.identity(
      model,
      this.schema.identity(model, current)
    );
    const fields = [...demanded];
    const { response, decoded } = await this.#written(
      model,
      sql`UPDATE ${table} SET ${this.#assignments(model, given)} WHERE ${identity}`,
      fields,
      answer
    );
    if (fields.length && !response.rows[0])
      throw (
        missing?.() ??
        new TypeError("UPDATE RETURNING did not produce the required record")
      );
    return decoded;
  }

  override async delete(model: AnyModel, row: Input): Promise<void> {
    this.#declinePreparation();
    const table = fieldName(model["~"].names.sql!);
    const identity = this.#lowering.identity(
      model,
      this.schema.identity(model, row)
    );
    await this.answer(
      {
        sql: sql`DELETE ${table} WHERE ${identity} RETURN BEFORE`,
        shape: { kind: "object", fields: {} },
      },
      false,
      model
    );
  }

  /** A write and what it must read back: named fields and the caller's answer. */
  async #written(
    model: AnyModel,
    statement: Sql,
    fields: readonly string[],
    answer: StatementAnswer | undefined
  ) {
    const q = this.queries;
    const projection = fields.length
      ? q.prepareProjection(
          model,
          { select: Object.fromEntries(fields.map((field) => [field, true])) },
          true
        )
      : undefined;
    const seen = new Set<string>();
    const returned = [answer?.projection, projection].flatMap(
      (read) =>
        read?.fields
          .filter((field) => !seen.has(field.name) && seen.add(field.name))
          .map((field) => this.#lowering.column(read.model, field)) ?? []
    );
    const clause = returned.length
      ? sql`RETURN ${sql.join(returned, ", ")}`
      : sql`RETURN id`;
    const response = await this.answer(
      {
        sql: sql`${statement} ${clause}`,
        shape: projection?.shape ?? { kind: "object", fields: {} },
      },
      false,
      model
    );
    if (answer) answer.row = response.rows[0];
    const decoded = projection
      ? (q.decodeProjection(projection.shape, response.rows, true)[0] ?? {})
      : {};
    return { response, decoded };
  }

  override async updateLocated(
    model: AnyModel,
    selector: PreparedSelector,
    given: Input,
    projection: PreparedProjection,
    missing: () => Error,
    _operation = "update",
    _refusal?: unknown,
    answer?: StatementAnswer
  ): Promise<Input> {
    this.#declinePreparation();
    const table = fieldName(model["~"].names.sql!);
    const fields = projection.fields.map((field) => field.name);
    const { response, decoded } = await this.#written(
      model,
      sql`UPDATE ${table} SET ${this.#assignments(model, given)} ${this.#where(selector, undefined)}`,
      fields,
      answer
    );
    if (!response.rows[0]) throw missing();
    return decoded;
  }

  override async updateRows(
    model: AnyModel,
    identities: readonly Input[],
    values: Input
  ): Promise<void> {
    this.#declinePreparation();
    const table = fieldName(model["~"].names.sql!);
    const rows = sql.join(
      identities.map(
        (identity) =>
          sql`(${this.#lowering.identity(model, this.schema.identity(model, identity))})`
      ),
      " OR "
    );
    await this.#written(
      model,
      sql`UPDATE ${table} SET ${this.#assignments(model, values)} WHERE ${rows}`,
      [],
      undefined
    );
  }

  /** A relation's members, updated or deleted as a set. */
  override async mutateMembers(
    edge: Membership,
    parent: Input,
    selector: PreparedSelector,
    values: Input | undefined
  ): Promise<void> {
    this.#declinePreparation();
    const model = edge.target;
    const table = fieldName(model["~"].names.sql!);
    const conditions = [
      this.#lowering.member(edge, parent),
      ...(selector.predicate
        ? [this.#lowering.predicate(selector.predicate, true)]
        : []),
    ];
    const where = sql.join(conditions, " AND ");
    await this.#written(
      model,
      values
        ? sql`UPDATE ${table} SET ${this.#assignments(model, values)} WHERE ${where}`
        : sql`DELETE ${table} WHERE ${where}`,
      [],
      undefined
    );
  }

  /** Clears a relation's link: every member, one, or all but those kept. */
  override async remove(
    edge: Membership,
    source: Input | undefined,
    target: Input | undefined,
    keep: Input[]
  ): Promise<void> {
    this.#declinePreparation();
    const model = edge.target;
    const clearability = edge.clearability;
    if (clearability.kind !== "columns") refuse("clearing this relation");
    const table = fieldName(model["~"].names.sql!);
    const cleared = Object.fromEntries(
      clearability.fields.map((field) => [field, null])
    );
    const identity = (row: Input) =>
      this.#lowering.identity(model, this.schema.identity(model, row));
    const conditions = [
      this.#lowering.member(edge, source ?? {}),
      ...(target ? [identity(target)] : []),
      ...(keep.length
        ? [
            sql`!(${sql.join(
              keep.map((row) => sql`(${identity(row)})`),
              " OR "
            )})`,
          ]
        : []),
    ];
    await this.#written(
      model,
      sql`UPDATE ${table} SET ${this.#assignments(model, cleared)} WHERE ${sql.join(conditions, " AND ")}`,
      [],
      undefined
    );
  }

  override async upsertOne(
    model: AnyModel,
    given: Input,
    updates: Input,
    target: readonly string[],
    projection?: PreparedProjection,
    single?: () => Error,
    upserted?: (created: boolean) => void
  ): Promise<unknown> {
    this.#declinePreparation();
    if (upserted) refuse("an upsert a hook observes");
    const keys = this.queries.keyOrder(model);
    if (target.length !== keys.length || target[0] !== keys[0])
      refuse("an upsert on a key other than the record's own");
    const table = fieldName(model["~"].names.sql!);
    const assignments =
      Object.keys(updates).length === 0
        ? sql.raw("id = id")
        : this.#assignments(model, updates);
    const statement = sql`INSERT INTO ${table} ${this.#row(model, given)} ON DUPLICATE KEY UPDATE ${assignments} ${this.#returning(projection)}`;
    return await this.#finish(model, statement, projection, single);
  }
}
