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
import type { RowsContribution } from "./controls";

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
 * One definition's `rows` with every predicate admitted: refusals are
 * `ClientInitializationError`s naming the extension, the model, the
 * predicate's mode and purpose, and the path inside it.
 */
export function admitRows(
  rows: RowsContribution,
  schema: Schema,
  extension: string,
  registry: SchemaRegistryLookup<Schema> = standaloneRegistry(schema)
): RowsContribution {
  const models: Record<string, Record<string, object>> = {};
  for (const [name, modes] of Object.entries(rows.models)) {
    const model = schema[name]!;
    const where = registry.getModelSchemas(model).core.where;
    const admitted: Record<string, object> = {};
    for (const [mode, purposes] of Object.entries(modes)) {
      const out: Record<string, unknown> = {};
      for (const purpose of ["root", "related"] as const) {
        const predicate = purposes[purpose];
        if (predicate === undefined) continue;
        const result = admittingDomainPredicate(MARKERS, () =>
          validateSchema(where, predicate)
        );
        if (result.issues) {
          const [issue] = result.issues;
          const at = issue!.path?.map(String).join(".") || "root";
          throw new ClientInitializationError(
            `Extension "${extension}" rows.${name}.${mode}.${purpose} at "${at}": ${issue!.message}.`,
            { meta: { extension, model: name } }
          );
        }
        out[purpose] = result.value;
      }
      admitted[mode] = Object.freeze(out);
    }
    models[name] = Object.freeze(admitted);
  }
  return Object.freeze({ ...rows, models: Object.freeze(models) });
}
