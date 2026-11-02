import { ValidationError } from "@errors";
import {
  baseOperation,
  ROUTED_OPERATIONS,
} from "@query-engine/routed-operations";
import type { Operation } from "@query-engine/types";
import { isAppended } from "@schema/appended";
import { hydrateSchemaNames } from "@schema/hydration";
import { resolveSchemaOrThrow } from "@schema/validation";
import {
  createResolvedSchemaRegistry,
  createSchemaRegistry,
} from "@validation/builder";
import { parseProviding } from "@validation/primitives/object";
import type {
  OperationPayloadSchema,
  Operations,
  Schema,
  ValidatedOperationPayload,
} from "./types";
import { operationResultType, schemaType } from "./typescript-type-renderer";

function publicOperationOrThrow(
  modelName: string,
  operation: string
): Operations {
  if (ROUTED_OPERATIONS.has(operation)) return operation as Operations;
  throw new ValidationError(
    { kind: "registry", model: modelName, property: operation },
    [{ path: "operation", message: `${operation} does not exist` }]
  );
}

function requireIdentifier(
  value: unknown,
  path: "model" | "operation"
): string {
  if (typeof value === "string") return value;
  throw new ValidationError({ kind: "registry", property: path }, [
    { path, message: `${path} must be a string` },
  ]);
}

function resultOperation(
  operation: Operations,
  args: Record<string, unknown>
): Operation {
  switch (operation) {
    case "createMany":
    case "updateMany":
    case "deleteMany":
      return args.select === undefined ? operation : `${operation}AndReturn`;
    default:
      return baseOperation(operation);
  }
}

/** Return the canonical Standard Schema for one public operation payload. */
export function getOperationPayloadSchema<
  const S extends Schema,
  ModelName extends Extract<keyof S, string>,
  OperationName extends Operations,
>(
  schema: S,
  modelName: ModelName,
  operation: OperationName
): OperationPayloadSchema<OperationName, S[ModelName]>;
export function getOperationPayloadSchema<
  const S extends Schema,
  ModelName extends Extract<keyof S, string>,
>(schema: S, modelName: ModelName, operation: unknown): unknown {
  requireIdentifier(modelName, "model");
  const validatedOperation = publicOperationOrThrow(
    modelName,
    requireIdentifier(operation, "operation")
  );
  return createSchemaRegistry(schema).proxy[modelName].args[
    baseOperation(validatedOperation)
  ];
}

/**
 * Validate one public model-operation payload and return its normalized value.
 * This is schema validation, not a driver-specific executability check.
 */
export function validateOperationPayload<
  const S extends Schema,
  ModelName extends Extract<keyof S, string>,
  OperationName extends Operations,
>(
  schema: S,
  modelName: ModelName,
  operation: OperationName,
  payload: unknown
): ValidatedOperationPayload<OperationName, S[ModelName]>;
export function validateOperationPayload(
  schema: Schema,
  modelName: unknown,
  operation: unknown,
  payload: unknown
): unknown {
  const validatedModelName = requireIdentifier(modelName, "model");
  const validatedOperation = publicOperationOrThrow(
    validatedModelName,
    requireIdentifier(operation, "operation")
  );
  const registry = createSchemaRegistry(schema);
  const validate = () =>
    registry.validate(
      validatedModelName,
      baseOperation(validatedOperation),
      payload ?? {}
    );
  // A field an extension appends (`orderingKey`), left out of a create, is
  // provided as its client provides it: its default is neither filled nor
  // validated.
  const appended = appendedFields(schema);
  return appended.size === 0
    ? validate()
    : parseProviding(
        (model, field) => appended.get(model)?.has(field) === true,
        validate
      );
}

/** Each model's fields whose validator an extension appends, by TS name. */
function appendedFields(schema: Schema): Map<string, Set<string>> {
  const appended = new Map<string, Set<string>>();
  for (const [name, model] of Object.entries(schema))
    for (const [field, value] of Object.entries(model["~"].state.shape))
      if (
        isAppended(
          (value as { "~"?: { state?: { schema?: unknown } } })["~"]?.state
            ?.schema
        )
      ) {
        let fields = appended.get(name);
        if (fields === undefined) appended.set(name, (fields = new Set()));
        fields.add(field);
      }
  return appended;
}

/**
 * Render the concrete return type for one validated public operation payload.
 * Client extensions and `defaultOmit()` are not part of this schema-only view:
 * on a client whose extensions declare `rows`, a to-one relation can read
 * `null` where the rendered type says it cannot.
 *
 * A payload with a recursive relation slot renders as declarations — a
 * `VibORMOperationResult` alias followed by one `VibORMRecursiveNodeN` alias per
 * recursive slot, numbered outer-first — because a finite recursive type needs
 * a name; every other result renders as one type expression.
 */
export function renderOperationResultType<
  const S extends Schema,
  ModelName extends Extract<keyof S, string>,
>(
  schema: S,
  modelName: ModelName,
  operation: Operations,
  payload: unknown
): string;
export function renderOperationResultType(
  schema: Schema,
  modelName: unknown,
  operation: unknown,
  payload: unknown
): string {
  const validatedModelName = requireIdentifier(modelName, "model");
  const validatedOperation = publicOperationOrThrow(
    validatedModelName,
    requireIdentifier(operation, "operation")
  );
  const schemaOperation = baseOperation(validatedOperation);
  hydrateSchemaNames(schema);
  const index = resolveSchemaOrThrow(schema);
  const registry = createResolvedSchemaRegistry(schema, index);
  const validated = registry.validate(
    validatedModelName,
    schemaOperation,
    payload ?? {}
  );
  const model = schema[validatedModelName];
  if (!model) {
    throw new ValidationError({ kind: "registry", model: validatedModelName }, [
      {
        path: validatedModelName,
        message: `${validatedModelName} does not exist`,
      },
    ]);
  }
  return operationResultType(
    model,
    validatedOperation,
    resultOperation(validatedOperation, validated),
    validated,
    index
  );
}

/**
 * Render the complete schema graph as a recursive `VibORMSchema` declaration.
 * Custom JSON schema output is `unknown` because Standard Schema erases it at runtime.
 */
export function renderSchemaType<const S extends Schema>(schema: S): string {
  hydrateSchemaNames(schema);
  return schemaType(schema, resolveSchemaOrThrow(schema));
}
