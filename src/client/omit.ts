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
 *  1. an explicit `select` on the node overrides the CLIENT default: nothing
 *     global is injected there, while a query-level `omit` still subtracts;
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
import type {
  ResolvedRelationIndex,
  ResolvedSlot,
  ResolvedVariantEdge,
} from "@schema/validation/relation-resolution";
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

/**
 * Resolves a model to the fields this client hides by default, and carries the
 * one resolved topology index the recursion walks.
 *
 * The index travels WITH the resolver because the two are used together at every
 * node and are settled together, once, at client construction: the resolver
 * answers "which columns", the index answers "which model is on the other side
 * of this key" — without ever invoking a target getter (§11.4.11).
 */
export interface ClientOmitResolver {
  /** The fields this client hides by default for one model. */
  readonly omit: (model: AnyModel) => Record<string, boolean> | undefined;
  readonly relations: ResolvedRelationIndex;
}

const hasEntries = (value: Record<string, boolean>): boolean =>
  Object.keys(value).length > 0;

/**
 * Build the model → default-omit lookup, or `undefined` when the client
 * configured nothing worth walking for. Keyed by model IDENTITY so a nested
 * relation resolves through its `ResolvedSlot` target without a name
 * round-trip.
 */
export const createClientOmitResolver = <S extends Record<string, AnyModel>>(
  schema: S,
  config: ClientOmitConfig<S> | undefined,
  relations: ResolvedRelationIndex
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
  return { omit: (model: AnyModel) => byModel.get(model), relations };
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
 * projection, so the client default is not injected. The node's own `omit`
 * remains for validation to subtract, and relation children are still visited.
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

  const defaults = hasSelect ? undefined : resolve.omit(model);
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
  const slots = resolve.relations.get(model);
  let changed = false;
  const next: Record<string, unknown> = { ...map };

  for (const key of Object.keys(map)) {
    const resolved = slots?.get(key);
    if (!resolved) continue;
    const value = map[key];

    // ONE index, split here by the settled EDGE: a direct variant carrier spans
    // several targets and projects a tagged envelope; every other slot — an
    // ordinary pair, or a bound inverse view of one carrier member — reaches
    // exactly one model.
    const carrier = directVariantCarrier(resolved);
    if (carrier) {
      const rewritten = rewriteVariantCarrier(carrier, value, resolve);
      if (rewritten !== value) {
        next[key] = rewritten;
        changed = true;
      }
      continue;
    }

    const target = slotTarget(resolved, model);
    if (!target) continue;

    if (value === true) {
      const defaults = resolve.omit(target);
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

/** The direct carrier edge of a variant slot — never a bound inverse's view. */
const directVariantCarrier = (
  resolved: ResolvedSlot
): ResolvedVariantEdge | undefined => {
  if (resolved.member) return undefined;
  const edge = resolved.edge;
  return edge.kind === "variantRowCarrier" ||
    edge.kind === "variantJunctionCarrier"
    ? edge
    : undefined;
};

/**
 * The SETTLED model on the other side of one slot.
 *
 * Every model here came out of the gate's own registration, so no getter is
 * invoked and no `targetEntries()` is walked: the edge already names both
 * endpoints, and a bound inverse names the carrier that holds the storage.
 */
const slotTarget = (
  resolved: ResolvedSlot,
  source: AnyModel
): AnyModel | undefined => {
  const edge = resolved.edge;
  if (edge.kind === "foreignKey" || edge.kind === "junction") {
    const [first, second] = edge.endpoints;
    return first.source === source && first.field === resolved.slot.field
      ? second.source
      : first.source;
  }
  return edge.carrier.source;
};

/**
 * WHERE a polymorphic arm lives depends on the slot's CARDINALITY, and getting
 * that wrong is not a missed default — it is a thrown query.
 *
 * A to-one slot's projection IS the discriminator map, so an arm is written at
 * the projection's top level. A collection's projection is an envelope whose
 * top level holds exactly two keys, `only` and `variants`; an arm written
 * beside them is an unknown key the strict envelope refuses. Since this rewrite
 * runs BEFORE validation, a top-level arm would make
 * `include: { items: true }` throw on any client that configures an `omit` for
 * a variant's target model — a client-option-shaped failure in a query that
 * never mentioned the option.
 */
const rewriteVariantCarrier = (
  edge: ResolvedVariantEdge,
  value: unknown,
  resolve: ClientOmitResolver
): unknown =>
  edge.kind === "variantJunctionCarrier"
    ? rewritePolymorphicCollection(edge, value, resolve)
    : rewritePolymorphicSlot(edge, value, resolve);

/**
 * The arm a client default produces for one target, or `undefined` when that
 * target is unconfigured (leave the caller's payload — and its cache key —
 * exactly as written).
 */
const defaultedArm = (
  target: AnyModel,
  variant: unknown,
  resolve: ClientOmitResolver
): unknown => {
  if (isPlainRecord(variant)) {
    const rewritten = rewriteNode(target, variant, resolve);
    return rewritten === variant ? undefined : rewritten;
  }
  if (variant !== true && variant !== undefined) return undefined;
  const defaults = resolve.omit(target);
  return defaults ? { omit: { ...defaults } } : undefined;
};

/**
 * A to-one polymorphic projection object overrides individual variants; absent
 * keys still project that target's default scalars. Visit every configured
 * target so client defaults apply to both explicit and defaulted variants.
 */
const rewritePolymorphicSlot = (
  edge: Extract<ResolvedVariantEdge, { kind: "variantRowCarrier" }>,
  value: unknown,
  resolve: ClientOmitResolver
): unknown => {
  if (value !== true && !isPlainRecord(value)) return value;

  const projection: Record<string, unknown> =
    value === true ? {} : { ...value };
  let changed = false;

  for (const member of edge.members) {
    const variant = value === true ? undefined : value[member.variant];
    const arm = defaultedArm(member.targetModel, variant, resolve);
    if (arm === undefined) continue;
    projection[member.variant] = arm;
    changed = true;
  }

  return changed ? projection : value;
};

/**
 * A collection projection: arms go UNDER `variants`, and an allow-list is
 * obeyed rather than worked around.
 *
 * Synthesizing an arm for a variant `only` excludes would fabricate the exact
 * "Variant 'x' is not in 'only'" refusal the envelope raises — a client option
 * producing a parse error about a key the caller never wrote.
 */
const rewritePolymorphicCollection = (
  edge: Extract<ResolvedVariantEdge, { kind: "variantJunctionCarrier" }>,
  value: unknown,
  resolve: ClientOmitResolver
): unknown => {
  if (value !== true && !isPlainRecord(value)) return value;

  const envelope = value === true ? undefined : value;
  const only = envelope?.only;
  const existing = envelope?.variants;
  // A malformed envelope is left ALONE: validation owns the message, and a
  // rewrite here would only add keys to a payload that is already failing.
  if (only !== undefined && !Array.isArray(only)) return value;
  if (existing !== undefined && !isPlainRecord(existing)) return value;
  const allowed = Array.isArray(only) ? new Set<unknown>(only) : undefined;

  const variants: Record<string, unknown> = { ...existing };
  let changed = false;

  for (const member of edge.members) {
    if (allowed && !allowed.has(member.variant)) continue;
    const arm = defaultedArm(
      member.topology.target.model,
      existing?.[member.variant],
      resolve
    );
    if (arm === undefined) continue;
    variants[member.variant] = arm;
    changed = true;
  }

  if (!changed) return value;
  return { ...envelope, variants };
};
