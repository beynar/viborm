import type { Operations } from "@client/types";
import {
  ClientInitializationError,
  QueryError,
  ValidationError,
  VibORMError,
} from "@errors";
import { ROUTED_OPERATIONS } from "@query-engine/routed-operations";
import type { Operation } from "@query-engine/types";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { discardAsyncValidationResult } from "@validation/parse-failure";
import { errorCause } from "../errors/diagnostic-safety";
import type { ExtensionPart } from "./chain";
import type { ResolvedControls } from "./chain-state";
import {
  type ControlLiteral,
  extensionError,
  type RuntimeExtensionDefinition,
} from "./definition";

/**
 * One argument an extension declares. Its values are a closed list or a
 * Standard Schema; `on` names the operations that accept it (every operation
 * when absent), `models` the models (every model when absent). With
 * `required`, a call on one of those operations that does not pass it is
 * refused: on every model that accepts it, or on the models it lists. With
 * `bound`, it is accepted only from a binding (the client
 * scope's `$bind`), never from a call's arguments: its placement reads no
 * argument, so a call that passes it is refused as passing an unknown key.
 * With `volatile`, a call that holds a value of it has no key (`key(run)`):
 * a read that holds one is never served from a store nor kept in one. A
 * value held in a variable keeps its literal type only with `as const`, as a
 * held enum clause does.
 */
export type ControlDeclaration = (
  | { readonly oneOf: readonly (string | number | boolean)[] }
  | { readonly schema: StandardSchemaV1 }
) & {
  readonly on?: readonly Operations[];
  /** The models that accept it; every model when absent. */
  readonly models?: readonly string[];
  /** Refused when absent: everywhere it is accepted, or on these models. */
  readonly required?: true | readonly string[];
  /** The value a call that passes none reads. */
  readonly default?: ControlLiteral;
  readonly bound?: boolean;
  readonly volatile?: boolean;
};

export type ControlsContribution = {
  readonly [name: string]: ControlDeclaration;
};

// =============================================================================
// PLACEMENT: where each declared control is accepted
// =============================================================================

/** One control of a chain: its owner, its placement and how a value is admitted. */
export interface ResolvedControl {
  readonly name: string;
  readonly extension: string;
  readonly declaration: ControlDeclaration;
  /** The operations that accept it. */
  readonly operations: ReadonlySet<string>;
  /** The models that accept it; every model when absent. */
  readonly models?: ReadonlySet<string>;
  /**
   * Where a call that does not pass it is refused: on every model that
   * accepts it (`true`), on these models only, or nowhere when absent.
   */
  readonly required?: true | ReadonlySet<string>;
  /** What an absent argument admits: its default. */
  readonly fallback?: ControlLiteral;
  /** Accepted only from a binding, never read from the arguments. */
  readonly bound?: true;
}

/**
 * Give every control of one definition its placement: where its own
 * declaration says, and nowhere else. No other part of the definition moves
 * it: an argument a `keep` or a rule reads is placed by its `.on(…)`,
 * `.models([…])` and `.required([…])`.
 */
export function placeControls(
  definition: RuntimeExtensionDefinition
): readonly ResolvedControl[] {
  const { name: extension, controls } = definition;
  return Object.entries(controls ?? {}).map(([name, declaration]) => {
    const { required } = declaration;
    return {
      name,
      extension,
      declaration,
      operations: placementOf(declaration.on),
      ...(declaration.models && { models: new Set(declaration.models) }),
      ...(required !== undefined && {
        required: required === true ? true : new Set(required),
      }),
      ...(declaration.default !== undefined && {
        fallback: declaration.default,
      }),
      ...(declaration.bound === true && { bound: true }),
    };
  });
}

/** Where a control goes: every operation, or those `.on(…)` names. */
const placementOf = (on: ControlDeclaration["on"]): ReadonlySet<string> =>
  Array.isArray(on) ? new Set(on) : ROUTED_OPERATIONS;

// =============================================================================
// ADMISSION: one call's controls, removed and validated once
// =============================================================================

/**
 * The controls one call admitted, by name. A `rows` control is resolved to its
 * mode, so an absent one reads as its default; an absent plain control is not
 * here.
 */
export type AdmittedControls = Readonly<Record<string, unknown>>;

export interface ControlAdmission {
  /** The arguments without their controls; the input itself when none was given. */
  readonly args: Record<string, unknown>;
  /** `undefined` when the call admitted no value. */
  readonly controls: AdmittedControls | undefined;
}

/**
 * Remove every control placed on this operation from its arguments and admit
 * each once, before any request handler runs. A key naming a control placed
 * elsewhere, or a bound-only one, stays in the arguments, where core
 * validation refuses it as an unknown key. A control the call did not pass
 * takes the value its view binds, if any; without one it is refused here on
 * the models its placement requires it on.
 */
export function admitControls(
  model: string,
  operation: Operation,
  input: Record<string, unknown>,
  placed: readonly ResolvedControl[],
  bound?: AdmittedControls
): ControlAdmission {
  // Arguments that are not an object hold no control: core validation refuses
  // them as it does on a client without controls.
  if (typeof input !== "object" || input === null) {
    return { args: input, controls: undefined };
  }
  const admitted: [string, unknown][] = [];
  let args: Record<string, unknown> | undefined;
  for (const control of placed) {
    const { name, required } = control;
    let raw: unknown;
    if (control.bound !== true && Object.hasOwn(input, name)) {
      raw = input[name];
      args ??= { ...input };
      delete args[name];
    }
    // A bound value was admitted and fixed once, when its view was bound.
    const value =
      raw === undefined
        ? (bound?.[name] ?? control.fallback)
        : admitControl(control, raw, model, operation);
    if (value !== undefined) admitted.push([name, value]);
    else if (required === true || required?.has(model)) {
      throw invalidControl(control, model, operation, ["is required"]);
    }
  }
  return {
    args: args ?? input,
    controls:
      admitted.length === 0
        ? undefined
        : Object.freeze(Object.fromEntries(admitted)),
  };
}

/**
 * The values a view binds after one extension binds its own controls: each
 * admitted once and fixed, over the values the view already binds, a value
 * replacing an earlier one.
 */
export function bindControls(
  controls: readonly ResolvedControl[],
  extension: string,
  values: Readonly<Record<string, unknown>>,
  previous: AdmittedControls | undefined
): AdmittedControls {
  const next: Record<string, unknown> = { ...previous };
  for (const [name, raw] of Object.entries(values)) {
    const control = controls.find(
      (candidate) =>
        candidate.name === name && candidate.extension === extension
    );
    if (control === undefined) undeclaredBinding(extension, name);
    next[name] = admitControl(control, raw);
  }
  return Object.freeze(next);
}

/** The refusal of a `$bind` naming a control its extension does not declare. */
export function undeclaredBinding(extension: string, name: string): never {
  throw new ClientInitializationError(
    `Extension "${extension}" binds control "${name}", which it does not declare.`,
    { meta: { extension } }
  );
}

/** One extension's own admitted controls, as its handlers see them. */
export function controlsOwnedBy(
  admitted: AdmittedControls | undefined,
  names: readonly string[]
): AdmittedControls {
  const owned: [string, unknown][] = [];
  for (const name of names) {
    if (admitted !== undefined && Object.hasOwn(admitted, name)) {
      owned.push([name, admitted[name]]);
    }
  }
  return Object.freeze(Object.fromEntries(owned));
}

/** One value admitted for a call's (model, operation), or, without them, a binding. */
function admitControl(
  control: ResolvedControl,
  value: unknown,
  model?: string,
  operation?: Operation
): unknown {
  const { declaration } = control;
  if ("oneOf" in declaration) {
    if (declaration.oneOf.some((allowed) => allowed === value)) return value;
    throw invalidControl(control, model, operation, [
      `must be one of ${declaration.oneOf.map((allowed) => JSON.stringify(allowed)).join(", ")}`,
    ]);
  }
  let result: ReturnType<StandardSchemaV1["~standard"]["validate"]>;
  try {
    result = declaration.schema["~standard"].validate(value);
  } catch (cause) {
    // A validator may own its typed failure; anything else is a failure of
    // extension code, as a throwing request transform is.
    if (cause instanceof VibORMError) throw cause;
    throw validatorFailure(control, model, operation, "threw", cause);
  }
  if ("then" in result) {
    // The refused promise is still live; without a handler its rejection
    // would surface as an unhandled rejection (D-37).
    discardAsyncValidationResult(result);
    throw validatorFailure(
      control,
      model,
      operation,
      "returned a promise",
      new TypeError("Control validators must return synchronously")
    );
  }
  if (result.issues)
    throw invalidControl(
      control,
      model,
      operation,
      result.issues.map((issue) => issue.message)
    );
  return result.value;
}

function invalidControl(
  control: ResolvedControl,
  model: string | undefined,
  operation: Operation | undefined,
  messages: readonly string[]
): ValidationError {
  return new ValidationError(
    operation === undefined
      ? { kind: "schema-builder", builder: "$bind", path: control.name }
      : { kind: "operation", operation, model },
    messages.map((message) => ({
      path: control.name,
      message: `Control "${control.name}" ${message}`,
    })),
    { meta: { model, extension: control.extension } }
  );
}

function validatorFailure(
  control: ResolvedControl,
  model: string | undefined,
  operation: Operation | undefined,
  failure: string,
  cause: unknown
): QueryError {
  return new QueryError(
    `Extension "${control.extension}" control "${control.name}" validator for ${operation === undefined ? "$bind" : `${model}.${operation}`} ${failure}.`,
    { cause: errorCause(cause), meta: { model, operation } }
  );
}

const NO_CONTROLS: readonly ResolvedControl[] = /* @__PURE__ */ Object.freeze(
  []
);

/**
 * The chain's controls with one definition's added, indexed by operation for
 * every model and for each model some control names. One name, one control:
 * a call's argument is read once and admitted against one declaration, so a
 * second declaration of a name (another extension's, or this one's `rows`
 * control beside its own `controls`) would refuse every call that passes
 * either value, and a binding would answer for both.
 */
function appendControls(
  previous: ResolvedControls | undefined,
  declarations: readonly ResolvedControl[]
): ResolvedControls {
  const all = Object.freeze([
    ...(previous?.all ?? []),
    ...declarations.map((control) => Object.freeze(control)),
  ]);
  const names = new Set<string>();
  for (const { name, extension } of all) {
    if (names.has(name))
      extensionError(
        `Extension "${extension}" declares control "${name}", which extension "${all.find((control) => control.name === name)?.extension}" already declares.`,
        extension
      );
    names.add(name);
  }
  const lists = new Map<string, readonly ResolvedControl[]>();
  const placed = (
    model: string,
    operation: string
  ): readonly ResolvedControl[] => {
    const key = `${model}\u0000${operation}`;
    let list = lists.get(key);
    if (list === undefined) {
      const found = all.filter(
        (control) =>
          control.operations.has(operation) &&
          (control.models === undefined || control.models.has(model))
      );
      list = found.length === 0 ? NO_CONTROLS : Object.freeze(found);
      lists.set(key, list);
    }
    return list;
  };
  return Object.freeze({
    names,
    all,
    placed,
    owned: controlsOwnedBy,
    admit: (
      model: string,
      placement: string,
      operation: Operation,
      args: Record<string, unknown>,
      bound: AdmittedControls | undefined
    ) => {
      const list = placed(model, placement);
      return list.length === 0
        ? undefined
        : admitControls(model, operation, args, list, bound);
    },
    bind: (
      extension: string,
      values: Readonly<Record<string, unknown>>,
      previous: AdmittedControls | undefined
    ) => bindControls(all, extension, values, previous),
  });
}

/**
 * `controls`: arguments an extension adds to calls. Declared before any
 * other part joins: a definition's handlers see its own controls.
 */
export const controlsPart: ExtensionPart = {
  declare(application) {
    const { definition, chain, next } = application;
    if (definition.controls === undefined) return;
    const declared = placeControls(definition);
    next.controls = appendControls(chain?.controls, declared);
    application.owner = {
      name: definition.name,
      controls: Object.freeze(declared.map((control) => control.name)),
    };
  },
};
