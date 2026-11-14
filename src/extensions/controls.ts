/**
 * Arguments: what `args` declares, placed on a chain and admitted once per
 * call. Brought by `args` alone: an extension that declares no argument
 * carries none of it.
 */
import {
  ClientInitializationError,
  QueryError,
  ValidationError,
  VibORMError,
} from "@errors";
import type { Operation } from "@query-engine/types";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { discardAsyncValidationResult } from "@validation/parse-failure";
import { errorCause } from "../errors/diagnostic-safety";
import { extensionError } from "./chain";
import type { ResolvedControls } from "./chain-state";

export type ControlLiteral = string | number | boolean;

/**
 * One argument an extension declares. Its values are a closed list or a
 * Standard Schema; `on` names the operations that accept it (every operation
 * when absent), `models` the models (every model when absent). With
 * `required`, a call on one of those operations that does not pass it is
 * refused: on every model that accepts it, or on the models it lists. With
 * `bound`, it is accepted only from a binding (the client scope's `$bind`),
 * never from a call's arguments, so a call that passes it is refused as
 * passing an unknown key. With `volatile`, a call that holds a value of it
 * has no key (`key(run)`): a read that holds one is never served from a
 * store nor kept in one.
 */
export type ControlDeclaration = (
  | { readonly oneOf: readonly (string | number | boolean)[] }
  | { readonly schema: StandardSchemaV1 }
) & {
  readonly on?: readonly string[];
  readonly models?: readonly string[];
  readonly required?: true | readonly string[];
  /** The value a call that passes none reads. */
  readonly default?: ControlLiteral;
  readonly bound?: boolean;
  readonly volatile?: boolean;
};

export type ControlsContribution = {
  readonly [name: string]: ControlDeclaration;
};

/**
 * One argument of a chain: its declaration as written, its name and the
 * extension that declares it. Its declaration alone places it: no other part
 * moves it.
 */
export type ResolvedControl = ControlDeclaration & {
  readonly name: string;
  readonly extension: string;
};

/** The arguments one call admitted, by name; one it did not pass is absent. */
export type AdmittedControls = Readonly<Record<string, unknown>>;

export interface ControlAdmission {
  /** The call's arguments without the chain's; the input itself when it passed none. */
  readonly args: Record<string, unknown>;
  /** `undefined` when the call admitted no value. */
  readonly controls: AdmittedControls | undefined;
}

/**
 * Take every argument placed on this operation out of the call's arguments
 * and admit each once, before any first moment runs. A key naming an argument
 * placed elsewhere, or a bound one, stays in the arguments, where core
 * validation refuses it as an unknown key. An argument the call did not pass
 * takes the value its view binds, else its default; without either it is
 * refused where it is required.
 */
function admitArguments(
  model: string,
  operation: Operation,
  input: Record<string, unknown>,
  placed: readonly ResolvedControl[],
  bound?: AdmittedControls
): ControlAdmission {
  // Arguments that are not an object hold no extension argument: core
  // validation refuses them as it does on a client without extensions.
  if (typeof input !== "object" || input === null) {
    return { args: input, controls: undefined };
  }
  const admitted: [string, unknown][] = [];
  let args: Record<string, unknown> | undefined;
  for (const argument of placed) {
    const { name, required } = argument;
    let raw: unknown;
    if (argument.bound !== true && Object.hasOwn(input, name)) {
      raw = input[name];
      args ??= { ...input };
      delete args[name];
    }
    // A bound value was admitted once, when its view was bound.
    const value =
      raw === undefined
        ? (bound?.[name] ?? argument.default)
        : admitValue(argument, raw, model, operation);
    if (value !== undefined) admitted.push([name, value]);
    else if (required === true || required?.includes(model)) {
      throw invalidArgument(argument, model, operation, ["is required"]);
    }
  }
  return {
    args: args ?? input,
    controls: admitted.length === 0 ? undefined : Object.fromEntries(admitted),
  };
}

/**
 * The values a view binds after one extension binds its own arguments: each
 * admitted once, over the values the view already binds, a value replacing
 * an earlier one.
 */
function bindArguments(
  all: readonly ResolvedControl[],
  extension: string,
  values: Readonly<Record<string, unknown>>,
  previous: AdmittedControls | undefined
): AdmittedControls {
  const next: Record<string, unknown> = { ...previous };
  for (const [name, raw] of Object.entries(values)) {
    const argument = all.find(
      (candidate) =>
        candidate.name === name && candidate.extension === extension
    );
    if (argument === undefined) undeclaredBinding(extension, name);
    next[name] = admitValue(argument, raw);
  }
  return next;
}

/** The refusal of a `$bind` naming an argument its extension does not declare. */
export function undeclaredBinding(extension: string, name: string): never {
  throw new ClientInitializationError(
    `Extension "${extension}" binds argument "${name}", which it does not declare.`,
    { meta: { extension } }
  );
}

/** One extension's own admitted arguments, as its parts see them (`c.values`). */
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
  return Object.fromEntries(owned);
}

/** One value admitted for a call's (model, operation), or, without them, a binding. */
function admitValue(
  argument: ResolvedControl,
  value: unknown,
  model?: string,
  operation?: Operation
): unknown {
  if ("oneOf" in argument) {
    if (argument.oneOf.some((allowed) => allowed === value)) return value;
    throw invalidArgument(argument, model, operation, [
      `must be one of ${argument.oneOf.map((allowed) => JSON.stringify(allowed)).join(", ")}`,
    ]);
  }
  let result: ReturnType<StandardSchemaV1["~standard"]["validate"]>;
  try {
    result = argument.schema["~standard"].validate(value);
  } catch (cause) {
    // A validator may own its typed failure; anything else is a failure of
    // extension code, as a throwing first moment is.
    if (cause instanceof VibORMError) throw cause;
    throw validatorFailure(argument, model, operation, "threw", cause);
  }
  if ("then" in result) {
    // The refused promise is still live; without a handler its rejection
    // would surface as an unhandled rejection (D-37).
    discardAsyncValidationResult(result);
    throw validatorFailure(
      argument,
      model,
      operation,
      "returned a promise",
      new TypeError("Argument validators must return synchronously")
    );
  }
  if (result.issues)
    throw invalidArgument(
      argument,
      model,
      operation,
      result.issues.map((issue) => issue.message)
    );
  return result.value;
}

function invalidArgument(
  argument: ResolvedControl,
  model: string | undefined,
  operation: Operation | undefined,
  messages: readonly string[]
): ValidationError {
  return new ValidationError(
    operation === undefined
      ? { kind: "schema-builder", builder: "$bind", path: argument.name }
      : { kind: "operation", operation, model },
    messages.map((message) => ({
      path: argument.name,
      message: `Argument "${argument.name}" ${message}`,
    })),
    { meta: { model, extension: argument.extension } }
  );
}

function validatorFailure(
  argument: ResolvedControl,
  model: string | undefined,
  operation: Operation | undefined,
  failure: string,
  cause: unknown
): QueryError {
  return new QueryError(
    `Extension "${argument.extension}" argument "${argument.name}" validator for ${operation === undefined ? "$bind" : `${model}.${operation}`} ${failure}.`,
    { cause: errorCause(cause), meta: { model, operation } }
  );
}

const NO_ARGUMENTS: readonly ResolvedControl[] = [];

/**
 * The chain's arguments with one extension's added, each (model, operation)
 * listing the ones it accepts the first time a call asks. One name, one
 * argument: a call's value is read once and admitted against one
 * declaration, so a second declaration of a name would refuse every call
 * that passes either value, and a binding would answer for both.
 */
export function appendArguments(
  previous: ResolvedControls | undefined,
  declared: readonly ResolvedControl[]
): ResolvedControls {
  const all = [...(previous?.all ?? []), ...declared];
  const names = new Set<string>();
  for (const { name, extension } of all) {
    if (names.has(name))
      extensionError(
        `Extension "${extension}" declares argument "${name}", which extension "${all.find((argument) => argument.name === name)?.extension}" already declares.`,
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
        ({ on, models }) =>
          (on === undefined || on.includes(operation)) &&
          (models === undefined || models.includes(model))
      );
      list = found.length === 0 ? NO_ARGUMENTS : found;
      lists.set(key, list);
    }
    return list;
  };
  return {
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
        : admitArguments(model, operation, args, list, bound);
    },
    bind: (
      extension: string,
      values: Readonly<Record<string, unknown>>,
      previous: AdmittedControls | undefined
    ) => bindArguments(all, extension, values, previous),
  };
}
