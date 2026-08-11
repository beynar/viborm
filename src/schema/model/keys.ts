/**
 * The ordered model-key catalog — the one owner of how a row can be addressed.
 *
 * A model's key facts have exactly three shapes, and this module stores each
 * once, grouped and ordered, in TS-field-name space:
 *
 * - `rowKey` — the complete primary key in constraint order (the array given to
 *   `.id([...])`, or the one `.id()` scalar). Optional: a model may declare no
 *   primary key.
 * - `addressableKeys` — the exact keys a public unique selector can name. A key
 *   with a `name` is a grouped constraint whose selector is that name and whose
 *   value is an object of members (`where: { region_slug: { region, slug } }`);
 *   a key without one is a bare scalar selector (`where: { email }`). That
 *   spelling difference is a real addressing fact — `.id(["a"])` and a scalar
 *   `.id()` on `a` accept different selectors — so it is stored, not inferred.
 * - `uniqueOverlapFields` — the conservative flattened view, used only to ask
 *   whether two selectors MAY overlap. Never a substitute for a grouped key.
 *
 * What this catalog deliberately does NOT claim: exact reference legality. A
 * foreign key may target a unique INDEX no selector can address, and whether a
 * given target is portable is a schema/provider-validation fact
 * (`getForeignKeyTargetFields` and its one fold-decision consumer own that
 * wider, over-approximating view). The catalog says how a row is ADDRESSED.
 *
 * A second deliberate survivor: the validation whereUnique factories
 * (`validation/model/core/filter.ts` / `where.ts`) keep reading the constraint
 * slots directly, because they need the member `VibSchema` VALUES to build the
 * parser and its inferred type — something a field-name catalog structurally
 * cannot supply. That is the preserved type/runtime-projection distinction,
 * not a missed migration.
 *
 * The catalog's arrays are cached for the model's lifetime and handed out
 * uncopied; every consumer treats them as the `readonly` types say. A consumer
 * that needs to mutate must copy first, as `getPrimaryKeyFields` does.
 *
 * Field-name space only: hydration binds column names after model construction,
 * so caching resolved columns here would freeze pre-hydration names. Every
 * column resolution is a downstream projection through `getColumnName`.
 */

import type { Model } from "./model";

export interface OrderedModelKey {
  // No "uniqueIndex" kind, deliberately departing from the plan's §4.1 sketch:
  // an index is never addressable, and an inhabited kind for it would invite
  // someone to push index-derived keys into `addressableKeys`, silently making
  // `where: { <indexed column> }` a unique discriminator.
  readonly kind: "primary" | "unique" | "compoundUnique";
  /**
   * The grouped-constraint selector name. Present exactly when the public
   * selector is the constraint name wrapping an object of members; absent for
   * a bare single-scalar selector.
   */
  readonly name?: string;
  /** Ordered members. Compound keys stay grouped; never flatten them. */
  readonly fields: readonly string[];
}

export interface ModelKeyCatalog {
  readonly rowKey?: OrderedModelKey;
  readonly addressableKeys: readonly OrderedModelKey[];
  readonly uniqueOverlapFields: readonly string[];
}

/**
 * One catalog per model instance. Models are immutable after construction
 * except name hydration, which binds COLUMN names only — key membership and
 * order never change, and the catalog stores no columns.
 */
const catalogCache = new WeakMap<object, ModelKeyCatalog>();

export function getModelKeyCatalog(model: Model<any>): ModelKeyCatalog {
  const cached = catalogCache.get(model);
  if (cached) {
    return cached;
  }
  const catalog = buildModelKeyCatalog(model);
  catalogCache.set(model, catalog);
  return catalog;
}

/**
 * Resolve one public unique-selector key to its addressable key.
 *
 * Precedence mirrors the selector grammar exactly: a bare scalar selector wins
 * over a grouped constraint of the same name, and the compound primary key
 * wins over a compound unique of the same name — the order `addressableKeys`
 * is built in, so the first match is the answer.
 */
export function findAddressableKey(
  model: Model<any>,
  selectorKey: string
): OrderedModelKey | undefined {
  for (const key of getModelKeyCatalog(model).addressableKeys) {
    const selector = key.name ?? key.fields[0];
    if (selector === selectorKey) {
      return key;
    }
  }
  return undefined;
}

function buildModelKeyCatalog(model: Model<any>): ModelKeyCatalog {
  const state = model["~"].state;
  const addressableKeys: OrderedModelKey[] = [];

  // Bare scalar selectors, in shape-declaration order. `state.uniques` carries
  // `.id()` scalars beside `.unique()` ones (`extractUniqueScalarMap` keys on
  // `isUnique || isId`), so the scalar primary key is addressable here too.
  let scalarRowKey: OrderedModelKey | undefined;
  for (const field of Object.keys(state.uniques)) {
    const isId = state.scalars[field]?.["~"].state.isId === true;
    const key: OrderedModelKey = isId
      ? { kind: "primary", fields: [field] }
      : { kind: "unique", fields: [field] };
    if (isId && !scalarRowKey) {
      scalarRowKey = key;
    }
    addressableKeys.push(key);
  }

  // EVERY declared compound-id constraint is addressable by its name — the
  // selector grammar has always resolved any of them (a second `.id([...])` is
  // representable; F002 refuses it at PUSH time only, never at `createClient`),
  // and empty ones stay addressable so their established "must include at least
  // one field" refusal keeps firing. The ROW key below is narrower: first
  // non-empty constraint only.
  const compoundIds: Record<string, { entries: Record<string, unknown> }> =
    state.compoundId ?? {};
  let compoundRowKey: OrderedModelKey | undefined;
  let firstCompoundId = true;
  for (const [name, constraint] of Object.entries(compoundIds)) {
    const key: OrderedModelKey = {
      kind: "primary",
      name,
      fields: Object.keys(constraint.entries),
    };
    // The row key is the FIRST declared constraint only, and only when it has a
    // name and members — a later non-empty constraint does not promote, exactly
    // as `getCompoundIdConstraint` has always read the record.
    if (firstCompoundId) {
      firstCompoundId = false;
      if (name && key.fields.length > 0) {
        compoundRowKey = key;
      }
    }
    addressableKeys.push(key);
  }

  // Named compound uniques, in declaration order.
  const compoundUniques: Record<string, { entries: Record<string, unknown> }> =
    state.compoundUniques ?? {};
  for (const [name, constraint] of Object.entries(compoundUniques)) {
    addressableKeys.push({
      kind: "compoundUnique",
      name,
      fields: Object.keys(constraint.entries),
    });
  }

  // The conservative flattened overlap view, in its established construction
  // order: scalar unique/id fields, then every compound-id member, then every
  // compound-unique member.
  const overlap = new Set<string>(Object.keys(state.uniques));
  for (const constraint of Object.values(compoundIds)) {
    for (const field of Object.keys(constraint.entries)) {
      overlap.add(field);
    }
  }
  for (const constraint of Object.values(compoundUniques)) {
    for (const field of Object.keys(constraint.entries)) {
      overlap.add(field);
    }
  }

  return {
    // The row key prefers the compound constraint: `getPrimaryKeyFields` has
    // always answered compound-first, and the projection contract pins that
    // reading (`target-projection.core.test.ts`, "schema order is the KEY's
    // order"). A model spelling both is refused by F002 at PUSH time only —
    // `createClient` never runs that rule — so the cursor deliberately keeps
    // its own scalar-first projection (`getCursorIdentityFields`).
    rowKey: compoundRowKey ?? scalarRowKey,
    addressableKeys,
    uniqueOverlapFields: [...overlap],
  };
}
