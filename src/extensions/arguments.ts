/**
 * Arguments: what `args` declares, placed on a chain and admitted once per
 * call. Brought by `args` alone: an extension that declares no argument
 * carries none of it.
 */

import { QueryError, ValidationError, VibORMError } from "@errors";
import { memo } from "@query-engine/raptor3/shared/schema";
import type { Operation } from "@query-engine/types";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { discardAsyncValidationResult } from "@validation/parse-failure";
import { errorCause } from "../errors/diagnostic-safety";
import { extensionError } from "./chain";
import type { ResolvedArgs } from "./chain-state";

type ArgLiteral = string | number | boolean;

/**
 * One argument an extension declares. Its values are a closed list or a
 * Standard Schema, and `admit` is the code that checks one, brought by the
 * word that declared it (`oneOf`, or `accepts` and `bound`), so a chain of
 * closed arguments carries no Standard Schema admission. `on` names the
 * operations that accept it (every operation when absent), `models` the
 * models (every model when absent). With `required`, a call on one of those
 * operations that does not pass it is refused: on every model that accepts
 * it, or on the models it lists. With `bound`, it is accepted only from a
 * binding (the client scope's `$bind`, which `bind` runs), never from a
 * call's arguments, so a call that passes it is refused as passing an
 * unknown key. With `volatile`, a call that holds a value of it has no key
 * (`key(run)`): a read that holds one is never served from a store nor kept
 * in one.
 */
export interface ArgDeclaration {
  /** A closed argument's values; absent for a Standard Schema's. */
  readonly oneOf?: readonly ArgLiteral[];
  readonly admit: AdmitValue;
  readonly on?: readonly string[];
  readonly models?: readonly string[];
  readonly required?: true | readonly string[];
  /** The value a call that passes none reads. */
  readonly default?: ArgLiteral;
  readonly bound?: boolean;
  readonly bind?: typeof bindArguments;
  readonly volatile?: boolean;
}

/** One value admitted for a call's (model, operation), or, without them, a binding. */
type AdmitValue = (
  argument: ResolvedArg,
  value: unknown,
  model?: string,
  operation?: Operation
) => unknown;

/**
 * One argument of a chain: its declaration as written, its name and the
 * extension that declares it. Its declaration alone places it: no other part
 * moves it.
 */
export type ResolvedArg = ArgDeclaration & {
  readonly name: string;
  readonly extension: string;
};

/** The arguments one call admitted, by name; one it did not pass is absent. */
export type AdmittedArgs = Readonly<Record<string, unknown>>;

export interface ArgAdmission {
  /** The call's arguments without the chain's; the input itself when it passed none. */
  readonly args: Record<string, unknown>;
  /** `undefined` when the call admitted no value. */
  readonly values: AdmittedArgs | undefined;
}

/**
 * The values a view binds after one extension binds its own arguments: each
 * admitted once, over the values the view already binds, a value replacing
 * an earlier one. Brought by `bound`: only a `bound` argument is bound.
 */
export function bindArguments(
  all: readonly ResolvedArg[],
  extension: string,
  values: Readonly<Record<string, unknown>>,
  previous: AdmittedArgs | undefined
): AdmittedArgs {
  const next: Record<string, unknown> = { ...previous };
  for (const [name, raw] of Object.entries(values)) {
    const argument = all.find(
      (candidate) =>
        candidate.name === name &&
        candidate.extension === extension &&
        candidate.bound === true
    );
    if (argument === undefined) notBound(extension, name);
    next[name] = argument.admit(argument, raw);
  }
  return next;
}

/** The refusal of a `$bind` naming an argument its extension does not declare `bound`. */
export function notBound(extension: string, name: string): never {
  return extensionError(
    `Extension "${extension}" binds argument "${name}", which it does not declare with bound(schema).`,
    extension
  );
}

/** One extension's own admitted arguments, as its parts see them (`c.values`). */
function argsOwnedBy(
  admitted: AdmittedArgs | undefined,
  names: readonly string[]
): AdmittedArgs {
  const owned: Record<string, unknown> = {};
  for (const name of names)
    if (admitted && Object.hasOwn(admitted, name)) owned[name] = admitted[name];
  return owned;
}

/** What admits a value of one of `values`, brought by `oneOf`. */
export const closedValues =
  (values: readonly ArgLiteral[]): AdmitValue =>
  (argument, value, model, operation) => {
    if (values.some((allowed) => allowed === value)) return value;
    throw invalidArgument(argument, model, operation, [
      `must be one of ${values.map((allowed) => JSON.stringify(allowed)).join(", ")}`,
    ]);
  };

/** What admits a value `schema` checks, brought by `accepts` and `bound`. */
export const checkedBy =
  (schema: StandardSchemaV1): AdmitValue =>
  (argument, value, model, operation) => {
    let result: ReturnType<StandardSchemaV1["~standard"]["validate"]>;
    try {
      result = schema["~standard"].validate(value);
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
  };

function invalidArgument(
  argument: ResolvedArg,
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
  argument: ResolvedArg,
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

/**
 * The chain's arguments with one extension's added, each (model, operation)
 * listing the ones it accepts the first time a call asks. One name, one
 * argument: a call's value is read once and admitted against one
 * declaration, so a second declaration of a name would refuse every call
 * that passes either value, and a binding would answer for both.
 */
export function appendArguments(
  previous: ResolvedArgs | undefined,
  declared: readonly ResolvedArg[]
): ResolvedArgs {
  const all = [...(previous?.all ?? []), ...declared];
  const binder = all.find((argument) => argument.bind)?.bind;
  const names = new Set<string>();
  for (const { name, extension } of all) {
    if (names.has(name))
      extensionError(
        `Extension "${extension}" declares argument "${name}", which extension "${all.find((argument) => argument.name === name)?.extension}" already declares.`,
        extension
      );
    names.add(name);
  }
  const lists = new Map<string, readonly ResolvedArg[]>();
  const placed = (model: string, operation: string): readonly ResolvedArg[] => {
    const key = `${model}\u0000${operation}`;
    return memo(lists, key, () =>
      all.filter(
        ({ on, models }) =>
          (on === undefined || on.includes(operation)) &&
          (models === undefined || models.includes(model))
      )
    );
  };
  return {
    names,
    all,
    placed,
    owned: argsOwnedBy,
    /**
     * Take every argument placed on this operation out of the call's
     * arguments and admit each once, before any first moment runs. A key
     * naming an argument placed elsewhere, or a bound one, stays in the
     * arguments, where core validation refuses it as an unknown key. An
     * argument the call did not pass takes the value its view binds, else
     * its default; without either it is refused where it is required.
     */
    admit: (
      model: string,
      placement: string,
      operation: Operation,
      input: Record<string, unknown>,
      bound: AdmittedArgs | undefined
    ): ArgAdmission | undefined => {
      const list = placed(model, placement);
      if (list.length === 0) return undefined;
      // Arguments that are not an object hold no extension argument: core
      // validation refuses them as it does on a client without extensions.
      if (typeof input !== "object" || input === null) {
        return { args: input, values: undefined };
      }
      let values: Record<string, unknown> | undefined;
      let args: Record<string, unknown> | undefined;
      for (const argument of list) {
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
            : argument.admit(argument, raw, model, operation);
        if (value !== undefined) (values ??= {})[name] = value;
        else if (required === true || required?.includes(model)) {
          throw invalidArgument(argument, model, operation, ["is required"]);
        }
      }
      return { args: args ?? input, values };
    },
    // Brought by `bound`: a chain that declares no bound argument binds none.
    bind: binder && ((...binding) => binder(all, ...binding)),
  };
}
