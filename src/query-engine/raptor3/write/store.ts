/**
 * The image: what one call believes of the rows it touches.
 *
 * The verbs ask it questions and tell it writes, as if it were the database
 * and answered at once. A question it can answer from what it knows is
 * answered from memory. One it cannot is noted, and answered with nothing;
 * the noted questions are then read together, and the verbs run again from
 * the start. Writes are noted, and sent at the end as one unit, behind the
 * statements that stop it where what the call believed no longer holds.
 *
 * A unit that stops writes nothing. Where it stopped on a row the call took
 * to be there, that row's question is asked for real and the verbs run
 * again: it is the verbs that refuse, of an image that is right.
 */
import { NotFoundError } from "@errors";
import type { AnyModel } from "@schema/model";
import { createFailureError } from "../../batch-error-attribution";
import type { PreparedProjection, Query } from "../shared/query";
import type { Input } from "../shared/schema";
import type { SqlOperationContext } from "../shared/sql-operation-context";
import { type Sent, type Statement, Stopped, type Transport } from "./send";
import { type Junction, outside, type Question, Writer } from "./statements";

/** A row the call knows: what it holds, as far as the call knows it. */
export type Row = Input;

interface Meta {
  readonly model: AnyModel;
  /** The question that found it, where one did. */
  readonly question?: Question;
  /** The call creates it. */
  made?: true;
  /** Nothing is known of it but its key: it was taken to be there. */
  partial?: true;
}

/** What a set write says once it is sent. */
export interface Later {
  sent?: Sent;
}

type Entry =
  | { readonly insert: Row; readonly relation?: string }
  | {
      readonly update: Row;
      readonly set: Input;
      readonly writes?: readonly string[];
    }
  | {
      readonly all: Question;
      readonly set: Input;
      readonly later: Later;
      readonly projection?: PreparedProjection;
    }
  | { readonly link: Junction; readonly from: Row; readonly to: Row };

/** The statements of one unit, and where their answers are told. */
export interface Unit {
  readonly statements: Statement[];
  heard(answers: readonly Sent[]): void;
}

export class Store {
  readonly operation: SqlOperationContext;
  readonly writer: Writer;
  readonly #transport: Transport;
  /** What the database answered, by question: kept from one run of the verbs to the next. */
  readonly #answers = new Map<string, { question: Question; rows: Input[] }>();
  /** The questions asked for real: a run needed more of their row than its key, or the row was not there. */
  readonly #concrete = new Set<string>();
  /** What a run made once and every later run takes again: a row's own copy of what the caller wrote. */
  readonly #copies = new Map<string, unknown>();
  #meta = new WeakMap<Row, Meta>();
  #known = new Map<string, Row>();
  #log: Entry[] = [];
  #missed = new Map<string, Question>();
  #presumed = new Map<string, { question: Question; row: Row }>();
  #used = new Set<{ question: Question; rows: Input[] }>();
  #after: { statement: Statement; take(sent: Sent): void }[] = [];
  #again = false;
  constructor(operation: SqlOperationContext, transport: Transport) {
    this.operation = operation;
    this.writer = new Writer(operation);
    this.#transport = transport;
  }
  /**
   * Runs the verbs until they ran on an image that could answer them, then
   * sends what they wrote; with `hand`, hands the unit over instead. `work`
   * answers how the call's answer is read once the unit is sent.
   */
  async run<T>(
    work: () => () => T,
    hand: true
  ): Promise<{ unit: Unit; answer: () => T }>;
  async run<T>(work: () => () => T): Promise<T>;
  async run<T>(work: () => () => T, hand?: true): Promise<unknown> {
    for (let races = 0; ; ) {
      this.#meta = new WeakMap();
      this.#known = new Map();
      this.#log = [];
      this.#missed = new Map();
      this.#presumed = new Map();
      this.#used = new Set();
      this.#after = [];
      this.#again = false;
      let answer: (() => T) | undefined;
      let refused: { error: unknown } | undefined;
      try {
        answer = work();
      } catch (error) {
        refused = { error };
      }
      if (this.#missed.size > 0) {
        await this.#learn();
        continue;
      }
      if (this.#again) continue;
      if (refused) throw refused.error;
      const unit = await this.#unit();
      if (hand) return { unit, answer: answer! };
      try {
        if (unit.statements.length > 0)
          unit.heard(await this.#transport.send(unit.statements, true));
        return answer!();
      } catch (error) {
        if (!(error instanceof Stopped)) throw error;
        const { stops, believed, model } = error.statement;
        // The call may not leave the row it would write.
        if (!believed)
          throw createFailureError(
            stops!,
            model["~"].names.ts!,
            this.operation.operation
          );
        // What the call took for granted is asked for real; what it read is read again.
        if (believed === "presumed")
          for (const id of this.#presumed.keys()) this.#concrete.add(id);
        else if (++races > 3)
          throw new NotFoundError(
            model["~"].names.ts!,
            this.operation.operation
          );
        else this.#answers.clear();
      }
    }
  }
  /** One unit of reads: every question the last run could not answer. */
  async #learn(): Promise<void> {
    const asked = [...this.#missed];
    const queries = asked.map(([, question]) =>
      this.writer.read(question, this.#transport.holds)
    );
    const sent = await this.#transport.send(
      queries.map((query, at) => ({
        sql: query.sql,
        model: asked[at]![1].model,
      })),
      false
    );
    for (const [at, [id, question]] of asked.entries())
      this.#answers.set(id, {
        question,
        rows: this.operation.queries.decodeQuery(
          queries[at]!,
          sent[at]!.rows,
          true
        ) as Input[],
      });
  }
  #name(model: AnyModel, values: Input): string {
    return `${model["~"].names.ts}:${this.operation.schema
      .keys(model)
      .map((field) => String(values[field]))
      .join("|")}`;
  }
  #key(row: Row): Input {
    return this.operation.schema.identity(this.#meta.get(row)!.model, row);
  }
  /** The one handle of a row, by its key. */
  #intern(model: AnyModel, values: Input, question?: Question): Row {
    const name = this.#name(model, values);
    let row = this.#known.get(name);
    if (!row) {
      row = { ...values };
      this.#known.set(name, row);
      this.#meta.set(row, { model, question });
    }
    return row;
  }
  /**
   * A question that names one row by its key is not asked: the row is taken
   * to be there, with nothing known of it but its key, and the unit that
   * writes asks first. A run that reads more of the row has the question
   * asked for real.
   */
  #presume(id: string, question: Question): Row | undefined {
    const { schema } = this.operation;
    const { model } = question;
    const pins = this.writer.selector(question).uniqueValues;
    const keys = schema.keys(model);
    if (
      !(question.unique && pins) ||
      this.#concrete.has(id) ||
      !keys.every((field) => pins.has(field))
    )
      return undefined;
    const key = Object.fromEntries(
      keys.map((field) => [field, pins.get(field)])
    );
    const name = this.#name(model, key);
    let row = this.#known.get(name);
    // A row the call already wrote is asked of the database once its writes are sent.
    if (row && this.#written(row)) return outside();
    if (!row) {
      const fields = schema.storedFields(model);
      const held: Row = { ...key };
      row = new Proxy(held, {
        get: (target, field) => {
          if (
            typeof field === "string" &&
            fields.includes(field) &&
            !(field in target) &&
            this.#meta.get(row!)?.partial
          ) {
            this.#concrete.add(id);
            this.#again = true;
          }
          return target[field as string];
        },
      });
      this.#known.set(name, row);
      this.#meta.set(row, { model, question, partial: true });
    }
    this.#presumed.set(id, { question, row });
    return row;
  }
  #written(row: Row): boolean {
    return this.#log.some(
      (entry) =>
        ("insert" in entry && entry.insert === row) ||
        ("update" in entry && entry.update === row)
    );
  }
  /** The rows a question names. */
  rows(question: Question): Row[] {
    const { model, member } = question;
    const id = JSON.stringify(
      [
        model["~"].names.ts,
        question.where,
        question.unique,
        member && [member.edge.name, this.#name(member.edge.source, member.of)],
        question.intent,
        question.writes,
        question.joins?.name,
        question.limit,
      ],
      (_, value) => (typeof value === "bigint" ? `${value}n` : value)
    );
    const answer = this.#answers.get(id);
    if (!answer) {
      const row = this.#presume(id, question);
      if (row) return [row];
      this.#missed.set(id, question);
      return [];
    }
    // Rows of the model the call wrote since are the database's to say once its writes are sent.
    if (
      this.#log.some(
        (entry) =>
          ("insert" in entry &&
            this.#meta.get(entry.insert)!.model === model) ||
          ("update" in entry &&
            this.#meta.get(entry.update)!.model === model) ||
          ("all" in entry && entry.all.model === model)
      )
    )
      return outside();
    this.#used.add(answer);
    return answer.rows.map((values) => {
      const row = this.#intern(model, values, question);
      const meta = this.#meta.get(row)!;
      // A row taken to be there, now read.
      if (meta.partial) {
        Object.assign(row, values);
        meta.partial = undefined;
      }
      return row;
    });
  }
  /** The one row a question names, which must be there. */
  one(question: Question): Row {
    const [row] = this.rows({ ...question, must: true });
    if (!row)
      throw createFailureError(
        this.writer.absent(question),
        question.model["~"].names.ts!,
        this.operation.operation
      );
    return row;
  }
  /** What a row of `model` takes where it is created or updated, beside what the caller wrote of it. */
  values(
    model: AnyModel,
    kind: "create" | "update",
    admitted: Input,
    raw: Input = {}
  ): Input {
    return this.writer.values(model, kind, admitted, raw);
  }
  /** A row created: what was admitted of what the caller wrote of it, and what it is given to be a member. */
  insert(
    model: AnyModel,
    admitted: Input,
    raw?: Input,
    relation?: string
  ): Row {
    const values = this.values(model, "create", admitted, raw);
    if (
      this.operation.schema
        .keys(model)
        .some((field) => values[field] === undefined)
    )
      outside();
    const row = this.#intern(model, values);
    this.#meta.get(row)!.made = true;
    this.#log.push({ insert: row, relation });
    return row;
  }
  /** A row takes `set`: `writes` says what the caller wrote of it. */
  update(row: Row, set: Input, writes?: readonly string[]): void {
    if (Object.keys(set).length === 0) return;
    Object.assign(row, set);
    // A row the call creates is inserted as it stands in the end.
    if (this.#meta.get(row)!.made) return;
    this.#log.push({ update: row, set, writes });
  }
  /** Every row a question names takes `set`: the call does not need to know them. */
  updateAll(
    question: Question,
    set: Input,
    projection?: PreparedProjection
  ): Later {
    const later: Later = {};
    this.#log.push({ all: question, set, later, projection });
    return later;
  }
  /** `to` is made a member of `from`'s through a junction. */
  link(edge: Junction, from: Row, to: Row): void {
    this.#log.push({ link: edge, from, to });
  }
  /** A read sent behind the call's writes, in their unit. */
  after(model: AnyModel, query: Query, take: (sent: Sent) => void): void {
    this.#after.push({ statement: { sql: query.sql, model }, take });
  }
  /** What one run makes of `make` is what every later run takes: a row's own copy of what the caller wrote. */
  copy<T>(name: string, make: () => T): T {
    if (!this.#copies.has(name)) this.#copies.set(name, make());
    return this.#copies.get(name) as T;
  }
  /**
   * The unit of the call's writes: what the call believed must still hold,
   * then every write in order, then what it reads of them. Rows written the
   * same way side by side travel in one statement.
   */
  async #unit(): Promise<Unit> {
    const { writer } = this;
    const statements: Statement[] = [];
    const takes = new Map<number, (sent: Sent) => void>();
    for (const { question } of this.#presumed.values())
      statements.push(writer.asks(question, undefined, "presumed"));
    if (!this.#transport.holds)
      for (const answer of this.#used)
        for (const values of answer.rows)
          statements.push(
            writer.asks(
              answer.question,
              this.operation.schema.identity(answer.question.model, values),
              "read"
            )
          );
    const log = this.#log;
    for (let at = 0; at < log.length; at++) {
      const entry = log[at]!;
      const beside = <T extends Entry>(same: (next: T) => boolean): T[] => {
        const run = [entry as T];
        while (at + 1 < log.length && same(log[at + 1] as T))
          run.push(log[++at] as T);
        return run;
      };
      if ("insert" in entry) {
        const { model } = this.#meta.get(entry.insert)!;
        const rows: Input[] = [];
        const settled = (row: Row) =>
          Object.fromEntries(
            Object.entries(row).filter(([, value]) => value !== undefined)
          );
        beside<Extract<Entry, { insert: Row }>>((next) => {
          const fits =
            "insert" in next &&
            this.#meta.get(next.insert)!.model === model &&
            next.relation === entry.relation &&
            writer.beside(
              model,
              [settled(entry.insert), ...rows],
              settled(next.insert)
            );
          if (fits) rows.push(settled(next.insert));
          return fits;
        });
        statements.push(
          await writer.insert(
            model,
            [settled(entry.insert), ...rows],
            entry.relation
          )
        );
      } else if ("update" in entry) {
        const meta = this.#meta.get(entry.update)!;
        const run = beside<Extract<Entry, { update: Row }>>(
          (next) =>
            "update" in next &&
            next.set === entry.set &&
            this.#meta.get(next.update)!.model === meta.model
        );
        statements.push(
          await writer.update(
            {
              ...meta.question,
              model: meta.model,
              intent: "update",
              writes: entry.writes,
            },
            entry.set,
            run.map((next) => this.#key(next.update))
          )
        );
      } else if ("all" in entry) {
        takes.set(statements.length, (sent) => {
          entry.later.sent = sent;
        });
        statements.push(
          await writer.update(entry.all, entry.set, undefined, entry.projection)
        );
      } else {
        const run = beside<Extract<Entry, { link: Junction }>>(
          (next) => "link" in next && next.link === entry.link
        );
        statements.push(
          ...writer.link(
            entry.link,
            run.map((next) => [next.from, next.to] as const)
          )
        );
      }
    }
    for (const { statement, take } of this.#after) {
      takes.set(statements.length, take);
      statements.push(statement);
    }
    return {
      statements,
      heard: (answers) => {
        for (const [at, take] of takes) take(answers[at]!);
      },
    };
  }
}
