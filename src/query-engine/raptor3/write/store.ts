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
import type { PreparedGuardFailure } from "../../types";
import {
  type PreparedProjection,
  type Query,
  readUpdate,
} from "../shared/query";
import type { Input } from "../shared/schema";
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
  /** The fields the call wrote of it. */
  readonly wrote: Set<string>;
}

/** What a set write says once it is sent. */
export interface Later {
  sent?: Sent;
}

/**
 * A value the database decides, of a row the call created: known once the
 * statement that creates the row is heard.
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

type Entry =
  | { readonly kind: "insert"; readonly row: Row; readonly relation?: string }
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
      readonly later: Later;
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
      readonly queries: () => Query[];
      take(sent: Sent[], queries: Query[]): void;
    };

/** One statement of a unit, written when it is sent, and where its answer is told. */
interface Step {
  write(): Statement[] | Promise<Statement[]>;
  take?(sent: Sent[]): void;
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
      this.#used = new Set();
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
      if (this.#missed.size > 0) await this.#learn();
      else if (this.#again) continue;
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
      const answer = await this.#settle(work);
      try {
        await this.#send();
        return answer();
      } catch (error) {
        if (!(error instanceof Stopped)) throw error;
        const { stops, believed, model } = error.statement;
        // The call may not leave the row it would write, or a row that must be there is not.
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
  /** Runs the verbs, and hands their unit over instead of sending it. */
  async prepare<T>(work: () => () => T) {
    const answer = await this.#settle(work);
    return { unit: await this.#unit(), answer };
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
    return this.#heard(
      this.operation.schema.identity(this.#meta.get(row)!.model, row)
    );
  }
  /** A row's key as it stands now, for a write noted now. */
  #now(row: Row): Input {
    return this.operation.schema.identity(this.#meta.get(row)!.model, row);
  }
  /** Values as a statement takes them: what the database decides must have been heard. */
  #heard(values: Input): Input {
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
   * Whether a row the call wrote answers a question now: `undefined` where
   * only the database can say. `was` says whether it answered before the
   * call wrote it.
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
    if (
      question.except?.some(
        (key) => this.#name(meta.model, key) === this.#name(meta.model, row)
      )
    )
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
   * A question that names one row by its key is not asked: the row is taken
   * to be there, with nothing known of it but its key, and the unit that
   * writes asks first. A run that reads more of the row has the question
   * asked for real.
   */
  #presume(id: string, question: Question): Row[] | undefined {
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
    // What a row the call wrote answers, where the call cannot say, is the database's to say once it is written.
    if (row && this.#changed(row)) return outside();
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
    this.#presumed.set(id, { question, row });
    return [row];
  }
  /**
   * A question that names one row by values no other row has, of a row the
   * call knows by them: answered by what the call knows, where that says.
   */
  #recalled(question: Question): Row[] | undefined {
    const pins = this.writer.selector(question).uniqueValues;
    if (!(question.unique && pins)) return undefined;
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
      return answers === undefined ? undefined : answers ? [row] : [];
    }
    return undefined;
  }
  #changed(row: Row): boolean {
    const meta = this.#meta.get(row)!;
    return Boolean(meta.made || meta.gone || meta.wrote.size > 0);
  }
  /** The rows a question names. */
  rows(question: Question): Row[] {
    const { model, member } = question;
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
      ],
      (_, value) => (typeof value === "bigint" ? `${value}n` : value)
    );
    // The members of a row the call creates are the rows it made members itself.
    const fresh = member && this.#meta.get(member.of)?.made;
    // What makes a row a member is read of the row it is a member of.
    if (member?.edge.kind === "reference" && !fresh)
      for (const pair of member.edge.pairs)
        if (member.of[pair.source] === undefined) return [];
    this.writable(question);
    const answer = fresh ? { question, rows: [] } : this.#answers.get(id);
    if (!answer) {
      const known = this.#recalled(question);
      if (known) return known;
      const presumed = question.must && this.#presume(id, question);
      if (presumed) return presumed;
      // Asked of the row as it stands now, whatever the call writes of it next.
      this.#missed.set(
        id,
        member
          ? { ...question, member: { ...member, of: { ...member.of } } }
          : question
      );
      return [];
    }
    // Rows a set write of the call may have changed are the database's to say.
    if (
      this.#log.some(
        (entry) => entry.kind === "all" && entry.question.model === model
      )
    )
      return outside();
    if (!fresh) this.#used.add(answer);
    const read = new Set(
      answer.rows.map((values) => {
        const row = this.#intern(model, values, question);
        const meta = this.#meta.get(row)!;
        // A row taken to be there, now read: what the call wrote of it stands.
        if (meta.partial) {
          Object.assign(row, { ...values, ...row });
          meta.partial = undefined;
        }
        return row;
      })
    );
    // What the call wrote since may answer now, or no longer.
    const rows = [...read];
    for (const row of this.#known.values()) {
      const meta = this.#meta.get(row)!;
      if (meta.model !== model) continue;
      const linked =
        member?.edge.kind === "junction" &&
        this.#linked(member.edge, member.of, row) !== undefined;
      if (!(this.#changed(row) || linked)) continue;
      const answers = this.#holds(row, question, read.has(row));
      if (answers === undefined) return outside();
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
  /** A row created: what was admitted of what the caller wrote of it, and what it is given to be a member. */
  insert(
    model: AnyModel,
    admitted: Input,
    raw?: Input,
    relation?: string
  ): Row {
    const row: Row = this.values(model, "create", admitted, raw);
    // A key the database decides is known once the row's statement is heard.
    for (const field of this.operation.schema.keys(model))
      if (row[field] === undefined)
        row[field] = new Pending(row, field, `@${++this.#made}`);
    const name = this.#name(model, row);
    if (this.#known.has(name)) outside();
    this.#known.set(name, row);
    this.#meta.set(row, { model, made: true, wrote: new Set() });
    this.#log.push({ kind: "insert", row, relation });
    return row;
  }
  /** The question a write of one row the call knows is written under: what found it, and what the write is. */
  #writing(row: Row, write: Partial<Question>): Question {
    const meta = this.#meta.get(row)!;
    return {
      model: meta.model,
      member: meta.question?.member,
      verb: meta.question?.verb,
      ...write,
    };
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
    const key = this.#now(row);
    const keys = this.operation.schema.keys(meta.model);
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
    if (keys.some((field) => field in set))
      this.#known.set(this.#name(meta.model, row), row);
    // A row the call creates is inserted as it stands in the end.
    if (meta.made) return;
    this.#log.push({
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
    });
  }
  /** A row is removed. */
  delete(row: Row): void {
    const meta = this.#meta.get(row)!;
    if (this.operation.scope?.rows.tombstones?.has(meta.model["~"].names.ts!))
      outside();
    meta.gone = true;
    if (meta.made)
      this.#log.splice(
        this.#log.findIndex(
          (entry) => entry.kind === "insert" && entry.row === row
        ),
        1
      );
    else
      this.#log.push({
        kind: "delete",
        row,
        key: this.#now(row),
        question: this.#writing(row, { intent: "delete" }),
      });
  }
  /** Every row a question names takes `set`, or is removed where there is none: the call does not need to know them. */
  all(question: Question, set?: Input, projection?: PreparedProjection): Later {
    const name = question.model["~"].names.ts!;
    if (!set && this.operation.scope?.rows.tombstones?.has(name)) outside();
    this.writable(question);
    const later: Later = {};
    this.#log.push({ kind: "all", question, set, later, projection });
    return later;
  }
  /** `to` is made a member of `from`'s through a junction. */
  link(edge: Junction, from: Row, to: Row): void {
    this.#log.push({
      kind: "link",
      edge,
      from,
      to,
      keys: [this.#now(from), this.#now(to)],
    });
  }
  /** `from`'s links through a junction go: the one to `to`, or every one but those to the rows `kept`. */
  unlink(edge: Junction, from: Row, to?: Row, kept: readonly Row[] = []): void {
    this.#log.push({
      kind: "unlink",
      edge,
      from,
      to,
      kept,
      keys: [
        this.#now(from),
        to && this.#now(to),
        kept.map((row) => this.#now(row)),
      ],
    });
  }
  /** Of a strict question, no row the call may see may be one it may not write so, when its writes reach here. */
  writable(question: Question): void {
    if (question.strict && this.writer.judges(question))
      this.#log.push({ kind: "none", question });
  }
  /** No row may answer the question when the call's writes reach here: `stops` refuses it. */
  none(question: Question, stops: PreparedGuardFailure): void {
    this.#log.push({ kind: "none", question, stops });
  }
  /** A row read as `projection` says, where the call's writes stand when this is asked. */
  read(
    row: Row,
    projection: PreparedProjection,
    take: (rows: Input[], query: Query) => void
  ): void {
    const { model } = this.#meta.get(row)!;
    this.#log.push({
      kind: "read",
      model,
      queries: () => [this.writer.one(model, this.#key(row), projection)],
      take: ([sent], [query]) => take(sent!.rows, query!),
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
    this.#log.push({
      kind: "read",
      model,
      queries: () =>
        this.operation.seriesQueries(
          projection,
          rows.map((row) => this.#key(row)),
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
   * The steps of the call's unit: what the call believed must still hold,
   * then every write in order. Rows written the same way side by side travel
   * in one statement.
   */
  #steps(): Step[] {
    const { writer } = this;
    const { schema } = this.operation;
    const steps: Step[] = [];
    /** Where this unit keeps the keys the database decides in it: it cannot hear them and go on. */
    let scratch: { id: string; model: AnyModel } | undefined;
    for (const { question } of this.#presumed.values())
      steps.push({
        write: () => [writer.asks(question, undefined, "presumed")],
      });
    if (!this.#transport.holds)
      for (const answer of this.#used)
        for (const values of answer.rows)
          steps.push({
            write: () => [
              writer.asks(
                answer.question,
                schema.identity(answer.question.model, values),
                "read"
              ),
            ],
          });
    const log = this.#log;
    for (let at = 0; at < log.length; at++) {
      const entry = log[at]!;
      /** The entries that follow `entry` and travel with it. */
      const beside = <T extends Entry>(same: (next: T) => boolean): T[] => {
        const run = [entry as T];
        while (at + 1 < log.length && same(log[at + 1] as T))
          run.push(log[++at] as T);
        return run;
      };
      if (entry.kind === "insert") {
        const { model } = this.#meta.get(entry.row)!;
        const settled = (row: Row) =>
          Object.fromEntries(
            Object.entries(row).filter(
              ([, value]) =>
                value !== undefined &&
                !(value instanceof Pending && value.row === row)
            )
          );
        const waits = (row: Row) =>
          Object.values(row).some(
            (value) => value instanceof Pending && value.row === row
          );
        const rows = [entry.row];
        // A row whose key the database decides is written alone: its statement says the key.
        beside<Extract<Entry, { kind: "insert" }>>((next) => {
          const fits =
            next.kind === "insert" &&
            !waits(entry.row) &&
            !waits(next.row) &&
            this.#meta.get(next.row)!.model === model &&
            next.relation === entry.relation &&
            writer.beside(model, rows.map(settled), settled(next.row));
          if (fits) rows.push(next.row);
          return fits;
        });
        const decided = schema
          .keys(model)
          .filter((field) => entry.row[field] instanceof Pending);
        if (decided.length > 0 && !this.#transport.holds)
          scratch ??= { id: crypto.randomUUID(), model };
        const at = steps.length;
        steps.push({
          write: async () => {
            const insert = (keyed: boolean) =>
              writer.insert(
                model,
                rows.map((row) => this.#heard(settled(row))),
                entry.relation,
                keyed
              );
            const kept =
              scratch &&
              writer.kept(scratch.id, `${at}`, decided, await insert(false));
            if (!kept) return [await insert(decided.length > 0)];
            entry.row[decided[0]!] = kept.value;
            return kept.statements;
          },
          take: ([sent]) => {
            const [said] = writer.keys(model, sent!.rows);
            for (const field of decided)
              if (entry.row[field] instanceof Pending)
                entry.row[field] = said?.[field] ?? sent!.insertId;
          },
        });
      } else if (entry.kind === "update") {
        const { model } = entry.question;
        const { hears } = entry;
        const run = beside<Extract<Entry, { kind: "update" }>>(
          (next) =>
            next.kind === "update" &&
            next.set === entry.set &&
            next.question.model === model &&
            hears.length === 0
        );
        steps.push({
          write: async () => [
            await writer.update(
              entry.question,
              this.#heard(entry.set),
              run.map((next) => this.#heard(next.key)),
              hears.length > 0 ? writer.key(model) : undefined
            ),
          ],
          take: ([sent]) => {
            const [said] = writer.keys(model, sent!.rows);
            for (const field of hears) entry.row[field] = said?.[field];
          },
        });
      } else if (entry.kind === "delete") {
        const { model } = entry.question;
        const run = beside<Extract<Entry, { kind: "delete" }>>(
          (next) => next.kind === "delete" && next.question.model === model
        );
        steps.push({
          write: () => [
            writer.remove(
              entry.question,
              run.map((next) => this.#heard(next.key))
            ),
          ],
        });
      } else if (entry.kind === "all")
        steps.push({
          write: async () => [
            entry.set
              ? await writer.update(
                  entry.question,
                  this.#heard(entry.set),
                  undefined,
                  entry.projection
                )
              : writer.remove(entry.question, undefined, entry.projection),
          ],
          take: ([sent]) => {
            entry.later.sent = sent;
          },
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
                  [
                    this.#heard(next.keys[0]),
                    this.#heard(next.keys[1]),
                  ] as const
              )
            ),
        });
      } else if (entry.kind === "unlink")
        steps.push({
          write: () => [
            writer.unlink(
              entry.edge,
              this.#heard(entry.keys[0]),
              entry.keys[1] && this.#heard(entry.keys[1]),
              entry.keys[2].map((key) => this.#heard(key))
            ),
          ],
        });
      else if (entry.kind === "none")
        steps.push({
          write: () => [writer.none(entry.question, entry.stops)],
        });
      else {
        let queries: Query[];
        steps.push({
          write: () => {
            queries = entry.queries();
            return queries.map((query) => ({
              sql: query.sql,
              model: entry.model,
            }));
          },
          take: (sent) => entry.take(sent, queries),
        });
      }
    }
    if (scratch) {
      const { open, close } = writer.scratch(scratch.id, scratch.model);
      steps.unshift({ write: () => open });
      steps.push({ write: () => [close] });
    }
    return steps;
  }
  /**
   * Sends the call's unit. A statement that needs a value the database has
   * not said yet is written once what stands before it is sent and heard.
   */
  async #send(): Promise<void> {
    const steps = this.#steps();
    let waiting: { statements: Statement[]; step: Step }[] = [];
    const flush = async (last: boolean) => {
      const statements = waiting.flatMap((written) => written.statements);
      if (statements.length === 0) return;
      const sent = await this.#transport.send(statements, last);
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
    await flush(true);
  }
  /** The call's unit as its statements, for an owner that sends it: none may wait for what the database says. */
  async #unit(): Promise<{
    statements: Statement[];
    heard(sent: readonly Sent[]): void;
  }> {
    const written: { statements: Statement[]; step: Step }[] = [];
    try {
      for (const step of this.#steps())
        written.push({ statements: await step.write(), step });
    } catch (error) {
      throw error === UNHEARD ? SEVERAL : error;
    }
    return {
      statements: written.flatMap((entry) => entry.statements),
      heard: (sent) => {
        let at = 0;
        for (const { statements, step } of written) {
          step.take?.(sent.slice(at, at + statements.length));
          at += statements.length;
        }
      },
    };
  }
}
