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
 * The source is a thunk (schema rule 3), so the state is derived on first
 * read, when every model exists. A modifier chained on the view reads it at
 * once.
 */

import type { ObjectSchema, VibSchema } from "@validation";
import type { ModelOperationInput } from "@validation/model";
import {
  type ProjectableScalarKeys,
  projectableScalarNames,
} from "@validation/model/core/projection";
import { isRecord } from "@validation/value-guards";
import { type AnyModel, Model, type ModelState } from "../model";
import { emptyRecord, put } from "../record";
import type { Scalar } from "../scalars/base";
import { type ViewFacts, viewFacts } from "./facts";

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
  : Omit<NonNullable<ModelOperationInput<M, "findMany">>, "cursor">;

/** The keys of a selection its value does not switch off. */
type AskedKeys<Selection> = {
  [K in keyof Selection]: Selection[K] extends false | undefined ? never : K;
}[keyof Selection];

/** The source scalars a query projects: the selected ones, or all but the omitted. */
type ViewScalarKeys<M extends AnyModel, Q> = Q extends {
  select: infer Selection extends object;
}
  ? Extract<AskedKeys<Selection>, ProjectableScalarKeys<M>>
  : Exclude<
      ProjectableScalarKeys<M>,
      Q extends { omit: infer Omitted extends object }
        ? AskedKeys<Omitted>
        : never
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

/** What the client types read of a view's declaration. */
export interface ViewDeclaration<M extends AnyModel, Q> {
  readonly source: M;
  readonly query: Q;
}

export interface ViewState<M extends AnyModel, Q> extends ModelState {
  shape: Pick<M["~"]["state"]["scalars"], ViewScalarKeys<M, Q>>;
  scalars: Pick<M["~"]["state"]["scalars"], ViewScalarKeys<M, Q>>;
  // biome-ignore lint/complexity/noBannedTypes: a view declares no relation
  relations: {};
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
 * counts none no key, so a view has no column for it.
 */
function countsRelation(from: ModelState, count: unknown): boolean {
  return isRecord(count)
    ? askedKeys(count.select).length > 0
    : Object.values(from.relations).some(
        (relation) => relation["~"].state.cardinality === "many"
      );
}

function deriveViewState(
  source: AnyModel,
  query: Readonly<Record<string, unknown>>
): ViewModelState {
  if (!(source instanceof Model)) {
    throw new Error("A view reads a model or a view");
  }
  const from = source["~"].state;
  const projectable = projectableScalarNames(source);
  const selected = isRecord(query.select) ? askedKeys(query.select) : undefined;
  const omitted = new Set(askedKeys(query.omit));
  const columns = projectable.filter((name) =>
    selected ? selected.includes(name) : !omitted.has(name)
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
      : [
          ...kept.filter((name) => !omitted.has(name)),
          ...askedKeys(query.include),
        ]
  ).filter(
    (name) =>
      name !== "_count" || kept.includes(name) || countsRelation(from, counted)
  );
  const projected = new Set(columns);
  const scalars = emptyRecord<Scalar>();
  const uniques = emptyRecord<Scalar>();
  for (const name of columns) {
    put(scalars, name, from.scalars[name]);
    if (name in from.uniques) put(uniques, name, from.uniques[name]);
  }
  return {
    shape: scalars,
    scalars,
    relations: emptyRecord(),
    uniques,
    compoundId: projectedCompoundKeys(from.compoundId, projected),
    compoundUniques: projectedCompoundKeys(from.compoundUniques, projected),
    tableName: undefined,
    indexes: [],
    omit: undefined,
    view: { source, query, documents },
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
export const view = <M extends AnyModel, const Q extends ViewQuery<M>>(
  source: () => M,
  // `const`: a selection's `true` stays `true`, which is what tells a selected
  // member from one that may be absent.
  query: Q
): Model<ViewState<M, Q>> =>
  new Model(
    deferredState(() => deriveViewState(source(), { ...(query as object) }))
  ) as unknown as Model<ViewState<M, Q>>;
