/**
 * The one place a statement is written: under the call's row scope, in the
 * provider's spelling. The store says which rows and what they take; it
 * never says who may.
 */

import { getAdapterInternals } from "@adapters/adapter-internals";
import type { AnyModel } from "@schema/model";
import { type Sql, sql } from "@sql";
import type { PreparedGuardFailure } from "../../types";
import { InsertValue, JoinedValue } from "../shared/insert-value";
import { nestedRefusal } from "../shared/operation-context";
import type {
  PreparedProjection,
  PreparedSelector,
  Query,
} from "../shared/query";
import { Parameter, type RowJudgement } from "../shared/row-scope";
import type { Input } from "../shared/schema";
import type { SqlOperationContext } from "../shared/sql-operation-context";
import type { SqlQueries } from "../shared/sql-queries";
import { linkJudgement, type Membership } from "../shared/storage";
import type { Sent, Statement } from "./send";

/** Thrown, before anything is written, by a call the new write path does not cover yet: the shipped engine runs it. */
export const OUTSIDE = Symbol("outside what the new write path covers");
export const outside = (): never => {
  throw OUTSIDE;
};

export type Junction = Extract<Membership, { kind: "junction" }>;

/** A question: the rows of a model a filter names, among the members of a row where it says so. */
export interface Question {
  readonly model: AnyModel;
  readonly where?: Input;
  /** The filter was admitted as a unique selector: it names one row at most. */
  readonly unique?: boolean;
  readonly member?: { readonly edge: Membership; readonly of: Input };
  /** The relation the rows are reached through, whose ever members they are. */
  readonly through?: Membership;
  /** What the call means to do with the rows: `join` makes them members, or no longer; of an update, what it writes of them. */
  readonly intent?: "update" | "delete" | "join";
  readonly writes?: readonly string[];
  /** No more than that many of them, the first by their key. */
  readonly limit?: number;
  /** The nested verb that asks, for what it refuses with. */
  readonly verb?: string;
  /** A row must be there: none is the call's refusal. */
  readonly must?: true;
  /**
   * Every row the call may see must be one it may write so: a row it cannot
   * see is passed by, one it sees and may not write is a refusal. With what
   * it refuses with, where not as a row that is not there.
   */
  readonly strict?: boolean | string;
  /** Rows left out, by their key. */
  readonly except?: readonly Input[];
}

export class Writer {
  readonly #operation: SqlOperationContext;
  readonly #q: SqlQueries;
  readonly #projections = new Map<AnyModel, PreparedProjection[]>();
  constructor(operation: SqlOperationContext) {
    this.#operation = operation;
    this.#q = operation.queries as SqlQueries;
  }
  /** What a write of the rows a question names is judged at. */
  #judged(question: Question): RowJudgement | undefined {
    const edge = question.through ?? question.member?.edge;
    if (question.intent === "join" && edge) return linkJudgement(edge);
    if (question.intent === "delete") return { verb: "delete", writes: [] };
    return question.writes && { verb: "update", writes: question.writes };
  }
  #related(question: Question): "root" | "related" {
    return question.member || question.through ? "related" : "root";
  }
  /** The rows a question names, among those the call may take so; `keys` narrows them to rows the call knows. */
  selector(question: Question, keys?: readonly Input[]): PreparedSelector {
    const q = this.#q;
    const { model } = question;
    const named = keys
      ? q.includeIdentities(model, keys)
      : q.prepareSelector(model, question.where, question.unique ?? false);
    const own = question.except?.length
      ? {
          ...q.andSelectors(model, [
            named,
            q.excludeIdentities(model, question.except),
          ]),
          uniqueKey: named.uniqueKey,
          uniqueValues: named.uniqueValues,
        }
      : named;
    return q.candidates(
      own,
      this.#related(question),
      undefined,
      this.#judged(question)
    );
  }
  #fields(model: AnyModel, fields: readonly string[]) {
    return this.#q.prepareProjection(
      model,
      { select: Object.fromEntries(fields.map((field) => [field, true])) },
      true
    );
  }
  /** The whole row of a model, and its key, as projections. */
  #projection(model: AnyModel, whole: boolean): PreparedProjection {
    let known = this.#projections.get(model);
    if (!known) {
      const { schema } = this.#operation;
      known = [
        this.#fields(model, schema.keys(model)),
        this.#fields(model, schema.storedFields(model)),
      ];
      this.#projections.set(model, known);
    }
    return known[Number(whole)]!;
  }
  #membership(question: Question) {
    return (
      question.member && {
        edge: question.member.edge,
        parent: question.member.of,
      }
    );
  }
  /** The rows a write names, as its statement says them: among the members of the question's row, where it has one. */
  #among(question: Question, selector: PreparedSelector, alias: string) {
    const named = this.#q.lowerSelector(selector, alias);
    const { member } = question;
    if (!member) return named;
    const members = this.#q.memberWhere(member.edge, member.of, alias);
    return named
      ? this.#operation.driver.adapter.operators.and(members, named)
      : members;
  }
  #limited(question: Question, selector: PreparedSelector, keys: unknown) {
    const { model, member } = question;
    return member
      ? { where: this.#among(question, selector, model["~"].names.sql!) }
      : this.#q.lowerMutationLimit(
          model,
          selector,
          keys ? undefined : question.limit
        );
  }
  /** The rows a question names, read whole; held where `hold`. */
  read(question: Question, hold: boolean): Query {
    return this.#q.select(
      question.model,
      question.limit === undefined ? {} : { take: question.limit },
      this.#membership(question),
      {
        forUpdate: hold,
        projection: this.#projection(question.model, true),
        selector: this.selector(question),
      }
    );
  }
  /** What a call refuses with where a row a question asks for is not there. */
  absent(question: Question, raceable = false): PreparedGuardFailure {
    const edge = question.member?.edge ?? question.through;
    return edge && question.verb
      ? {
          kind: "nestedWrite",
          relation: edge.name,
          message: `Cannot ${question.verb} relation '${edge.name}': target record was not found${question.member ? " for this parent" : ""}.`,
          raceable,
        }
      : { kind: "notFound", message: "", raceable };
  }
  /**
   * A statement that stops its unit unless the question still names a row:
   * the one `key` names, where given. It stops on what the call `believed`,
   * or, where the row must be there, on the call's refusal itself.
   */
  asks(
    question: Question,
    key: Input | undefined,
    believed: "presumed" | "read"
  ): Statement {
    const { model } = question;
    const probe = this.#q.select(
      model,
      { take: 1 },
      this.#membership(question),
      {
        projection: this.#projection(model, false),
        selector: this.selector(question),
        ...(key && { identity: key }),
      }
    ).sql;
    return {
      sql: this.#operation.driver.adapter.assertions.exists(probe),
      probe,
      premise: "exists",
      believed: believed === "presumed" && question.must ? undefined : believed,
      // Also what an owner that cannot run the call again reports.
      stops: this.absent(question, believed === "read"),
      model,
    };
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
    relation?: string,
    returns?: PreparedProjection
  ): Promise<Statement> {
    const q = this.#q;
    const { capabilities, mutations } = this.#operation.driver.adapter;
    const rows = await this.#operation.computed(model, values, false);
    const fields = Object.keys(rows[0]!);
    const placed = q.domain?.produced(model);
    if (fields.length === 0 && placed) outside();
    const select = placed && q.producedSource(model, fields, rows, placed);
    // A row that states nothing is the database's to fill.
    const insert =
      fields.length > 0
        ? mutations.insert(
            q.table(model),
            fields.map((field) => q.columnName(model, field)),
            select
              ? { select }
              : rows.map((row) =>
                  fields.map((field) => q.fieldValue(model, field, row[field]))
                )
          )
        : mutations.insertDefault(q.table(model));
    return {
      model,
      // It answers with the row it wrote, where the provider returns what it wrote.
      sql:
        returns && capabilities.supportsReturning
          ? this.#operation.answering(model, insert, returns)
          : insert,
      ...(select && {
        probe: select,
        stops:
          relation === undefined
            ? this.#operation.refusalOf(model)
            : nestedRefusal("create", relation),
      }),
    };
  }
  /**
   * The rows a question names take `values`: the rows `keys` names, where the
   * call knows them. The statement refuses the rows it would leave where the
   * call may not leave them so.
   */
  async update(
    question: Question,
    values: Input,
    keys?: readonly Input[],
    projection?: PreparedProjection
  ): Promise<Statement> {
    const q = this.#q;
    const { model } = question;
    const limit = keys ? undefined : question.limit;
    const { capabilities, mutations } = this.#operation.driver.adapter;
    // A value joined to other rows where it is written is not written here yet.
    if (Object.values(values).some((value) => value instanceof JoinedValue))
      outside();
    const [set] = await this.#operation.computed(model, [values], false);
    const selector = this.selector(question, keys);
    const judged = this.#judged(question);
    let stops: PreparedGuardFailure | undefined;
    let statement = q.sharing(() => {
      const produced =
        judged &&
        q.domain &&
        q.producedWhere(
          model,
          (alias) => this.#among(question, selector, alias),
          set!,
          q.domain.produced(model, judged, Object.keys(set!)),
          q.domain.cycles(model, judged),
          limit
        );
      const edge = question.member?.edge ?? question.through;
      if (produced)
        stops =
          edge && question.verb
            ? nestedRefusal(question.verb, edge.name)
            : this.#operation.refusalOf(model, judged);
      const named = produced
        ? { where: produced, suffix: undefined }
        : this.#limited(question, selector, keys);
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
    // It answers with the rows it wrote as the caller reads them, or so that
    // the call can count them, where the provider's own count would count
    // what a cascade changed besides.
    if (projection) {
      if (!capabilities.supportsReturning) outside();
      statement = this.#operation.answering(model, statement, projection);
    } else if (!keys && capabilities.countsCascadedChanges)
      statement = sql`${statement} ${mutations.returning(sql.raw("1"))}`;
    return { model, sql: statement, stops };
  }
  /**
   * The rows a question names are removed: the rows `keys` names, where the
   * call knows them. With `projection`, it answers with them as they were.
   */
  remove(
    question: Question,
    keys?: readonly Input[],
    projection?: PreparedProjection
  ): Statement {
    const q = this.#q;
    const { model } = question;
    const { capabilities, mutations } = this.#operation.driver.adapter;
    const selector = this.selector({ ...question, intent: "delete" }, keys);
    let statement = q.sharing(() => {
      const named = this.#limited(question, selector, keys);
      const removal = mutations.delete(q.table(model), named.where);
      return named.suffix ? sql`${removal} ${named.suffix}` : removal;
    });
    if (projection) {
      if (!capabilities.supportsReturning) outside();
      statement = this.#operation.answering(model, statement, projection);
    } else if (!keys && capabilities.countsCascadedChanges)
      statement = sql`${statement} ${mutations.returning(sql.raw("1"))}`;
    return { model, sql: statement };
  }
  /** Whether the call's writes of the rows a question names are judged beyond what it may see. */
  judges(question: Question): boolean {
    return Boolean(
      this.#judged(question) &&
        this.#operation.scope?.rows.domain.verbs?.has(
          question.model["~"].names.ts!
        )
    );
  }
  /**
   * A statement that stops its unit, with `stops`, where a row answers the
   * question; of a strict question, where a row the call may see is not one
   * it may write so.
   */
  none(
    question: Question,
    stops: PreparedGuardFailure = typeof question.strict === "string"
      ? {
          kind: "nestedWrite",
          relation: question.member!.edge.name,
          message: question.strict,
          raceable: false,
        }
      : this.absent(question)
  ): Statement {
    const { model, strict } = question;
    const probe = this.#q.select(
      model,
      { take: 1 },
      this.#membership(question),
      {
        projection: this.#projection(model, false),
        selector: this.selector(
          strict ? { ...question, intent: undefined } : question
        ),
        ...(strict && {
          unless: this.#q.domainOf(model, "related", this.#judged(question)),
        }),
      }
    ).sql;
    return {
      sql: this.#operation.driver.adapter.assertions.notExists(probe),
      probe,
      premise: "notExists",
      stops,
      model,
    };
  }
  /** One row read by its key, as `projection` says. */
  one(model: AnyModel, key: Input, projection: PreparedProjection): Query {
    return this.#q.select(model, {}, undefined, { identity: key, projection });
  }
  /** The links of `from`'s row through a junction go: the one to `to`, or every one but those to the rows `kept`. */
  unlink(
    edge: Junction,
    from: Input,
    to: Input | undefined,
    kept: readonly Input[]
  ): Statement {
    const q = this.#q;
    const { identifiers, mutations, operators, subqueries } =
      this.#operation.driver.adapter;
    const named = (side: Junction["sourceSide"], row: Input) =>
      Object.fromEntries(
        side.members.map((pair) => [
          pair.junctionField,
          row[pair.referencedField],
        ])
      );
    const own = named(edge.sourceSide, from);
    // Every link but those kept: of the rows the call may take out, and no other.
    const domain = to
      ? undefined
      : q.domainOf(edge.target, "related", linkJudgement(edge));
    const seen = q.alias();
    return {
      model: edge.source,
      sql: mutations.delete(
        identifiers.table(edge.table),
        operators.and(
          q.junctionWhere(edge, {
            ...own,
            ...(to && named(edge.targetSide, to)),
          }),
          ...kept.map((row) =>
            operators.not(
              q.junctionWhere(edge, { ...own, ...named(edge.targetSide, row) })
            )
          ),
          ...(domain
            ? [
                operators.exists(
                  subqueries.existsCheck(
                    q.table(edge.target, seen),
                    operators.and(
                      ...edge.targetSide.members.map((pair) =>
                        operators.eq(
                          identifiers.column(edge.table, pair.junctionField),
                          q.column(edge.target, pair.referencedField, seen)
                        )
                      ),
                      q.lowerSelector(domain, seen)!
                    )
                  )
                ),
              ]
            : [])
        )
      ),
    };
  }
  /** Whether a write of rows by their keys says how many of them it found. */
  get counts(): boolean {
    return this.#operation.driver.dialect !== "mysql";
  }
  /** What opens and closes the place a unit keeps the keys the database decides in it. */
  scratch(
    id: string,
    model: AnyModel
  ): { open: Statement[]; close: Statement } {
    const { batchRefs } = getAdapterInternals(this.#operation.driver.adapter);
    return {
      open: batchRefs.setup(id).map((statement) => ({ sql: statement, model })),
      close: { sql: batchRefs.cleanup(id), model },
    };
  }
  /**
   * An insert that keeps the one key the database decides of its row where
   * the statements after it in its unit read it, and what they read. None
   * where the provider keeps no such key exactly.
   */
  kept(
    scratch: string,
    name: string,
    fields: readonly string[],
    insert: Statement
  ): { statements: Statement[]; value: Sql } | undefined {
    const { adapter } = this.#operation.driver;
    const { batchRefs } = getAdapterInternals(adapter);
    const { model } = insert;
    const [field] = fields;
    const state = model["~"].state.scalars[field!]?.["~"].state;
    if (
      fields.length !== 1 ||
      state?.autoGenerate?.kind !== "increment" ||
      !batchRefs.storeInsertedKey
    )
      return undefined;
    const [producing, ...storing] = batchRefs.storeInsertedKey(
      scratch,
      name,
      insert.sql,
      adapter.identifiers.escape(this.#q.columnName(model, field!))
    );
    return {
      statements: [
        { ...insert, sql: producing! },
        ...storing.map((statement) => ({ sql: statement, model })),
      ],
      value: adapter.expressions.cast(
        batchRefs.read(scratch, name),
        state.type === "bigint" ? "bigint" : "integer"
      ),
    };
  }
  /** The key of a row of `model`, as a statement answers with it. */
  key(model: AnyModel): PreparedProjection {
    return this.#projection(model, false);
  }
  /** The keys a statement returned, as the call holds them. */
  keys(model: AnyModel, rows: Input[]): Input[] {
    return rows.length > 0
      ? (this.#q.decodeProjection(
          this.#projection(model, false).shape,
          rows,
          true
        ) as Input[])
      : [];
  }
  /** How many rows a set write that answers so wrote. */
  count(sent: Sent): number {
    return this.#operation.driver.adapter.capabilities.countsCascadedChanges
      ? sent.rows.length
      : sent.rowCount;
  }
  /** The links that make each second row a member of the first one's through a junction, added where they are not there. */
  link(
    edge: Junction,
    pairs: readonly (readonly [Input, Input])[]
  ): Statement[] {
    const q = this.#q;
    const { identifiers, mutations } = this.#operation.driver.adapter;
    const sides = [edge.sourceSide, edge.targetSide];
    const columns = sides.flatMap((side) =>
      side.members.map((pair) => pair.junctionField)
    );
    return mutations
      .insertAbsent(
        identifiers.table(edge.table),
        columns,
        pairs.map((pair) =>
          sides.flatMap((side, at) =>
            side.members.map((member) =>
              q.fieldValue(
                side.model,
                member.referencedField,
                pair[at]![member.referencedField]
              )
            )
          )
        ),
        columns
      )
      .map((statement) => ({ sql: statement, model: edge.source }));
  }
}
