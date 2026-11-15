import type { StandardSchemaV1 } from "@standard-schema/spec";
import { type ArgDeclaration, appendArguments } from "./arguments";
import type { ExtensionPart } from "./chain";
import type {
  Accepted,
  AnyTarget,
  ArgSource,
  ArgsFacts,
  BoundAccepted,
  Part,
} from "./contract";
import { operationsOf } from "./on";

/** A declaration `oneOf`, `accepts` or `bound` made: what it reads as. */
interface Declared {
  readonly spec: ArgDeclaration;
}

/** A declaration with its modifiers, each returning a new one. */
function declared(spec: ArgDeclaration): Declared {
  const value: Declared & Record<string, unknown> = {
    spec,
    default: (fallback: string | number | boolean) =>
      declared({ ...spec, default: fallback }),
    // A name, a list or a set, as the types take it: each names operations.
    on: (operations: unknown) =>
      declared({ ...spec, on: operationsOf(operations) }),
    models: (models: readonly string[]) => declared({ ...spec, models }),
    required: (models?: readonly string[]) =>
      declared({ ...spec, required: models ?? true }),
    volatile: () => declared({ ...spec, volatile: true }),
  };
  return value;
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

function specOf(name: string, value: unknown): ArgDeclaration {
  // A schema may be callable (ArkType's types are functions).
  if (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) {
    if (isSchema(value)) return { schema: value };
    if (isDeclared(value)) return value.spec;
  }
  throw new TypeError(
    `Argument "${name}" is declared with oneOf(...), accepts(schema), bound(schema) or a Standard Schema`
  );
}

/** Arguments an extension adds to the calls they are placed on. */
export function args<
  T extends AnyTarget,
  const D extends Readonly<Record<string, ArgSource>> = Readonly<
    Record<string, ArgSource>
  >,
>(declarations: D): Part<T, ArgsFacts<D>>;
export function args(declarations: Readonly<Record<string, unknown>>): unknown {
  const names = Object.keys(declarations);
  const specs = names.map((name) => ({
    ...specOf(name, declarations[name]),
    name,
  }));
  const part: ExtensionPart = {
    // Declared before any other part joins: the extension's parts see its
    // own arguments. A name declared twice, in one extension too, is
    // refused as two extensions declaring it would be.
    declare(application) {
      const { next, chain, owner, name: extension } = application;
      next.args = appendArguments(
        next.args ?? chain?.args,
        specs.map((spec) => ({ ...spec, extension }))
      );
      application.owner = {
        name: extension,
        args: [...(owner.args ?? []), ...names],
      };
    },
  };
  return part;
}
