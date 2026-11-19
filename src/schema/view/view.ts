/**
 * `s.view`: a database view declared as a read of a model.
 *
 * A view is a `Model` whose state is DERIVED from its source and its query:
 * its scalars are the source scalars the query projects, by the same objects
 * and so under the same column names and types; its keys are the source keys
 * whose members are all projected, since a read returns source rows; and each
 * non-scalar selection (a relation, `_count`, `_aggregate`) is a JSON column
 * the state names in {@link ViewFacts.documents}. Nothing is declared twice:
 * what a view row holds is what the query reads.
 *
 * A query that groups (`by`, what `groupBy` takes) makes an AGGREGATED
 * view: one row per group, its columns flat and typed (a grouped field under
 * its name, `count`, `sumAmount`, …), its key the `by` list where no member
 * is nullable. Each is a scalar the view derives, held in
 * {@link ViewFacts.aggregated} with where it comes from.
 *
 * The source is a thunk (schema rule 3), so the state is derived on first
 * read, when every model exists. A modifier chained on the view reads it at
 * once.
 */

import type { ObjectSchema, VibSchema } from "@validation";
import type { ModelOperationInput } from "@validation/model";
import {
  type GroupByMember,
  groupedColumn,
} from "@validation/model/args/time-step";
import {
  type DeclaredDocumentKeys,
  type ProjectableScalarKeys,
  projectableScalarNames,
} from "@validation/model/core/projection";
import v from "@validation/primitives/v";
import { isRecord } from "@validation/value-guards";
import { type AnyModel, Model, type ModelState } from "../model";
import type { NameFromKeys } from "../model/helper";
import { emptyRecord, put } from "../record";
import type {
  SlotKeyFields,
  SlotOwnerModel,
} from "../relation/static-membership";
import type { AnyRelation } from "../relation/types";
import type { Scalar } from "../scalars/base";
import { bigInt } from "../scalars/bigint/scalar";
import { derivedScalar } from "../scalars/common";
import { decimal } from "../scalars/decimal/scalar";
import { int } from "../scalars/int/scalar";
import { number } from "../scalars/number/scalar";
import { string } from "../scalars/string/scalar";
import {
  type ViewAggregate,
  type ViewColumnOrigin,
  type ViewFacts,
  viewFacts,
} from "./facts";

/**
 * `T` with every list it holds read-only, at any depth. A view's query is
 * inferred `const`, so each list in it (`in: [...]`, `orderBy: [...]`,
 * `OR: [...]`) is a read-only tuple, which a mutable list in the constraint
 * does not take: the inference then fails without a word, the query is
 * checked against the constraint and passes, and the view's columns are read
 * off the constraint, every scalar of the source, instead of off the query.
 */
type ReadonlyLists<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyLists<T[K]> }
    : T;

/**
 * What a view may say: what `findMany` takes on its source, without `cursor`,
 * a paging anchor and not a row set.
 *
 * The first arm answers the moment TypeScript reads the signature with `M`
 * still at its constraint, `Model<any>`: the argument type of a model whose
 * state is `any` has no end (TS2589). Once `M` is the source, the second arm
 * is the one that checks the query.
 */
export type ViewQuery<M extends AnyModel> = 0 extends 1 & M["~"]["state"]
  ? unknown
  : ReadonlyLists<
      Omit<NonNullable<ModelOperationInput<M, "findMany">>, "cursor">
    > & {
      // A query that groups is an aggregated view's (`AggregatedViewQuery`).
      readonly by?: never;
    };

type GroupByInput<M extends AnyModel> = NonNullable<
  ModelOperationInput<M, "groupBy">
>;

/**
 * What an aggregated view may say: what `groupBy` takes on its source, with
 * the same guard as {@link ViewQuery} while `M` is at its constraint, and its
 * lists read-only for the same reason.
 */
export type AggregatedViewQuery<M extends AnyModel> = 0 extends 1 &
  M["~"]["state"]
  ? unknown
  : ReadonlyLists<GroupByInput<M>>;

/** The keys of a selection its value does not switch off. */
type AskedKeys<Selection> = {
  [K in keyof Selection]: Selection[K] extends false | undefined ? never : K;
}[keyof Selection];

/** The source scalars a query projects: the selected ones, or all, but the omitted. */
type ViewScalarKeys<M extends AnyModel, Q> = Exclude<
  Q extends { select: infer Selection extends object }
    ? Extract<AskedKeys<Selection>, ProjectableScalarKeys<M>>
    : ProjectableScalarKeys<M>,
  Q extends { omit: infer Omitted extends object } ? AskedKeys<Omitted> : never
>;

type CompoundKeys = Record<string, ObjectSchema<Record<string, VibSchema>>>;

/** The compound keys of the source whose members the view projects. */
type ProjectedCompoundKeys<Keys, Projected> = Keys extends CompoundKeys
  ? {
      [Name in keyof Keys as Keys[Name] extends ObjectSchema<infer Members>
        ? keyof Members extends Projected
          ? Name
          : never
        : never]: Keys[Name];
    }
  : undefined;

type SourceRelations<M extends AnyModel> = M["~"]["state"]["relations"];

/** The source relations whose name no column of the view takes. */
type CandidateRelationKeys<M extends AnyModel, Q> = Exclude<
  keyof SourceRelations<M>,
  ViewScalarKeys<M, Q> | DeclaredDocumentKeys<M, Q>
>;

/**
 * The relations a view inherits: its source's whose key fields it keeps
 * (`SlotKeyFields`, asked of the table whose slot it is), under a name no
 * column of the view takes. Any other is no member of the view's type, as
 * the runtime refuses it.
 */
type InheritedRelationKeys<M extends AnyModel, Q> = {
  [K in CandidateRelationKeys<M, Q>]: [
    Exclude<
      SlotKeyFields<SlotOwnerModel<M>, K, SourceRelations<M>[K]>,
      ViewScalarKeys<M, Q>
    >,
  ] extends [never]
    ? K
    : never;
}[CandidateRelationKeys<M, Q>];

/** What the client types read of a view's declaration. */
export interface ViewDeclaration<M extends AnyModel, Q> {
  readonly source: M;
  readonly query: Q;
}

export interface ViewState<M extends AnyModel, Q> extends ModelState {
  shape: Pick<M["~"]["state"]["scalars"], ViewScalarKeys<M, Q>> &
    Pick<SourceRelations<M>, InheritedRelationKeys<M, Q>>;
  scalars: Pick<M["~"]["state"]["scalars"], ViewScalarKeys<M, Q>>;
  relations: Pick<SourceRelations<M>, InheritedRelationKeys<M, Q>>;
  uniques: Pick<
    M["~"]["state"]["uniques"],
    Extract<keyof M["~"]["state"]["uniques"], ViewScalarKeys<M, Q>>
  >;
  compoundId: ProjectedCompoundKeys<
    M["~"]["state"]["compoundId"],
    ViewScalarKeys<M, Q>
  >;
  compoundUniques: ProjectedCompoundKeys<
    M["~"]["state"]["compoundUniques"],
    ViewScalarKeys<M, Q>
  >;
  tableName: undefined;
  indexes: [];
  omit: undefined;
  view: ViewDeclaration<M, Q>;
}

/** A scalar of `F`'s type and domain, nullable. */
type NullableOf<F> = F extends {
  readonly nullable: () => infer N extends Scalar;
}
  ? N
  : never;

/** A grouped field as a view's only key member: unique, where its type says so. */
type UniqueOf<F> = F extends { readonly unique: () => infer U extends Scalar }
  ? U
  : F;

type NullableNumber = NullableOf<ReturnType<typeof number>>;
type Count = ReturnType<typeof int>;
/** A period's start, the `YYYY-MM-DD` text `groupBy` answers for it. */
type Period = ReturnType<typeof string>;

/** The members of a query's `by`, one or a list, as written. */
type ByMembers<Q> = Q extends { readonly by: infer By }
  ? By extends readonly unknown[]
    ? By
    : readonly [By]
  : never;

/** The field a `by` member groups: itself, or the key of `{ field: step }`. */
type GroupedField<Member> = Member extends string
  ? Member
  : keyof Member & string;

/** The fields of a query's `by` list, in its order. */
type GroupedFields<Q, By = ByMembers<Q>> = {
  -readonly [I in keyof By]: GroupedField<By[I]>;
};

type IsNullable<F> = F extends {
  readonly "~": { readonly state: { readonly nullable: true } };
}
  ? true
  : false;

type SourceScalars<M extends AnyModel> = M["~"]["state"]["scalars"];

/**
 * The key a view grouped by `Q`'s `by` has: none where a member is nullable,
 * the field alone for one member, a compound key for several.
 */
type GroupKey<M extends AnyModel, Q, Fields = GroupedFields<Q>> = true extends {
  [I in keyof Fields]: IsNullable<SourceScalars<M>[Fields[I] & string]>;
}[keyof Fields & number]
  ? "none"
  : Fields extends readonly [string]
    ? "single"
    : Fields extends readonly [string, string, ...string[]]
      ? "compound"
      : "none";

/** A grouped column: the field's scalar, or the day its period starts on. */
type GroupedScalar<F, Member, Key> = Key extends "single"
  ? UniqueOf<StepScalar<F, Member>>
  : StepScalar<F, Member>;

type StepScalar<F, Member> = Member extends string
  ? F
  : IsNullable<F> extends true
    ? NullableOf<Period>
    : Period;

/** The fields a selection asks for: the ones its value does not switch off. */
type Selected<Selection> = AskedKeys<Selection> & string;

/** `sum` and `amount` as `sumAmount`. */
type Column<
  Prefix extends string,
  F extends string,
> = `${Prefix}${Capitalize<F>}`;

type CountScalars<Q> = Q extends { readonly _count: true }
  ? { count: Count }
  : Q extends { readonly _count: infer Selection extends object }
    ? {
        [F in Selected<Selection> as F extends "_all"
          ? "count"
          : Column<"count", F>]: Count;
      }
    : unknown;

type ScalarType<F> = F extends {
  readonly "~": { readonly state: { readonly type: infer T } };
}
  ? T
  : never;

/**
 * `_min` and `_max` are the field's type, nullable. An average of decimals
 * is a decimal at the field's scale, of any other number a number. A sum is
 * the field's type, but a sum of ints or doubles is a number: what `groupBy`
 * answers past the int range.
 */
type AggregateScalar<A, F> = A extends "_min" | "_max"
  ? NullableOf<F>
  : ScalarType<F> extends "decimal"
    ? NullableOf<F>
    : A extends "_sum"
      ? ScalarType<F> extends "bigint"
        ? NullableOf<F>
        : NullableNumber
      : NullableNumber;

type AggregateScalars<S, Q, A extends `_${string}`> = Q extends {
  readonly [K in A]: infer Selection extends object;
}
  ? {
      [F in Selected<Selection> & keyof S as Column<
        A extends `_${infer Name}` ? Name : never,
        F
      >]: AggregateScalar<A, S[F]>;
    }
  : unknown;

/** An aggregated view's columns: its grouped fields, then its aggregates. */
type AggregatedScalars<M extends AnyModel, Q> = {
  [Member in ByMembers<Q>[number] as GroupedField<Member>]: GroupedScalar<
    SourceScalars<M>[GroupedField<Member>],
    Member,
    GroupKey<M, Q>
  >;
} & CountScalars<Q> &
  AggregateScalars<SourceScalars<M>, Q, "_avg"> &
  AggregateScalars<SourceScalars<M>, Q, "_sum"> &
  AggregateScalars<SourceScalars<M>, Q, "_min"> &
  AggregateScalars<SourceScalars<M>, Q, "_max">;

/** A scalar's base validator: a compound key member's. */
type BaseOf<F> = F extends {
  readonly "~": {
    readonly state: { readonly base: infer B extends VibSchema };
  };
}
  ? B
  : never;

type GroupedMembers<M extends AnyModel, Q, Fields> = {
  [F in Fields[keyof Fields & number] & string]: BaseOf<
    AggregatedScalars<M, Q>[F & keyof AggregatedScalars<M, Q>]
  >;
};

/**
 * The state of an aggregated view: one row per group, its columns flat
 * scalars, keyed by its `by` list where no member is nullable.
 */
export interface AggregatedViewState<M extends AnyModel, Q> extends ModelState {
  shape: AggregatedScalars<M, Q>;
  scalars: AggregatedScalars<M, Q>;
  // biome-ignore lint/complexity/noBannedTypes: an aggregated view's columns are not its source's, so it inherits no relation
  relations: {};
  uniques: GroupKey<M, Q> extends "single"
    ? {
        [F in GroupedFields<Q>[0] & string]: Extract<
          AggregatedScalars<M, Q>[F & keyof AggregatedScalars<M, Q>],
          Scalar
        >;
      }
    : Record<string, never>;
  compoundId: GroupKey<M, Q> extends "compound"
    ? {
        [Name in NameFromKeys<GroupedFields<Q>>]: ObjectSchema<
          GroupedMembers<M, Q, GroupedFields<Q>>
        >;
      }
    : undefined;
  compoundUniques: undefined;
  tableName: undefined;
  indexes: [];
  omit: undefined;
  view: ViewDeclaration<M, Q>;
}

/** The state a view model holds: a model's, and the facts that make it a view. */
type ViewModelState = ModelState & { readonly view: ViewFacts };

const STATE_KEYS = [
  "shape",
  "compoundId",
  "compoundUniques",
  "tableName",
  "indexes",
  "omit",
  "scalars",
  "relations",
  "uniques",
  "view",
] as const satisfies readonly (keyof ViewModelState)[];

/**
 * The keys of a model's state that {@link STATE_KEYS} leaves out: none. A key
 * added to `ModelState`, optional or not, makes this a name, and
 * `deferredState` then asks for a state no model has: the build fails until
 * the key is listed and `deriveViewState` answers it for a view.
 */
type UnderivedStateKeys = Exclude<
  keyof ViewModelState,
  (typeof STATE_KEYS)[number]
>;

/**
 * A state whose members are derived on the first read of any of them, and are
 * plain data from then on, as a table's state is: every later read finds a
 * value, not an accessor. A view that reads itself through its sources asks
 * again while the first answer is being made, and is refused there.
 */
function deferredState(
  derive: () => ViewModelState & Record<UnderivedStateKeys, never>
): ViewModelState {
  let deriving = false;
  const state = {} as ViewModelState;
  const settle = (): ViewModelState => {
    if (deriving) throw new Error("A view cannot read itself");
    deriving = true;
    try {
      const derived = derive();
      for (const key of STATE_KEYS) {
        Object.defineProperty(state, key, {
          value: derived[key],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    } finally {
      deriving = false;
    }
    return state;
  };
  for (const key of STATE_KEYS) {
    Object.defineProperty(state, key, {
      enumerable: true,
      configurable: true,
      get: () => settle()[key],
    });
  }
  return state;
}

/** The keys of a selection its value does not switch off, in the order written. */
function askedKeys(selection: unknown): string[] {
  return isRecord(selection)
    ? Object.keys(selection).filter(
        (key) => selection[key] !== false && selection[key] !== undefined
      )
    : [];
}

/** The compound keys of `keys` whose members are all in `projected`. */
function projectedCompoundKeys<Keys extends CompoundKeys>(
  keys: Keys | undefined,
  projected: ReadonlySet<string>
): Keys | undefined {
  const kept = Object.entries(keys ?? {}).filter(([, key]) =>
    Object.keys(key.entries).every((member) => projected.has(member))
  );
  return kept.length === 0 ? undefined : (Object.fromEntries(kept) as Keys);
}

/**
 * Whether a `_count` selection counts a relation: one it names, or, as
 * `true`, any to-many relation of the source. A read gives a `_count` that
 * counts none no key, so a view has no column for it. A view source reads
 * only the relations it inherits, which the schema's resolution settles
 * (`settleCount`).
 */
function countsRelation(from: ModelState, count: unknown): boolean {
  return isRecord(count)
    ? askedKeys(count.select).length > 0
    : Object.values(from.relations).some(
        (relation) => relation["~"].state.cardinality === "many"
      );
}

/**
 * `scalar` as a column of an aggregated view: its type, list shape and
 * domain, under the view's field name and with none of what the source
 * declared for its own column (a `.map()`, a default, a key, a generator).
 */
const columnOf = (
  scalar: Scalar,
  nullable: boolean,
  isUnique = false
): Scalar =>
  derivedScalar(scalar, {
    nullable,
    hasDefault: nullable,
    default: nullable ? null : undefined,
    optional: nullable,
    columnName: undefined,
    isId: false,
    isUnique,
    autoGenerate: undefined,
    disallowZero: false,
  });

/** The aggregates a view may hold, in the order `groupBy` answers them. */
const AGGREGATES = ["_count", "_avg", "_sum", "_min", "_max"] as const;

/**
 * The column an aggregate of `field` is held in: `count` for a count of
 * rows, else the aggregate's name and the field's (`sumAmount`).
 */
const aggregateColumn = (aggregate: ViewAggregate, field: string): string =>
  field === "_all"
    ? aggregate.slice(1)
    : `${aggregate.slice(1)}${field.charAt(0).toUpperCase()}${field.slice(1)}`;

/**
 * The scalar an aggregate is held in, chosen so that a view row decodes what
 * `groupBy` answers: a count an int; `_min`, `_max` and an average of
 * decimals the field's type, nullable; another average a number; a sum of
 * bigints a bigint, of ints or doubles a number (an int sum passes the int
 * range where `groupBy` still answers), of decimals a decimal at the field's
 * scale, as wide as every provider that stores the field stores one at that
 * scale: 18 digits less the scale where SQLite stores the field (its
 * coefficient is an int64), 65 less the scale where MySQL does and SQLite
 * does not, PostgreSQL's 1000 beyond. A field SQLite stores at its limit
 * (precision and scale adding up to 18) has no room above its own range.
 */
function aggregateScalar(aggregate: ViewAggregate, field: Scalar): Scalar {
  if (aggregate === "_count") return int();
  const state = field["~"].state;
  if (aggregate === "_min" || aggregate === "_max")
    return columnOf(field, true);
  const { decimal: descriptor } = state;
  if (descriptor !== undefined) {
    if (aggregate === "_avg") return columnOf(field, true);
    const { precision, scale } = descriptor;
    // 18 and 65: what precision and scale add up to at most on SQLite and
    // on MySQL (`PROVIDER_LIMITS`, the decimal codec).
    const limit = [18, 65].find((sum) => precision + scale <= sum);
    return decimal({
      precision: limit ? limit - scale : 1000,
      scale,
    }).nullable();
  }
  return aggregate === "_sum" && state.type === "bigint"
    ? bigInt().nullable()
    : number().nullable();
}

/**
 * An aggregated view's state: a column per grouped field (a period's start
 * as the `YYYY-MM-DD` text `groupBy` answers), then one per aggregate in the
 * order `groupBy` answers them, and the `by` list as its key where no member
 * is nullable. A name that is not a scalar of the source is no column, as in
 * a view of rows: admitting the query, the migration refuses it with the
 * view named.
 */
function deriveAggregatedState(
  source: AnyModel,
  query: Readonly<Record<string, unknown>>
): ViewModelState {
  const from = source["~"].state;
  const members = [query.by].flat() as GroupByMember[];
  const grouped = members
    .map(groupedColumn)
    .filter(({ field }) => from.scalars[field] !== undefined);
  const by = grouped.map(({ field }) => field);
  const keyed = grouped.every(
    ({ field }) => !from.scalars[field]!["~"].state.nullable
  );
  const columns: string[] = [];
  const origins = emptyRecord<ViewColumnOrigin>();
  const scalars = emptyRecord<Scalar>();
  const add = (name: string, origin: ViewColumnOrigin, scalar: Scalar) => {
    columns.push(name);
    put(origins, name, origin);
    put(scalars, name, scalar);
  };
  for (const origin of grouped) {
    const field = from.scalars[origin.field]!;
    const { nullable } = field["~"].state;
    add(
      origin.field,
      origin,
      columnOf(
        origin.step === undefined ? field : string(),
        nullable,
        keyed && by.length === 1
      )
    );
  }
  for (const aggregate of AGGREGATES) {
    const selection = query[aggregate];
    for (const field of selection === true ? ["_all"] : askedKeys(selection)) {
      if (field === "_all") {
        if (aggregate === "_count")
          add(aggregateColumn(aggregate, field), { aggregate }, int());
        continue;
      }
      const scalar = from.scalars[field];
      if (scalar === undefined) continue;
      add(
        aggregateColumn(aggregate, field),
        { field, aggregate },
        aggregateScalar(aggregate, scalar)
      );
    }
  }
  const key = emptyRecord<VibSchema>();
  for (const field of by) put(key, field, scalars[field]!["~"].state.base);
  // Named as `.id([...])` names one of the same fields.
  const compoundId = (
    keyed && by.length > 1
      ? { [by.join("_")]: v.object(key, { partial: false }) }
      : undefined
  ) as ModelState["compoundId"];
  const uniques = emptyRecord<Scalar>();
  if (keyed && by.length === 1) put(uniques, by[0]!, scalars[by[0]!]!);
  return {
    shape: scalars,
    scalars,
    relations: emptyRecord(),
    uniques,
    compoundId,
    compoundUniques: undefined,
    tableName: undefined,
    indexes: [],
    omit: undefined,
    view: {
      source,
      query,
      columns,
      documents: [],
      aggregated: { by, origins, scalars, compoundId },
    },
  };
}

function deriveViewState(
  source: AnyModel,
  query: Readonly<Record<string, unknown>>
): ViewModelState {
  if (!(source instanceof Model)) {
    throw new Error("A view reads a model or a view");
  }
  if (query.by !== undefined) return deriveAggregatedState(source, query);
  const from = source["~"].state;
  const projectable = projectableScalarNames(source);
  const selected = isRecord(query.select) ? askedKeys(query.select) : undefined;
  const omitted = new Set(askedKeys(query.omit));
  // As a read does: `omit` takes from the selection, written or default.
  const columns = projectable.filter(
    (name) => (selected?.includes(name) ?? true) && !omitted.has(name)
  );
  // A selection names scalars and JSON columns alike; without one, a view
  // keeps its source's JSON columns and adds the relations it includes.
  const kept = viewFacts(source)?.documents ?? [];
  const counted = (
    isRecord(query.select) ? query.select : { ...(query.include as object) }
  )._count;
  const documents = (
    selected
      ? selected.filter((name) => !projectable.includes(name))
      : // A stored column the include names again is the one it keeps.
        [...new Set([...kept, ...askedKeys(query.include)])]
  ).filter(
    (name) =>
      !omitted.has(name) &&
      (name !== "_count" ||
        kept.includes(name) ||
        countsRelation(from, counted))
  );
  const projected = new Set(columns);
  const scalars = emptyRecord<Scalar>();
  const uniques = emptyRecord<Scalar>();
  for (const name of columns) {
    put(scalars, name, from.scalars[name]);
    if (name in from.uniques) put(uniques, name, from.uniques[name]);
  }
  // Each relation of the source whose name no column of the view takes. The
  // schema's resolution keeps those whose key columns the view holds; the
  // targets are not read here, where they may not exist yet.
  const relations = emptyRecord<AnyRelation>();
  for (const [name, relation] of Object.entries(
    from.relations as Record<string, AnyRelation>
  ))
    if (!(projected.has(name) || documents.includes(name)))
      put(relations, name, relation);
  return {
    shape: { ...scalars, ...relations },
    scalars,
    relations,
    uniques,
    compoundId: projectedCompoundKeys(from.compoundId, projected),
    compoundUniques: projectedCompoundKeys(from.compoundUniques, projected),
    tableName: undefined,
    indexes: [],
    omit: undefined,
    view: { source, query, columns, documents },
  };
}

/**
 * Declares a database view: the rows `findMany(query)` reads on `source`, as
 * a read-only model. VibORM's migrations create it and keep it current.
 *
 * ```ts
 * const publishedPost = s
 *   .view(() => post, {
 *     where: { published: true },
 *     select: { id: true, title: true, author: { select: { name: true } } },
 *   })
 *   .map("published_posts");
 * ```
 */
export function view<M extends AnyModel, const Q extends ViewQuery<M>>(
  source: () => M,
  // `const`: a selection's `true` stays `true`, which is what tells a selected
  // member from one that may be absent.
  query: Q
): Model<ViewState<M, Q>>;
/**
 * Declares an aggregated view: the groups `groupBy(query)` reads on
 * `source`, each a row of flat columns (a grouped field under its name, an
 * aggregate as `count`, `sumAmount`, …), keyed by the `by` list where no
 * member is nullable.
 *
 * ```ts
 * const salesByDay = s.view(() => order, {
 *   by: [{ createdAt: "day" }, "currency"],
 *   _sum: { amount: true },
 *   _count: true,
 * }); // createdAt, currency, sumAmount, count
 * ```
 */
export function view<
  M extends AnyModel,
  const Q extends AggregatedViewQuery<M>,
>(source: () => M, query: Q): Model<AggregatedViewState<M, Q>>;
export function view(
  source: () => AnyModel,
  query: unknown
): Model<ModelState> {
  return new Model(
    deferredState(() => deriveViewState(source(), { ...(query as object) }))
  );
}
