import type { Schema } from "@client/types";
import { ClientInitializationError } from "@errors";
import {
  Condition,
  type ConditionTest,
  Parameter,
} from "@query-engine/raptor3/shared/row-scope";
import { isPlainRecord } from "@schema/relation/terminal";
import { createSchemaRegistry } from "@validation/builder";
import { validateSchema } from "@validation/primitives/helpers";
import {
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
  ancestors = new Set<object>(),
  path: string[] = []
): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  // The root has no ancestor: a path is never empty here.
  if (ancestors.has(value)) return path.join(".");
  ancestors.add(value);
  for (const [key, item] of Object.entries(value)) {
    path.push(key);
    const found = cyclePath(item, ancestors, path);
    if (found !== undefined) return found;
    path.pop();
  }
  ancestors.delete(value);
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
  const admit = (
    name: string,
    place: string,
    predicate: unknown
  ): Record<string, unknown> => {
    const cycle = cyclePath(predicate);
    if (cycle !== undefined) refuse(name, place, cycle, "contains itself");
    const where = registry.getModelSchemas(schema[name]!).core.where;
    const result = admittingDomainPredicate(MARKERS, () =>
      validateSchema(where, predicate)
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
  const verbs: Record<string, RowsVerbs> = {};
  for (const [name, entry] of Object.entries(rows.verbs ?? {})) {
    const place = `verbs.${name}`;
    if (!Object.hasOwn(schema, name))
      refuse(name, place, "root", "names an unknown model");
    const { state } = schema[name]!["~"];
    const predicates: Record<string, Record<string, unknown>> = {};
    for (const [key, predicate] of Object.entries(entry.predicates))
      predicates[key] = admit(name, `${place}.predicates.${key}`, predicate);
    const known = (at: string, predicate: string | undefined) => {
      if (predicate !== undefined && !Object.hasOwn(predicates, predicate))
        refuse(name, place, at, `names unknown predicate "${predicate}"`);
    };
    known("read", entry.read);
    known("update", entry.update);
    known("delete", entry.delete);
    for (const [field, predicate] of Object.entries(entry.writes ?? {})) {
      if (
        !(
          Object.hasOwn(state.scalars, field) ||
          Object.hasOwn(state.relations, field)
        )
      )
        refuse(name, place, `writes.${field}`, "names an unknown field");
      known(`writes.${field}`, predicate);
    }
    verbs[name] = Object.freeze({
      ...entry,
      predicates: Object.freeze(predicates),
    });
  }
  const models: Record<string, Record<string, object>> = {};
  for (const [name, modes] of Object.entries(rows.models)) {
    const admitted: Record<string, object> = {};
    for (const [mode, purposes] of Object.entries(modes)) {
      const out: Record<string, unknown> = {};
      for (const purpose of ["root", "related"] as const) {
        const predicate = purposes[purpose];
        if (predicate === undefined) continue;
        const place = `${name}.${mode}.${purpose}`;
        if (typeof predicate !== "string")
          out[purpose] = admit(name, place, predicate);
        else if (Object.hasOwn(verbs[name]?.predicates ?? {}, predicate))
          out[purpose] = verbs[name]!.predicates[predicate];
        else
          refuse(name, place, "root", `names unknown predicate "${predicate}"`);
      }
      admitted[mode] = Object.freeze(out);
    }
    models[name] = Object.freeze(admitted);
  }
  return Object.freeze({
    ...rows,
    models: Object.freeze(models),
    ...(rows.verbs && { verbs: Object.freeze(verbs) }),
  });
}
