import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  Accepted,
  AnyTarget,
  ArgSource,
  ArgsFacts,
  BoundAccepted,
  Part,
} from "./contract";
import type { ControlDeclaration } from "./controls";
import { controlsPart } from "./controls";
import { type ArgSpec, builtPart, type DefinitionDraft } from "./extension";
import { operationsOf } from "./on";

/** A declaration `oneOf`, `accepts` or `bound` made: what it reads as. */
interface Declared {
  readonly spec: ArgSpec;
}

/** A declaration with its modifiers, each returning a new one. */
function declared(spec: ArgSpec): Declared {
  return Object.freeze({
    spec,
    default: (fallback: string | number | boolean) =>
      declared({ ...spec, default: fallback }),
    on: (operations: unknown) =>
      declared({ ...spec, on: operationsOf(operations) ?? [] }),
    models: (models: readonly string[]) => declared({ ...spec, models }),
    required: (models?: readonly string[]) =>
      declared({ ...spec, required: models ?? true }),
    volatile: () => declared({ ...spec, uncacheable: true }),
  });
}

/** An argument whose value is one of `values`. */
export function oneOf<
  const Values extends readonly (string | number | boolean)[],
>(...values: Values): Accepted<Values[number]>;
export function oneOf(...values: (string | number | boolean)[]): unknown {
  return declared({ oneOf: values });
}

/** An argument whose value a Standard Schema checks, with the modifiers of `oneOf`. */
export function accepts<S extends StandardSchemaV1>(
  schema: S
): Accepted<StandardSchemaV1.InferInput<S>>;
export function accepts(schema: StandardSchemaV1): unknown {
  return declared({ schema });
}

/**
 * An argument the client binds (`scope.$bind`), never a call: no call
 * accepts it, a rule may read it.
 */
export function bound<D extends StandardSchemaV1>(
  schema: D
): BoundAccepted<StandardSchemaV1.InferInput<D>>;
export function bound(schema: StandardSchemaV1): unknown {
  return declared({ schema, bound: true });
}

const isSchema = (value: object): value is StandardSchemaV1 =>
  "~standard" in value;

/** Whether `value` is a declaration: its `spec` is one only a builder writes. */
const isDeclared = (value: object): value is Declared =>
  "spec" in value && typeof value.spec === "object" && value.spec !== null;

function specOf(name: string, value: unknown): ArgSpec {
  if (typeof value === "object" && value !== null) {
    if (isSchema(value)) return { schema: value };
    if (isDeclared(value)) return value.spec;
  }
  throw new TypeError(
    `Argument "${name}" is declared with oneOf(...), accepts(schema), bound(schema) or a Standard Schema`
  );
}

/**
 * The extension's arguments placed, once every part wrote: an argument a
 * rule reads as its mode is placed by the rows that read it; every other one
 * as it is declared.
 */
function placeArgs(draft: DefinitionDraft): void {
  const controls: Record<string, ControlDeclaration> = {};
  for (const [name, spec] of Object.entries(draft.args ?? {}))
    if (draft.rows?.control !== name) controls[name] = spec;
  if (Object.keys(controls).length > 0) draft.controls = controls;
}

/** Arguments an extension adds to the calls they are placed on. */
export function args<
  T extends AnyTarget,
  const D extends Readonly<Record<string, ArgSource>> = Readonly<
    Record<string, ArgSource>
  >,
>(declarations: D): Part<T, ArgsFacts<D>>;
export function args(declarations: Readonly<Record<string, unknown>>): unknown {
  const specs = Object.fromEntries(
    Object.entries(declarations).map(([name, value]) => [
      name,
      specOf(name, value),
    ])
  );
  return builtPart([controlsPart], (draft) => {
    if (draft.args === undefined) draft.finish.push(() => placeArgs(draft));
    draft.args = { ...draft.args, ...specs };
  });
}
