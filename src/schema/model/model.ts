// Model Class Implementation
// Defines database models with fields and relations

import { isField, type Field } from "../fields/base";
import { type SchemaNames } from "../fields/common";
import { AnyRelation, Relation } from "../relation/relation";
import { buildModelSchemas, type TypedModelSchemas } from "./runtime";
import type {
  FieldRecord,
  ScalarFieldKeys as _ScalarFieldKeys,
  ModelState,
  AnyModelState,
  DefaultModelState,
  CompoundConstraint,
} from "./types/helpers";

// Re-export types from helpers for external use
export type {
  ModelState,
  AnyModelState,
  DefaultModelState,
  ExtractFields,
  ExtractCompoundId,
  ExtractCompoundUniques,
  CompoundKeyName,
  CompoundConstraint,
  EffectiveKeyName,
} from "./types/helpers";

// Re-export ScalarFieldKeys for convenience
export type ScalarFieldKeys<T extends FieldRecord> = _ScalarFieldKeys<T> &
  string;

// =============================================================================
// TYPE INFERENCE HELPER
// =============================================================================

/**
 * Infers the TypeScript types for model fields
 * Only includes scalar fields, not relations
 */
type InferModelFields<TFields extends FieldRecord> = {
  [K in keyof TFields as TFields[K] extends Field
    ? K
    : never]: TFields[K] extends Field
    ? TFields[K]["~"]["schemas"]["base"]["infer"]
    : never;
};

// =============================================================================
// INDEX AND CONSTRAINT TYPES
// =============================================================================

export type IndexType = "btree" | "hash" | "gin" | "gist";

export interface IndexOptions {
  name?: string;
  unique?: boolean;
  type?: IndexType;
  where?: string; // For partial indexes (PostgreSQL)
}

export interface IndexDefinition {
  fields: string[];
  options: IndexOptions;
}

/** Options for compound primary key (@@id) */
export interface CompoundIdOptions {
  name?: string;
}

/** Options for compound unique constraint (@@unique) */
export interface CompoundUniqueOptions {
  name?: string;
}

// =============================================================================
// MODEL OPTIONS (internal)
// =============================================================================

type ModelOptions<
  TCompoundId extends CompoundConstraint | undefined,
  TCompoundUniques extends readonly CompoundConstraint[]
> = {
  tableName?: string | undefined;
  indexes?: IndexDefinition[];
  compoundId?: TCompoundId;
  compoundUniques?: TCompoundUniques;
};

// =============================================================================
// MODEL CLASS
// =============================================================================

/**
 * Model class with single State generic for future-proofing.
 * Use extraction helpers (ExtractFields, ExtractCompoundId, etc.) to access state parts.
 */
export class Model<State extends AnyModelState = ModelState> {
  // ---------------------------------------------------------------------------
  // Private state (exposed via ~)
  // ---------------------------------------------------------------------------
  private _fields: Map<string, Field> = new Map();
  private _relations: Map<string, AnyRelation> = new Map();
  private _tableName: string | undefined = undefined;
  private _indexes: IndexDefinition[] = [];
  private _compoundId: State["compoundId"] = undefined as State["compoundId"];
  private _compoundUniques: State["compoundUniques"] =
    [] as unknown as State["compoundUniques"];
  private _schemas?: TypedModelSchemas<State["fields"]>;
  /** Name slots hydrated by client at initialization */
  private _names: SchemaNames = {};

  constructor(
    private _fieldDefinitions: State["fields"],
    options?: ModelOptions<State["compoundId"], State["compoundUniques"]>
  ) {
    this.separateFieldsAndRelations(_fieldDefinitions);
    if (options) {
      this._tableName = options.tableName ?? undefined;
      this._indexes = options.indexes ?? [];
      this._compoundId = (options.compoundId ??
        undefined) as State["compoundId"];
      this._compoundUniques = (options.compoundUniques ??
        []) as unknown as State["compoundUniques"];
    }
  }

  private separateFieldsAndRelations(definitions: State["fields"]): void {
    for (const [key, definition] of Object.entries(definitions)) {
      if (isField(definition)) {
        this._fields.set(key, definition as Field);
      } else if (definition instanceof Relation) {
        this._relations.set(key, definition);
      } else {
        throw new Error(
          `Invalid field definition for '${key}'. Must be a Field or Relation instance.`
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Gets the model/table name (for display/error messages)
   * Returns tableName if set, otherwise "Model"
   */
  get name(): string {
    return this._tableName ?? "Model";
  }

  /**
   * Maps the model to a specific database table name
   */
  map(tableName: string): this {
    if (
      !tableName ||
      typeof tableName !== "string" ||
      tableName.trim() === ""
    ) {
      throw new Error("Table name must be a non-empty string");
    }
    this._tableName = tableName;
    return this;
  }

  /**
   * Adds an index on the specified field(s)
   */
  index(
    fields:
      | ScalarFieldKeys<State["fields"]>
      | ScalarFieldKeys<State["fields"]>[],
    options: IndexOptions = {}
  ): this {
    const fieldArray = Array.isArray(fields) ? fields : [fields];
    // Validation deferred to SchemaValidator (I001)
    this._indexes.push({
      fields: fieldArray,
      options,
    });
    return this;
  }

  /**
   * Defines a compound primary key (@@id in Prisma)
   * Use this when the primary key consists of multiple fields
   *
   * @example
   * const membership = s.model({
   *   orgId: s.string(),
   *   userId: s.string(),
   *   role: s.string(),
   * }).id(["orgId", "userId"]);
   *
   * // With custom constraint name
   * .id(["orgId", "userId"], { name: "membership_pk" });
   */
  id<
    const K extends readonly ScalarFieldKeys<State["fields"]>[],
    const N extends string | undefined = undefined
  >(
    fields: K,
    options?: { name?: N }
  ): Model<
    ModelState<
      State["fields"],
      CompoundConstraint<K, N>,
      State["compoundUniques"]
    >
  >;
  id<
    K extends ScalarFieldKeys<State["fields"]>,
    const N extends string | undefined = undefined
  >(
    fields: K,
    options?: { name?: N }
  ): Model<
    ModelState<
      State["fields"],
      CompoundConstraint<[K], N>,
      State["compoundUniques"]
    >
  >;
  id(
    fields:
      | ScalarFieldKeys<State["fields"]>
      | readonly ScalarFieldKeys<State["fields"]>[],
    options?: CompoundIdOptions
  ): Model<any> {
    const fieldArray = Array.isArray(fields) ? fields : [fields];
    return new Model(this._fieldDefinitions, {
      tableName: this._tableName,
      indexes: this._indexes,
      compoundId: { fields: fieldArray, name: options?.name },
      compoundUniques: this._compoundUniques,
    });
  }

  /**
   * Adds a compound unique constraint (@@unique in Prisma)
   * Use this when multiple fields together must be unique
   *
   * @example
   * const user = s.model({
   *   id: s.string().id(),
   *   email: s.string(),
   *   orgId: s.string(),
   * }).unique(["email", "orgId"]);
   *
   * // With custom constraint name
   * .unique(["email", "orgId"], { name: "user_email_org_unique" });
   */
  unique<
    const K extends readonly ScalarFieldKeys<State["fields"]>[],
    const N extends string | undefined = undefined
  >(
    fields: K,
    options?: { name?: N }
  ): Model<
    ModelState<
      State["fields"],
      State["compoundId"],
      [...State["compoundUniques"], CompoundConstraint<K, N>]
    >
  >;
  unique<
    K extends ScalarFieldKeys<State["fields"]>,
    const N extends string | undefined = undefined
  >(
    fields: K,
    options?: { name?: N }
  ): Model<
    ModelState<
      State["fields"],
      State["compoundId"],
      [...State["compoundUniques"], CompoundConstraint<[K], N>]
    >
  >;
  unique(
    fields:
      | ScalarFieldKeys<State["fields"]>
      | readonly ScalarFieldKeys<State["fields"]>[],
    options?: CompoundUniqueOptions
  ): Model<any> {
    const fieldArray = Array.isArray(fields) ? fields : [fields];
    const newUniques = [
      ...this._compoundUniques,
      { fields: fieldArray, name: options?.name },
    ];
    return new Model(this._fieldDefinitions, {
      tableName: this._tableName,
      indexes: this._indexes,
      compoundId: this._compoundId,
      compoundUniques: newUniques,
    });
  }

  /**
   * Extends the model with additional fields
   */
  extends<ETFields extends FieldRecord>(
    fields: ETFields
  ): Model<
    ModelState<
      State["fields"] & ETFields,
      State["compoundId"],
      State["compoundUniques"]
    >
  > {
    return new Model<
      ModelState<
        State["fields"] & ETFields,
        State["compoundId"],
        State["compoundUniques"]
      >
    >(
      { ...this._fieldDefinitions, ...fields },
      {
        tableName: this._tableName,
        indexes: this._indexes,
        compoundId: this._compoundId,
        compoundUniques: this._compoundUniques,
      }
    );
  }

  // ---------------------------------------------------------------------------
  // Internal namespace (~)
  // ---------------------------------------------------------------------------

  /**
   * Internal namespace for ORM internals
   * Not part of the public API - may change without notice
   */
  get "~"() {
    // Use a self reference for lazy schema access to avoid circular issues
    const self = this;

    return {
      /** Field definitions as passed to the model constructor */
      fields: this._fieldDefinitions,
      /** Map of scalar field names to Field instances */
      fieldMap: this._fields,
      /** Map of relation names to Relation instances */
      relations: this._relations,
      /** Database table name (set via .map()) */
      tableName: this._tableName,
      /** Index definitions */
      indexes: this._indexes,
      /** Compound primary key fields (@@id) - array of field names */
      compoundId: this._compoundId,
      /** Compound unique constraints (@@unique) - array of field name arrays */
      compoundUniques: this._compoundUniques,
      /** ArkType schemas for validation (lazily computed) */
      get schemas(): TypedModelSchemas<State["fields"]> {
        if (!self._schemas) {
          self._schemas = buildModelSchemas(self);
        }
        return self._schemas;
      },
      /** Inferred TypeScript type for model records */
      get infer() {
        return {} as InferModelFields<State["fields"]>;
      },
      /** Name slots hydrated by client at initialization */
      names: this._names,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Creates a new model with the given fields
 *
 * Relations use a builder pattern with config-first, getter-last:
 * s.relation.fields("authorId").references("id").manyToOne(() => user)
 *
 * @example
 * const user = s.model({
 *   id: s.string().id().ulid(),
 *   name: s.string(),
 *   posts: s.relation.oneToMany(() => post),
 * }).map("users");
 *
 * const post = s.model({
 *   id: s.string().id().ulid(),
 *   authorId: s.string(),
 *   author: s.relation.fields("authorId").references("id").manyToOne(() => user),
 * }).map("posts");
 *
 * // With compound primary key
 * const membership = s.model({
 *   orgId: s.string(),
 *   userId: s.string(),
 *   role: s.string(),
 * }).id(["orgId", "userId"]);
 */
export const model = <const TFields extends FieldRecord>(
  fields: TFields
): Model<DefaultModelState<TFields>> => new Model(fields);
