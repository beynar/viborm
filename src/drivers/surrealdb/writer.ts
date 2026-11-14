/**
 * The write path's statements in SurrealQL. What a call means, which rows it
 * knows and in what order its statements go are the engine's
 * (`query-engine/raptor3/write`); here is only how each statement is said
 * where a record is its id, a many-to-many an edge, and a judged write a
 * block that refuses before it writes.
 */

import type { AnyDriver } from "@drivers/exports";
import {
  NestedWriteAssertionError,
  QueryEngineError,
  type UniqueConstraintError,
  UnsupportedOperationError,
} from "@errors";
import { dividesByZero } from "@query-engine/raptor3/shared/decimal";
import { JoinedValue } from "@query-engine/raptor3/shared/insert-value";
import {
  type PreparedProjection,
  type PreparedSelector,
  wholeValue,
} from "@query-engine/raptor3/shared/query";
import type { RowJudgement } from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { SqlOperationContext } from "@query-engine/raptor3/shared/sql-operation-context";
import {
  linkJudgement,
  linkMembers,
  type Membership,
} from "@query-engine/raptor3/shared/storage";
import {
  prepared,
  type Sent,
  type Statement,
  Stopped,
} from "@query-engine/raptor3/write/send";
import {
  type Junction,
  type Question,
  Writer,
} from "@query-engine/raptor3/write/statements";
import type { PreparedGuardFailure } from "@query-engine/types";
import { getModelKeyCatalog } from "@schema/model/keys";
import { Sql, sql } from "@sql";
import { Decimal, RecordId } from "surrealdb";
import type { SurrealQueries } from "./queries";
import {
  isOneValue,
  onceEach,
  quantized,
  type SurrealReadBackend,
  walksFurther,
} from "./read-backend";
import { FORBIDDEN_ROW, isConflict, STOPPED } from "./transaction";

type AnyModel = PreparedProjection["model"];

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
const NOTHING = sql.raw("");

/** How many times a call is made again after meeting another at commit. */
const RERUNS = 16;

/** A relation whose row holds a value of another in its own key. */
type FollowingEdge = Extract<Membership, { kind: "reference" }>;

/** What a write holds at the top level ahead of itself, and what refuses with it. */
interface Ahead {
  readonly lets: Sql;
  readonly checks: Sql;
}

const NOTHING_AHEAD: Ahead = { lets: NOTHING, checks: NOTHING };

/** The parts of a text that say something, in order. */
const seq = (...parts: Sql[]): Sql =>
  sql.join(
    parts.filter((part) => part.toStatement() !== ""),
    " "
  );

function refuse(what: string): never {
  throw new UnsupportedOperationError(
    `The SurrealDB write backend does not support ${what} yet.`
  );
}

const fieldName = (identifier: string): Sql => sql.raw(identifier);

/** A key part's value after arithmetic, computed here since a record's id is fixed. */
function arithmetic(
  type: string,
  current: unknown,
  operator: string,
  operand: unknown
): unknown {
  const zero = () => new QueryEngineError("Cannot divide a key by zero.");
  if (type === "decimal") {
    const [a, b] = [new Decimal(String(current)), new Decimal(String(operand))];
    if (operator === "divide" && dividesByZero(operand)) throw zero();
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
    if (operator === "divide" && b === 0n) throw zero();
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
  if (operator === "divide" && b === 0) throw zero();
  return operator === "increment"
    ? a + b
    : operator === "decrement"
      ? a - b
      : operator === "multiply"
        ? a * b
        : Math.trunc(a / b);
}

/**
 * One call on SurrealDB. A write's own statement answers any read of the
 * rows it writes: `RETURN` reads after the write, and a delete reads ahead
 * of itself. No locks: two writers meet at commit, and the loser, having
 * written nothing, is made again from what the winner committed.
 */
export class SurrealCall extends SqlOperationContext {
  /** A request of several statements failed: it does not say which, so the call is made again, each statement its own request. */
  #apart: boolean | undefined;

  override answersInStatement(): boolean {
    return true;
  }

  override async again(error: unknown, attempt: number): Promise<boolean> {
    if (isConflict(error)) {
      if (attempt === RERUNS) return false;
      // Two losers made again together would only meet again.
      await new Promise((resolve) =>
        setTimeout(resolve, 5 + Math.random() * 45 * attempt)
      );
      return true;
    }
    return this.#apart === false && (this.#apart = true);
  }

  /**
   * A text takes any number of statements, and answers each: sent as the
   * driver's batch, where each statement is still seen as its own.
   */
  override together(
    driver: AnyDriver,
    statements: readonly Statement[],
    whole: boolean
  ): Promise<Sent[]> | undefined {
    if (this.#apart) return undefined;
    return driver
      ._executeBatch<Input>(
        statements.map((statement) => {
          const { believed, probe, premise } = statement;
          const text = believed ? probe! : statement.sql;
          return prepared(this, driver, {
            ...statement,
            // In a text that is its own unit, what is asked stops the text where it is not so.
            sql:
              whole && text === probe
                ? sql`IF array::len({ ${text} }) ${sql.raw(premise === "exists" ? "=" : ">")} 0 { THROW ${sql.raw(`"${STOPPED}"`)} }`
                : text,
          });
        }),
        undefined,
        this.attribution
      )
      .catch((error) => {
        this.#apart ??= false;
        throw error;
      });
  }
}

export class SurrealWriter extends Writer {
  readonly #q: SurrealQueries;
  readonly #low: SurrealReadBackend;

  constructor(operation: SqlOperationContext, hears?: Writer["hears"]) {
    super(operation, hears);
    this.#q = operation.queries as unknown as SurrealQueries;
    this.#low = this.#q.lowering;
  }

  /** Asks the database in the call's unit, before the statement being written is sent. */
  async #heard(statement: Sql, model: AnyModel): Promise<Input[]> {
    if (!this.hears) refuse("a write that reads before it writes, in a batch");
    return (await this.hears(statement, model)) as Input[];
  }

  /** `INSERT IGNORE` answers with the rows it wrote: none is a row passed by, and nothing failed. */
  override get passes(): boolean {
    return true;
  }

  /** A question is asked as it is: its answer is heard, and nothing here fails to say no. */
  protected override asserts(probe: Sql): Sql {
    return probe;
  }

  override asks(
    asked: readonly (readonly [Question, (Input | Input[])?])[],
    believed: "presumed" | "read"
  ): Statement {
    const [first] = asked as [readonly [Question, (Input | Input[])?]];
    if (asked.length === 1) return super.asks(asked, believed);
    // One row answers where every question names one.
    const probe = this.#low.hoisted(
      () =>
        sql`SELECT true AS found FROM [0] WHERE ${sql.join(
          asked.map(
            (each) =>
              sql`array::len((${super.asks([each], believed).probe!})) > 0`
          ),
          " AND "
        )}`
    );
    return { ...super.asks([first], believed), sql: probe, probe };
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
    const keys = this.#q.keyOrder(model);
    const members = Object.entries(row)
      .filter(
        ([field, value]) =>
          value !== null && value !== undefined && !keys.includes(field)
      )
      .map(([field, value]): [string, Sql] => [
        this.#q.columnName(model, field),
        this.#low.value(model, field, value),
      ]);
    // Written here, not left to its default: a transaction reserves what it states.
    const { scalars } = model["~"].state;
    const generated = Object.keys(scalars)
      .filter(
        (field) =>
          scalars[field]!["~"].state.autoGenerate?.kind === "increment" &&
          !keys.includes(field) &&
          row[field] === undefined
      )
      .map((field): [string, Sql] => {
        const column = this.#q.columnName(model, field);
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

  /**
   * One row created at its record, where the row states it. `INSERT` costs about
   * twice as much for one row, and refuses a taken record or a unique value in the
   * same words. A key a sequence gives, or the statement reads, is no record yet.
   */
  #created(model: AnyModel, row: Input): Sql | undefined {
    const [stated, ...members] = this.#rowMembers(model, row);
    const record = stated![1];
    if (!(isOneValue(record) && record.values[0] instanceof RecordId))
      return undefined;
    const content = members.every(([, value]) => isOneValue(value))
      ? sql`${Object.fromEntries(
          members.map(([column, value]) => [column, value.values[0]])
        )}`
      : sql`{ ${sql.join(
          members.map(([column, value]) => sql`${fieldName(column)}: ${value}`),
          ", "
        )} }`;
    return sql`CREATE ${record} CONTENT ${content}`;
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
    const next = (key: string, sequence: string) => {
      if (
        model["~"].state.scalars[key]?.["~"].state.autoGenerate?.kind !==
        "increment"
      )
        refuse("a key the database generates");
      return sql`sequence::nextval(${sequence})`;
    };
    const table = model["~"].names.sql!;
    if (keys.length === 1) {
      const given = row[keys[0]!];
      return given === undefined
        ? next(keys[0]!, `${table}_seq`)
        : this.#low.value(model, keys[0]!, given);
    }
    if (
      keys.every((key) => row[key] !== undefined && !(row[key] instanceof Sql))
    )
      return sql`${this.#low.recordOf(model, row)}`;
    const parts = keys.map((key) => {
      if (row[key] instanceof Sql) return row[key];
      if (row[key] !== undefined)
        return this.#low.keyPart(model, key, row[key]);
      return next(key, `${table}_${this.#q.columnName(model, key)}_seq`);
    });
    return sql`[${sql.join(parts, ", ")}]`;
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
    const low = this.#low;
    return Object.entries(values).map(([field, given]) => {
      const column = low.physical(model, field);
      const whole = wholeValue(given);
      if (whole) {
        return {
          column,
          value:
            whole.value === null
              ? sql.raw("NONE")
              : low.value(model, field, whole.value),
        };
      }
      const [operator, operand] = Object.entries(given as Input)[0]!;
      const state = model["~"].state.scalars[field]?.["~"].state;
      if (operator === "push" || operator === "unshift") {
        const members = low.value(model, field, [operand].flat());
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
      const computed = sql`${column} ${sql.raw(sign)} ${low.value(model, field, operand)}`;
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

  /** What a write answers with: the rows as the call reads them, their ids where it counts them, or nothing. */
  #returning(
    projection: PreparedProjection | undefined,
    counted: boolean
  ): Sql {
    if (projection) return sql`RETURN ${this.#low.columns(projection)}`;
    return sql.raw(counted ? "RETURN id" : "RETURN NONE");
  }

  /**
   * Where a write finds its rows: the records `keys` name, the record the
   * question names by its whole key, or the table; what else is asked of
   * them; and what the statement states ahead of itself.
   */
  #frame(
    question: Question,
    keys?: readonly Input[]
  ): { readonly before: Sql; readonly target: Sql; readonly where: Sql } {
    const { model, member } = question;
    const low = this.#low;
    const selector = keys
      ? this.selector({
          ...question,
          // Rows the call knows are named by their keys; what found them is said again only where asked.
          where: question.again ? question.where : undefined,
          unique: false,
          only: undefined,
        })
      : this.selector(question);
    let from = fieldName(model["~"].names.sql!);
    let predicate = selector.predicate;
    let named = false;
    if (keys) {
      named = true;
      from =
        keys.length === 1
          ? low.recordOfRow(model, keys[0]!)
          : sql`[${sql.join(
              keys.map((key) => low.recordOfRow(model, key)),
              ", "
            )}]`;
    } else if (!member && predicate) {
      const record = low.namedRecord(model, predicate);
      if (record) {
        named = true;
        from = record.record;
        predicate = record.rest;
      }
    }
    const conditions = onceEach([
      ...(member ? [low.member(member.edge, member.of)] : []),
      ...(predicate
        ? member
          ? low.conjuncts(predicate)
          : low.located(model, predicate, named || undefined)
        : []),
    ]);
    const where = conditions.length
      ? sql`WHERE ${sql.join(conditions, " AND ")}`
      : NOTHING;
    const limit = keys || member ? undefined : question.limit;
    if (limit !== undefined) {
      // The first rows of it in key order.
      const { extras, order } = low.order(model, undefined);
      const taken = sql`ORDER BY ${order} LIMIT ${sql.raw(String(Number(limit)))}`;
      return {
        before: NOTHING,
        where: NOTHING,
        target:
          extras.length === 0
            ? sql`(SELECT VALUE id FROM ${seq(from, where, taken)})`
            : sql`(SELECT id, ${sql.join(extras, ", ")} FROM ${seq(from, where, taken)}).id`,
      };
    }
    // A statement here evaluates its `WHERE` row by row and sees what it has
    // already written, where SQL reads a snapshot: a filter that reads other
    // rows finds its rows first.
    if (selector.predicate && walksFurther(selector.predicate))
      return {
        before: sql`LET $targets = (SELECT VALUE id FROM ${seq(from, where)});`,
        target: sql.raw("$targets"),
        where: NOTHING,
      };
    return { before: NOTHING, target: from, where };
  }

  /**
   * Refused where a junction holds one of `rows` back. A record's edges go with it,
   * before anything in the database could object, so this is the engine's: a raw
   * delete does not hold back.
   */
  #heldBack(model: AnyModel, rows: Sql): Sql | undefined {
    const { schema } = this.operation;
    const refusals = schema.restrictingSlots(model).flatMap((slot) => {
      const edge = schema.membership(model, slot);
      if (edge.kind !== "junction" || edge.declared) return [];
      const { table, near } = this.#low.edgeOf(edge);
      return [
        sql`IF array::len(SELECT VALUE id FROM ${table} WHERE ${near} IN (SELECT VALUE id FROM ${rows}) LIMIT 1) > 0 { THROW ${`ON DELETE REJECT: ${edge.name}`} };`,
      ];
    });
    return refusals.length ? sql.join(refusals, " ") : undefined;
  }

  /** Refused unless every row in `rows`, read as a list, holds what judges it. */
  #judges(rows: string, judge: PreparedSelector | undefined): Ahead {
    if (!judge?.predicate) return NOTHING_AHEAD;
    const holds = this.#low.judging(() =>
      this.#low.predicate(judge.predicate!, true)
    );
    return {
      lets: sql`LET $judged = (SELECT VALUE 1 FROM ${sql.raw(rows)} WHERE ${holds});`,
      checks: sql`IF array::len($judged) != array::len(${sql.raw(rows)}) { THROW ${JUDGED} };`,
    };
  }

  /**
   * What an update states ahead of itself: the rows it would leave, as `next`
   * states them, each refused unless it holds what judges it. So the refusal
   * comes before a unique index or a reference could object, as a judged
   * statement's does in SQL. Nothing where nothing judges them.
   */
  #judgedNext(
    model: AnyModel,
    next: () => Sql,
    assigned: readonly string[],
    judgement: RowJudgement | undefined,
    candidatesJudged = true
  ): Ahead {
    const domain = this.#q.domain;
    if (judgement === undefined || domain === undefined) return NOTHING_AHEAD;
    const judge = domain.produced(
      model,
      judgement,
      candidatesJudged ? assigned : undefined
    );
    const cycles = domain.cycles(model, judgement);
    if (!judge?.predicate && cycles.length === 0) return NOTHING_AHEAD;
    const { lets, checks } = this.#judges("$next", judge);
    return {
      lets: seq(sql`LET $next = ${next()};`, lets),
      checks: seq(
        checks,
        ...cycles.map((relation) => this.#staysAcyclic(model, relation))
      ),
    };
  }

  /** {@link #judgedNext} over the rows of `source` as an update writing `values` leaves them. */
  #judgedRows(
    model: AnyModel,
    source: Sql,
    values: Input,
    judgement: RowJudgement | undefined,
    candidatesJudged = true
  ): Ahead {
    return this.#judgedNext(
      model,
      () => sql`(SELECT ${this.#leaving(model, values)} FROM ${source})`,
      Object.keys(values),
      judgement,
      candidatesJudged
    );
  }

  /** A row as an update writing `values` leaves it, read from the row it reads. */
  #leaving(model: AnyModel, values: Input): Sql {
    const written = this.#assigned(model, values).map(
      ({ column, value }) => sql`${value} AS ${column}`
    );
    return sql.join([sql.raw("*"), ...written], ", ");
  }

  /**
   * A write with what it holds ahead of it. What is held stands at the top level, and
   * the block holds only what must refuse together with the write, as one transaction.
   */
  #stated(before: Sql, ahead: Ahead, write: Sql): Sql {
    if (ahead === NOTHING_AHEAD) return seq(before, write);
    return seq(before, ahead.lets, sql`RETURN { ${seq(ahead.checks, write)} }`);
  }

  /** Refused where a row in `$next` would hold itself among what its link walks to. */
  #staysAcyclic(model: AnyModel, relation: string): Sql {
    const edge = this.operation.schema.membership(model, relation);
    if (edge.kind === "reference" && this.#low.isLinked(edge)) {
      const link = this.#low.physical(model, edge.pairs[0]!.source);
      return sql`IF array::len(SELECT VALUE 1 FROM $next WHERE ${link} != NONE AND (${link} = id OR id IN ${link}.{..+collect}.${link})) > 0 { THROW ${JUDGED} };`;
    }
    return sql`IF array::len(array::filter($next, |$candidate| $candidate.id IN ${this.#low.walkFrom(edge, sql.raw("$candidate"))}.edges.c)) > 0 { THROW ${JUDGED} };`;
  }

  /** What a judged write of the rows a question names refuses with. */
  #refusal(
    question: Question,
    judgement: RowJudgement | undefined
  ): PreparedGuardFailure | undefined {
    if (!(judgement && this.#q.domain)) return undefined;
    const edge = question.member?.edge ?? question.through;
    return this.#q.domain.refusal(
      this.operation.operation,
      question.model,
      judgement,
      edge && question.verb ? [question.verb, edge.name] : undefined
    );
  }

  override async insert(
    model: AnyModel,
    values: Input[],
    relation?: string,
    returns?: PreparedProjection,
    beside?: readonly string[],
    skips = false
  ): Promise<Statement> {
    const low = this.#low;
    const rows = await this.computed(model, values);
    const table = fieldName(model["~"].names.sql!);
    const judge = this.#q.domain?.produced(model);
    const judged = judge?.predicate !== undefined;
    const verb = sql.raw(skips ? "INSERT IGNORE" : "INSERT");
    const statement = low.hoisted(() => {
      // With what the database decides of the row beside, where the call needs both.
      const seen = new Set<string>();
      const answered = [returns, beside && this.fields(model, beside)].flatMap(
        (read) =>
          read?.fields
            .filter((field) => !seen.has(field.name) && seen.add(field.name))
            .map((field) => low.column(model, field)) ?? []
      );
      // Its own rows' count is what a call that creates many answers with.
      const returning = answered.length
        ? sql`RETURN ${sql.join(answered, ", ")}`
        : sql.raw(
            relation === undefined || skips ? "RETURN id" : "RETURN NONE"
          );
      const created =
        rows.length === 1 && !skips && !judged
          ? this.#created(model, rows[0]!)
          : undefined;
      if (created) return sql`${created} ${returning}`;
      const insert = (held: Sql) =>
        sql`${verb} INTO ${table} ${held} ${returning}`;
      if (!judged) return insert(this.#rows(model, rows));
      const { lets, checks } = this.#judges("$rows", judge);
      // The rows stand outside the block: an `IF` in a block beside a long literal takes
      // about the cube of its length (800 rows, 6 s; 1,600 never ends and holds the server).
      return sql`LET $rows = ${this.#rows(model, rows)}; ${lets} RETURN { ${checks} ${insert(sql.raw("$rows"))} }`;
    });
    return {
      model,
      sql: statement,
      ...(judged && {
        stops: this.#q.domain!.refusal(
          this.operation.operation,
          model,
          undefined,
          relation === undefined ? undefined : ["create", relation]
        ),
      }),
    };
  }

  override async update(
    question: Question,
    values: Input,
    keys?: readonly Input[],
    projection?: PreparedProjection,
    counted = !keys
  ): Promise<Statement> {
    const { model } = question;
    const low = this.#low;
    const [field, joined] = (Object.entries(values).find(
      ([, value]) => value instanceof JoinedValue
    ) ?? []) as [string, JoinedValue] | [];
    const [given] = await this.computed(model, [
      Object.fromEntries(
        Object.entries(values).filter(([, value]) => value !== joined)
      ),
    ]);
    const judgement = this.judged(question);
    const stops = this.#refusal(question, judgement);
    if (joined)
      return {
        model,
        stops,
        sql: await this.#listed(
          question,
          field!,
          joined,
          given!,
          keys,
          projection
        ),
      };
    const returning = this.#returning(projection, counted);
    const answer = projection ? low.columns(projection) : sql.raw("id");
    const located = (columns: Sql) =>
      low.hoisted(() => {
        const { before, target, where } = this.#frame(question, keys);
        return seq(before, sql`SELECT ${columns} FROM`, target, where);
      });
    if (this.#keyChange(model, given!).length > 0) {
      // A record's id cannot change: each row is found, moved, and the rest of the write follows it.
      const moved: Input[] = [];
      for (const row of await this.#heard(
        located(this.#as(model, this.#q.keyOrder(model))),
        model
      ))
        moved.push(await this.#moveRecord(model, row, given!));
      if (moved.length === 0) return { model, sql: sql`RETURN []` };
      const rest = this.#withoutKeys(model, given!);
      const records = sql`[${sql.join(
        moved.map((row) => low.recordOfRow(model, row)),
        ", "
      )}]`;
      // The moved records are what the update produces, judged as its rows would be
      // where nothing moved: their candidates stood under the keys they left.
      return {
        model,
        stops,
        sql: low.hoisted(() =>
          this.#stated(
            NOTHING,
            this.#judgedRows(model, records, rest, judgement, false),
            Object.keys(rest).length > 0
              ? sql`UPDATE ${records} SET ${this.#assignments(model, rest)} ${returning}`
              : sql`SELECT ${answer} FROM ${records}`
          )
        ),
      };
    }
    const statement = low.hoisted(() => {
      const { before, target, where } = this.#frame(question, keys);
      return this.#stated(
        before,
        this.#judgedRows(model, seq(target, where), given!, judgement),
        seq(
          sql`UPDATE ${target} SET ${this.#assignments(model, given!)}`,
          where,
          returning
        )
      );
    });
    const followers = this.#keyFollowers(model, given!);
    if (followers.length === 0) return { model, sql: statement, stops };
    // Nothing in the database moves a record: those holding what this write
    // changes in their own keys are moved here, once it is written.
    const stored = this.#as(model, this.operation.schema.storedFields(model));
    const before = await this.#heard(located(stored), model);
    const said = await this.#heard(statement, model).catch((error) => {
      throw stops && error instanceof NestedWriteAssertionError
        ? new Stopped({ model, sql: statement, stops })
        : error;
    });
    await this.#follow(model, followers, before, stored);
    return { model, sql: sql`RETURN ${said}` };
  }

  /** Fields of a row as a read names them here: each under its own name. */
  #as(model: AnyModel, fields: readonly string[]): Sql {
    return sql.join(
      fields.map(
        (field) =>
          sql`${this.#low.physical(model, field)} AS ${fieldName(field)}`
      ),
      ", "
    );
  }

  /**
   * A value each row takes from a list: what gives the value names the rows, read
   * in the call's unit, and the one statement writes a row only while it holds what
   * it was named by.
   */
  async #listed(
    question: Question,
    field: string,
    joined: JoinedValue,
    beside: Input,
    keys: readonly Input[] | undefined,
    projection: PreparedProjection | undefined
  ): Promise<Sql> {
    const { model } = question;
    const q = this.#q;
    const low = this.#low;
    const selector = this.selector(question, keys);
    const spelt = q.spelling(model, this.operation.driver.dialect);
    const entries = await joined.rows(
      {
        ...spelt,
        // The rows this update may write are those its own question names.
        visible: (alias, options) =>
          options?.update
            ? selector.predicate
              ? low.predicate(selector.predicate, true)
              : sql.raw("true")
            : spelt.visible(alias, options),
      },
      (statement) => this.#heard(statement, model)
    );
    const identity = q.keyOrder(model);
    const writes = entries.map(({ where, value }) => ({
      record: low.recordOfRow(
        model,
        Object.fromEntries(identity.map((key) => [key, where[key]]))
      ),
      values: { [field]: value, ...beside } as Input,
      where: sql.join(
        [
          sql.raw("true"),
          ...Object.entries(where)
            .filter(([held]) => !identity.includes(held))
            .map(([held, was]) =>
              was === null || was === undefined
                ? sql`${low.physical(model, held)} = NONE`
                : sql`${low.physical(model, held)} = ${low.value(model, held, was)}`
            ),
        ],
        " AND "
      ),
    }));
    if (writes.length === 0) return sql`RETURN []`;
    // Each row is judged as it would be left, as the rows of an update are.
    return low.hoisted(() => {
      const written = sql`array::flatten([${sql.join(
        writes.map(
          ({ record, values, where }) =>
            sql`(UPDATE ${record} SET ${this.#assignments(model, values)} WHERE ${where} RETURN id)`
        ),
        ", "
      )}])`;
      return this.#stated(
        NOTHING,
        this.#judgedNext(
          model,
          () =>
            sql`array::flatten([${sql.join(
              writes.map(
                ({ record, values, where }) =>
                  sql`(SELECT ${this.#leaving(model, values)} FROM ${record} WHERE ${where})`
              ),
              ", "
            )}])`,
          [field, ...Object.keys(beside)],
          this.judged(question)
        ),
        projection
          ? sql`LET $written = ${written}.id; RETURN (SELECT ${low.columns(projection)} FROM $written);`
          : sql`RETURN ${written}`
      );
    });
  }

  override remove(
    question: Question,
    keys?: readonly Input[],
    projection?: PreparedProjection,
    counted = !keys
  ): Statement {
    const { model } = question;
    const low = this.#low;
    return {
      model,
      sql: low.hoisted(() => {
        const { before, target, where } = this.#frame(
          { ...question, intent: "delete" },
          keys
        );
        const heldBack = this.#heldBack(model, sql.raw("$rows"));
        if (!(heldBack || projection))
          return seq(
            before,
            sql`DELETE`,
            target,
            where,
            sql.raw(counted ? "RETURN BEFORE" : "RETURN NONE")
          );
        // `RETURN BEFORE` is the row alone, so what it answers reads ahead of it, in
        // the one statement: a block runs as a transaction of its own.
        return seq(
          before,
          sql`LET $rows = (SELECT VALUE id FROM ${seq(target, where)});`,
          projection
            ? sql`LET $answer = (SELECT ${low.columns(projection)} FROM $rows);`
            : NOTHING,
          sql`RETURN { ${seq(
            heldBack ?? NOTHING,
            projection
              ? sql`DELETE $rows; RETURN $answer;`
              : sql`DELETE $rows RETURN BEFORE`
          )} }`
        );
      }),
    };
  }

  override async either(
    question: Question,
    row: Input,
    set: Input,
    projection: PreparedProjection
  ): Promise<Statement> {
    const { model } = question;
    const low = this.#low;
    const [given] = await this.computed(model, [row]);
    const [updates] = await this.computed(model, [set]);
    const target = this.selector(question).uniqueKey!.fields;
    const table = fieldName(model["~"].names.sql!);
    const returning = this.#returning(projection, true);
    return {
      model,
      sql: low.hoisted(() => {
        const created = this.#row(model, given!);
        const assignments = this.#assignments(model, updates!);
        if (this.#q.keyOrder(model).every((key) => target.includes(key)))
          return sql`INSERT INTO ${table} ${created} ON DUPLICATE KEY UPDATE ${assignments} ${returning}`;
        // `ON DUPLICATE KEY` takes a conflict on any index, and only the target's
        // may update: the record is found by it, and another conflict still refuses.
        const found = sql.join(
          target.map(
            (field) =>
              sql`${low.physical(model, field)} = ${low.value(model, field, given![field])}`
          ),
          " AND "
        );
        return sql`RETURN { LET $found = (SELECT VALUE id FROM ${table} WHERE ${found} LIMIT 1)[0]; RETURN IF $found != NONE { UPDATE $found SET ${assignments} ${returning} } ELSE { INSERT INTO ${table} [${created}] ${returning} }; }`;
      }),
    };
  }

  override async link(
    edge: Junction,
    pairs: readonly (readonly [Input, Input])[],
    through?: Input
  ): Promise<Statement[]> {
    const low = this.#low;
    const { uniqueSide } = edge;
    const statements: Sql[] = [];
    const own = uniqueSide === "source" ? 0 : 1;
    if (edge.declared) {
      const { model } = edge.declared;
      const members = linkMembers(edge);
      const table = fieldName(model["~"].names.sql!);
      const taken = await this.linked(
        edge,
        members.map(({ pair }) => pair.junctionField),
        through
      );
      const holds = (side: Junction["sourceSide"], row: Input) =>
        sql.join(
          side.members.map((pair) => {
            const field = low.linkFieldOf(edge, pair.junctionField);
            return sql`${low.physical(model, field)} = ${low.value(model, field, row[pair.referencedField])}`;
          }),
          " AND "
        );
      for (const pair of pairs) {
        // The link that side holds takes the other row: the one it held goes.
        if (uniqueSide)
          statements.push(
            sql`DELETE ${table} WHERE ${holds(edge[`${uniqueSide}Side`], pair[own])} AND !(${holds(
              edge[uniqueSide === "source" ? "targetSide" : "sourceSide"],
              pair[1 - own]!
            )}) RETURN NONE`
          );
        const row = this.#row(model, {
          ...Object.fromEntries(
            members.map(({ side, pair: member }) => [
              low.linkFieldOf(edge, member.junctionField),
              pair[side === edge.sourceSide ? 0 : 1][member.referencedField],
            ])
          ),
          ...taken.row,
        });
        statements.push(
          taken.sets
            ? sql`INSERT INTO ${table} ${row} ON DUPLICATE KEY UPDATE ${this.#assignments(model, taken.sets)} RETURN NONE`
            : sql`INSERT IGNORE INTO ${table} [${row}] RETURN NONE`
        );
      }
    } else {
      const { table, near, far } = low.edgeOf(edge);
      const ends = pairs.map(
        (pair) =>
          [
            low.end(
              edge.sourceSide,
              (member) => pair[0][member.referencedField]
            ),
            low.end(
              edge.targetSide,
              (member) => pair[1][member.referencedField]
            ),
          ] as const
      );
      if (uniqueSide) {
        // A singular relation needs its index, so its edges carry a record, and a
        // `RELATE` would refuse the pair an idempotent link must skip. The edge
        // that side holds to another row goes first.
        const [held, other] = own === 0 ? [near, far] : [far, near];
        for (const pair of ends)
          statements.push(
            sql`DELETE ${table} WHERE ${held} = ${pair[own]} AND ${other} != ${pair[1 - own]!} RETURN NONE`
          );
        statements.push(
          sql`INSERT RELATION IGNORE INTO ${table} [${sql.join(
            ends.map(
              ([source, target]) =>
                sql`{ ${near}: ${source}, ${far}: ${target} }`
            ),
            ", "
          )}] RETURN NONE`
        );
      } else {
        // A `LIGHTWEIGHT` edge is its pair, so `RELATE` is idempotent by itself and
        // takes one source's targets in one statement.
        const forward = near.toStatement() === "in";
        const bySource = new Map<string, { source: Sql; targets: Sql[] }>();
        for (const [source, target] of ends) {
          const name = `${source.toStatement()} ${source.values.map(String).join(" ")}`;
          const run = bySource.get(name) ?? { source, targets: [] };
          run.targets.push(target);
          bySource.set(name, run);
        }
        for (const { source, targets } of bySource.values()) {
          const all = sql`[${sql.join(targets, ", ")}]`;
          statements.push(
            forward
              ? sql`RELATE (${source})->${table}->(${all}) RETURN NONE`
              : sql`RELATE (${all})->${table}->(${source}) RETURN NONE`
          );
        }
      }
    }
    return statements.map((statement) => ({
      sql: statement,
      model: edge.source,
    }));
  }

  override unlink(
    edge: Junction,
    from: Input,
    to: Input | undefined,
    kept: readonly Input[]
  ): Statement {
    const low = this.#low;
    // Every link but those kept: of the rows the call may take out, and no other.
    const allowed = to
      ? undefined
      : this.#q.domainOf(edge.target, "related", linkJudgement(edge))
          ?.predicate;
    const writable = allowed
      ? sql`LET $writable = (SELECT VALUE id FROM ${fieldName(edge.target["~"].names.sql!)} WHERE ${low.predicate(allowed, true)});`
      : NOTHING;
    const among = (far: Sql) => (allowed ? [sql`${far} IN $writable`] : []);
    if (edge.declared) {
      const { model } = edge.declared;
      const holds = (side: Junction["sourceSide"], row: Input) =>
        sql.join(
          side.members.map((pair) => {
            const field = low.linkFieldOf(edge, pair.junctionField);
            return sql`${low.physical(model, field)} = ${low.value(model, field, row[pair.referencedField])}`;
          }),
          " AND "
        );
      return {
        model: edge.source,
        sql: seq(
          writable,
          sql`DELETE ${fieldName(model["~"].names.sql!)} WHERE ${sql.join(
            [
              holds(edge.sourceSide, from),
              ...(to ? [holds(edge.targetSide, to)] : []),
              ...kept.map((row) => sql`!(${holds(edge.targetSide, row)})`),
              ...among(low.linkTarget(edge, edge.targetSide, "")),
            ],
            " AND "
          )} RETURN NONE`
        ),
      };
    }
    const { far, out } = low.edgeOf(edge);
    const end = (side: Junction["sourceSide"], row: Input) =>
      low.end(side, (pair) => row[pair.referencedField]);
    const conditions = [
      ...(to ? [sql`${far} = ${end(edge.targetSide, to)}`] : []),
      ...(kept.length
        ? [
            sql`${far} NOT IN [${sql.join(
              kept.map((row) => end(edge.targetSide, row)),
              ", "
            )}]`,
          ]
        : []),
      ...among(far),
    ];
    // From its source, an edge is reached along the record's own list.
    return {
      model: edge.source,
      sql: seq(
        writable,
        sql`DELETE ${end(edge.sourceSide, from)}${out}`,
        conditions.length
          ? sql`WHERE ${sql.join(conditions, " AND ")}`
          : NOTHING,
        sql`RETURN NONE`
      ),
    };
  }

  /**
   * A refusal here says what it met: the record, where the row's own key was
   * taken, or the index, under the name a migration gives a model's key.
   */
  override refusedFor(
    model: AnyModel,
    key: NonNullable<PreparedSelector["uniqueKey"]>,
    error: UniqueConstraintError
  ): boolean {
    const table = model["~"].names.sql!;
    return error.message.includes(
      key.kind === "primary"
        ? `Database record \`${table}:`
        : `index \`${table}_${key.name ?? this.#q.columnName(model, key.fields[0]!)}_key\``
    );
  }

  /** The key fields a write states. */
  #keyChange(model: AnyModel, given: Input): readonly string[] {
    return this.#q.keyOrder(model).filter((key) => Object.hasOwn(given, key));
  }

  /** The values a write states beside a key it has already moved. */
  #withoutKeys(model: AnyModel, given: Input): Input {
    const keys = this.#q.keyOrder(model);
    return Object.fromEntries(
      Object.entries(given).filter(([field]) => !keys.includes(field))
    );
  }

  /**
   * What stands in for a moved row's unique fields while both copies exist: its
   * unique indexes would read the old row as a duplicate of the new one. One field
   * out of the way frees a key over several, and a missing value is in no index.
   */
  #standIns(model: AnyModel): Map<string, Sql | undefined> {
    const keys = this.#q.keyOrder(model);
    const scalars = model["~"].state.scalars;
    const standIns = new Map<string, Sql | undefined>();
    const standIn = (field: string) => {
      const state = scalars[field]?.["~"].state;
      return !state || state.array || this.#low.holdsRecord(model, field)
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

  /** One row moved to the key a write gives it: one statement, a transaction of its own. */
  async #moveRecord(
    model: AnyModel,
    identity: Input,
    given: Input
  ): Promise<Input> {
    const next = { ...identity };
    for (const key of this.#keyChange(model, given))
      next[key] = await this.#movedKey(model, key, identity[key], given[key]);
    const statement = await this.#movement(model, identity, next, { count: 0 });
    await this.#heard(sql`RETURN { ${statement} RETURN []; }`, model);
    return next;
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
    if (whole)
      return (
        await this.#heard(sql`RETURN [{ value: ${whole.value as Sql} }]`, model)
      )[0]?.value;
    const [operator, operand] = Object.entries(given as Input)[0]!;
    const { type } = model["~"].state.scalars[key]!["~"].state;
    if (!ARITHMETIC[operator]) refuse(`the '${operator}' update`);
    return arithmetic(type as string, current, operator, operand);
  }

  /**
   * Who holds a non-key field of `model` in their own key, cascading: nothing in the
   * database can move a record, so an update of the field moves them here.
   */
  #keyFollowers(model: AnyModel, given: Input): readonly FollowingEdge[] {
    const q = this.#q;
    const keys = q.keyOrder(model);
    const found: FollowingEdge[] = [];
    for (const source of Object.values(this.operation.schema.schema))
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

  /** The records holding, in their own keys, what a write changed of the rows that were `before`: each moved after it. */
  async #follow(
    model: AnyModel,
    followers: readonly FollowingEdge[],
    before: readonly Input[],
    stored: Sql
  ): Promise<void> {
    const low = this.#low;
    const q = this.#q;
    const keys = q.keyOrder(model);
    for (const was of before) {
      const [now] = await this.#heard(
        sql`SELECT ${stored} FROM ${low.recordOfRow(model, this.operation.schema.identity(model, was))}`,
        model
      );
      if (!now) continue;
      for (const edge of followers) {
        const { source } = edge;
        const held = await this.#heard(
          sql`SELECT ${this.#as(source, q.keyOrder(source))} FROM ${fieldName(source["~"].names.sql!)} WHERE ${sql.join(
            edge.pairs.map(
              ({ source: part, target }) =>
                sql`${low.physical(source, part)} = ${low.value(source, part, was[target])}`
            ),
            " AND "
          )}`,
          model
        );
        for (const row of held)
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
    const q = this.#q;
    const low = this.#low;
    const { schema } = this.operation;
    const at = moves.count++;
    const named = (variable: string) => sql.raw(`$${variable}${at}`);
    const old = named("old");
    const moved = named("new");
    const held = named("row");
    const other = named("other");
    const others = named("others");
    const keys = q.keyOrder(model);
    const standIns = this.#standIns(model);
    const copied = schema
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
    for (const source of Object.values(schema.schema))
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
            : {
                ...(
                  await this.#heard(
                    sql`SELECT ${this.#as(model, schema.storedFields(model))} FROM ${low.recordOfRow(model, identity)}`,
                    model
                  )
                )[0],
                ...identity,
              };
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
            for (const row of await this.#heard(
              sql`SELECT ${this.#as(source, q.keyOrder(source))} FROM ${table} WHERE ${holding}`,
              model
            ))
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
    return sql`LET ${old} = ${low.recordOfRow(model, identity)}; LET ${moved} = ${low.recordOfRow(model, next)}; IF ${moved} = ${old} { RETURN []; }; ${sql.join(refusals, " ")} LET ${held} = (SELECT * FROM ONLY ${old}); IF ${held} = NONE { RETURN []; }; ${quiet ? sql`UPDATE ${old} SET viborm_moved = true;` : NOTHING} INSERT INTO ${fieldName(model["~"].names.sql!)} [{ ${sql.join([sql`id: ${moved}`, ...copied], ", ")} }] RETURN NONE; ${sql.join(follow, " ")} DELETE ${old}; ${restored.length ? sql`UPDATE ${moved} SET ${sql.join(restored, ", ")};` : NOTHING}`;
  }
}
