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
import {
  type PreparedProjection,
  type Query,
  readUpdate,
} from "../shared/query";
import type { EngineSchema, Input } from "../shared/schema";
import type { SqlOperationContext } from "../shared/sql-operation-context";
import type { Membership } from "../shared/storage";
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
  #presumed = new Map<string, { question: Question; row: Row; at: number }>();
  #used = new Map<Answer, number>();
  /** What the database may hold of a model beyond what the call knows: every field of its rows, or those named. */
  #stale = new Map<AnyModel, Set<string> | true>();
  #again = false;
  #made = 0;
  constructor(operation: SqlOperationContext, transport: Transport) {
    this.operation = operation;
    this.writer = new Writer(operation);
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
    const answer = await this.#settle(work);
    const written: { statements: Statement[]; step: Step }[] = [];
    try {
      for (const step of this.#steps(this.#log.length, false))
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
    for (const [id, { question, after: asked }] of this.#missed) {
      if (asked !== after) continue;
      const query = this.writer.read(question, this.#transport.holds);
      steps.push({
        write: () => [{ sql: query.sql, model: question.model }],
        take: ([sent]) => {
          this.#answers.set(id, {
            question,
            rows: this.operation.queries.decodeQuery(
              query,
              sent!.rows,
              true
            ) as Input[],
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
    if (!stale || stale === true) return Boolean(stale);
    const { facts } = this.writer.selector(question);
    return (
      facts.reads.length > 0 ||
      [...stale].some((field) => facts.fields.has(field)) ||
      (member?.edge.kind === "reference" &&
        member.edge.pairs.some((pair) => stale.has(pair.target)))
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
          ? { ...question, member: { ...member, of: { ...member.of } } }
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
  /** Notes a write, told what the database said of it where a run before this one sent it. */
  #note(entry: Entry): void {
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
    const name = this.#name(model, row);
    if (this.#known.has(name)) outside();
    this.#known.set(name, row);
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
    return row;
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
   * A row takes `set`: `writes` says what the caller wrote of it, `joined` the
   * relation it is made a member of, or leaves, by this write.
   */
  update(
    row: Row,
    set: Input,
    writes?: readonly string[],
    joined?: Membership
  ): void {
    if (Object.keys(set).length === 0) return;
    const meta = this.#meta.get(row)!;
    const { model } = meta;
    const key = this.#key(row);
    const keys = this.operation.schema.keys(model);
    const hears: string[] = [];
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
          : { intent: "update", writes }
      ),
      take: ([sent]) => {
        const [said] = this.writer.keys(model, sent!.rows);
        for (const field of hears) row[field] = said?.[field];
      },
    });
  }
  /** A row is removed. */
  delete(row: Row): void {
    const meta = this.#meta.get(row)!;
    if (this.operation.scope?.rows.tombstones?.has(meta.model["~"].names.ts!))
      outside();
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
    if (
      !set &&
      this.operation.scope?.rows.tombstones?.has(model["~"].names.ts!)
    )
      outside();
    const later: Later = {};
    // Where no statement both writes rows and answers with them so, they are read, then written by their keys.
    if (
      projection &&
      !this.operation.answersInStatement(
        model,
        projection,
        set ? "update" : "delete",
        set
      )
    ) {
      const rows = this.rows(question);
      const take = (read: Input[]) => {
        later.sent = { rows: read, rowCount: read.length };
      };
      if (!set) this.series(model, rows, projection, "updateMany", take);
      for (const row of rows)
        if (set) this.update(row, set, question.writes);
        else this.delete(row);
      if (set) this.series(model, rows, projection, "updateMany", take);
      return later;
    }
    this.writable(question);
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
  #steps(to: number, alone = true): Step[] {
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
      if (first && writer.counts && (holds || (alone && writes === 1)))
        confirms.set(first, question);
      else
        steps.push({
          write: () => [writer.asks(question, undefined, "presumed")],
        });
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
    /** Refuses where a write that says whether its row is there found none. */
    const confirmed = (entry: Entry, sent: Sent) => {
      const question = confirms.get(entry);
      if (question && sent.rowCount === 0 && sent.rows.length === 0)
        throw createFailureError(
          writer.absent(question),
          question.model["~"].names.ts!,
          this.operation.operation
        );
    };
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
          steps.push({
            write: () => [
              writer.asks(
                answer.question,
                schema.identity(model, values),
                "read"
              ),
            ],
          });
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
      const told =
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
        // The rows written side by side that the read after them asks for, and nothing else of what the database decides of them: their statement answers it.
        let end = at + 1;
        while (end < to && fits(rows, log[end]))
          rows.push((log[end++] as typeof entry).row);
        let read = answered(end, rows, "insert");
        if (read && !rows.some((row) => (needed.get(row) ?? 0) > 1)) at = end;
        else {
          read = undefined;
          rows = [entry.row];
          // A row of which the database decides what another statement needs is written alone: its statement says it.
          beside<typeof entry>((next) => {
            const joins =
              fits(rows, next) &&
              !(needed.has(entry.row) || needed.has(next.row));
            if (joins) rows.push(next.row);
            return joins;
          });
        }
        const hears = !read && needed.has(entry.row);
        if (hears && last && !holds)
          scratch ??= { id: crypto.randomUUID(), model };
        steps.push({
          write: async () => {
            const insert = (returns?: PreparedProjection) =>
              writer.insert(
                model,
                rows.map((row) => this.#said(settled(row))),
                entry.relation,
                returns
              );
            const kept =
              scratch &&
              hears &&
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
          take: read ? told(read, at) : hears ? take : undefined,
        });
      } else if (entry.kind === "update") {
        const { model } = entry.question;
        const { hears } = entry;
        const run = beside<Extract<Entry, { kind: "update" }>>(
          (next) =>
            next.kind === "update" &&
            next.set === entry.set &&
            next.question.model === model &&
            hears.length === 0 &&
            !(confirms.has(entry) || confirms.has(next))
        );
        const read =
          run.length === 1 && hears.length === 0
            ? answered(at + 1, [entry.row], "update", entry.set)
            : undefined;
        if (read) at++;
        steps.push({
          write: async () => [
            await writer.update(
              under(entry),
              this.#said(entry.set),
              run.map((next) => this.#said(next.key)),
              read?.projection ??
                (hears.length > 0 ? writer.key(model) : undefined)
            ),
          ],
          take: read ? told(read, place + 1) : take,
        });
      } else if (entry.kind === "delete") {
        const { model } = entry.question;
        const run = beside<Extract<Entry, { kind: "delete" }>>(
          (next) =>
            next.kind === "delete" &&
            next.question.model === model &&
            !(confirms.has(entry) || confirms.has(next))
        );
        steps.push({
          write: () => [
            writer.remove(
              under(entry),
              run.map((next) => this.#said(next.key))
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
      else {
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
      if (statements.length === 0) return;
      const sent = await this.#transport.send(statements, end);
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
