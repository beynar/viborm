import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import { QueryEngineError } from "@errors";
import {
  type AggregateLeaf,
  classifyAggregateLeaf,
} from "@query-engine/result/result-aggregate-leaf";
import { classifyResultColumn } from "@query-engine/result/result-column";
import { buildExpectedResultShape } from "@query-engine/result/result-shape";
import type {
  ExpectedAggregateResultShape,
  ExpectedPolymorphicResultShape,
  ExpectedRelationResultShape,
  ExpectedResultShape,
  Operation,
} from "@query-engine/types";
import { type AnyModel, Model } from "@schema/model";
import {
  type AnyRelation,
  isVariantRelationState,
  slotMayBeEmpty,
} from "@schema/relation";
import type { Scalar } from "@schema/scalars";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import type { Operations, Schema } from "./types";

type TypeNode =
  | { readonly kind: "atom"; readonly value: string }
  | {
      readonly kind: "array";
      readonly element: TypeNode;
      readonly immutable: boolean;
    }
  | { readonly kind: "object"; readonly fields: readonly TypeField[] }
  | { readonly kind: "union"; readonly members: readonly TypeNode[] };

interface TypeField {
  readonly name: string;
  readonly type: TypeNode;
  readonly immutable?: true;
  readonly optional?: true;
}

/**
 * One named alias a rendered result declares. A recursive relation is the
 * only type TypeScript cannot spell as one anonymous expression, so each
 * recursive slot is rendered once as a named alias whose repeated key refers
 * to the alias itself.
 */
type AliasDeclaration = { readonly name: string; type: TypeNode };

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NULL_TYPE: TypeNode = { kind: "atom", value: "null" };

function atom(value: string): TypeNode {
  return { kind: "atom", value };
}

function arrayOf(element: TypeNode, immutable = false): TypeNode {
  return { kind: "array", element, immutable };
}

function objectOf(fields: readonly TypeField[]): TypeNode {
  return { kind: "object", fields };
}

function unionOf(...nodes: readonly TypeNode[]): TypeNode {
  const members: TypeNode[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const candidates = node.kind === "union" ? node.members : [node];
    for (const candidate of candidates) {
      const identity = renderType(candidate, 0);
      if (seen.has(identity)) continue;
      seen.add(identity);
      members.push(candidate);
    }
  }
  const [onlyMember] = members;
  if (!onlyMember) return atom("never");
  return members.length === 1 ? onlyMember : { kind: "union", members };
}

function renderPropertyName(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function indentation(depth: number): string {
  return "  ".repeat(depth);
}

function renderType(node: TypeNode, depth: number): string {
  switch (node.kind) {
    case "atom":
      return node.value;
    case "array": {
      const typeConstructor = node.immutable ? "ReadonlyArray" : "Array";
      return `${typeConstructor}<${renderType(node.element, depth)}>`;
    }
    case "union":
      return node.members
        .map((member) => renderType(member, depth))
        .join(" | ");
    case "object": {
      if (node.fields.length === 0) return "{}";
      const fieldIndentation = indentation(depth + 1);
      const fields = node.fields.map((field) => {
        const modifier = field.immutable ? "readonly " : "";
        const optional = field.optional ? "?" : "";
        return `${fieldIndentation}${modifier}${renderPropertyName(field.name)}${optional}: ${renderType(field.type, depth + 1)};`;
      });
      return `{
${fields.join("\n")}
${indentation(depth)}}`;
    }
    default:
      throw new QueryEngineError(
        "The TypeScript renderer received an unknown node."
      );
  }
}

function enumType(scalar: Scalar): TypeNode {
  const values = Reflect.get(scalar["~"].state.base, "values");
  if (
    !(
      Array.isArray(values) &&
      values.every((value) => typeof value === "string")
    )
  ) {
    throw new QueryEngineError("An enum scalar has no readable string values.");
  }
  return unionOf(...values.map((value) => atom(JSON.stringify(value))));
}

function scalarType(scalar: Scalar): TypeNode {
  const state = scalar["~"].state;
  let value: TypeNode;
  switch (state.type) {
    case "string":
    case "time":
      value = atom("string");
      break;
    case "int":
    case "number":
      value = atom("number");
      break;
    case "decimal":
      value = atom('import("viborm").Decimal');
      break;
    case "boolean":
      value = atom("boolean");
      break;
    case "datetime":
    case "date":
      value = atom("Date");
      break;
    case "bigint":
      value = atom("bigint");
      break;
    case "json":
      // A custom Standard Schema carries its output only in an erased generic.
      value = atom("unknown");
      break;
    case "blob":
      value = atom("Uint8Array");
      break;
    case "vector":
      value = arrayOf(atom("number"));
      break;
    case "point":
      value = objectOf([
        { name: "longitude", type: atom("number") },
        { name: "latitude", type: atom("number") },
      ]);
      break;
    case "enum":
      value = enumType(scalar);
      break;
    default:
      throw new QueryEngineError(
        "The TypeScript renderer does not support this scalar type."
      );
  }
  if (state.array) value = arrayOf(value);
  return state.nullable ? unionOf(value, NULL_TYPE) : value;
}

function requiredRelationShape(
  relationName: string,
  expected: ExpectedRelationResultShape | undefined
): ExpectedRelationResultShape {
  if (expected) return expected;
  throw new QueryEngineError(
    `The result shape for relation '${relationName}' is absent.`
  );
}

function requiredPolymorphicShape(
  relationName: string,
  expected: ExpectedPolymorphicResultShape | undefined
): ExpectedPolymorphicResultShape {
  if (expected) return expected;
  throw new QueryEngineError(
    `The result shape for polymorphic relation '${relationName}' is absent.`
  );
}

function aggregateLeafType(leaf: AggregateLeaf): TypeNode {
  switch (leaf.kind) {
    case "count":
    case "number":
      return leaf.nullable
        ? unionOf(atom("number"), NULL_TYPE)
        : atom("number");
    case "scalar":
    case "widenedSum":
      return unionOf(scalarType(leaf.scalar), NULL_TYPE);
    case "unknown":
      throw new QueryEngineError(
        "The aggregate result contains an unknown field."
      );
    default:
      throw new QueryEngineError(
        "The TypeScript renderer received an unknown aggregate leaf."
      );
  }
}

function aggregateType(
  model: AnyModel,
  name: "_count" | "_avg" | "_sum" | "_min" | "_max",
  expected: ExpectedAggregateResultShape | undefined
): TypeNode {
  if (name === "_count" && expected?.fields === undefined) {
    return atom("number");
  }
  if (!expected?.fields) {
    throw new QueryEngineError(
      `The result shape for aggregate '${name}' is absent.`
    );
  }
  const fields = [...expected.fields].map((fieldName) => ({
    name: fieldName,
    type: aggregateLeafType(
      classifyAggregateLeaf(name, fieldName, model["~"].state.scalars)
    ),
  }));
  return objectOf(fields);
}

function polymorphicType(
  expected: ExpectedPolymorphicResultShape,
  declarations: AliasDeclaration[]
): TypeNode {
  const variants: TypeNode[] = [];
  for (const [publicType, variant] of expected.variants) {
    variants.push(
      objectOf([
        {
          name: "type",
          type: atom(JSON.stringify(publicType)),
          immutable: true,
        },
        {
          name: "data",
          type: rowType(variant.model, variant.shape, declarations),
          immutable: true,
        },
      ])
    );
  }
  const member = variants.length === 0 ? atom("never") : unionOf(...variants);
  if (expected.cardinality === "many") return arrayOf(member, true);
  return expected.optional ? unionOf(member, NULL_TYPE) : member;
}

/** A relation slot's cardinality and emptiness around one row type. */
function relationValue(
  expected: ExpectedRelationResultShape,
  row: TypeNode
): TypeNode {
  if (expected.cardinality === "many") return arrayOf(row);
  return expected.optional ? unionOf(row, NULL_TYPE) : row;
}

/**
 * One recursive slot: the ordinary node row once, as a named alias whose own
 * key repeats the slot. A numeric cutoff may leave that key absent, so it is
 * optional; an exhaustive traversal publishes it on every occurrence.
 */
function recursiveRowType(
  key: string,
  expected: ExpectedRelationResultShape,
  depth: number | false,
  declarations: AliasDeclaration[]
): TypeNode {
  const declaration: AliasDeclaration = {
    name: `VibORMRecursiveNode${declarations.length + 1}`,
    type: atom("never"),
  };
  declarations.push(declaration);
  const self = atom(declaration.name);
  declaration.type = objectOf([
    ...rowFields(expected.model, expected.shape, declarations),
    {
      name: key,
      type: relationValue(expected, self),
      ...(depth === false ? {} : { optional: true as const }),
    },
  ]);
  return self;
}

function rowType(
  model: AnyModel,
  shape: ExpectedResultShape,
  declarations: AliasDeclaration[]
): TypeNode {
  return objectOf(rowFields(model, shape, declarations));
}

function rowFields(
  model: AnyModel,
  shape: ExpectedResultShape,
  declarations: AliasDeclaration[]
): TypeField[] {
  const fields: TypeField[] = [];
  for (const rawKey of shape.rawKeys) {
    const column = classifyResultColumn(model, rawKey, shape);
    switch (column.kind) {
      case "empty":
        break;
      case "distance":
        fields.push({
          name: "_distance",
          type:
            column.scalar?.["~"].state.type === "point" &&
            column.scalar["~"].state.nullable
              ? unionOf(atom("number"), NULL_TYPE)
              : atom("number"),
        });
        break;
      case "scalar":
        fields.push({ name: column.key, type: scalarType(column.scalar) });
        break;
      case "relation": {
        const expected = requiredRelationShape(column.key, column.expected);
        const relatedRow = expected.recurrence
          ? recursiveRowType(
              column.key,
              expected,
              expected.recurrence.depth,
              declarations
            )
          : rowType(expected.model, expected.shape, declarations);
        fields.push({
          name: column.key,
          type: relationValue(expected, relatedRow),
        });
        break;
      }
      case "polymorphic":
        fields.push({
          name: column.key,
          type: polymorphicType(
            requiredPolymorphicShape(column.key, column.expected),
            declarations
          ),
        });
        break;
      case "relationCounts": {
        if (!column.relations) {
          throw new QueryEngineError(
            "The relation-count result shape is absent."
          );
        }
        fields.push({
          name: "_count",
          type: objectOf(
            [...column.relations].map((relationName) => ({
              name: relationName,
              type: atom("number"),
            }))
          ),
        });
        break;
      }
      case "aggregate":
        fields.push({
          name: column.name,
          type: aggregateType(model, column.name, column.expected),
        });
        break;
      case "unknown":
        throw new QueryEngineError(
          `The result shape contains unknown column '${column.key}'.`
        );
      default:
        throw new QueryEngineError(
          "The TypeScript renderer received an unknown result column."
        );
    }
  }
  return fields;
}

function countType(shape: ExpectedResultShape): TypeNode {
  if (shape.rawKeys.length === 1 && shape.rawKeys[0] === COUNT_RESULT_KEY) {
    return atom("number");
  }
  return objectOf(
    shape.rawKeys.map((fieldName) => ({
      name: fieldName,
      type: atom("number"),
    }))
  );
}

/**
 * The schema-only result type of one admitted payload, from its expected
 * shape alone: no driver, no SQL, no client default-omit or extension.
 *
 * Almost every result renders as ONE type expression. A recursive relation
 * slot cannot: its node refers to itself, and TypeScript names recursion only
 * through a declaration (format: `renderOperationResultType`). The text names
 * no exported helper.
 */
export function operationResultType(
  model: AnyModel,
  publicOperation: Operations,
  engineOperation: Operation,
  args: Record<string, unknown>,
  index: ResolvedRelationIndex
): string {
  if (
    (publicOperation === "createMany" ||
      publicOperation === "updateMany" ||
      publicOperation === "deleteMany") &&
    engineOperation === publicOperation
  ) {
    return renderType(objectOf([{ name: "count", type: atom("number") }]), 0);
  }

  const shape = buildExpectedResultShape(model, engineOperation, args, index);
  if (!shape) {
    throw new QueryEngineError(
      `Operation '${publicOperation}' has no renderable result shape.`
    );
  }

  const declarations: AliasDeclaration[] = [];
  let value =
    shape.carrier === "existence"
      ? atom("boolean")
      : shape.carrier === "count"
        ? countType(shape)
        : rowType(model, shape, declarations);

  if (
    publicOperation === "findMany" ||
    publicOperation === "groupBy" ||
    engineOperation === "createManyAndReturn" ||
    engineOperation === "updateManyAndReturn" ||
    engineOperation === "deleteManyAndReturn"
  ) {
    value = arrayOf(value);
  } else if (
    publicOperation === "findFirst" ||
    publicOperation === "findUnique"
  ) {
    value = unionOf(value, NULL_TYPE);
  }
  if (declarations.length === 0) return renderType(value, 0);
  return [{ name: "VibORMOperationResult", type: value }, ...declarations]
    .map(({ name, type }) => `type ${name} = ${renderType(type, 0)};`)
    .join("\n");
}

function settledModel(relation: AnyRelation, variant?: string): AnyModel {
  const target = relation["~"].settleTarget(variant);
  if (target instanceof Model) return target;
  throw new QueryEngineError("A relation target is not a model.");
}

function schemaModelReference(model: AnyModel): TypeNode {
  const modelName = model["~"].names.ts;
  if (!modelName) {
    throw new QueryEngineError(
      "A schema model has no hydrated TypeScript name."
    );
  }
  return atom(`VibORMSchema[${JSON.stringify(modelName)}]`);
}

function schemaRelationType(
  model: AnyModel,
  fieldName: string,
  relation: AnyRelation,
  index: ResolvedRelationIndex
): TypeNode {
  const resolved = index.get(model)?.get(fieldName);
  if (!resolved) {
    throw new QueryEngineError(
      `The resolved schema has no relation slot for '${fieldName}'.`
    );
  }
  const state = relation["~"].state;
  if (isVariantRelationState(state)) {
    const variants = Object.keys(state.target.entries).map((publicType) =>
      objectOf([
        {
          name: "type",
          type: atom(JSON.stringify(publicType)),
          immutable: true,
        },
        {
          name: "data",
          type: schemaModelReference(settledModel(relation, publicType)),
          immutable: true,
        },
      ])
    );
    const member = variants.length === 0 ? atom("never") : unionOf(...variants);
    if (state.cardinality === "many") return arrayOf(member, true);
    return slotMayBeEmpty(resolved) ? unionOf(member, NULL_TYPE) : member;
  }

  const target = schemaModelReference(settledModel(relation));
  if (state.cardinality === "many") return arrayOf(target);
  return slotMayBeEmpty(resolved) ? unionOf(target, NULL_TYPE) : target;
}

function schemaModelType(
  model: AnyModel,
  index: ResolvedRelationIndex
): TypeNode {
  const state = model["~"].state;
  const fields: TypeField[] = [];
  for (const fieldName of Object.keys(state.shape)) {
    const scalar = Object.hasOwn(state.scalars, fieldName)
      ? state.scalars[fieldName]
      : undefined;
    if (scalar) {
      fields.push({ name: fieldName, type: scalarType(scalar) });
      continue;
    }
    const relation = Object.hasOwn(state.relations, fieldName)
      ? state.relations[fieldName]
      : undefined;
    if (relation) {
      fields.push({
        name: fieldName,
        type: schemaRelationType(model, fieldName, relation, index),
      });
      continue;
    }
    const modelName = model["~"].names.ts ?? "model";
    throw new QueryEngineError(
      `Model '${modelName}' has unknown field '${fieldName}'.`
    );
  }
  return objectOf(fields);
}

export function schemaType(
  schema: Schema,
  index: ResolvedRelationIndex
): string {
  const models = Object.entries(schema).map(([modelName, model]) => ({
    name: modelName,
    type: schemaModelType(model, index),
  }));
  return `type VibORMSchema = ${renderType(objectOf(models), 0)};`;
}
