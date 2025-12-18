// Relation Class Implementation
// Clean class hierarchy for different relation types

import { type AnyModel } from "../model";
import { type SchemaNames } from "../fields/common";
import { getRelationSchemas } from "./schemas";

export type Getter = () => AnyModel;
export type RelationType =
  | "oneToOne"
  | "oneToMany"
  | "manyToOne"
  | "manyToMany";
export type ReferentialAction = "cascade" | "setNull" | "restrict" | "noAction";

// =============================================================================
// RELATION INTERNALS (exposed via ~)
// =============================================================================

type UpdateState<
  State extends RelationState,
  Update extends Partial<RelationState>
> = State & Update;

export interface RelationState {
  type: RelationType;
  fields?: string[];
  references?: string[];
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  optional?: boolean;
  through?: string;
  A?: string;
  B?: string;
}

// =============================================================================
// BASE RELATION (shared logic)
// =============================================================================

export class Relation<State extends RelationState, G extends Getter> {
  private _state: State;
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};
  private _getter: G;

  constructor(state: State, getter: G) {
    this._state = state;
    this._getter = getter;
  }

  get "~"() {
    return {
      getter: this._getter,
      state: this._state,
      names: this._names,
      schemas: getRelationSchemas(this._state),
    };
  }
}

// =============================================================================
// HELPERS
// =============================================================================

export function generateJunctionTableName(
  model1: string,
  model2: string
): string {
  const names = [model1.toLowerCase(), model2.toLowerCase()].sort();
  return `${names[0]}_${names[1]}`;
}

export function generateJunctionFieldName(modelName: string): string {
  return `${modelName.toLowerCase()}Id`;
}

export function getJunctionTableName(
  relation: Relation<RelationState, Getter>,
  sourceModelName: string,
  targetModelName: string
): string {
  return (
    relation["~"].state.through ||
    generateJunctionTableName(sourceModelName, targetModelName)
  );
}

export function getJunctionFieldNames(
  relation: Relation<RelationState, Getter>,
  sourceModelName: string,
  targetModelName: string
): [string, string] {
  const sourceFieldName =
    relation["~"].state.A || generateJunctionFieldName(sourceModelName);
  const targetFieldName =
    relation["~"].state.B || generateJunctionFieldName(targetModelName);
  return [sourceFieldName, targetFieldName];
}

export type AnyRelation = Relation<RelationState, Getter>;

export const relationBase = <State extends RelationState, G extends Getter>(
  getter: G,
  state: State
) => {
  return new Relation<State, G>(state, getter);
};

export const oneToOne = <G extends Getter>(
  getter: G,
  state: Omit<RelationState, "type" | "through" | "throughA" | "throughB">
) => {
  return relationBase(getter, { type: "oneToOne", ...state });
};

export const manyToOne = <G extends Getter>(
  getter: G,
  state: Omit<RelationState, "type" | "through" | "throughA" | "throughB">
) => {
  return relationBase(getter, { type: "manyToOne", ...state });
};

export const oneToMany = <G extends Getter>(
  getter: G,
  state: Omit<RelationState, "type" | "through" | "throughA" | "throughB">
) => {
  return relationBase(getter, { type: "oneToMany", ...state });
};

export const manyToMany = <G extends Getter>(
  getter: G,
  state: Omit<RelationState, "type" | "through" | "throughA" | "throughB">
) => {
  return relationBase(getter, { type: "manyToMany", ...state });
};
