import type {
  CacheableOperations,
  MutationOperations,
  Operations,
} from "@client/types";
import type { StandardSchemaV1 } from "@standard-schema/spec";

// =============================================================================
// DEFINITION MEMBERS: plain data, whose names are checked when applied
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
 * when absent). A value held in a variable keeps its literal type only with
 * `as const`, as a held enum clause does.
 */
export type ControlDeclaration = (
  | { readonly oneOf: readonly (string | number | boolean)[] }
  | { readonly schema: StandardSchemaV1 }
) & { readonly on?: ControlPlacement };

export type ControlsContribution = {
  readonly [name: string]: ControlDeclaration;
};

/** Constant scalar `where` or `data` fields of one model. */
type ScalarFields = { readonly [field: string]: unknown };

/**
 * Which rows an operation sees. `control` names the call argument that picks
 * a mode; every model entry declares the same mode names, `default` among
 * them. `root` filters the call's own candidates, `related` rows reached
 * through a relation.
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
