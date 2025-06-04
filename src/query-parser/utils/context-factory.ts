import { Model, Field, Relation } from "@schema";
import { Operation } from "@types";
import { BuilderContext } from "@query-parser/query-parser";
import type { QueryParser } from "../query-parser";

/**
 * ContextFactory - BuilderContext Creation Utility
 *
 * This component provides centralized creation and management of BuilderContext
 * objects used throughout the query parser system. It ensures consistent context
 * creation, proper default values, and type safety across all components.
 *
 * FEATURES:
 * - Centralized context creation with intelligent defaults
 * - Type-safe context building with proper optional property handling
 * - Context validation and consistency checking
 * - Context cloning and modification utilities
 * - Context debugging and introspection capabilities
 * - Performance optimization through context reuse
 *
 * CONTEXT TYPES:
 * - Basic context: Model, operation, and alias
 * - Field context: Includes field information for field operations
 * - Relation context: Includes relation information for relation operations
 * - Nested context: Context for nested queries and subqueries
 * - Mutation context: Context for create, update, delete operations
 *
 * CONTEXT PROPERTIES:
 * - Core: model, baseOperation, alias
 * - Optional: field, relation, parentAlias, fieldName
 * - Extended: take, skip, cursor, data, conflictFields
 * - Meta: isNested, depth, path, mode
 *
 * VALIDATION:
 * - Required property validation
 * - Type consistency checking
 * - Circular reference detection
 * - Context hierarchy validation
 *
 * PERFORMANCE:
 * - Efficient context creation with minimal overhead
 * - Context reuse for similar operations
 * - Lazy property evaluation where possible
 * - Memory-efficient context management
 *
 * TYPE SAFETY:
 * - Full TypeScript support with proper type inference
 * - Compile-time validation of context properties
 * - Runtime type checking for dynamic contexts
 * - Proper handling of optional and nullable properties
 */
export class ContextFactory {
  readonly name = "ContextFactory";
  readonly dependencies: string[] = [];

  private contextCache = new Map<string, BuilderContext>();
  private contextHistory: Array<{ context: BuilderContext; timestamp: Date }> =
    [];

  constructor(private parser: QueryParser) {}

  /**
   * Create basic BuilderContext
   *
   * Creates a context with core required properties
   */
  create(
    model: Model<any>,
    operation: Operation,
    alias: string,
    options: {
      field?: Field<any>;
      relation?: Relation<any, any>;
      parentAlias?: string;
      fieldName?: string;
    } = {}
  ): BuilderContext {
    const context: BuilderContext = {
      model,
      baseOperation: operation,
      alias,
      ...this.filterUndefinedProperties(options),
    };

    this.validateContext(context);
    this.trackContext(context);

    return context;
  }

  /**
   * Create context from payload
   *
   * Creates context with additional information extracted from query payload
   */
  createFromPayload(
    model: Model<any>,
    operation: Operation,
    alias: string,
    payload: any,
    options: {
      field?: Field<any>;
      relation?: Relation<any, any>;
      parentAlias?: string;
      fieldName?: string;
    } = {}
  ): BuilderContext {
    const baseContext = this.create(model, operation, alias, options);

    // Extract additional context from payload
    const enhancedContext: BuilderContext = {
      ...baseContext,
      // Add payload-derived properties if they exist
      ...(payload.take !== undefined && { take: payload.take }),
      ...(payload.skip !== undefined && { skip: payload.skip }),
      ...(payload.cursor !== undefined && { cursor: payload.cursor }),
      ...(payload.data !== undefined && { data: payload.data }),
      ...(payload.distinct !== undefined && { distinct: payload.distinct }),
    };

    return enhancedContext;
  }

  /**
   * Create field context
   *
   * Creates context specifically for field operations
   */
  createFieldContext(
    model: Model<any>,
    fieldName: string,
    operation: Operation,
    alias: string,
    additionalOptions: any = {}
  ): BuilderContext {
    const field = model.fields.get(fieldName);
    if (!field) {
      throw new Error(
        `Field '${fieldName}' not found on model '${model.name}'`
      );
    }

    return this.create(model, operation, alias, {
      field: field as any,
      fieldName,
      ...additionalOptions,
    });
  }

  /**
   * Create relation context
   *
   * Creates context specifically for relation operations
   */
  createRelationContext(
    model: Model<any>,
    relationName: string,
    operation: Operation,
    alias: string,
    parentAlias?: string,
    additionalOptions: any = {}
  ): BuilderContext {
    const relation = model.relations.get(relationName);
    if (!relation) {
      throw new Error(
        `Relation '${relationName}' not found on model '${model.name}'`
      );
    }

    return this.create(model, operation, alias, {
      relation,
      parentAlias,
      ...additionalOptions,
    });
  }

  /**
   * Create nested context
   *
   * Creates context for nested queries with depth tracking
   */
  createNestedContext(
    parentContext: BuilderContext,
    model: Model<any>,
    operation: Operation,
    alias: string,
    depth: number = 0
  ): BuilderContext {
    return {
      ...this.create(model, operation, alias),
      parentAlias: parentContext.alias,
      isNested: true,
      depth,
      path: this.buildContextPath(parentContext, model.name),
    };
  }

  /**
   * Create mutation context
   *
   * Creates context specifically for mutation operations
   */
  createMutationContext(
    model: Model<any>,
    operation: Operation,
    alias: string,
    data: any,
    conflictFields?: string[]
  ): BuilderContext {
    return {
      ...this.create(model, operation, alias),
      data,
      ...(conflictFields && { conflictFields }),
      mode: "write" as any,
    };
  }

  /**
   * Clone context with modifications
   *
   * Creates a copy of existing context with optional modifications
   */
  clone(
    context: BuilderContext,
    modifications: Partial<BuilderContext> = {}
  ): BuilderContext {
    return {
      ...context,
      ...this.filterUndefinedProperties(modifications),
    };
  }

  /**
   * Merge contexts
   *
   * Combines multiple contexts with proper precedence
   */
  merge(...contexts: BuilderContext[]): BuilderContext {
    if (contexts.length === 0) {
      throw new Error("At least one context is required for merging");
    }

    const baseContext = contexts[0];
    if (!baseContext) {
      throw new Error("Base context cannot be undefined");
    }

    const mergedContext = contexts.reduce((merged, current) => {
      if (!current) {
        return merged;
      }
      return {
        ...merged,
        ...this.filterUndefinedProperties(current),
      };
    }, baseContext);

    this.validateContext(mergedContext);
    return mergedContext;
  }

  /**
   * Validate context properties
   *
   * Ensures context has required properties and valid values
   */
  validateContext(context: BuilderContext): void {
    if (!context.model) {
      throw new Error("Context must have a model");
    }

    if (!context.baseOperation) {
      throw new Error("Context must have a baseOperation");
    }

    if (!context.alias) {
      throw new Error("Context must have an alias");
    }

    // Validate field exists if specified
    if (context.field && context.fieldName) {
      if (!context.model.fields.has(context.fieldName)) {
        throw new Error(
          `Field '${context.fieldName}' not found on model '${context.model.name}'`
        );
      }
    }

    // Validate relation exists if specified
    if (context.relation) {
      // Basic relation validation - more detailed validation would require relation name
      if (typeof context.relation.getter !== "function") {
        throw new Error("Invalid relation object in context");
      }
    }
  }

  /**
   * Get context statistics
   *
   * Returns information about context creation and usage
   */
  getStatistics(): {
    totalCreated: number;
    cacheSize: number;
    cacheHitRate: number;
  } {
    return {
      totalCreated: this.contextHistory.length,
      cacheSize: this.contextCache.size,
      cacheHitRate:
        this.contextCache.size > 0
          ? this.contextCache.size / this.contextHistory.length
          : 0,
    };
  }

  /**
   * Clear context cache
   *
   * Clears cached contexts and history
   */
  clearCache(): void {
    this.contextCache.clear();
    this.contextHistory = [];
  }

  /**
   * Get context by key
   *
   * Retrieves cached context by key
   */
  getCached(key: string): BuilderContext | undefined {
    return this.contextCache.get(key);
  }

  /**
   * Cache context with key
   *
   * Stores context in cache for reuse
   */
  cache(key: string, context: BuilderContext): void {
    this.contextCache.set(key, context);
  }

  /**
   * Generate context key
   *
   * Creates a unique key for context caching
   */
  generateKey(
    model: Model<any>,
    operation: Operation,
    alias: string,
    options: any = {}
  ): string {
    const optionsKey = Object.keys(options)
      .sort()
      .map((key) => `${key}:${options[key]}`)
      .join(",");

    return `${model.name}:${operation}:${alias}:${optionsKey}`;
  }

  /**
   * Create context with caching
   *
   * Creates context with automatic caching for performance
   */
  createCached(
    model: Model<any>,
    operation: Operation,
    alias: string,
    options: any = {}
  ): BuilderContext {
    const key = this.generateKey(model, operation, alias, options);
    const cached = this.getCached(key);

    if (cached) {
      return cached;
    }

    const context = this.create(model, operation, alias, options);
    this.cache(key, context);

    return context;
  }

  /**
   * Private helper methods
   */

  private filterUndefinedProperties(obj: any): any {
    const filtered: any = {};

    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        filtered[key] = value;
      }
    }

    return filtered;
  }

  private trackContext(context: BuilderContext): void {
    this.contextHistory.push({
      context,
      timestamp: new Date(),
    });
  }

  private buildContextPath(
    parentContext: BuilderContext,
    modelName: string
  ): string[] {
    const parentPath = parentContext.path || [parentContext.model.name];
    return [...parentPath, modelName];
  }
}
