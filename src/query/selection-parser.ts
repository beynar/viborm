// Selection Parser for BaseORM
// Handles SELECT and INCLUDE operations and converts them to AST

import {
  SelectionAST,
  InclusionAST,
  SelectionFieldAST,
  InclusionRelationAST,
  NestedSelectionAST,
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
// Selection Parser
// ================================

export class SelectionParser {
  constructor(private fieldResolver: FieldResolver) {}

  /**
   * Parses SELECT clauses from Prisma-like syntax to AST
   */
  parseSelect(select: any, model: ModelReference): SelectionAST {
    if (!select || typeof select !== "object") {
      throw new ParseError("Invalid select object", { model: model.name });
    }

    const fields: SelectionFieldAST[] = [];

    for (const [key, value] of Object.entries(select)) {
      try {
        const resolved = this.fieldResolver.resolveFieldPath(model.name, [key]);

        if (isFieldReference(resolved)) {
          fields.push({
            type: "SELECTION_FIELD",
            field: resolved,
            include: Boolean(value),
          });
        } else if (isRelationReference(resolved)) {
          // Handle nested selection for relations
          const nested = this.parseNestedSelection(resolved, value);
          const fieldAST: SelectionFieldAST = {
            type: "SELECTION_FIELD",
            field: resolved as any, // Casting for compatibility
            include: Boolean(value),
          };
          if (nested) {
            fieldAST.nested = nested;
          }
          fields.push(fieldAST);
        }
      } catch (error) {
        if (error instanceof ParseError) {
          throw error;
        }
        throw new ParseError(
          `Failed to parse select field '${key}': ${error}`,
          {
            model: model.name,
            field: key,
          }
        );
      }
    }

    return {
      type: "SELECTION",
      model,
      fields,
    };
  }

  /**
   * Parses INCLUDE clauses from Prisma-like syntax to AST
   */
  parseInclude(include: any, model: ModelReference): InclusionAST {
    if (!include || typeof include !== "object") {
      throw new ParseError("Invalid include object", { model: model.name });
    }

    const relations: InclusionRelationAST[] = [];

    for (const [key, value] of Object.entries(include)) {
      try {
        const resolved = this.fieldResolver.resolveRelation(model.name, key);

        const nested =
          value && typeof value === "object"
            ? this.parseNestedSelection(resolved, value)
            : undefined;

        const relationAST: InclusionRelationAST = {
          type: "INCLUSION_RELATION",
          relation: resolved,
          include: Boolean(value),
        };
        if (nested) {
          relationAST.nested = nested;
        }
        relations.push(relationAST);
      } catch (error) {
        if (error instanceof ParseError) {
          throw error;
        }
        throw new ParseError(
          `Failed to parse include relation '${key}': ${error}`,
          {
            model: model.name,
            field: key,
          }
        );
      }
    }

    return {
      type: "INCLUSION",
      model,
      relations,
    };
  }

  /**
   * Parses nested selection for relations (select/include within relations)
   */
  private parseNestedSelection(
    relation: RelationReference,
    value: any
  ): NestedSelectionAST | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    // Parse nested query arguments
    const args: any = {};

    if (value.select) {
      args.select = this.parseSelect(value.select, {
        name: relation.targetModel.name,
        model: relation.targetModel,
      });
    }

    if (value.include) {
      args.include = this.parseInclude(value.include, {
        name: relation.targetModel.name,
        model: relation.targetModel,
      });
    }

    // Handle nested aggregations
    if (
      value._count ||
      value._avg ||
      value._sum ||
      value._min ||
      value._max ||
      value.aggregate
    ) {
      args.aggregate = {};

      // Collect all aggregation operations
      for (const key of ["_count", "_avg", "_sum", "_min", "_max"]) {
        if (value[key]) {
          args.aggregate[key] = value[key];
        }
      }

      // Handle explicit aggregate object
      if (value.aggregate) {
        Object.assign(args.aggregate, value.aggregate);
      }
    }

    if (value.where) {
      args.where = value.where; // Will be parsed by FilterParser
    }

    if (value.orderBy) {
      args.orderBy = value.orderBy; // Will be parsed by OrderingParser
    }

    // Handle groupBy for nested aggregations
    if (value.groupBy) {
      args.groupBy = value.groupBy; // Will be parsed by AggregationParser
    }

    // Handle having for nested aggregations
    if (value.having) {
      args.having = value.having; // Will be parsed by FilterParser
    }

    // Handle cursor for nested pagination
    if (value.cursor) {
      args.cursor = value.cursor; // Will be parsed by CursorParser
    }

    if (value.take) {
      args.take = value.take;
    }

    if (value.skip) {
      args.skip = value.skip;
    }

    if (value.distinct) {
      args.distinct = value.distinct;
    }

    return {
      type: "NESTED_SELECTION",
      relation,
      args: Object.keys(args).length > 0 ? args : undefined,
    };
  }
}
