/**
 * PROTOTYPE (analysis only, not for merge): a write as statements over sets of
 * rows. A second foundation, beside `plan/write.ts`, to measure what one more
 * thing costs once the costly axes are primitives.
 *
 * SIX PRIMITIVES, and a verb is none of them: it composes them.
 * - {@link Rows}: rows of one model named by a query; by their keys once the
 *   call knows them. One row is a set of which one member is asked.
 * - a requirement: what a statement asks of its rows, with what it reports
 *   where they are not so, as data ({@link Statement.failure}).
 * - {@link Writer}: the one place a statement is written. It reads the call's
 *   row scope and the provider's capabilities. A verb says what it writes,
 *   never who may.
 * - learning: a statement whose answer the call awaits to go on
 *   ({@link Run.learn}).
 * - {@link Run}: the statements waiting to be sent, cut where the call
 *   learns; a {@link Transport} says how a unit of them reaches the database.
 * - {@link joined}: how a row is made a member of a relation, by its storage.
 *
 * THREE RULES.
 * 1. Rows are named by their query until their first write, by their keys
 *    after it. The keys are learned in one read, held where the unit holds.
 * 2. A statement suffices by itself: it names its rows and carries what it
 *    asks. A sealed batch and a dialogue send the same statements.
 * 3. A verb names no transport and no row scope.
 */
import type { AnyDriver } from "@drivers";
import { attachCommitCertainty } from "@drivers/driver-error-context";
import {
  bindExecutionTransactionPhases,
  deriveStatementExecutionContext,
} from "@drivers/execution-context";
import { transferPreparedStatement } from "@drivers/prepared-statement-provenance";
import type { QueryExecutionContext } from "@drivers/types";
import { isVibORMError, NestedWriteAssertionError } from "@errors";
import type { AnyModel } from "@schema/model";
import { type Sql, sql } from "@sql";
import { createFailureError } from "../../batch-error-attribution";
import type { PreparedBatchOperation, PreparedGuardFailure } from "../../types";
import { writeSinks } from "../../write-sinks";
import { InsertValue, JoinedValue } from "../shared/insert-value";
import {
  type ExecutionBinding,
  nestedRefusal,
} from "../shared/operation-context";
import type { PreparedSelector, Query } from "../shared/query";
import { Parameter, parseStamped } from "../shared/row-scope";
import type { Arguments, Input } from "../shared/schema";
import type { SqlOperationContext } from "../shared/sql-operation-context";
import type { SqlQueries } from "../shared/sql-queries";
import { linkJudgement, type Membership } from "../shared/storage";

/** Thrown, before anything is written, by a call the prototype does not cover: the shipped engine runs it. */
export const OUTSIDE = Symbol("outside what the foundation covers");
const outside = (): never => {
  throw OUTSIDE;
};

/**
 * Rows of one model, named by a query: what the caller says of them, and
 * their keys besides once the call knows them.
 */
interface Rows {
  readonly model: AnyModel;
  readonly where?: Input;
  /** No more than that many of them, the first by their key. */
  readonly limit?: number;
  readonly keys?: readonly Input[];
}

/** What the database says of one statement. */
interface Sent {
  readonly rows: Input[];
  readonly rowCount: number;
}

/** One statement, which suffices by itself. */
interface Statement {
  readonly sql: Sql;
  /** What it reports where it stops its unit: it asks something of its rows, or judges the rows it would leave. */
  readonly failure?: PreparedGuardFailure;
  /** Its question by itself, where a provider does not say which statement stopped a batch. */
  readonly probe?: Sql;
  /** The answer a question asked for its own sake needs. */
  readonly premise?: "exists" | "notExists";
}

/** What the fields and relations a write writes are judged as; none where it writes nothing of its rows. */
type Writes = readonly string[] | undefined;

/** The one place a statement is written: under the call's row scope, in the provider's spelling. */
class Writer {
  readonly #operation: SqlOperationContext;
  readonly #q: SqlQueries;
  constructor(operation: SqlOperationContext) {
    this.#operation = operation;
    this.#q = operation.queries as SqlQueries;
  }
  /** The rows as a write of `writes` names them: among those the call may write so. */
  #named(rows: Rows, writes: Writes): PreparedSelector {
    const q = this.#q;
    const { model, keys } = rows;
    const own = q.prepareSelector(model, rows.where, false);
    return q.candidates(
      keys
        ? q.andSelectors(model, [own, q.includeIdentities(model, keys)])
        : own,
      "root",
      undefined,
      writes && { verb: "update", writes }
    );
  }
  /** The rows a link through `edge` reaches, as the call names one: among those it may link so. */
  #reached(edge: Membership, target: Rows): PreparedSelector {
    const q = this.#q;
    return q.candidates(
      target.keys
        ? q.includeIdentities(edge.target, target.keys)
        : q.prepareSelector(edge.target, target.where, true),
      "related",
      undefined,
      linkJudgement(edge)
    );
  }
  /**
   * What makes rows members through a junction: each row of `target` of the
   * row of `parent` it stands beside, or the one row `target` names of every
   * row of `parent`. A link is added where it is not there. A row the call
   * names must be there, among those it may link: `verb` refuses it where not.
   */
  link(edge: Junction, parent: Rows, target: Rows, verb?: string): Statement[] {
    const q = this.#q;
    const { assertions, identifiers, mutations } =
      this.#operation.driver.adapter;
    const selector = this.#reached(edge, target);
    const sides = [
      [edge.sourceSide, parent.keys!],
      [edge.targetSide, target.keys],
    ] as const;
    const columns = sides.flatMap(([side]) =>
      side.members.map((pair) => pair.junctionField)
    );
    const probe =
      verb &&
      q.select(edge.target, { take: 1 }, undefined, {
        projection: this.#key(edge.target),
        selector,
      }).sql;
    return [
      ...(probe
        ? [
            {
              sql: assertions.exists(probe),
              probe,
              premise: "exists" as const,
              failure: {
                kind: "nestedWrite" as const,
                relation: edge.name,
                message: `Cannot ${verb} relation '${edge.name}': target record was not found.`,
                raceable: false,
              },
            },
          ]
        : []),
      ...mutations
        .insertAbsent(
          identifiers.table(edge.table),
          columns,
          parent.keys!.map((_, row) =>
            sides.flatMap(([side, keys]) =>
              side.members.map((pair) =>
                // A row the call does not know by its key is read where the link is written.
                keys
                  ? q.fieldValue(
                      side.model,
                      pair.referencedField,
                      keys[row]![pair.referencedField]
                    )
                  : q.locatedValue(side.model, pair.referencedField, selector)
              )
            )
          ),
          columns
        )
        .map((statement) => ({ sql: statement })),
    ];
  }
  #key(model: AnyModel) {
    return this.#q.prepareProjection(
      model,
      {
        select: Object.fromEntries(
          this.#operation.schema.keys(model).map((field) => [field, true])
        ),
      },
      true
    );
  }
  /** The keys of the rows, read; held where `hold`. */
  keys(rows: Rows, writes: Writes, hold: boolean): Query {
    return this.#q.select(
      rows.model,
      rows.limit === undefined ? {} : { take: rows.limit },
      undefined,
      {
        forUpdate: hold,
        projection: this.#key(rows.model),
        selector: this.#named(rows, writes),
      }
    );
  }
  /** Each row the call knows by its key, asked to be what the rows' query names still. */
  pinned(rows: Rows, writes: Writes): Statement[] {
    const { assertions } = this.#operation.driver.adapter;
    return rows.keys!.map((key) => {
      const probe = this.#q.select(rows.model, { take: 1 }, undefined, {
        projection: this.#key(rows.model),
        selector: this.#named({ ...rows, keys: [key] }, writes),
      }).sql;
      return {
        sql: assertions.exists(probe),
        probe,
        premise: "exists",
        failure: {
          kind: "notFound",
          message: "a row the call read is no longer what it wrote it as",
          raceable: true,
        },
      };
    });
  }
  /** The rows take `values`; the statement refuses the rows it would leave where the call may not leave them so. */
  async update(rows: Rows, values: Input, writes: Writes): Promise<Statement> {
    const q = this.#q;
    const { model, limit } = rows;
    const { mutations } = this.#operation.driver.adapter;
    const [set] = await this.#operation.computed(model, [values], false);
    const selector = this.#named(rows, writes);
    const judged = writes && { verb: "update" as const, writes };
    let failure: PreparedGuardFailure | undefined;
    const statement = q.sharing(() => {
      const produced =
        judged &&
        q.domain &&
        q.producedWhere(
          model,
          (alias) => q.lowerSelector(selector, alias),
          set!,
          q.domain.produced(model, judged, Object.keys(set!)),
          q.domain.cycles(model, judged),
          limit
        );
      if (produced) failure = this.#operation.refusalOf(model, judged);
      const named = produced
        ? { where: produced, suffix: undefined }
        : q.lowerMutationLimit(model, selector, limit);
      const update = mutations.update(
        q.table(model),
        sql.join(
          Object.entries(set!).map(([field, value]) =>
            q.updateAssignment(model, field, value)
          ),
          ", "
        ),
        named.where
      );
      return named.suffix ? sql`${update} ${named.suffix}` : update;
    });
    return { sql: statement, failure };
  }
  /**
   * What a row of `model` takes where it is created, or updated: what was
   * admitted of what the caller wrote of it, `raw`, and what the call's
   * extensions write of every such row, where the caller wrote nothing.
   */
  values(
    model: AnyModel,
    kind: "create" | "update",
    admitted: Input,
    raw: Input
  ): Input {
    const { scope, schema } = this.#operation;
    const kept: Input = {};
    const computed: Input = {};
    for (const [field, value] of Object.entries(
      scope?.rows.stamps?.get(model["~"].names.ts!)?.[kind] ?? {}
    ))
      if (raw[field] === undefined)
        // A value computed where the row is written is no data to admit; a
        // parameter is the call's one instant.
        (value instanceof InsertValue ? computed : kept)[field] =
          value instanceof Parameter ? scope!.instant() : value;
    if (Object.values(computed).some((value) => value instanceof JoinedValue))
      outside();
    // Admitted as the caller's own would be, where there is something to admit.
    let written: Input = {};
    if (Object.keys(kept).length > 0)
      written =
        kind === "create"
          ? schema.createValues(model, kept)
          : schema.update(model, kept, true);
    return schema.scalars(model, {
      ...admitted,
      ...Object.fromEntries(
        Object.keys(kept).map((field) => [field, written[field]])
      ),
      ...computed,
    });
  }
  /** Whether `row` travels in the statement that inserts `rows`: the same columns, within what the provider binds in one statement. */
  beside(model: AnyModel, rows: readonly Input[], row: Input): boolean {
    const q = this.#q;
    const fields = Object.keys(row);
    const placed = q.domain?.produced(model);
    return (
      fields.join() === Object.keys(rows[0]!).join() &&
      (rows.length + 1) * fields.length +
        ((placed && q.lowerSelector(placed)?.values.length) ?? 0) <=
        (this.#operation.driver.maxBindParametersPerStatement ??
          Number.POSITIVE_INFINITY)
    );
  }
  /** Rows of `model`; where the call may not create one, the statement refuses it, in the name of `relation` where they are created through one. */
  async insert(
    model: AnyModel,
    values: Input[],
    relation?: string
  ): Promise<Statement> {
    const q = this.#q;
    const rows = await this.#operation.computed(model, values, false);
    const fields = Object.keys(rows[0]!);
    if (fields.length === 0) outside();
    const placed = q.domain?.produced(model);
    const select = placed && q.producedSource(model, fields, rows, placed);
    return {
      sql: this.#operation.driver.adapter.mutations.insert(
        q.table(model),
        fields.map((field) => q.columnName(model, field)),
        select
          ? { select }
          : rows.map((row) =>
              fields.map((field) => q.fieldValue(model, field, row[field]))
            )
      ),
      ...(select && {
        probe: select,
        failure:
          relation === undefined
            ? this.#operation.refusalOf(model)
            : nestedRefusal("create", relation),
      }),
    };
  }
  /**
   * A write as it answers: with the rows it wrote as `select` reads them, or
   * so that the call can count them, where the provider's own count would
   * count what a cascade changed besides.
   */
  answering(model: AnyModel, statement: Statement, select?: Input): Statement {
    const { capabilities, mutations } = this.#operation.driver.adapter;
    if (select && !capabilities.supportsReturning) outside();
    if (select)
      return {
        ...statement,
        sql: this.#operation.answering(
          model,
          statement.sql,
          this.#q.prepareProjection(model, { select })
        ),
      };
    return capabilities.countsCascadedChanges
      ? {
          ...statement,
          sql: sql`${statement.sql} ${mutations.returning(sql.raw("1"))}`,
        }
      : statement;
  }
  /** How many rows a write that answers so wrote. */
  count(sent: Sent): number {
    return this.#operation.driver.adapter.capabilities.countsCascadedChanges
      ? sent.rows.length
      : sent.rowCount;
  }
}

/** A statement with the model it is sent in the name of. */
type Sending = Statement & { readonly model: AnyModel };

/** What waits to be sent: a statement, or rows to insert, which the next ones of their model may join. */
interface Waiting {
  readonly model: AnyModel;
  readonly statement?: Statement;
  readonly rows?: Input[];
  readonly relation?: string;
  sent?: Sent;
}

/** How a unit of the call's statements reaches the database. */
interface Transport {
  /** Rows the call read are held until its unit ends: no statement asks for them again. */
  readonly holds: boolean;
  /** Sends statements that go together and answers for each; `last` where the call has no more to say. */
  send(statements: readonly Sending[], last: boolean): Promise<Sent[]>;
  /** Ends the unit: undone where the call `failed`. */
  end(failed?: unknown): Promise<void>;
}

/** The answer of a statement: awaited, it sends what waits; or read once the call has sent. */
interface Asked extends PromiseLike<Sent> {
  answer(): Sent;
}

/** The call's statements, sent together as far as the call does not need an answer to go on. */
class Run {
  readonly #operation: SqlOperationContext;
  readonly #transport: Transport;
  readonly #writer: Writer;
  readonly #waiting: Waiting[] = [];
  constructor(
    operation: SqlOperationContext,
    transport: Transport,
    writer: Writer
  ) {
    this.#operation = operation;
    this.#transport = transport;
    this.#writer = writer;
  }
  send(model: AnyModel, statement: Statement): Asked {
    const waiting: Waiting = { model, statement };
    this.#waiting.push(waiting);
    return {
      answer: () => waiting.sent!,
      then: (heard, failed) =>
        this.flush()
          .then(() => waiting.sent!)
          .then(heard, failed),
    };
  }
  /** The statements that wait, as written, and where to tell their answers: to who sends them. */
  async rest(): Promise<{
    statements: Sending[];
    heard(answers: readonly Sent[]): void;
  }> {
    const waiting = this.#waiting.splice(0);
    const statements: Sending[] = [];
    for (const { model, statement, rows, relation } of waiting)
      statements.push({
        ...(statement ?? (await this.#writer.insert(model, rows!, relation))),
        model,
      });
    return {
      statements,
      heard: (answers) => {
        for (const [at, sent] of answers.entries()) waiting[at]!.sent = sent;
      },
    };
  }
  async flush(last = false): Promise<void> {
    const { statements, heard } = await this.rest();
    if (statements.length > 0)
      heard(await this.#transport.send(statements, last));
  }
  /** A row created: beside the rows of its model that wait just before it, where one statement holds them. */
  insert(model: AnyModel, row: Input, relation?: string): void {
    const last = this.#waiting.at(-1);
    if (
      last?.rows &&
      last.model === model &&
      last.relation === relation &&
      this.#writer.beside(model, last.rows, row)
    )
      last.rows.push(row);
    else this.#waiting.push({ model, relation, rows: [row] });
  }
  /** Rows the call must know to go on: read now, held where the unit holds. */
  async learn(read: (hold: boolean) => Query, model: AnyModel) {
    const query = read(this.#transport.holds);
    const { rows } = await this.send(model, { sql: query.sql });
    return this.#operation.queries.decodeQuery(query, rows, true);
  }
  /** What a unit that does not hold the rows it learned asks of them before it writes. */
  pin(model: AnyModel, asked: () => Statement[]): void {
    if (this.#transport.holds) return;
    for (const statement of asked()) this.send(model, statement);
  }
}

/** The context one statement is sent under: the operation's, named for the model it touches. */
const contextOf = (
  operation: SqlOperationContext,
  model: AnyModel
): QueryExecutionContext => {
  const whole = operation.attribution;
  const name = model["~"].names.ts!;
  return whole.model === name
    ? whole
    : deriveStatementExecutionContext(whole, name);
};

const refusal = (operation: SqlOperationContext, statement: Sending): Error =>
  createFailureError(
    statement.failure!,
    statement.model["~"].names.ts!,
    operation.operation
  );

/**
 * A dialogue: each statement is sent once the one before answered, inside
 * the unit `open` opens. On `driver` itself where there is none to open, or
 * where the call is one statement.
 */
function dialogue(
  operation: SqlOperationContext,
  driver: AnyDriver,
  open?: (body: (inside: AnyDriver) => Promise<void>) => Promise<unknown>
): Transport {
  let entered: Promise<AnyDriver> | undefined;
  let unit: Promise<unknown> | undefined;
  let leave: (failed?: unknown) => void;
  const enter = () =>
    (entered ??= new Promise<AnyDriver>((inside, refused) => {
      unit = open!(
        (transport) =>
          new Promise<void>((done, undo) => {
            leave = (failed) => (failed === undefined ? done() : undo(failed));
            inside(transport);
          })
      );
      unit.catch(refused);
    }));
  return {
    holds: true,
    async send(statements, last) {
      const transport =
        !open || (last && !entered && statements.length === 1)
          ? driver
          : await enter();
      const answers: Sent[] = [];
      for (const statement of statements)
        answers.push(
          await transport
            ._execute<Input>(
              statement.sql,
              contextOf(operation, statement.model)
            )
            .catch((error) => {
              throw statement.failure &&
                error instanceof NestedWriteAssertionError
                ? refusal(operation, statement)
                : error;
            })
        );
      return answers;
    },
    async end(failed) {
      if (!entered) return;
      leave(failed);
      await (failed === undefined ? unit : unit!.catch(() => undefined));
    },
  };
}

/** One statement as a batch takes it. */
const prepared = (
  operation: SqlOperationContext,
  driver: AnyDriver,
  statement: Sending
) => {
  const at = contextOf(operation, statement.model);
  const query = driver._prepare(statement.sql, at);
  return transferPreparedStatement(query, {
    sql: query.sql,
    params: query.params ?? [],
    context: at,
  });
};

/** Atomic batches: the statements that go together are one batch, durable once it answers. */
function batches(operation: SqlOperationContext, driver: AnyDriver): Transport {
  return {
    holds: false,
    async send(statements) {
      const [alone] = statements;
      try {
        return statements.length === 1
          ? [
              await driver._execute<Input>(
                alone!.sql,
                contextOf(operation, alone!.model)
              ),
            ]
          : await driver._executeBatch<Input>(
              statements.map((statement) =>
                prepared(operation, driver, statement)
              ),
              undefined,
              operation.attribution
            );
      } catch (error) {
        if (!(error instanceof NestedWriteAssertionError)) throw error;
        // The statement that stopped the batch is the one the provider
        // points at. Where it points at none, each question is asked again,
        // in order; where all still hold, it is the first that judged its
        // rows amid the batch's writes.
        const index = error.meta.statementIndex;
        let stopped = typeof index === "number" ? statements[index] : undefined;
        if (!stopped) {
          // What was asked for its own sake is asked again together.
          const asked = statements.filter((statement) => statement.premise);
          const answers =
            asked.length > 0
              ? await this.send(
                  asked.map(({ probe, model }) => ({ sql: probe!, model })),
                  false
                )
              : [];
          stopped = asked.find(
            ({ premise }, at) =>
              answers[at]!.rows.length > 0 !== (premise === "exists")
          );
          // A judgement asked again stops as its statement did.
          for (const statement of stopped ? [] : statements) {
            if (statement.premise || !statement.probe) continue;
            stopped = await this.send(
              [{ sql: statement.probe, model: statement.model }],
              false
            ).then(
              () => undefined,
              () => statement
            );
            if (stopped) break;
          }
        }
        stopped ??= statements.find(
          (statement) => statement.failure && !statement.probe
        );
        throw stopped?.failure ? refusal(operation, stopped) : error;
      }
    },
    end: async () => undefined,
  };
}

/** What one call plans with. */
interface Call {
  readonly operation: SqlOperationContext;
  readonly writer: Writer;
  readonly run: Run;
  /** What the caller wrote of each node of what was admitted of it ({@link paired}). */
  readonly said: WeakMap<object, unknown>;
}

/**
 * Notes, of each node of `admitted`, the node of `raw` it was read from. One
 * entry is written as itself, or as the list of one.
 */
function paired<T>(admitted: T, raw: unknown, said: Call["said"]): T {
  if (typeof admitted === "object" && admitted) {
    said.set(admitted, raw);
    for (const [key, child] of Object.entries(admitted)) {
      const next = (raw as Input | undefined)?.[key];
      paired(child, next === undefined && key === "0" ? raw : next, said);
    }
  }
  return admitted;
}

type Junction = Extract<Membership, { kind: "junction" }>;

/** Whether what a relation asks writes the row it is asked of: it holds the key, or the link is its own. */
const touches = (edge: Membership): boolean => {
  if (edge.discriminator) return outside();
  if (edge.kind === "junction")
    return edge.declared || edge.uniqueSide ? outside() : true;
  return edge.owner === "target" ? false : outside();
};

/** What a row holds that makes it a member of the row `key` names, through `edge`. */
const joined = (edge: Membership, key: Input): Input =>
  touches(edge) || edge.kind !== "reference"
    ? {}
    : Object.fromEntries(
        edge.pairs.map((pair) => [pair.target, key[pair.source] ?? outside()])
      );

const list = (value: unknown): unknown[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
};

/**
 * Makes rows that are there members through `edge`: each row of `target` of
 * the row of `parent` it stands beside, or the one row the call names, with
 * `verb`, of every row of `parent`. A row born a member holds what makes it
 * one.
 */
function join(
  call: Call,
  edge: Membership,
  parent: Rows,
  target: Rows,
  verb?: string
): void {
  if (edge.kind !== "junction") {
    if (verb) outside();
    return;
  }
  for (const statement of call.writer.link(edge, parent, target, verb))
    call.run.send(edge.source, statement);
}

/**
 * Rows created, one per entry, each holding besides what it is `given` to be
 * a member; then what their relations ask of the rows they reach from each.
 */
async function make(
  call: Call,
  model: AnyModel,
  entries: Input[],
  given: Input[],
  relation?: string
): Promise<Rows> {
  const { schema } = call.operation;
  const rows = entries.map((data, row) =>
    call.writer.values(
      model,
      "create",
      { ...data, ...given[row] },
      { ...(call.said.get(data) as Input), ...given[row] }
    )
  );
  for (const row of rows) call.run.insert(model, row, relation);
  const made: Rows = {
    model,
    keys: rows.map((row) => schema.identity(model, row)),
  };
  await related(call, made, entries);
  return made;
}

/**
 * A relation's verbs, in the order they take effect. Each is asked once of
 * all the rows of `parent`, with one entry of the payload as each row's own
 * copy states it.
 */
const verbs: Record<
  string,
  (
    call: Call,
    edge: Membership,
    parent: Rows,
    entry: (row: number) => Input
  ) => Promise<void>
> = {
  connect: async (call, edge, parent, entry) =>
    join(
      call,
      edge,
      parent,
      { model: edge.target, where: entry(0) },
      "connect"
    ),
  create: async (call, edge, parent, entry) =>
    join(
      call,
      edge,
      parent,
      await make(
        call,
        edge.target,
        parent.keys!.map((_, row) => entry(row)),
        parent.keys!.map((key) => joined(edge, key)),
        edge.name
      )
    ),
};

/** The relations `data` names of one row, each with what it asks. */
const relationsOf = (
  operation: SqlOperationContext,
  model: AnyModel,
  data: Input
) =>
  model["~"].relationNames.flatMap((name) => {
    const payload = data[name] as Input | undefined;
    if (payload === undefined) return [];
    if (Object.keys(payload).some((verb) => !(verb in verbs))) outside();
    return [{ name, payload, edge: operation.schema.membership(model, name) }];
  });

/**
 * What the relations ask of the rows they reach from `parent`'s, rows the
 * call knows: `copies` holds, for each, its own copy of what the caller
 * wrote, where what a default fills is that row's own.
 */
async function related(
  call: Call,
  parent: Rows,
  copies: Input[]
): Promise<void> {
  for (const { name, edge, payload } of relationsOf(
    call.operation,
    parent.model,
    copies[0]!
  ))
    for (const verb of Object.keys(verbs))
      for (const at of list(payload[verb]).keys())
        await verbs[verb]!(
          call,
          edge,
          parent,
          (row) => list((copies[row]![name] as Input)[verb])[at] as Input
        );
}

/**
 * Rows written: what `data` states of them, then what its relations ask of
 * each. One statement where nothing but the rows is written: it names them
 * itself, and `answers` what it wrote. Where more is, the rows are learned,
 * then written by their keys.
 */
async function write(
  call: Call,
  rows: Rows,
  data: Input,
  raw: Input,
  select?: Input
): Promise<{ rows: Rows; answers?: Asked }> {
  const { operation, writer, run } = call;
  const { schema } = operation;
  const { model } = rows;
  const values = writer.values(model, "update", data, raw);
  const relations = relationsOf(operation, model, data);
  const stated = [
    ...Object.keys(values).filter((field) => raw[field] !== undefined),
    ...relations.filter(({ edge }) => touches(edge)).map(({ name }) => name),
  ];
  const writes =
    stated.length + Object.keys(values).length > 0 ? stated : undefined;
  if (relations.length === 0)
    return {
      rows,
      answers: run.send(
        model,
        writer.answering(
          model,
          await writer.update(rows, values, writes),
          select
        )
      ),
    };
  const known: Rows = {
    model,
    where: rows.where,
    keys: await run.learn((hold) => writer.keys(rows, writes, hold), model),
  };
  if (known.keys!.length === 0) return { rows: known };
  run.pin(model, () => writer.pinned(known, writes));
  if (Object.keys(values).length > 0)
    run.send(model, await writer.update(known, values, writes));
  await related(
    call,
    { model, keys: known.keys },
    known.keys!.map((_, row) =>
      row === 0
        ? data
        : paired(
            parseStamped(operation.scope?.rows.stamps ?? new Map(), () =>
              schema.update(model, raw, true)
            ),
            raw,
            call.said
          )
    )
  );
  return { rows: known };
}

/** `updateMany`: the rows written, answered as the caller asked, or counted. */
async function updateMany(
  call: Call,
  model: AnyModel,
  args: Arguments,
  raw: Input
): Promise<() => unknown> {
  const { operation, run, writer } = call;
  const q = operation.queries;
  const select = args.select as Input | undefined;
  const projection = select && q.prepareProjection(model, { select });
  const data = args.data as Input;
  if (args.limit === 0 || Object.keys(data).length === 0)
    return () => (projection ? [] : { count: 0 });
  const { rows, answers } = await write(
    call,
    { model, where: args.where as Input, limit: args.limit as number },
    paired(data, raw.data, call.said),
    raw.data as Input,
    select
  );
  const { keys } = rows;
  // Rows written by their keys are read again once every one is written.
  const read =
    projection && keys?.length
      ? operation
          .seriesQueries(projection, [...keys], "updateMany")
          .map((query) => ({ query, asked: run.send(model, query) }))
      : [];
  return () => {
    if (!projection)
      return { count: keys ? keys.length : writer.count(answers!.answer()) };
    const returned = answers ? answers.answer().rows : [];
    for (const { query, asked } of read) {
      const { rows: again } = asked.answer();
      q.assertExpectedRows(query, again.length);
      returned.push(...again);
    }
    return q.decodeResult(returned, "updateMany", (decoded) =>
      q.decodeProjection(projection.shape, decoded)
    );
  };
}

/**
 * Plans one call for `transport`: what it must know is learned, the rest
 * waits in its run. Throws {@link OUTSIDE}, before anything is written, for a
 * call the prototype does not cover.
 */
async function planned(
  operation: SqlOperationContext,
  model: AnyModel,
  args: Arguments,
  raw: unknown,
  transport: Transport
) {
  if (
    operation.operation !== "updateMany" ||
    writeSinks.get(operation.attribution)
  )
    outside();
  // The call fails as a whole before it sends anything it cannot finish.
  relationsOf(operation, model, args.data as Input).map(({ edge }) =>
    touches(edge)
  );
  const writer = new Writer(operation);
  const run = new Run(operation, transport, writer);
  const answer = await updateMany(
    { operation, writer, run, said: new WeakMap() },
    model,
    args,
    raw as Input
  );
  return { run, answer };
}

/** A call sent by itself, or inside the transaction its caller lends it. */
export async function planSets(
  operation: SqlOperationContext,
  driver: AnyDriver,
  model: AnyModel,
  args: Arguments,
  raw: unknown,
  binding?: ExecutionBinding
): Promise<unknown> {
  const seam = binding?.writeOutcome;
  // The transaction says how far its commit went; the seam hears it once.
  let phase: "pending" | "ready" | "committed" = "pending";
  const at = contextOf(operation, model);
  let transport: Transport;
  if (binding?.kind === "borrowed-transaction") {
    const lent = binding.operationRegion;
    transport = dialogue(
      operation,
      binding.driver,
      lent && ((body) => lent(body, at))
    );
  } else if (driver.supportsTransactions)
    transport = dialogue(operation, driver, (body) =>
      driver.withTransaction(
        body,
        undefined,
        seam
          ? bindExecutionTransactionPhases(at, {
              readyToCommit: () => {
                phase = "ready";
              },
              committed: () => {
                phase = "committed";
              },
            })
          : at
      )
    );
  else transport = batches(operation, driver);
  let answer: () => unknown;
  try {
    const call = await planned(operation, model, args, raw, transport);
    answer = call.answer;
    await call.run.flush(true);
  } catch (error) {
    await transport.end(error);
    throw error;
  }
  try {
    await transport.end();
  } catch (error) {
    if (phase === "pending") throw error;
    const durable = phase === "committed";
    const primary = isVibORMError(error)
      ? attachCommitCertainty(
          error,
          durable ? "committed" : "may-have-committed"
        )
      : error;
    await operation.stateWriteOutcome(
      durable ? seam?.committedSegment : seam?.mayBeVisible,
      primary
    );
    throw primary;
  }
  await operation.stateWriteOutcome(seam?.committedSegment);
  return answer();
}

const SEVERAL = Symbol("more than one unit");

/**
 * A call as one unit its caller sends, among other calls' units: its
 * statements are handed over, each with what it reports where it stops the
 * unit. None where the call must hear the database to go on: what it would
 * read now, a call sent before it in the same unit may change.
 */
export async function prepareSets(
  operation: SqlOperationContext,
  driver: AnyDriver,
  model: AnyModel,
  args: Arguments,
  raw: unknown
): Promise<PreparedBatchOperation<unknown> | undefined> {
  try {
    const { run, answer } = await planned(operation, model, args, raw, {
      holds: false,
      send: () => Promise.reject(SEVERAL),
      end: async () => undefined,
    });
    const { statements, heard } = await run.rest();
    return {
      queries: statements.map((statement) =>
        prepared(operation, driver, statement)
      ),
      guards: statements.flatMap((statement, queryIndex) =>
        statement.failure
          ? [
              {
                queryIndex,
                premise: statement.premise ?? "exists",
                // A statement that judges its own rows is pointed at by its place.
                probe: statement.premise
                  ? statement.probe!
                  : operation.driver.adapter.clauses.select(sql`1`),
                failure: statement.failure,
                model: statement.model["~"].names.ts!,
                operation: operation.operation,
              },
            ]
          : []
      ),
      parseResult: (results) => {
        heard(results as Sent[]);
        return answer();
      },
    };
  } catch (error) {
    if (error !== SEVERAL) throw error;
    return undefined;
  }
}
