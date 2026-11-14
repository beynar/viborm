import type {
  CacheableOperations,
  MutationOperations,
  Operations,
} from "@client/types";
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
  readonly on?: ControlPlacement;
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

/** Constant scalar `where` or `data` fields of one model. */
type ScalarFields = { readonly [field: string]: unknown };

/**
 * Which rows an operation sees. `control` names the call argument that picks
 * a mode; every model entry declares the same mode names, `default` among
 * them. `root` filters the call's own candidates, `related` rows reached
 * through a relation; each is a model's `where`, admitted once when the
 * extension is applied, or the name of one of its `verbs` predicates. Where a
 * filter takes a value, `{ control: "<name>", path?: "a.b" }` takes the value
 * the call passed for that control (or a field of it), `{ now: true }` the
 * call's instant, and `{ $if: … }` tests a call value. An absent value
 * (`null` included) matches nothing where its control is required, and drops
 * its filter where it is not.
 *
 * `verbs` judges, per model, what a call may do to the rows it sees: a mode
 * only narrows them (R8). A model's entry may be a function returning it:
 * it is called when a call of the chain first needs that model, and its
 * entry admitted then, so a refusal of it fails that call instead of
 * `$extends`. It is called once for the declaration it belongs to, which is
 * admitted once per schema: a declaration changed after it was applied is
 * not read again.
 */
export type RowsContribution = {
  readonly control: string;
  readonly default: string;
  readonly models: {
    readonly [model: string]: {
      readonly [mode: string]: {
        readonly root?: ScalarFields | string;
        readonly related?: ScalarFields | string;
      };
    };
  };
  readonly verbs?: {
    readonly [model: string]: RowsVerbs | (() => RowsVerbs);
  };
  /**
   * Per model, a `where` every row of a set this member's own predicates
   * compute over the model's whole table holds, in every mode: what the
   * statement shares once (a repeated body) or walks as a set (a recursive
   * filter under a relation budget), where a positive test reads it (never
   * under `NOT`, `none`, `every` or `isNot`). A relation those predicates
   * read row by row is not bounded: from a row the member admits, it reaches
   * such rows already. `permissions`' `tenant` states its tenant here.
   */
  readonly confine?: { readonly [model: string]: ScalarFields };
};

/**
 * One model's named predicates, each a `where` admitted once, and the verbs
 * that take them. `read` ANDs with every mode's `root` and `related`; a write
 * takes its verb's beside them: a delete `delete`'s, an update, for each
 * field its data writes, that field's `writes` entry, else `update`'s, and
 * `update`'s when its data writes only stamps. A join row's change is a write
 * of the relation on both rows it links; a row only addressed to reach its
 * children is read. A verb left out matches nothing.
 *
 * The row a write produces is judged too, as a value, against the rows as
 * they stand before the write, inside the statement that writes it (R4): a
 * created row at `place` (a model naming none is not judged on create); an
 * updated row at the predicates that judged its old row, and, for each field
 * its data writes, at that field's `moves` entry, and where it writes the
 * key of an `acyclic` relation (a to-one relation of the model to itself),
 * outside its own subtree. `acyclic` may be a function returning that list:
 * it is called the first time an update writes the key of one of the
 * model's self relations. A refused row is written by no statement.
 *
 * `evidence` declares a projection key (`evidence.as`) a `select` or
 * `include` may name at every depth, on reads and on the rows a write
 * returns: per row, whether each of `names` holds there beside `read`.
 * `reads` gates a field on a predicate: the row carries it only where
 * `read` and that predicate hold, a `select` naming it fails on a row
 * without them, and every operand a call writes over it (`where`, `orderBy`,
 * aggregates, `distinct`, unique lookups, relation filters) reads it as
 * absent there. A key or foreign-key field is never gated.
 */
export type RowsVerbs = {
  readonly predicates: { readonly [name: string]: ScalarFields };
  readonly read?: string;
  readonly update?: string;
  readonly delete?: string;
  readonly writes?: { readonly [field: string]: string };
  readonly place?: string;
  readonly moves?: { readonly [field: string]: string };
  readonly acyclic?: readonly string[] | (() => readonly string[]);
  readonly evidence?: {
    readonly as: string;
    readonly names: readonly string[];
  };
  readonly reads?: { readonly [field: string]: string };
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
      readonly [Name in keyof Controls as Controls[Name] extends {
        readonly bound: true;
      }
        ? never
        : Name]: PlaceControl<
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
// DATA STATE: the fields a chain's `data` writes, per model
// =============================================================================

/**
 * The fields one `data` entry writes on its models' creates: there they may
 * be left out even where the schema requires them. An update's fields need
 * nothing, as every field of an update is optional already.
 */
export interface StampedFields<Models = PropertyKey, Fields = PropertyKey> {
  readonly models: Models;
  readonly fields: Fields;
}

/** The fields a chain writes on every create of one model. */
export type StampedFieldNames<Data, ModelName> =
  Data extends StampedFields<infer Models, infer Fields extends PropertyKey>
    ? ModelName extends Models
      ? Fields
      : never
    : never;

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
