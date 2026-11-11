/**
 * PROTOTYPE (analysis only, not for merge): a `create` or an `update` as a
 * physical plan, and the two schedulers that send it.
 *
 * Second version. The statements are the plan's own: what it must leave the
 * same as the shipped engine is the answer, the error and the database, in no
 * more round trips. Byte identity of the SQL is no longer asked for.
 *
 * {@link createSteps} and {@link updateSteps} state WHAT the database must
 * see, in order, with no word about how it is sent. A nested verb is a few
 * steps over rows: a row read first ({@link Located}) or rows written as a set
 * ({@link Rows}), and a step may run only where a row was found, or only where
 * it was not ({@link Condition}). {@link inTransaction} and {@link inBatch}
 * are the two ways to send the steps: a provider with interactive transactions
 * reads each row under lock where the plan places it; a provider with atomic
 * batches reads the rows first, level by level, then asserts inside one batch
 * that each is still there.
 *
 * WHAT THE CALL DECIDED STILL HOLDS WHEN IT WRITES. A call decides from rows
 * it read, and another session may change them before it writes. One rule per
 * kind of decision, the same on both schedulers:
 * - a row the call needs nothing of but what names it is named, not read
 *   ({@link name}): its write names it, and holds it from then on. One that
 *   must be there is required where its step stands: a transaction hears it
 *   of the write, a batch asserts it ({@link Statements.asked});
 * - a row found is held until the unit ends. A transaction reads it under
 *   lock; a batch asserts it, by its key and by what named it, under the same
 *   lock;
 * - a value of a row found is the row's own where the row is held from its
 *   read. A batch reads ahead: only the key it asserts is still the row's, and
 *   any other value is read again inside the write that spends it;
 * - an absence cannot be held: the insert's own unique key decides, and the
 *   call that loses is planned once more ({@link planWrite}). So no read locks
 *   an absence the call goes on to fill: where it finds a row after all, it
 *   reads it again, held ({@link inTransaction});
 * - rows written as a set are never read by the call: the write names them
 *   itself, and holds the links it reads ({@link Statements});
 * - what the call itself wrote earlier: a batch reads ahead only the rows it
 *   must read, and no earlier write of the call can change ({@link ahead}).
 *
 * THE STEPS DO NOT KNOW HOW THEY ARE SENT. What a batch does differently, and
 * what it cannot do, is said in one place, of the steps as planned
 * ({@link ahead}).
 *
 * A VALUE IS KNOWN where the call states it, where its row was read, or once
 * its row is written. A write that decides what the call goes on to read
 * returns its row in a transaction ({@link Statements.decided}); a batch hears
 * nothing between its statements, so a value is read where it is written,
 * from the row its key names.
 *
 * ONE KIND OF ROW, ONE KIND OF VALUE. A row the call creates is a row like one
 * it finds: it holds from the start what the call states of it, and
 * {@link writeSteps} plans both. A value is a field of a row of the plan
 * ({@link Read}).
 *
 * Covered, called outside a transaction and under no row scope but kept rows,
 * on a relation a foreign key holds, a junction holds (generated, declared or
 * of variants) or a row of variants holds:
 * - `create`: nested `create`, `connect` and `connectOrCreate`;
 * - `update` by a unique selector: scalar writes and, to any depth, `create`,
 *   `connect`, `connectOrCreate`, `update`, `upsert`, `delete`, `disconnect`,
 *   `set`, `updateMany` and `deleteMany`.
 * Everything else throws {@link UNSUPPORTED} before any provider work, and the
 * shipped engine runs.
 */
import type { AnyDriver } from "@drivers";
import { attachCommitCertainty } from "@drivers/driver-error-context";
import {
  bindExecutionTransactionPhases,
  deriveStatementExecutionContext,
} from "@drivers/execution-context";
import { transferPreparedStatement } from "@drivers/prepared-statement-provenance";
import type { QueryExecutionContext } from "@drivers/types";
import {
  attachRecordSeriesProgress,
  ForbiddenError,
  isVibORMError,
  NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
  NestedWriteAssertionError,
  NestedWriteError,
  NotFoundError,
  retainWriteOutcomeFailure,
  UniqueConstraintError,
  UnsupportedOperationError,
  VibORMErrorCode,
} from "@errors";
import type { AnyModel } from "@schema/model";
import { type Sql, sql } from "@sql";
import { type WriteKind, type WriteSink, writeSinks } from "../../write-sinks";
import { Commands } from "../commands/commands";
import { InsertValue, JoinedValue, Stored } from "../shared/insert-value";
import {
  nestedRefusal,
  type WriteOutcomeSeam,
} from "../shared/operation-context";
import {
  GatedFieldRefusal,
  InvalidScalarResult,
  type PreparedProjection,
  type PreparedSelector,
  type Query,
  RecursiveOutputOverBudget,
  readUpdate,
  returningSafeProjection,
} from "../shared/query";
import {
  Parameter,
  parseStamped,
  type RowJudgement,
} from "../shared/row-scope";
import type { Arguments, EngineSchema, Input } from "../shared/schema";
import type { SqlOperationContext } from "../shared/sql-operation-context";
import type { SqlQueries } from "../shared/sql-queries";
import { linkJudgement, linkMembers, type Membership } from "../shared/storage";

export const UNSUPPORTED = Symbol("unsupported by the plan prototype");

/** Why the prototype last declined, and whether it last planned through a junction: the experiment's own accounting. */
export const declined = { reason: "", junction: false };
function unsupported(reason: string): never {
  declined.reason = reason;
  throw UNSUPPORTED;
}

type Junction = Extract<Membership, { kind: "junction" }>;

/** Rows of one model: those `where` names, among the members of a located row where `member` says which. */
interface Rows {
  readonly model: AnyModel;
  readonly where?: Input;
  /** `where` names one row by itself: it is read alone, and must turn out a member. */
  readonly unique?: boolean;
  /** The relation they are members of, and the row whose members they are. */
  readonly member?: { readonly edge: Membership; readonly of: Located };
  /** Rows left out: the ones a `set` keeps. */
  readonly except?: readonly Located[];
  /** No more than that many of them, the first by their key. */
  readonly limit?: number;
  /**
   * What a write of them is judged at: its verb, and the fields it writes.
   * Rows the call may not write so are rows it does not find.
   */
  judged?: RowJudgement;
  /** The one row found, where the plan reads it before it writes. */
  found?: Input;
}

/**
 * One row the plan knows: a row it reads before it writes, or a row it
 * creates, which holds from the start what the call states of it.
 */
interface Located extends Rows {
  /** The call creates it: what it holds from the start is what the call states of it. */
  readonly made?: boolean;
  /** The relation it is reached through and the verb that reaches it, for its refusal. */
  readonly relation?: string;
  readonly verb?: string;
  /** None is not a refusal: what is planned for the row runs under a {@link Condition}. */
  readonly lax?: boolean;
  /** A step needs it as it was found. */
  bound?: boolean;
  /** The call needs nothing of it but what its `where` states: it is named, not read ({@link name}). */
  named?: boolean;
  /** What the call's earlier writes may do to its lookup, where a batch asks ({@link ahead}). */
  moved?: "out" | "any";
  readonly when?: Condition;
  /**
   * The call writes where it finds none: an absence, which no lock holds. The
   * row it creates in the place of this one, where other steps read from it.
   */
  orElse?: Located | true;
  /** The fields other steps read from the row. */
  reads?: Set<string>;
  /** What its entry states of the link's own columns: a declared junction's `$through`. */
  readonly stated?: Input;
  /** The same row, sought holding what an upsert asks of it besides: updated only where that one is found. */
  matched?: Located;
}

/** What is planned under it is sent only where `row` was found, or only where it was not. */
interface Condition {
  readonly row: Located;
  readonly found: boolean;
  readonly outer?: Condition;
}
const holds = (condition?: Condition): boolean =>
  !condition ||
  ((condition.row.named || condition.row.found !== undefined) ===
    condition.found &&
    holds(condition.outer));

/**
 * A value of a row of the plan: the row's own once it is found or written,
 * and before that what the call states of it. With a `relation`, it makes a
 * row a member: it must be there, a null would detach the row that takes it.
 */
class Read {
  readonly row: Located;
  readonly field: string;
  readonly relation?: string;
  constructor(row: Located, field: string, relation?: string) {
    // A row the call creates holds what it states and what the database
    // generates: nothing else fills a field.
    const said = row.found?.[field];
    if (
      row.made &&
      (said === null ||
        (said === undefined &&
          !row.model["~"].state.scalars[field]?.["~"].state.autoGenerate))
    )
      throw new UnsupportedOperationError(
        `Cannot create relation '${relation ?? unsupported("a field read from a created row that nothing fills")}': referenced field '${field}' must be supplied by the parent record or generated by the database.`
      );
    this.row = row;
    this.field = field;
    this.relation = relation;
    reads(row, [field]);
  }
}

const unlinked = (value: Read): Error =>
  new NestedWriteError(
    `Cannot connect relation '${value.relation}': the located target's referenced field '${value.field}' is null.`,
    value.relation!
  );

/** Whether an update's payload states the value its field takes; an operator leaves it to the database. */
const states = (value: unknown): boolean =>
  value instanceof Read || readUpdate(value).kind === "value";

/** The row that holds a rewritten row's key moves with it, where the database carries it there. */
const carried = (row: Located): void => {
  const { edge, of } = row.member ?? {};
  if (
    edge?.kind === "reference" &&
    edge.owner === "source" &&
    edge.reference?.onUpdate === "cascade" &&
    of?.found
  )
    for (const pair of edge.pairs)
      of.found[pair.source] = row.found![pair.target];
};

/** A column both rows of a link fill: a link is written where they hold one value. */
class Shared {
  readonly source: unknown;
  readonly target: unknown;
  readonly relation: string;
  readonly column: string;
  constructor(
    source: unknown,
    target: unknown,
    relation: string,
    column: string
  ) {
    this.source = source;
    this.target = target;
    this.relation = relation;
    this.column = column;
  }
}

/** Who takes the rows a statement returns: the call's answer, or a hook. */
interface Taker {
  /** How the rows are asked for; where they are only counted, none. */
  readonly projection?: PreparedProjection;
  /**
   * Given the rows; the query, where they were read by one of their own; and
   * how many rows a write wrote, where it is only asked that.
   */
  readonly take: (rows: Input[], query?: Query, count?: number) => void;
}

/** A row read by its key, as `projection` asks. */
interface Reading extends Taker {
  readonly when?: Condition;
  readonly kind: "read";
  readonly row: Located;
  readonly projection: PreparedProjection;
}

type Step = {
  readonly when?: Condition;
  /**
   * Who takes the rows a step returns: the read of its row a write answers in
   * its own statement ({@link compose}), or the call, of rows written as a
   * set or one by one.
   */
  answers?: Taker;
  /** The write finds its row itself, by what names it ({@link compose}). */
  locates?: boolean;
} & (
  | { readonly kind: "locate"; readonly rows: Located[] }
  | {
      /** Rows of a model, or links of a junction: a link that is there takes `takes`, and nothing else. */
      readonly kind: "insert";
      readonly into: AnyModel | Junction;
      readonly rows: Input[];
      readonly takes?: Input;
      /** The fields that name a row of a model that is there ({@link compose}). */
      readonly key?: readonly string[];
      /** A row another holds the place of is left out. */
      readonly skips?: boolean;
      /** The row of a model it writes, as the plan knows it. */
      readonly made?: Located;
    }
  | {
      /** The links whose columns hold what the row states: one row's to another, or every link of a row. */
      readonly kind: "unlink";
      readonly into: Junction;
      /** The first row; the others state, the same way, the links that stay. */
      readonly rows: Input[];
      /** Only the links to rows the call may take: a row it cannot see keeps its link. */
      readonly visible?: boolean;
    }
  | {
      readonly kind: "update";
      readonly target: Rows;
      /** Rows found that take the same `sets` in the same statement. */
      readonly also?: Located[];
      readonly sets: Input;
    }
  | {
      readonly kind: "delete";
      readonly target: Rows;
      /** What the row takes where its model keeps deleted rows. */
      readonly marks?: Input;
    }
  | {
      /**
       * What must hold of rows, or the call is refused. Each of `rows` is
       * there; or, with `none`, none of the rows the first names is: those
       * `blocked` says, where a restriction protects only some of them.
       */
      readonly kind: "require";
      readonly rows: Located[];
      readonly none?: boolean;
      /** Asked only where that row was read among the members: read alone, it was judged by itself. */
      readonly among?: Located;
      readonly blocked?: (
        candidates: PreparedSelector
      ) => PreparedSelector | undefined;
      /** With `none`: but the rows the call may write at that. */
      readonly unless?: RowJudgement;
      /** What a row that must not be there refuses with. */
      readonly failure?: () => Error;
    }
  | {
      /**
       * The steps of every row `target` names, planned once the rows are
       * read: how many there are is known only then.
       */
      readonly kind: "each";
      readonly target: Located;
      readonly each: (row: Located) => Step[];
      /** Its steps for a row not read yet: what cannot be done is said of them. */
      readonly dry: Step[];
      /** What more than one row refuses with. */
      readonly several?: (count: number) => Error;
    }
  | Reading
);

/**
 * What the row a verb reaches is judged at: a delete as one; a link that
 * changes, as a write of the row that holds it; an update says itself what
 * it writes ({@link writeSteps}).
 */
const judgedAt = (verb: string, edge?: Membership): RowJudgement | undefined =>
  verb === "delete"
    ? { verb, writes: [] }
    : verb === "update" || verb === "upsert" || !edge
      ? undefined
      : linkJudgement(edge);

/** A step that seeks rows that must be found: to read them, or only to require them. */
const seeks = (
  step?: Step
): step is Extract<Step, { kind: "locate" | "require" }> =>
  step?.kind === "locate" || (step?.kind === "require" && !step.none);

/**
 * What the caller wrote, by what was admitted of it: each node of `admitted`
 * with the node of `raw` it was read from. One entry is written as itself,
 * or as the list of one.
 */
function paired(
  admitted: unknown,
  raw: unknown,
  said = new WeakMap<object, unknown>()
): WeakMap<object, unknown> {
  if (typeof admitted === "object" && admitted) {
    said.set(admitted, raw);
    for (const [key, child] of Object.entries(admitted)) {
      const next = (raw as Input | undefined)?.[key];
      paired(child, next === undefined && key === "0" ? raw : next, said);
    }
  }
  return said;
}

interface Planning {
  readonly operation: SqlOperationContext;
  readonly schema: EngineSchema;
  readonly steps: Step[];
  /** What the caller wrote of each node of the payload, as it was admitted ({@link paired}). */
  readonly said: WeakMap<object, unknown>;
  /** The hooks' reader: which nested writes it wants the rows of. */
  readonly sink?: WriteSink;
  /** What the steps being planned run under. */
  under?: Condition;
  /**
   * Where the steps are those of each of several rows: the relation and verb
   * that join a row which can be a member of one only.
   */
  readonly joins?: { only?: [relation: string, verb: string, link: boolean] };
}

/** What the call reads of a row besides the values its steps take from it: its key, for a read by key. */
const reads = (row: Located, fields: readonly string[]): void => {
  // Of the row, and of the one created where the row is not found.
  for (const of of typeof row.orElse === "object" ? [row, row.orElse] : [row])
    for (const field of fields) (of.reads ??= new Set()).add(field);
};

/** The row another stands for: itself, or the one created where it was not found. */
const standing = (row: Located): Located =>
  row.found || typeof row.orElse !== "object" ? row : row.orElse;

function push(planning: Planning, step: Step): void {
  planning.steps.push(
    planning.under ? { ...step, when: planning.under } : step
  );
}

/** What a written value says its row's field holds, where the call knows it before it reads. */
const known = (value: unknown): unknown => {
  if (value instanceof Shared) return known(value.source);
  if (!(value instanceof Read)) return value;
  const { row, field } = value;
  // A row found or made in another's place is known once the call has read.
  return row.orElse
    ? undefined
    : (known(row.found?.[field]) ?? row.where?.[field]);
};

/**
 * Whether what a lookup states of a row and what a write states of one may be
 * of one row: not where they give a field two values.
 */
const mayBe = (asked?: Input, written?: Input): boolean =>
  !(asked && written) ||
  Object.entries(asked).every(([field, value]) => {
    const said = known(written[field]);
    return (
      [value, said].some(
        (given) => given === undefined || typeof given === "object"
      ) || said === value
    );
  });

/**
 * What the call's earlier writes may do to the answer of a lookup of `rows`:
 * take rows out of it, or anything. Asked of the steps themselves: a write
 * names its rows and says what it does to them. A lookup reads what its
 * `where` reads and, among members, what holds the membership.
 */
function disturbed(
  operation: SqlOperationContext,
  earlier: readonly Step[],
  rows: Rows
): "out" | "any" | undefined {
  const { model, where, member } = rows;
  const edge = member?.edge;
  const holds =
    edge?.kind === "reference" ? held(edge).map(([own]) => own) : [];
  // What a junction's link holds where it makes the row asked for a member.
  const link =
    edge?.kind === "junction" &&
    Object.fromEntries(
      (
        [
          [edge.sourceSide, member!.of.where],
          [edge.targetSide, where],
        ] as const
      ).flatMap(([side, named]) =>
        side.members.map((pair) => [
          pair.junctionField,
          named?.[pair.referencedField],
        ])
      )
    );
  // A `where` that reads other rows may read one the call wrote.
  const reads =
    operation.queries.prepareSelector(model, where, rows.unique ?? false).facts
      .reads.length > 0;
  let answer: "out" | undefined;
  for (const step of earlier) {
    if (
      step.kind === "locate" ||
      step.kind === "require" ||
      step.kind === "read"
    )
      continue;
    // What is written of rows not read yet is not known.
    if (reads || step.kind === "each") return "any";
    if ("into" in step) {
      const { into } = step;
      const [row] = step.rows;
      const touches =
        "table" in into
          ? link && into.table === (edge as Junction).table && mayBe(link, row)
          : into === model && mayBe(where, row);
      if (!touches) continue;
      if (step.kind === "insert") return "any";
      answer = "out";
      continue;
    }
    const { target } = step;
    const sets = step.kind === "update" ? step.sets : {};
    // A row an update writes is the one named before it, and after it.
    if (
      target.model !== model ||
      !(
        mayBe(where, target.where) || mayBe(where, { ...target.where, ...sets })
      )
    )
      continue;
    if (
      Object.keys(sets).some(
        (field) =>
          (where && field in where) ||
          (holds.includes(field) && sets[field] !== null)
      )
    )
      return "any";
    if (step.kind === "delete" || holds.some((field) => field in sets))
      answer = "out";
  }
  return answer;
}

/**
 * Which rows the call names without reading them. A row is named where the
 * call needs nothing of it but what its `where` states: nothing is planned for
 * where it is not there, nothing reads more of it, no step needs it as it was
 * found, and no write changes what names it: its own, or that of the row
 * whose key it holds, which the database carries to it. Its writes name it
 * themselves, and one that must be there is required where its step stands.
 */
function name(operation: SqlOperationContext, steps: Step[]): void {
  const renamed = new Set<Rows>();
  for (const step of steps) {
    const { target, sets } = step as Extract<Step, { kind: "update" }>;
    if (
      step.kind !== "update" ||
      !Object.keys(sets).some(
        (field) =>
          operation.schema.keys(target.model).includes(field) ||
          field in (target.where ?? {})
      )
    )
      continue;
    renamed.add(target);
    if (target.member) renamed.add(target.member.of);
  }
  for (const [at, step] of [...steps.entries()].reverse()) {
    if (step.kind !== "locate") continue;
    const [row] = step.rows as [Located];
    row.named = !(
      row.orElse ||
      row.bound ||
      renamed.has(row) ||
      [...(row.reads ?? [])].some(
        (field) => typeof (row.where?.[field] ?? {}) === "object"
      )
    );
    if (row.named)
      steps.splice(
        at,
        1,
        ...(row.lax ? [] : [{ ...step, kind: "require" as const }])
      );
  }
}

/**
 * What a batch cannot do. It reads before it writes, and hears nothing between
 * its statements: a row it must read is read ahead, so not one whose lookup an
 * earlier write of the call may change ({@link disturbed}). One that must be
 * there is still read ahead where writes only took rows out, and required
 * after them.
 */
function ahead(operation: SqlOperationContext, steps: Step[]): void {
  for (const [at, step] of steps.entries()) {
    // Each row read is written before the next, and a batch is sent whole:
    // each row is a batch of its own, where the rows are all the call writes.
    if (step.kind === "each" && steps.length > 1)
      unsupported("rows read, then written one by one, within a batch");
    if (!seeks(step)) continue;
    const [row] = step.rows as [Located];
    row.moved = disturbed(operation, steps.slice(0, at), row);
    if (
      step.kind === "locate" &&
      (row.moved === "any" || (row.moved && row.lax))
    )
      unsupported("a row an earlier write of the call may change, read ahead");
  }
}

/** A row the steps planned after it are about. */
function locate(planning: Planning, row: Located): Located {
  const located: Located = { ...row, when: planning.under };
  push(planning, { kind: "locate", rows: [located] });
  return located;
}

/** Plans `work` for where `row` was found, or for where it was not. */
function within<T>(
  planning: Planning,
  row: Located,
  found: boolean,
  work: () => T
): T {
  if (!found) row.orElse ??= true;
  // A row that must be there conditions nothing.
  if (found && !row.lax) return work();
  const outer = planning.under;
  planning.under = { row, found, outer };
  try {
    return work();
  } finally {
    planning.under = outer;
  }
}

/**
 * Adds to what a create, or an update, of a row of `model` writes what the
 * call's extensions write on every one: each field the caller did not state
 * in `data`, and no relation has `decided`.
 */
function stamp(
  planning: Planning,
  model: AnyModel,
  kind: "create" | "update",
  sets: Input,
  data: Input = {},
  decided: readonly string[] = []
): void {
  const { scope, schema } = planning.operation;
  const said = (planning.said.get(data) ?? {}) as Input;
  const kept: Input = {};
  for (const [field, value] of Object.entries(
    scope?.rows.stamps?.get(model["~"].names.ts!)?.[kind] ?? {}
  ))
    if (said[field] === undefined && !decided.includes(field))
      // A value computed where the row is written is no data to admit; a
      // parameter is the call's one instant.
      (value instanceof InsertValue ? sets : kept)[field] =
        value instanceof Parameter ? scope!.instant() : value;
  // Admitted as the caller's own would be, where there is something to
  // admit; what an update's admission generates besides is the row's own
  // admission's to say.
  if (Object.keys(kept).length > 0)
    for (const [field, value] of Object.entries(
      kind === "create"
        ? schema.createValues(model, kept)
        : schema.update(model, kept, true)
    ))
      if (field in kept) sets[field] = value;
  if (Object.values(sets).some((value) => value instanceof JoinedValue))
    unsupported("a value read from rows the write joins");
}

/** What a delete writes on a model that keeps its deleted rows; nothing where it removes them. */
function tombstone(planning: Planning, model: AnyModel): Input | undefined {
  const { scope, schema } = planning.operation;
  const mark = scope?.rows.tombstones?.get(model["~"].names.ts!);
  if (!(scope && mark)) return undefined;
  if (scope.defaults !== scope.domain)
    unsupported("a tombstone under controls that widen the default rows");
  const marks = schema.scalars(
    model,
    schema.update(
      model,
      mark.at === undefined
        ? mark.assign
        : { ...mark.assign, [mark.at]: scope.instant() },
      true
    )
  );
  // A kept row is updated: it takes what every update of its model takes.
  stamp(planning, model, "update", marks);
  return marks;
}

/** Appends the read of a nested row a hook wants, whole: after the write, before a delete. */
function observe(
  planning: Planning,
  model: AnyModel,
  write: WriteKind,
  located: Located
): void {
  const { sink, operation } = planning;
  const name = model["~"].names.ts!;
  if (!sink?.wants(name, write)) return;
  reads(located, planning.schema.keys(model));
  const projection = operation.queries.prepareProjection(model, {});
  push(planning, {
    kind: "read",
    row: located,
    projection,
    take: (rows, query) =>
      sink.wrote(
        name,
        write,
        operation.queries.decodeProjection(
          query?.shape ?? projection.shape,
          rows
        )
      ),
  });
}

/** Writes `sets` on the row found, and shows it to the hook that asked. */
function write(planning: Planning, row: Located, sets: Input): void {
  push(planning, { kind: "update", target: row, sets });
  observe(planning, row.model, "update", row);
}

/**
 * Rows a write leaves out because the call may not write them at `judged`
 * are a refusal where the call sees them: only a row it cannot see is passed
 * by. Asked where the call's writes of their model are judged.
 */
function guarded(
  planning: Planning,
  rows: Rows,
  judged: RowJudgement | undefined,
  failure: () => Error
): void {
  if (
    judged &&
    planning.operation.scope?.rows.domain.verbs?.has(rows.model["~"].names.ts!)
  )
    push(planning, {
      kind: "require",
      none: true,
      rows: [{ ...rows, judged: undefined }],
      unless: judged,
      failure,
    });
}

/** Removes the row found, or marks it where its model keeps deleted rows. */
function erase(planning: Planning, row: Located): void {
  const marks = tombstone(planning, row.model);
  const { member } = row;
  if (!marks) {
    if (row.verb) observe(planning, row.model, "delete", row);
    // The link references the row: it goes first, and the row is then known
    // by what was read of it. A kept row keeps its links.
    if (member?.edge.kind === "junction") {
      row.bound = true;
      relate(
        planning,
        member.edge,
        memberOf(member.edge, member.of),
        row,
        false
      );
    }
    push(planning, { kind: "delete", target: row });
    return;
  }
  // A kept row leaves the rows that reference it in place: where the database
  // would have refused the DELETE, the tombstone is refused too.
  if (planning.sink) unsupported("a tombstone a hook may observe");
  // The check is made of a row the call holds, and of the row it is reached
  // through: both are known by their key.
  for (const known of member ? [row, member.of] : [row])
    reads(known, planning.schema.keys(known.model));
  const rules = new Commands(planning.operation);
  // The link the row is reached through is kept, and restricts nothing: its
  // slot on the row's side is excepted for the row it leads to.
  const slot = member && linkJudgement(member.edge)?.writes.at(-1);
  push(planning, {
    kind: "require",
    none: true,
    rows: [row],
    blocked: (candidates) =>
      rules.blocked(
        candidates,
        slot
          ? {
              slot,
              identity: planning.schema.identity(
                member!.of.model,
                (member!.of.found ?? member!.of.where)!
              ),
            }
          : undefined
      ),
    failure: rules.restrictFailure(row.model),
  });
  push(planning, { kind: "delete", target: row, marks });
}

/** A write to every row of `step.target` at once: no hook sees its rows, no kept row is told apart. */
function writeSet(
  planning: Planning,
  step: Extract<Step, { kind: "update" | "delete" }>
): void {
  const { model } = step.target;
  const name = model["~"].names.ts!;
  if (
    step.kind === "delete" &&
    planning.operation.scope?.rows.tombstones?.has(name)
  )
    unsupported("kept rows deleted as a set");
  if (step.kind === "delete")
    step.target.judged = { verb: "delete", writes: [] };
  if (planning.sink?.wants(name, step.kind))
    unsupported("a hook on rows written as a set");
  push(planning, step);
}

const entries = (value: unknown): unknown[] =>
  value === undefined || value === false ? [] : [value].flat();

type Reference = Extract<Membership, { kind: "reference" }>;

/**
 * Per column that says whose member a row is, the field of that row it holds:
 * the member's own columns where it holds the reference, its link's where a
 * junction does.
 */
const held = (edge: Membership): (readonly [string, string])[] =>
  edge.kind === "reference"
    ? edge.pairs.map((pair) => [pair.target, pair.source] as const)
    : edge.sourceSide.members.map(
        (pair) => [pair.junctionField, pair.referencedField] as const
      );

/** What says which variant a row of that side holds, where the relation has variants. */
const typed = (edge: Membership, side: "source" | "target"): Input =>
  edge.discriminator?.side === side
    ? { [edge.discriminator.field]: edge.discriminator.value }
    : {};

/**
 * Columns that hold fields of `row`, each read of it: what makes another row,
 * or a link, name this one. On a `side`, with the variant that side holds.
 */
const holding = (
  edge: Membership,
  row: Located,
  pairs: readonly (readonly [string, string])[],
  side?: "source" | "target"
): Input => ({
  ...Object.fromEntries(
    pairs.map(([own, field]) => [own, new Read(row, field, edge.name)])
  ),
  ...(side && typed(edge, side)),
});

/** What a member of `parent`'s row holds, or its link does. */
const memberOf = (edge: Membership, parent: Located): Input =>
  holding(edge, parent, held(edge), "target");

/** The columns of a link that name the row it reaches. */
const reached = (edge: Junction, row: Located): Input =>
  holding(
    edge,
    row,
    edge.targetSide.members.map((pair) => [
      pair.junctionField,
      pair.referencedField,
    ])
  );

/**
 * A link added or removed: the one from the row `key` reads to the row `of`,
 * or every link of the first but those `kept` where there is no `of`. A link added through a declared junction is a row of its model:
 * it takes that model's defaults and what the entry `stated`, and one that is
 * there takes what was stated.
 */
function link(
  planning: Planning,
  kind: "insert" | "unlink",
  edge: Junction,
  key: Input,
  of?: Located,
  stated?: Input,
  kept: Input[] = []
): void {
  const row = { ...key };
  for (const [column, value] of Object.entries(of ? reached(edge, of) : {}))
    row[column] =
      column in key ? new Shared(key[column], value, edge.name, column) : value;
  const model = edge.declared?.model;
  let takes: Input | undefined;
  if (model && kind === "insert") {
    const { schema, operation, sink } = planning;
    const q = operation.queries as SqlQueries;
    const name = model["~"].names.ts!;
    const members = new Set(Object.keys(row));
    const missing = schema
      .linkRequired(model, members)
      .filter((field) => stated?.[field] === undefined);
    if (missing.length > 0)
      throw new NestedWriteError(
        `Cannot link relation '${edge.name}': '${name}' requires ${missing.map((field) => `$through.${field}`).join(", ")}, which a link cannot fill.`,
        edge.name
      );
    // A stated column is a write to the model: what would judge or observe a
    // direct write refuses it.
    if (
      stated &&
      (q.restrictsLinkWrite(model) ||
        operation.scope?.rows.stamps?.has(name) ||
        sink?.wants(name, "create") ||
        sink?.wants(name, "update"))
    )
      throw new UnsupportedOperationError(
        `Cannot write $through of relation '${edge.name}': this client's extensions judge or observe writes to '${name}'. Write the row through the '${name}' delegate.`
      );
    for (const [field, value] of Object.entries({
      ...schema.createValues(
        model,
        Object.fromEntries(
          schema
            .linkDefaults(model, members)
            .filter((field) => !(stated && field in stated))
            .map((field) => [field, undefined])
        )
      ),
      ...stated,
    }))
      row[schema.physicalField(model, field).name] = q.fieldValue(
        model,
        field,
        value
      );
    // A link that is there takes what was stated, as an update of its row would.
    if (stated && Object.keys(stated).length > 0)
      takes = schema.scalars(model, schema.update(model, stated, true));
  }
  push(planning, {
    kind,
    into: edge,
    rows: [row, ...kept],
    takes,
    visible: !of,
  } as Step);
}

/**
 * The row found made a member of the row `key` reads, or no longer one where
 * `member` is off: it takes the key or gives it up, or a link is added or goes.
 */
function relate(
  planning: Planning,
  edge: Membership,
  key: Input,
  row: Located,
  member = true,
  stated = row.stated
): void {
  // Its membership is stored once: it is the member of one row.
  if (
    planning.joins &&
    member &&
    (edge.kind === "reference" || edge.uniqueSide === "target")
  )
    // A relation of variants is named before its variant.
    planning.joins.only ??= [
      edge.name.split(".")[0]!,
      row.verb!,
      edge.kind === "junction",
    ];
  if (edge.kind === "reference")
    write(planning, row, member ? key : cleared(edge));
  else {
    // The one link a slot holds is every link of the row that holds it.
    link(
      planning,
      member ? "insert" : "unlink",
      edge,
      key,
      member || edge.many ? row : undefined,
      stated
    );
  }
}

/** A row created a member of the row `key` reads; `stated` is its entry's `$through`, where it is not in `data`. */
function createMember(
  planning: Planning,
  edge: Membership,
  key: Input,
  data: Input,
  stated = data.$through as Input | undefined
): Located {
  if (edge.kind === "reference")
    return createSteps(planning, edge.target, data, key, edge.name);
  const row = createSteps(planning, edge.target, data, undefined, edge.name);
  link(planning, "insert", edge, key, row, stated);
  return row;
}

/** What empties `edge`'s membership on the row that holds it. */
function cleared(edge: Membership): Input {
  const { clearability } = edge;
  if (clearability.kind !== "columns")
    unsupported("a membership no column clears");
  return Object.fromEntries(clearability.fields.map((field) => [field, null]));
}

/** A field a relation reads or writes is the relation's: a payload that writes it too is the shipped engine's to judge. */
function owned(edge: Membership, written: Input): void {
  for (const [, field] of held(edge))
    if (written[field] !== undefined && written[field] !== null)
      unsupported("a field written beside the relation that holds it");
}

/**
 * The relation `name` of `model` with its payload, where the prototype covers
 * its storage. A collection of variants is one relation per variant, each
 * with the entries that name it, spelled as any relation's; a `set` empties
 * every variant, named or not.
 */
function relations(
  planning: Planning,
  model: AnyModel,
  name: string,
  payload: Input
): [Membership, Input][] {
  const { schema } = planning;
  const resolved = schema.index.get(model)!.get(name)!;
  const arms: [string | undefined, Input][] =
    "members" in resolved.edge && !resolved.member
      ? resolved.edge.members.map(({ variant }) => [
          variant,
          Object.fromEntries(
            Object.entries(payload).flatMap(([verb, given]) => {
              // An entry names its variant; `true` asks it of whichever holds.
              const mine = entries(given)
                .filter(
                  (entry) => entry === true || (entry as Input).type === variant
                )
                .map((entry) => {
                  if (entry === true) return entry;
                  const { type, ...named } = entry as Input;
                  if (verb === "create") return named.data;
                  return named.data || named.create ? named : named.where;
                });
              return mine.length > 0 || (verb === "set" && given)
                ? [[verb, mine]]
                : [];
            })
          ),
        ])
      : [[undefined, payload]];
  return arms
    .filter(([, mine]) => Object.keys(mine).length > 0)
    .map(([variant, mine]) => {
      const edge = schema.membership(model, name, variant);
      if (edge.kind === "junction") declined.junction = true;
      // A slot of one row takes one entry per verb.
      return [
        edge,
        variant === undefined || edge.many
          ? mine
          : Object.fromEntries(
              Object.entries(mine).map(([verb, list]) => [
                verb,
                (list as unknown[])[0],
              ])
            ),
      ];
    });
}

/** The verbs of one relation payload, in the order they take effect. */
const SINGLE = [
  "disconnect",
  "delete",
  "create",
  "connect",
  "connectOrCreate",
  "upsert",
  "update",
];
/** The verbs a row being created may ask of the rows it reaches: it has no member yet. */
const CREATING = ["create", "connect", "connectOrCreate"];
const COLLECTION = [
  "disconnect",
  "delete",
  "set",
  "updateMany",
  "deleteMany",
  "update",
  "upsert",
  "connectOrCreate",
  "connect",
  "create",
];
function verbsOf(edge: Membership, payload: Input): [string, unknown][] {
  const order = edge.many ? COLLECTION : SINGLE;
  const stated = Object.entries(payload).filter(
    ([, given]) => given !== undefined && given !== false
  );
  if (stated.some(([verb]) => !order.includes(verb)))
    unsupported("a nested verb the plan does not cover");
  return stated.sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
}

/**
 * Where a verb's rows are: the members of a row through a relation, or, for
 * the call's own verb, any row of a model.
 */
interface Place {
  readonly model: AnyModel;
  readonly member?: Rows["member"];
  /** No more than that many of its rows are written as a set, or one by one. */
  readonly limit?: number;
  /** One row of it; any row of its model where `among` is off. */
  one(
    verb: string,
    where: unknown,
    lax?: boolean,
    among?: boolean,
    stated?: unknown
  ): Located;
  /** A row created in it; `instead` of a row sought and not found, it stands for that row. */
  make(data: Input, stated?: Input, instead?: Located): Located;
  /** The row found made one of its rows, or no longer one. */
  join(row: Located, member?: boolean): void;
  /**
   * Plans what writes a row of it that was there: after the write of the row
   * whose members they are, where that one holds their key and says so first.
   */
  after?(work: () => void): void;
}

/**
 * One verb asked of a place, with one entry of its payload: the call's own
 * verb is asked of the rows of its model as a nested one is of a row's
 * members. Answers the one row it is asked of, where there is one.
 */
function ask(
  planning: Planning,
  place: Place,
  verb: string,
  entry: unknown
): Located | undefined {
  const { model, member } = place;
  const { where, data, update, create, $through, targetWhere, setWhere } =
    entry as Input;
  const after = place.after ?? ((work: () => void) => work());
  switch (verb) {
    case "disconnect":
    case "delete": {
      const row = place.one(verb, entry, entry === true);
      within(planning, row, true, () =>
        verb === "delete" ? erase(planning, row) : place.join(row, false)
      );
      return row;
    }
    case "updateMany": {
      const written = Object.entries(data as Input).filter(
        ([, value]) => value !== undefined
      );
      const { schema } = planning;
      // Rows that take the same fields are written at once. Rows of which a
      // relation or a key is written are read, and each is written as an
      // `update` writes its row.
      if (
        written.some(
          ([field]) =>
            !schema.storedFields(model).includes(field) ||
            schema.keys(model).includes(field)
        )
      ) {
        const target: Located = {
          model,
          member,
          where: where as Input,
          limit: place.limit,
          relation: member?.edge.name,
          verb: member && verb,
        };
        // Each row is written of its own copy of what the caller wrote: what
        // a default fills is that row's own.
        // A member that can belong to one row cannot be asked of several:
        // the last written would take it from the others.
        const joins: NonNullable<Planning["joins"]> = {};
        const each = (row: Located, raw?: Input) => {
          // Admitted as the call was: a row created under it may leave out
          // what the call's extensions write.
          const args = raw
            ? parseStamped(
                planning.operation.scope?.rows.stamps ?? new Map(),
                () => schema.update(model, raw, true)
              )
            : (data as Input);
          const rows: Planning = {
            ...planning,
            steps: [],
            under: undefined,
            said: raw ? paired(args, raw) : planning.said,
            joins,
          };
          writeSteps(rows, row, args);
          return rows.steps;
        };
        // Rows are sought as the write of each is judged.
        const dry = { ...target, found: {} };
        const planned = each(dry);
        target.judged = dry.judged;
        push(planning, {
          kind: "each",
          target,
          // What the plan cannot do for one row, it says before any is read.
          dry: planned,
          each: (row) => each(row, planning.said.get(data as Input) as Input),
          several:
            joins.only &&
            ((count) =>
              new UnsupportedOperationError(
                `updateMany matched ${count} rows, so it cannot apply '${joins.only![1]}' to relation '${joins.only![0]}': ${
                  joins.only![2]
                    ? "that target's member-junction slot can belong to only one of them"
                    : "that membership is stored on the target row, which can belong to only one of them"
                } — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call.`
              )),
        });
        return undefined;
      }
      const sets = Object.fromEntries(written);
      stamp(planning, model, "update", sets, data as Input);
      if (Object.keys(sets).length === 0)
        unsupported("an update that writes nothing");
      writeSet(planning, {
        kind: "update",
        target: {
          model,
          member,
          where: where as Input,
          limit: place.limit,
          judged: {
            verb: "update",
            writes: Object.keys(planning.said.get(data as Input) ?? {}),
          },
        },
        sets,
      });
      return undefined;
    }
    case "deleteMany":
      // The rows' links go with them, by the junction's own foreign key.
      writeSet(planning, {
        kind: "delete",
        target: { model, member, where: entry as Input, limit: place.limit },
      });
      return undefined;
    case "update": {
      let row: Located | undefined;
      after(() => {
        row = place.one(verb, where);
        writeSteps(planning, row, data as Input);
      });
      return row;
    }
    case "upsert": {
      const row = place.one(verb, where, true);
      // Updated where found, and where it holds what the call asks of it
      // besides; created where not found.
      const guards = [targetWhere, setWhere].filter(Boolean);
      if (guards.length > 0) {
        row.matched = place.one(
          verb,
          {
            ...(where as Input),
            AND: [...entries((where as Input).AND), ...guards],
          },
          true
        );
        // Where none is there, the call may go on to create the row.
        row.matched.orElse = true;
      }
      // An update that says nothing asks nothing of the row found.
      if (Object.keys(planning.said.get(update as Input) ?? {}).length > 0)
        after(() =>
          within(planning, row.matched ?? row, true, () =>
            writeSteps(planning, row, update as Input)
          )
        );
      row.orElse = within(planning, row, false, () =>
        place.make(create as Input, undefined, row)
      );
      return row;
    }
    case "connectOrCreate": {
      const row = place.one(verb, where, true, false, $through);
      within(planning, row, true, () => place.join(row));
      row.orElse = within(planning, row, false, () =>
        place.make(create as Input, row.stated, row)
      );
      return row;
    }
    default:
      return place.make(entry as Input);
  }
}

/** The steps of one created row, which holds from the start what the call states of it. */
function createSteps(
  planning: Planning,
  model: AnyModel,
  data: Input,
  given?: Input,
  relation?: string
): Located {
  const self: Located = {
    model,
    made: true,
    found: {},
    relation,
    verb: relation && "create",
  };
  writeSteps(planning, self, data, given);
  return self;
}

/**
 * The steps that write one row, in the order the database must see them: the
 * rows whose key it takes, its own INSERT or UPDATE, then what its relations
 * ask of the rows they reach, in the order the verbs take effect. A row the
 * call creates takes what its payload states, and what `given` makes it a
 * member with; a row found takes what its UPDATE sets.
 */
function writeSteps(
  planning: Planning,
  located: Located,
  data: Input,
  given?: Input
): void {
  const { schema } = planning;
  const { model } = located;
  const stored = new Set(schema.storedFields(model));
  const made = Boolean(located.made);
  const sets: Input = made ? located.found! : {};
  const members: (() => void)[] = [];
  // A field the payload leaves out is the database's to fill, or stays.
  for (const [name, value] of Object.entries(data))
    if (stored.has(name) && value !== undefined) sets[name] = value;
  Object.assign(sets, given);
  // A caller that writes by hand what marks a kept row as deleted changes
  // which rows the call's own lookups may take: the shipped engine's to order.
  const mark = planning.operation.scope?.rows.tombstones?.get(
    model["~"].names.ts!
  );
  if (
    mark &&
    !made &&
    Object.keys(sets).some((field) => field === mark.at || field in mark.assign)
  )
    unsupported("a kept row's marker written by hand");
  /** The fields a relation decides: no extension writes them. */
  const decided = Object.keys(given ?? {});
  /** What the caller's own data writes of the row: what an update is judged at. */
  const said = (planning.said.get(data) ?? {}) as Input;
  const writes = Object.keys(said).filter(
    (name) =>
      stored.has(name) &&
      said[name] !== undefined &&
      !(said[name] instanceof Stored)
  );
  for (const [name, value] of Object.entries(data)) {
    if (stored.has(name) || value === undefined || name === "$through")
      continue;
    for (const [edge, asked] of relations(
      planning,
      model,
      name,
      value as Input
    )) {
      const { target } = edge;
      const member = { edge, of: located };
      /** The written row holds the key of the row the relation reaches. */
      const holds = edge.kind === "reference" && edge.owner === "source";
      if (holds) {
        owned(edge, sets);
        for (const pair of edge.pairs) decided.push(pair.source);
      }
      /** One row of the relation: a member of this row's, or any row where `among` is off. */
      const one = (
        verb: string,
        where: unknown,
        lax = false,
        among = true,
        stated?: unknown
      ) => {
        // A row that may be this one, where this one's own write already
        // takes what would make it a member: two relations write one key.
        if (
          target === model &&
          mayBe(
            located.where ?? located.found,
            where === true ? undefined : (where as Input)
          ) &&
          held(edge).some(([own]) => own in sets)
        )
          unsupported("a row's own key written by two relations");
        const row = locate(planning, {
          model: target,
          relation: edge.name,
          verb,
          where: where === true ? undefined : (where as Input | undefined),
          unique: edge.many || !among,
          member: among ? member : undefined,
          lax,
          stated: stated as Input | undefined,
          judged: judgedAt(verb, edge),
        });
        // None is no refusal.
        if (where === true)
          guarded(planning, row, row.judged, () =>
            missing(planning.operation, row)
          );
        // The row whose key this one holds is sought by what this one holds.
        if (holds && among)
          reads(
            located,
            (edge as Reference).pairs.map((pair) => pair.source)
          );
        // A junction's member is read among the members: where none is found,
        // a row that is there, and no member, is refused where it is asked.
        if (lax && among && row.unique && edge.kind === "junction")
          within(planning, row, false, () =>
            push(planning, {
              kind: "require",
              none: true,
              among: row,
              rows: [{ ...row, member: undefined }],
              failure: () => missing(planning.operation, row),
            })
          );
        return row;
      };
      const verbs = verbsOf(edge, asked);
      // A relation whose verbs change which row this one holds, or its
      // links, writes this row; one that only updates the rows it reaches
      // does not.
      if (
        verbs.some(
          ([verb]) =>
            verb !== "update" &&
            (holds || (edge.kind === "junction" && verb !== "updateMany"))
        )
      )
        writes.push(
          name,
          // A relation of variants is one field of the row that holds it.
          ...(holds && !edge.discriminator
            ? (edge as Reference).pairs.map((pair) => pair.source)
            : [])
        );
      // The row's one write says which row it holds the key of: one verb says
      // it, and none that removes that row.
      if (holds && (verbs.length > 1 || verbs[0]?.[0] === "delete"))
        unsupported("verbs on a slot whose key the row holds");
      if (made && verbs.some(([verb]) => !CREATING.includes(verb)))
        unsupported("that verb under a create");
      const naming = (verb: string, payload: unknown) =>
        entries(payload).map((entry) => {
          const { $through, ...where } = entry as Input;
          return one(verb, where, false, false, $through);
        });
      // A set whose members cannot give their key up cannot take one out. It
      // is refused before the call writes anything: the rows it keeps are
      // read first, and no other member may be there.
      const [[first, given] = []] = verbs;
      const kept =
        first === "set" && edge.clearability.kind === "none"
          ? naming(first, given)
          : undefined;
      if (kept)
        push(planning, {
          kind: "require",
          none: true,
          rows: [{ model: target, member, except: kept }],
          failure: () =>
            new NestedWriteError(
              `Cannot set relation '${edge.name}' because foreign key field(s) ${[
                ...Object.keys(typed(edge, "target")),
                ...held(edge).map(([own]) => own),
              ].join(
                ", "
              )} are required: rows removed from the set cannot be disconnected. Delete them instead.`,
              edge.name
            ),
        });
      const work = () => {
        const key = holds ? {} : memberOf(edge, located);
        /** What this row takes of the row it holds the key of. */
        const of = (row: Located): Input =>
          holding(
            edge,
            row,
            (edge as Reference).pairs.map((pair) => [pair.source, pair.target]),
            "source"
          );
        const place: Place = holds
          ? {
              model: target,
              member,
              after: (later) => members.push(later),
              // Nothing is read of the row a slot gives up.
              one: (verb, where, ...rest) =>
                verb === "disconnect" && where === true
                  ? { model: target }
                  : one(verb, where, ...rest),
              // The key is this row's own write's to say, of the row sought
              // or of the one created where it is not there.
              make: (data, _, instead) => {
                const row = createSteps(
                  planning,
                  target,
                  data,
                  undefined,
                  edge.name
                );
                if (instead) instead.orElse = row;
                Object.assign(sets, of(instead ?? row));
                return row;
              },
              join: (row, on = true) => {
                Object.assign(sets, on ? of(row) : cleared(edge));
              },
            }
          : {
              model: target,
              member,
              one,
              make: (data, stated) =>
                createMember(planning, edge, key, data, stated),
              join: (row, on) => relate(planning, edge, key, row, on),
            };

        for (const [verb, payload] of verbs) {
          // The rows a set keeps or a connect names are read side by side,
          // then joined; a set first empties the slot of every other row.
          if (verb === "set" || verb === "connect") {
            const named = (verb === "set" && kept) || naming(verb, payload);
            if (verb === "set" && !kept) {
              // The rows it keeps are left out by their key.
              for (const row of named) reads(row, schema.keys(target));
              guarded(
                planning,
                { model: target, member, except: named },
                linkJudgement(edge),
                () =>
                  new NestedWriteError(
                    `Cannot clear relation '${edge.name}': a connected record may not be disconnected by this call.`,
                    edge.name
                  )
              );
              if (edge.kind === "reference")
                writeSet(planning, {
                  kind: "update",
                  target: {
                    model: target,
                    member,
                    except: named,
                    judged: linkJudgement(edge),
                  },
                  sets: cleared(edge),
                });
              else
                link(
                  planning,
                  "unlink",
                  edge,
                  key,
                  undefined,
                  undefined,
                  // The links it keeps stay as they are.
                  named.map((row) => reached(edge, row))
                );
            }
            for (const row of named) place.join(row);
            continue;
          }
          for (const entry of entries(payload))
            ask(planning, place, verb, entry);
        }
      };
      // What the row's own write reads of another row is planned before it.
      if (holds) work();
      else members.push(work);
    }
  }
  // What a key may be rewritten with is the key's rule, wherever it is asked.
  const refused =
    !made && located.verb && schema.keyPortabilityRefusal(model, data);
  if (refused && located.verb === "upsert")
    unsupported("a refusal only an upsert that finds its row raises");
  if (refused) throw refused;
  stamp(planning, model, made ? "create" : "update", sets, data, decided);
  const written = made || Object.keys(sets).length > 0;
  if (!made)
    located.judged =
      written || writes.length > 0 ? { verb: "update", writes } : undefined;
  if (made)
    push(planning, {
      kind: "insert",
      into: model,
      rows: [sets],
      made: located,
    });
  else if (written) push(planning, { kind: "update", target: located, sets });
  if (written && located.verb)
    observe(planning, model, made ? "create" : "update", located);
  for (const next of members) next();
}

/** One plan's statements, spelled once for both schedulers. */
class Statements {
  readonly #operation: SqlOperationContext;
  readonly #queries: SqlQueries;
  readonly #selectors = new Map<Rows, PreparedSelector>();
  readonly #projections = new Map<
    AnyModel,
    { readonly row: PreparedProjection; readonly key: PreparedProjection }
  >();
  /**
   * The call hears the database between its statements: a transaction, where
   * a row found is held from its read. A batch is sent whole.
   */
  readonly #held: boolean;
  /**
   * Where the call hears the database between its statements: how a value
   * its extension computes may read it before the write.
   */
  asks?: (statement: Sql, of: AnyModel) => Promise<{ rows: Input[] }>;
  /**
   * What the last write rendered refuses with, where its statement judges the
   * row it would produce and fails before it writes one the call may not;
   * and its judgement by itself, where it can be asked again.
   */
  judged?: { refusal: () => Error; probe?: Sql };
  /** What the last write rendered asks of the rows it reads from: no row may answer `probe`. */
  required: { probe: Sql; model: AnyModel; refusal: () => Error }[] = [];
  constructor(operation: SqlOperationContext) {
    this.#operation = operation;
    this.#queries = operation.queries as SqlQueries;
    this.#held = operation.driver.supportsTransactions;
  }
  /**
   * The value a step takes, once the row it is read from is found or written.
   * A row found is held from its read in a transaction: its values are the
   * call's. A batch reads ahead: only the key it asserts is still the row's,
   * and any other value it writes is read again where it is written, from the
   * row its key names. One that must be there is asserted so.
   */
  #value(value: unknown, written = false): unknown {
    if (value instanceof Shared) {
      const source = this.#value(value.source);
      if (written && String(source) !== String(this.#value(value.target)))
        throw new NestedWriteError(
          `Cannot link relation '${value.relation}': the two rows hold different values for '${value.column}'.`,
          value.relation,
          { meta: { field: value.column, relation: value.relation } }
        );
      return this.#value(value.source, written);
    }
    if (!(value instanceof Read)) return value;
    const { field, relation } = value;
    const row = standing(value.row);
    const said = (row.found ?? row.where!)[field];
    // A row the call creates may hold another row's value.
    let read = said instanceof Read ? this.#value(said, written) : said;
    const must = written && relation !== undefined;
    if (must && read === null) throw unlinked(value);
    const { schema } = this.#operation;
    if (
      written &&
      row.found &&
      !(
        this.#held ||
        said instanceof Read ||
        schema.keys(row.model).includes(field)
      )
    ) {
      const q = this.#queries;
      const identity = this.key(row);
      if (must && schema.physicalField(row.model, field).nullable)
        this.required.push({
          model: row.model,
          probe: q.select(row.model, { take: 1 }, undefined, {
            row: { kind: "fieldNull", field },
            identity,
            projection: this.projections(row.model).key,
          }).sql,
          refusal: () => unlinked(value),
        });
      read = q.locatedValue(
        row.model,
        field,
        q.includeIdentities(row.model, [identity])
      );
    }
    if (must && read === undefined) throw unlinked(value);
    return read;
  }
  /**
   * What a write changes of what the call knows of its row: its key, or a
   * field other steps read from it. `left` names the ones the write leaves to
   * the database, which alone can say them then.
   */
  settles(step: Step): { row: Located; left: string[] } | undefined {
    if (step.kind === "insert") {
      const row = step.made;
      // What the statement computes is the database's to say, as what the
      // row leaves out.
      const left = [...(row?.reads ?? [])].filter(
        (field) =>
          row!.found![field] === undefined ||
          row!.found![field] instanceof InsertValue
      );
      return left.length > 0 ? { row: row!, left } : undefined;
    }
    if (step.kind !== "update") return undefined;
    const row = step.target as Located;
    const known = this.kept(row).filter((field) => field in step.sets);
    return known.length > 0
      ? { row, left: known.filter((field) => !states(step.sets[field])) }
      : undefined;
  }
  /** What the call knows a row by, and reads from it. */
  kept(row: Located): string[] {
    const { edge } = row.member ?? {};
    return [
      ...this.#operation.schema.keys(row.model),
      ...(row.reads ?? []),
      // The row that holds this one's key reads it: it moves with it.
      ...(edge?.kind === "reference" && edge.owner === "source"
        ? edge.pairs.map((pair) => pair.target)
        : []),
    ];
  }
  /**
   * After a write, its row holds what the database `returned`; where the
   * call heard nothing, what the write states.
   */
  now(step: Step, row: Located, returned?: Input): void {
    if (!row.found) return;
    if (returned) Object.assign(row.found, returned);
    else if (step.kind === "update")
      for (const field of this.kept(row)) {
        if (!(field in step.sets)) continue;
        const update = readUpdate(this.#value(step.sets[field]));
        if (update.kind === "value") row.found[field] = update.value;
      }
    carried(row);
  }
  #only(fields: readonly string[]) {
    return { select: Object.fromEntries(fields.map((field) => [field, true])) };
  }
  /** The whole row of `model` and its key, as projections. */
  projections(model: AnyModel) {
    let known = this.#projections.get(model);
    if (!known) {
      const of = (fields: readonly string[]) =>
        this.#queries.prepareProjection(model, this.#only(fields), true);
      known = {
        row: of(this.#operation.schema.storedFields(model)),
        key: of(this.#operation.schema.keys(model)),
      };
      this.#projections.set(model, known);
    }
    return known;
  }
  key(row: Rows): Input {
    // A row not read is the one its `where` names.
    const { found, where } = standing(row);
    return Object.fromEntries(
      this.#operation.schema
        .keys(row.model)
        .map((key) => [key, this.#value((found ?? where!)[key])])
    );
  }
  /**
   * The key a row is sought by, where the row is updated where found and
   * `created` under that key where not, and the provider's insert of what is
   * not there can say both: none where the two arms are not that.
   */
  folds(
    row: Located,
    sets: Input,
    created: Input
  ): readonly string[] | undefined {
    const q = this.#queries;
    const { model, where } = row;
    // Under a row scope the provider would find a row the call may not see.
    if (this.selector(row).scoped) return undefined;
    const { uniqueKey, uniqueValues } = q.prepareSelector(model, where, true);
    const keys = this.#operation.schema.keys(model);
    // The `where` names the key and nothing else, the created row is under it,
    // and the update leaves the row's keys and is one the statement can spell.
    const named = Object.values(where ?? {}).flatMap((value) =>
      value && typeof value === "object" ? Object.values(value) : [value]
    );
    return uniqueKey &&
      uniqueValues &&
      named.length === uniqueValues.size &&
      uniqueKey.fields.every(
        (field) =>
          typeof created[field] !== "object" &&
          Object.is(created[field], uniqueValues.get(field))
      ) &&
      !Object.keys(sets).some(
        (field) =>
          keys.includes(field) || !q.namesUpdate(model, field, sets[field])
      )
      ? uniqueKey.fields
      : undefined;
  }
  /** The rows `target` names by itself, among those the call may take. */
  selector(target: Rows & { readonly verb?: string }): PreparedSelector {
    let selector = this.#selectors.get(target);
    if (selector) return selector;
    const q = this.#queries;
    const { model, except } = target;
    const own = q.prepareSelector(model, target.where, target.unique ?? false);
    selector = q.candidates(
      except
        ? {
            ...q.andSelectors(model, [
              own,
              q.excludeIdentities(
                model,
                except.map((row) => this.key(row))
              ),
            ]),
            uniqueKey: own.uniqueKey,
            uniqueValues: own.uniqueValues,
          }
        : own,
      target.member || target.verb ? "related" : "root",
      undefined,
      target.judged
    );
    this.#selectors.set(target, selector);
    return selector;
  }
  /**
   * Whether rows are named among the members. A row its own `where` names is
   * read alone, then judged a member: by what it holds ({@link isMember}), or,
   * where a junction holds the membership, by what a batch asserts of it
   * ({@link asked}). A transaction asserts nothing, so it reads a
   * junction's member among the members; a row not read ahead always is.
   */
  narrowed(rows: Rows & { readonly named?: boolean }): boolean {
    const { member } = rows;
    return Boolean(
      member &&
        (rows.named ||
          !rows.unique ||
          (member.edge.kind === "junction" && this.#held))
    );
  }
  /**
   * The membership `target`'s rows are named among: where they are
   * {@link narrowed}, or wherever `narrow` asks for a row read alone.
   */
  #among(target: Rows, narrow = this.narrowed(target)) {
    const { member } = target;
    return member && narrow
      ? // A row not read yet is the one its `where` names.
        { edge: member.edge, parent: (member.of.found ?? member.of.where)! }
      : undefined;
  }
  /** Whether the row found is the one `row`'s own `where` names, among rows read together. */
  names(row: Located, found: Input): boolean {
    return [...(this.selector(row).uniqueValues ?? [])].every(
      ([field, value]) => String(found[field]) === String(value)
    );
  }
  /** Whether the row found, read alone, holds what makes it a member. */
  isMember(row: Located): boolean {
    const { member, found } = row;
    return (
      member?.edge.kind !== "reference" ||
      (member.edge.pairs.every(
        (pair) =>
          String(found![pair.target]) ===
          String((member.of.found ?? member.of.where!)[pair.source])
      ) &&
        [found!, member.of.found ?? member.of.where!].every((row, at) =>
          Object.entries(typed(member.edge, at ? "source" : "target")).every(
            ([field, value]) => row[field] === value
          )
        ))
    );
  }
  /**
   * The rows `rows` name, read whole in one statement; locked where the
   * provider can hold them. Read `again`, a row is the one found, if what
   * named it still does.
   */
  lookup(rows: readonly Located[], forUpdate: boolean, again = false): Query {
    const q = this.#queries;
    const [{ model }] = rows as [Located];
    const selectors = rows.map((row) => this.selector(row));
    const [alone] = rows.length === 1 ? rows : [];
    return q.select(
      model,
      alone ? { take: 1 } : {},
      alone && this.#among(alone),
      {
        forUpdate,
        identity: again ? this.key(alone!) : undefined,
        projection: this.projections(model).row,
        selector:
          selectors.length === 1
            ? selectors[0]
            : q.orSelectors(model, selectors),
      }
    );
  }
  /** Every row a name designates, read whole and held. */
  all(rows: Rows): Query {
    return this.#queries.select(
      rows.model,
      rows.limit === undefined ? {} : { take: rows.limit },
      this.#among(rows),
      {
        forUpdate: true,
        projection: this.projections(rows.model).row,
        selector: this.selector(rows),
      }
    );
  }
  /**
   * What a requirement asks of one row: the row itself where it must be
   * there, by what names it and by its key where it was read; or one of the
   * rows that must not be. It holds the row it finds until the unit ends,
   * where the provider can. None where nothing is to be asked.
   */
  asked(
    row: Located,
    {
      none,
      among,
      blocked,
      unless,
    }: Partial<Extract<Step, { kind: "require" }>>,
    forUpdate: boolean
  ): Query | undefined {
    const selector =
      among && !this.narrowed(among)
        ? undefined
        : (blocked ?? ((rows) => rows))(this.selector(row));
    return (
      selector &&
      this.#queries.select(
        row.model,
        { take: 1 },
        this.#among(row, none ? undefined : true),
        {
          forUpdate,
          identity: row.found && this.key(row),
          projection: this.projections(row.model).key,
          selector,
          unless:
            unless && this.#queries.domainOf(row.model, "related", unless),
        }
      )
    );
  }
  /** The statements of one write: one, but where a dialect needs more to add a link that may be there. */
  async write(
    step: Extract<Step, { kind: "insert" | "update" | "delete" | "unlink" }>
  ): Promise<Sql[]> {
    this.judged = undefined;
    if (step.kind !== "insert") return [await this[step.kind](step as never)];
    return "table" in step.into
      ? this.#link(step.into, step.rows, step.takes)
      : this.insert(step);
  }
  /** Rows of a model; one that is there under `key` takes `takes`. */
  async insert(step: Extract<Step, { kind: "insert" }>): Promise<Sql[]> {
    const q = this.#queries;
    const { mutations } = this.#operation.driver.adapter;
    const into = step.into as AnyModel;
    const fields = Object.keys(step.rows[0]!);
    const name = (field: string) => q.columnName(into, field);
    const rows = await this.#final(into, step.rows);
    const values = rows.map((row) =>
      fields.map((field) => q.fieldValue(into, field, row[field]))
    );
    if (step.key)
      return mutations.insertAbsent(
        q.table(into),
        fields.map(name),
        values,
        step.key.map(name),
        await this.#sets(into, step.takes!)
      );
    const skip = step.skips ? mutations.skipDuplicates("") : undefined;
    // Rows the call may not create are judged as values, where they are read
    // from to be written.
    const placed = q.domain?.produced(into);
    // A row is judged on the values it writes.
    if (placed && fields.length === 0)
      throw new UnsupportedOperationError(
        `Cannot create a '${into["~"].names.ts!}' row that writes no field: its placement is judged on the values it writes.`
      );
    const select = placed && q.producedSource(into, fields, rows, placed);
    if (select) this.#refuses(step.made!, select);
    // A row that states nothing is the database's to fill.
    const insert =
      fields.length > 0
        ? mutations.insert(
            q.table(into),
            fields.map(name),
            select ? { select } : values,
            skip?.prefix
          )
        : mutations.insertDefault(q.table(into));
    return [skip ? sql`${insert} ${skip.suffix}` : insert];
  }
  /**
   * Links added where they are not there. A column of one of the two rows
   * takes that row's value; a declared junction's own column was typed where
   * the link was planned. A link that is there takes `takes`; where one side
   * holds a single link, the link that side holds takes the other row.
   */
  async #link(into: Junction, rows: Input[], takes?: Input): Promise<Sql[]> {
    const q = this.#queries;
    const { adapter } = this.#operation.driver;
    const { uniqueSide, declared } = into;
    const members = linkMembers(into);
    const columns = Object.keys(rows[0]!);
    const values = rows.map((row) =>
      columns.map((column) => {
        const value = this.#value(row[column], true);
        const member = members.find(
          ({ pair }) => pair.junctionField === column
        );
        return member
          ? q.fieldValue(member.side.model, member.pair.referencedField, value)
          : (value as Sql);
      })
    );
    const side = (name: "source" | "target") =>
      into[`${name}Side`].members.map((pair) => pair.junctionField);
    const table = adapter.identifiers.table(into.table);
    const key = declared?.key ?? members.map(({ pair }) => pair.junctionField);
    if (!uniqueSide)
      return adapter.mutations.insertAbsent(
        table,
        columns,
        values,
        key,
        takes && (await this.#sets(declared!.model, takes))
      );
    // The link that side holds takes the other row, unless it holds it.
    const other = side(uniqueSide === "source" ? "target" : "source");
    return adapter.mutations.insertAbsent(
      table,
      columns,
      values,
      side(uniqueSide),
      sql.join(
        other.map((column) =>
          adapter.set.assign(
            adapter.identifiers.escape(column),
            values[0]![columns.indexOf(column)]!
          )
        ),
        ", "
      ),
      q.junctionWhere(
        into,
        Object.fromEntries(
          other.map((column) => [column, this.#value(rows[0]![column])])
        ),
        into.table
      )
    );
  }
  /**
   * `rows` as a statement writes them: each value read, then those the call's
   * extensions compute, in the statement, once the others are final.
   */
  #final(model: AnyModel, rows: Input[]): Promise<Input[]> {
    return this.#operation.computed(
      model,
      rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([field, value]) => [
            field,
            this.#value(value, true),
          ])
        )
      ),
      this.asks
        ? async (statement) => (await this.asks!(statement, model)).rows
        : false
    );
  }
  #assign(model: AnyModel, values: Input): Sql {
    return sql.join(
      Object.entries(values).map(([field, value]) =>
        this.#queries.updateAssignment(model, field, value)
      ),
      ", "
    );
  }
  async #sets(model: AnyModel, sets: Input): Promise<Sql> {
    return this.#assign(model, (await this.#final(model, [sets]))[0]!);
  }
  /**
   * The values a statement binds to judge the rows it creates in `model`;
   * none where nothing judges them.
   */
  judges(model: AnyModel): number | undefined {
    const q = this.#queries;
    const placed = q.domain?.produced(model);
    return placed && (q.lowerSelector(placed)?.values.length ?? 0);
  }
  #refuses(row: Located, probe?: Sql): void {
    this.judged = {
      probe,
      refusal: () =>
        this.#operation.refused(
          row.model,
          row.judged,
          row.relation === undefined
            ? undefined
            : nestedRefusal(row.verb!, row.relation)
        ),
    };
  }
  /** The links whose columns hold what `row` states of them. */
  #links(into: Junction, row: Input): Sql {
    return this.#queries.junctionWhere(
      into,
      Object.fromEntries(
        Object.entries(row).map(([column, value]) => [
          column,
          this.#value(value),
        ])
      )
    );
  }
  unlink(step: Extract<Step, { kind: "unlink" }>): Sql {
    const { adapter } = this.#operation.driver;
    const q = this.#queries;
    const { into } = step;
    const [links, ...kept] = step.rows.map((row) => this.#links(into, row));
    const domain =
      step.visible && q.domainOf(into.target, "related", linkJudgement(into));
    const seen = q.alias();
    return adapter.mutations.delete(
      adapter.identifiers.table(into.table),
      adapter.operators.and(
        links!,
        ...kept.map((link) => adapter.operators.not(link)),
        ...(domain
          ? [
              adapter.operators.exists(
                adapter.subqueries.existsCheck(
                  q.table(into.target, seen),
                  adapter.operators.and(
                    ...into.targetSide.members.map((pair) =>
                      adapter.operators.eq(
                        adapter.identifiers.column(
                          into.table,
                          pair.junctionField
                        ),
                        q.column(into.target, pair.referencedField, seen)
                      )
                    ),
                    q.lowerSelector(domain, seen)!
                  )
                )
              ),
            ]
          : [])
      )
    );
  }
  /** The rows found by their key, or every row the target names where none was read. */
  #where(
    target: Rows,
    also: readonly Located[] = [],
    alias?: string
  ): Sql | undefined {
    const q = this.#queries;
    const { model } = target;
    // Under an alias the rows are only named: what is written of them, and
    // how many, is the statement's to say.
    const lower = (selector: PreparedSelector, limit?: number) =>
      alias
        ? q.lowerSelector(selector, alias)
        : q.lowerMutationLimit(model, selector, limit).where;
    if (also.length > 0) {
      const rows = [target as Located, ...also];
      return lower(
        rows.every((row) => row.found)
          ? q.includeIdentities(
              model,
              rows.map((row) => this.key(row))
            )
          : q.orSelectors(
              model,
              rows.map((row) => this.selector(row))
            )
      );
    }
    if (target.found) return q.lowerIdentity(model, this.key(target), alias);
    const where = lower(this.selector(target), target.limit);
    const among = this.#among(target);
    return among
      ? this.#operation.driver.adapter.operators.and(
          // Written as a set, the members are read where they are written: a
          // link another session is moving is waited for, and read again.
          q.memberWhere(
            among.edge,
            among.parent,
            alias ?? model["~"].names.sql!,
            !alias
          ),
          ...(where ? [where] : [])
        )
      : where;
  }
  /**
   * The WHERE of an update that judges the rows it would leave, against the
   * rows as they stand before it writes: none where nothing judges them.
   */
  #produced(
    target: Rows,
    values: Input,
    also?: readonly Located[]
  ): Sql | undefined {
    const q = this.#queries;
    const { model, judged } = target;
    const produced =
      judged &&
      q.domain &&
      q.producedWhere(
        model,
        (alias) => this.#where(target, also, alias),
        values,
        // Rows named with their judgement state it once: what the write
        // does not change of it is not stated again.
        q.domain.produced(
          model,
          judged,
          target.found ? undefined : Object.keys(values)
        ),
        q.domain.cycles(model, judged),
        target.limit
      );
    if (produced) this.#refuses(target);
    return produced;
  }
  async update(step: Extract<Step, { kind: "update" }>): Promise<Sql> {
    const q = this.#queries;
    const { target, also } = step;
    const { model } = target;
    const [values] = await this.#final(model, [step.sets]);
    return q.sharing(() =>
      this.#operation.driver.adapter.mutations.update(
        q.table(model),
        this.#assign(model, values!),
        this.#produced(target, values!, also) ?? this.#where(target, also)
      )
    );
  }
  async delete(step: Extract<Step, { kind: "delete" }>): Promise<Sql> {
    const { mutations } = this.#operation.driver.adapter;
    const q = this.#queries;
    const { model } = step.target;
    const marks = step.marks && (await this.#sets(model, step.marks));
    return q.sharing(() => {
      const where = this.#where(step.target);
      return marks
        ? mutations.update(q.table(model), marks, where)
        : mutations.delete(q.table(model), where);
    });
  }
  /** A row read by its key, as its reader asks. */
  read(step: Reading): Query {
    return this.#queries.select(step.row.model, {}, undefined, {
      identity: this.key(step.row),
      projection: step.projection,
    });
  }
  /** `statement` returning the whole of `projection`. */
  returning(statement: Sql, projection: PreparedProjection): Sql {
    return sql`${statement} ${this.#operation.driver.adapter.mutations.returning(
      sql.join(this.#queries.lowerProjection(projection), ", ")
    )}`;
  }
}

/** The model a write is sent in the name of: a link's is the row's it is a link of. */
const writtenModel = (
  step: Extract<Step, { kind: "insert" | "update" | "delete" | "unlink" }>
): AnyModel => {
  if (!("into" in step)) return step.target.model;
  return "table" in step.into ? step.into.source : step.into;
};

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

/**
 * The calls that found a row, then found it `gone` before they wrote, where
 * its absence is an outcome they plan for: what they decided no longer holds,
 * and nothing was written, so they are planned once more ({@link planWrite}).
 */
const outdated = new WeakSet<Error>();

/** What a row that is not there refuses with. */
function missing(
  operation: SqlOperationContext,
  row: Located,
  gone = false
): Error {
  const error = row.verb
    ? new NestedWriteError(
        // A row a connectOrCreate found is refused only where it is gone since.
        row.verb === "connectOrCreate"
          ? "Record was replaced by another transaction during nested connectOrCreate"
          : `Cannot ${row.verb} relation '${row.relation}': target record was not found${row.member ? " for this parent" : ""}.`,
        row.relation!
      )
    : new NotFoundError(row.model["~"].names.ts!, operation.operation);
  if (gone && row.lax) outdated.add(error);
  return error;
}

/** What a lookup found, told to each row it read: the row, or its refusal. */
function settle(
  operation: SqlOperationContext,
  statements: Statements,
  rows: readonly Located[],
  query: Query,
  raw: Input[],
  must = false
): void {
  const found = operation.queries.decodeQuery(query, raw, true) as Input[];
  for (const row of rows) {
    row.found =
      rows.length === 1
        ? found[0]
        : found.find((candidate) => statements.names(row, candidate));
    if (row.found ? !statements.isMember(row) : must || !row.lax)
      throw missing(operation, row, must);
  }
}

interface Plan {
  readonly model: AnyModel;
  /** The steps as they are sent ({@link compose}). */
  readonly steps: Step[];
  /** The operation's own row, where it has one: the row a create writes, or the row its selector finds. */
  readonly located?: Located;
  readonly sink?: WriteSink;
  /** The caller's reader of the write's durability, told by the envelope that learns it. */
  readonly seam?: WriteOutcomeSeam;
  /** The call was planned once already. */
  readonly again: boolean;
}

function published(
  operation: SqlOperationContext,
  shape: Query["shape"],
  rows: Input[],
  query?: Query
): unknown {
  const q = operation.queries;
  if (query) q.assertExpectedRows(query, rows.length);
  return q.decodeResult(rows, operation.operation, (raw) =>
    q.decodeProjection(shape, raw)
  )[0];
}

/**
 * Rows of one model read, written the same values or inserted side by side
 * travel as one statement, as far as the provider's bound on a statement's
 * values, `max`, allows.
 */
function sideBySide(
  planned: readonly Step[],
  located: Located | undefined,
  statements: Statements,
  max = Number.POSITIVE_INFINITY
): Step[] {
  const steps: Step[] = [];
  /** One more row of `width` values fits beside `rows`, and `beside` others. */
  const room = (rows: readonly unknown[], width: number, beside = 0) =>
    (rows.length + 1) * width + beside <= max;
  for (const step of planned) {
    const last = steps.at(-1);
    // What judges the rows a step creates, counted in what its statement binds.
    const judges =
      step.kind === "insert" && !("table" in step.into)
        ? statements.judges(step.into)
        : undefined;
    const beside =
      last?.kind === step.kind &&
      last.when === step.when &&
      !(statements.settles(step) || statements.settles(last!));
    if (
      beside &&
      step.kind === "insert" &&
      last.kind === "insert" &&
      // A link is a few values: its group stays under the batch's bound too.
      Object.keys(step.rows[0]!).length > 0 &&
      room(last.rows, Object.keys(step.rows[0]!).length, judges) &&
      // Rows judged where they are written do not see each other: one that
      // reads another is written after it.
      !(
        judges !== undefined &&
        Object.values(step.rows[0]!).some(
          (value) =>
            value instanceof Read && last.rows.includes(value.row.found!)
        )
      ) &&
      last.into === step.into &&
      last.takes === step.takes &&
      last.answers === step.answers &&
      last.skips === step.skips &&
      Object.keys(last.rows[0]!).join() === Object.keys(step.rows[0]!).join()
    )
      last.rows.push(...step.rows);
    else if (
      // Rows read and rows only required are sought in one statement; the
      // group is read where one of its rows is.
      seeks(last) &&
      seeks(step) &&
      last.when === step.when &&
      room(
        last.rows,
        statements.selector(step.rows[0]!).uniqueValues?.size ?? 1
      ) &&
      [last.rows[0]!, step.rows[0]!].every(
        (row) =>
          row.model === step.rows[0]!.model &&
          row.unique &&
          !(row.lax || statements.narrowed(row)) &&
          row !== located &&
          statements.selector(row).uniqueValues
      )
    )
      steps.splice(-1, 1, {
        ...(last.kind === "locate" ? last : step),
        rows: [...last.rows, ...step.rows],
      });
    else if (
      beside &&
      step.kind === "update" &&
      last.kind === "update" &&
      room(
        last.also!,
        statements.kept(step.target as Located).length,
        Object.keys(step.sets).length
      ) &&
      last.sets === step.sets &&
      last.target.model === step.target.model &&
      !statements.narrowed(step.target as Located)
    )
      last.also!.push(step.target);
    else if (step.kind === "update") steps.push({ ...step, also: [] });
    else if ("rows" in step)
      steps.push({ ...step, rows: [...step.rows] } as Step);
    else steps.push({ ...step });
  }
  return steps;
}

/**
 * A write as the taker of its rows asks for them: as its projection says, or
 * only counted. Where the provider's count of the rows a statement wrote also
 * counts what a cascade changed, each row written returns a marker instead.
 */
function asking(
  operation: SqlOperationContext,
  of: AnyModel,
  statement: Sql,
  taker: Taker,
  beside: Sql[] = []
): Sql {
  const { capabilities, mutations } = operation.driver.adapter;
  if (taker.projection)
    return operation.answering(of, statement, taker.projection, beside);
  return capabilities.countsCascadedChanges
    ? sql`${statement} ${mutations.returning(sql.raw("1"))}`
    : statement;
}

/**
 * The rows a step is about, read and held, each with its steps. What the
 * caller wrote is admitted for every row before the first is written: what it
 * refuses, it refuses before anything is written. A row read is then known by
 * its key.
 */
async function members(
  operation: SqlOperationContext,
  statements: Statements,
  step: Extract<Step, { kind: "each" }>,
  send: (statement: Sql, of: AnyModel) => Promise<{ rows: Input[] }>
): Promise<(readonly [Located, Step[]])[]> {
  const query = statements.all(step.target);
  const { rows } = await send(query.sql, step.target.model);
  if (rows.length > 1 && step.several) throw step.several(rows.length);
  return operation.queries.decodeQuery(query, rows, true).map((found) => {
    const row: Located = { ...step.target, where: undefined, found };
    return [row, step.each(row)] as const;
  });
}

/**
 * The rows a step wrote one by one, read again by their keys for who takes
 * them: each must still be there.
 */
async function again(
  operation: SqlOperationContext,
  statements: Statements,
  { answers, target }: Extract<Step, { kind: "each" }>,
  written: readonly (readonly [Located, Step[]])[],
  send: (statement: Sql, of: AnyModel) => Promise<{ rows: Input[] }>
): Promise<Input[]> {
  const rows: Input[] = [];
  for (const query of answers?.projection
    ? operation.seriesQueries(
        answers.projection,
        written.map(([row]) => statements.key(row)),
        "updateMany"
      )
    : []) {
    const read = await send(query.sql, target.model);
    operation.queries.assertExpectedRows(query, read.rows.length);
    rows.push(...read.rows);
  }
  return rows;
}

/** How many rows a write wrote, as {@link asking} had it say. */
const wrote = (
  operation: SqlOperationContext,
  response: { rows: unknown[]; rowCount: number }
): number =>
  operation.driver.adapter.capabilities.countsCascadedChanges
    ? response.rows.length
    : response.rowCount;

/** The one row of the plan a write writes. */
const rowOf = (step: Step): Located | undefined => {
  if (step.kind === "insert")
    return step.rows.length === 1 ? step.made : undefined;
  if (step.kind === "update")
    return step.also?.length ? undefined : (step.target as Located);
  return step.kind === "delete" ? (step.target as Located) : undefined;
};

/**
 * The steps as they are sent. Rows read or written side by side travel
 * together ({@link sideBySide}), and a statement does the work of several
 * steps where the provider can say them at once:
 * - a row sought by a key, updated where found and created under that key
 *   where not, is one insert of what is not there;
 * - a read of a row is answered by a write of that row, which returns it,
 *   where nothing between them changes what is read: a row that stays is read
 *   after its write, one that goes before it;
 * - a row located only to be written is located by its own write, which
 *   returns it: no step between reads the row, and none checks what must hold
 *   of it once held.
 */
function compose(
  operation: SqlOperationContext,
  statements: Statements,
  planned: Step[],
  located: Located | undefined,
  sink: WriteSink | undefined,
  held: boolean
): Step[] {
  name(operation, planned);
  if (!held) ahead(operation, planned);
  const { capabilities, mutations } = operation.driver.adapter;
  const steps = sideBySide(
    planned,
    located,
    statements,
    operation.driver.maxBindParametersPerStatement
  );
  const answered = (write: Step, read: Reading): boolean => {
    let written: Input | undefined;
    if (write.kind === "update") written = write.sets;
    else if (write.kind === "insert") written = write.takes;
    else if (write.kind === "delete") written = write.marks;
    return operation.answersInStatement(
      read.row.model,
      read.projection,
      written ? "update" : (write.kind as "insert" | "delete"),
      written
    );
  };
  /** What a write returns holds what the call reads of `row`, or nothing after `index` reads it. */
  const enough = (
    { projection }: Taker,
    row: Located,
    index: number,
    among: Step[]
  ): boolean =>
    among.slice(index + 1).every((step) => step.kind === "read") ||
    statements
      .kept(row)
      .every((name) => projection?.fields.some((field) => field.name === name));
  const [sought, update, insert, answer] = steps;
  const key =
    steps.length === 4 &&
    sought?.kind === "locate" &&
    update?.kind === "update" &&
    insert?.kind === "insert" &&
    insert.made &&
    answer?.kind === "read" &&
    capabilities.supportsTargetedUpsert &&
    // A hook hears which arm ran: it rides the RETURNING beside the row.
    (!sink ||
      (mutations.upserted && returningSafeProjection(answer.projection))) &&
    statements.folds(sought.rows[0]!, update.sets, insert.rows[0]!);
  if (key) {
    const folded: Step = {
      ...insert,
      when: undefined,
      takes: update.sets,
      key,
      answers: answer,
    };
    if (answered(folded, answer)) return [folded];
  }
  const fused = new Set<Step>();
  for (const [at, read] of steps.entries()) {
    if (read.kind !== "read") continue;
    const { row, projection } = read;
    const own = returningSafeProjection(projection);
    const changes = (step: Step): boolean =>
      // What is written of rows not read yet may reach the row itself.
      step.kind === "each" ||
      (own
        ? Boolean(statements.settles(step)) ||
          // A write may reach the row itself, through a relation to its own model.
          ((step.kind === "update" || step.kind === "delete") &&
            step.target.model === row.model &&
            mayBe(row.where ?? row.found, step.target.where))
        : !(
            step.kind === "locate" ||
            step.kind === "require" ||
            step.kind === "read"
          ));
    for (const [index, write] of steps.entries()) {
      const written = rowOf(write);
      if (
        !written ||
        (written !== row && written !== row.orElse) ||
        write.answers ||
        (write.kind === "delete" && !write.marks) !== index > at ||
        steps
          .slice(Math.min(index, at) + 1, Math.max(index, at))
          .some(changes) ||
        // A write that leaves to the database what the call goes on to read
        // returns it.
        (statements.settles(write)?.left.length &&
          !enough(read, row, index, steps)) ||
        !answered(write, read)
      )
        continue;
      write.answers = read;
      if (write.when === read.when) fused.add(read);
    }
  }
  const sent = steps.filter((step) => !fused.has(step));
  for (const first of [...sent]) {
    if (!seeks(first)) continue;
    const [row, more] = first.rows as [Located, Located?];
    const from = sent.indexOf(first);
    const at = sent.findIndex(
      (step) =>
        (step.kind === "update" || step.kind === "delete") &&
        step.target === row
    );
    const write = sent[at];
    if (
      write &&
      !(more || row.lax) &&
      write.when === first.when &&
      // Of a row it names, or of its own row where the write returns it whole.
      (first.kind === "require" || row === located) &&
      capabilities.supportsReturning &&
      // A batch hears nothing between its statements: only where the write is
      // all there is.
      (held || sent.length === 2) &&
      !(write.answers && !enough(write.answers, row, at, sent)) &&
      sent.slice(from + 1, at).every((step) => {
        if (step.kind === "read") return step.row !== row;
        if (step.kind !== "locate" && step.kind !== "require") return true;
        // A check of the row is made of a row the call holds: a read taken
        // only to hold it is none where the provider holds no row.
        return step.kind === "require" && step.none
          ? step.rows[0] === row && !capabilities.supportsRowLocks
          : step.rows.every(({ member }) => member?.of !== row);
      })
    ) {
      write.locates = true;
      sent.splice(from, 1);
    }
  }
  // One statement hears what it writes. Of several, a write that leaves to
  // the database what the call goes on to read returns its row: the provider
  // must be able to. A batch hears nothing between its statements: it reads a
  // value where it writes it, from the row its key names. So it can only be
  // a field of a row created under a key of the call's own.
  for (const step of planned) {
    // What cannot be done for a row not read yet is said before any is read.
    if (step.kind === "each")
      compose(
        operation,
        statements,
        held
          ? step.dry
          : [{ kind: "require", rows: [step.target] }, ...step.dry],
        undefined,
        sink,
        held
      );
    const { row, left = [] } =
      (sent.length > 1 && statements.settles(step)) || {};
    if (left.length === 0) continue;
    if (!capabilities.supportsReturning)
      unsupported(
        "a value the database decides on a provider without RETURNING"
      );
    if (
      !held &&
      (step.kind === "update" ||
        left.some((field) => operation.schema.keys(row!.model).includes(field)))
    )
      unsupported("a value the database decides, read by a batch");
  }
  return sent;
}

/**
 * The statements sent one after the other, each heard before the next: a row
 * is read under lock where the plan places it. More than one hold together in
 * a transaction.
 */
async function inOrder(
  operation: SqlOperationContext,
  driver: AnyDriver,
  statements: Statements,
  plan: Plan
): Promise<void> {
  const { model, located, steps, sink, seam } = plan;
  const { capabilities, mutations, identifiers } = operation.driver.adapter;
  // What the call heard is told once every statement is in: a reader that
  // refuses then undoes them all.
  const heard: (() => void)[] = [];
  const tell = () => {
    for (const told of heard) told();
  };
  const run = async (
    transport: AnyDriver,
    steps = plan.steps,
    answered = new Set<Step>()
  ): Promise<void> => {
    if (steps === plan.steps) heard.length = 0;
    const send = (statement: Sql, of: AnyModel) =>
      transport._execute<Input>(statement, contextOf(operation, of));
    statements.asks = send;
    for (const step of steps) {
      if (answered.has(step) || !holds(step.when)) continue;
      if (step.kind === "each") {
        // Its rows are read, and held; each is then written as its steps say.
        const rows = await members(operation, statements, step, send);
        for (const [, planned] of rows)
          await run(
            transport,
            compose(operation, statements, planned, undefined, sink, true),
            answered
          );
        // Whoever takes its rows has them read again, written, or counted.
        const written = await again(operation, statements, step, rows, send);
        heard.push(() => step.answers?.take(written, undefined, rows.length));
      } else if (step.kind === "require" && step.none) {
        const query = statements.asked(step.rows[0]!, step, true);
        if (
          query &&
          (await send(query.sql, step.rows[0]!.model)).rows.length > 0
        )
          throw step.failure!();
      } else if (seeks(step)) {
        // A row that must be there is sought as one that is read: held, and
        // refused where it is not there.
        const [row] = step.rows as [Located];
        // An absence cannot be held. Where a lock would hold one the call
        // goes on to fill, the read takes none: the row it finds is read
        // again, held, and is the row found only if what named it still does.
        const open = Boolean(capabilities.locksMissingKeys && row.orElse);
        for (const again of open ? [false, true] : [false]) {
          if (again && !row.found) break;
          const query = statements.lookup(step.rows, again || !open, again);
          const { rows } = await send(query.sql, row.model);
          settle(operation, statements, step.rows, query, rows, again);
        }
      } else if (step.kind === "read") {
        const query = statements.read(step);
        const { rows } = await send(query.sql, step.row.model);
        heard.push(() => step.take(rows, query));
      } else {
        const of = writtenModel(step);
        const [statement, ...more] = (await statements.write(step)) as [
          Sql,
          ...Sql[],
        ];
        const told = statements.settles(step);
        const reader = step.answers;
        // A write returns its row where it answers a read of it, where it is
        // what finds the row, or where it leaves to the database what the
        // call goes on to read.
        const row = rowOf(step);
        // Of a row it names, its key says it wrote one.
        const whole =
          step.locates || told?.left.length
            ? statements.projections(of)[
                step.locates && row!.named ? "key" : "row"
              ]
            : undefined;
        // The arm an insert of what is not there took rides beside the row.
        const arm =
          step.kind === "insert" && step.key && sink && mutations.upserted;
        let sent = statement;
        if (reader)
          sent = asking(
            operation,
            of,
            statement,
            reader,
            arm ? [identifiers.aliased(arm, "__inserted")] : []
          );
        else if (whole) sent = statements.returning(statement, whole);
        const { judged } = statements;
        const response = await send(sent, of).catch((error) => {
          // The statement refused the row it would have produced.
          throw judged && error instanceof NestedWriteAssertionError
            ? judged.refusal()
            : error;
        });
        const { rows } = response;
        for (const next of more) await send(next, of);
        if (whole && rows.length === 0)
          throw missing(operation, told?.row ?? row!);
        // What it returned is the row's, where a step comes after it.
        const [back] =
          whole &&
          steps.slice(steps.indexOf(step) + 1).some((next) => next !== reader)
            ? operation.queries.decodeProjection(
                (reader?.projection ?? whole).shape,
                rows,
                true
              )
            : [];
        if (step.locates && back && !row!.named) row!.found = back;
        if (arm) {
          // The row was found: nothing more is read of it.
          if (rows[0]!.__inserted !== true) located!.found = {};
          rows[0]!.__inserted = undefined;
        }
        if (told) statements.now(step, told.row, back);
        if (reader) {
          answered.add(reader as Step);
          heard.push(() =>
            reader.take(rows, undefined, wrote(operation, response))
          );
        }
      }
    }
  };
  // One statement holds by itself. So do an INSERT and the read of its answer,
  // unless the provider cannot return what it wrote and a refused answer must
  // undo it.
  const [first, second] = steps;
  if (
    (steps.length === 1 && first!.kind !== "each") ||
    (steps.length === 2 &&
      first!.kind === "insert" &&
      second!.kind === "read" &&
      capabilities.supportsReturning)
  ) {
    await unenveloped(operation, seam, () => run(driver), tell);
    return;
  }
  // The transaction says how far its commit went; the seam hears it once.
  let phase: "pending" | "ready" | "committed" = "pending";
  const at = contextOf(operation, model);
  try {
    await driver.withTransaction(
      async (transport) => {
        await run(transport);
        tell();
      },
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
    );
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
}

/** Statements sent outside any envelope: durable once they return, perhaps visible where they fail. */
async function unenveloped<T>(
  operation: SqlOperationContext,
  seam: WriteOutcomeSeam | undefined,
  send: () => Promise<T>,
  decode: (sent: T) => unknown
): Promise<unknown> {
  let sent: T;
  try {
    sent = await send();
  } catch (error) {
    if (!(error instanceof UniqueConstraintError))
      await operation.stateWriteOutcome(seam?.mayBeVisible, error);
    throw error;
  }
  let value: unknown;
  let failure: { readonly error: unknown } | undefined;
  try {
    value = decode(sent);
  } catch (error) {
    failure = { error };
  }
  await operation.stateWriteOutcome(seam?.committedSegment, failure?.error);
  if (failure) throw failure.error;
  return value;
}

/** Atomic batch: read the rows first, level by level, then one batch that asserts what was read. */
async function inBatch(
  operation: SqlOperationContext,
  driver: AnyDriver,
  statements: Statements,
  plan: Plan
): Promise<void> {
  const { model, steps } = plan;
  const [series] = steps;
  if (series?.kind === "each") {
    // Rows written one by one are a batch each: the next row sees what the
    // last one wrote, and what was committed stays where a later row fails.
    // The error then says how far the call went.
    const send = (statement: Sql, of: AnyModel) =>
      driver._execute<Input>(statement, contextOf(operation, of));
    const rows = await members(operation, statements, series, send);
    const said = (done: number, phase: "member" | "result") => ({
      atomicity: "segment" as const,
      phase,
      committedSegments: done,
      committedWriteMembers: done,
      completedMembers: done,
    });
    // A row read is held by nothing until its own batch: that batch requires
    // it, by its key.
    for (const [done, [row, planned]] of rows.entries())
      try {
        await inBatch(operation, driver, statements, {
          ...plan,
          steps: compose(
            operation,
            statements,
            [{ kind: "require", rows: [row] }, ...planned],
            undefined,
            plan.sink,
            false
          ),
        });
      } catch (error) {
        throw done > 0
          ? attachRecordSeriesProgress(error, said(done, "member"))
          : error;
      }
    try {
      series.answers?.take(
        await again(operation, statements, series, rows, send),
        undefined,
        rows.length
      );
    } catch (error) {
      throw attachRecordSeriesProgress(error, said(rows.length, "result"));
    }
    return;
  }
  /** Statements sent together: one by itself, several as one batch. */
  const together = async (
    sent: { statement: Sql; of: AnyModel }[],
    acknowledged?: () => Promise<void>
  ): Promise<{ rows: Input[]; rowCount: number }[]> => {
    const [alone] = sent;
    if (sent.length === 1) {
      const response = await driver._execute<Input>(
        alone!.statement,
        contextOf(operation, alone!.of)
      );
      await acknowledged?.();
      return [response];
    }
    return driver._executeBatch<Input>(
      sent.map(({ statement, of }) => {
        const at = contextOf(operation, of);
        const query = driver._prepare(statement, at);
        return transferPreparedStatement(query, { ...query, context: at });
      }),
      undefined,
      contextOf(operation, model),
      acknowledged
    );
  };
  // Rows are read once every row they are found through, or planned under,
  // has been: the lookups of one level are sent together.
  let waiting = steps.flatMap((step) => (step.kind === "locate" ? [step] : []));
  const tried = new Set<Located>();
  const needs = (row: Located): Located[] => {
    const rows = statements.narrowed(row) ? [row.member!.of] : [];
    for (let under = row.when; under; under = under.outer) rows.push(under.row);
    // A row the call names is never read.
    return rows.filter((needed) => !needed.named);
  };
  while (waiting.length > 0) {
    const level = waiting.filter((step) =>
      step.rows.every((row) => needs(row).every((needed) => tried.has(needed)))
    );
    // A row the call names is not read, where it is sought beside one that is.
    const read = level
      .filter((step) => holds(step.when))
      .map((step) => step.rows.filter((row) => !row.named));
    const lookups = read.map((rows) => statements.lookup(rows, false));
    const responses =
      read.length > 0
        ? await together(
            read.map(([row], index) => ({
              statement: lookups[index]!.sql,
              of: row!.model,
            }))
          )
        : [];
    for (const [index, rows] of read.entries())
      settle(
        operation,
        statements,
        rows,
        lookups[index]!,
        responses[index]!.rows
      );
    for (const step of level) for (const row of step.rows) tried.add(row);
    waiting = waiting.filter((step) => !level.includes(step));
  }
  // What the call hears of the batch: the rows a read asked for, by statement.
  const heard: { at: number; take: Taker["take"] }[] = [];
  const answered = new Set<Step>();
  // What each row found must still be when the batch runs, in batch order.
  const asserted: {
    at: number;
    /** The assertion's own question, the answer that satisfies it, and its refusal. */
    probe: Sql;
    holds: (rows: Input[]) => boolean;
    refusal: () => Error;
    /** Asked amid the batch's own writes: asking again after it rolled back says nothing. */
    inPlace?: boolean;
  }[] = [];
  const { assertions } = operation.driver.adapter;
  const batch: { statement: Sql; of: AnyModel }[] = [];
  /** A question the batch asks of the database, and stops at where the answer is not the one it needs. */
  const assert = (
    probe: Sql,
    of: AnyModel,
    refusal: () => Error,
    none = true,
    inPlace = false
  ) => {
    asserted.push({
      at: batch.length,
      probe,
      holds: (rows) => rows.length > 0 !== none,
      refusal,
      inPlace,
    });
    batch.push({
      statement: assertions[none ? "notExists" : "exists"](probe),
      of,
    });
  };
  let writes = 0;
  for (const step of steps) {
    // A batch has no step of rows not read yet ({@link ahead}).
    if (answered.has(step) || !holds(step.when) || step.kind === "each")
      continue;
    if (step.kind === "locate" || step.kind === "require") {
      const none = step.kind === "require" && step.none;
      for (const row of step.rows) {
        // What was read ahead must still be there; nothing is asked of a row
        // that was not found.
        const probe =
          step.kind === "require" || row.named || row.found
            ? statements.asked(row, step.kind === "require" ? step : {}, !none)
                ?.sql
            : undefined;
        if (probe)
          assert(
            probe,
            row.model,
            (step.kind === "require" && step.failure) ||
              (() => missing(operation, row, true)),
            Boolean(none),
            !none && writes > 0 && row.moved !== undefined
          );
      }
    } else if (step.kind === "read") {
      const query = statements.read(step);
      heard.push({ at: batch.length, take: (rows) => step.take(rows, query) });
      batch.push({ statement: query.sql, of: step.row.model });
    } else {
      writes++;
      const of = writtenModel(step);
      const written = await statements.write(step);
      // What the write reads again from a row found must be there.
      for (const { probe, model: from, refusal } of statements.required.splice(
        0
      ))
        assert(probe, from, refusal);
      const reader = step.answers;
      if (reader) {
        answered.add(reader as Step);
        heard.push({ at: batch.length, take: reader.take });
        written[0] = asking(operation, of, written[0]!, reader);
      }
      // A statement that judges the row it would produce stops the batch as
      // an assertion does, amid its writes.
      const { judged } = statements;
      if (judged)
        asserted.push({
          at: batch.length,
          probe: judged.probe ?? written[0]!,
          holds: () => true,
          refusal: judged.refusal,
          inPlace: !judged.probe,
        });
      for (const statement of written) batch.push({ statement, of });
      const told = statements.settles(step);
      if (told) statements.now(step, told.row);
    }
  }
  // The batch is durable once acknowledged; a listener that fails then is held
  // until the answer is decoded, which stays primary where it fails too.
  const { seam } = plan;
  let held: { readonly failure: unknown } | undefined;
  const acknowledged = async () => {
    try {
      await seam?.committedSegment?.();
    } catch (failure) {
      held = { failure };
    }
  };
  const ordered = driver.supportsOrderedCommittedSegments;
  let responses: Awaited<ReturnType<typeof together>>;
  try {
    responses = await together(batch, ordered ? acknowledged : undefined);
    if (!ordered) await acknowledged();
  } catch (error) {
    if (held)
      throw operation.answered(retainWriteOutcomeFailure(error, held.failure));
    // The assertion that failed is the one the provider points at. Where it
    // points at none, each one read ahead is asked again, in order: the first
    // that no longer holds is what another session changed, and where all
    // still hold, the failure is the first one asked amid the batch's writes.
    let failed: (typeof asserted)[number] | undefined;
    if (error instanceof NestedWriteAssertionError) {
      const index = error.meta.statementIndex;
      failed = asserted.find((assertion) => assertion.at === index);
      for (const assertion of failed ? [] : asserted) {
        if (assertion.inPlace) continue;
        // A judgement asked again fails as its statement did.
        const holds = await driver
          ._execute<Input>(assertion.probe, contextOf(operation, model))
          .then(
            ({ rows }) => assertion.holds(rows),
            () => false
          );
        if (holds) continue;
        failed = assertion;
        break;
      }
      failed ??= asserted.find((assertion) => assertion.inPlace);
    }
    const refusal = failed?.refusal();
    // Nothing is visible where only assertions ran before the batch stopped.
    const stoppedBeforeAnyWrite =
      error instanceof NestedWriteAssertionError &&
      asserted.length === (asserted.at(-1)?.at ?? -1) + 1;
    if (
      !(
        stoppedBeforeAnyWrite ||
        ordered ||
        error instanceof UniqueConstraintError ||
        // The batch wrote nothing, and the call is planned once more.
        (refusal && outdated.has(refusal) && !plan.again)
      )
    )
      await operation.stateWriteOutcome(seam?.mayBeVisible, error);
    if (refusal) throw refusal;
    throw error instanceof NestedWriteAssertionError
      ? new NestedWriteError(NESTED_WRITE_ASSERTION_FLOOR_MESSAGE, "", {
          code: VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED,
          cause: error,
        })
      : error;
  }
  try {
    for (const { at, take } of heard)
      take(responses[at]!.rows, undefined, wrote(operation, responses[at]!));
  } catch (failure) {
    // The batch is durable: a failure that follows it says what it wrote.
    const reported = attachRecordSeriesProgress(worded(operation, failure), {
      atomicity: "segment",
      phase: "result",
      committedSegments: 1,
      // The call is one member, durable once it wrote.
      committedWriteMembers: Number(writes > 0),
      completedMembers: 0,
    });
    throw held
      ? operation.answered(retainWriteOutcomeFailure(reported, held.failure))
      : reported;
  }
  if (held) throw operation.answered(held.failure);
}

/** A value the provider returned that its scalar refuses is the operation's failure to word. */
function worded(operation: SqlOperationContext, error: unknown): unknown {
  return error instanceof InvalidScalarResult ||
    error instanceof RecursiveOutputOverBudget ||
    error instanceof GatedFieldRefusal
    ? operation.failure(error, "result")
    : error;
}

/** Plans a standalone `create` or `update`; throws {@link UNSUPPORTED} outside the prototype's scope. */
export function planWrite(
  operation: SqlOperationContext,
  driver: AnyDriver,
  model: AnyModel,
  args: Arguments,
  raw: unknown,
  seam?: WriteOutcomeSeam,
  again = false
): () => Promise<unknown> {
  const sink = writeSinks.get(operation.attribution);
  const verb = operation.operation;
  // Not a limit of the plan: nothing measures yet that it sends no more
  // statements than the shipped engine where a write returns nothing.
  if (verb !== "create" && !driver.adapter.capabilities.supportsReturning)
    unsupported("an update on a provider without RETURNING");
  const planning: Planning = {
    operation,
    schema: operation.schema,
    steps: [],
    said: paired(args, raw),
    sink,
  };
  const { steps } = planning;
  // A key rewritten beside a relation is judged by rules the plan has not.
  if (
    verb === "upsert" &&
    operation.schema.namesRelation(model, args.update as Input) &&
    operation.schema
      .keys(model)
      .some((key) => (args.update as Input)[key] !== undefined)
  )
    unsupported("an upsert that rewrites its key beside a relation");
  // The call's own verb is asked of the rows of its model, as a nested verb
  // is of a row's members: once, or once per row it creates.
  const place: Place = {
    model,
    limit: args.limit as number | undefined,
    one: (verb, where, lax) =>
      locate(planning, {
        model,
        where: where as Input,
        unique: true,
        lax,
        judged: judgedAt(verb),
      }),
    make: (data) => createSteps(planning, model, data),
    // Every row of the model is one of its rows.
    join: () => undefined,
  };
  const many = verb.endsWith("Many");
  const roots = entries(
    {
      create: args.data,
      createMany: args.data,
      delete: args.where,
      deleteMany: args.where ?? {},
    }[verb] ?? args
  ).map((entry) =>
    ask(planning, place, verb === "createMany" ? "create" : verb, entry)
  );
  const located = many ? undefined : roots[0]!;
  const matched = located?.matched ?? located;
  if (steps.length === 1 && steps[0]!.kind === "locate")
    unsupported("an update that writes nothing");
  const planned = steps.length;
  const q = operation.queries;
  const held = driver.supportsTransactions;
  let value: unknown;
  let answer: Reading | undefined;
  if (many) {
    const nested = planned > roots.length;
    const { mutations } = operation.driver.adapter;
    // A row left out leaves no trace: nothing may have been written for it.
    if (
      args.skipDuplicates &&
      (nested || mutations.skipDuplicatesStrategy !== "sql")
    )
      unsupported("rows left out where another holds their place");
    // The shipped engine commits each row created with rows of its own by
    // itself where the provider sends batches: the documented contract.
    if (verb === "createMany" && nested && !held)
      unsupported("rows created with rows of their own, a batch each");
    // A verb over many rows answers with the rows its writes return, as the
    // caller selected them, or with their number: not where a later row's
    // steps may change a row an earlier one returned.
    if (
      verb === "createMany" &&
      nested &&
      args.select &&
      steps.some(
        (step) =>
          (step.kind === "update" || step.kind === "delete") &&
          step.target.model === model
      )
    )
      unsupported("a row a later one may change, read as it was written");
    const projection = args.select
      ? q.prepareProjection(model, { select: args.select })
      : undefined;
    if (args.limit === 0 || planned === 0)
      return async () => operation.emptyBulkResult(projection);
    const rows: Input[] = [];
    const counted = { count: 0 };
    value = projection ? rows : counted;
    const taker: Taker = {
      projection,
      take: (returned, _, written = 0) => {
        counted.count += written;
        if (projection)
          rows.push(
            ...q.decodeResult(returned, verb, (decoded) =>
              q.decodeProjection(projection.shape, decoded)
            )
          );
      },
    };
    for (const [at, step] of steps.entries())
      if (
        step.kind === "insert"
          ? roots.includes(step.made)
          : verb !== "createMany"
      )
        steps[at] = {
          ...step,
          answers: taker,
          skips: Boolean(args.skipDuplicates),
        } as Step;
  } else {
    // The call's answer is its row, read as the caller asked: as its last
    // write leaves it, or as it was where it goes.
    const projection = q.prepareProjection(model, args);
    answer = {
      kind: "read",
      row: located!,
      projection,
      take: (rows, query) => {
        value = published(
          operation,
          query?.shape ?? projection.shape,
          rows,
          query
        );
      },
    };
    const last = steps.at(-1)!;
    steps.splice(
      last.kind === "delete" && last.target === located && !last.marks
        ? -1
        : steps.length,
      0,
      answer
    );
    reads(located!, operation.schema.keys(model));
  }
  const statements = new Statements(operation);
  const plan: Plan = {
    model,
    steps: compose(operation, statements, steps, located, sink, held),
    located,
    sink,
    seam,
    again,
  };
  // A kept row answers as its write left it: the write must be able to say.
  if (
    plan.steps.some(
      (step) =>
        step.kind === "delete" &&
        step.marks &&
        step.target === located &&
        !step.answers
    )
  )
    unsupported("a kept row's answer its write cannot give");
  // One statement is its own atomic unit, and hears what it writes. Rows
  // written one by one are a unit each where the provider sends batches.
  const [first] = plan.steps;
  const one = plan.steps.length === 1 && first!.kind !== "each";
  if (planned > 1) operation.requireAtomicUnit();
  return () =>
    (one || held
      ? inOrder(operation, driver, statements, plan)
      : inBatch(operation, driver, statements, plan)
    )
      .then(() => {
        // A hook hears which arm an upsert took, where one ran.
        if (verb === "upsert" && (matched!.found || !located!.found))
          sink?.upserted(!located!.found);
        return value;
      })
      .catch(async (error) => {
        // What the call decided from no longer holds, and nothing was
        // written: it is planned once more. A row it found is gone; or a row
        // it went on to create where it found none was created by another
        // session first. Which of the row's keys the provider names then is
        // its own choice, so the call looks again. Not where a hook saw rows
        // of the attempt.
        const retried =
          // One statement read nothing before it wrote; what rows written one
          // by one committed is never written again.
          !(again || one || (first!.kind === "each" && !held)) &&
          steps.every((step) => step.kind !== "read" || step === answer);
        const sought =
          error instanceof UniqueConstraintError &&
          steps
            .flatMap((step) => (step.kind === "locate" ? step.rows : []))
            .find((row) => row.orElse && !row.found);
        const there = async (row: Located) =>
          (
            await driver._execute<Input>(
              statements.lookup([row], false).sql,
              contextOf(operation, row.model)
            )
          ).rows.length > 0;
        if (
          retried &&
          (outdated.has(error) || (sought && (await there(sought))))
        )
          return planWrite(operation, driver, model, args, raw, seam, true)();
        // An upsert went on to create a row the call sees, on a model no rule
        // lets it update: the refusal is the update's.
        const name = model["~"].names.ts!;
        if (
          sought &&
          verb === "upsert" &&
          operation.scope?.rows.domain.verbs
            ?.get(name)
            ?.some((layer) => JSON.stringify(layer?.update) === '{"OR":[]}') &&
          (await there({ ...sought, judged: undefined }))
        )
          throw new ForbiddenError(name, "update", {
            reason: "the row this upsert locates exists",
            cause: error,
          });
        throw worded(operation, error);
      });
}
