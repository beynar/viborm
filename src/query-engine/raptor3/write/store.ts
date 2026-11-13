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
import {
  NestedWriteError,
  NotFoundError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
} from "@errors";
import { type AnyModel, getModelKeyCatalog } from "@schema/model";
import type { Sql } from "@sql";
import { createFailureError } from "../../batch-error-attribution";
import type { PreparedGuardFailure } from "../../types";
import { type WriteKind, type WriteWatch, writeSinks } from "../../write-sinks";
import { InsertValue, JoinedValue } from "../shared/insert-value";
import {
  type PreparedProjection,
  type Query,
  readUpdate,
  returningSafeProjection,
} from "../shared/query";
import type { EngineSchema, Input } from "../shared/schema";
import type { SqlOperationContext } from "../shared/sql-operation-context";
import { hopFieldsOf, type Membership } from "../shared/storage";
import { nameOf, same, scalarsOf } from "../shared/terms";
import {
  refusedBy,
  type Sent,
  type Statement,
  Stopped,
  type Transport,
} from "./send";
import { type Junction, type Question, Writer } from "./statements";

/** A row the call knows: what it holds, as far as the call knows it. */
export type Row = Input;

/** What the call read without holding is no longer so: the call may be made again in another unit, or fails with `failure`. */
export class Lost {
  readonly failure: unknown;
  constructor(failure: unknown) {
    this.failure = failure;
  }
}

interface Meta {
  readonly model: AnyModel;
  /** The question that found it, where one did. */
  readonly question?: Question;
  /** The call creates it. */
  made?: true;
  /** Where the call notes that it creates it. */
  at?: number;
  /** Nothing is known of it but its key: it was taken to be there. */
  partial?: true;
  /** It was taken to be there by values that are not its key: the question that names it. */
  readonly named?: string;
  /** The call removed it. */
  gone?: true;
  /** The call changed its key. */
  moved?: true;
  /** What it held before the call gave it another key. */
  stood?: Input;
  /** The database passed it by: it was one too many. */
  passed?: true;
  /** The fields the call wrote of it, once it wrote one. */
  wrote?: Set<string>;
  /** Of a row the call creates: what is written of a field where the row is created, where that is not what the row holds since. */
  born?: Input;
  /** How many rows the statement that created it said it wrote: of rows written side by side, said of the first. */
  inserted?: number;
}

/** What a set write says once it is sent. */
export interface Later {
  sent?: Sent;
  /** Of a row created where none was found, else updated: which it was, where something asked. */
  created?: boolean;
}

/**
 * A value the database decides, of a row the call wrote: known once the
 * statement that writes the row is heard.
 */
class Pending {
  readonly row: Row;
  readonly field: string;
  /** Where the call notes the write that decides it. */
  readonly at: number;
  /** What the database will compute, written as it will compute it, where the call knows what it computes it of. */
  readonly spell?: () => unknown;
  /** No write of the call decides it: it is what the row holds, never heard and always written as what reads it. */
  readonly named: boolean;
  readonly #name: string;
  constructor(
    row: Row,
    field: string,
    name: string,
    at: number,
    spell?: () => unknown,
    named = false
  ) {
    this.row = row;
    this.field = field;
    this.#name = name;
    this.at = at;
    this.spell = spell;
    this.named = named;
  }
  toString(): string {
    return this.#name;
  }
}
const UNHEARD = Symbol("a value the database has not said yet");
/** The first row of a part undone alone was passed by: another row holds what it alone may hold. */
const PASSED = Symbol("a row the database passed by");
/** A value as text, whatever numbers it holds. */
const text = (value: unknown): string =>
  JSON.stringify(value, (_, each) =>
    typeof each === "bigint" ? `${each}n` : each
  );
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
      /** Rows created at once: `passes`, only where none holds what one of them alone may hold. */
      readonly kind: "skipping";
      readonly model: AnyModel;
      readonly rows: readonly Input[];
      readonly projection?: PreparedProjection;
      readonly passes: boolean;
    }
  | {
      /** The row a question names takes `set`; where there is none, `row` is created. */
      readonly kind: "either";
      readonly question: Question;
      readonly row: Input;
      readonly set: Input;
      readonly projection: PreparedProjection;
      /** What says, of the row answered, that the statement created it. */
      readonly marker?: Sql;
    }
  | {
      readonly kind: "link";
      readonly edge: Junction;
      readonly from: Row;
      readonly to: Row;
      readonly keys: readonly [Input, Input];
      /** What was written of the link itself, where a model holds it. */
      readonly through?: Input;
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
      /** What the call read, and goes on from: where it no longer holds, the call runs again. */
      readonly believed?: true;
    }
  | {
      readonly kind: "read";
      readonly model: AnyModel;
      readonly rows: readonly Row[];
      /** Of one row, read as this says: the statement that writes the row may answer it. */
      readonly projection?: PreparedProjection;
      readonly queries: () => Query[];
    }
) & {
  take?(sent: Sent[], queries?: Query[]): void;
  /** The part of the unit it is written in, where that part is undone alone if its first row is refused: `root` on that row's own write. */
  attempt?: number;
  root?: boolean;
};

/** Statements of a unit, written when it is sent, and where their answers are told. */
interface Step {
  write(): Statement[] | Promise<Statement[]>;
  take?(sent: Sent[]): void;
  attempt?: number;
  root?: boolean;
  /** Whether it writes. */
  writes?: boolean;
  /** Its answer says whether a row the call took to be there is: heard before anything more is written. */
  confirms?: boolean;
}

interface Answer {
  readonly question: Question;
  readonly rows: Input[];
}

/** The relations of `model` whose rows hold its key. */
const holders = (schema: EngineSchema, model: AnyModel) =>
  model["~"].relationNames.flatMap((name) => {
    if ("members" in schema.index.get(model)!.get(name)!.edge) return [];
    const edge = schema.membership(model, name);
    return edge.kind === "reference" && edge.owner === "target" ? [edge] : [];
  });
/** The models whose rows the database changes with a row of `model` that goes, or takes another key. */
const dependents = new WeakMap<AnyModel, Set<AnyModel>>();
function dependentsOf(schema: EngineSchema, model: AnyModel): Set<AnyModel> {
  let found = dependents.get(model);
  if (!found) {
    found = new Set();
    dependents.set(model, found);
    for (const edge of holders(schema, model)) {
      found.add(edge.target);
      for (const further of dependentsOf(schema, edge.target))
        found.add(further);
    }
  }
  return found;
}

const NONE: string[] = [];
/** The step of a statement that only asks. */
const STILL: Step = { write: () => [] };
/** The fields of a model the database decides where a row leaves them out: its key, and what it counts for the row. */
const decidables = new WeakMap<AnyModel, readonly string[]>();
function decidable(schema: EngineSchema, model: AnyModel): readonly string[] {
  let fields = decidables.get(model);
  if (!fields) {
    const scalars = scalarsOf(model);
    fields = [
      ...new Set([
        ...schema.keys(model),
        ...schema
          .storedFields(model)
          .filter(
            (field) =>
              scalars[field]?.["~"].state.autoGenerate?.kind === "increment"
          ),
      ]),
    ];
    decidables.set(model, fields);
  }
  return fields;
}

export class Store {
  readonly operation: SqlOperationContext;
  readonly writer: Writer;
  /** What watches this run of the call's writes, where something asked to see rows. */
  readonly watch: WriteWatch | undefined;
  readonly #transport: Transport;
  /** What the database answered, by question: kept from one run of the verbs to the next. */
  #answers: Map<string, Answer> | undefined;
  /** The questions asked for real: a run needed more of their row than its key, or the row was not there. */
  #concrete: Set<string> | undefined;
  /** What a run made once and every later run takes again: a row's own copy of what the caller wrote. */
  #copies: Map<string, unknown> | undefined;
  /** How much of what the verbs note is sent already, and what the database said of it. */
  #sent = 0;
  #delivered = 0;
  readonly #heard = new Map<number, Sent[]>();
  /** The rows taken to be there that a unit asked for already, where rows are held. */
  #asserted: Set<string> | undefined;
  /** How many times what the call wrote was made before the call ended. */
  segments = 0;
  /** Everything the call writes was sent: what fails after is its answer. */
  said = false;
  #members: number[] = [];
  /** A row as the statement that read it whole said it. */
  #raw: WeakMap<Input, Input> | undefined;
  #meta = new WeakMap<Row, Meta>();
  #known = new Map<string, Row>();
  #log: Entry[] = [];
  #missed = new Map<string, { question?: Question; after: number }>();
  /** Whether each part undone alone was written, once sent; and the part being noted. */
  #outcomes: Map<number, boolean> | undefined;
  #attempting: number | undefined;
  #presumed = new Map<string, { question: Question; row?: Row; at: number }>();
  #used = new Map<Answer, number>();
  /** What the database may hold of a model beyond what the call knows: every field of its rows, or those named. */
  #stale = new Map<AnyModel, Set<string> | true>();
  /** The models the call wrote a row of, and the junctions it wrote a link of. */
  #touched = new Set<AnyModel | string>();
  #again = false;
  /** The value a statement being written waits for the database to say. */
  #waited: Pending | undefined;
  /** The verbs ran on this store already: what a run noted is put away before the next. */
  #ran = false;
  #made = 0;
  /** The call's unit is handed over: what the call hears of it comes too late to stop it. */
  #handed = false;
  constructor(operation: SqlOperationContext, transport: Transport) {
    this.operation = operation;
    this.#transport = transport;
    this.writer = new (operation.backend?.writer ?? Writer)(
      operation,
      // Given to the writer as it is made: a function stored in it afterwards keeps the whole call from the next collection.
      transport.holds ? (sql, model) => this.#hear({ sql, model }) : undefined
    );
    this.watch = writeSinks.get(operation.attribution)?.attempt();
  }
  /** Asks the database in the call's unit, once what was written before is sent. */
  #hear = async (statement: Statement): Promise<Input[]> =>
    (await this.#transport.send([statement], false))[0]!.rows;
  /** Runs the verbs until they ran on an image that could answer them. */
  async #settle<T>(work: () => () => T): Promise<() => T> {
    for (;;) {
      // A store begins as a run leaves it to the next.
      if (this.#ran) {
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
        this.#members = [];
        this.#says = [];
        this.#absences = [];
        this.#left = new Set();
      }
      this.#ran = true;
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
        const [only] = this.#log;
        // A call that is one write naming its rows itself, and that took nothing for granted, is sent as it is.
        if (
          this.#log.length === 1 &&
          (only!.kind === "all" ||
            only!.kind === "skipping" ||
            only!.kind === "either") &&
          only!.attempt === undefined &&
          this.#presumed.size + this.#used.size + this.#sent === 0
        ) {
          const sent = await this.#transport.send(
            await this.#whole(only as never),
            true
          );
          this.said = true;
          this.#sent = 1;
          // What was written outside a unit the call can undo is made, where a row was written.
          if (
            this.#transport.loose &&
            sent.some((each) => each.rowCount > 0 || each.rows.length > 0)
          )
            this.segments++;
          only!.take?.(sent);
          return answer();
        }
        await this.#deliver(this.#steps(this.#log.length), true);
        return answer();
      } catch (error) {
        if (error instanceof Lost) throw error;
        if (!(error instanceof Stopped))
          throw this.#says.reduce((failure, say) => say(failure), error);
        const { stops, believed, model } = error.statement;
        // The call may not leave the row it would write, a row that must be
        // there is not, or what it wrote before cannot be taken back.
        if (!believed || this.#delivered > 0)
          throw createFailureError(
            stops!,
            nameOf(model),
            this.operation.operation
          );
        // What the call took for granted is asked for real; what it read is read again.
        if (believed === "presumed")
          for (const id of this.#presumed.keys())
            (this.#concrete ??= new Set()).add(id);
        // Only a unit that holds nothing of what it reads asks again what it read: it plans again on what the database says now, three times at most.
        else if (++races > 3)
          throw new NotFoundError(nameOf(model), this.operation.operation);
        else this.#answers = undefined;
        this.#asserted = undefined;
        this.#outcomes = undefined;
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
    // Before a unit handed over, only the call's own row may be looked for: found, the unit asks for it again; not found, the key it is created under refuses a row that came since.
    if (
      this.#handed &&
      [...this.#missed.values()].some(
        ({ question, after: asked }) =>
          asked > 0 ||
          !question?.unique ||
          question.must ||
          question.through ||
          question.member
      )
    )
      throw SEVERAL;
    const steps = after > this.#sent ? this.#steps(after) : [];
    // Questions that each name one row of a model, sought the same way, are one statement.
    const groups = new Map<string, [string, Question][]>();
    const pins = (question: Question) =>
      question.unique && !(question.member || question.limit)
        ? this.writer.selector(question).uniqueValues
        : undefined;
    const group = (question: Question) =>
      pins(question) &&
      text([
        nameOf(question.model),
        question.through?.name,
        question.intent,
        question.writes,
        question.makes,
      ]);
    for (const [id, { question, after: asked }] of this.#missed) {
      if (asked !== after || !question) continue;
      const key = group(question) || id;
      groups.set(key, [...(groups.get(key) ?? []), [id, question]]);
    }
    // A row taken to be there is read with them rather than asked for after.
    for (const [id, { question, row }] of this.#presumed) {
      const together = row && groups.get(group(question) || "");
      if (together) together.push([id, question]);
    }
    /** A question asked of the row it is asked of as the database has said it by then. */
    const told = ({ member, ...question }: Question): Question => ({
      ...question,
      member: member && { ...member, of: this.#said(member.of) },
    });
    for (const asked of groups.values()) {
      const [[, first]] = asked as [[string, Question]];
      const { model } = first;
      let query: Query;
      /** What each question of the group is answered with, once heard. */
      let found: [string, Question, Input[]][] | undefined;
      const take = ([sent]: Sent[]) => {
        const rows = this.operation.queries.decodeQuery(query, sent!.rows);
        for (const [at, row] of rows.entries())
          (this.#raw ??= new WeakMap()).set(row, sent!.rows[at]!);
        const before = found;
        found = asked.map(([id, question]) => [
          id,
          question,
          asked.length === 1
            ? rows
            : rows.filter((row) =>
                [...pins(question)!].every(([field, value]) =>
                  same(row[field], value)
                )
              ),
        ]);
        for (const [id, question, answer] of found)
          (this.#answers ??= new Map()).set(id, { question, rows: answer });
        return before;
      };
      // A place where the call would make a row is not held where holding it holds the place of a row that is not there: two calls holding it would wait on each other.
      const loose =
        this.#transport.holds &&
        first.makes === true &&
        this.writer.adapter.capabilities.locksMissingKeys === true;
      steps.push({
        // Asked of the row it is asked of as the database has said it by then.
        write: () => {
          query = this.writer.read(
            asked.map(([, question]) => told(question)),
            this.#transport.holds && !loose
          );
          return [{ sql: query.sql, model }];
        },
        take,
      });
      // The rows found there are read again by their keys, and held: the call goes on with what they hold from then on.
      if (loose)
        steps.push({
          write: () => {
            if (!found) throw UNHEARD;
            const again = found
              .filter(([, , rows]) => rows.length > 0)
              .map(([, question, rows]) => ({
                ...told(question),
                only: rows.map((row) =>
                  this.operation.schema.identity(model, row)
                ),
                again: true,
              }));
            if (again.length === 0) return [];
            query = this.writer.read(again, true);
            return [{ sql: query.sql, model }];
          },
          take: (sent) => {
            if (sent.length === 0) return;
            const before = take(sent)!;
            // A row that no longer answers: what the call read is no longer so.
            if (
              found!.some(
                ([, , rows], at) => rows.length < before[at]![2].length
              )
            )
              throw new Lost(this.#absent(first, true));
          },
        });
    }
    await this.#deliver(steps, false);
    this.#delivered = this.#sent;
  }
  #name(model: AnyModel, values: Input): string {
    const keys = this.operation.schema.keys(model);
    // Most rows have one key.
    if (keys.length === 1) return `${nameOf(model)}:${values[keys[0]!]}`;
    // A row of a model without a key is no other row the call knows.
    if (keys.length === 0) return `${nameOf(model)}#${++this.#made}`;
    return `${nameOf(model)}:${this.operation.schema
      .keys(model)
      .map((field) => String(values[field]))
      .join("|")}`;
  }
  /** What a row holds that makes other rows its members through a relation: asked of the row as it stands now, whatever the call writes of it next. */
  #of({ edge, of }: NonNullable<Question["member"]>): Input {
    // What a link holds of the row: its key, or the fields the junction references of it.
    return Object.fromEntries(
      [
        ...new Set([
          ...(edge.kind === "reference"
            ? []
            : this.operation.schema.keys(edge.source)),
          ...hopFieldsOf(edge),
        ]),
      ].map((field) => [field, of[field]])
    );
  }
  /** What the call holds of a row it knows. */
  #about(row: Row) {
    return this.#meta.get(row)!;
  }
  /** What refuses the call where the row a question names is not there. */
  #absent(question: Question, lost?: boolean) {
    return createFailureError(
      this.writer.absent(question, lost),
      nameOf(question.model),
      this.operation.operation
    );
  }
  /** A question as a statement asks it: of a row it names the members of, what only the database holds written as what reads it. */
  #asked<Q extends Question>(question: Q): Q {
    const { member } = question;
    return member
      ? {
          ...question,
          member: { ...member, of: this.#said(this.#of(member)) },
        }
      : question;
  }
  /** A row's key as it stands now. */
  #key(row: Row): Input {
    return this.operation.schema.identity(this.#about(row).model, row);
  }
  /** Values as a statement takes them: what the database decides must have been heard. */
  #said(values: Input): Input {
    const heard: Input = {};
    for (const field in values) {
      const value = values[field];
      const said = value instanceof Pending ? value.row[value.field] : value;
      // What cannot be heard before the unit goes on is written as the database will compute it.
      if (said instanceof Pending) {
        if (!said.named && (this.#transport.holds || !said.spell)) {
          this.#waited = said;
          throw UNHEARD;
        }
        heard[field] = said.spell!();
      } else if (said !== undefined) heard[field] = said;
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
      this.#meta.set(row, { model, question });
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
    const meta = this.#about(row);
    if (meta.gone) return false;
    const { member } = question;
    const selector = this.writer.selector(question);
    const { facts } = selector;
    const name = this.#name(meta.model, row);
    if (question.except?.some((key) => this.#name(meta.model, key) === name))
      return false;
    /** Whether the call wrote, of the row, a field the question reads. */
    const rewritten =
      meta.wrote !== undefined &&
      [...meta.wrote].some((field) => facts.fields.has(field));
    // A value the row holds that is not the one asked for: it does not answer, whose ever member it is. One spelled another way may be the one asked for: the database says.
    let unsure = false;
    for (const [field, value] of facts.equals) {
      if (!Object.hasOwn(row, field) || row[field] instanceof Pending) continue;
      const holds = this.operation.queries.told(
        meta.model,
        field,
        row[field],
        value
      );
      if (holds === false) return false;
      unsure ||= holds === undefined;
    }
    if (member?.edge.kind === "reference") {
      const { discriminator, pairs } = member.edge;
      // Of the variant the relation reaches.
      if (discriminator) {
        const holder = discriminator.side === "target" ? row : member.of;
        if (!(discriminator.field in holder)) return undefined;
        if (holder[discriminator.field] !== discriminator.value) return false;
      }
      for (const pair of pairs) {
        if (!(pair.target in row && pair.source in member.of)) return undefined;
        const [holds, held] = [row[pair.target], member.of[pair.source]];
        // A value only the database holds is the same as itself, and its to compare with any other.
        if (
          holds !== held &&
          (holds instanceof Pending || held instanceof Pending)
        )
          return undefined;
        if (!same(holds, held)) return false;
      }
    } else if (member) {
      const linked = this.#linked(member.edge as Junction, member.of, row);
      if (linked === false) return false;
      // A link the call did not make is the database's to say. A row that did not answer answers now only by what the call wrote of what the question reads.
      if (linked === undefined && !was)
        return was === false && !rewritten ? false : undefined;
    }
    for (const field of facts.equals.keys())
      if (row[field] instanceof Pending) return undefined;
    // Stated in full by what the call knows of the row.
    if (
      facts.exact &&
      !(selector.scoped || unsure) &&
      [...facts.equals.keys()].every((field) => field in row)
    )
      return true;
    // What the call wrote of it changes nothing the question reads: it answers as it did.
    if (was && !meta.made && facts.reads.size === 0 && !rewritten) return true;
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
      const side = entry.edge.uniqueSide;
      if (entry.kind === "link") {
        if (entry.from === a && entry.to === b) linked = true;
        // The one link a row of that side holds took another row.
        else if (side === "source" ? entry.from === a : side && entry.to === b)
          linked = false;
      } else if (
        entry.from === a &&
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
    if (!(question.must && question.unique && pins) || this.#concrete?.has(id))
      return undefined;
    // A row named by values no other row has, that are not its key: its key is what the database holds of it, written wherever it is needed as what reads it there. Not of a member, nor where a write may not read the table it writes.
    const named = !keys.every((field) => pins.has(field));
    if (
      named &&
      (question.member ||
        question.through ||
        !this.writer.adapter.capabilities.supportsMutationTargetInSubquery)
    )
      return undefined;
    const key = Object.fromEntries(pins);
    const name = named ? `${id}` : this.#name(model, key);
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
            (this.#concrete ??= new Set()).add(id);
            this.#again = true;
          }
          return target[field as string];
        },
      });
      row = partial;
      if (named)
        for (const field of keys)
          if (!(field in held))
            held[field] = new Pending(
              partial,
              field,
              `@${++this.#made}`,
              this.#log.length,
              () => this.writer.located(question, field),
              true
            );
      this.#known.set(name, row);
      this.#meta.set(row, {
        model,
        question,
        partial: true,
        named: named ? id : undefined,
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
    const { uniqueValues, facts } = this.writer.selector(question);
    // Named by a unique key alone, or by its own key beside what else is asked of it.
    const pins =
      uniqueValues ??
      (this.operation.schema
        .keys(question.model)
        .every((field) => facts.keys.has(field))
        ? facts.keys
        : undefined);
    if (!(question.unique && pins)) return false;
    for (const row of this.#known.values()) {
      if (
        this.#about(row).model !== question.model ||
        ![...pins].every(
          ([field, value]) => field in row && same(row[field], value)
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
    const meta = this.#about(row);
    return Boolean(meta.made || meta.gone || meta.wrote);
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
        (facts.reads.size > 0 ||
          [...stale].some((field) => facts.fields.has(field)) ||
          (member?.edge.kind === "reference" &&
            member.edge.pairs.some((pair) => stale.has(pair.target))))) ||
      // A filter that reads other rows reads what the call wrote of them.
      [...facts.reads].some(
        (read) => this.#touched.has(read) || this.#stale.has(read as AnyModel)
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
  /** Whether a question reads any of `fields` of the rows it names. */
  reads(question: Question, fields: readonly string[]): boolean {
    const { facts } = this.writer.selector(question);
    return fields.some((field) => facts.fields.has(field));
  }
  /** The rows a question names. */
  rows(question: Question): Row[] {
    this.writable(question);
    // The members of a row the call gave another key, where the database does not make them follow, are those it had under the key it had: asked as of then, ahead of what the call writes.
    const { member } = question;
    const stood = member && this.#meta.get(member.of)?.stood;
    if (
      stood &&
      member.edge.kind === "reference" &&
      member.edge.owner === "target" &&
      member.edge.reference &&
      member.edge.reference.onUpdate !== "cascade"
    )
      return this.#rows(
        { ...question, member: { ...member, of: stood } },
        false
      );
    return this.#rows(question, this.#spoiled(question));
  }
  /** Whether the row a junction's members are members of says what its links hold of it: asked of the row, so a row known by its key alone is read. */
  #links(member: NonNullable<Question["member"]>): boolean {
    const { edge, of } = member;
    return (
      edge.kind !== "junction" ||
      edge.sourceSide.members.every(
        (pair) => of[pair.referencedField] !== undefined
      )
    );
  }
  /** The keys the call moved a row away from: no row has one of them until the call makes one. */
  #left = new Set<string>();
  #rows(question: Question, late: boolean): Row[] {
    const { model, member } = question;
    if (this.#left.size > 0 && question.unique) {
      const pins = this.writer.selector(question).uniqueValues;
      const keys = this.operation.schema.keys(model);
      const name =
        pins &&
        keys.every((field) => pins.has(field)) &&
        this.#name(
          model,
          Object.fromEntries(keys.map((field) => [field, pins.get(field)]))
        );
      // Unless the call made a row under it since: the row that had it is known by its new key.
      const there = name ? this.#known.get(name) : undefined;
      if (
        name &&
        this.#left.has(name) &&
        !(there && this.#name(model, there) === name)
      )
        return [];
    }
    const fresh = member && this.#meta.get(member.of)?.made;
    // What makes a row a member is read of the row it is a member of.
    if (member?.edge.kind === "reference" && !fresh)
      for (const pair of member.edge.pairs)
        if (member.of[pair.source] === undefined) return [];
    if (member && !this.#links(member)) return [];
    const after = late ? this.#log.length : 0;
    const id = text([
      nameOf(model),
      question.where,
      question.unique,
      member && [
        member.edge.name,
        this.#name(member.edge.source, member.of),
        // What makes a row a member, where the row it is a member of holds it.
        member.edge.kind === "reference" && [
          ...member.edge.pairs.map((pair) => String(member.of[pair.source])),
          member.edge.discriminator?.side === "source" &&
            member.of[member.edge.discriminator.field],
        ],
      ],
      question.intent,
      question.writes,
      question.through?.name,
      question.limit,
      question.except?.map((key) => this.#name(model, key)),
      after,
      question.joined && 1,
    ]);
    // The members of a row the call creates are the rows it made members itself.
    const answer =
      fresh && !late ? { question, rows: [] } : this.#answers?.get(id);
    if (!answer) {
      const recalled = !late && this.#recalled(question);
      if (recalled === true) return this.#rows(question, true);
      // What the call recalls of a row it only read is asked again where its writes are sent, where nothing held what it read.
      const read = Array.isArray(recalled)
        ? recalled.filter((row) => !this.#changed(row))
        : [];
      if (read.length > 0)
        this.#used.set({ question, rows: read }, this.#log.length);
      const known = recalled || (!late && this.#presume(id, question));
      if (known) return known;
      // Asked of the row as it stands now, whatever the call writes of it next.
      this.#missed.set(id, {
        question: member
          ? { ...question, member: { ...member, of: this.#of(member) } }
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
        const meta = this.#about(row);
        const raw = (this.#raw ??= new WeakMap());
        raw.set(row, raw.get(values)!);
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
      const meta = this.#about(row);
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
  /** Whether rows of `model` the call deletes are kept, and marked. */
  keeps(model: AnyModel): boolean {
    return this.writer.marks(model) !== undefined;
  }
  /** The one row a question names, which must be there. */
  one(question: Question): Row {
    const missed = this.#missed.size;
    const [row] = this.rows({ ...question, must: true });
    // A question not answered yet says nothing: the verbs go on, on a row of which nothing is known.
    if (!row && this.#missed.size > missed) {
      const unknown: Row = {};
      this.#meta.set(unknown, { model: question.model, question });
      return unknown;
    }
    if (!row) throw this.#absent(question);
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
    entry.attempt = this.#attempting;
    if ("row" in entry && entry.kind !== "either")
      this.#touched.add(this.#about(entry.row).model);
    else if (entry.kind === "skipping") this.#touched.add(entry.model);
    else if ("edge" in entry) this.#touched.add(entry.edge.table);
    const heard = this.#heard.get(this.#log.push(entry) - 1);
    if (heard) entry.take?.(heard);
  }
  /** A row created: what was admitted of what the caller wrote of it, and what it `takes` of the rows it references. */
  insert(
    model: AnyModel,
    admitted: Input,
    raw?: Input,
    relation?: string,
    takes?: Input
  ): Row {
    const row: Row = this.writer.values(model, "create", admitted, raw, takes);
    if (takes) Object.assign(row, takes);
    // What the database decides of the row is known once its statement is heard: a key it leaves out, a value computed where it is written.
    let computed: Input | undefined;
    for (const field in row)
      if (row[field] instanceof InsertValue)
        (computed ??= {})[field] = row[field];
    // Most rows are written with all the database would decide of them.
    let decided = NONE;
    for (const field of decidable(this.operation.schema, model))
      if (row[field] === undefined)
        (decided === NONE ? (decided = []) : decided).push(field);
    if (computed)
      for (const field in computed)
        (decided === NONE ? (decided = []) : decided).push(field);
    for (const field of decided)
      row[field] = new Pending(
        row,
        field,
        `@${++this.#made}`,
        this.#log.length
      );
    // A row created under a key another has is the database's to refuse.
    const name = this.#name(model, row);
    if (!this.#known.has(name)) this.#known.set(name, row);
    const meta: Meta = {
      model,
      made: true,
      at: this.#log.length,
      born: computed,
    };
    this.#meta.set(row, meta);
    this.#note({
      kind: "insert",
      row,
      relation,
      decided,
      take: ([sent]) => {
        meta.inserted = sent!.rowCount;
        // Where its statement said what the database decided of it.
        const [raw] = sent!.rows;
        const [said] =
          raw && decided.every((field) => field in raw)
            ? this.writer.told(model, decided, sent!.rows)
            : [];
        for (const field of decided)
          if (row[field] instanceof Pending && (said || sent!.insertId))
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
    const { model } = this.#about(row);
    const name = nameOf(model);
    const { watch } = this;
    if (!watch?.wants(name, kind)) return;
    const q = this.operation.queries;
    const projection = q.prepareProjection(model, {});
    this.read(row, projection, (rows) =>
      watch.shows(name, kind, q.decodeProjection(projection.shape, rows))
    );
  }
  /** The question a write of one row the call knows is written under: what found it, and what the write is. */
  #writing(row: Row, write: Partial<Question>): Question {
    const { model, question } = this.#about(row);
    return {
      model,
      // What the row was found by: said again by its first write where nothing holds what the call read.
      where: question?.where,
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
    const { model } = this.#about(row);
    for (const edge of holders(schema, model)) {
      if (
        edge.reference?.onUpdate !== "cascade" ||
        // What the row does not hold, no write of the call gave it.
        edge.pairs.every(
          (pair) =>
            !Object.hasOwn(row, pair.source) ||
            before[pair.source] === row[pair.source]
        )
      )
        continue;
      for (const child of [...this.#known.values()]) {
        const meta = this.#about(child);
        if (
          meta.model !== edge.target ||
          !edge.pairs.every(
            (pair) =>
              Object.hasOwn(child, pair.target) &&
              same(child[pair.target], before[pair.source])
          )
        )
          continue;
        const was = { ...child };
        for (const pair of edge.pairs) {
          child[pair.target] = row[pair.source];
          (meta.wrote ??= new Set()).add(pair.target);
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
   * relation it is made a member of, or leaves, by this write, and `of` the
   * row it is made a member of.
   */
  update(
    row: Row,
    set: Input,
    writes?: readonly string[],
    joined?: Membership,
    removes = false,
    of?: Row
  ): void {
    if (Object.keys(set).length === 0) return;
    const meta = this.#about(row);
    const { model } = meta;
    const key = this.#key(row);
    const keys = this.operation.schema.keys(model);
    // A row named by what it holds is no longer named so once the call writes that, or its key: it is read.
    if (
      meta.named !== undefined &&
      Object.keys(set).some(
        (field) =>
          keys.includes(field) ||
          this.writer.selector(meta.question!).uniqueValues?.has(field)
      )
    ) {
      (this.#concrete ??= new Set()).add(meta.named);
      this.#again = true;
    }
    const hears: string[] = [];
    const before = { ...row };
    let computed = false;
    for (const field in set) {
      const value = set[field];
      const update =
        value instanceof Pending
          ? { kind: "value" as const, value }
          : readUpdate(value);
      (meta.wrote ??= new Set()).add(field);
      // What the database computes of a row is its to say; so is what a row written after it decides. A row the call creates is written first as it stood.
      const made = meta.at ?? Number.POSITIVE_INFINITY;
      const later =
        (update.kind === "value" &&
          update.value instanceof Pending &&
          update.value.at > made) ||
        // So is what it holds of a row the call creates after it: that row is not there when this one is inserted.
        (of !== undefined && (this.#meta.get(of)?.at ?? -1) > made);
      if (update.kind !== "value" || later) {
        const stood = row[field];
        // Of a row the call creates only.
        if (
          meta.made &&
          !(
            (meta.born && field in meta.born) ||
            (stood instanceof Pending && stood.row === row)
          )
        )
          (meta.born ??= {})[field] = stood;
        computed = true;
      }
      if (update.kind === "value") row[field] = update.value;
      else {
        const stood = row[field];
        const q = this.operation.queries;
        row[field] = new Pending(
          row,
          field,
          `@${++this.#made}`,
          this.#log.length,
          stood === undefined || stood instanceof Pending
            ? undefined
            : () =>
                q.updateValue(
                  model,
                  field,
                  value,
                  q.fieldValue(model, field, stood)
                )
        );
        if (keys.includes(field)) hears.push(field);
      }
    }
    if (
      keys.some(
        (field) =>
          field in set &&
          (row[field] instanceof Pending || !same(row[field], before[field]))
      )
    )
      meta.stood ??= before;
    // A row is known by the key it has now: the key it had names no row the call knows of.
    if (keys.some((field) => field in set)) {
      this.#left.add(this.#name(model, before));
      this.#known.set(this.#name(model, row), row);
      meta.moved = true;
      this.#cascades(model);
    }
    this.#follow(row, before);
    // A row the call creates is inserted as it stands in the end.
    if (meta.made && !computed) return;
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
        // A write that is to say the key it gave its row says it, or wrote no row.
        if (!said) throw this.#absent(meta.question ?? { model });
        for (const field of hears) row[field] = said[field];
      },
    });
    // A kept row that goes is seen as the update it is.
    if (meta.question?.verb) this.#seen(row, "update");
  }
  /** A row is removed: marked, where its model keeps the rows it deletes. */
  delete(row: Row): void {
    const meta = this.#about(row);
    const { model, question } = meta;
    const marks = this.writer.marks(model);
    // As it was before it goes.
    if (question?.verb && !marks) this.#seen(row, "delete");
    if (marks) {
      // A kept row leaves the rows that reference it in place: where the database would have refused its removal, the mark is refused too.
      const stops = this.writer.restriction(model);
      const through = question?.member;
      if (stops)
        this.none(
          {
            model,
            where: this.#key(row),
            unique: true,
            intent: "delete",
            referenced: this.writer.referenced(
              through,
              through && this.#key(through.of)
            ),
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
    if (question.member) this.#links(question.member);
    const q = this.operation.queries;
    const name = nameOf(model);
    const kind = set ? "update" : "delete";
    // Rows written through a relation are shown whole to what asked to see them.
    const watched =
      question.verb && this.watch?.wants(name, kind)
        ? q.prepareProjection(model, {})
        : undefined;
    const returns = projection ?? watched;
    const marks = set ? undefined : this.writer.marks(model);
    const stops = marks && this.writer.restriction(model);
    const later: Later = {};
    // Where no statement both writes rows and answers with them so, they are
    // read, then written by their keys; and so are rows that are kept where
    // one may be refused: the rows asked of are the rows written.
    const { member } = question;
    const referenced =
      stops && this.writer.referenced(member, member && this.#key(member.of));
    // Rows that need not be known are held, not read: nothing comes to reference them between what is asked and what is written. So it is in a unit handed over, which nothing comes between.
    const held =
      stops && !(this.#handed || member || question.limit !== undefined);
    if (
      marks
        ? watched || (stops && !(this.#handed || held))
        : returns &&
          !this.operation.answersInStatement(model, returns, kind, set)
    ) {
      // A value read from a table the write joins names the rows written: no other is asked for.
      const joined =
        set &&
        Object.values(set).find(
          (value): value is JoinedValue => value instanceof JoinedValue
        );
      const rows = this.rows(joined ? { ...question, joined } : question);
      const take = (read: Input[]) => {
        later.sent = { rows: read, rowCount: read.length };
      };
      const answer = () =>
        projection
          ? this.series(model, rows, projection, "updateMany", take)
          : take(rows);
      // Rows that go answer as they were; rows that are written or kept, as that leaves them.
      if (!(set || marks)) answer();
      if (stops && rows.length > 0)
        this.none(
          {
            model,
            only: rows.map((row) => this.#key(row)),
            intent: "delete",
            referenced,
          },
          stops
        );
      for (const row of rows)
        if (marks) {
          this.update(row, marks, undefined, undefined, true);
          this.#about(row).gone = true;
        } else if (set)
          this.update(
            row,
            set,
            question.writes,
            undefined,
            question.intent === "delete"
          );
        else this.delete(row);
      if (set || marks) answer();
      return later;
    }
    if (marks) {
      // Unless the rows are read ahead of their marks: they are held as they are read.
      if (
        held &&
        this.#transport.holds &&
        this.writer.adapter.capabilities.supportsRowLocks &&
        !(
          returns &&
          !this.operation.answersInStatement(model, returns, "update", marks)
        )
      )
        this.#note({
          kind: "read",
          model,
          rows: [],
          queries: () => [
            this.operation.scope!.rows.tombstones!.lock(
              q,
              this.writer.selector({ ...question, intent: "delete" })
            ),
          ],
        });
      if (stops)
        this.none(
          { ...question, must: undefined, intent: "delete", referenced },
          stops
        );
      return this.all(question, marks, projection);
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
      projection: returns,
      take: ([sent]) => {
        later.sent = sent;
        if (watched)
          this.watch!.shows(
            name,
            kind,
            q.decodeProjection(watched.shape, sent!.rows)
          );
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
    const { capabilities } = this.writer.adapter;
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
    // Which of the two it was is told to what asked: by the statement itself where the provider marks a row it created, else by asking for the row just before it.
    const name = nameOf(model);
    const asked =
      this.watch?.wants(name, "create") || this.watch?.wants(name, "update");
    const marker =
      asked && returningSafeProjection(projection)
        ? this.writer.adapter.mutations.upserted
        : undefined;
    let created: boolean | undefined;
    if (asked && !marker)
      this.#note({
        kind: "read",
        model,
        rows: [],
        queries: () => [this.writer.read([question], false)],
        take: ([sent]) => {
          created = sent!.rows.length === 0;
        },
      });
    this.#note({
      kind: "either",
      question,
      row,
      set,
      projection,
      marker,
      take: ([sent]) => {
        later.sent = sent;
        for (const said of marker ? sent!.rows : []) {
          created = said.__viborm_inserted === true;
          said.__viborm_inserted = undefined;
        }
        later.created = created;
      },
    });
    this.#spoil(model);
    return later;
  }
  /** `to` is made a member of `from`'s through a junction: `through` is what was written of the link itself. */
  link(edge: Junction, from: Row, to: Row, through?: Input): void {
    const source = this.#end(edge.sourceSide, from);
    const target = this.#end(edge.targetSide, to);
    // One column of a link holds one value: where both rows supply it, they supply the same, or the call is refused before anything is written.
    for (const pair of edge.sourceSide.members) {
      const other = edge.targetSide.members.find(
        (each) => each.junctionField === pair.junctionField
      );
      if (!other) continue;
      const a = source[pair.referencedField];
      const b = target[other.referencedField];
      const known = (value: unknown) =>
        !(value === undefined || value instanceof Pending);
      if (known(a) && known(b) && !same(a, b))
        throw new NestedWriteError(
          `Cannot link relation '${edge.name}': the two rows hold different values for '${pair.junctionField}'.`,
          edge.name,
          { meta: { field: pair.junctionField, relation: edge.name } }
        );
    }
    this.#note({
      kind: "link",
      edge,
      from,
      to,
      keys: [source, target],
      through,
    });
  }
  /**
   * What a link holds of the row at one of its ends: the fields the junction
   * references there, which are the row's key or values no other row has.
   * Asked of the row, so a row known by its key alone is read.
   */
  #end(side: Junction["sourceSide"], row: Row): Input {
    return Object.fromEntries(
      side.members.map((pair) => [
        pair.referencedField,
        row[pair.referencedField],
      ])
    );
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
        this.#end(edge.sourceSide, from),
        to && this.#end(edge.targetSide, to),
        kept.map((row) => this.#end(edge.targetSide, row)),
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
    if (question.member) this.#links(question.member);
    this.#note({ kind: "none", question, stops });
  }
  /** The call goes on as no row answers the question: asked again where its writes are sent, where nothing held what it read. */
  absent(question: Question): void {
    if (!this.#transport.holds)
      this.#note({ kind: "none", question, believed: true });
  }
  /** A row read as `projection` says, where the call's writes stand when this is asked. */
  read(
    row: Row,
    projection: PreparedProjection,
    take: (rows: Input[]) => void
  ): void {
    const { model } = this.#about(row);
    const said = this.#told([row], projection);
    if (said) {
      take(said);
      return;
    }
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
  /** What rows read whole have said of what is read of themselves alone, while the call has written nothing: a write of any row may change it where the database makes it follow. */
  #told(rows: readonly Row[], projection: PreparedProjection) {
    const said = rows.map((row) => this.#raw?.get(row));
    return said.every(Boolean) &&
      this.#log.every(
        (entry) => entry.kind === "read" || entry.kind === "none"
      ) &&
      projection.fields.every((field) => field.kind === "scalar")
      ? (said as Input[])
      : undefined;
  }
  /** Rows read by their keys as `projection` says, in their order, where the call's writes stand when this is asked. */
  series(
    model: AnyModel,
    rows: readonly Row[],
    projection: PreparedProjection,
    kind: "createMany" | "updateMany",
    take: (rows: Input[]) => void
  ): void {
    // A row the database passed by is no row of the call's.
    const there = rows.filter((row) => !this.#about(row).passed);
    const said = this.#told(there, projection);
    if (said) {
      take(said);
      return;
    }
    this.#note({
      kind: "read",
      model,
      rows: there,
      projection,
      queries: () =>
        this.operation.seriesQueries(
          projection,
          there.map((row) => this.#said(this.#key(row))),
          kind
        ),
      take: (sent, queries) => {
        // A read-back owes its write every row it names: fewer is the write's refusal.
        for (const [at, query] of (queries ?? []).entries()) {
          const expected = query.expectedRows;
          if (!expected || sent[at]!.rows.length >= expected.count) continue;
          // A row taken to be there, read before anything said it was: the read says it is not.
          for (const { question, row } of this.#presumed.values())
            if (row && there.includes(row))
              throw new Stopped({
                sql: query.sql,
                model,
                stops: this.writer.absent(question),
                believed: "presumed",
              });
          throw expected.missing;
        }
        take(sent.flatMap((each) => each.rows));
      },
    });
  }
  /** What the call says of a failure of its writes, where it knows more of it than the database says. */
  #says: ((failure: unknown) => unknown)[] = [];
  saying(say: (failure: unknown) => unknown): void {
    this.#says.push(say);
  }
  /** The keys rows were created under because the call found none there. */
  #absences: {
    model: AnyModel;
    key: NonNullable<ReturnType<Writer["selector"]>["uniqueKey"]>;
  }[] = [];
  /** A row is created under the key a question named, because none answered it. */
  created(question: Question): void {
    const key = this.writer.selector(question).uniqueKey;
    if (key) this.#absences.push({ model: question.model, key });
  }
  /** Whether a failure is the database refusing such a row for its key: another writer made it since. */
  raced(failure: unknown): boolean {
    return (
      failure instanceof UniqueConstraintError &&
      this.#absences.some(({ model, key }) =>
        this.writer.refusedFor(model, key, failure)
      )
    );
  }
  /** A row of the call's own rows begins: what is written until the next is its. */
  member(): void {
    this.#members.push(this.#log.length);
  }
  /** How many of the call's own rows are written, where what the call sent before it failed stands: of a call that writes one row, that row; `series` counts the rows of a call that writes several, and none of one that writes one. */
  members(series = false): number {
    if (series && this.#members.length === 0) return 0;
    const ends = [...this.#members.slice(1), this.#log.length];
    return ends.filter((end) => end <= this.#sent).length;
  }
  /** Refuses where no part of the call's unit can be undone alone. */
  attempts(rows: string): void {
    // A unit handed over hears nothing of its parts: it cannot be one unit.
    if (this.#handed) throw SEVERAL;
    if (!this.#transport.attempt)
      throw new UnsupportedOperationError(
        `skipDuplicates cannot skip ${rows} on driver '${this.operation.driver.driverName}' in this scope; a member savepoint is required.`,
        { meta: { operation: this.operation.operation } }
      );
  }
  /**
   * A row created, with what hangs on it, unless the database refuses the row
   * for holding what another row alone may hold: then nothing of it is
   * written, and the call goes on. Answers whether it was written.
   */
  attempt(work: () => Row, rows: string): boolean {
    this.attempts(rows);
    const from = this.#log.length;
    this.#attempting = from;
    let made: Row;
    try {
      made = work();
    } finally {
      this.#attempting = undefined;
    }
    const part = this.#log.slice(from);
    const root = part.find(
      (entry) => entry.kind === "insert" && entry.row === made
    );
    if (root) root.root = true;
    const written = this.#outcomes?.get(from);
    // Only the database can say: once the part is sent.
    if (written === undefined) {
      this.#missed.set(`attempt:${from}`, { after: this.#log.length });
      return true;
    }
    if (!written)
      for (const entry of part) {
        if (entry.kind !== "insert") continue;
        const meta = this.#about(entry.row);
        Object.assign(meta, { gone: true, passed: true });
        // The row that has its key is the one the database holds.
        const name = this.#name(meta.model, entry.row);
        if (this.#known.get(name) === entry.row) this.#known.delete(name);
      }
    return written;
  }
  /** How many of the rows the call created the database said it wrote. */
  written(rows: readonly Row[]): number {
    let count = 0;
    for (const row of rows) count += this.#meta.get(row)?.inserted ?? 0;
    return count;
  }
  /** The call's unit is handed over. */
  get handed(): boolean {
    return this.#handed;
  }
  /**
   * Rows created where no row holds what one of them alone may hold: the
   * others are passed by, and the call does not know which. Each is what was
   * admitted of it, what the caller wrote of it, and what it takes of the
   * rows it references.
   */
  skipping(
    model: AnyModel,
    rows: readonly (readonly [Input, Input, Input?])[],
    projection?: PreparedProjection,
    passes = true
  ): Later | undefined {
    // None where no one statement passes such rows by, or answers with those it wrote.
    if (
      (passes &&
        this.writer.adapter.mutations.skipDuplicatesStrategy !== "sql") ||
      (projection &&
        !this.operation.answersInStatement(model, projection, "insert"))
    )
      return undefined;
    const later: Later = {};
    this.#note({
      kind: "skipping",
      model,
      rows: rows.map(([admitted, raw, takes]) =>
        Object.assign(
          this.writer.values(model, "create", admitted, raw, takes),
          takes
        )
      ),
      projection,
      passes,
      take: (sent) => {
        const said = sent.flatMap((each) => each.rows);
        later.sent = {
          rows: said,
          rowCount: projection
            ? said.length
            : sent.reduce((count, each) => count + each.rowCount, 0),
        };
      },
    });
    this.#spoil(model);
    return later;
  }
  /** What one run makes of `make` is what every later run takes: a row's own copy of what the caller wrote. */
  copy<T>(name: string, make: () => T): T {
    const copies = (this.#copies ??= new Map());
    if (!copies.has(name)) copies.set(name, make());
    return copies.get(name) as T;
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
    /** The entry whose steps are being written: they are told apart as those of a part undone alone, and the write of its first row among them. */
    let current: Entry | undefined;
    const push = (step: Step) => {
      if (current) {
        step.attempt = current.attempt;
        step.root = current.root;
        step.writes = current.kind !== "read";
      }
      steps.push(step);
    };
    const log = this.#log;
    const last = to === log.length;
    /** Where this unit keeps the keys the database decides in it: it cannot hear them and go on. */
    let scratch: { id: string; model: AnyModel } | undefined;
    const span = log.slice(this.#sent, to);
    /** The rows of which other statements need what the database decides, and how many do. */
    const needed = new Map<Row, number>();
    const needs = (values: readonly (Input | undefined)[], own?: Row) => {
      let rows: Set<Row> | undefined;
      for (const each of values)
        if (each)
          for (const field in each) {
            const value = each[field];
            // What the database decides of a row is no need of the row's own write.
            if (value instanceof Pending && value.row !== own)
              (rows ??= new Set()).add(value.row);
          }
      if (rows)
        for (const row of rows) needed.set(row, (needed.get(row) ?? 0) + 1);
    };
    /** Whether a statement other than the read of a row needs what the database decides of it: its read needs it too where its key is the database's to say. */
    const wanted = (row: Row) =>
      (needed.get(row) ?? 0) >
      (Object.values(this.#key(row)).some((value) => value instanceof Pending)
        ? 1
        : 0);
    let writes = 0;
    // What is noted after this unit needs what the database decides in it too.
    for (let at = this.#sent; at < log.length; at++) {
      const entry = log[at]!;
      if (at < to && !(entry.kind === "none" || entry.kind === "read"))
        writes++;
      if (entry.kind === "insert") needs([entry.row], entry.row);
      else if (entry.kind === "update") needs([entry.key, entry.set]);
      else if (entry.kind === "delete") needs([entry.key]);
      else if (entry.kind === "link" || entry.kind === "unlink")
        needs([entry.keys[0], entry.keys[1], ...(entry.keys[2] ?? [])]);
      else if (entry.kind === "read")
        needs(entry.rows.map((row) => this.#key(row)));
    }
    // A unit after the first asks again of the rows the call has not written.
    const passed = (row: Row | undefined) =>
      this.#sent > 0 && row && this.#changed(row);
    /** The writes that say themselves whether the row they were taken to find is there. */
    const confirms = new Map<Entry, Question>();
    /** The rows taken to be there that one statement asks for: those sought the same way. */
    let asked: Map<string, [Question, (Input | Input[])?][]> | undefined;
    /** Adds a row to ask for to the statement that asks for those sought the same way. */
    const ask = (
      question: Question,
      own: string,
      believed: "presumed" | "read",
      key?: Input | Input[],
      place?: number,
      // In a unit that hears each answer, every row asked for is held; in one sent whole, the rows the unit gives another row a reference to.
      held = holds || question.intent === "join"
    ) => {
      const group = text([
        believed,
        nameOf(question.model),
        question.member ? own : question.through?.name,
        question.verb,
        question.intent,
        question.writes,
        place,
        held,
      ]);
      asked ??= new Map();
      if (!asked.has(group)) {
        const together: [Question, (Input | Input[])?][] = [];
        asked.set(group, together);
        push({
          write: () => [
            writer.asks(
              together.map(([each, key]) => [this.#asked(each), key]),
              believed,
              holds,
              held
            ),
          ],
        });
      }
      asked.get(group)!.push([question, key]);
    };
    /** The first write of each row, in the whole call. */
    let firsts: Map<Row, Entry> | undefined;
    const firstOf = (row: Row) => {
      if (!firsts) {
        firsts = new Map();
        for (const entry of log)
          if ("row" in entry && !firsts.has(entry.row))
            firsts.set(entry.row, entry);
      }
      return firsts.get(row);
    };
    /** The rows taken to be there after the unit began: each asked for at its place, in the order of their places. */
    const later: [number, () => void][] = [];
    /** Whether the unit writes, before a place, what may make a row the member a question says: the row it is a member of, or a link of its relation. */
    const made = (question: Question, at: number) =>
      question.member !== undefined &&
      log
        .slice(this.#sent, at)
        .some((entry) =>
          "row" in entry
            ? entry.row === question.member!.of
            : entry.kind === "link" &&
              question.member!.edge.kind === "junction" &&
              entry.edge.table === question.member!.edge.table
        );
    /** The rows taken to be there that this unit hears of, in the order the call took them. */
    const taken = [...this.#presumed].filter(
      ([id, { row, at }]) =>
        !(at > to || (holds ? this.#asserted?.has(id) : passed(row)))
    );
    // The first write of a row taken to be there says whether it is,
    // where nothing else is written if it is not.
    // A link of the row the call takes away before it writes the row is no longer there to say the row was a member.
    const says = taken.map(([, { row }]) => {
      const first = span.find(
        (entry) =>
          ((entry.kind === "update" || entry.kind === "delete") &&
            entry.row === row) ||
          (entry.kind === "unlink" && entry.to === row)
      );
      return first &&
        first.kind !== "unlink" &&
        writer.counts(first.kind) &&
        (holds || !(this.#handed || writes > 1))
        ? first
        : undefined;
    });
    // Where two rows the call took to be there are both missing, the first it took is the one said so: a row is asked for behind the write that says an earlier one is there. That write must be the unit's first, and take nothing of the row asked for; else the earlier row is asked for too.
    for (let place = says.length, asked = false, held = false; place-- > 0; ) {
      if (asked && (held || says[place] !== log[this.#sent]))
        says[place] = undefined;
      const { through } = taken[place]![1].question;
      asked ||= !says[place];
      held ||=
        !says[place] &&
        through?.kind === "reference" &&
        through.owner === "source";
    }
    let behind = 0;
    for (const [place, [id, { question, at }]] of taken.entries()) {
      (this.#asserted ??= new Set()).add(id);
      const first = says[place];
      if (first) {
        confirms.set(first, question);
        behind = this.#sent + 1;
        continue;
      }
      // A member is asked for behind what the unit writes that may make it one.
      const from = Math.max(made(question, at) ? at : 0, behind);
      if (from > 0)
        later.push([
          from,
          () => ask(question, id, "presumed", undefined, from),
        ]);
      else ask(question, id, "presumed");
    }
    /**
     * The question a write of rows by their keys is written under: rows the
     * call found were found members; a row it took to be there is still to
     * be one.
     */
    const under = (
      entry: Extract<Entry, { kind: "update" | "delete" }>,
      run: readonly Extract<Entry, { kind: "update" | "delete" }>[] = [entry]
    ) => ({
      ...this.#asked({
        ...entry.question,
        member: confirms.get(entry)?.member,
      }),
      through: entry.question.member?.edge ?? entry.question.through,
      // Where nothing holds what the call read, the first write of the rows it read says again what they were found by.
      again:
        !holds &&
        run.every(
          (each) =>
            each.question.where === entry.question.where &&
            firstOf(each.row) === each &&
            !this.#meta.get(each.row)?.made
        ),
    });
    /**
     * Rows the call read and named again by what they were found by: where
     * the write took fewer, some stopped answering after the unit asked, and
     * the unit is made. The call says so, with what stands.
     */
    const consumed = (
      question: Question,
      rows: number,
      sent: Sent | undefined
    ) => {
      if (question.again && sent && writer.count(sent) < rows)
        throw new TransactionError(
          `${question.verb ?? this.operation.operation} selected-row cardinality changed during its locked mutation.`,
          {
            meta: {
              model: this.operation.modelName,
              operation: this.operation.operation,
            },
          }
        );
    };
    /** Whether a write is of a row the call names by what the question that found it says, its key being the database's to say. */
    const unkeyed = (entry: Entry) =>
      "row" in entry && this.#meta.get(entry.row)?.named !== undefined;
    /** The keys a write of rows names them by; none where the question does. */
    const keyed = (run: readonly { row: Row; key: Input }[]) =>
      unkeyed(run[0] as Entry)
        ? undefined
        : run.map((next) => this.#said(next.key));
    /** Whether two writes of rows by their keys may be one statement: rows found, or rows taken to be members of the same row. */
    const mates = (entry: Entry, next: Entry) => {
      const [a, b] = [confirms.get(entry)?.member, confirms.get(next)?.member];
      return (
        confirms.has(entry) === confirms.has(next) &&
        a?.of === b?.of &&
        a?.edge === b?.edge &&
        !(own.has(next) || spare?.has(next) || spare?.has(entry)) &&
        !(unkeyed(entry) || unkeyed(next))
      );
    };
    /** Refuses where a write that says whether its rows are there found fewer. */
    let sizes: Map<Entry, number> | undefined;
    const confirmed = (entry: Entry, sent: Sent) => {
      const question = confirms.get(entry);
      if (question && writer.count(sent) < (sizes?.get(entry) ?? 1))
        throw this.#absent(question);
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
    let told: Set<Entry> | undefined;
    /**
     * The reads of one row that find it gone are answered by what the row's
     * own write said of it: something noted between them may remove the row,
     * and the call answers with the row it wrote.
     */
    let spare: Map<Entry, Extract<Entry, { kind: "read" }>> | undefined;
    let spared: Map<Entry, Sent> | undefined;
    for (let place = this.#sent; place < to; place++) {
      const read = log[place]!;
      if (!(read.kind === "read" && read.projection && read.rows.length === 1))
        continue;
      const [row] = read.rows;
      const { model } = read;
      let changed = false;
      for (let at = place - 1; at >= this.#sent; at--) {
        const entry = log[at]!;
        if (
          (entry.kind === "insert" || entry.kind === "update") &&
          entry.row === row
        ) {
          if (
            !(own.has(entry) || spare?.has(entry)) &&
            (at === place - 1 || returningSafeProjection(read.projection)) &&
            (entry.kind === "insert" || entry.hears.length === 0) &&
            this.operation.answersInStatement(
              model,
              read.projection,
              entry.kind,
              entry.kind === "update" ? entry.set : undefined
            )
          ) {
            if (changed) {
              if (entry.kind === "update")
                (spare ??= new Map()).set(entry, read);
            } else {
              own.set(entry, { read, place });
              (told ??= new Set()).add(read);
            }
          }
          break;
        }
        // What may change the row between its write and its read.
        const touched =
          entry.kind === "all" || entry.kind === "either"
            ? entry.question.model
            : entry.kind === "delete" || entry.kind === "update"
              ? this.#about(entry.row).model
              : undefined;
        if (
          touched === model ||
          (touched && dependentsOf(schema, touched).has(model))
        )
          changed = true;
      }
    }
    /** The read of rows that follows `at`, where the statement that writes those rows may answer it. */
    const answered = (
      at: number,
      rows: readonly Row[],
      effect: "insert" | "delete"
    ) => {
      const next = log[at];
      return at < to &&
        next?.kind === "read" &&
        next.projection &&
        next.rows.length === rows.length &&
        next.rows.every((row, place) => row === rows[place]) &&
        this.operation.answersInStatement(next.model, next.projection, effect)
        ? next
        : undefined;
    };
    for (const [answer, at] of this.#used) {
      // Rows read where what is read is held are not asked again.
      if (holds) continue;
      {
        const { model, where } = answer.question;
        const keys = (at > to ? [] : answer.rows)
          .filter(
            (values) => !passed(this.#known.get(this.#name(model, values)))
          )
          // By its key, and by every value of it no other row may have: what the call may have given another row to hold. A value it does not have names no row.
          .map((values) =>
            Object.fromEntries(
              [
                ...new Set([
                  ...schema.keys(model),
                  ...getModelKeyCatalog(model)
                    .referenceableKeys.flat()
                    .filter((field) => (values[field] ?? null) !== null),
                ]),
              ].map((field) => [field, values[field]])
            )
          );
        const key = keys.length === 1 ? keys[0] : keys;
        if (keys.length === 0) continue;
        // A unit that writes nothing but the rows it read, each once, says again in each write what the row was found by; any other holds the rows it read from where it asks for them.
        const held = !(
          writes === answer.rows.length &&
          answer.rows.every((values) => {
            const first = firstOf(this.#known.get(this.#name(model, values))!);
            return (
              (first?.kind === "update" || first?.kind === "delete") &&
              span.includes(first)
            );
          })
        );
        if (made(answer.question, at))
          later.push([
            at,
            () => ask(answer.question, text(where), "read", key, at, held),
          ]);
        else ask(answer.question, text(where), "read", key, undefined, held);
      }
    }
    later.sort(([a], [b]) => a - b);
    for (let at = this.#sent; at < to; at++) {
      const entry = log[at]!;
      const place = at;
      while (later.length > 0 && later[0]![0] <= at) later.shift()![1]();
      current = entry;
      /** The entries that follow `entry` and travel with it. */
      const beside = <T extends Entry>(same: (next: T) => boolean): T[] => {
        const run = [entry as T];
        while (
          at + 1 < to &&
          log[at + 1]!.attempt === entry.attempt &&
          // What is asked for at a place is asked before what is written there.
          !(later.length > 0 && later[0]![0] <= at + 1) &&
          same(log[at + 1] as T)
        )
          run.push(log[++at] as T);
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
        const { model } = this.#about(entry.row);
        const { decided } = entry;
        const settled = (row: Row): Input => {
          const computes = this.#about(row).born;
          /** What the statement does not write of the row: what it holds no value of, and what the database decides of it. */
          const left = (value: unknown) =>
            value === undefined ||
            (value instanceof Pending && value.row === row);
          // Most rows are written as they are.
          let whole = !computes;
          for (const field in row) whole &&= !left(row[field]);
          if (whole) return row;
          const values: Input = {};
          for (const field in row) {
            // What is computed where the row is written is written as what computes it.
            const value = computes?.[field] ?? row[field];
            if (!left(value)) values[field] = value;
          }
          return values;
        };
        const columns = Object.keys(settled(entry.row));
        const fits = (rows: Row[], next: Entry | undefined) =>
          next?.kind === "insert" &&
          this.#about(next.row).model === model &&
          next.relation === entry.relation &&
          writer.beside(model, columns, rows.length, settled(next.row));
        let rows = [entry.row];
        const mine = own.get(entry);
        // The rows written side by side that the read after them asks for, and nothing else of what the database decides of them: their statement answers it.
        let end = at + 1;
        while (!mine && end < to && fits(rows, log[end]))
          rows.push((log[end++] as typeof entry).row);
        let read = mine?.read ?? answered(end, rows, "insert");
        // Another statement needs what the database decides of the row: its statement says it beside the answer, where it can.
        const both = Boolean(mine) && wanted(entry.row);
        if (
          mine &&
          both &&
          !(holds && returningSafeProjection(mine.read.projection!))
        ) {
          told?.delete(mine.read);
          read = undefined;
        } else if (mine) rows = [entry.row];
        else if (read && !rows.some(wanted)) at = end;
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
        // A provider whose writes say nothing says one thing of a row it creates: the number it gave it.
        if (hears && decided.length > 1 && !writer.says)
          throw new Error(
            "Returning generated values requires RETURNING support or one generated increment field"
          );
        if (hears && last && !holds)
          scratch ??= { id: crypto.randomUUID(), model };
        push({
          write: async () => {
            const insert = (returns?: PreparedProjection) =>
              writer.insert(
                model,
                rows.map((row) => this.#said(settled(row))),
                entry.relation,
                returns,
                read && hears ? decided : undefined,
                // Where an insert can pass a taken key by and say so, the first row of a part undone alone does: nothing fails, and nothing is undone.
                entry.root && writer.passes
              );
            const kept =
              scratch &&
              hears &&
              !read &&
              writer.kept(scratch.id, `${place}`, decided, await insert());
            if (!kept)
              return [
                await insert(
                  read?.projection ??
                    (hears ? writer.fields(model, decided) : undefined)
                ),
              ];
            entry.row[decided[0]!] = kept.value;
            return kept.statements;
          },
          take: (sent) => {
            if (entry.root && writer.passes && sent[0]!.rows.length === 0)
              throw PASSED;
            take(sent);
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
        if (run.length > 1) (sizes ??= new Map()).set(entry, run.length);
        const mine = run.length === 1 ? own.get(entry) : undefined;
        if (!mine && own.has(entry)) told?.delete(own.get(entry)!.read);
        const read = mine?.read;
        const kept = hears.length === 0 ? spare?.get(entry) : undefined;
        let asked = false;
        let named: Question | undefined;
        push({
          confirms: confirms.has(entry),
          write: async () => {
            const set = this.#said(entry.set);
            const first =
              hears.length > 0 &&
              writer.computes(under(entry), this.#said(entry.key), set);
            asked = Boolean(first);
            named = under(entry, run);
            return [
              ...(first ? [first] : []),
              await writer.update(
                named,
                set,
                keyed(run),
                read?.projection ??
                  kept?.projection ??
                  (hears.length > 0 && !first ? writer.key(model) : undefined),
                // Counted where its count is what says the rows were there, or still answered.
                confirms.has(entry) || named.again
              ),
            ];
          },
          take: read
            ? tells(read, mine!.place)
            : (sent) => {
                if (kept) (spared ??= new Map()).set(kept, sent.at(-1)!);
                take(asked ? sent.slice(0, 1) : sent);
                if (writer.counts("update"))
                  consumed(named!, run.length, sent.at(-1));
              },
        });
      } else if (entry.kind === "delete") {
        const { model } = entry.question;
        const run = beside<Extract<Entry, { kind: "delete" }>>(
          (next) =>
            next.kind === "delete" &&
            next.question.model === model &&
            mates(entry, next)
        );
        if (run.length > 1) (sizes ??= new Map()).set(entry, run.length);
        const named = under(entry, run);
        push({
          confirms: confirms.has(entry),
          write: () => [
            writer.remove(
              named,
              keyed(run),
              undefined,
              confirms.has(entry) || named.again
            ),
          ],
          take: (sent) => {
            take(sent);
            consumed(named, run.length, sent[0]);
          },
        });
      } else if (
        entry.kind === "all" ||
        entry.kind === "skipping" ||
        entry.kind === "either"
      )
        push({ write: () => this.#whole(entry), take });
      else if (entry.kind === "link") {
        // Links of a junction that only joins two rows travel together.
        const plain = (link: typeof entry) =>
          !(link.through || link.edge.declared || link.edge.uniqueSide);
        const run = beside<typeof entry>(
          (next) =>
            next.kind === "link" &&
            next.edge === entry.edge &&
            plain(entry) &&
            plain(next)
        );
        push({
          write: () =>
            writer.link(
              entry.edge,
              run.map(
                (next) =>
                  [this.#said(next.keys[0]), this.#said(next.keys[1])] as const
              ),
              entry.through
            ),
        });
      } else if (entry.kind === "unlink")
        push({
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
        push({
          write: () => [
            {
              ...writer.none(this.#asked(entry.question), entry.stops),
              ...(entry.believed && { believed: "read" as const }),
            },
          ],
        });
      else if (!told?.has(entry)) {
        // A row read as it goes is answered by the statement that removes it.
        const removal = log[at + 1];
        if (
          at + 1 < to &&
          removal?.kind === "delete" &&
          answered(at, [removal.row], "delete")
        ) {
          at++;
          push({
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
        push({
          write: () => {
            queries = entry.queries();
            return queries.map((query) => ({
              sql: query.sql,
              model: entry.model,
            }));
          },
          take: (sent) =>
            take(
              spared?.has(entry) && sent.every((each) => each.rows.length === 0)
                ? [spared.get(entry)!]
                : sent,
              queries
            ),
        });
      }
    }
    // What is asked for behind the unit's last write.
    for (const [, run] of later) run();
    if (scratch) {
      const { open, close } = writer.scratch(scratch.id, scratch.model);
      steps.unshift({ write: () => open });
      steps.push({ write: () => [close] });
    }
    this.#sent = Math.max(this.#sent, to);
    return steps;
  }
  /** The statements of a write that names its rows itself. */
  async #whole(
    entry: Extract<Entry, { kind: "all" | "skipping" | "either" }>
  ): Promise<Statement[]> {
    const { writer } = this;
    if (entry.kind === "all")
      return [
        entry.set
          ? await writer.update(
              this.#asked(entry.question),
              this.#said(entry.set),
              undefined,
              entry.projection
            )
          : writer.remove(
              this.#asked(entry.question),
              undefined,
              entry.projection
            ),
      ];
    if (entry.kind === "either")
      return [
        await writer.either(
          entry.question,
          this.#said(entry.row),
          this.#said(entry.set),
          entry.projection,
          entry.marker
        ),
      ];
    // As many statements as the rows' shapes and the provider's bound on one statement ask.
    const chunks: Input[][] = [];
    let columns: string[] = [];
    for (const row of entry.rows) {
      const chunk = chunks.at(-1);
      if (chunk && writer.beside(entry.model, columns, chunk.length, row))
        chunk.push(row);
      else {
        chunks.push([row]);
        columns = Object.keys(row);
      }
    }
    return Promise.all(
      chunks.map((chunk) =>
        writer.insert(
          entry.model,
          chunk.map((row) => this.#said(row)),
          undefined,
          entry.projection,
          undefined,
          entry.passes
        )
      )
    );
  }
  /**
   * Sends the steps of a unit. A statement that needs a value the database
   * has not said yet is written once what stands before it is sent and
   * heard.
   */
  async #deliver(
    steps: Step[],
    last: boolean,
    within?: Transport["send"]
  ): Promise<void> {
    const send = within ?? this.#transport.send;
    let waiting: { statements: Statement[]; step: Step }[] = [];
    const flush = async (end: boolean) => {
      const told = waiting;
      waiting = [];
      // One step's statements are sent as they are, and its answers taken so.
      const one = told.length === 1;
      const statements = one
        ? told[0]!.statements
        : told.flatMap((written) => written.statements);
      const sent = statements.length > 0 ? await send(statements, end) : [];
      this.said ||= end && !within;
      let at = 0;
      const parts = told.map(({ statements: own }) =>
        one ? sent : sent.slice(at, (at += own.length))
      );
      // What was written outside a unit the call can undo is made, where a row was written.
      if (
        !within &&
        this.#transport.loose &&
        told.some(
          ({ step }, place) =>
            step.writes &&
            parts[place]!.some(
              (each) => each.rowCount > 0 || each.rows.length > 0
            )
        )
      )
        this.segments++;
      for (let place = 0; place < told.length; place++)
        told[place]!.step.take?.(parts[place]!);
    };
    // What a statement asks while it is written is asked once what stands before it is sent.
    const outer = this.#hear;
    // Named before it is stored: a function written where it is assigned to a field is kept past the next collection, with all it holds.
    const hear = async (statement: Statement) => {
      await flush(false);
      return (await send([statement], false))[0]!.rows;
    };
    this.#hear = hear;
    try {
      for (let at = 0; at < steps.length; at++) {
        const step = steps[at]!;
        // A part undone alone is sent alone: whether it was written is noted.
        if (!within && step.attempt !== undefined) {
          await flush(false);
          const part = [step];
          while (steps[at + 1]?.attempt === step.attempt)
            part.push(steps[++at]!);
          const written = await this.#attempted(part);
          (this.#outcomes ??= new Map()).set(step.attempt, written);
          continue;
        }
        let statements: Statement[];
        try {
          statements = await step.write();
        } catch (error) {
          if (error !== UNHEARD) throw error;
          await flush(false);
          // What the database decided of a row is asked for again where a unit made after it writes it into other rows: on a transport that holds nothing, another writer may have changed the row since.
          const waited = this.#waited;
          this.#waited = undefined;
          if (waited && !(within || this.#transport.holds))
            waiting.push({
              statements: [
                this.writer.still(this.#about(waited.row).model, {
                  ...this.#key(waited.row),
                  [waited.field]: waited.row[waited.field],
                }),
              ],
              step: STILL,
            });
          statements = await step.write();
        }
        waiting.push({ statements, step });
        // Where each statement is heard as it is sent, what says whether a row is there is taken before the next is written: a row that is not there refuses the call before anything under it does.
        if (
          within
            ? step.root && this.writer.passes
            : this.#transport.holds && step.confirms
        )
          await flush(last && at === steps.length - 1);
      }
      await flush(last);
    } finally {
      this.#hear = outer;
    }
  }
  /** Sends a part of the unit that is undone alone where the database refuses its first row as one too many: whether it was written. */
  async #attempted(part: Step[]): Promise<boolean> {
    let first: Statement | undefined;
    const told = part.map((step) =>
      step.root
        ? {
            ...step,
            write: async () => {
              const statements = await step.write();
              [first] = statements;
              return statements;
            },
          }
        : step
    );
    try {
      await this.#transport.attempt!((send) =>
        this.#deliver(told, false, send)
      );
      return true;
    } catch (error) {
      if (
        error === PASSED ||
        (error instanceof UniqueConstraintError &&
          first &&
          refusedBy.get(error) === first)
      )
        return false;
      throw error;
    }
  }
}
