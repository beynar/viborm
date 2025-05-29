// Ordering Parser for BaseORM
// Handles ORDER BY operations and converts them to AST

import {
  OrderingAST,
  OrderingTarget,
  FieldOrderingTarget,
  RelationOrderingTarget,
  AggregateOrderingTarget,
  ModelReference,
  FieldReference,
  RelationReference,
  ParseError,
} from "./ast";
import { FieldResolver } from "./field-resolver";

// ================================
// Type Guards
// ================================

function isFieldReference(
  ref: FieldReference | RelationReference
): ref is FieldReference {
  return "field" in ref;
}

function isRelationReference(
  ref: FieldReference | RelationReference
): ref is RelationReference {
  return "relation" in ref;
}

// ================================
// Ordering Parser
// ================================

export class OrderingParser {
  constructor(private fieldResolver: FieldResolver) {}

  /**
   * Parses ORDER BY clauses from Prisma-like syntax to AST
   */
  parseOrderBy(orderBy: any, model: ModelReference): OrderingAST[] {
    if (!orderBy) {
      return [];
    }

    // Handle single order object
    if (!Array.isArray(orderBy)) {
      return this.parseOrderByArray([orderBy], model);
    }

    return this.parseOrderByArray(orderBy, model);
  }

  /**
   * Parses an array of order by clauses
   */
  private parseOrderByArray(
    orderByArray: any[],
    model: ModelReference
  ): OrderingAST[] {
    const orderings: OrderingAST[] = [];

    for (const orderItem of orderByArray) {
      if (typeof orderItem === "string") {
        // Simple field name with default ascending order
        const resolved = this.fieldResolver.resolveFieldPath(model.name, [
          orderItem,
        ]);
        if (isFieldReference(resolved)) {
          orderings.push({
            type: "ORDERING",
            target: {
              type: "FIELD",
              field: resolved,
            } as FieldOrderingTarget,
            direction: "asc",
          });
        }
      } else if (typeof orderItem === "object" && orderItem !== null) {
        // Object with field/direction pairs
        for (const [key, direction] of Object.entries(orderItem)) {
          try {
            const ordering = this.parseOrderByField(key, direction, model);
            if (ordering) {
              orderings.push(ordering);
            }
          } catch (error) {
            if (error instanceof ParseError) {
              throw error;
            }
            throw new ParseError(
              `Failed to parse orderBy field '${key}': ${error}`,
              {
                model: model.name,
                field: key,
              }
            );
          }
        }
      }
    }

    return orderings;
  }

  /**
   * Parses a single order by field
   */
  private parseOrderByField(
    fieldPath: string,
    direction: any,
    model: ModelReference
  ): OrderingAST | null {
    const pathParts = fieldPath.split(".");

    // Handle aggregate functions
    const firstPart = pathParts[0];
    if (firstPart && this.isAggregateFunction(firstPart)) {
      return this.parseAggregateOrdering(pathParts, direction, model);
    }

    try {
      const resolved = this.fieldResolver.resolveFieldPath(
        model.name,
        pathParts
      );

      if (isFieldReference(resolved)) {
        const nullsHandling = this.parseNullsHandling(direction);
        const orderingAST: OrderingAST = {
          type: "ORDERING",
          target: {
            type: "FIELD",
            field: resolved,
          } as FieldOrderingTarget,
          direction: this.parseDirection(direction),
        };

        // Only add nulls property if it's defined
        if (nullsHandling !== undefined) {
          orderingAST.nulls = nullsHandling;
        }

        return orderingAST;
      } else if (isRelationReference(resolved)) {
        // Handle relation ordering (complex case)
        return this.parseRelationOrdering(resolved, direction);
      }
    } catch (error) {
      if (error instanceof ParseError) {
        throw error;
      }
      throw new ParseError(`Failed to resolve field path '${fieldPath}'`, {
        model: model.name,
        field: fieldPath,
      });
    }

    return null;
  }

  /**
   * Parses relation ordering (ordering by related fields)
   */
  private parseRelationOrdering(
    relation: RelationReference,
    direction: any
  ): OrderingAST {
    const target: RelationOrderingTarget = {
      type: "RELATION",
      relation,
    };

    // If direction is an object, it might contain nested ordering
    if (typeof direction === "object" && direction !== null) {
      // For now, handle simple nested ordering
      // This could be expanded for more complex cases
      target.nested = {
        type: "ORDERING",
        target: {
          type: "FIELD",
          field: relation as any, // This would need proper handling
        } as FieldOrderingTarget,
        direction: "asc",
      };
    }

    const nullsHandling = this.parseNullsHandling(direction);
    const orderingAST: OrderingAST = {
      type: "ORDERING",
      target,
      direction: this.parseDirection(direction),
    };

    // Only add nulls property if it's defined
    if (nullsHandling !== undefined) {
      orderingAST.nulls = nullsHandling;
    }

    return orderingAST;
  }

  /**
   * Parses aggregate ordering (count, avg, etc.)
   */
  private parseAggregateOrdering(
    pathParts: string[],
    direction: any,
    model: ModelReference
  ): OrderingAST {
    const operation = pathParts[0] as "count" | "avg" | "sum" | "min" | "max";

    let field: FieldReference | undefined;
    let relation: RelationReference | undefined;

    // If there's a field specified for the aggregate
    if (pathParts.length > 1) {
      const fieldPath = pathParts.slice(1);
      try {
        const resolved = this.fieldResolver.resolveFieldPath(
          model.name,
          fieldPath
        );
        if (isFieldReference(resolved)) {
          field = resolved;
        } else if (isRelationReference(resolved)) {
          relation = resolved;
        }
      } catch {
        // Ignore resolution errors for aggregates
      }
    }

    const target: AggregateOrderingTarget = {
      type: "AGGREGATE",
      operation,
    };

    if (field) {
      target.field = field;
    }
    if (relation) {
      target.relation = relation;
    }

    const nullsHandling = this.parseNullsHandling(direction);
    const orderingAST: OrderingAST = {
      type: "ORDERING",
      target,
      direction: this.parseDirection(direction),
    };

    // Only add nulls property if it's defined
    if (nullsHandling !== undefined) {
      orderingAST.nulls = nullsHandling;
    }

    return orderingAST;
  }

  /**
   * Parses direction from various input formats
   */
  private parseDirection(direction: any): "asc" | "desc" {
    if (typeof direction === "string") {
      const lower = direction.toLowerCase();
      if (lower === "desc" || lower === "descending") {
        return "desc";
      }
    }
    if (typeof direction === "object" && direction?.sort) {
      return this.parseDirection(direction.sort);
    }
    return "asc"; // Default
  }

  /**
   * Parses nulls handling from direction object
   */
  private parseNullsHandling(direction: any): "first" | "last" | undefined {
    if (typeof direction === "object" && direction?.nulls) {
      const nulls = direction.nulls.toLowerCase();
      if (nulls === "first") return "first";
      if (nulls === "last") return "last";
    }
    return undefined;
  }

  /**
   * Checks if a string represents an aggregate function
   */
  private isAggregateFunction(str: string): boolean {
    const aggregates = ["count", "avg", "sum", "min", "max"];
    return aggregates.includes(str.toLowerCase());
  }
}
