// Relation Types and Shared Interfaces

/** Workaround to allow circular dependencies */
export type Getter = () => any;

/** Relation cardinality types */
export type RelationType =
  | "oneToOne"
  | "oneToMany"
  | "manyToOne"
  | "manyToMany";

/** Referential action for foreign key constraints */
export type ReferentialAction = "cascade" | "setNull" | "restrict" | "noAction";

// =============================================================================
// RELATION STATE
// =============================================================================

/**
 * Unified relation state interface
 * All properties are optional except type and getter
 * Specific relation types will only use relevant properties
 */
export interface RelationState {
  type: RelationType;
  getter: Getter;
  name?: string;
  // ToOne properties (oneToOne, manyToOne)
  fields?: string[];
  references?: string[];
  optional?: boolean;
  // Referential actions (ToOne and ManyToMany)
  onDelete?: ReferentialAction;
  onUpdate?: ReferentialAction;
  // ManyToMany properties
  through?: string;
  A?: string;
  B?: string;
}

/** State for ToOne relations (oneToOne, manyToOne) */
export interface ToOneRelationState extends RelationState {
  type: "oneToOne" | "manyToOne";
}

/** State for ToMany relations (oneToMany) */
export interface ToManyRelationState extends RelationState {
  type: "oneToMany";
}

/** State for ManyToMany relations */
export interface ManyToManyRelationState extends RelationState {
  type: "manyToMany";
}
