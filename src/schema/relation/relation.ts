// Relation Class Implementation
// Clean class hierarchy for different relation types

import { Model } from "../model";
import { type SchemaNames } from "../fields/common";
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
  readonly fields?: string[] | undefined;
  readonly references?: string[] | undefined;
  readonly onDelete?: ReferentialAction | undefined;
  readonly onUpdate?: ReferentialAction | undefined;
  // ManyToMany only
  readonly through?: string | undefined;
  readonly throughA?: string | undefined;
  readonly throughB?: string | undefined;
  // Name slots hydrated by client at initialization
  readonly names: SchemaNames;
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
  protected _fields?: string[];
  protected _references?: string[];
  protected _onDelete?: ReferentialAction;
  protected _onUpdate?: ReferentialAction;
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(
    protected readonly _getter: G,
    protected readonly _relationType: T
  ) {}

  /** FK field(s) on the current model */
  fields(...fieldNames: string[]): this {
    this._fields = fieldNames;
    return this;
  }

  /** Field(s) on the target model being referenced */
  references(...fieldNames: string[]): this {
    this._references = fieldNames;
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
      names: this._names,
      infer: {} as any,
    };
  }

  abstract get "~"(): RelationInternals<G, T, TOptional>;
}

// =============================================================================
// TO-ONE RELATIONS (oneToOne, manyToOne) - can be optional
// =============================================================================

export class ToOneRelation<
  const G extends Getter,
  T extends "oneToOne" | "manyToOne",
  TOptional extends boolean = false
> extends Relation<G, T, TOptional> {
  private _optional: boolean = false;

  /** Mark relation as optional (allows null) */
  optional(): ToOneRelation<G, T, true> {
    const rel = new ToOneRelation<G, T, true>(this._getter, this._relationType);
    if (this._fields) rel._fields = [...this._fields];
    if (this._references) rel._references = [...this._references];
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
// RELATION BUILDER (getter-last pattern)
// =============================================================================

/**
 * RelationBuilder class for defining relations with config-first, getter-last pattern.
 *
 * This pattern avoids TypeScript circular reference issues because:
 * 1. Config methods (fields, references, etc.) return `this` - no generics involved
 * 2. Terminal methods (oneToOne, manyToOne, etc.) introduce the generic LAST
 * 3. Since there's no more chaining after the terminal method, TypeScript doesn't
 *    need to resolve the generic to enable further method calls
 *
 * @example
 * const user = s.model({
 *   posts: s.relation.oneToMany(() => post),
 *   profile: s.relation.optional().oneToOne(() => profile),
 * });
 * const post = s.model({
 *   author: s.relation.fields("authorId").references("id").manyToOne(() => user),
 * });
 */
export class RelationBuilderImpl {
  private _fields?: string[];
  private _references?: string[];
  private _onDelete?: ReferentialAction;
  private _onUpdate?: ReferentialAction;
  private _optional: boolean = false;
  // ManyToMany specific
  private _through?: string;
  private _throughA?: string;
  private _throughB?: string;

  /** FK field(s) on the current model */
  fields(...names: string[]): RelationBuilderImpl {
    const builder = new RelationBuilderImpl();
    builder._fields = names;
    builder._references = this._references;
    builder._onDelete = this._onDelete;
    builder._onUpdate = this._onUpdate;
    builder._optional = this._optional;
    builder._through = this._through;
    builder._throughA = this._throughA;
    builder._throughB = this._throughB;
    return builder;
  }

  /** Field(s) on the target model being referenced */
  references(...names: string[]): RelationBuilderImpl {
    const builder = new RelationBuilderImpl();
    builder._fields = this._fields;
    builder._references = names;
    builder._onDelete = this._onDelete;
    builder._onUpdate = this._onUpdate;
    builder._optional = this._optional;
    builder._through = this._through;
    builder._throughA = this._throughA;
    builder._throughB = this._throughB;
    return builder;
  }

  /** Action when referenced row is deleted */
  onDelete(action: ReferentialAction): RelationBuilderImpl {
    const builder = new RelationBuilderImpl();
    builder._fields = this._fields;
    builder._references = this._references;
    builder._onDelete = action;
    builder._onUpdate = this._onUpdate;
    builder._optional = this._optional;
    builder._through = this._through;
    builder._throughA = this._throughA;
    builder._throughB = this._throughB;
    return builder;
  }

  /** Action when referenced row is updated */
  onUpdate(action: ReferentialAction): RelationBuilderImpl {
    const builder = new RelationBuilderImpl();
    builder._fields = this._fields;
    builder._references = this._references;
    builder._onDelete = this._onDelete;
    builder._onUpdate = action;
    builder._optional = this._optional;
    builder._through = this._through;
    builder._throughA = this._throughA;
    builder._throughB = this._throughB;
    return builder;
  }

  /** Mark relation as optional (allows null) - only for to-one relations */
  optional(): RelationBuilderImpl {
    const builder = new RelationBuilderImpl();
    builder._fields = this._fields;
    builder._references = this._references;
    builder._onDelete = this._onDelete;
    builder._onUpdate = this._onUpdate;
    builder._optional = true;
    builder._through = this._through;
    builder._throughA = this._throughA;
    builder._throughB = this._throughB;
    return builder;
  }

  /** Junction table name (many-to-many only) */
  through(tableName: string): RelationBuilderImpl {
    const builder = new RelationBuilderImpl();
    builder._fields = this._fields;
    builder._references = this._references;
    builder._onDelete = this._onDelete;
    builder._onUpdate = this._onUpdate;
    builder._optional = this._optional;
    builder._through = tableName;
    builder._throughA = this._throughA;
    builder._throughB = this._throughB;
    return builder;
  }

  /** Junction table FK column for source model (many-to-many only) */
  A(fieldName: string): RelationBuilderImpl {
    const builder = new RelationBuilderImpl();
    builder._fields = this._fields;
    builder._references = this._references;
    builder._onDelete = this._onDelete;
    builder._onUpdate = this._onUpdate;
    builder._optional = this._optional;
    builder._through = this._through;
    builder._throughA = fieldName;
    builder._throughB = this._throughB;
    return builder;
  }

  /** Junction table FK column for target model (many-to-many only) */
  B(fieldName: string): RelationBuilderImpl {
    const builder = new RelationBuilderImpl();
    builder._fields = this._fields;
    builder._references = this._references;
    builder._onDelete = this._onDelete;
    builder._onUpdate = this._onUpdate;
    builder._optional = this._optional;
    builder._through = this._through;
    builder._throughA = this._throughA;
    builder._throughB = fieldName;
    return builder;
  }

  // ===========================================================================
  // TERMINAL METHODS - These introduce the generic and finalize the relation
  // ===========================================================================

  /** Create a one-to-one relation */
  oneToOne<G extends Getter>(
    getter: G
  ): ToOneRelation<
    G,
    "oneToOne",
    typeof this._optional extends true ? true : false
  > {
    const rel = this._optional
      ? new ToOneRelation<G, "oneToOne", true>(getter, "oneToOne")
      : new ToOneRelation<G, "oneToOne", false>(getter, "oneToOne");
    if (this._fields) rel._fields = this._fields;
    if (this._references) rel._references = this._references;
    if (this._onDelete) rel._onDelete = this._onDelete;
    if (this._onUpdate) rel._onUpdate = this._onUpdate;
    (rel as any)._optional = this._optional;
    return rel as any;
  }

  /** Create a many-to-one relation */
  manyToOne<G extends Getter>(
    getter: G
  ): ToOneRelation<
    G,
    "manyToOne",
    typeof this._optional extends true ? true : false
  > {
    const rel = this._optional
      ? new ToOneRelation<G, "manyToOne", true>(getter, "manyToOne")
      : new ToOneRelation<G, "manyToOne", false>(getter, "manyToOne");
    if (this._fields) rel._fields = this._fields;
    if (this._references) rel._references = this._references;
    if (this._onDelete) rel._onDelete = this._onDelete;
    if (this._onUpdate) rel._onUpdate = this._onUpdate;
    (rel as any)._optional = this._optional;
    return rel as any;
  }

  /** Create a one-to-many relation */
  oneToMany<G extends Getter>(getter: G): OneToManyRelation<G> {
    const rel = new OneToManyRelation<G>(getter);
    if (this._fields) rel._fields = this._fields;
    if (this._references) rel._references = this._references;
    if (this._onDelete) rel._onDelete = this._onDelete;
    if (this._onUpdate) rel._onUpdate = this._onUpdate;
    return rel;
  }

  /** Create a many-to-many relation */
  manyToMany<G extends Getter>(getter: G): ManyToManyRelation<G> {
    const rel = new ManyToManyRelation<G>(getter);
    if (this._fields) rel._fields = this._fields;
    if (this._references) rel._references = this._references;
    if (this._onDelete) rel._onDelete = this._onDelete;
    if (this._onUpdate) rel._onUpdate = this._onUpdate;
    if (this._through) (rel as any)._through = this._through;
    if (this._throughA) (rel as any)._throughA = this._throughA;
    if (this._throughB) (rel as any)._throughB = this._throughB;
    return rel;
  }
}

/**
 * Relation builder entry point.
 * Always creates a fresh builder instance to avoid state pollution.
 *
 * @example
 * // Simple relation
 * posts: s.relation.oneToMany(() => post)
 *
 * // With FK config
 * author: s.relation.fields("authorId").references("id").manyToOne(() => user)
 *
 * // Optional relation
 * profile: s.relation.optional().oneToOne(() => profile)
 *
 * // Many-to-many with junction
 * tags: s.relation.through("post_tags").A("postId").B("tagId").manyToMany(() => tag)
 */
export const relation = new Proxy({} as RelationBuilderImpl, {
  get(_target, prop) {
    // Always create a fresh builder for each property access
    const builder = new RelationBuilderImpl();
    const value = (builder as any)[prop];
    if (typeof value === "function") {
      return value.bind(builder);
    }
    return value;
  },
});

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

export type AnyRelation =
  | ToOneRelation<any, any, any>
  | OneToManyRelation<any>
  | ManyToManyRelation<any>;
