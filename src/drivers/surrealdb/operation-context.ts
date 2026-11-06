/**
 * PROTOTYPE: `docs/architecture/query-backend-frontier.md` step 5.
 *
 * The writes `Commands` asks for, in SurrealQL. `Commands`, admission, stamps, the
 * envelope and decoding stay shared. A method this does not override refuses at
 * its first adapter read: this driver holds no SQL.
 */

import {
  QueryEngineError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
} from "@errors";
import { dividesByZero } from "@query-engine/raptor3/shared/decimal";
import { InsertValue } from "@query-engine/raptor3/shared/insert-value";
import {
  OperationContext,
  type StatementAnswer,
} from "@query-engine/raptor3/shared/operation-context";
import {
  type PreparedProjection,
  type PreparedSelector,
  type Queries,
  wholeValue,
} from "@query-engine/raptor3/shared/query";
import type { Input } from "@query-engine/raptor3/shared/schema";
import {
  linkMembers,
  type Membership,
} from "@query-engine/raptor3/shared/storage";
import { writeSinks } from "@query-engine/write-sinks";
import { getModelKeyCatalog } from "@schema/model/keys";
import { type Sql, sql } from "@sql";
import { SurrealQueries } from "./queries";
import { quantized, SurrealReadBackend } from "./read-backend";

type AnyModel = PreparedProjection["model"];
type Junction = Extract<Membership, { kind: "junction" }>;

const ARITHMETIC: Readonly<Record<string, string>> = {
  increment: "+",
  decrement: "-",
  multiply: "*",
  divide: "/",
};

const CONFLICT = /can be retried|read or write conflict/;

/**
 * A key a moved row can hold beside its old self: only what its field's type
 * admits, and nothing it could ever keep, since it is overwritten in that statement.
 */
const STAND_INS: Readonly<Record<string, Sql>> = {
  string: sql.raw("rand::string(32)"),
  int: sql.raw("rand::int(-2147483648, 2147483647)"),
  bigint: sql.raw("rand::int(-2147483648, 2147483647)"),
};

/**
 * Failures that leave a nested scope having written nothing, which is all a scope
 * can undo here without a savepoint: the transaction around it goes on.
 */
export const WROTE_NOTHING = new WeakSet<object>();

/** Two transactions that met at commit, in the words SurrealDB has for it. */
export function isConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (CONFLICT.test(error.message) ||
      (error.cause instanceof Error && CONFLICT.test(error.cause.message)))
  );
}

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

  /**
   * No locks: two writers meet at commit, where the other databases meet at a
   * unique key. The loser plans again once, from what the winner committed, under
   * the one recovery an operation is allowed.
   */
  override async run<T>(body: () => Promise<T>, single = false): Promise<T> {
    try {
      return await super.run(body, single);
    } catch (error) {
      if (!(isConflict(error) && this.replaysInPlace)) throw error;
      const replacement = this.spendRecovery();
      if (!replacement) throw error;
      this.restartRejectedInsert(replacement);
      // Two losers replaying together would only meet again.
      await new Promise((resolve) =>
        setTimeout(resolve, 5 + Math.random() * 45)
      );
      return await super.run(body, single);
    }
  }

  #backend: SurrealReadBackend | undefined;

  get #lowering(): SurrealReadBackend {
    this.#backend ??= new SurrealReadBackend(this.queries);
    return this.#backend;
  }

  #writes = 0;

  /**
   * Every write says so here. Preparing an array transaction queues statements,
   * and this writes through none: running here would write outside the transaction,
   * so it declines and the array runs each member inside it instead.
   */
  #writing(): void {
    if (this.preparesBatch) throw this.incompletePreparation;
    if (writeSinks.get(this.attribution)) refuse("a write a hook observes");
    this.#writes += 1;
  }

  /** A member skipped at its own row, before any write, has nothing to take back. */
  override async executeSkippableMember(
    execute: () => Promise<void>,
    rootProducer: object,
    member: Parameters<OperationContext["executeSkippableMember"]>[2]
  ): Promise<boolean> {
    const before = this.#writes;
    return await super.executeSkippableMember(
      async () => {
        try {
          await execute();
        } catch (error) {
          if (
            this.#writes === before &&
            this.rejectedProducer(error) === rootProducer
          )
            WROTE_NOTHING.add(error as object);
          throw error;
        }
      },
      rootProducer,
      member
    );
  }

  /** `RETURN` reads any row after a write, and a delete reads ahead of itself. */
  override answersInStatement(): boolean {
    return true;
  }

  #checked(model: AnyModel, values: Input): void {
    for (const [field, value] of Object.entries(values)) {
      if (value instanceof InsertValue) refuse(`a computed value ('${field}')`);
      if (model["~"].state.relations[field])
        refuse(`the relation '${field}' in a write`);
    }
  }

  /** One row as an object literal: an absent or null field stores nothing. */
  #row(model: AnyModel, row: Input): Sql {
    this.#checked(model, row);
    const keys = this.queries.keyOrder(model);
    const key = this.#recordKey(model, row, keys);
    const members = Object.entries(row)
      .filter(
        ([field, value]) =>
          value !== null && value !== undefined && !keys.includes(field)
      )
      .map(
        ([field, value]) =>
          sql`${fieldName(this.queries.columnName(model, field))}: ${this.#lowering.value(model, field, value)}`
      );
    return sql`{ ${sql.join([sql`id: ${key}`, ...members], ", ")} }`;
  }

  /** A row's id: what it states, or the next of its sequence. */
  #recordKey(model: AnyModel, row: Input, keys: readonly string[]): Sql {
    if (keys.length > 1) {
      if (keys.some((key) => row[key] === undefined))
        refuse("a compound key the database generates");
      return sql`${this.#lowering.recordOf(model, row)}`;
    }
    const given = row[keys[0]!];
    if (given !== undefined)
      return this.#lowering.value(model, keys[0]!, given);
    const state = model["~"].state.scalars[keys[0]!]?.["~"].state;
    if (state?.autoGenerate?.kind !== "increment")
      refuse("a key the database generates");
    return sql`sequence::nextval(${`${model["~"].names.sql!}_seq`})`;
  }

  #assignments(model: AnyModel, values: Input): Sql {
    this.#checked(model, values);
    const keys = this.queries.keyOrder(model);
    const _q = this.queries;
    return sql.join(
      Object.entries(values).map(([field, given]) => {
        if (keys.includes(field)) refuse("changing a record's key");
        const column = this.#lowering.physical(model, field);
        const whole = wholeValue(given);
        if (whole) {
          return whole.value === null
            ? sql`${column} = NONE`
            : sql`${column} = ${this.#lowering.value(model, field, whole.value)}`;
        }
        const [operator, operand] = Object.entries(given as Input)[0]!;
        const state = model["~"].state.scalars[field]?.["~"].state;
        if (operator === "push" || operator === "unshift") {
          const members = this.#lowering.value(model, field, [operand].flat());
          return operator === "push"
            ? sql`${column} = array::concat(${column} ?? [], ${members})`
            : sql`${column} = array::concat(${members}, ${column} ?? [])`;
        }
        const sign = ARITHMETIC[operator];
        if (!sign) refuse(`the '${operator}' update`);
        if (operator === "divide" && state?.decimal && dividesByZero(operand))
          throw new QueryEngineError(
            `Cannot divide decimal field '${field}' by zero.`
          );
        const by = this.#lowering.value(model, field, operand);
        const computed = sql`${column} ${sql.raw(sign)} ${by}`;
        const change =
          operator === "multiply" || operator === "divide"
            ? quantized(state, computed)
            : computed;
        // SQL leaves NULL as it is, where NONE would refuse the arithmetic.
        return state?.nullable
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

  #where(selector: PreparedSelector): Sql {
    const { predicate } = selector;
    const lowered = predicate && this.#lowering.predicate(predicate, true);
    return lowered ? sql`WHERE ${lowered}` : sql.raw("");
  }

  /** What a bulk write takes: the table, or the first rows of it in key order. */
  #target(selector: PreparedSelector, limit: number | undefined): Sql {
    const { model } = selector;
    const table = fieldName(model["~"].names.sql!);
    if (limit === undefined) return sql`${table} ${this.#where(selector)}`;
    return sql`(SELECT VALUE id FROM ${table} ${this.#where(selector)} ORDER BY ${this.#lowering.order(model, undefined)} LIMIT ${sql.raw(String(Number(limit)))})`;
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
    this.#writing();
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
    this.#writing();
    if (captured) refuse("a tombstone");
    if (this.#keyChange(model, given).length > 0)
      return await this.#updateKeys(
        model,
        selector,
        given,
        limit,
        projection,
        single
      );
    const assignments = this.#assignments(model, given);
    const statement = this.#lowering.hoisted(() =>
      limit === undefined
        ? sql`UPDATE ${fieldName(model["~"].names.sql!)} SET ${assignments} ${this.#where(selector)} ${this.#returning(projection)}`
        : sql`UPDATE ${this.#target(selector, limit)} SET ${assignments} ${this.#returning(projection)}`
    );
    return await this.#finish(model, statement, projection, single);
  }

  /** A bulk write that moves keys: each record moves, and the rest of it follows. */
  async #updateKeys(
    model: AnyModel,
    selector: PreparedSelector,
    given: Input,
    limit: number | undefined,
    projection: PreparedProjection | undefined,
    single: (() => Error) | undefined
  ): Promise<unknown> {
    const q = this.queries;
    const keys = q.keyOrder(model);
    const located = await this.answer(
      {
        sql: sql`SELECT ${sql.join(
          keys.map(
            (key) =>
              sql`${this.#lowering.physical(model, key)} AS ${fieldName(key)}`
          ),
          ", "
        )} FROM ${this.#target(selector, limit)}`,
        shape: { kind: "object", fields: {} },
      },
      false,
      model
    );
    const moved: Input[] = [];
    for (const row of located.rows as Input[])
      moved.push(await this.#moveRecord(model, row, given));
    const rest = this.#withoutKeys(model, given);
    const conditions = moved.map(
      (row) => sql`(${this.#lowering.identity(model, row)})`
    );
    const table = fieldName(model["~"].names.sql!);
    const where = conditions.length
      ? sql.join(conditions, " OR ")
      : sql.raw("false");
    const statement =
      Object.keys(rest).length > 0
        ? sql`UPDATE ${table} SET ${this.#assignments(model, rest)} WHERE ${where} ${this.#returning(projection)}`
        : sql`SELECT ${projection ? this.#lowering.columns(projection) : sql.raw("id")} FROM ${table} WHERE ${where}`;
    return await this.#finish(model, statement, projection, single);
  }

  override async deleteMany(
    model: AnyModel,
    selector: PreparedSelector,
    limit?: number,
    projection?: PreparedProjection,
    single?: () => Error
  ): Promise<unknown> {
    this.#writing();
    if (!projection) {
      const { rows } = await this.answer(
        {
          sql: this.#lowering.hoisted(
            () => sql`DELETE ${this.#target(selector, limit)} RETURN BEFORE`
          ),
          shape: { kind: "object", fields: {} },
        },
        true,
        model
      );
      return { count: rows.length };
    }
    // `RETURN BEFORE` is the row alone, so what it answers reads ahead of it, in
    // the one statement: a block runs as a transaction of its own.
    const table = fieldName(model["~"].names.sql!);
    const located =
      limit === undefined
        ? sql`LET $rows = (SELECT VALUE id FROM ${table} ${this.#where(selector)});`
        : sql`LET $rows = ${this.#target(selector, limit)};`;
    const { rows } = await this.answer(
      {
        sql: sql`RETURN { ${located} LET $answer = (SELECT ${this.#lowering.columns(projection)} FROM $rows); DELETE $rows; RETURN $answer; }`,
        shape: projection.shape,
      },
      true,
      model
    );
    return this.published(
      this.publishedProjection(projection.shape, rows as Input[]),
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
    producer?: object,
    _membership?: unknown,
    _refusal?: unknown,
    answer?: StatementAnswer
  ): Promise<Input> {
    this.#writing();
    const table = fieldName(model["~"].names.sql!);
    const produced = [...demanded].filter(
      (field) => given[field] === undefined
    );
    // No savepoints: a statement that fails ends the transaction. An insert that
    // may be answered another way is one that ignores its conflict, and says so.
    const verb = sql.raw(producer ? "INSERT IGNORE" : "INSERT");
    const { response, decoded } = await this.#written(
      model,
      sql`${verb} INTO ${table} [${this.#row(model, given)}]`,
      produced,
      answer
    );
    if (producer && !response.rows[0]) {
      const error = new UniqueConstraintError(
        `A record of '${model["~"].names.ts}' already holds these values.`
      );
      this.#writes -= 1;
      this.rejectInsert(error, producer);
      throw error;
    }
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
    this.#writing();
    if (Object.keys(given).length === 0) return {};
    const table = fieldName(model["~"].names.sql!);
    let row = this.schema.identity(model, current);
    let rest = given;
    if (this.#keyChange(model, given).length > 0) {
      row = await this.#moveRecord(model, row, given);
      rest = this.#withoutKeys(model, given);
    }
    const identity = this.#lowering.identity(model, row);
    const fields = [...demanded];
    // A key that moved may be all there was: `UPDATE` reads what it asks back.
    const assignments =
      Object.keys(rest).length === 0
        ? sql.raw("")
        : sql`SET ${this.#assignments(model, rest)} `;
    const { response, decoded } = await this.#written(
      model,
      sql`UPDATE ${table} ${assignments}WHERE ${identity}`,
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
    this.#writing();
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

  /** The key fields a write states, and the record it leaves the row under. */
  #keyChange(model: AnyModel, given: Input): readonly string[] {
    return this.queries
      .keyOrder(model)
      .filter((key) => Object.hasOwn(given, key));
  }

  /**
   * What stands in for a moved row's unique fields while both copies exist: its
   * unique indexes would read the old row as a duplicate of the new one. One field
   * out of the way frees a key over several, and a missing value is in no index.
   */
  #standIns(model: AnyModel): Map<string, Sql | undefined> {
    const keys = this.queries.keyOrder(model);
    const scalars = model["~"].state.scalars;
    const standIns = new Map<string, Sql | undefined>();
    const standIn = (field: string) => {
      const state = scalars[field]?.["~"].state;
      return !state || state.array || this.#lowering.holdsRecord(model, field)
        ? undefined
        : STAND_INS[state.type as string];
    };
    for (const fields of getModelKeyCatalog(model).referenceableKeys) {
      // The id holds a key naming it: no index does.
      if (fields.some((field) => keys.includes(field))) continue;
      const held = fields.find((field) => standIn(field));
      if (held) {
        standIns.set(held, standIn(held));
        continue;
      }
      const absent = fields.find(
        (field) => scalars[field]?.["~"].state.nullable
      );
      if (!absent)
        refuse(
          `changing the key of '${model["~"].names.ts}', whose unique ${fields.map((field) => `'${field}'`).join(", ")} has no value to stand in`
        );
      standIns.set(absent, undefined);
    }
    return standIns;
  }

  /**
   * A record's id cannot change, so a new key is a new record: the row is copied
   * under it, what points at it does what its action says, and the old one goes.
   * It runs as one statement, a transaction of its own.
   */
  async #moveRecord(
    model: AnyModel,
    identity: Input,
    given: Input
  ): Promise<Input> {
    const q = this.queries;
    const low = this.#lowering;
    const next = { ...identity };
    for (const key of this.#keyChange(model, given)) {
      const whole = wholeValue(given[key]);
      if (!whole) refuse("arithmetic on a record's key");
      next[key] = whole.value;
    }
    const keys = q.keyOrder(model);
    const standIns = this.#standIns(model);
    const copied = this.schema
      .storedFields(model)
      .filter(
        (field) =>
          !keys.includes(field) && (!standIns.has(field) || standIns.get(field))
      )
      .map((field) => {
        const column = fieldName(q.columnName(model, field));
        return sql`${column}: ${standIns.get(field) ?? sql`$row.${column}`}`;
      });
    const restored = [...standIns.keys()].map((field) => {
      const column = fieldName(q.columnName(model, field));
      return sql`${column} = $row.${column}`;
    });
    const refusals: Sql[] = [];
    const follow: Sql[] = [];
    for (const source of Object.values(this.schema.schema) as AnyModel[])
      for (const slot of Object.keys(source["~"].state.relations)) {
        const { edges } = q.countedMemberships(source, slot);
        for (const edge of edges) {
          if (edge.target !== model) continue;
          if (edge.kind === "junction") {
            // A declared link is a row of its model, reached by its own references.
            if (edge.declared) continue;
            const { table, near, far } = low.edgeOf(edge);
            const others = sql`(SELECT VALUE ${near} FROM ${table} WHERE ${far} = $old)`;
            // An edge's ends are fixed: it is related again from the new record. A
            // singular one holds its index until it is gone.
            follow.push(
              edge.uniqueSide
                ? sql`LET $others = ${others}; DELETE ${table} WHERE ${far} = $old; FOR $other IN $others { INSERT RELATION INTO ${table} [{ ${near}: $other, ${far}: $new }] };`
                : near.toStatement() === "in"
                  ? sql`FOR $other IN ${others} { RELATE $other->${table}->$new };`
                  : sql`FOR $other IN ${others} { RELATE $new->${table}->$other };`
            );
            continue;
          }
          if (edge.owner !== "source" || edge.discriminator) continue;
          // Not by the key: its action is an event on the row, which deleting the
          // old copy would fire while the new one is the row that holds the value.
          if (!edge.pairs.every(({ target }) => keys.includes(target)))
            refuse(
              `changing the key of '${model["~"].names.ts}', which '${source["~"].names.ts}' references by another field`
            );
          const holders = edge.pairs.map(({ source: held, target }) => ({
            column: low.physical(source, held),
            value: low.value(source, held, next[target]),
            was: low.value(source, held, identity[target]),
          }));
          const table = fieldName(source["~"].names.sql!);
          const holding = sql.join(
            holders.map(({ column, was }) => sql`${column} = ${was}`),
            " AND "
          );
          // As SQL's foreign keys: left unsaid, a key that is held refuses to change.
          const action = edge.reference?.onUpdate ?? "noAction";
          if (action === "restrict" || action === "noAction") {
            refusals.push(
              sql`IF array::len(SELECT VALUE id FROM ${table} WHERE ${holding} LIMIT 1) > 0 { THROW ${`ON UPDATE REJECT: ${edge.name}`} };`
            );
            continue;
          }
          if (
            holders.some(({ column }) => column.toStatement().startsWith("id"))
          )
            refuse("a key change under a key that holds it");
          follow.push(
            sql`UPDATE ${table} SET ${sql.join(
              holders.map(({ column, value }) =>
                action === "setNull"
                  ? sql`${column} = NONE`
                  : sql`${column} = ${value}`
              ),
              ", "
            )} WHERE ${holding};`
          );
        }
      }
    await this.answer(
      {
        sql: sql`RETURN { LET $old = ${low.recordOfRow(model, identity)}; LET $new = ${low.recordOfRow(model, next)}; IF $new = $old { RETURN []; }; ${sql.join(refusals, " ")} LET $row = (SELECT * FROM ONLY $old); INSERT INTO ${fieldName(model["~"].names.sql!)} [{ ${sql.join([sql`id: $new`, ...copied], ", ")} }] RETURN NONE; ${sql.join(follow, " ")} DELETE $old; ${restored.length ? sql`UPDATE $new SET ${sql.join(restored, ", ")};` : sql.raw("")} RETURN []; }`,
        shape: { kind: "object", fields: {} },
      },
      false,
      model
    );
    return next;
  }

  /** The values a write states beside a key it has already moved. */
  #withoutKeys(model: AnyModel, given: Input): Input {
    const keys = this.queries.keyOrder(model);
    return Object.fromEntries(
      Object.entries(given).filter(([field]) => !keys.includes(field))
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
    this.#writing();
    const table = fieldName(model["~"].names.sql!);
    const fields = projection.fields.map((field) => field.name);
    if (this.#keyChange(model, given).length > 0) {
      const result = await this.#updateKeys(
        model,
        selector,
        given,
        undefined,
        projection,
        missing
      );
      if (answer) answer.row = result as Input;
      return result as Input;
    }
    const { response, decoded } = await this.#written(
      model,
      sql`UPDATE ${table} SET ${this.#assignments(model, given)} ${this.#where(selector)}`,
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
    this.#writing();
    // A list of records reads each by key, where an `OR` of the same scans.
    const records = sql.join(
      identities.map((identity) => this.#lowering.recordOfRow(model, identity)),
      ", "
    );
    await this.#written(
      model,
      sql`UPDATE [${records}] SET ${this.#assignments(model, values)}`,
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
    this.#writing();
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

  /**
   * One edge, where absent: a `RELATE` refuses a pair that already exists. A
   * singular relation's capture is the edge it holds now, which moves first.
   */
  override async link(
    edge: Junction,
    values: Input,
    _member: unknown,
    captured?: Input,
    written?: Input
  ): Promise<void> {
    if (edge.declared) {
      await this.#linkDeclared(edge, values, written);
      return;
    }
    if (captured) {
      const columns = linkMembers(edge).map(({ pair }) => pair.junctionField);
      if (columns.every((field) => Object.is(captured[field], values[field])))
        return;
      const { response } = await this.#unlink(
        edge,
        (_side, pair) => captured[pair.junctionField]
      );
      if (response.rowCount !== 1) {
        const failure = new TransactionError(
          `Concurrent membership change on the singular polymorphic member of relation '${edge.name}': the captured owner's membership was already removed; retry to converge.`
        );
        failure.meta.raceable = true;
        throw failure;
      }
    }
    await this.linkMany(edge, [values]);
  }

  /**
   * A link that is a row of its model: its members from the two records, its
   * defaults, and what the call states. One that exists takes only the stated.
   */
  async #linkDeclared(
    edge: Junction,
    values: Input,
    written?: Input
  ): Promise<void> {
    this.#writing();
    const low = this.#lowering;
    const model = edge.declared!.model;
    const members = linkMembers(edge).map(({ pair }) => pair.junctionField);
    const defaults = this.schema
      .linkDefaults(model, new Set(members))
      .filter((field) => !(written && Object.hasOwn(written, field)));
    const row: Input = {
      ...Object.fromEntries(
        members.map((column) => [low.linkFieldOf(edge, column), values[column]])
      ),
      ...this.schema.createValues(
        model,
        Object.fromEntries(defaults.map((field) => [field, undefined]))
      ),
      ...written,
    };
    const stated = Object.keys(written ?? {});
    const table = fieldName(model["~"].names.sql!);
    const stamped = Object.keys(model["~"].state.scalars).filter(
      (field) =>
        model["~"].state.scalars[field]!["~"].state.autoGenerate?.kind ===
          "updatedAt" && !stated.includes(field)
    );
    const stamps = this.schema.createValues(
      model,
      Object.fromEntries(stamped.map((field) => [field, undefined]))
    );
    await this.#written(
      model,
      stated.length
        ? sql`INSERT INTO ${table} ${this.#row(model, row)} ON DUPLICATE KEY UPDATE ${this.#assignments(model, { ...written, ...stamps })}`
        : sql`INSERT IGNORE INTO ${table} [${this.#row(model, row)}]`,
      [],
      undefined
    );
  }

  override async linkMany(
    edge: Junction,
    rows: readonly Input[]
  ): Promise<void> {
    this.#writing();
    if (edge.declared) {
      for (const values of rows) await this.#linkDeclared(edge, values);
      return;
    }
    const { table, near, far } = this.#lowering.edgeOf(edge);
    const end = (side: Junction["sourceSide"], values: Input) =>
      this.#lowering.end(side, (pair) => values[pair.junctionField]);
    if (edge.uniqueSide) {
      // A singular relation needs its index, so its edges carry a record, and a
      // `RELATE` would refuse the pair an idempotent link must skip.
      const edges = rows.map(
        (values) =>
          sql`{ ${near}: ${end(edge.sourceSide, values)}, ${far}: ${end(edge.targetSide, values)} }`
      );
      await this.#written(
        edge.source,
        sql`INSERT RELATION IGNORE INTO ${table} [${sql.join(edges, ", ")}]`,
        [],
        undefined
      );
      return;
    }
    // A `LIGHTWEIGHT` edge is its pair, so `RELATE` is idempotent by itself and
    // takes one source's targets in one statement.
    // The links of one run share their parent, so one source.
    const source = end(edge.sourceSide, rows[0]!);
    const targets = sql`[${sql.join(
      rows.map((values) => end(edge.targetSide, values)),
      ", "
    )}]`;
    await this.#written(
      edge.source,
      near.toStatement() === "in"
        ? sql`RELATE (${source})->${table}->(${targets})`
        : sql`RELATE (${targets})->${table}->(${source})`,
      [],
      undefined
    );
  }

  /** Removes a link's row. What it keeps is a target's fields, not its key. */
  async #unlinkDeclared(
    edge: Junction,
    source: Input | undefined,
    target: Input | undefined,
    keep: readonly Input[]
  ): Promise<void> {
    const low = this.#lowering;
    const model = edge.declared!.model;
    const matches = (side: Junction["sourceSide"], row: Input) =>
      sql.join(
        side.members.map((pair) => {
          const field = low.linkFieldOf(edge, pair.junctionField);
          return sql`${low.physical(model, field)} = ${low.value(model, field, row[pair.referencedField])}`;
        }),
        " AND "
      );
    const conditions = [
      ...(source ? [matches(edge.sourceSide, source)] : []),
      ...(target ? [matches(edge.targetSide, target)] : []),
      ...keep.map((row) => sql`!(${matches(edge.targetSide, row)})`),
    ];
    await this.#written(
      model,
      sql`DELETE ${fieldName(model["~"].names.sql!)} WHERE ${sql.join(conditions, " AND ")}`,
      [],
      undefined
    );
  }

  /** Removes an edge and leaves both records. `keep` is only a declared junction's. */
  #unlink(
    edge: Junction,
    read: (
      side: Junction["sourceSide"],
      pair: Junction["sourceSide"]["members"][number]
    ) => unknown
  ) {
    this.#writing();
    const { table, far, out } = this.#lowering.edgeOf(edge);
    const end = (side: Junction["sourceSide"]) =>
      this.#lowering.end(side, (pair) => read(side, pair));
    const hasSource =
      read(edge.sourceSide, edge.sourceSide.members[0]!) !== undefined;
    const hasTarget =
      read(edge.targetSide, edge.targetSide.members[0]!) !== undefined;
    // From its source, an edge is reached along the record's own list.
    const statement = hasSource
      ? sql`DELETE ${end(edge.sourceSide)}${out}${hasTarget ? sql` WHERE ${far} = ${end(edge.targetSide)}` : sql.raw("")}`
      : sql`DELETE ${table} WHERE ${far} = ${end(edge.targetSide)}`;
    return this.#written(edge.source, statement, [], undefined);
  }

  /** Clears a relation's link: every member, one, or all but those kept. */
  override async remove(
    edge: Membership,
    source: Input | undefined,
    target: Input | undefined,
    keep: Input[]
  ): Promise<void> {
    this.#writing();
    if (edge.kind === "junction" && edge.declared) {
      await this.#unlinkDeclared(edge, source, target, keep);
      return;
    }
    if (edge.kind === "junction") {
      await this.#unlink(edge, (side, pair) => {
        const row = side === edge.sourceSide ? source : target;
        return row?.[pair.referencedField];
      });
      return;
    }
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
    this.#writing();
    if (upserted) refuse("an upsert a hook observes");
    const keys = this.queries.keyOrder(model);
    const table = fieldName(model["~"].names.sql!);
    const row = this.#row(model, given);
    const returning = this.#returning(projection);
    const unchanged = Object.keys(updates).length === 0;
    if (keys.every((key) => target.includes(key))) {
      const assignments = unchanged
        ? sql.raw("id = id")
        : this.#assignments(model, updates);
      const statement = sql`INSERT INTO ${table} ${row} ON DUPLICATE KEY UPDATE ${assignments} ${returning}`;
      return await this.#finish(model, statement, projection, single);
    }
    // `ON DUPLICATE KEY` takes a conflict on any index, and only the target's
    // may update: the record is found by it, and another conflict still refuses.
    const found = sql.join(
      target.map(
        (field) =>
          sql`${this.#lowering.physical(model, field)} = ${this.#lowering.value(model, field, given[field])}`
      ),
      " AND "
    );
    const update = unchanged
      ? sql`SELECT ${projection ? this.#lowering.columns(projection) : sql.raw("id")} FROM $found`
      : sql`UPDATE $found SET ${this.#assignments(model, updates)} ${returning}`;
    const statement = sql`RETURN { LET $found = (SELECT VALUE id FROM ${table} WHERE ${found} LIMIT 1)[0]; RETURN IF $found != NONE { ${update} } ELSE { INSERT INTO ${table} [${row}] ${returning} }; }`;
    return await this.#finish(model, statement, projection, single);
  }
}
