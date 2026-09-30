import type {
  CacheableOperations,
  MutationOperations,
  Operations,
} from "@client/types";
import { QueryError, ValidationError, VibORMError } from "@errors";
import {
  isReadOperation,
  isWriteOperation,
  ROUTED_OPERATIONS,
} from "@query-engine/routed-operations";
import type { Operation } from "@query-engine/types";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { isFunction, isRecord } from "@validation/value-guards";
import { isError } from "../errors/diagnostic-safety";
import type { ControlLiteral, RuntimeExtensionDefinition } from "./definition";

// =============================================================================
// DEFINITION MEMBERS: plain data, checked by TypeScript only
// =============================================================================

/** The operations a declared control is accepted on. */
export type ControlPlacement =
  | "reads"
  | "writes"
  | "all"
  | readonly Operations[];

/**
 * One argument an extension declares. Its values are a closed list or a
 * Standard Schema; `on` names the operations that accept it (every operation
 * when absent). With `required`, a call on one of those operations that does
 * not pass it is refused. A value held in a variable keeps its literal type
 * only with `as const`, as a held enum clause does.
 */
export type ControlDeclaration = (
  | { readonly oneOf: readonly (string | number | boolean)[] }
  | { readonly schema: StandardSchemaV1 }
) & { readonly on?: ControlPlacement; readonly required?: boolean };

export type ControlsContribution = {
  readonly [name: string]: ControlDeclaration;
};

/** Constant scalar `where` or `data` fields of one model. */
type ScalarFields = { readonly [field: string]: unknown };

/**
 * Which rows an operation sees. `control` names the call argument that picks
 * a mode; every model entry declares the same mode names, `default` among
 * them. `root` filters the call's own candidates, `related` rows reached
 * through a relation. Where a filter takes a value, `{ control: "<name>" }`
 * takes the value the call passed for that control; a call that passed none
 * drops that filter.
 */
export type RowsContribution = {
  readonly control: string;
  readonly default: string;
  readonly models: {
    readonly [model: string]: {
      readonly [mode: string]: {
        readonly root?: ScalarFields;
        readonly related?: ScalarFields;
      };
    };
  };
};

/**
 * What a delete does on the models named here: an update that stamps `at`
 * with the call's time and writes `assign`, unless the call's controls match
 * `removeWhen`.
 */
export type DeletionContribution = {
  readonly removeWhen?: {
    readonly [control: string]: string | number | boolean;
  };
  readonly models: {
    readonly [model: string]: {
      readonly at?: string;
      readonly assign?: ScalarFields;
    };
  };
};

// =============================================================================
// CONTROL STATE: what a chain's controls add to each (model, operation)
// =============================================================================

/** Operations that select candidates: where a rows control is accepted. */
type CandidateOperations = Exclude<Operations, "create" | "createMany">;

/** One declared control as the delegates see it. */
export interface PlacedControl<
  Value = unknown,
  Models = PropertyKey,
  Placed = Operations,
> {
  readonly value: Value;
  readonly models: Models;
  readonly operations: Placed;
}

export type NoControls = Record<never, never>;

type ControlValue<Declaration> = Declaration extends {
  readonly oneOf: readonly (infer Value)[];
}
  ? Value
  : Declaration extends { readonly schema: StandardSchemaV1<infer Input> }
    ? Input
    : never;

type PlacementOperations<On> = On extends "reads"
  ? CacheableOperations
  : On extends "writes"
    ? MutationOperations
    : On extends readonly (infer Operation)[]
      ? Operation
      : Operations;

/**
 * `deletion` places the control `removeWhen` names: on the deletes of the
 * models it manages, whatever the declaration's `on` says.
 */
type PlaceControl<Name, Declaration, Deletion> = Deletion extends {
  readonly removeWhen: infer RemoveWhen;
  readonly models: infer Managed;
}
  ? Name extends keyof RemoveWhen
    ? PlacedControl<
        ControlValue<Declaration>,
        keyof Managed,
        "delete" | "deleteMany"
      >
    : PlaceFreeControl<Declaration>
  : PlaceFreeControl<Declaration>;

type PlaceFreeControl<Declaration> = PlacedControl<
  ControlValue<Declaration>,
  PropertyKey,
  PlacementOperations<
    Declaration extends { readonly on: infer On } ? On : "all"
  >
>;

type DeclaredControls<Definition> = Definition extends {
  readonly controls: infer Controls extends ControlsContribution;
}
  ? {
      readonly [Name in keyof Controls]: PlaceControl<
        Name,
        Controls[Name],
        Definition extends { readonly deletion: infer Deletion }
          ? Deletion
          : unknown
      >;
    }
  : NoControls;

/** Every model entry declares the same mode names: those are the values. */
type RowsModes<Rows extends RowsContribution> =
  | Rows["default"]
  | {
      [Model in keyof Rows["models"]]: keyof Rows["models"][Model];
    }[keyof Rows["models"]];

/** The rows control: every candidate-selecting operation of every model. */
type RowsControl<Definition> = Definition extends {
  readonly rows: infer Rows extends RowsContribution;
}
  ? {
      readonly [Name in Rows["control"]]: PlacedControl<
        RowsModes<Rows>,
        PropertyKey,
        CandidateOperations
      >;
    }
  : NoControls;

/**
 * The models one definition's `rows` can hide from a relation read: its
 * entries' keys. A to-one relation that targets one of them reads `null` when
 * its target is hidden, so the result types widen it (`result-types.ts`).
 */
export type RowsModels<Definition> = Definition extends {
  readonly rows: infer Rows extends RowsContribution;
}
  ? Extract<keyof Rows["models"], string>
  : never;

/** The controls one definition places, keyed by control name. */
export type DefinitionControls<Definition> = DeclaredControls<Definition> &
  RowsControl<Definition>;

/** The optional control arguments one (model, operation) accepts. */
export type OperationControls<Controls, ModelName, Operation> = {
  readonly [Name in keyof Controls as Controls[Name] extends PlacedControl<
    unknown,
    infer Models,
    infer Placed
  >
    ? ModelName extends Models
      ? Operation extends Placed
        ? Name
        : never
      : never
    : never]?: Controls[Name] extends PlacedControl<infer Value>
    ? Value
    : never;
};

// =============================================================================
// PLACEMENT: where each declared control is accepted
// =============================================================================

/** Where a control goes when its declaration names a placement. */
const PLACEMENTS: Readonly<
  Record<"reads" | "writes" | "all", ReadonlySet<string>>
> = {
  reads: new Set([...ROUTED_OPERATIONS].filter(isReadOperation)),
  writes: new Set([...ROUTED_OPERATIONS].filter(isWriteOperation)),
  all: ROUTED_OPERATIONS,
};

/** Every operation that selects candidates: where a `rows` control goes. */
const CANDIDATE_OPERATIONS: ReadonlySet<string> = new Set(
  [...ROUTED_OPERATIONS].filter(
    (operation) => operation !== "create" && operation !== "createMany"
  )
);

/** Where a `deletion.removeWhen` control goes, on the models it manages. */
const DELETE_OPERATIONS: ReadonlySet<string> = new Set([
  "delete",
  "deleteMany",
]);

/** One control of a chain: its owner, its placement and how a value is admitted. */
export interface ResolvedControl {
  readonly name: string;
  readonly extension: string;
  readonly declaration: ControlDeclaration;
  /** The operations that accept it. */
  readonly operations: ReadonlySet<string>;
  /** The models that accept it; every model when absent. */
  readonly models?: ReadonlySet<string>;
  /** What an absent argument admits: the `rows` control's default mode. */
  readonly fallback?: ControlLiteral;
}

/**
 * Give every control of one definition its placement. A control
 * `deletion.removeWhen` names goes on the deletes of the models `deletion`
 * manages; the `rows` control on every candidate-selecting operation of every
 * model, its values the mode names; every other control where its own `on`
 * says (every operation without one), on every model.
 */
export function placeControls(
  definition: RuntimeExtensionDefinition
): readonly ResolvedControl[] {
  const placed: ResolvedControl[] = [];
  const { name: extension, controls, rows, deletion } = definition;
  const removeWhen = deletion?.removeWhen ?? {};
  const managed = new Set(Object.keys(deletion?.models ?? {}));
  for (const [name, declaration] of Object.entries(controls ?? {})) {
    const removes = Object.hasOwn(removeWhen, name);
    placed.push({
      name,
      extension,
      declaration,
      operations: removes ? DELETE_OPERATIONS : placementOf(declaration.on),
      models: removes ? managed : undefined,
    });
  }
  if (rows !== undefined) {
    placed.push({
      name: rows.control,
      extension,
      declaration: Object.freeze({ oneOf: Object.freeze(rowsModes(rows)) }),
      operations: CANDIDATE_OPERATIONS,
      fallback: rows.default,
    });
  }
  return placed;
}

function placementOf(on: ControlDeclaration["on"]): ReadonlySet<string> {
  if (on === undefined) return ROUTED_OPERATIONS;
  return typeof on === "string" ? PLACEMENTS[on] : new Set<string>(on);
}

/**
 * The `rows` control's values: the mode names, which every model entry
 * declares alike, or the default alone when no model is named.
 */
export function rowsModes(rows: RowsContribution): readonly string[] {
  const [modes] = Object.values(rows.models);
  return modes === undefined ? [rows.default] : Object.keys(modes);
}

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
 * elsewhere stays in the arguments, where core validation refuses it as an
 * unknown key. A required control the call did not pass is refused here.
 */
export function admitControls(
  model: string,
  operation: Operation,
  input: Record<string, unknown>,
  placed: readonly ResolvedControl[]
): ControlAdmission {
  // Arguments that are not an object hold no control: core validation refuses
  // them as it does on a client without controls.
  if (typeof input !== "object" || input === null) {
    return { args: input, controls: undefined };
  }
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(input);
  } catch (cause) {
    throw controlFailure(
      `The arguments of ${model}.${operation} could not be inspected for controls`,
      model,
      operation,
      cause
    );
  }
  const admitted: [string, unknown][] = [];
  let given: Set<PropertyKey> | undefined;
  for (const control of placed) {
    let raw: unknown;
    if (keys.includes(control.name)) {
      (given ??= new Set()).add(control.name);
      raw = readControl(input, control, model, operation);
    }
    const value =
      raw === undefined
        ? control.fallback
        : admitControl(control, raw, model, operation);
    if (value !== undefined) admitted.push([control.name, value]);
    else if (control.declaration.required === true) {
      throw invalidControl(control, model, operation, ["is required"]);
    }
  }
  return {
    args:
      given === undefined
        ? input
        : withoutControls(input, keys, given, model, operation),
    controls:
      admitted.length === 0
        ? undefined
        : Object.freeze(Object.fromEntries(admitted)),
  };
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

function readControl(
  input: Record<string, unknown>,
  control: ResolvedControl,
  model: string,
  operation: Operation
): unknown {
  try {
    return Reflect.get(input, control.name);
  } catch (cause) {
    throw controlFailure(
      `Extension "${control.extension}" control "${control.name}" of ${model}.${operation} could not be read`,
      model,
      operation,
      cause
    );
  }
}

/** The caller's arguments minus the controls, every other descriptor kept. */
function withoutControls(
  input: Record<string, unknown>,
  keys: readonly PropertyKey[],
  controls: ReadonlySet<PropertyKey>,
  model: string,
  operation: Operation
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  try {
    for (const key of keys) {
      if (controls.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor) Object.defineProperty(args, key, descriptor);
    }
  } catch (cause) {
    throw controlFailure(
      `The arguments of ${model}.${operation} could not be inspected for controls`,
      model,
      operation,
      cause
    );
  }
  return args;
}

function admitControl(
  control: ResolvedControl,
  value: unknown,
  model: string,
  operation: Operation
): unknown {
  const { declaration } = control;
  if ("oneOf" in declaration) {
    if (declaration.oneOf.some((allowed) => allowed === value)) return value;
    throw invalidControl(control, model, operation, [
      `must be one of ${declaration.oneOf.map((allowed) => JSON.stringify(allowed)).join(", ")}`,
    ]);
  }
  let result: unknown;
  try {
    result = declaration.schema["~standard"].validate(value);
  } catch (cause) {
    // A validator may own its typed failure; anything else is a failure of
    // extension code, as a throwing request transform is.
    if (isVibORMFailure(cause)) throw cause;
    throw validatorFailure(control, model, operation, "threw", cause);
  }
  let shape: "promise" | "malformed" | "issues" | "value" = "malformed";
  let issues: readonly unknown[] = [];
  let admitted: unknown;
  try {
    if (isRecord(result)) {
      const then = "then" in result ? result.then : undefined;
      if (isFunction(then)) {
        shape = "promise";
        // The refused promise is still live; without a handler its rejection
        // would surface as an unhandled rejection (D-37).
        Reflect.apply(then, result, [undefined, () => undefined]);
      } else {
        const listed = result.issues;
        if (listed !== undefined) {
          if (Array.isArray(listed)) {
            shape = "issues";
            issues = listed;
          }
        } else if ("value" in result) {
          shape = "value";
          admitted = result.value;
        }
      }
    }
  } catch (cause) {
    throw validatorFailure(
      control,
      model,
      operation,
      "returned an unreadable result",
      cause
    );
  }
  switch (shape) {
    case "value":
      return admitted;
    case "issues":
      throw invalidControl(control, model, operation, issueMessages(issues));
    case "promise":
      throw validatorFailure(
        control,
        model,
        operation,
        "returned a promise",
        new TypeError("Control validators must return synchronously")
      );
    default:
      throw validatorFailure(
        control,
        model,
        operation,
        "returned a malformed result",
        new TypeError("A Standard Schema result has a value or an issue list")
      );
  }
}

/** Each issue's message; an issue that cannot be read still refuses. */
function issueMessages(issues: readonly unknown[]): string[] {
  const messages: string[] = [];
  try {
    for (const issue of issues) {
      const message = isRecord(issue) ? issue.message : undefined;
      messages.push(typeof message === "string" ? message : "is invalid");
    }
  } catch {
    return ["is invalid"];
  }
  return messages.length === 0 ? ["is invalid"] : messages;
}

/** Contained: `instanceof` on a hostile thrown proxy is itself a throw site. */
function isVibORMFailure(value: unknown): value is VibORMError {
  try {
    return value instanceof VibORMError;
  } catch {
    return false;
  }
}

function invalidControl(
  control: ResolvedControl,
  model: string,
  operation: Operation,
  messages: readonly string[]
): ValidationError {
  return new ValidationError(
    { kind: "operation", operation, model },
    messages.map((message) => ({
      path: control.name,
      message: `Control "${control.name}" ${message}`,
    })),
    { meta: { model, extension: control.extension } }
  );
}

function validatorFailure(
  control: ResolvedControl,
  model: string,
  operation: Operation,
  failure: string,
  cause: unknown
): QueryError {
  return controlFailure(
    `Extension "${control.extension}" control "${control.name}" validator for ${model}.${operation} ${failure}`,
    model,
    operation,
    cause
  );
}

function controlFailure(
  message: string,
  model: string,
  operation: Operation,
  cause: unknown
): QueryError {
  return new QueryError(`${message}.`, {
    cause: isError(cause)
      ? cause
      : new Error("A non-Error value was thrown.", { cause }),
    meta: { model, operation },
  });
}
