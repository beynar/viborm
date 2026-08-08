/**
 * CLIENT-LEVEL `omit` — `createClient({ omit: { user: { passwordHash: true } } })`.
 *
 * A per-client DEFAULT, not a schema rule. It is applied by rewriting the
 * payload before validation: every node that will produce a row of a configured
 * model gains the configured `omit`, unless the caller already spoke about that
 * node's projection. From there it is an ordinary query-level `omit` and travels
 * the one path that exists (`withOmitProjection` desugars it into `select`).
 *
 * Why rewrite the ARGS instead of teaching the engine a second default? Because
 * the schemas are shared: two clients over the same models must accept exactly
 * the same payloads, and a per-client default that changed what VALIDATES would
 * break that. Rewriting args keeps the client option where it belongs — a
 * default for what a query did not say — and leaves one implementation of the
 * projection itself.
 *
 * PRECEDENCE, in the order the rules fire:
 *  1. an explicit `select` on the node wins outright: the caller named the
 *     projection positively, so nothing is injected there (Prisma's rule too);
 *  2. the node's own `omit` wins per FIELD: `{ passwordHash: false }` re-includes
 *     a globally omitted column, `{ other: true }` adds to the default;
 *  3. otherwise the client default applies as written.
 *
 * Model-level `.omit()` is above all three and is not represented here at all —
 * those fields have no `omit` key to name (see
 * `src/validation/model/core/projection.ts`).
 *
 * COST. `undefined` config means the whole module is skipped: `resolve` is never
 * built and `applyClientOmit` is never called, so a client that configures
 * nothing pays nothing. With config, one shallow walk of the `select`/`include`
 * tree per query, copying only the nodes it changes.
 */

import { VibORMError, VibORMErrorCode } from "@errors";
import type { AnyModel } from "@schema/model";
import type { AnyPolymorphicRelation } from "@schema/relation";
import { projectableScalarNames } from "@validation/model/core/projection";
import { isRecord as isPlainRecord } from "@validation/value-guards";
import type { Operations } from "./types";

/** Fields a client hides by default, per model key of the schema. */
export type ClientOmitConfig<S extends Record<string, AnyModel>> = {
  [K in keyof S]?: ClientModelOmit<S[K]>;
};

/**
 * The scalars of `M` a client may hide — every scalar except the ones the
 * MODEL already hides for good (naming one of those has no `omit` key to name;
 * see `@validation/model/core/projection`).
 *
 * The `any` arm is not decoration. `VibORMConfig` is not generic in the
 * schema, so the type this is instantiated with is `Model<any>`, whose
 * `scalars` is `any` — and the subtraction above would then cancel to `never`,
 * leaving `Partial<Record<never, true>>`, a config object with NO known
 * properties. That shape type-checks anything, which is survivable, but it
 * also provides no contextual type for the flags, so the `true` a caller
 * writes widens to `boolean` and the result type can no longer tell "hidden"
 * from "maybe hidden". Answering `string` keeps the flag literal.
 */
type ProjectableKeysOf<M extends AnyModel> = 0 extends 1 &
  M["~"]["state"]["scalars"]
  ? string
  : Extract<
      Exclude<
        keyof M["~"]["state"]["scalars"],
        M["~"]["state"]["omit"] extends Record<string, true>
          ? keyof M["~"]["state"]["omit"]
          : never
      >,
      string
    >;

/**
 * The fields one model hides by default, each flagged `true`.
 *
 * `true` only — not `boolean`. Two reasons, and they are the same reason:
 *  - a `false` here would be a key that does nothing (the resolver only ever
 *    acts on `=== true`), and a config key that silently does nothing is the
 *    shape this codebase refuses; per-field re-inclusion belongs on the QUERY
 *    (`omit: { passwordHash: false }`), which is where it can be undone;
 *  - `boolean` as the contextual type widens the `true` a caller writes, and a
 *    widened flag is a flag the RESULT TYPE cannot resolve — it would render
 *    `passwordHash?: string` on a client that hides the column outright.
 */
export type ClientModelOmit<M extends AnyModel> = Partial<
  Record<ProjectableKeysOf<M>, true>
>;

/** Resolves a model to the fields this client hides by default. */
export type ClientOmitResolver = (
  model: AnyModel
) => Record<string, boolean> | undefined;

const hasEntries = (value: Record<string, boolean>): boolean =>
  Object.keys(value).length > 0;

/**
 * Build the model → default-omit lookup, or `undefined` when the client
 * configured nothing worth walking for. Keyed by model IDENTITY so a nested
 * relation resolves through `relation.getter()` without a name round-trip.
 */
export const createClientOmitResolver = <S extends Record<string, AnyModel>>(
  schema: S,
  config: ClientOmitConfig<S> | undefined
): ClientOmitResolver | undefined => {
  if (!config) return undefined;
  const byModel = new Map<AnyModel, Record<string, boolean>>();
  for (const key of Object.keys(config)) {
    const model = schema[key];
    const entry = config[key as keyof ClientOmitConfig<S>];
    // A config naming a model or a field that does not exist is a typo the
    // client would otherwise carry silently — the resolver simply never fires
    // for a name nothing matches. `VibORMConfig` cannot express the per-model
    // field union (it is not generic in the schema), so the check lives here,
    // at construction, where it is still cheaper than a wrong query.
    if (!model) {
      throw new VibORMError(
        `Client 'omit' names model '${key}', which is not in the schema.`,
        VibORMErrorCode.INVALID_INPUT,
        { meta: { model: key } }
      );
    }
    if (!isPlainRecord(entry)) continue;
    const projectable = new Set(projectableScalarNames(model));
    const flags: Record<string, boolean> = {};
    for (const field of Object.keys(entry)) {
      if (!projectable.has(field)) {
        throw new VibORMError(
          `Client 'omit' names field '${field}' on model '${key}', which is not a readable scalar of that model.`,
          VibORMErrorCode.INVALID_INPUT,
          { meta: { model: key, field } }
        );
      }
      if (entry[field] === true) flags[field] = true;
    }
    if (hasEntries(flags)) byModel.set(model, flags);
  }
  if (byModel.size === 0) return undefined;
  return (model: AnyModel) => byModel.get(model);
};

/**
 * The operations whose top-level payload is a model row (or rows). A bulk write
 * is NOT here: it answers `{ count }` unless the CALLER asked for a projection,
 * and a client default must never be what flips a return shape. Its nested
 * nodes are covered anyway — a bulk write projects scalars only.
 */
const PROJECTING_OPERATIONS: ReadonlySet<string> = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "create",
  "update",
  "upsert",
  "delete",
]);

/** A bulk write already carrying a projection: the caller opted into rows. */
const bulkWriteProjects = (
  operation: string,
  args: Record<string, unknown>
): boolean =>
  (operation === "createMany" ||
    operation === "updateMany" ||
    operation === "deleteMany") &&
  args.omit !== undefined;

/**
 * Rewrite one payload so every projecting node carries the client defaults.
 * Returns the SAME object when nothing changed, so an unaffected query is not
 * copied.
 */
export const applyClientOmit = (
  model: AnyModel,
  operation: Operations | string,
  args: Record<string, unknown>,
  resolve: ClientOmitResolver
): Record<string, unknown> => {
  const projects =
    PROJECTING_OPERATIONS.has(operation) || bulkWriteProjects(operation, args);
  if (!projects) return args;
  return rewriteNode(model, args, resolve);
};

/**
 * One node of the projection tree. `select` present means the caller stated the
 * projection: the node's own `omit` is left alone (the pair is refused
 * downstream anyway) and only its relation children are visited.
 */
const rewriteNode = (
  model: AnyModel,
  node: Record<string, unknown>,
  resolve: ClientOmitResolver
): Record<string, unknown> => {
  const selectValue = node.select;
  const includeValue = node.include;
  const hasSelect = isPlainRecord(selectValue);

  const nextSelect = hasSelect
    ? rewriteRelationMap(model, selectValue, resolve)
    : selectValue;
  const nextInclude = isPlainRecord(includeValue)
    ? rewriteRelationMap(model, includeValue, resolve)
    : includeValue;

  const defaults = hasSelect ? undefined : resolve(model);
  const nextOmit = defaults ? mergeOmit(defaults, node.omit) : node.omit;

  if (
    nextSelect === selectValue &&
    nextInclude === includeValue &&
    nextOmit === node.omit
  ) {
    return node;
  }

  const next: Record<string, unknown> = { ...node };
  if (nextSelect !== selectValue) next.select = nextSelect;
  if (nextInclude !== includeValue) next.include = nextInclude;
  if (nextOmit !== node.omit) next.omit = nextOmit;
  return next;
};

/**
 * The client defaults with the caller's own `omit` layered on top, per field —
 * so `{ passwordHash: false }` re-includes exactly one globally hidden column
 * and leaves the rest hidden. Returns the caller's value untouched when it
 * already overrides every default (nothing to add).
 */
const mergeOmit = (
  defaults: Record<string, boolean>,
  local: unknown
): Record<string, unknown> => {
  if (!isPlainRecord(local)) return { ...defaults };
  const merged: Record<string, unknown> = { ...defaults };
  for (const field of Object.keys(local)) merged[field] = local[field];
  return merged;
};

/**
 * Visit the relation entries of a `select`/`include` map. A bare `true` is
 * promoted to `{ omit: … }` only when the target model has defaults — otherwise
 * the shorthand is left exactly as written, which keeps the payload (and its
 * cache key) identical for the models nobody configured.
 */
const rewriteRelationMap = (
  model: AnyModel,
  map: Record<string, unknown>,
  resolve: ClientOmitResolver
): Record<string, unknown> => {
  const relations = model["~"].state.relations;
  const polymorphicRelations = model["~"].state.polymorphicRelations;
  let changed = false;
  const next: Record<string, unknown> = { ...map };

  for (const key of Object.keys(map)) {
    const relation = Object.hasOwn(relations, key) ? relations[key] : undefined;
    const value = map[key];

    const polymorphicRelation = Object.hasOwn(polymorphicRelations, key)
      ? polymorphicRelations[key]
      : undefined;
    if (polymorphicRelation) {
      const rewritten = rewritePolymorphicRelation(
        polymorphicRelation,
        value,
        resolve
      );
      if (rewritten !== value) {
        next[key] = rewritten;
        changed = true;
      }
      continue;
    }

    if (!relation) continue;
    const target = relation["~"].state.getter() as AnyModel;

    if (value === true) {
      const defaults = resolve(target);
      if (!defaults) continue;
      next[key] = { omit: { ...defaults } };
      changed = true;
      continue;
    }
    if (!isPlainRecord(value)) continue;

    const rewritten = rewriteNode(target, value, resolve);
    if (rewritten !== value) {
      next[key] = rewritten;
      changed = true;
    }
  }

  return changed ? next : map;
};

/**
 * A polymorphic projection object overrides individual variants; absent keys
 * still project that target's default scalars. Visit every configured target so
 * client defaults apply to both explicit and defaulted variants.
 */
const rewritePolymorphicRelation = (
  relation: AnyPolymorphicRelation,
  value: unknown,
  resolve: ClientOmitResolver
): unknown => {
  if (value !== true && !isPlainRecord(value)) return value;

  const projection: Record<string, unknown> =
    value === true ? {} : { ...value };
  let changed = false;

  for (const { publicType, targetModel } of relation["~"].targetEntries()) {
    // Client construction runs the mandatory polymorphic definition gate before
    // any query rewrite, so the cached hostile-boundary value is now a model.
    const target = targetModel as AnyModel;
    const variant = value === true ? undefined : value[publicType];

    if (variant === true) {
      const defaults = resolve(target);
      if (!defaults) continue;
      projection[publicType] = { omit: { ...defaults } };
      changed = true;
      continue;
    }

    if (isPlainRecord(variant)) {
      const rewritten = rewriteNode(target, variant, resolve);
      if (rewritten !== variant) {
        projection[publicType] = rewritten;
        changed = true;
      }
      continue;
    }

    if (variant === undefined) {
      const defaults = resolve(target);
      if (!defaults) continue;
      projection[publicType] = { omit: { ...defaults } };
      changed = true;
    }
  }

  return changed ? projection : value;
};
