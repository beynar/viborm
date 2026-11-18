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

/** A state whose every member is read from `derive`'s answer, asked once. */
function deferredState(derive: () => ViewModelState): ViewModelState {
  let derived: ViewModelState | undefined;
  const state = {};
  for (const key of STATE_KEYS) {
    Object.defineProperty(state, key, {
      enumerable: true,
      get: () => (derived ??= derive())[key],
    });
  }
  return state as ViewModelState;
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

function deriveViewState(source: AnyModel, declared: object): ViewModelState {
  if (!(source instanceof Model)) {
    throw new Error(
      "A view reads a model or another view: s.view(() => model, query)"
    );
  }
  const query: Readonly<Record<string, unknown>> = { ...declared };
  const from = source["~"].state;
  const projectable = projectableScalarNames(source);
  const selected = isRecord(query.select) ? askedKeys(query.select) : undefined;
  const omitted = new Set(askedKeys(query.omit));
  const columns = projectable.filter((name) =>
    selected ? selected.includes(name) : !omitted.has(name)
  );
  // A selection names scalars and JSON columns alike; without one, a view
  // keeps its source's JSON columns and adds the relations it includes.
  const documents = selected
    ? selected.filter((name) => !projectable.includes(name))
    : [
        ...(viewFacts(source)?.documents ?? []).filter(
          (name) => !omitted.has(name)
        ),
        ...askedKeys(query.include),
      ];
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
export const view = <M extends AnyModel, Q extends ViewQuery<M>>(
  source: () => M,
  query: Q
): Model<ViewState<M, Q>> =>
  new Model(
    deferredState(() => deriveViewState(source(), query ?? {}))
  ) as unknown as Model<ViewState<M, Q>>;
