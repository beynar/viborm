/**
 * `docs/architecture/query-backend-frontier.md` step 5.
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
import { Decimal } from "surrealdb";
import { SurrealQueries } from "./queries";
import {
  isOneValue,
  onceEach,
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
  float: sql.raw("rand::float()"),
  decimal: sql.raw("<decimal>rand::int(-2147483648, 2147483647)"),
  datetime: sql.raw("time::from_millis(rand::int(0, 2147483647))"),
};

const JUDGED = sql.raw(`"${FORBIDDEN_ROW}"`);

/** How many times an operation plans again after meeting another at commit. */
const REPLANS = 16;

/** A relation whose row holds a value of another in its own key. */
type FollowingEdge = Extract<Membership, { kind: "reference" }>;

/** What a write holds at the top level ahead of itself, and what refuses with it. */
interface Ahead {
  readonly lets: Sql;
  readonly checks: Sql;
}

const NOTHING_AHEAD: Ahead = { lets: sql.raw(""), checks: sql.raw("") };

/** A key part's value after arithmetic, computed here since a record's id is fixed. */
function arithmetic(
  type: string,
  current: unknown,
  operator: string,
  operand: unknown
): unknown {
  if (type === "decimal") {
    const [a, b] = [new Decimal(String(current)), new Decimal(String(operand))];
    if (operator === "divide" && dividesByZero(operand))
      throw new QueryEngineError("Cannot divide a key by zero.");
    return (
      operator === "increment"
        ? a.add(b)
        : operator === "decrement"
          ? a.sub(b)
          : operator === "multiply"
            ? a.mul(b)
            : a.div(b)
    ).toString();
  }
  if (type === "bigint") {
    const [a, b] = [BigInt(String(current)), BigInt(String(operand))];
    if (operator === "divide" && b === 0n)
      throw new QueryEngineError("Cannot divide a key by zero.");
    return operator === "increment"
      ? a + b
      : operator === "decrement"
        ? a - b
        : operator === "multiply"
          ? a * b
          : a / b;
  }
  if (type !== "int") refuse(`arithmetic on a key of type '${type}'`);
  const [a, b] = [Number(current), Number(operand)];
  if (operator === "divide" && b === 0)
    throw new QueryEngineError("Cannot divide a key by zero.");
  return operator === "increment"
    ? a + b
    : operator === "decrement"
      ? a - b
      : operator === "multiply"
        ? a * b
        : Math.trunc(a / b);
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
    // Written here, not left to its default: a transaction reserves what it states.
    const generated = Object.entries(model["~"].state.scalars)
      .filter(
        ([field, scalar]) =>
          (scalar as { "~": { state: { autoGenerate?: { kind: string } } } })[
            "~"
          ].state.autoGenerate?.kind === "increment" &&
          !keys.includes(field) &&
          row[field] === undefined
      )
      .map(([field]): [string, Sql] => {
        const column = this.queries.columnName(model, field);
        return [
          column,
          sql`sequence::nextval(${`${model["~"].names.sql!}_${column}_seq`})`,
        ];
      });
    return [
      ["id", this.#recordKey(model, row, keys)],
      ...members,
      ...generated,
    ];
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
      if (
        keys.every(
          (key) => row[key] !== undefined && !(row[key] instanceof Sql)
        )
      )
        return sql`${this.#lowering.recordOf(model, row)}`;
      const parts = keys.map((key) => {
        if (row[key] instanceof Sql) return row[key];
        if (row[key] !== undefined)
          return this.#lowering.keyPart(model, key, row[key]);
        const state = model["~"].state.scalars[key]?.["~"].state;
        if (state?.autoGenerate?.kind !== "increment")
          refuse("a key the database generates");
        const column = this.queries.columnName(model, key);
        return sql`sequence::nextval(${`${model["~"].names.sql!}_${column}_seq`})`;
      });
      return sql`[${sql.join(parts, ", ")}]`;
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
    const { predicate, model } = selector;
    if (!predicate) return sql.raw("");
    const conditions = onceEach(this.#lowering.located(model, predicate));
    return conditions.length
      ? sql`WHERE ${sql.join(conditions, " AND ")}`
      : sql.raw("");
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
  #judges(rows: string, judge: PreparedSelector | undefined): Ahead {
    if (!judge?.predicate) return NOTHING_AHEAD;
    const holds = this.#lowering.judging(() =>
      this.#lowering.predicate(judge.predicate!, true)
    );
    return {
      lets: sql`LET $judged = (SELECT VALUE 1 FROM ${sql.raw(rows)} WHERE ${holds});`,
      checks: sql`IF array::len($judged) != array::len(${sql.raw(rows)}) { THROW ${JUDGED} };`,
    };
  }

  /** A create, refused before it writes where a row it would make is not permitted. */
  #judgedInsert(
    insert: (rows: Sql) => Sql,
    rows: Sql,
    judge: PreparedSelector | undefined
  ): Sql {
    if (!judge?.predicate) return insert(rows);
    const { lets, checks } = this.#judges("$rows", judge);
    // The rows stand outside the block: an `IF` in a block beside a long literal takes
    // about the cube of its length (800 rows, 6 s; 1,600 never ends and holds the server).
    return sql`LET $rows = ${rows}; ${lets} RETURN { ${checks} ${insert(sql.raw("$rows"))} }`;
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
  ): Ahead {
    const domain = this.queries.domain;
    if (judgement === undefined || domain === undefined) return NOTHING_AHEAD;
    const judge = domain.produced(
      model,
      judgement,
      candidatesJudged ? Object.keys(values) : undefined
    );
    const cycles = domain.cycles(model, judgement);
    if (!judge?.predicate && cycles.length === 0) return NOTHING_AHEAD;
    const written = this.#assigned(model, values).map(
      ({ column, value }) => sql`${value} AS ${column}`
    );
    const { lets, checks } = this.#judges("$next", judge);
    return {
      lets: sql`LET $next = (SELECT ${sql.join([sql.raw("*"), ...written], ", ")} FROM ${source}); ${lets}`,
      checks: sql`${checks} ${sql.join(
        cycles.map((relation) => this.#staysAcyclic(model, relation)),
        " "
      )}`,
    };
  }

  /**
   * A write with what it holds ahead of it. What is held stands at the top level, and
   * the block holds only what must refuse together with the write, as one transaction.
   */
  #stated(ahead: Ahead, write: Sql): Sql {
    if (ahead === NOTHING_AHEAD) return write;
    return sql`${ahead.lets} RETURN { ${ahead.checks} ${write} }`;
  }

  /** Refused where a row in `$next` would hold itself among what its link walks to. */
  #staysAcyclic(model: AnyModel, relation: string): Sql {
    const edge = this.schema.membership(model, relation);
    if (edge.kind === "reference" && this.#lowering.isLinked(edge)) {
      const link = this.#lowering.physical(model, edge.pairs[0]!.source);
      return sql`IF array::len(SELECT VALUE 1 FROM $next WHERE ${link} != NONE AND (${link} = id OR id IN ${link}.{..+collect}.${link})) > 0 { THROW ${JUDGED} };`;
    }
    return sql`IF array::len(array::filter($next, |$candidate| $candidate.id IN ${this.#lowering.walkFrom(edge, sql.raw("$candidate"))}.edges.c)) > 0 { THROW ${JUDGED} };`;
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
  #ahead(before: Sql, judged: Ahead): Ahead {
    if (!before.toStatement()) return judged;
    return { lets: sql`${before} ${judged.lets}`, checks: judged.checks };
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
    const statement = this.#lowering.hoisted(() =>
      this.#judgedInsert(
        (held) =>
          sql`${verb} INTO ${table} ${held} ${this.#returning(projection)}`,
        rows,
        this.queries.domain?.produced(model)
      )
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
    single?: () => Error
  ): Promise<unknown> {
    this.#writing();
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
    const statement = this.#lowering.hoisted(() => {
      const frozen =
        limit === undefined
          ? this.#frozen(table, this.#where(selector), selector.predicate)
          : undefined;
      const source = () => frozen?.source ?? this.#target(selector, limit);
      return this.#stated(
        this.#ahead(
          frozen?.before ?? sql.raw(""),
          this.#judgedRows(model, source(), given, selector.judgement)
        ),
        sql`${frozen ? frozen.update(assignments) : sql`UPDATE ${source()} SET ${assignments}`} ${this.#returning(projection)}`
      );
    });
    return await this.#withFollowers(
      model,
      given,
      this.#target(selector, limit),
      () =>
        this.#refusing(model, undefined, () =>
          this.#finish(model, statement, projection, single)
        )
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
    const located = () =>
      limit === undefined
        ? sql`LET $rows = (SELECT VALUE id FROM ${table} ${this.#where(selector)});`
        : sql`LET $rows = ${this.#target(selector, limit)};`;
    const heldBack = this.#heldBack(model, sql.raw("$rows"));
    if (!projection) {
      const { rows } = await this.answer(
        {
          sql: this.#lowering.hoisted(() =>
            heldBack ||
            (limit === undefined &&
              selector.predicate &&
              walksFurther(selector.predicate))
              ? sql`${located()} RETURN { ${heldBack ?? sql.raw("")} DELETE $rows RETURN BEFORE }`
              : sql`DELETE ${this.#target(selector, limit)} RETURN BEFORE`
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
        sql: this.#lowering.hoisted(
          () =>
            sql`${located()} LET $answer = (SELECT ${this.#lowering.columns(projection)} FROM $rows); RETURN { ${heldBack ?? sql.raw("")} DELETE $rows; RETURN $answer; }`
        ),
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
            sql: this.#lowering.hoisted(() =>
              this.#judgedInsert(() => sql.raw("[]"), sql`[${row}]`, judge)
            ),
            shape: { kind: "object", fields: {} },
          },
          true
        )
      );
    const { response, decoded } = await this.#written(
      model,
      () => ({ write: sql`${verb} INTO ${table} [${row}]` }),
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
    const { response, decoded } = await this.#withFollowers(
      model,
      rest,
      this.#lowering.recordOfRow(model, row),
      () =>
        this.#refusing(model, refusal, () =>
          this.#written(
            model,
            () => ({
              write: sql`UPDATE ${table} ${assignments}WHERE ${identity}`,
              ahead: this.#judgedRows(
                model,
                sql`${table} WHERE ${identity}`,
                rest,
                judgement,
                false
              ),
            }),
            fields,
            answer
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
          `changing the key of '${model["~"].names.ts}', whose unique ${fields.join(", ")} has no value to stand in`
        );
      standIns.set(absent, undefined);
    }
    return standIns;
  }

  /** It runs as one statement, a transaction of its own. */
  async #moveRecord(
    model: AnyModel,
    identity: Input,
    given: Input
  ): Promise<Input> {
    const next = { ...identity };
    for (const key of this.#keyChange(model, given))
      next[key] = await this.#movedKey(model, key, identity[key], given[key]);
    const moves = { count: 0 };
    const statement = await this.#movement(model, identity, next, moves);
    await this.answer(
      {
        sql: sql`RETURN { ${statement} RETURN []; }`,
        shape: { kind: "object", fields: {} },
      },
      false,
      model
    );
    return next;
  }

  /** A row's stored fields, as a key moving reads those it does not state. */
  async #storedRow(model: AnyModel, identity: Input): Promise<Input> {
    const low = this.#lowering;
    const fields = this.schema.storedFields(model);
    const { rows } = await this.answer(
      {
        sql: sql`SELECT ${sql.join(
          fields.map(
            (field) => sql`${low.physical(model, field)} AS ${fieldName(field)}`
          ),
          ", "
        )} FROM ${low.recordOfRow(model, identity)}`,
        shape: { kind: "object", fields: {} },
      },
      false,
      model
    );
    return (rows as Input[])[0] ?? {};
  }

  /**
   * Who holds a non-key field of `model` in their own key, cascading: nothing in the
   * database can move a record, so an update of the field moves them here.
   */
  #keyFollowers(model: AnyModel, given: Input): readonly FollowingEdge[] {
    const q = this.queries;
    const keys = q.keyOrder(model);
    const found: FollowingEdge[] = [];
    for (const source of Object.values(this.schema.schema) as AnyModel[])
      for (const slot of Object.keys(source["~"].state.relations)) {
        const { edges } = q.countedMemberships(source, slot);
        for (const edge of edges)
          if (
            edge.kind === "reference" &&
            edge.target === model &&
            edge.owner === "source" &&
            !edge.discriminator &&
            edge.reference?.onUpdate === "cascade" &&
            edge.pairs.some(
              ({ source: part, target }) =>
                !keys.includes(target) &&
                Object.hasOwn(given, target) &&
                q.keyOrder(source).includes(part)
            )
          )
            found.push(edge);
      }
    return found;
  }

  /** `write`, and the records holding what it changed in their own keys, moved after it. */
  async #withFollowers<T>(
    model: AnyModel,
    given: Input,
    rows: Sql,
    write: () => Promise<T>
  ): Promise<T> {
    const followers = this.#keyFollowers(model, given);
    if (followers.length === 0) return await write();
    const low = this.#lowering;
    const q = this.queries;
    const keys = q.keyOrder(model);
    const read = async (from: Sql) => {
      const { rows: found } = await this.answer(
        {
          sql: sql`SELECT ${sql.join(
            this.schema
              .storedFields(model)
              .map(
                (field) =>
                  sql`${low.physical(model, field)} AS ${fieldName(field)}`
              ),
            ", "
          )} FROM ${from}`,
          shape: { kind: "object", fields: {} },
        },
        false,
        model
      );
      return found as Input[];
    };
    const before = await read(rows);
    const result = await write();
    for (const was of before) {
      const [now] = await read(
        low.recordOfRow(model, this.schema.identity(model, was))
      );
      if (!now) continue;
      for (const edge of followers) {
        const source = edge.source;
        const located = await this.answer(
          {
            sql: sql`SELECT ${sql.join(
              q
                .keyOrder(source)
                .map(
                  (key) =>
                    sql`${low.physical(source, key)} AS ${fieldName(key)}`
                ),
              ", "
            )} FROM ${fieldName(source["~"].names.sql!)} WHERE ${sql.join(
              edge.pairs.map(
                ({ source: part, target }) =>
                  sql`${low.physical(source, part)} = ${low.value(source, part, was[target])}`
              ),
              " AND "
            )}`,
            shape: { kind: "object", fields: {} },
          },
          false,
          model
        );
        for (const row of located.rows as Input[])
          await this.#moveRecord(
            source,
            row,
            Object.fromEntries(
              edge.pairs
                .filter(
                  ({ source: part, target }) =>
                    !keys.includes(target) && q.keyOrder(source).includes(part)
                )
                .map(({ source: part, target }) => [part, now[target]])
            )
          );
      }
    }
    return result;
  }

  /** What a write leaves a key part at: what it states, reads, or computes from it. */
  async #movedKey(
    model: AnyModel,
    key: string,
    current: unknown,
    given: unknown
  ): Promise<unknown> {
    const whole = wholeValue(given);
    if (whole && !(whole.value instanceof Sql)) return whole.value;
    if (whole) {
      const { rows } = await this.answer(
        {
          sql: sql`RETURN [{ value: ${whole.value as Sql} }]`,
          shape: { kind: "object", fields: {} },
        },
        false,
        model
      );
      return (rows as Input[])[0]?.value;
    }
    const [operator, operand] = Object.entries(given as Input)[0]!;
    const { type } = model["~"].state.scalars[key]!["~"].state;
    if (!ARITHMETIC[operator]) refuse(`the '${operator}' update`);
    return arithmetic(type as string, current, operator, operand);
  }

  /**
   * A record's id cannot change, so a new key is a new record: the row is copied
   * under it, what points at it does what its action says, and the old one goes.
   * A record holding the key in its own key moves with it, inside the same block.
   */
  async #movement(
    model: AnyModel,
    identity: Input,
    next: Input,
    moves: { count: number }
  ): Promise<Sql> {
    const q = this.queries;
    const low = this.#lowering;
    const at = moves.count++;
    const named = (variable: string) => sql.raw(`$${variable}${at}`);
    const old = named("old");
    const moved = named("new");
    const held = named("row");
    const other = named("other");
    const others = named("others");
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
        return sql`${column}: ${standIns.get(field) ?? sql`${held}.${column}`}`;
      });
    const restored = [...standIns.keys()].map((field) => {
      const column = fieldName(q.columnName(model, field));
      return sql`${column} = ${held}.${column}`;
    });
    const refusals: Sql[] = [];
    const follow: Sql[] = [];
    let quiet = false;
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
            const action = edge.targetSide.onUpdate ?? "cascade";
            if (action === "restrict" || action === "noAction") {
              refusals.push(
                sql`IF array::len(SELECT VALUE id FROM ${table} WHERE ${far} = ${old} LIMIT 1) > 0 { THROW ${`ON UPDATE REJECT: ${edge.name}`} };`
              );
              continue;
            }
            const linked = sql`(SELECT VALUE ${near} FROM ${table} WHERE ${far} = ${old})`;
            // An edge's ends are fixed: it is related again from the new record. A
            // singular one holds its index until it is gone.
            follow.push(
              edge.uniqueSide
                ? sql`LET ${others} = ${linked}; DELETE ${table} WHERE ${far} = ${old}; FOR ${other} IN ${others} { INSERT RELATION INTO ${table} [{ ${near}: ${other}, ${far}: ${moved} }] };`
                : near.toStatement() === "in"
                  ? sql`FOR ${other} IN ${linked} { RELATE ${other}->${table}->${moved} };`
                  : sql`FOR ${other} IN ${linked} { RELATE ${moved}->${table}->${other} };`
            );
            continue;
          }
          if (edge.owner !== "source" || edge.discriminator) continue;
          // An event answers for it: a move's old copy says so, and it stays quiet.
          if (
            edge.pairs.length > 1 ||
            !low.holdsRecord(source, edge.pairs[0]!.source)
          )
            quiet = true;
          // Not by the key: the value stays with the row, and so do those holding it.
          if (!edge.pairs.some(({ target }) => keys.includes(target))) continue;
          const stored = edge.pairs.every(({ target }) => keys.includes(target))
            ? identity
            : { ...(await this.#storedRow(model, identity)), ...identity };
          const holders = edge.pairs.map(({ source: part, target }) => ({
            part,
            column: low.physical(source, part),
            now: keys.includes(target) ? next[target] : stored[target],
            value: low.value(
              source,
              part,
              keys.includes(target) ? next[target] : stored[target]
            ),
            was: low.value(source, part, stored[target]),
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
          ) {
            if (action === "setNull")
              refuse("setNull on a key that holds another");
            const located = await this.answer(
              {
                sql: sql`SELECT ${sql.join(
                  q
                    .keyOrder(source)
                    .map(
                      (key) =>
                        sql`${low.physical(source, key)} AS ${fieldName(key)}`
                    ),
                  ", "
                )} FROM ${table} WHERE ${holding}`,
                shape: { kind: "object", fields: {} },
              },
              false,
              model
            );
            for (const row of located.rows as Input[])
              follow.push(
                await this.#movement(
                  source,
                  row,
                  {
                    ...row,
                    ...Object.fromEntries(
                      holders.map(({ part, now }) => [part, now])
                    ),
                  },
                  moves
                )
              );
            continue;
          }
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
    return sql`LET ${old} = ${low.recordOfRow(model, identity)}; LET ${moved} = ${low.recordOfRow(model, next)}; IF ${moved} = ${old} { RETURN []; }; ${sql.join(refusals, " ")} LET ${held} = (SELECT * FROM ONLY ${old}); IF ${held} = NONE { RETURN []; }; ${quiet ? sql`UPDATE ${old} SET viborm_moved = true;` : sql.raw("")} INSERT INTO ${fieldName(model["~"].names.sql!)} [{ ${sql.join([sql`id: ${moved}`, ...copied], ", ")} }] RETURN NONE; ${sql.join(follow, " ")} DELETE ${old}; ${restored.length ? sql`UPDATE ${moved} SET ${sql.join(restored, ", ")};` : sql.raw("")}`;
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
    build: () => { readonly write: Sql; readonly ahead?: Ahead },
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
    const columns = returned.length ? sql.join(returned, ", ") : sql.raw("id");
    const response = await this.answer(
      {
        sql: this.#lowering.hoisted(() => {
          const { write, ahead } = build();
          return this.#stated(
            ahead ?? NOTHING_AHEAD,
            sql`${write} RETURN ${columns}`
          );
        }),
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
    const { response, decoded } = await this.#withFollowers(
      model,
      given,
      sql`${table} ${this.#where(selector)}`,
      () =>
        this.#refusing(model, refusal, () =>
          this.#written(
            model,
            () => {
              const frozen = this.#frozen(
                table,
                this.#where(selector),
                selector.predicate
              );
              return {
                write: frozen.update(this.#assignments(model, given)),
                ahead: this.#ahead(
                  frozen.before,
                  this.#judgedRows(
                    model,
                    frozen.source,
                    given,
                    selector.judgement
                  )
                ),
              };
            },
            fields,
            answer
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
    const asking = await this.#settled(model, asked);
    if (Object.keys(asking).length === 0) return;
    const moves = this.#keyChange(model, asking).length > 0;
    const moved = moves
      ? await Promise.all(
          identities.map((identity) =>
            this.#moveRecord(model, identity, asking)
          )
        )
      : identities;
    const values = moves ? this.#withoutKeys(model, asking) : asking;
    if (Object.keys(values).length === 0) return;
    // A list of records reads each by key, where an `OR` of the same scans.
    const records = sql.join(
      moved.map((identity) => this.#lowering.recordOfRow(model, identity)),
      ", "
    );
    await this.#refusing(model, refusal, () =>
      this.#written(
        model,
        () => ({
          write: sql`UPDATE $records SET ${this.#assignments(model, values)}`,
          ahead: this.#ahead(
            sql`LET $records = [${records}];`,
            this.#judgedRows(model, sql.raw("$records"), values, judgement)
          ),
        }),
        [],
        undefined
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
    const where = () =>
      sql.join(
        onceEach([
          this.#lowering.member(edge, parent),
          ...(selector.predicate
            ? this.#lowering.conjuncts(selector.predicate)
            : []),
        ]),
        " AND "
      );
    const frozen = () =>
      this.#frozen(table, sql`WHERE ${where()}`, selector.predicate);
    if (values && this.#keyChange(model, values).length > 0) {
      const keys = this.queries.keyOrder(model);
      const located = await this.answer(
        {
          sql: sql`SELECT ${sql.join(
            keys.map(
              (key) =>
                sql`${this.#lowering.physical(model, key)} AS ${fieldName(key)}`
            ),
            ", "
          )} FROM ${table} WHERE ${where()}`,
          shape: { kind: "object", fields: {} },
        },
        false,
        model
      );
      const rest = this.#withoutKeys(model, values);
      for (const row of located.rows as Input[]) {
        const moved = await this.#moveRecord(model, row, values);
        if (Object.keys(rest).length > 0)
          await this.#written(
            model,
            () => ({
              write: sql`UPDATE ${table} SET ${this.#assignments(model, rest)} WHERE ${this.#lowering.identity(model, moved)}`,
            }),
            [],
            undefined
          );
      }
      return;
    }
    if (values)
      return await this.#refusing(
        model,
        nestedRefusal("updateMany", edge.name),
        () =>
          this.#reportedUpdate(model, () => {
            const { before, source, update } = frozen();
            return {
              write: update(this.#assignments(model, values)),
              ahead: this.#ahead(
                before,
                this.#judgedRows(model, source, values, selector.judgement)
              ),
            };
          })
      );
    await this.#reportDelete(model, where());
    await this.#written(
      model,
      () => {
        const { before, source } = frozen();
        return {
          write: sql`DELETE ${source}`,
          ahead: this.#ahead(before, {
            lets: sql.raw(""),
            checks: this.#heldBack(model, source) ?? sql.raw(""),
          }),
        };
      },
      [],
      undefined
    );
  }

  /** An update whose rows a hook may want: the statement answers with them. */
  async #reportedUpdate(
    model: AnyModel,
    build: () => { readonly write: Sql; readonly ahead?: Ahead }
  ): Promise<void> {
    const name = model["~"].names.ts!;
    const sink = writeSinks.get(this.attribution);
    if (!sink?.wants(name, "update")) {
      await this.#written(model, build, [], undefined);
      return;
    }
    const { shape, fields } = this.queries.prepareProjection(model, {});
    const columns = fields.map((field) => this.#lowering.column(model, field));
    const rows = await this.read(
      {
        sql: this.#lowering.hoisted(() => {
          const { write, ahead } = build();
          return this.#stated(
            ahead ?? NOTHING_AHEAD,
            sql`${write} RETURN ${sql.join(columns, ", ")}`
          );
        }),
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
      () => ({
        write: stated.length
          ? sql`INSERT INTO ${table} ${this.#row(model, row)} ON DUPLICATE KEY UPDATE ${this.#assignments(model, { ...written, ...stamps })}`
          : sql`INSERT IGNORE INTO ${table} [${this.#row(model, row)}]`,
      }),
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
        () => ({
          write: sql`INSERT RELATION IGNORE INTO ${table} [${sql.join(edges, ", ")}]`,
        }),
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
      () => ({
        write:
          near.toStatement() === "in"
            ? sql`RELATE (${source})->${table}->(${targets})`
            : sql`RELATE (${targets})->${table}->(${source})`,
      }),
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
      () => ({
        write: sql`DELETE ${fieldName(model["~"].names.sql!)} WHERE ${sql.join(conditions, " AND ")}`,
        ahead: writable && {
          lets: sql`LET $writable = ${writable};`,
          checks: sql.raw(""),
        },
      }),
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
      () => ({
        write: statement,
        ahead: writable && {
          lets: sql`LET $writable = ${writable};`,
          checks: sql.raw(""),
        },
      }),
      [],
      undefined
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
    await this.#refusing(model, nestedRefusal("disconnect", edge.name), () =>
      this.#reportedUpdate(model, () => {
        const unlinked = sql.join(
          onceEach([
            ...conditions,
            ...(allowed ? this.#lowering.conjuncts(allowed) : []),
          ]),
          " AND "
        );
        const { before, source, update } = this.#frozen(
          table,
          sql`WHERE ${unlinked}`,
          allowed
        );
        return {
          write: update(this.#assignments(model, cleared)),
          ahead: this.#ahead(
            before,
            this.#judgedRows(model, source, cleared, judgement)
          ),
        };
      })
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
