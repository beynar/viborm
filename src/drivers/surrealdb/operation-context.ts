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
        if (operator === "divide" && state?.decimal && Number(operand) === 0)
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
    const statement =
      limit === undefined
        ? sql`UPDATE ${fieldName(model["~"].names.sql!)} SET ${assignments} ${this.#where(selector)} ${this.#returning(projection)}`
        : sql`UPDATE ${this.#target(selector, limit)} SET ${assignments} ${this.#returning(projection)}`;
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
    this.#declinePreparation();
    const target = this.#target(selector, limit);
    if (!projection) {
      const { rows } = await this.answer(
        {
          sql: sql`DELETE ${target} RETURN BEFORE`,
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
        : sql`LET $rows = ${target};`;
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
    this.#declinePreparation();
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
    this.#declinePreparation();
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
    if (Object.keys(rest).length === 0) {
      const { response } = await this.#written(
        model,
        sql`SELECT * FROM ${table} WHERE ${identity}`,
        fields,
        answer
      );
      return (
        this.queries.decodeProjection(
          this.queries.prepareProjection(
            model,
            { select: Object.fromEntries(fields.map((f) => [f, true])) },
            true
          ).shape,
          response.rows,
          true
        )[0] ?? {}
      );
    }
    const { response, decoded } = await this.#written(
      model,
      sql`UPDATE ${table} SET ${this.#assignments(model, rest)} WHERE ${identity}`,
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

  /** The key fields a write states, and the record it leaves the row under. */
  #keyChange(model: AnyModel, given: Input): readonly string[] {
    return this.queries
      .keyOrder(model)
      .filter((key) => Object.hasOwn(given, key));
  }

  /**
   * A record's id cannot change, so a new key is a new record: the row is copied
   * under it, what points at it follows, and the old one goes. It runs as one
   * statement, a transaction of its own. An action other than a cascade leaves its
   * reference behind, and the delete then refuses as the foreign key would.
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
    const record = (row: Input) =>
      keys.length === 1
        ? low.value(model, keys[0]!, row[keys[0]!])
        : sql`${low.recordOf(model, row)}`;
    const copied = this.schema
      .storedFields(model)
      .filter((field) => !keys.includes(field))
      .map((field) => {
        const column = fieldName(q.columnName(model, field));
        return sql`${column}: $row.${column}`;
      });
    const follow: Sql[] = [];
    for (const source of Object.values(this.schema.schema) as AnyModel[])
      for (const slot of Object.keys(source["~"].state.relations)) {
        const { edges } = q.countedMemberships(source, slot);
        for (const edge of edges) {
          if (edge.target !== model) continue;
          if (edge.kind === "junction") {
            const { table, near, far } = low.edgeOf(edge);
            // An edge's ends are fixed: it is related again from the new record.
            follow.push(
              sql`FOR $other IN (SELECT VALUE ${near} FROM ${table} WHERE ${far} = $old) { INSERT RELATION IGNORE INTO ${table} [{ ${near}: $other, ${far}: $new }] };`
            );
            continue;
          }
          if (edge.owner !== "source" || edge.discriminator) continue;
          const action = edge.reference?.onUpdate;
          if (action !== undefined && action !== "cascade") continue;
          const holders = edge.pairs.map(({ source: held, target }) => ({
            column: low.physical(source, held),
            value: low.value(source, held, next[target]),
            was: low.value(source, held, identity[target]),
          }));
          if (
            holders.some(({ column }) => column.toStatement().startsWith("id"))
          )
            refuse("a key change under a key that holds it");
          follow.push(
            sql`UPDATE ${fieldName(source["~"].names.sql!)} SET ${sql.join(
              holders.map(({ column, value }) => sql`${column} = ${value}`),
              ", "
            )} WHERE ${sql.join(
              holders.map(({ column, was }) => sql`${column} = ${was}`),
              " AND "
            )};`
          );
        }
      }
    await this.answer(
      {
        sql: sql`RETURN { LET $old = ${record(identity)}; LET $new = ${record(next)}; LET $row = (SELECT * FROM ONLY $old); INSERT INTO ${fieldName(model["~"].names.sql!)} [{ ${sql.join([sql`id: $new`, ...copied], ", ")} }] RETURN NONE; ${sql.join(follow, " ")} DELETE $old; RETURN []; }`,
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
    this.#declinePreparation();
    const table = fieldName(model["~"].names.sql!);
    const fields = projection.fields.map((field) => field.name);
    if (this.#keyChange(model, given).length > 0)
      refuse("changing a key the write locates in its own statement");
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

  /**
   * One edge, where absent: a `RELATE` refuses a pair that already exists. A
   * singular relation's capture is the edge it holds now, which moves first.
   */
  override async link(
    edge: Junction,
    values: Input,
    _member: unknown,
    captured?: Input
  ): Promise<void> {
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

  override async linkMany(
    edge: Junction,
    rows: readonly Input[]
  ): Promise<void> {
    this.#declinePreparation();
    const { table, near, far } = this.#lowering.edgeOf(edge);
    const end = (side: Junction["sourceSide"], values: Input) =>
      this.#lowering.end(side, (pair) => values[pair.junctionField]);
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
  }

  /** Removes an edge and leaves both records. `keep` is only a declared junction's. */
  #unlink(
    edge: Junction,
    read: (
      side: Junction["sourceSide"],
      pair: Junction["sourceSide"]["members"][number]
    ) => unknown
  ) {
    this.#declinePreparation();
    const { table, near, far } = this.#lowering.edgeOf(edge);
    const conditions: Sql[] = [];
    for (const [column, side] of [
      [near, edge.sourceSide],
      [far, edge.targetSide],
    ] as const) {
      if (read(side, side.members[0]!) !== undefined)
        conditions.push(
          sql`${column} = ${this.#lowering.end(side, (pair) => read(side, pair))}`
        );
    }
    return this.#written(
      edge.source,
      sql`DELETE ${table} WHERE ${sql.join(conditions, " AND ")}`,
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
    this.#declinePreparation();
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
