import type { Schema } from "@client/types";
import { ClientInitializationError } from "@errors";
import {
  Condition,
  type ConditionTest,
  type LazyRelations,
  Parameter,
} from "@query-engine/raptor3/shared/row-scope";
import type { ModelState } from "@schema/model";
import { isPlainRecord } from "@schema/relation/terminal";
import { createSchemaRegistry } from "@validation/builder";
import { validateSchema } from "@validation/primitives/helpers";
import {
  type AdmittedFilters,
  admittingDomainPredicate,
  type DomainMarkers,
} from "@validation/primitives/parameter";
import type { SchemaRegistryLookup } from "@validation/types";
import type { RowsContribution, RowsVerbs } from "./controls";

/**
 * Each domain predicate admitted once, when its extension is applied, through
 * its model's `where` schema: a misspelt key fails here, never at the first
 * read, and the engine prepares what a caller's `where` would be (K1(a)).
 */

/**
 * The where schemas of a schema no client prepared (a definition read on its
 * own), built once; a client hands admission its own.
 */
const registries = new WeakMap<Schema, SchemaRegistryLookup<Schema>>();

function standaloneRegistry(schema: Schema): SchemaRegistryLookup<Schema> {
  let registry = registries.get(schema);
  if (registry === undefined) {
    registry = createSchemaRegistry(schema);
    registries.set(schema, registry);
  }
  return registry;
}

/** Successful admission can be reused only for immutable data and native schemas.
 * Registry identity carries the resolved relation topology; model entries also
 * guard schema maps edited between applications. No call/driver facts live here.
 */
const admittedRows = new WeakMap<
  SchemaRegistryLookup<Schema>,
  WeakMap<
    RowsContribution,
    {
      schema: Schema;
      entries: [string, Schema[string]][];
      admitted: RowsContribution;
    }
  >
>();
/** A lazy `verbs` entry's admission, per registry, for one that returned immutable data. */
const admittedLazily = new WeakMap<
  SchemaRegistryLookup<Schema>,
  WeakMap<
    () => RowsVerbs,
    {
      schema: Schema;
      entries: [string, Schema[string]][];
      admitted: RowsVerbs;
    }
  >
>();
const immutableData = new WeakSet<object>();
export function isImmutableRowData(
  value: unknown,
  open = new Set<object>()
): boolean {
  if (value === null || typeof value !== "object")
    return typeof value !== "function" && typeof value !== "symbol";
  if (immutableData.has(value)) return true;
  if (!Object.isFrozen(value) || open.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype ||
        !Array.from({ length: value.length }, (_, index) =>
          Object.hasOwn(value, index)
        ).every(Boolean)
      : prototype !== Object.prototype &&
        prototype !== null &&
        prototype !== Parameter.prototype &&
        prototype !== Condition.prototype
  )
    return false;
  open.add(value);
  const safe = Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === "string" &&
      descriptor &&
      "value" in descriptor &&
      isImmutableRowData(descriptor.value, open)
    );
  });
  open.delete(value);
  if (safe) immutableData.add(value);
  return safe;
}

/**
 * Immutable `rows` whose functions (lazy `verbs` entries, and the resolvers
 * admission puts in their place) are leaves known by identity: what one
 * returns is checked when it is called.
 */
const immutableRows = new WeakSet<object>();
function isImmutableRows(value: unknown, open = new Set<object>()): boolean {
  if (typeof value === "function") return true;
  if (value === null || typeof value !== "object")
    return typeof value !== "symbol";
  if (immutableRows.has(value) || immutableData.has(value)) return true;
  if (!Object.isFrozen(value) || open.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype ||
        !Array.from({ length: value.length }, (_, index) =>
          Object.hasOwn(value, index)
        ).every(Boolean)
      : prototype !== Object.prototype &&
        prototype !== null &&
        prototype !== Parameter.prototype &&
        prototype !== Condition.prototype
  )
    return false;
  open.add(value);
  const safe = Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === "string" &&
      descriptor &&
      "value" in descriptor &&
      isImmutableRows(descriptor.value, open)
    );
  });
  open.delete(value);
  if (safe) immutableRows.add(value);
  return safe;
}

/** An entry's data immutable, a lazy `acyclic` known by identity. */
function isImmutableVerbs(entry: RowsVerbs): boolean {
  return (
    Object.isFrozen(entry) &&
    Reflect.ownKeys(entry).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(entry, key);
      return (
        typeof key === "string" &&
        descriptor !== undefined &&
        "value" in descriptor &&
        ((key === "acyclic" && typeof descriptor.value === "function") ||
          isImmutableRowData(descriptor.value))
      );
    })
  );
}

/** Native admission of immutable input owns every newly produced container. */
function freezeAdmitted(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeAdmitted(child, seen);
  Object.freeze(value);
}

/** A model's `rows.verbs` entry, key by key. */
const VERBS_KEYS: Record<keyof RowsVerbs, true> = {
  predicates: true,
  read: true,
  update: true,
  delete: true,
  writes: true,
  place: true,
  moves: true,
  acyclic: true,
  evidence: true,
  reads: true,
};

/**
 * A declared projection key's spelling: `$` and an identifier. No model
 * member and no engine carrier is spelled so, so a key never hides either,
 * whatever the schema later adds.
 */
const PROJECTION_KEY = /^\$[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * A model's key, unique and foreign-key fields: what identity and every join
 * read, and what a unique constraint answers for on a write, so none of them
 * is ever read-gated.
 */
function keyFields(state: ModelState): ReadonlySet<string> {
  return new Set([
    ...Object.entries(state.scalars)
      .filter(([, scalar]) => scalar["~"].state.isId === true)
      .map(([field]) => field),
    // A write of a guessed value fails on the constraint exactly when some
    // row holds it: a gate on a unique field would be confirmed by it.
    ...Object.keys(state.uniques),
    ...[
      ...Object.values(state.compoundId ?? {}),
      ...Object.values(state.compoundUniques ?? {}),
    ].flatMap(({ entries }) => Object.keys(entries)),
    ...Object.values(state.relations).flatMap(
      (relation) => relation["~"].state.foreignKey?.fields ?? []
    ),
  ]);
}

/** A condition's tests, the filter vocabulary's own words (OD-12). */
const TESTS = ["exists", "equals", "in", "has", "hasSome"] as const;

/** `{ control, path? }`: a control's value, or a field of it. */
export function isReference(
  value: unknown
): value is { readonly control: string; readonly path?: string } {
  return (
    isPlainRecord(value) &&
    typeof value.control === "string" &&
    Object.keys(value).every((key) => key === "control" || key === "path") &&
    (value.path === undefined || typeof value.path === "string")
  );
}

/** `{ now: true }`: the call's one instant. */
export const isInstant = (value: unknown): boolean =>
  isPlainRecord(value) && value.now === true && Object.keys(value).length === 1;

const REFUSED_CONDITION = `a condition names one control and exactly one of ${TESTS.join(", ")}`;

/** `$if`'s `{ control, path?, <one test> }` as a condition, or the refusal. */
function conditionOf(spec: unknown): Condition | string {
  if (!isPlainRecord(spec)) return REFUSED_CONDITION;
  const { control, path, ...tests } = spec;
  const [test, ...others] = Object.keys(tests);
  const operand = tests[test!];
  if (
    typeof control !== "string" ||
    (path !== undefined && typeof path !== "string") ||
    !TESTS.includes(test as (typeof TESTS)[number]) ||
    others.length > 0 ||
    (test === "exists" && typeof operand !== "boolean") ||
    ((test === "in" || test === "hasSome") && !Array.isArray(operand))
  )
    return REFUSED_CONDITION;
  return new Condition(
    new Parameter(control, path),
    Object.freeze({ [test!]: operand }) as unknown as ConditionTest
  );
}

/** The nodes a predicate's markers stand for, as its `where` meets them. */
const MARKERS: DomainMarkers = {
  value: (value) => {
    if (isReference(value)) return new Parameter(value.control, value.path);
    return isInstant(value) ? new Parameter() : undefined;
  },
  condition: conditionOf,
};

/**
 * The path at which `value` contains itself, `undefined` where it does not.
 * Only an object inside its own descendants is refused: a predicate may share
 * sub-objects freely.
 */
function cyclePath(
  value: unknown,
  acyclic: WeakSet<object>,
  ancestors = new Set<object>(),
  path: string[] = []
): string | undefined {
  if (typeof value !== "object" || value === null || acyclic.has(value))
    return undefined;
  // The root has no ancestor: a path is never empty here.
  if (ancestors.has(value)) return path.join(".");
  ancestors.add(value);
  for (const [key, item] of Object.entries(value)) {
    path.push(key);
    const found = cyclePath(item, acyclic, ancestors, path);
    if (found !== undefined) return found;
    path.pop();
  }
  ancestors.delete(value);
  // Every descendant was walked: no cycle passes through this object.
  acyclic.add(value);
  return undefined;
}

/**
 * One definition's `rows` with every predicate admitted, each named predicate
 * once and a mode naming one given its admitted object: refusals are
 * `ClientInitializationError`s naming the extension, the model, the
 * predicate's place in `rows` and the path inside it.
 */
export function admitRows(
  rows: RowsContribution,
  schema: Schema,
  extension: string,
  registry: SchemaRegistryLookup<Schema> = standaloneRegistry(schema)
): RowsContribution {
  const native = Object.values(schema).every((model) => {
    const state: ModelState = model["~"].state;
    return Object.values(state.scalars).every(
      (scalar) => scalar["~"].state.schema === undefined
    );
  });
  const reusable = native && isImmutableRows(rows);
  const entries = reusable ? Object.entries(schema) : undefined;
  /** A cached admission still holds where the schema map is the one it read. */
  const holds = (previous: {
    schema: Schema;
    entries: [string, Schema[string]][];
  }) => {
    const current = Object.entries(schema);
    return (
      previous.schema === schema &&
      current.length === previous.entries.length &&
      current.every(
        ([name, model], index) =>
          name === previous.entries[index]![0] &&
          model === previous.entries[index]![1]
      )
    );
  };
  const previous = reusable ? admittedRows.get(registry)?.get(rows) : undefined;
  if (previous && holds(previous)) return previous.admitted;
  const refuse = (
    name: string,
    place: string,
    at: string,
    reason: string
  ): never => {
    throw new ClientInitializationError(
      `Extension "${extension}" rows.${place} at "${at}": ${reason}.`,
      { meta: { extension, model: name } }
    );
  };
  // Shared sub-predicates are walked and parsed once per admission, a lazy
  // entry's included.
  const acyclic = new WeakSet<object>();
  const filters: AdmittedFilters = new WeakMap();
  const admit = (
    name: string,
    place: string,
    predicate: unknown
  ): Record<string, unknown> => {
    const cycle = cyclePath(predicate, acyclic);
    if (cycle !== undefined) refuse(name, place, cycle, "contains itself");
    const where = registry.getModelSchemas(schema[name]!).core.where;
    const result = admittingDomainPredicate(
      MARKERS,
      () => validateSchema(where, predicate),
      filters
    );
    if (!result.issues) return result.value as Record<string, unknown>;
    const [issue] = result.issues;
    return refuse(
      name,
      place,
      issue!.path?.map(String).join(".") || "root",
      issue!.message
    );
  };
  /** The self relations of `name` holding its key: what `acyclic` may name. */
  const selfKeys = (name: string): readonly string[] => {
    const { state } = schema[name]!["~"];
    return Object.keys(state.relations).filter((relation) => {
      const held = state.relations[relation]!["~"];
      return (
        held.state.foreignKey !== undefined &&
        held.settleTarget() === schema[name]
      );
    });
  };
  const admitAcyclic = (
    name: string,
    place: string,
    relations: readonly string[]
  ): readonly string[] => {
    const allowed = selfKeys(name);
    for (const relation of relations)
      if (!allowed.includes(relation))
        refuse(
          name,
          place,
          `acyclic.${relation}`,
          "names no to-one relation of the model to itself holding its key"
        );
    return relations;
  };
  /** One model's `verbs` entry, every predicate admitted and every name checked. */
  const admitVerbs = (name: string, entry: RowsVerbs): RowsVerbs => {
    const place = `verbs.${name}`;
    if (!isPlainRecord(entry))
      refuse(name, place, "root", "is not an object or a function");
    // Policies may be data built at runtime: a misspelt `writes` would leave
    // its field judged at `update`, which widens the write.
    for (const key of Object.keys(entry))
      if (!Object.hasOwn(VERBS_KEYS, key))
        refuse(
          name,
          place,
          key,
          `is not one of ${Object.keys(VERBS_KEYS).join(", ")}`
        );
    const { state } = schema[name]!["~"];
    const predicates = Object.fromEntries(
      Object.entries(entry.predicates).map(([key, predicate]) => [
        key,
        admit(name, `${place}.predicates.${key}`, predicate),
      ])
    );
    const known = (at: string, predicate: string | undefined) => {
      if (predicate !== undefined && !Object.hasOwn(predicates, predicate))
        refuse(name, place, at, `names unknown predicate "${predicate}"`);
    };
    known("read", entry.read);
    known("update", entry.update);
    known("delete", entry.delete);
    known("place", entry.place);
    for (const key of ["writes", "moves"] as const)
      for (const [field, predicate] of Object.entries(entry[key] ?? {})) {
        if (
          !(
            Object.hasOwn(state.scalars, field) ||
            Object.hasOwn(state.relations, field)
          )
        )
          refuse(name, place, `${key}.${field}`, "names an unknown field");
        known(`${key}.${field}`, predicate);
      }
    let cycles: readonly string[] | LazyRelations | undefined;
    const declared = entry.acyclic;
    if (typeof declared === "function") {
      let resolved: readonly string[] | undefined;
      cycles = Object.freeze({
        candidates: Object.freeze(selfKeys(name)),
        resolve: () =>
          (resolved ??= Object.freeze([
            ...admitAcyclic(name, place, declared()),
          ])),
      });
    } else if (declared !== undefined)
      cycles = admitAcyclic(name, place, declared);
    const { evidence } = entry;
    if (evidence !== undefined) {
      if (!PROJECTION_KEY.test(evidence.as))
        refuse(name, place, "evidence.as", "is not `$` and an identifier");
      for (const [index, predicate] of evidence.names.entries())
        known(`evidence.names.${index}`, predicate);
    }
    const keys = entry.reads === undefined ? undefined : keyFields(state);
    for (const [field, predicate] of Object.entries(entry.reads ?? {})) {
      if (!Object.hasOwn(state.scalars, field))
        refuse(name, place, `reads.${field}`, "names no scalar of the model");
      // Masked in a caller's operands while identity and joins read it raw,
      // a key would answer through a relation what a filter hides.
      if (keys!.has(field))
        refuse(
          name,
          place,
          `reads.${field}`,
          "names a key, a unique or a foreign key field"
        );
      known(`reads.${field}`, predicate);
    }
    return Object.freeze({
      ...entry,
      predicates: Object.freeze(predicates),
      ...(cycles !== undefined && {
        acyclic: cycles as RowsVerbs["acyclic"],
      }),
    });
  };
  /**
   * A lazy entry, admitted the first time it is resolved: once per schema
   * registry when it returns immutable data, else once per admission.
   */
  const lazily = (name: string, entry: () => RowsVerbs): (() => RowsVerbs) => {
    let admitted: RowsVerbs | undefined;
    return () => {
      if (admitted !== undefined) return admitted;
      const cached = native
        ? admittedLazily.get(registry)?.get(entry)
        : undefined;
      if (cached && holds(cached)) return (admitted = cached.admitted);
      const declared = entry();
      const result = admitVerbs(name, declared);
      if (native && isPlainRecord(declared) && isImmutableVerbs(declared)) {
        freezeAdmitted(result);
        let cache = admittedLazily.get(registry);
        if (!cache) {
          cache = new WeakMap();
          admittedLazily.set(registry, cache);
        }
        cache.set(entry, {
          schema,
          entries: Object.entries(schema),
          admitted: result,
        });
      }
      admitted = result;
      return result;
    };
  };
  const verbs: Record<string, RowsVerbs | (() => RowsVerbs)> = {};
  for (const [name, entry] of Object.entries(rows.verbs ?? {})) {
    if (!Object.hasOwn(schema, name))
      refuse(name, `verbs.${name}`, "root", "names an unknown model");
    verbs[name] =
      typeof entry === "function"
        ? lazily(name, entry)
        : admitVerbs(name, entry);
  }
  const models: Record<string, Record<string, object>> = {};
  for (const [name, modes] of Object.entries(rows.models)) {
    const admitted = new Map<string, object>();
    const own = verbs[name];
    for (const [mode, purposes] of Object.entries(modes)) {
      const out: Record<string, unknown> = {};
      for (const purpose of ["root", "related"] as const) {
        const predicate = purposes[purpose];
        if (predicate === undefined) continue;
        const place = `${name}.${mode}.${purpose}`;
        if (typeof predicate !== "string")
          out[purpose] = admit(name, place, predicate);
        else if (typeof own === "function")
          // A lazy entry's predicate, named when its model is first needed.
          out[purpose] = () =>
            Object.hasOwn(own().predicates, predicate)
              ? own().predicates[predicate]
              : refuse(
                  name,
                  place,
                  "root",
                  `names unknown predicate "${predicate}"`
                );
        else if (Object.hasOwn(own?.predicates ?? {}, predicate))
          out[purpose] = own!.predicates[predicate];
        else
          refuse(name, place, "root", `names unknown predicate "${predicate}"`);
      }
      admitted.set(mode, Object.freeze(out));
    }
    models[name] = Object.freeze(Object.fromEntries(admitted));
  }
  const admitted = Object.freeze({
    ...rows,
    models: Object.freeze(models),
    ...(rows.verbs && { verbs: Object.freeze(verbs) }),
  }) as RowsContribution;
  if (entries) freezeAdmitted(admitted);
  if (entries && isImmutableRows(admitted)) {
    let cache = admittedRows.get(registry);
    if (!cache) {
      cache = new WeakMap();
      admittedRows.set(registry, cache);
    }
    cache.set(rows, { schema, entries, admitted });
  }
  return admitted;
}
