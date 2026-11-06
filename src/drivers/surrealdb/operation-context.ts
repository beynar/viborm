/**
 * PROTOTYPE: `docs/architecture/query-backend-frontier.md` step 5.
 *
 * The writes `Commands` asks for, in SurrealQL. `Commands`, admission, stamps, the
 * envelope and decoding stay shared. A method this does not override refuses at
 * its first adapter read: this driver holds no SQL.
 */

import {
  ForbiddenError,
  NestedWriteError,
  QueryEngineError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
} from "@errors";
import { dividesByZero } from "@query-engine/raptor3/shared/decimal";
import {
  InsertValue,
  type JoinedPlan,
  JoinedValue,
  Stored,
} from "@query-engine/raptor3/shared/insert-value";
import {
  nestedRefusal,
  OperationContext,
  type StatementAnswer,
} from "@query-engine/raptor3/shared/operation-context";
import {
  type PreparedPredicate,
  type PreparedProjection,
  type PreparedSelector,
  type Queries,
  type Query,
  wholeValue,
} from "@query-engine/raptor3/shared/query";
import type { RowJudgement } from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import {
  linkJudgement,
  linkMembers,
  type Membership,
} from "@query-engine/raptor3/shared/storage";
import type { PreparedGuardFailure } from "@query-engine/types";
import { writeSinks } from "@query-engine/write-sinks";
import { getModelKeyCatalog } from "@schema/model/keys";
import { Sql, sql } from "@sql";
import { SurrealQueries } from "./queries";
import {
  isOneValue,
  quantized,
  SurrealReadBackend,
  walksFurther,
} from "./read-backend";
import { placed } from "./respace";
import { FORBIDDEN_ROW, isConflict } from "./transaction";

type AnyModel = PreparedProjection["model"];
type Junction = Extract<Membership, { kind: "junction" }>;

const ARITHMETIC: Readonly<Record<string, string>> = {
  increment: "+",
  decrement: "-",
  multiply: "*",
  divide: "/",
};

/**
 * A key a moved row can hold beside its old self: only what its field's type
 * admits, and nothing it could ever keep, since it is overwritten in that statement.
 */
const STAND_INS: Readonly<Record<string, Sql>> = {
  string: sql.raw("rand::string(32)"),
  int: sql.raw("rand::int(-2147483648, 2147483647)"),
  bigint: sql.raw("rand::int(-2147483648, 2147483647)"),
};

const JUDGED = sql.raw(`"${FORBIDDEN_ROW}"`);

/** How many times an operation plans again after meeting another at commit. */
const REPLANS = 16;

function refuse(what: string): never {
  throw new UnsupportedOperationError(
    `The SurrealDB write backend does not support ${what} yet.`
  );
}

function fieldName(identifier: string): Sql {
  return sql.raw(identifier);
}

export class SurrealOperationContext extends OperationContext {
  declare readonly queries: SurrealQueries;

  protected override createQueries(
    ...args: ConstructorParameters<typeof Queries>
  ): SurrealQueries {
    return new SurrealQueries(...args);
  }

  /**
   * No locks: two writers meet at commit, where the other databases meet at a
   * unique key. The loser plans again from what the winner committed. Each round
   * has a winner, so writers that keep meeting all finish within a bounded number.
   */
  override async run<T>(body: () => Promise<T>, single = false): Promise<T> {
    let replacement: ReturnType<OperationContext["spendRecovery"]>;
    for (let attempt = 1; ; attempt++) {
      try {
        return await super.run(body, single);
      } catch (error) {
        if (!(isConflict(error) && this.replaysInPlace) || attempt === REPLANS)
          throw error;
        replacement ??= this.spendRecovery();
        if (!replacement) throw error;
        this.restartRejectedInsert(replacement);
      }
      // Two losers planning together would only meet again.
      await new Promise((resolve) =>
        setTimeout(resolve, 5 + Math.random() * 45 * attempt)
      );
    }
  }

  #backend: SurrealReadBackend | undefined;

  get #lowering(): SurrealReadBackend {
    this.#backend ??= new SurrealReadBackend(this.queries);
    return this.#backend;
  }

  /**
   * Every write says so here. Preparing an array transaction queues statements,
   * and this writes through none: running here would write outside the transaction,
   * so it declines and the array runs each member inside it instead.
   */
  #writing(): void {
    if (this.preparesBatch) throw this.incompletePreparation;
  }

  /** Everything here runs at once, in a transaction: nothing waits in a batch. */
  protected override statePremise(): void {
    refuse("a premise stated for a batch");
  }

  protected override submit(): never {
    refuse("statements queued for a batch");
  }

  override packageGuard(): void {
    throw this.incompletePreparation;
  }

  protected override closeScratch(): void {
    // A scratch table is a batch's, and there is no batch here.
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
    const members = this.#rowMembers(model, row).map(
      ([column, value]) => sql`${fieldName(column)}: ${value}`
    );
    return sql`{ ${sql.join(members, ", ")} }`;
  }

  /** A row's columns and what each holds, its record first. */
  #rowMembers(model: AnyModel, row: Input): [string, Sql][] {
    this.#checked(model, row);
    const keys = this.queries.keyOrder(model);
    const members = Object.entries(row)
      .filter(
        ([field, value]) =>
          value !== null && value !== undefined && !keys.includes(field)
      )
      .map(([field, value]): [string, Sql] => [
        this.queries.columnName(model, field),
        this.#lowering.value(model, field, value),
      ]);
    return [["id", this.#recordKey(model, row, keys)], ...members];
  }

  /** Rows as a list: one parameter, where each value of each is one. */
  #rows(model: AnyModel, rows: readonly Input[]): Sql {
    const members = rows.map((row) => this.#rowMembers(model, row));
    const held = members.every((row) =>
      row.every(([, value]) => isOneValue(value))
    );
    if (!held)
      return sql`[${sql.join(
        rows.map((row) => this.#row(model, row)),
        ", "
      )}]`;
    return sql`${members.map((row) =>
      Object.fromEntries(
        row.map(([column, value]) => [column, value.values[0]])
      )
    )}`;
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
    return sql.join(
      this.#assigned(model, values).map(
        ({ column, value }) => sql`${column} = ${value}`
      ),
      ", "
    );
  }

  /** Each field an update writes, and what it writes there. */
  #assigned(model: AnyModel, values: Input): { column: Sql; value: Sql }[] {
    this.#checked(model, values);
    const keys = this.queries.keyOrder(model);
    return Object.entries(values).map(([field, given]) => {
      if (keys.includes(field)) refuse("changing a record's key");
      const column = this.#lowering.physical(model, field);
      const whole = wholeValue(given);
      if (whole) {
        return {
          column,
          value:
            whole.value === null
              ? sql.raw("NONE")
              : this.#lowering.value(model, field, whole.value),
        };
      }
      const [operator, operand] = Object.entries(given as Input)[0]!;
      const state = model["~"].state.scalars[field]?.["~"].state;
      if (operator === "push" || operator === "unshift") {
        const members = this.#lowering.value(model, field, [operand].flat());
        return {
          column,
          value:
            operator === "push"
              ? sql`array::concat(${column} ?? [], ${members})`
              : sql`array::concat(${members}, ${column} ?? [])`,
        };
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
      return {
        column,
        value: state?.nullable
          ? sql`(IF ${column} = NONE { NONE } ELSE { ${change} })`
          : change,
      };
    });
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

  /**
   * Refused where a junction holds one of `rows` back. A record's edges go with it,
   * before anything in the database could object, so this is the engine's: a raw
   * delete does not hold back.
   */
  #heldBack(model: AnyModel, rows: Sql): Sql | undefined {
    const refusals = this.schema.restrictingSlots(model).flatMap((slot) => {
      const edge = this.schema.membership(model, slot);
      if (edge.kind !== "junction" || edge.declared) return [];
      const { table, near } = this.#lowering.edgeOf(edge);
      return [
        sql`IF array::len(SELECT VALUE id FROM ${table} WHERE ${near} IN (SELECT VALUE id FROM ${rows}) LIMIT 1) > 0 { THROW ${`ON DELETE REJECT: ${edge.name}`} };`,
      ];
    });
    return refusals.length ? sql.join(refusals, " ") : undefined;
  }

  /** Refused unless every row in `rows`, read as a list, holds what judges it. */
  #judges(rows: string, judge: PreparedSelector | undefined): Sql {
    return judge?.predicate
      ? sql`IF array::len(SELECT VALUE 1 FROM ${sql.raw(rows)} WHERE ${this.#lowering.predicate(judge.predicate, true)}) != array::len(${sql.raw(rows)}) { THROW ${JUDGED} };`
      : sql.raw("");
  }

  /** A create, refused before it writes where a row it would make is not permitted. */
  #judgedInsert(
    insert: (rows: Sql) => Sql,
    rows: Sql,
    judge: PreparedSelector | undefined
  ): Sql {
    if (!judge?.predicate) return insert(rows);
    // The rows stand outside the block: an `IF` in a block beside a long literal takes
    // about the cube of its length (800 rows, 6 s; 1,600 never ends and holds the server).
    return sql`LET $rows = ${rows}; RETURN { ${this.#judges("$rows", judge)} ${insert(sql.raw("$rows"))} }`;
  }

  /**
   * What an update states ahead of itself: the rows of `source` as it would leave
   * them, each refused unless it holds what judges it. So the refusal comes before
   * a unique index or a reference could object, as a judged statement's does in SQL.
   * `undefined` where nothing judges them.
   */
  #judgedRows(
    model: AnyModel,
    source: Sql,
    values: Input,
    judgement: RowJudgement | undefined,
    candidatesJudged = true
  ): Sql | undefined {
    const domain = this.queries.domain;
    if (judgement === undefined || domain === undefined) return undefined;
    const judge = domain.produced(
      model,
      judgement,
      candidatesJudged ? Object.keys(values) : undefined
    );
    const cycles = domain.cycles(model, judgement);
    if (!judge?.predicate && cycles.length === 0) return undefined;
    const written = this.#assigned(model, values).map(
      ({ column, value }) => sql`${value} AS ${column}`
    );
    return sql`LET $next = (SELECT ${sql.join([sql.raw("*"), ...written], ", ")} FROM ${source}); ${this.#judges("$next", judge)} ${sql.join(
      cycles.map((relation) => this.#staysAcyclic(model, relation)),
      " "
    )}`;
  }

  /** Refused where a row in `$next` would hold itself among what its link walks to. */
  #staysAcyclic(model: AnyModel, relation: string): Sql {
    const edge = this.schema.membership(model, relation);
    if (edge.kind !== "reference" || edge.pairs.length !== 1)
      refuse("an acyclic rule over this relation");
    const link = this.#lowering.physical(model, edge.pairs[0]!.source);
    return sql`IF array::len(SELECT VALUE 1 FROM $next WHERE ${link} != NONE AND (${link} = id OR id IN ${link}.{..+collect}.${link})) > 0 { THROW ${JUDGED} };`;
  }

  /**
   * What a bulk write of `table` reads its rows from. A statement here evaluates its
   * `WHERE` row by row and sees what it has already written, where SQL reads a snapshot,
   * so a filter that reads other rows would change under it: those rows are found first.
   */
  #frozen(
    table: Sql,
    where: Sql,
    predicate: PreparedPredicate | undefined
  ): {
    readonly before: Sql;
    readonly source: Sql;
    readonly update: (set: Sql) => Sql;
  } {
    if (predicate && walksFurther(predicate))
      return {
        before: sql`LET $targets = (SELECT VALUE id FROM ${table} ${where});`,
        source: sql.raw("$targets"),
        update: (set) => sql`UPDATE $targets SET ${set}`,
      };
    return {
      before: sql.raw(""),
      source: sql`${table} ${where}`,
      update: (set) => sql`UPDATE ${table} SET ${set} ${where}`,
    };
  }

  /** What a write's block states ahead of it, where anything does. */
  #ahead(before: Sql, judged: Sql | undefined): Sql | undefined {
    if (!(before.toStatement() || judged)) return undefined;
    return sql`${before} ${judged ?? sql.raw("")}`;
  }

  /** Each value an extension computes, replaced by what it computes for these rows. */
  async #computed(model: AnyModel, rows: readonly Input[]): Promise<Input[]> {
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
          dialect: "postgresql",
          lastKey: (list, key) => this.#lastKey(model, list, key),
        },
        at
      );
      for (const [position, index] of at.entries())
        computed[index]![field] = values[position];
    }
    return computed ?? [...rows];
  }

  /** The largest key a list holds, among values that are digit strings. */
  async #lastKey(
    model: AnyModel,
    list: Input,
    key: string
  ): Promise<string | null> {
    const lowering = this.#lowering;
    const column = lowering.physical(model, key);
    const held = Object.entries(list).map(([field, value]) =>
      value === null
        ? sql`${lowering.physical(model, field)} = NONE`
        : sql`${lowering.physical(model, field)} = ${lowering.value(model, field, value)}`
    );
    const { rows } = await this.answer(
      {
        sql: sql`SELECT ${column} AS key, id FROM ${fieldName(model["~"].names.sql!)} WHERE ${sql.join([...held, sql`string::matches(${column}, ${"^[0-9]{2,}$"})`], " AND ")} ORDER BY key DESC LIMIT 1`,
        shape: { kind: "object", fields: {} },
      },
      false,
      model
    );
    return ((rows as Input[])[0]?.key as string | undefined) ?? null;
  }

  /** An update's values, what keeps its stored value left out of them. */
  async #settled(model: AnyModel, given: Input): Promise<Input> {
    const kept = Object.fromEntries(
      Object.entries(given).filter(([, value]) => !(value instanceof Stored))
    );
    return (await this.#computed(model, [kept]))[0]!;
  }

  /**
   * A value read from rows the update ranks: every row of each list is read, each
   * list placed, and the one statement writes a row only while it holds the key it
   * was ranked with.
   */
  async #respace(
    model: AnyModel,
    selector: PreparedSelector,
    plan: JoinedPlan,
    beside: Input,
    projection: PreparedProjection | undefined,
    single: (() => Error) | undefined
  ): Promise<unknown> {
    const q = this.queries;
    const lowering = this.#lowering;
    const table = fieldName(model["~"].names.sql!);
    const column = (field: string) => lowering.physical(model, field);
    const seen = q.scoped(
      model,
      plan.where === undefined
        ? undefined
        : q.prepareSelector(
            model,
            this.schema.admit(model, "findMany", { where: plan.where as Input })
              .where as Input
          ).predicate,
      "root"
    );
    const filter = seen
      ? sql`WHERE ${lowering.predicate(seen, true)}`
      : sql.raw("");
    const asRow = (fields: readonly string[], prefix: string) =>
      fields.map(
        (field, at) => sql`${column(field)} AS ${sql.raw(`${prefix}${at}`)}`
      );
    const movable = selector.predicate
      ? sql`(IF ${lowering.predicate(selector.predicate, true)} { true } ELSE { false })`
      : sql.raw("true");
    const read = async (statement: Sql) =>
      (
        await this.answer(
          { sql: statement, shape: { kind: "object", fields: {} } },
          false,
          model
        )
      ).rows as Input[];
    const lists =
      plan.within.length === 0
        ? (
            await read(
              sql`SELECT VALUE { id: id } FROM ${table} ${filter} LIMIT 1`
            )
          ).length > 0 || plan.where === undefined
          ? [{}]
          : []
        : await read(
            sql`SELECT ${sql.join(asRow(plan.within, "w"), ", ")} FROM ${table} ${filter} GROUP BY ${sql.join(
              plan.within.map((_, at) => sql.raw(`w${at}`)),
              ", "
            )}`
          );
    const writes: Sql[] = [];
    for (const list of lists) {
      const conditions = plan.within.map((field, at) => {
        const value = (list as Input)[`w${at}`];
        return value === null || value === undefined
          ? sql`${column(field)} = NONE`
          : sql`${column(field)} = ${lowering.value(model, field, value)}`;
      });
      const inList = conditions.length
        ? sql`WHERE ${sql.join(conditions, " AND ")}`
        : sql.raw("");
      const rows = await read(
        sql`SELECT ${sql.join(
          [
            sql`${column(plan.key)} AS k`,
            ...asRow(plan.identity, "i"),
            ...asRow(
              plan.order.map(([field]) => field),
              "o"
            ),
            sql`${movable} AS v`,
          ],
          ", "
        )} FROM ${table} ${inList}`
      );
      const keys = placed(
        rows.map((row) => ({
          key: row.k ?? null,
          identity: plan.identity
            .map((_, at) => String(row[`i${at}`]))
            .join("\u0000"),
          order: plan.order.map((_, at) => row[`o${at}`] ?? null),
          movable: row.v === true,
        })),
        plan.order.map(([, way]) => way)
      );
      for (const [index, row] of rows.entries()) {
        const next = keys[index];
        if (next === null || next === undefined) continue;
        const identity = Object.fromEntries(
          plan.identity.map((field, at) => [field, row[`i${at}`]])
        );
        const held =
          row.k === null || row.k === undefined
            ? sql`${column(plan.key)} = NONE`
            : sql`${column(plan.key)} = ${row.k}`;
        writes.push(
          sql`(UPDATE ${lowering.recordOfRow(model, identity)} SET ${sql.join(
            [
              sql`${column(plan.key)} = ${next}`,
              ...(Object.keys(beside).length
                ? [this.#assignments(model, beside)]
                : []),
            ],
            ", "
          )} WHERE ${sql.join([held, ...conditions], " AND ")} RETURN VALUE { id: id })`
        );
      }
    }
    if (writes.length === 0)
      return projection ? this.published([], single) : { count: 0 };
    const written = await this.answer(
      {
        sql: sql`RETURN array::flatten([${sql.join(writes, ", ")}])`,
        shape: { kind: "object", fields: {} },
      },
      false,
      model
    );
    if (projection) {
      const single_key =
        plan.identity.length === 1 ? plan.identity[0]! : undefined;
      const records = sql.join(
        (written.rows as Input[]).map((row) =>
          lowering.recordOfRow(
            model,
            single_key
              ? { [single_key]: row.id }
              : Object.fromEntries(
                  plan.identity.map((field, at) => [
                    field,
                    (row.id as unknown[])[at],
                  ])
                )
          )
        ),
        ", "
      );
      return await this.#finish(
        model,
        written.rows.length
          ? sql`SELECT ${lowering.columns(projection)} FROM [${records}]`
          : sql`RETURN []`,
        projection,
        single
      );
    }
    return { count: written.rows.length };
  }

  /** What a write's own statement reports where it refuses a row. */
  async #refusing<T>(
    model: AnyModel,
    refusal: PreparedGuardFailure | undefined,
    write: () => Promise<T>
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (!(error instanceof ForbiddenError)) throw error;
      throw this.refusal({ model, refusal: refusal ?? this.#forbidden });
    }
  }

  get #forbidden(): PreparedGuardFailure {
    return {
      kind: "forbidden",
      message: `${this.operation} produced a row that is not permitted.`,
      raceable: false,
    };
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
    single?: () => Error,
    refusal?: PreparedGuardFailure
  ): Promise<never> {
    this.#writing();
    if (given.length === 0) return { count: 0 } as never;
    const table = fieldName(model["~"].names.sql!);
    const computed = await this.#computed(model, given);
    const rows = this.#rows(model, computed);
    const verb = sql.raw(skipDuplicates ? "INSERT IGNORE" : "INSERT");
    const statement = this.#judgedInsert(
      (held) =>
        sql`${verb} INTO ${table} ${held} ${this.#returning(projection)}`,
      rows,
      this.queries.domain?.produced(model)
    );
    return (await this.#refusing(model, refusal, () =>
      this.#finish(model, statement, projection, single)
    )) as never;
  }

  override async updateMany(
    model: AnyModel,
    selector: PreparedSelector,
    asked: Input,
    limit?: number,
    projection?: PreparedProjection,
    single?: () => Error,
    captured?: readonly Input[]
  ): Promise<unknown> {
    this.#writing();
    if (captured) refuse("a tombstone");
    const joined = Object.values(asked).find(
      (value): value is JoinedValue => value instanceof JoinedValue
    );
    if (joined) {
      const beside = await this.#settled(
        model,
        Object.fromEntries(
          Object.entries(asked).filter(([, value]) => value !== joined)
        )
      );
      return await this.#respace(
        model,
        selector,
        joined.plan(),
        beside,
        projection,
        single
      );
    }
    const given = await this.#settled(model, asked);
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
    const table = fieldName(model["~"].names.sql!);
    const frozen =
      limit === undefined
        ? this.#frozen(table, this.#where(selector), selector.predicate)
        : undefined;
    const statement = (() => {
      const source = () => frozen?.source ?? this.#target(selector, limit);
      const write = () =>
        sql`${frozen ? frozen.update(assignments) : sql`UPDATE ${source()} SET ${assignments}`} ${this.#returning(projection)}`;
      const judged = this.#judgedRows(
        model,
        source(),
        given,
        selector.judgement
      );
      const before = frozen?.before.toStatement() ? frozen.before : undefined;
      return judged || before
        ? sql`RETURN { ${before ?? sql.raw("")} ${judged ?? sql.raw("")} ${write()} }`
        : this.#lowering.hoisted(write);
    })();
    return await this.#refusing(model, undefined, () =>
      this.#finish(model, statement, projection, single)
    );
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
    const table = fieldName(model["~"].names.sql!);
    const located =
      limit === undefined
        ? sql`LET $rows = (SELECT VALUE id FROM ${table} ${this.#where(selector)});`
        : sql`LET $rows = ${this.#target(selector, limit)};`;
    const heldBack = this.#heldBack(model, sql.raw("$rows"));
    if (!projection) {
      const { rows } = await this.answer(
        {
          sql:
            heldBack ||
            (limit === undefined &&
              selector.predicate &&
              walksFurther(selector.predicate))
              ? sql`RETURN { ${located} ${heldBack ?? sql.raw("")} DELETE $rows RETURN BEFORE }`
              : this.#lowering.hoisted(
                  () =>
                    sql`DELETE ${this.#target(selector, limit)} RETURN BEFORE`
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
    const { rows } = await this.answer(
      {
        sql: sql`RETURN { ${located} ${heldBack ?? sql.raw("")} LET $answer = (SELECT ${this.#lowering.columns(projection)} FROM $rows); DELETE $rows; RETURN $answer; }`,
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

  /**
   * Which key an ignored insert met, since it answers nothing: the first the row
   * states whose values a record holds. A recovery reads it to tell its own key.
   */
  async #heldBy(model: AnyModel, row: Input) {
    const table = model["~"].names.sql!;
    for (const key of getModelKeyCatalog(model).referenceableKeys) {
      if (key.some((field) => row[field] === undefined)) continue;
      const matches = sql.join(
        key.map(
          (field) =>
            sql`${this.#lowering.physical(model, field)} = ${this.#lowering.value(model, field, row[field])}`
        ),
        " AND "
      );
      const held = await this.read(
        {
          sql: sql`SELECT id FROM ${fieldName(table)} WHERE ${matches} LIMIT 1`,
          shape: { kind: "object", fields: {} },
        },
        true
      );
      if (held.length > 0)
        return {
          table,
          columns: key.map((field) => this.queries.columnName(model, field)),
        };
    }
    return { table };
  }

  /** One record's write, inside the transaction `Commands` opened. */
  override async insert(
    model: AnyModel,
    asked: Input,
    demanded: ReadonlySet<string>,
    _member: unknown,
    _operation = "create",
    producer?: object,
    _membership?: unknown,
    refusal?: PreparedGuardFailure,
    answer?: StatementAnswer
  ): Promise<Input> {
    this.#writing();
    const table = fieldName(model["~"].names.sql!);
    const given = (await this.#computed(model, [asked]))[0]!;
    const produced = [...demanded].filter(
      (field) => given[field] === undefined
    );
    // A failing statement costs its transaction a replay. An insert that may be
    // answered another way ignores its conflict, and says so, for nothing.
    const verb = sql.raw(producer ? "INSERT IGNORE" : "INSERT");
    const row = this.#row(model, given);
    const judge = this.queries.domain?.produced(model);
    if (judge?.predicate)
      await this.#refusing(model, refusal, () =>
        this.read(
          {
            sql: sql`RETURN { LET $rows = [${row}]; ${this.#judges("$rows", judge)} [] }`,
            shape: { kind: "object", fields: {} },
          },
          true
        )
      );
    const { response, decoded } = await this.#written(
      model,
      sql`${verb} INTO ${table} [${row}]`,
      produced,
      answer
    );
    if (producer && !response.rows[0]) {
      const error = new UniqueConstraintError(
        `A record of '${model["~"].names.ts}' already holds these values.`,
        { meta: await this.#heldBy(model, given) }
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
    asked: Input,
    _member: unknown,
    _operation = "update",
    demanded: ReadonlySet<string> = new Set(),
    missing?: () => Error,
    judgement?: RowJudgement,
    refusal?: PreparedGuardFailure,
    answer?: StatementAnswer
  ): Promise<Input> {
    this.#writing();
    const given = await this.#settled(model, asked);
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
    const { response, decoded } = await this.#refusing(model, refusal, () =>
      this.#written(
        model,
        sql`UPDATE ${table} ${assignments}WHERE ${identity}`,
        fields,
        answer,
        this.#judgedRows(
          model,
          sql`${table} WHERE ${identity}`,
          rest,
          judgement,
          false
        )
      )
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
    const heldBack = this.#heldBack(model, sql`${table} WHERE ${identity}`);
    const removal = sql`DELETE ${table} WHERE ${identity} RETURN BEFORE`;
    await this.answer(
      {
        sql: heldBack ? sql`RETURN { ${heldBack} ${removal} }` : removal,
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
      if (whole.value instanceof Sql)
        refuse("moving a record's key through a relation");
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
            // Nothing in the database holds an edge's key back, so the engine does.
            const held = edge.targetSide.onUpdate ?? "cascade";
            if (held === "restrict" || held === "noAction") {
              refusals.push(
                sql`IF array::len(SELECT VALUE id FROM ${table} WHERE ${far} = $old LIMIT 1) > 0 { THROW ${`ON UPDATE REJECT: ${edge.name}`} };`
              );
              continue;
            }
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
    answer: StatementAnswer | undefined,
    judged?: Sql,
    /** What it reads held outside its block, for the reason `#judgedInsert` says. */
    held?: Sql
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
    const columns = returned.length ? sql.join(returned, ", ") : sql.raw("id");
    const response = await this.answer(
      {
        sql: sql.join(
          [
            ...(held ? [held] : []),
            judged
              ? sql`RETURN { ${judged} ${statement} RETURN ${columns} }`
              : sql`${statement} RETURN ${columns}`,
          ],
          " "
        ),
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
    asked: Input,
    projection: PreparedProjection,
    missing: () => Error,
    _operation = "update",
    refusal?: PreparedGuardFailure,
    answer?: StatementAnswer
  ): Promise<Input> {
    this.#writing();
    const given = await this.#settled(model, asked);
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
    const frozen = this.#frozen(
      table,
      this.#where(selector),
      selector.predicate
    );
    const { response, decoded } = await this.#refusing(model, refusal, () =>
      this.#written(
        model,
        frozen.update(this.#assignments(model, given)),
        fields,
        answer,
        this.#ahead(
          frozen.before,
          this.#judgedRows(model, frozen.source, given, selector.judgement)
        )
      )
    );
    if (!response.rows[0]) throw missing();
    return decoded;
  }

  override async updateRows(
    model: AnyModel,
    identities: readonly Input[],
    asked: Input,
    _member: unknown,
    _operation: string,
    judgement: RowJudgement | undefined,
    refusal: PreparedGuardFailure | undefined
  ): Promise<void> {
    this.#writing();
    const values = await this.#settled(model, asked);
    if (Object.keys(values).length === 0) return;
    // A list of records reads each by key, where an `OR` of the same scans.
    const records = sql.join(
      identities.map((identity) => this.#lowering.recordOfRow(model, identity)),
      ", "
    );
    await this.#refusing(model, refusal, () =>
      this.#written(
        model,
        sql`UPDATE $records SET ${this.#assignments(model, values)}`,
        [],
        undefined,
        this.#judgedRows(model, sql.raw("$records"), values, judgement),
        sql`LET $records = [${records}];`
      )
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
    const frozen = this.#frozen(table, sql`WHERE ${where}`, selector.predicate);
    if (values)
      return await this.#refusing(
        model,
        nestedRefusal("updateMany", edge.name),
        () =>
          this.#reportedUpdate(
            model,
            frozen.update(this.#assignments(model, values)),
            this.#ahead(
              frozen.before,
              this.#judgedRows(model, frozen.source, values, selector.judgement)
            )
          )
      );
    await this.#reportDelete(model, where);
    await this.#written(
      model,
      sql`DELETE ${frozen.source}`,
      [],
      undefined,
      this.#ahead(frozen.before, this.#heldBack(model, frozen.source))
    );
  }

  /** An update whose rows a hook may want: the statement answers with them. */
  async #reportedUpdate(
    model: AnyModel,
    statement: Sql,
    judged?: Sql
  ): Promise<void> {
    const name = model["~"].names.ts!;
    const sink = writeSinks.get(this.attribution);
    if (!sink?.wants(name, "update")) {
      await this.#written(model, statement, [], undefined, judged);
      return;
    }
    const { shape, fields } = this.queries.prepareProjection(model, {});
    const columns = fields.map((field) => this.#lowering.column(model, field));
    const rows = await this.read(
      {
        sql: judged
          ? sql`RETURN { ${judged} ${statement} RETURN ${sql.join(columns, ", ")} }`
          : sql`${statement} RETURN ${sql.join(columns, ", ")}`,
        shape,
      },
      false,
      false,
      model
    );
    sink.wrote(name, "update", rows);
  }

  /** Rows as they were before a delete, read ahead of it in this transaction. */
  async #reportDelete(model: AnyModel, where: Sql): Promise<void> {
    const name = model["~"].names.ts!;
    const sink = writeSinks.get(this.attribution);
    if (!sink?.wants(name, "delete")) return;
    const { shape, fields } = this.queries.prepareProjection(model, {});
    const columns = fields.map((field) => this.#lowering.column(model, field));
    const rows = await this.read(
      {
        sql: sql`SELECT ${sql.join(columns, ", ")} FROM ${fieldName(model["~"].names.sql!)} WHERE ${where}`,
        shape,
      },
      false,
      false,
      model
    );
    sink.wrote(name, "delete", rows);
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
    keep: readonly Input[],
    writable: Sql | undefined
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
      ...(writable
        ? [sql`${low.linkTarget(edge, edge.targetSide, "")} IN $writable`]
        : []),
    ];
    await this.#written(
      model,
      sql`DELETE ${fieldName(model["~"].names.sql!)} WHERE ${sql.join(conditions, " AND ")}`,
      [],
      undefined,
      undefined,
      writable && sql`LET $writable = ${writable};`
    );
  }

  /** Removes an edge and leaves both records. `keep` is only a declared junction's. */
  #unlink(
    edge: Junction,
    read: (
      side: Junction["sourceSide"],
      pair: Junction["sourceSide"]["members"][number]
    ) => unknown,
    writable?: Sql
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
    const among = writable ? [sql`${far} IN $writable`] : [];
    const wheres = [
      ...(hasTarget ? [sql`${far} = ${end(edge.targetSide)}`] : []),
      ...among,
    ];
    const where = wheres.length
      ? sql` WHERE ${sql.join(wheres, " AND ")}`
      : sql.raw("");
    const statement = hasSource
      ? sql`DELETE ${end(edge.sourceSide)}${out}${where}`
      : sql`DELETE ${table}${where}`;
    return this.#written(
      edge.source,
      statement,
      [],
      undefined,
      undefined,
      writable && sql`LET $writable = ${writable};`
    );
  }

  /** Clears a relation's link: every member, one, or all but those kept. */
  /** A clear refuses a member the call sees and may not unlink, as naming it does. */
  async #refuseUnwritableClear(
    edge: Membership,
    source: Input | undefined,
    target: Input | undefined,
    keep: Input[]
  ): Promise<void> {
    const q = this.queries;
    const model = edge.target;
    const writable = q.domainOf(model, "related", linkJudgement(edge));
    const visible = q.domainOf(model, "related");
    if (target !== undefined || writable === visible) return;
    const keys = this.schema.keys(model);
    const held = await this.read(
      q.select(
        model,
        { select: Object.fromEntries(keys.map((field) => [field, true])) },
        { edge, parent: source! },
        { selector: visible, unless: writable }
      ),
      true
    );
    const kept = (row: Input) =>
      keep.some((other) =>
        keys.every((field) => String(other[field]) === String(row[field]))
      );
    if (held.some((row) => !kept(row)))
      throw new NestedWriteError(
        `Cannot clear relation '${edge.name}': a connected record may not be disconnected.`,
        edge.name
      );
  }

  override async remove(
    edge: Membership,
    source: Input | undefined,
    target: Input | undefined,
    keep: Input[]
  ): Promise<void> {
    this.#writing();
    await this.#refuseUnwritableClear(edge, source, target, keep);
    const model = edge.target;
    // A removal takes related rows whose link the call may write, as its lookups
    // do: a row the call does not see keeps its link.
    const allowed = this.queries.domainOf(
      model,
      "related",
      linkJudgement(edge)
    )?.predicate;
    const writable = allowed
      ? sql`(SELECT VALUE id FROM ${fieldName(model["~"].names.sql!)} WHERE ${this.#lowering.predicate(allowed, true)})`
      : undefined;
    if (edge.kind === "junction" && edge.declared) {
      await this.#unlinkDeclared(edge, source, target, keep, writable);
      return;
    }
    if (edge.kind === "junction") {
      await this.#unlink(
        edge,
        (side, pair) => {
          const row = side === edge.sourceSide ? source : target;
          return row?.[pair.referencedField];
        },
        writable
      );
      return;
    }
    const clearability = edge.clearability;
    if (clearability.kind !== "columns") refuse("clearing this relation");
    const table = fieldName(model["~"].names.sql!);
    const cleared = Object.fromEntries(
      clearability.fields.map((field) => [field, null])
    );
    const identity = (row: Input) =>
      this.#lowering.identity(model, this.schema.identity(model, row));
    const judgement = linkJudgement(edge);
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
    if (allowed) conditions.push(this.#lowering.predicate(allowed, true));
    const unlinked = sql.join(conditions, " AND ");
    const frozen = this.#frozen(table, sql`WHERE ${unlinked}`, allowed);
    await this.#refusing(model, nestedRefusal("disconnect", edge.name), () =>
      this.#reportedUpdate(
        model,
        frozen.update(this.#assignments(model, cleared)),
        this.#ahead(
          frozen.before,
          this.#judgedRows(model, frozen.source, cleared, judgement)
        )
      )
    );
  }

  override async upsertOne(
    model: AnyModel,
    asked: Input,
    askedUpdates: Input,
    target: readonly string[],
    projection?: PreparedProjection,
    single?: () => Error,
    upserted?: (created: boolean) => void,
    existing?: Query
  ): Promise<unknown> {
    this.#writing();
    const given = (await this.#computed(model, [asked]))[0]!;
    const updates = await this.#settled(model, askedUpdates);
    // No statement here says which arm it took, so its key is read first.
    if (upserted && existing)
      upserted((await this.read(existing, true)).length === 0);
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
