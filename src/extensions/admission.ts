import type { Schema } from "@client/types";
import { ClientInitializationError } from "@errors";
import {
  Condition,
  type ConditionTest,
  Existence,
  type ModelDomain,
  OuterColumn,
  Parameter,
  type RowDomain,
} from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
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
import type { ResolvedControls } from "./chain";
import type { RowsContribution } from "./controls";
import { verbsAdmission } from "./rows-slot";

/**
 * Each domain predicate admitted once, when its extension is applied, through
 * its model's `where` schema: a misspelt key fails here, never at the first
 * read, and the engine prepares what a caller's `where` would be (K1(a)).
 * This module admits a member's modes; its `verbs` and `confine` are
 * admitted by what reads them (`verbs.ts`), handed what admits a predicate.
 */

/** What admits one predicate of a member, for what admits its verbs. */
export interface PredicateAdmission {
  readonly schema: Schema;
  /**
   * `predicate`, one of model `name`'s, at `place` in `rows`, admitted
   * through the model's `where` schema; what it reads of its call is added
   * to `references` as its parameters are made.
   */
  readonly admit: (
    name: string,
    place: string,
    predicate: unknown,
    references: References
  ) => Input;
  readonly refuse: (
    name: string,
    place: string,
    at: string,
    reason: string
  ) => never;
}

/**
 * What predicates read of their call, as admission makes their parameters:
 * each control they name, and `undefined` for the call's instant.
 */
export type References = Set<string | undefined>;

/** What an admitted member's predicates read of their call ({@link References}). */
export interface AdmittedReferences {
  /** Per mode, its own predicates'. */
  readonly modes: { readonly [mode: string]: readonly (string | undefined)[] };
  /** Its `confine`'s and its eager `verbs` entries'; a lazy entry's are its own. */
  readonly verbs: readonly (string | undefined)[];
}

/** What a chain's verbs and confinements bind to, for every mode combination. */
export interface VerbsBound {
  readonly verbs?: RowDomain["verbs"];
  readonly confine?: ModelDomain;
  readonly judge?: RowDomain["judge"];
  readonly project?: RowDomain["project"];
  /** Whether one of their predicates may read a call value. */
  readonly reads: boolean;
}

/** Binds every member's verbs and confinements to a chain with `controls`. */
export type VerbsBinder = (
  members: readonly AdmittedRows[],
  controls: ResolvedControls | undefined
) => VerbsBound;

/**
 * A `rows` member as admission left it: its predicates admitted, the
 * controls they name, and, where it declares `verbs` or `confine`, what
 * binds them (left by what admitted them, so only a member declaring one
 * brings it).
 */
export interface AdmittedRows extends RowsContribution {
  readonly references?: AdmittedReferences;
  readonly bind?: VerbsBinder;
}

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

/**
 * Each declaration's admission, per schema registry: a registry is prepared
 * once per schema, so a client created per request over the same schema
 * applies the same declaration object without reading its predicates again.
 * A declaration changed after it was applied is not read again.
 */
const admittedRows = new WeakMap<
  SchemaRegistryLookup<Schema>,
  WeakMap<RowsContribution, AdmittedRows>
>();

/**
 * What admission returned. Applied again, a member is made of nodes, which
 * admit as themselves and make no parameter: what its admission recorded
 * stands.
 */
const outputs = new WeakSet<AdmittedRows>();

/** The keys admission adds to a member, read back where it is applied again. */
const ADMITTED_KEYS: ReadonlySet<string> = new Set(["references", "bind"]);

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

/** `{ $row, up }`: a column of an enclosing row (resolved where it is compared). */
export const isOuterColumn = (
  value: unknown
): value is { readonly $row: string; readonly up: number } =>
  isPlainRecord(value) &&
  Object.keys(value).length === 2 &&
  typeof value.$row === "string" &&
  Number.isSafeInteger(value.up) &&
  (value.up as number) >= 0;

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

/** The keys a definition's `rows` reads. */
const ROWS_KEYS: ReadonlySet<string> = new Set([
  "control",
  "default",
  "models",
  "verbs",
  "confine",
]);

/**
 * One definition's `rows` with every predicate admitted, each named predicate
 * once and a mode naming one given its admitted object: refusals are
 * `ClientInitializationError`s naming the extension, the model, the
 * predicate's place in `rows` and the path inside it. Admitted once per
 * schema registry and declaration object, where the schema's scalars admit
 * with the engine's own schemas.
 */
export function admitRows(
  rows: AdmittedRows,
  schema: Schema,
  extension: string,
  registry: SchemaRegistryLookup<Schema> = standaloneRegistry(schema)
): AdmittedRows {
  // A field's own schema may read its value differently on another call.
  const native = Object.values(schema).every((model) => {
    const state: ModelState = model["~"].state;
    return Object.values(state.scalars).every(
      (scalar) => scalar["~"].state.schema === undefined
    );
  });
  const known = native ? admittedRows.get(registry)?.get(rows) : undefined;
  if (known) return known;
  const prior = outputs.has(rows) ? rows.references : undefined;
  // A key `rows` does not read is refused, not dropped: `bound` (1.9, 1.10)
  // would otherwise lose its confinement silently.
  for (const key of Object.keys(rows))
    if (!(ROWS_KEYS.has(key) || (prior && ADMITTED_KEYS.has(key))))
      throw new ClientInitializationError(
        `Extension "${extension}" rows.${key} is not a rows key${key === "bound" ? ": it is named rows.confine since 1.11" : ""}.`,
        { meta: { extension } }
      );
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
  const acyclic = new WeakSet<object>();
  /**
   * Shared sub-predicates are walked and parsed once per set of predicates
   * whose references are told apart: a reused parse makes no parameter, so
   * it records nothing. A mode's, and the verbs and confinements' (a lazy
   * entry's included).
   */
  const filtersOf = new Map<string, AdmittedFilters>();
  const admit = (
    name: string,
    place: string,
    predicate: unknown,
    references: References,
    of = ""
  ): Input => {
    const cycle = cyclePath(predicate, acyclic);
    if (cycle !== undefined) refuse(name, place, cycle, "contains itself");
    const where = registry.getModelSchemas(schema[name]!).core.where;
    const markers: DomainMarkers = {
      value: (value) => {
        if (isReference(value)) {
          references.add(value.control);
          return new Parameter(value.control, value.path);
        }
        if (isOuterColumn(value)) return new OuterColumn(value.$row, value.up);
        if (!isInstant(value)) return undefined;
        references.add(undefined);
        return new Parameter();
      },
      condition: (spec) => {
        const node = conditionOf(spec);
        if (typeof node !== "string") references.add(node.parameter.control!);
        return node;
      },
      /**
       * `$exists`: one model of the schema and its `where`, admitted with
       * that model's own schema (its markers and depth rules included).
       */
      exists: (spec) => {
        const models = isPlainRecord(spec) ? Object.keys(spec) : [];
        const [model] = models;
        if (
          models.length !== 1 ||
          !Object.hasOwn(schema, model!) ||
          !isPlainRecord((spec as Record<string, unknown>)[model!])
        )
          return {
            message:
              "names exactly one model of the schema and the `where` its rows must match",
            path: [],
          };
        const result = validateSchema(
          registry.getModelSchemas(schema[model!]!).core.where,
          (spec as Record<string, unknown>)[model!]
        );
        if (result.issues) {
          const [issue] = result.issues;
          return {
            message: issue!.message,
            path: [model!, ...(issue!.path ?? [])],
          };
        }
        return new Existence(model!, result.value as Input);
      },
    };
    let filters = filtersOf.get(of);
    if (filters === undefined) filtersOf.set(of, (filters = new WeakMap()));
    const result = admittingDomainPredicate(
      markers,
      () => validateSchema(where, predicate),
      filters
    );
    if (!result.issues) return result.value as Input;
    const [issue] = result.issues;
    return refuse(
      name,
      place,
      issue!.path?.map(String).join(".") || "root",
      issue!.message
    );
  };
  const admission: PredicateAdmission = { schema, admit, refuse };
  // What reads `verbs` and `confine` is there where the extension that
  // declares one was built with it.
  const reader =
    rows.verbs === undefined && rows.confine === undefined
      ? undefined
      : verbsAdmission();
  const verbsControls: References = new Set(prior?.verbs);
  const verbs =
    rows.verbs && reader!.verbs(rows.verbs, admission, verbsControls);
  const models: Record<string, Record<string, object>> = {};
  const modes = new Map<string, References>();
  for (const [name, entries] of Object.entries(rows.models)) {
    const admitted = new Map<string, object>();
    for (const [mode, purposes] of Object.entries(entries)) {
      let references = modes.get(mode);
      if (references === undefined)
        modes.set(mode, (references = new Set(prior?.modes[mode])));
      const out: Record<string, unknown> = {};
      for (const purpose of ["root", "related"] as const) {
        const predicate = purposes[purpose];
        if (predicate === undefined) continue;
        const place = `${name}.${mode}.${purpose}`;
        const unknown = (): never =>
          refuse(name, place, "root", `names unknown predicate "${predicate}"`);
        if (typeof predicate !== "string")
          out[purpose] = admit(
            name,
            place,
            predicate,
            references,
            `mode ${mode}`
          );
        else if (verbs === undefined) unknown();
        else out[purpose] = reader!.named(verbs[name], predicate, unknown);
      }
      admitted.set(mode, Object.freeze(out));
    }
    models[name] = Object.freeze(Object.fromEntries(admitted));
  }
  const confine =
    rows.confine && reader!.confine(rows.confine, admission, verbsControls);
  const admitted: AdmittedRows = Object.freeze({
    ...rows,
    models: Object.freeze(models),
    ...(verbs && { verbs }),
    ...(confine && { confine }),
    references: Object.freeze({
      modes: Object.freeze(
        Object.fromEntries(
          [...modes].map(([mode, names]) => [mode, Object.freeze([...names])])
        )
      ),
      verbs: Object.freeze([...verbsControls]),
    }),
    ...(reader && { bind: reader.bind }),
  });
  outputs.add(admitted);
  if (native) {
    let cache = admittedRows.get(registry);
    if (!cache) {
      cache = new WeakMap();
      admittedRows.set(registry, cache);
    }
    cache.set(rows, admitted);
  }
  return admitted;
}
