// Relation Class Implementation
// Clean class hierarchy for different relation types

import { type AnyModel } from "../model";
import { type SchemaNames } from "../fields/common";
import { getRelationSchemas } from "./schemas";

// Workaround to allow circular dependencies
export type Getter = () => any;
export type RelationType =
  | "oneToOne"
  | "oneToMany"
  | "manyToOne"
  | "manyToMany";
export type ReferentialAction = "cascade" | "setNull" | "restrict" | "noAction";

// =============================================================================
// RELATION INTERNALS (exposed via ~)
// =============================================================================
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
  getter: Getter;
}

// =============================================================================
// BASE RELATION (shared logic)
// =============================================================================

export class Relation<State extends RelationState> {
  private _state: State;
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(state: State) {
    this._state = state;
  }

  get "~"() {
    return {
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
  relation: Relation<RelationState>,
  sourceModelName: string,
  targetModelName: string
): string {
  return (
    relation["~"].state.through ||
    generateJunctionTableName(sourceModelName, targetModelName)
  );
}

export function getJunctionFieldNames(
  relation: Relation<RelationState>,
  sourceModelName: string,
  targetModelName: string
): [string, string] {
  const sourceFieldName =
    relation["~"].state.A || generateJunctionFieldName(sourceModelName);
  const targetFieldName =
    relation["~"].state.B || generateJunctionFieldName(targetModelName);
  return [sourceFieldName, targetFieldName];
}

export type AnyRelation = Relation<RelationState>;

export const relationBase = <
  G extends Getter,
  State extends Omit<RelationState, "getter">
>(
  getter: G,
  state: State
) => {
  return new Relation<State & { getter: G }>({ ...state, getter });
};

export const oneToOne = <G extends Getter>(
  getter: G,
  state?: Omit<RelationState, "type" | "through" | "A" | "B" | "getter">
) => {
  return relationBase(getter, { type: "oneToOne", ...state });
};

export const manyToOne = <G extends Getter>(
  getter: G,
  state?: Omit<RelationState, "type" | "through" | "A" | "B" | "getter">
) => {
  return relationBase(getter, { type: "manyToOne", ...state });
};

export const oneToMany = <G extends Getter>(
  getter: G,
  state?: Omit<RelationState, "type" | "through" | "A" | "B" | "getter">
) => {
  return relationBase(getter, { type: "oneToMany", ...state });
};

export const manyToMany = <G extends Getter>(
  getter: G,
  state?: Omit<RelationState, "type" | "getter">
) => {
  return relationBase(getter, { type: "manyToMany", ...state });
};
