// Relation Class Implementation
// Clean class hierarchy for different relation types

import { Model } from "../model";
import { Simplify } from "../../types/utilities.js";

export type Getter = () => Model<any>;
export type RelationType =
  | "oneToOne"
  | "oneToMany"
  | "manyToOne"
  | "manyToMany";
export type ReferentialAction = "cascade" | "setNull" | "restrict" | "noAction";

// =============================================================================
// RELATION INTERNALS (exposed via ~)
// =============================================================================

export interface RelationInternals<
  G extends Getter,
  T extends RelationType,
  TOptional extends boolean = false
> {
  readonly getter: G;
  readonly relationType: T;
  readonly isToMany: boolean;
  readonly isToOne: boolean;
  readonly isOptional: TOptional;
  readonly fields?: string | undefined;
  readonly references?: string | undefined;
  readonly onDelete?: ReferentialAction | undefined;
  readonly onUpdate?: ReferentialAction | undefined;
  // ManyToMany only
  readonly through?: string | undefined;
  readonly throughA?: string | undefined;
  readonly throughB?: string | undefined;
  // Type inference
  readonly infer: G extends () => infer M
    ? M extends Model<any>
      ? T extends "oneToMany" | "manyToMany"
        ? Simplify<M["~"]["infer"]>[]
        : TOptional extends true
        ? Simplify<M["~"]["infer"]> | null
        : Simplify<M["~"]["infer"]>
      : never
    : never;
}

// =============================================================================
// BASE RELATION (shared logic)
// =============================================================================

export abstract class Relation<
  G extends Getter,
  T extends RelationType,
  TOptional extends boolean = false
> {
  protected _fields?: string;
  protected _references?: string;
  protected _onDelete?: ReferentialAction;
  protected _onUpdate?: ReferentialAction;

  constructor(
    protected readonly _getter: G,
    protected readonly _relationType: T
  ) {}

  /** FK field on the current model */
  fields(fieldName: string): this {
    this._fields = fieldName;
    return this;
  }

  /** Field on the target model being referenced */
  references(fieldName: string): this {
    this._references = fieldName;
    return this;
  }

  /** Action when referenced row is deleted */
  onDelete(action: ReferentialAction): this {
    this._onDelete = action;
    return this;
  }

  /** Action when referenced row is updated */
  onUpdate(action: ReferentialAction): this {
    this._onUpdate = action;
    return this;
  }

  protected buildInternals(): RelationInternals<G, T, TOptional> {
    const self = this;
    return {
      getter: this._getter,
      relationType: this._relationType,
      get isToMany() {
        return (
          self._relationType === "oneToMany" ||
          self._relationType === "manyToMany"
        );
      },
      get isToOne() {
        return (
          self._relationType === "oneToOne" ||
          self._relationType === "manyToOne"
        );
      },
      isOptional: false as TOptional,
      fields: this._fields,
      references: this._references,
      onDelete: this._onDelete,
      onUpdate: this._onUpdate,
      through: undefined,
      throughA: undefined,
      throughB: undefined,
      infer: {} as any,
    };
  }

  abstract get "~"(): RelationInternals<G, T, TOptional>;
}

// =============================================================================
// TO-ONE RELATIONS (oneToOne, manyToOne) - can be optional
// =============================================================================

export class ToOneRelation<
  G extends Getter,
  T extends "oneToOne" | "manyToOne",
  TOptional extends boolean = false
> extends Relation<G, T, TOptional> {
  private _optional: boolean = false;

  /** Mark relation as optional (allows null) */
  optional(): ToOneRelation<G, T, true> {
    const rel = new ToOneRelation<G, T, true>(this._getter, this._relationType);
    if (this._fields) rel._fields = this._fields;
    if (this._references) rel._references = this._references;
    if (this._onDelete) rel._onDelete = this._onDelete;
    if (this._onUpdate) rel._onUpdate = this._onUpdate;
    rel._optional = true;
    return rel;
  }

  get "~"(): RelationInternals<G, T, TOptional> {
    const base = this.buildInternals();
    return {
      ...base,
      isOptional: this._optional as TOptional,
    };
  }
}

// =============================================================================
// ONE-TO-MANY RELATION - no optional, no through
// =============================================================================

export class OneToManyRelation<G extends Getter> extends Relation<
  G,
  "oneToMany",
  false
> {
  constructor(getter: G) {
    super(getter, "oneToMany");
  }

  get "~"(): RelationInternals<G, "oneToMany", false> {
    return this.buildInternals();
  }
}

// =============================================================================
// MANY-TO-MANY RELATION - has through, A, B
// =============================================================================

export class ManyToManyRelation<G extends Getter> extends Relation<
  G,
  "manyToMany",
  false
> {
  private _through?: string;
  private _throughA?: string;
  private _throughB?: string;

  constructor(getter: G) {
    super(getter, "manyToMany");
  }

  /** Junction table name */
  through(tableName: string): this {
    this._through = tableName;
    return this;
  }

  /** Junction table FK column for source model */
  A(fieldName: string): this {
    this._throughA = fieldName;
    return this;
  }

  /** Junction table FK column for target model */
  B(fieldName: string): this {
    this._throughB = fieldName;
    return this;
  }

  get "~"(): RelationInternals<G, "manyToMany", false> {
    const base = this.buildInternals();
    return {
      ...base,
      through: this._through,
      throughA: this._throughA,
      throughB: this._throughB,
    };
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

export const oneToOne = <G extends Getter>(getter: G) =>
  new ToOneRelation<G, "oneToOne">(getter, "oneToOne");

export const oneToMany = <G extends Getter>(getter: G) =>
  new OneToManyRelation<G>(getter);

export const manyToOne = <G extends Getter>(getter: G) =>
  new ToOneRelation<G, "manyToOne">(getter, "manyToOne");

export const manyToMany = <G extends Getter>(getter: G) =>
  new ManyToManyRelation<G>(getter);

// Legacy: s.relation().oneToOne() style
export function relation() {
  return { oneToOne, oneToMany, manyToOne, manyToMany };
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
  relation: Relation<any, any, any>,
  sourceModelName: string,
  targetModelName: string
): string {
  return (
    relation["~"].through ||
    generateJunctionTableName(sourceModelName, targetModelName)
  );
}

export function getJunctionFieldNames(
  relation: Relation<any, any, any>,
  sourceModelName: string,
  targetModelName: string
): [string, string] {
  const sourceFieldName =
    relation["~"].throughA || generateJunctionFieldName(sourceModelName);
  const targetFieldName =
    relation["~"].throughB || generateJunctionFieldName(targetModelName);
  return [sourceFieldName, targetFieldName];
}
