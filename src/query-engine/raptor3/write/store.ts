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
 * What the image cannot know — rows a set write changed, rows the database
 * changed with a row the call removed or renamed, a filter only the database
 * evaluates over a row the call wrote — follows one rule: what is noted is
 * sent, then the question is asked.
 *
 * A unit that stops writes nothing. Where it stopped on a row the call took
 * to be there, that row's question is asked for real and the verbs run
 * again: it is the verbs that refuse, of an image that is right.
 */
import { NotFoundError } from "@errors";
import type { AnyModel } from "@schema/model";
import { createFailureError } from "../../batch-error-attribution";
import type { PreparedGuardFailure } from "../../types";
import { type WriteKind, type WriteSink, writeSinks } from "../../write-sinks";
import {
  type PreparedProjection,
  type Query,
  readUpdate,
  returningSafeProjection,
} from "../shared/query";
import type { EngineSchema, Input } from "../shared/schema";
import type { SqlOperationContext } from "../shared/sql-operation-context";
import { linkJudgement, type Membership } from "../shared/storage";
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
  /** The call removed it. */
  gone?: true;
  /** The call changed its key. */
  moved?: true;
  /** The fields the call wrote of it. */
  readonly wrote: Set<string>;
}

/** What a set write says once it is sent. */
export interface Later {
  sent?: Sent;
}

/**
 * A value the database decides, of a row the call wrote: known once the
 * statement that writes the row is heard.
 */
class Pending {
  readonly row: Row;
  readonly field: string;
  readonly #name: string;
  constructor(row: Row, field: string, name: string) {
    this.row = row;
    this.field = field;
    this.#name = name;
  }
  toString(): string {
    return this.#name;
  }
}
const UNHEARD = Symbol("a value the database has not said yet");
/** Thrown where a call that must be one unit is more than one. */
export const SEVERAL = Symbol("more than one unit");

/** One thing noted: what it writes when its unit is sent, and where its answer is told. */
type Entry = (
  | {
      readonly kind: "insert";
      readonly row: Row;
      readonly relation?: string;
      /** The fields of its key the database decides. */
      readonly decided: readonly string[];
    }
  | {
      readonly kind: "update";
      readonly row: Row;
      /** The row's key as the write finds it. */
      readonly key: Input;
      readonly set: Input;
      /** The fields of its key the database computes by this write. */
      readonly hears: readonly string[];
      readonly question: Question;
    }
  | {
      readonly kind: "delete";
      readonly row: Row;
      readonly key: Input;
      readonly question: Question;
    }
  | {
      readonly kind: "all";
      readonly question: Question;
      readonly set?: Input;
      readonly projection?: PreparedProjection;
    }
  | {
      /** The row a question names takes `set`; where there is none, `row` is created. */
      readonly kind: "either";
      readonly question: Question;
      readonly row: Input;
      readonly set: Input;
      readonly projection: PreparedProjection;
    }
  | {
      readonly kind: "link";
      readonly edge: Junction;
      readonly from: Row;
      readonly to: Row;
      readonly keys: readonly [Input, Input];
    }
  | {
      readonly kind: "unlink";
      readonly edge: Junction;
      readonly from: Row;
      readonly to?: Row;
      readonly kept: readonly Row[];
      readonly keys: readonly [Input, Input | undefined, Input[]];
    }
  | {
      readonly kind: "none";
      readonly question: Question;
      readonly stops?: PreparedGuardFailure;
    }
  | {
      readonly kind: "read";
      readonly model: AnyModel;
      readonly rows: readonly Row[];
      /** Of one row, read as this says: the statement that writes the row may answer it. */
      readonly projection?: PreparedProjection;
      readonly queries: () => Query[];
    }
) & { take?(sent: Sent[], queries?: Query[]): void };

/** Statements of a unit, written when it is sent, and where their answers are told. */
interface Step {
  write(): Statement[] | Promise<Statement[]>;
  take?(sent: Sent[]): void;
}

interface Answer {
  readonly question: Question;
  readonly rows: Input[];
}

/** The models whose rows the database changes with a row of `model` that goes, or takes another key. */
const dependents = new WeakMap<AnyModel, Set<AnyModel>>();
function dependentsOf(schema: EngineSchema, model: AnyModel): Set<AnyModel> {
  let found = dependents.get(model);
  if (!found) {
    found = new Set();
    dependents.set(model, found);
    for (const name of model["~"].relationNames) {
      const resolved = schema.index.get(model)!.get(name)!;
      if ("members" in resolved.edge) continue;
      const edge = schema.membership(model, name);
      if (edge.kind !== "reference" || edge.owner !== "target") continue;
      found.add(edge.target);
      for (const further of dependentsOf(schema, edge.target))
        found.add(further);
    }
  }
  return found;
}

export class Store {
  readonly operation: SqlOperationContext;
  readonly writer: Writer;
  /** What is told the rows the call writes through its relations, where something asks. */
  readonly sink: WriteSink | undefined;
  readonly #transport: Transport;
  /** What the database answered, by question: kept from one run of the verbs to the next. */
  readonly #answers = new Map<string, Answer>();
  /** The questions asked for real: a run needed more of their row than its key, or the row was not there. */
  readonly #concrete = new Set<string>();
  /** What a run made once and every later run takes again: a row's own copy of what the caller wrote. */
  readonly #copies = new Map<string, unknown>();
  /** How much of what the verbs note is sent already, and what the database said of it. */
  #sent = 0;
  #delivered = 0;
  readonly #heard = new Map<number, Sent[]>();
  /** The rows taken to be there that a unit asked for already, where rows are held. */
  readonly #asserted = new Set<string>();
  #meta = new WeakMap<Row, Meta>();
  #known = new Map<string, Row>();
  #log: Entry[] = [];
  #missed = new Map<string, { question: Question; after: number }>();
  #presumed = new Map<string, { question: Question; row?: Row; at: number }>();
  #used = new Map<Answer, number>();
  /** What the database may hold of a model beyond what the call knows: every field of its rows, or those named. */
  #stale = new Map<AnyModel, Set<string> | true>();
  /** The models the call wrote a row of, and the junctions it wrote a link of. */
  #touched = new Set<AnyModel | string>();
  #again = false;
  #made = 0;
  /** The call's unit is handed over: what the call hears of it comes too late to stop it. */
  #handed = false;
  constructor(operation: SqlOperationContext, transport: Transport) {
    this.operation = operation;
    this.writer = new Writer(operation);
    this.sink = writeSinks.get(operation.attribution);
    this.#transport = transport;
  }
  /** Runs the verbs until they ran on an image that could answer them. */
  async #settle<T>(work: () => () => T): Promise<() => T> {
    for (;;) {
      this.#meta = new WeakMap();
      this.#known = new Map();
      this.#log = [];
      this.#missed = new Map();
      this.#presumed = new Map();
      this.#used = new Map();
      this.#stale = new Map();
      this.#touched = new Set();
      this.#again = false;
      this.#made = 0;
      let answer: (() => T) | undefined;
      let refused: { error: unknown } | undefined;
      try {
        answer = work();
      } catch (error) {
        refused = { error };
      }
      // What a run refuses on an image that could not answer it says nothing.
      if (this.#again) continue;
      if (this.#missed.size > 0) await this.#learn();
      else if (refused) throw refused.error;
      else return answer!;
    }
  }
  /**
   * Runs the verbs, then sends what they wrote. `work` answers how the
   * call's answer is read once its writes are sent.
   */
  async run<T>(work: () => () => T): Promise<T> {
    for (let races = 0; ; ) {
      try {
        const answer = await this.#settle(work);
        await this.#deliver(this.#steps(this.#log.length), true);
        return answer();
      } catch (error) {
        if (!(error instanceof Stopped)) throw error;
        const { stops, believed, model } = error.statement;
        // The call may not leave the row it would write, a row that must be
        // there is not, or what it wrote before cannot be taken back.
        if (!believed || this.#delivered > 0)
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
        this.#asserted.clear();
        this.#sent = 0;
      }
    }
  }
  /** Runs the verbs, and hands their unit over instead of sending it. */
  async prepare<T>(work: () => () => T) {
    this.#handed = true;
    const answer = await this.#settle(work);
    const written: { statements: Statement[]; step: Step }[] = [];
    try {
      for (const step of this.#steps(this.#log.length))
        written.push({ statements: await step.write(), step });
    } catch (error) {
      // None of its statements may wait for what the database says.
      throw error === UNHEARD ? SEVERAL : error;
    }
    return {
      statements: written.flatMap((entry) => entry.statements),
      answer: (sent: readonly Sent[]) => {
        let at = 0;
        for (const { statements, step } of written) {
          step.take?.(sent.slice(at, at + statements.length));
          at += statements.length;
        }
        return answer();
      },
    };
  }
  /**
   * One unit of reads: the questions the last run could not answer, the
   * first of them. Those asked of what the call wrote are read once what it
   * noted before them is sent.
   */
  async #learn(): Promise<void> {
    const after = Math.min(
      ...[...this.#missed.values()].map((missed) => missed.after)
    );
    const steps = after > this.#sent ? this.#steps(after) : [];
    // Questions that each name one row of a model, sought the same way, are one statement.
    const groups = new Map<string, [string, Question][]>();
    const pins = (question: Question) =>
      question.unique && !(question.member || question.limit)
        ? this.writer.selector(question).uniqueValues
        : undefined;
    const group = (question: Question) =>
      pins(question) &&
      JSON.stringify([
        question.model["~"].names.ts,
        question.through?.name,
        question.intent,
        question.writes,
      ]);
    for (const [id, { question, after: asked }] of this.#missed) {
      if (asked !== after) continue;
      const key = group(question) || id;
      groups.set(key, [...(groups.get(key) ?? []), [id, question]]);
    }
    // A row taken to be there is read with them rather than asked for after.
    for (const [id, { question, row }] of this.#presumed) {
      const together = row && groups.get(group(question) || "");
      if (together) together.push([id, question]);
    }
    for (const asked of groups.values()) {
      const [[, first]] = asked as [[string, Question]];
      let query: Query;
      steps.push({
        // Asked of the row it is asked of as the database has said it by then.
        write: () => {
          query = this.writer.read(
            asked.map(([, { member, ...question }]) => ({
              ...question,
              member: member && { ...member, of: this.#said(member.of) },
            })),
            this.#transport.holds
          );
          return [{ sql: query.sql, model: first.model }];
        },
        take: ([sent]) => {
          const rows = this.operation.queries.decodeQuery(
            query,
            sent!.rows,
            true
          ) as Input[];
          for (const [id, question] of asked)
            this.#answers.set(id, {
              question,
              rows:
                asked.length === 1
                  ? rows
                  : rows.filter((row) =>
                      [...pins(question)!].every(
                        ([field, value]) => String(row[field]) === String(value)
                      )
                    ),
            });
        },
      });
    }
    await this.#deliver(steps, false);
    this.#delivered = this.#sent;
  }
  #name(model: AnyModel, values: Input): string {
    return `${model["~"].names.ts}:${this.operation.schema
      .keys(model)
      .map((field) => String(values[field]))
      .join("|")}`;
  }
  /** A row's key as it stands now. */
  #key(row: Row): Input {
    return this.operation.schema.identity(this.#meta.get(row)!.model, row);
  }
  /** Values as a statement takes them: what the database decides must have been heard. */
  #said(values: Input): Input {
    const heard: Input = {};
    for (const [field, value] of Object.entries(values)) {
      const said = value instanceof Pending ? value.row[value.field] : value;
      if (said instanceof Pending) throw UNHEARD;
      if (said !== undefined) heard[field] = said;
    }
    return heard;
  }
  /** The one handle of a row, by its key. */
  #intern(model: AnyModel, values: Input, question?: Question): Row {
    const name = this.#name(model, values);
    let row = this.#known.get(name);
    if (!row) {
      row = { ...values };
      this.#known.set(name, row);
      this.#meta.set(row, { model, question, wrote: new Set() });
    }
    return row;
  }
  /**
   * Whether a row the call knows answers a question now: `undefined` where
   * only the database can say. `was` says whether it answered before the
   * call wrote it, where that is known.
   */
  #holds(
    row: Row,
    question: Question,
    was: boolean | undefined
  ): boolean | undefined {
    const meta = this.#meta.get(row)!;
    if (meta.gone) return false;
    const { member } = question;
    const selector = this.writer.selector(question);
    const { facts } = selector;
    const same = (a: unknown, b: unknown) => String(a) === String(b);
    const name = this.#name(meta.model, row);
    if (question.except?.some((key) => this.#name(meta.model, key) === name))
      return false;
    if (member?.edge.kind === "reference")
      for (const pair of member.edge.pairs) {
        if (!(pair.target in row && pair.source in member.of)) return undefined;
        if (!same(row[pair.target], member.of[pair.source])) return false;
      }
    else if (member) {
      const linked = this.#linked(member.edge as Junction, member.of, row);
      if (linked === false) return false;
      if (linked === undefined && !was) return was && undefined;
    }
    for (const [field, value] of facts.equals) {
      if (row[field] instanceof Pending) return undefined;
      if (field in row && !same(row[field], value)) return false;
    }
    // Stated in full by what the call knows of the row.
    if (
      facts.exact &&
      !selector.scoped &&
      [...facts.equals.keys()].every((field) => field in row)
    )
      return true;
    // What the call wrote of it changes nothing the question reads: it answers as it did.
    if (
      was &&
      !meta.made &&
      facts.reads.length === 0 &&
      ![...meta.wrote].some((field) => facts.fields.has(field))
    )
      return true;
    return undefined;
  }
  /** Whether the call itself linked or unlinked two rows through a junction: `undefined` where it did neither. */
  #linked(edge: Junction, from: Row, to: Row): boolean | undefined {
    let linked: boolean | undefined;
    for (const entry of this.#log) {
      if (!(entry.kind === "link" || entry.kind === "unlink")) continue;
      if (entry.edge.table !== edge.table) continue;
      const [a, b] =
        entry.edge.source === edge.source ? [from, to] : [to, from];
      if (entry.from !== a) continue;
      if (entry.kind === "link" && entry.to === b) linked = true;
      if (
        entry.kind === "unlink" &&
        (entry.to === b || !(entry.to || entry.kept.includes(b)))
      )
        linked = false;
    }
    return linked;
  }
  /**
   * A question that names one row by its key, of a row that must be there,
   * is not asked: the row is taken to be there, with nothing known of it but
   * its key, and the unit that writes asks first. A run that reads more of
   * the row has the question asked for real.
   */
  #presume(id: string, question: Question): Row[] | undefined {
    const { schema } = this.operation;
    const { model } = question;
    const pins = this.writer.selector(question).uniqueValues;
    const keys = schema.keys(model);
    if (
      !(question.must && question.unique && pins) ||
      this.#concrete.has(id) ||
      !keys.every((field) => pins.has(field))
    )
      return undefined;
    const key = Object.fromEntries(
      keys.map((field) => [field, pins.get(field)])
    );
    const name = this.#name(model, key);
    let row = this.#known.get(name);
    if (!row) {
      const fields = schema.storedFields(model);
      const held: Row = { ...key };
      const partial: Row = new Proxy(held, {
        get: (target, field) => {
          if (
            typeof field === "string" &&
            fields.includes(field) &&
            !(field in target) &&
            this.#meta.get(partial)?.partial
          ) {
            this.#concrete.add(id);
            this.#again = true;
          }
          return target[field as string];
        },
      });
      row = partial;
      this.#known.set(name, row);
      this.#meta.set(row, {
        model,
        question,
        partial: true,
        wrote: new Set(),
      });
    }
    this.#presumed.set(id, { question, row, at: this.#log.length });
    return [row];
  }
  /**
   * A question that names one row by values no other row has, of a row the
   * call knows by them: answered by what the call knows, where that says.
   * Where it does not say of a row the call wrote, only the database can,
   * once that is written: `true`.
   */
  #recalled(question: Question): Row[] | boolean {
    const pins = this.writer.selector(question).uniqueValues;
    if (!(question.unique && pins)) return false;
    for (const row of this.#known.values()) {
      if (
        this.#meta.get(row)!.model !== question.model ||
        ![...pins].every(
          ([field, value]) =>
            field in row && String(row[field]) === String(value)
        )
      )
        continue;
      const answers = this.#holds(row, question, undefined);
      if (answers === undefined) return this.#changed(row);
      return answers ? [row] : [];
    }
    return false;
  }
  #changed(row: Row): boolean {
    const meta = this.#meta.get(row)!;
    return Boolean(meta.made || meta.gone || meta.wrote.size > 0);
  }
  /** Whether the database may hold, of the rows a question names, what the call does not know. */
  #spoiled(question: Question): boolean {
    const { model, member } = question;
    if (member && this.#meta.get(member.of)?.moved) return true;
    const stale = this.#stale.get(model);
    if (stale === true) return true;
    const { facts } = this.writer.selector(question);
    return (
      (stale !== undefined &&
        (facts.reads.length > 0 ||
          [...stale].some((field) => facts.fields.has(field)) ||
          (member?.edge.kind === "reference" &&
            member.edge.pairs.some((pair) => stale.has(pair.target))))) ||
      // A filter that reads other rows reads what the call wrote of them.
      facts.reads.some((read) =>
        read.path.some(
          (edge) =>
            this.#touched.has(edge.target) ||
            this.#stale.has(edge.target) ||
            (edge.kind === "junction" && this.#touched.has(edge.table))
        )
      )
    );
  }
  /** The database may hold what the call does not know of `model`: of `fields`, or of its rows whole. */
  #spoil(model: AnyModel, fields?: Iterable<string>): void {
    const stale = this.#stale.get(model);
    if (stale === true) return;
    if (!fields) this.#stale.set(model, true);
    else if (stale) for (const field of fields) stale.add(field);
    else this.#stale.set(model, new Set(fields));
  }
  /** The rows a question names. */
  rows(question: Question): Row[] {
    this.writable(question);
    return this.#rows(question, this.#spoiled(question));
  }
  #rows(question: Question, late: boolean): Row[] {
    const { model, member } = question;
    const fresh = member && this.#meta.get(member.of)?.made;
    // What makes a row a member is read of the row it is a member of.
    if (member?.edge.kind === "reference" && !fresh)
      for (const pair of member.edge.pairs)
        if (member.of[pair.source] === undefined) return [];
    const after = late ? this.#log.length : 0;
    const id = JSON.stringify(
      [
        model["~"].names.ts,
        question.where,
        question.unique,
        member && [
          member.edge.name,
          this.#name(member.edge.source, member.of),
          // What makes a row a member, where the row it is a member of holds it.
          member.edge.kind === "reference" &&
            member.edge.pairs.map((pair) => String(member.of[pair.source])),
        ],
        question.intent,
        question.writes,
        question.through?.name,
        question.limit,
        question.except?.map((key) => this.#name(model, key)),
        after,
      ],
      (_, value) => (typeof value === "bigint" ? `${value}n` : value)
    );
    // The members of a row the call creates are the rows it made members itself.
    const answer =
      fresh && !late ? { question, rows: [] } : this.#answers.get(id);
    if (!answer) {
      const recalled = !late && this.#recalled(question);
      if (recalled === true) return this.#rows(question, true);
      const known = recalled || (!late && this.#presume(id, question));
      if (known) return known;
      // Asked of the row as it stands now, whatever the call writes of it next.
      this.#missed.set(id, {
        question: member
          ? {
              ...question,
              member: {
                ...member,
                of: Object.fromEntries(
                  (member.edge.kind === "reference"
                    ? member.edge.pairs.map((pair) => pair.source)
                    : this.operation.schema.keys(member.edge.source)
                  ).map((field) => [field, member.of[field]])
                ),
              },
            }
          : question,
        after,
      });
      return [];
    }
    if (!(fresh || this.#used.has(answer)))
      this.#used.set(answer, this.#log.length);
    const read = new Set(
      answer.rows.map((values) => {
        const row = this.#intern(model, values, question);
        const meta = this.#meta.get(row)!;
        // A row taken to be there, now read: what the call wrote of it stands.
        if (meta.partial) {
          Object.assign(row, { ...values, ...row });
          meta.partial = undefined;
        }
        // As the database says it, once what the call wrote is sent.
        if (late) Object.assign(row, values);
        return row;
      })
    );
    const rows = [...read];
    if (late) return rows;
    // What the call wrote since may answer now, or no longer.
    for (const row of this.#known.values()) {
      const meta = this.#meta.get(row)!;
      if (meta.model !== model) continue;
      const linked =
        member?.edge.kind === "junction" &&
        this.#linked(member.edge, member.of, row) !== undefined;
      if (!(this.#changed(row) || linked)) continue;
      const answers = this.#holds(row, question, read.has(row));
      // Only the database can say: once what the call noted is sent.
      if (answers === undefined) return this.#rows(question, true);
      if (answers && !read.has(row)) rows.push(row);
      if (!answers && read.has(row)) rows.splice(rows.indexOf(row), 1);
    }
    return rows;
  }
  /** The one row a question names, which must be there. */
  one(question: Question): Row {
    const missed = this.#missed.size;
    const [row] = this.rows({ ...question, must: true });
    // A question not answered yet says nothing: the verbs go on, on a row of which nothing is known.
    if (!row && this.#missed.size > missed) {
      const unknown: Row = {};
      this.#meta.set(unknown, {
        model: question.model,
        question,
        wrote: new Set(),
      });
      return unknown;
    }
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
  /** Notes a write, told what the database said of it where a run before this one sent it. */
  #note(entry: Entry): void {
    if ("row" in entry && entry.kind !== "either")
      this.#touched.add(this.#meta.get(entry.row)!.model);
    else if ("edge" in entry) this.#touched.add(entry.edge.table);
    const heard = this.#heard.get(this.#log.push(entry) - 1);
    if (heard) entry.take?.(heard);
  }
  /** A row created: what was admitted of what the caller wrote of it, and what it is given to be a member. */
  insert(
    model: AnyModel,
    admitted: Input,
    raw?: Input,
    relation?: string
  ): Row {
    const row: Row = this.values(model, "create", admitted, raw);
    // A key the database decides is known once the row's statement is heard.
    const decided = this.operation.schema
      .keys(model)
      .filter((field) => row[field] === undefined);
    for (const field of decided)
      row[field] = new Pending(row, field, `@${++this.#made}`);
    // A row created under a key another has is the database's to refuse.
    const name = this.#name(model, row);
    if (!this.#known.has(name)) this.#known.set(name, row);
    this.#meta.set(row, { model, made: true, wrote: new Set() });
    this.#note({
      kind: "insert",
      row,
      relation,
      decided,
      take: ([sent]) => {
        const [said] = this.writer.keys(model, sent!.rows);
        for (const field of decided)
          if (row[field] instanceof Pending)
            row[field] = said?.[field] ?? sent!.insertId;
      },
    });
    if (relation !== undefined) this.#seen(row, "create");
    return row;
  }
  /**
   * A row the call writes through a relation is shown to what asked to see
   * such rows: read whole where the call's writes stand when this is said.
   */
  #seen(row: Row, kind: WriteKind): void {
    const { model } = this.#meta.get(row)!;
    const name = model["~"].names.ts!;
    if (!this.sink?.wants(name, kind)) return;
    const q = this.operation.queries;
    const projection = q.prepareProjection(model, {});
    this.read(row, projection, (rows) =>
      this.sink!.wrote(name, kind, q.decodeProjection(projection.shape, rows))
    );
  }
  /** The question a write of one row the call knows is written under: what found it, and what the write is. */
  #writing(row: Row, write: Partial<Question>): Question {
    const { model, question } = this.#meta.get(row)!;
    return {
      model,
      member: question?.member,
      through: question?.through,
      verb: question?.verb,
      ...write,
    };
  }
  /** The rows of other models the database changes with a row of `model` are its to say. */
  #cascades(model: AnyModel): void {
    for (const other of dependentsOf(this.operation.schema, model))
      this.#spoil(other);
  }
  /**
   * The rows the call knows that reference `row` by what it held `before`
   * hold what it holds now, where the database makes them follow: and so do
   * the rows that reference those.
   */
  #follow(row: Row, before: Row): void {
    const { schema } = this.operation;
    const { model } = this.#meta.get(row)!;
    for (const name of model["~"].relationNames) {
      if ("members" in schema.index.get(model)!.get(name)!.edge) continue;
      const edge = schema.membership(model, name);
      if (
        edge.kind !== "reference" ||
        edge.owner !== "target" ||
        edge.reference?.onUpdate !== "cascade" ||
        edge.pairs.every((pair) => before[pair.source] === row[pair.source])
      )
        continue;
      for (const child of [...this.#known.values()]) {
        const meta = this.#meta.get(child)!;
        if (
          meta.model !== edge.target ||
          !edge.pairs.every(
            (pair) =>
              Object.hasOwn(child, pair.target) &&
              String(child[pair.target]) === String(before[pair.source])
          )
        )
          continue;
        const was = { ...child };
        for (const pair of edge.pairs) {
          child[pair.target] = row[pair.source];
          meta.wrote.add(pair.target);
        }
        if (schema.keys(meta.model).some((key) => was[key] !== child[key])) {
          this.#known.set(this.#name(meta.model, child), child);
          meta.moved = true;
        }
        this.#follow(child, was);
      }
    }
  }
  /**
   * A row takes `set`: `writes` says what the caller wrote of it, `joined` the
   * relation it is made a member of, or leaves, by this write.
   */
  update(
    row: Row,
    set: Input,
    writes?: readonly string[],
    joined?: Membership,
    removes = false
  ): void {
    if (Object.keys(set).length === 0) return;
    const meta = this.#meta.get(row)!;
    const { model } = meta;
    const key = this.#key(row);
    const keys = this.operation.schema.keys(model);
    const hears: string[] = [];
    const before = { ...row };
    for (const [field, value] of Object.entries(set)) {
      const update =
        value instanceof Pending
          ? { kind: "value" as const, value }
          : readUpdate(value);
      meta.wrote.add(field);
      if (update.kind === "value") row[field] = update.value;
      // What the database computes of a row is its to say.
      else if (meta.made) outside();
      else {
        row[field] = new Pending(row, field, `@${++this.#made}`);
        if (keys.includes(field)) hears.push(field);
      }
    }
    // A row is known by the key it has now.
    if (keys.some((field) => field in set)) {
      this.#known.set(this.#name(model, row), row);
      meta.moved = true;
      this.#cascades(model);
    }
    this.#follow(row, before);
    // A row the call creates is inserted as it stands in the end.
    if (meta.made) return;
    this.#note({
      kind: "update",
      row,
      key,
      set,
      hears,
      question: this.#writing(
        row,
        joined
          ? { intent: "join", through: joined }
          : removes
            ? { intent: "delete" }
            : { intent: "update", writes }
      ),
      take: ([sent]) => {
        if (hears.length === 0) return;
        const [said] = this.writer.keys(model, sent!.rows);
        for (const field of hears) row[field] = said?.[field];
      },
    });
    if (meta.question?.verb && !removes) this.#seen(row, "update");
  }
  /** A row is removed: marked, where its model keeps the rows it deletes. */
  delete(row: Row): void {
    const meta = this.#meta.get(row)!;
    const { model, question } = meta;
    const marks = this.writer.marks(model);
    // As it was before it goes.
    if (question?.verb) this.#seen(row, "delete");
    if (marks) {
      // A kept row leaves the rows that reference it in place: where the database would have refused its removal, the mark is refused too.
      const stops = this.writer.restriction(model);
      const through = question?.member;
      // The link the row is reached through is kept, and restricts nothing.
      const slot =
        through?.edge.kind === "junction" &&
        linkJudgement(through.edge)?.writes.at(-1);
      if (stops)
        this.none(
          {
            model,
            where: this.#key(row),
            unique: true,
            referenced: slot
              ? { slot, identity: this.#key(through!.of) }
              : true,
          },
          stops
        );
      this.update(row, marks, undefined, undefined, true);
      meta.gone = true;
      return;
    }
    meta.gone = true;
    const made = this.#log.findIndex(
      (entry) => entry.kind === "insert" && entry.row === row
    );
    // A row the call created and has not sent is not created.
    if (made >= this.#sent) {
      this.#log.splice(made, 1);
      return;
    }
    this.#note({
      kind: "delete",
      row,
      key: this.#key(row),
      question: this.#writing(row, { intent: "delete" }),
    });
    this.#cascades(meta.model);
  }
  /** Every row a question names takes `set`, or is removed where there is none: the call does not need to know them. */
  all(question: Question, set?: Input, projection?: PreparedProjection): Later {
    const { model } = question;
    const marks = set ? undefined : this.writer.marks(model);
    if (marks) {
      const stops = this.writer.restriction(model);
      if (stops) this.none({ ...question, referenced: true }, stops);
      return this.all(question, marks, projection);
    }
    const later: Later = {};
    // Where no statement both writes rows and answers with them so, they are read, then written by their keys.
    if (
      (question.verb &&
        this.sink?.wants(model["~"].names.ts!, set ? "update" : "delete")) ||
      (projection &&
        !this.operation.answersInStatement(
          model,
          projection,
          set ? "update" : "delete",
          set
        ))
    ) {
      const rows = this.rows(question);
      const take = (read: Input[]) => {
        later.sent = { rows: read, rowCount: read.length };
      };
      const answer = () =>
        projection
          ? this.series(model, rows, projection, "updateMany", take)
          : take(rows);
      if (!set) answer();
      for (const row of rows)
        if (set) this.update(row, set, question.writes);
        else this.delete(row);
      if (set) answer();
      return later;
    }
    this.writable(question);
    // A row that must be there is asked for where what the write says of it comes too late.
    if (question.must && this.#handed)
      this.#presumed.set(`all:${this.#log.length}`, {
        question,
        row: undefined,
        at: this.#log.length,
      });
    this.#note({
      kind: "all",
      question,
      set,
      projection,
      take: ([sent]) => {
        later.sent = sent;
      },
    });
    this.#spoil(model, set && Object.keys(set));
    if (!set) this.#cascades(model);
    return later;
  }
  /**
   * The row a question names takes `set`; where there is none, a row is
   * created of what was `admitted`. None where no one statement says so.
   */
  either(
    question: Question,
    admitted: Input,
    raw: Input,
    set: Input,
    projection: PreparedProjection
  ): Later | undefined {
    const { model } = question;
    const q = this.operation.queries;
    const { capabilities } = this.operation.driver.adapter;
    const selector = this.writer.selector(question);
    const pins = selector.uniqueValues;
    const row = this.values(model, "create", admitted, raw);
    const fields = Object.keys(set);
    if (
      !(
        capabilities.supportsTargetedUpsert &&
        capabilities.supportsReturning &&
        selector.uniqueKey &&
        pins
      ) ||
      selector.scoped ||
      this.sink ||
      q.domain?.produced(model) ||
      fields.length === 0 ||
      this.operation.schema.keys(model).some((key) => key in set) ||
      // The row created is the one the question would name.
      !selector.uniqueKey.fields.every(
        (field) =>
          (row[field] === null || typeof row[field] !== "object") &&
          Object.is(row[field], pins.get(field))
      ) ||
      !fields.every((field) => q.namesUpdate(model, field, set[field])) ||
      !this.operation.answersInStatement(model, projection, "update", set)
    )
      return undefined;
    const later: Later = {};
    this.#note({
      kind: "either",
      question,
      row,
      set,
      projection,
      take: ([sent]) => {
        later.sent = sent;
      },
    });
    this.#spoil(model);
    return later;
  }
  /** `to` is made a member of `from`'s through a junction. */
  link(edge: Junction, from: Row, to: Row): void {
    this.#note({
      kind: "link",
      edge,
      from,
      to,
      keys: [this.#key(from), this.#key(to)],
    });
  }
  /** `from`'s links through a junction go: the one to `to`, or every one but those to the rows `kept`. */
  unlink(edge: Junction, from: Row, to?: Row, kept: readonly Row[] = []): void {
    this.#note({
      kind: "unlink",
      edge,
      from,
      to,
      kept,
      keys: [
        this.#key(from),
        to && this.#key(to),
        kept.map((row) => this.#key(row)),
      ],
    });
  }
  /** Of a strict question, no row the call may see may be one it may not write so, when its writes reach here. */
  writable(question: Question): void {
    if (question.strict && this.writer.judges(question))
      this.#note({ kind: "none", question });
  }
  /** No row may answer the question when the call's writes reach here: `stops` refuses it. */
  none(question: Question, stops: PreparedGuardFailure): void {
    this.#note({ kind: "none", question, stops });
  }
  /** A row read as `projection` says, where the call's writes stand when this is asked. */
  read(
    row: Row,
    projection: PreparedProjection,
    take: (rows: Input[]) => void
  ): void {
    const { model } = this.#meta.get(row)!;
    this.#note({
      kind: "read",
      model,
      rows: [row],
      projection,
      queries: () => [
        this.writer.one(model, this.#said(this.#key(row)), projection),
      ],
      take: ([sent]) => take(sent!.rows),
    });
  }
  /** Rows read by their keys as `projection` says, in their order, where the call's writes stand when this is asked. */
  series(
    model: AnyModel,
    rows: readonly Row[],
    projection: PreparedProjection,
    kind: "createMany" | "updateMany",
    take: (rows: Input[]) => void
  ): void {
    this.#note({
      kind: "read",
      model,
      rows,
      projection,
      queries: () =>
        this.operation.seriesQueries(
          projection,
          rows.map((row) => this.#said(this.#key(row))),
          kind
        ),
      take: (sent) => take(sent.flatMap((each) => each.rows)),
    });
  }
  /** What one run makes of `make` is what every later run takes: a row's own copy of what the caller wrote. */
  copy<T>(name: string, make: () => T): T {
    if (!this.#copies.has(name)) this.#copies.set(name, make());
    return this.#copies.get(name) as T;
  }
  /**
   * The steps of a unit, up to what was noted before `to`: what the call
   * believed must still hold, then every write not sent yet, in order. Rows
   * written the same way side by side travel in one statement.
   */
  #steps(to: number): Step[] {
    const { writer } = this;
    const { schema } = this.operation;
    const { holds } = this.#transport;
    const steps: Step[] = [];
    const log = this.#log;
    const last = to === log.length;
    /** Where this unit keeps the keys the database decides in it: it cannot hear them and go on. */
    let scratch: { id: string; model: AnyModel } | undefined;
    const span = log.slice(this.#sent, to);
    /** The rows of which other statements need what the database decides, and how many do. */
    const needed = new Map<Row, number>();
    const needs = (...values: (Input | undefined)[]) => {
      const rows = new Set<Row>();
      for (const each of values)
        for (const value of Object.values(each ?? {}))
          if (value instanceof Pending) rows.add(value.row);
      for (const row of rows) needed.set(row, (needed.get(row) ?? 0) + 1);
    };
    let writes = 0;
    for (const entry of span) {
      if (!(entry.kind === "none" || entry.kind === "read")) writes++;
      if (entry.kind === "insert")
        needs(
          Object.fromEntries(
            Object.entries(entry.row).filter(
              ([, value]) => (value as Pending)?.row !== entry.row
            )
          )
        );
      else if (entry.kind === "update") needs(entry.key, entry.set);
      else if (entry.kind === "delete") needs(entry.key);
      else if (entry.kind === "link" || entry.kind === "unlink")
        needs(entry.keys[0], entry.keys[1], ...(entry.keys[2] ?? []));
      else if (entry.kind === "read")
        needs(...entry.rows.map((row) => this.#key(row)));
    }
    // A unit after the first asks again of the rows the call has not written.
    const passed = (row: Row | undefined) =>
      this.#sent > 0 && row && this.#changed(row);
    /** The writes that say themselves whether the row they were taken to find is there. */
    const confirms = new Map<Entry, Question>();
    /** The rows taken to be there that one statement asks for: those sought the same way. */
    const asked = new Map<string, [Question, Input?][]>();
    /** Adds a row to ask for to the statement that asks for those sought the same way. */
    const ask = (
      question: Question,
      own: string,
      believed: "presumed" | "read",
      key?: Input
    ) => {
      const group = JSON.stringify([
        believed,
        question.model["~"].names.ts,
        question.member ? own : question.through?.name,
        question.verb,
        question.intent,
        question.writes,
      ]);
      if (!asked.has(group)) {
        const together: [Question, Input?][] = [];
        asked.set(group, together);
        steps.push({ write: () => [writer.asks(together, believed)] });
      }
      asked.get(group)!.push([question, key]);
    };
    for (const [id, { question, row, at }] of this.#presumed) {
      if (at > to || (holds ? this.#asserted.has(id) : passed(row))) continue;
      this.#asserted.add(id);
      // The first write of a row taken to be there says whether it is,
      // where nothing else is written if it is not.
      const first = span.find(
        (entry) =>
          (entry.kind === "update" || entry.kind === "delete") &&
          entry.row === row
      );
      if (first && writer.counts && (holds || !(this.#handed || writes > 1)))
        confirms.set(first, question);
      else ask(question, id, "presumed");
    }
    /**
     * The question a write of rows by their keys is written under: rows the
     * call found were found members; a row it took to be there is still to
     * be one.
     */
    const under = (entry: Extract<Entry, { kind: "update" | "delete" }>) => ({
      ...entry.question,
      member: confirms.get(entry)?.member,
      through: entry.question.member?.edge ?? entry.question.through,
    });
    /** Whether two writes of rows by their keys may be one statement: rows found, or rows taken to be members of the same row. */
    const mates = (entry: Entry, next: Entry) => {
      const [a, b] = [confirms.get(entry)?.member, confirms.get(next)?.member];
      return (
        confirms.has(entry) === confirms.has(next) &&
        a?.of === b?.of &&
        a?.edge === b?.edge &&
        !own.has(next)
      );
    };
    /** Refuses where a write that says whether its rows are there found fewer. */
    const sizes = new Map<Entry, number>();
    const confirmed = (entry: Entry, sent: Sent) => {
      const question = confirms.get(entry);
      if (question && writer.count(sent) < (sizes.get(entry) ?? 1))
        throw createFailureError(
          writer.absent(question),
          question.model["~"].names.ts!,
          this.operation.operation
        );
    };
    /**
     * The reads of one row its own write answers: the write just before it,
     * or an earlier one where the read asks only what the row itself holds
     * and nothing noted between them can change the row.
     */
    const own = new Map<
      Entry,
      { read: Extract<Entry, { kind: "read" }>; place: number }
    >();
    const told = new Set<Entry>();
    for (let place = this.#sent; place < to; place++) {
      const read = log[place]!;
      if (!(read.kind === "read" && read.projection && read.rows.length === 1))
        continue;
      const [row] = read.rows;
      const { model } = read;
      for (let at = place - 1; at >= this.#sent; at--) {
        const entry = log[at]!;
        if (
          (entry.kind === "insert" || entry.kind === "update") &&
          entry.row === row
        ) {
          if (
            !own.has(entry) &&
            (at === place - 1 || returningSafeProjection(read.projection)) &&
            (entry.kind === "insert" || entry.hears.length === 0) &&
            this.operation.answersInStatement(
              model,
              read.projection,
              entry.kind,
              entry.kind === "update" ? entry.set : undefined
            )
          ) {
            own.set(entry, { read, place });
            told.add(read);
          }
          break;
        }
        // What may change the row between its write and its read.
        const touched =
          entry.kind === "all" || entry.kind === "either"
            ? entry.question.model
            : entry.kind === "delete" || entry.kind === "update"
              ? this.#meta.get(entry.row)!.model
              : undefined;
        if (
          touched === model ||
          (touched && dependentsOf(schema, touched).has(model))
        )
          break;
      }
    }
    /** The read of rows that follows `at`, where the statement that writes those rows may answer it. */
    const answered = (
      at: number,
      rows: readonly Row[],
      effect: "insert" | "update" | "delete",
      written?: Input
    ) => {
      const next = log[at];
      return at < to &&
        next?.kind === "read" &&
        next.projection &&
        next.rows.length === rows.length &&
        next.rows.every((row, place) => row === rows[place]) &&
        this.operation.answersInStatement(
          next.model,
          next.projection,
          effect,
          written
        )
        ? next
        : undefined;
    };
    if (!holds)
      for (const [answer, at] of this.#used)
        for (const values of at > to ? [] : answer.rows) {
          const { model } = answer.question;
          if (passed(this.#known.get(this.#name(model, values)))) continue;
          ask(
            answer.question,
            JSON.stringify(answer.question.where),
            "read",
            schema.identity(model, values)
          );
        }
    for (let at = this.#sent; at < to; at++) {
      const entry = log[at]!;
      const place = at;
      /** The entries that follow `entry` and travel with it. */
      const beside = <T extends Entry>(same: (next: T) => boolean): T[] => {
        const run = [entry as T];
        while (at + 1 < to && same(log[at + 1] as T)) run.push(log[++at] as T);
        return run;
      };
      const take = (sent: Sent[], queries?: Query[]) => {
        this.#heard.set(place, sent);
        confirmed(entry, sent[0]!);
        entry.take?.(sent, queries);
      };
      /** Tells the read a write answered what the write said. */
      const tells =
        (read: Entry | undefined, from: number) => (sent: Sent[]) => {
          this.#heard.set(from, sent);
          confirmed(entry, sent[0]!);
          read?.take?.(sent);
        };
      if (entry.kind === "insert") {
        const { model } = this.#meta.get(entry.row)!;
        const { decided } = entry;
        const settled = (row: Row) =>
          Object.fromEntries(
            Object.entries(row).filter(
              ([, value]) =>
                value !== undefined &&
                !(value instanceof Pending && value.row === row)
            )
          );
        const fits = (rows: Row[], next: Entry | undefined) =>
          next?.kind === "insert" &&
          this.#meta.get(next.row)!.model === model &&
          next.relation === entry.relation &&
          writer.beside(model, rows.map(settled), settled(next.row));
        let rows = [entry.row];
        const mine = own.get(entry);
        // The rows written side by side that the read after them asks for, and nothing else of what the database decides of them: their statement answers it.
        let end = at + 1;
        while (!mine && end < to && fits(rows, log[end]))
          rows.push((log[end++] as typeof entry).row);
        let read = mine?.read ?? answered(end, rows, "insert");
        // Another statement needs what the database decides of the row: its statement says it beside the answer, where it can.
        const both = Boolean(mine) && (needed.get(entry.row) ?? 0) > 1;
        if (
          mine &&
          both &&
          !(holds && returningSafeProjection(mine.read.projection!))
        ) {
          told.delete(mine.read);
          read = undefined;
        } else if (mine) rows = [entry.row];
        else if (read && !rows.some((row) => (needed.get(row) ?? 0) > 1))
          at = end;
        else {
          read = undefined;
          rows = [entry.row];
          // A row of which the database decides what another statement needs is written alone: its statement says it.
          beside<typeof entry>((next) => {
            const joins =
              fits(rows, next) &&
              !(needed.has(entry.row) || needed.has(next.row) || own.has(next));
            if (joins) rows.push(next.row);
            return joins;
          });
        }
        const hears = (both || !read) && needed.has(entry.row);
        if (hears && last && !holds)
          scratch ??= { id: crypto.randomUUID(), model };
        steps.push({
          write: async () => {
            const insert = (returns?: PreparedProjection) =>
              writer.insert(
                model,
                rows.map((row) => this.#said(settled(row))),
                entry.relation,
                returns,
                Boolean(read) && hears
              );
            const kept =
              scratch &&
              hears &&
              !read &&
              writer.kept(scratch.id, `${place}`, decided, await insert());
            if (!kept)
              return [
                await insert(
                  read?.projection ?? (hears ? writer.key(model) : undefined)
                ),
              ];
            entry.row[decided[0]!] = kept.value;
            return kept.statements;
          },
          take: (sent) => {
            if (hears) take(sent);
            if (read) tells(read, mine?.place ?? at)(sent);
          },
        });
      } else if (entry.kind === "update") {
        const { model } = entry.question;
        const { hears } = entry;
        const fields = Object.keys(entry.set);
        const run = beside<Extract<Entry, { kind: "update" }>>(
          (next) =>
            next.kind === "update" &&
            next.question.model === model &&
            // Rows that take the same values, written the same way.
            Object.keys(next.set).length === fields.length &&
            fields.every((field) =>
              Object.is(next.set[field], entry.set[field])
            ) &&
            next.question.intent === entry.question.intent &&
            next.question.through === entry.question.through &&
            next.question.verb === entry.question.verb &&
            hears.length === 0 &&
            mates(entry, next)
        );
        sizes.set(entry, run.length);
        const mine = run.length === 1 ? own.get(entry) : undefined;
        if (!mine && own.has(entry)) told.delete(own.get(entry)!.read);
        const read = mine?.read;
        steps.push({
          write: async () => [
            await writer.update(
              under(entry),
              this.#said(entry.set),
              run.map((next) => this.#said(next.key)),
              read?.projection ??
                (hears.length > 0 ? writer.key(model) : undefined),
              confirms.has(entry)
            ),
          ],
          take: read ? tells(read, mine!.place) : take,
        });
      } else if (entry.kind === "delete") {
        const { model } = entry.question;
        const run = beside<Extract<Entry, { kind: "delete" }>>(
          (next) =>
            next.kind === "delete" &&
            next.question.model === model &&
            mates(entry, next)
        );
        sizes.set(entry, run.length);
        steps.push({
          write: () => [
            writer.remove(
              under(entry),
              run.map((next) => this.#said(next.key)),
              undefined,
              confirms.has(entry)
            ),
          ],
          take,
        });
      } else if (entry.kind === "all")
        steps.push({
          write: async () => [
            entry.set
              ? await writer.update(
                  entry.question,
                  this.#said(entry.set),
                  undefined,
                  entry.projection
                )
              : writer.remove(entry.question, undefined, entry.projection),
          ],
          take,
        });
      else if (entry.kind === "either")
        steps.push({
          write: async () => [
            await writer.either(
              entry.question,
              this.#said(entry.row),
              this.#said(entry.set),
              entry.projection
            ),
          ],
          take,
        });
      else if (entry.kind === "link") {
        const run = beside<Extract<Entry, { kind: "link" }>>(
          (next) => next.kind === "link" && next.edge === entry.edge
        );
        steps.push({
          write: () =>
            writer.link(
              entry.edge,
              run.map(
                (next) =>
                  [this.#said(next.keys[0]), this.#said(next.keys[1])] as const
              )
            ),
        });
      } else if (entry.kind === "unlink")
        steps.push({
          write: () => [
            writer.unlink(
              entry.edge,
              this.#said(entry.keys[0]),
              entry.keys[1] && this.#said(entry.keys[1]),
              entry.keys[2].map((key) => this.#said(key))
            ),
          ],
        });
      else if (entry.kind === "none")
        steps.push({
          write: () => [writer.none(entry.question, entry.stops)],
        });
      else if (!told.has(entry)) {
        // A row read as it goes is answered by the statement that removes it.
        const removal = log[at + 1];
        if (
          at + 1 < to &&
          removal?.kind === "delete" &&
          answered(at, [removal.row], "delete")
        ) {
          at++;
          steps.push({
            write: () => [
              writer.remove(
                under(removal),
                [this.#said(removal.key)],
                entry.projection
              ),
            ],
            take: (sent) => {
              confirmed(removal, sent[0]!);
              take(sent);
            },
          });
          continue;
        }
        let queries: Query[];
        steps.push({
          write: () => {
            queries = entry.queries();
            return queries.map((query) => ({
              sql: query.sql,
              model: entry.model,
            }));
          },
          take: (sent) => take(sent, queries),
        });
      }
    }
    if (scratch) {
      const { open, close } = writer.scratch(scratch.id, scratch.model);
      steps.unshift({ write: () => open });
      steps.push({ write: () => [close] });
    }
    this.#sent = Math.max(this.#sent, to);
    return steps;
  }
  /**
   * Sends the steps of a unit. A statement that needs a value the database
   * has not said yet is written once what stands before it is sent and
   * heard.
   */
  async #deliver(steps: Step[], last: boolean): Promise<void> {
    let waiting: { statements: Statement[]; step: Step }[] = [];
    const flush = async (end: boolean) => {
      const statements = waiting.flatMap((written) => written.statements);
      const sent =
        statements.length > 0
          ? await this.#transport.send(statements, end)
          : [];
      let at = 0;
      for (const { statements: own, step } of waiting) {
        step.take?.(sent.slice(at, at + own.length));
        at += own.length;
      }
      waiting = [];
    };
    for (const step of steps) {
      let statements: Statement[];
      try {
        statements = await step.write();
      } catch (error) {
        if (error !== UNHEARD) throw error;
        await flush(false);
        statements = await step.write();
      }
      waiting.push({ statements, step });
    }
    await flush(last);
  }
}
