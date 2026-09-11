import type { AnyDriver } from "@drivers";
import { hydrateSchemaNames, type Schema } from "@schema/hydration";
import { getModelKeyCatalog, type AnyModel } from "@schema/model";
import { validateClientSchemaOrThrow } from "@schema/validation";
import { createResolvedSchemaRegistry } from "@validation/builder";
import { isRecord } from "@validation/value-guards";
import {
  parseValidated,
  upsertEnvelopeSchema,
} from "../../write-engine/parse-boundary";

export type Input = Record<string, unknown>;
export type Operation =
  | "create"
  | "createMany"
  | "update"
  | "upsert"
  | "updateMany"
  | "deleteMany"
  | "findMany"
  | "findUnique"
  | "groupBy";
export interface EngineConfig {
  schema: Schema;
  driver: AnyDriver;
}
export interface Arguments extends Input {
  data: Input;
  create?: Input;
  update?: Input;
  where?: Input;
  targetWhere?: Input;
  setWhere?: Input;
  select?: Input;
  include?: Input;
  orderBy?: Input | Input[];
  take?: number;
  skip?: number;
  by?: string[];
  having?: Input;
  limit?: number;
  omit?: Input;
  skipDuplicates?: boolean;
}

/** These casts attach the existing admission schema's dynamic model correlation. */
export function record(value: unknown): Input {
  return value as Input;
}
export function entries(value: unknown): Input[] {
  return Array.isArray(value) ? value : [record(value)];
}

export class EngineSchema {
  readonly index;
  readonly registry;
  constructor(readonly schema: Schema) {
    hydrateSchemaNames(schema);
    this.index = validateClientSchemaOrThrow(schema);
    this.registry = createResolvedSchemaRegistry(schema, this.index);
  }
  admit(model: AnyModel, operation: Operation, raw: unknown): Arguments {
    if (operation === "upsert") return this.upsert(model, raw);
    const schema = this.registry.getModelSchemas(model).args[operation];
    const input =
      operation === "update" && isRecord(raw) && isRecord(raw.data)
        ? {
            ...raw,
            data: Object.fromEntries(
              Object.entries(raw.data).sort(([left], [right]) => {
                const isVariant = (name: string) =>
                  model["~"].state.relations[name]?.["~"].state.target.kind ===
                  "variants";
                return Number(isVariant(left)) - Number(isVariant(right));
              })
            ),
          }
        : raw;
    return parseValidated(schema, input, operation, "") as Arguments;
  }
  private upsert(model: AnyModel, raw: unknown): Arguments {
    const envelope = parseValidated(upsertEnvelopeSchema, raw, "upsert", "");
    const schemas = this.registry.getModelSchemas(model);
    const createHasRelations = model["~"].relationNames.some(
      (name) => envelope.create[name] !== undefined
    );
    const updateScalars = Object.fromEntries(
      Object.entries(envelope.update).filter(
        ([name]) => !model["~"].relationNames.includes(name)
      )
    );
    const where = parseValidated(
      schemas.core.whereUniqueExtended,
      envelope.where,
      "upsert",
      "where"
    );
    const scalarCreate = createHasRelations
      ? undefined
      : parseValidated(
          schemas.core.scalarCreate,
          envelope.create,
          "upsert",
          "create"
        );
    const update = parseValidated(
      schemas.core.scalarUpdate,
      updateScalars,
      "upsert",
      "update"
    );
    const projection = parseValidated(
      schemas.core.upsertProjection,
      {
        select: envelope.select,
        include: envelope.include,
        omit: envelope.omit,
      },
      "upsert",
      ""
    );
    const conditions: Pick<Arguments, "targetWhere" | "setWhere"> = {
      targetWhere: undefined,
      setWhere: undefined,
    };
    for (const field of ["targetWhere", "setWhere"] as const) {
      const input = envelope[field];
      if (isRecord(input) && Object.keys(input).length)
        conditions[field] = record(
          parseValidated(schemas.core.where, input, "upsert", field)
        );
    }
    const create = createHasRelations
      ? parseValidated(schemas.core.create, envelope.create, "create", "data")
      : scalarCreate;
    const admittedUpdate = this.update(
      model,
      envelope.update,
      false,
      record(update)
    );
    // Operation dispatch supplies the correlation: upsert owns create/update, not data.
    return record({
      ...envelope,
      ...record(projection),
      ...conditions,
      where,
      create,
      update: admittedUpdate,
    }) as Arguments;
  }
  update(
    model: AnyModel,
    source: Input,
    captured: boolean,
    envelope?: Input
  ): Input {
    const schemas = this.registry.getModelSchemas(model);
    if (captured)
      return record(
        parseValidated(schemas.core.update, source, "updateMany", "data")
      );
    const admitted = { ...(envelope ?? source) };
    const names = Object.keys(source).filter((name) =>
      model["~"].relationNames.includes(name)
    );
    const isVariant = (name: string) =>
      model["~"].state.relations[name]!["~"].state.target.kind === "variants";
    // Admission phases are ordinary relations then carriers, retaining raw order within each.
    for (const name of names.sort(
      (a, b) => Number(isVariant(a)) - Number(isVariant(b))
    )) {
      if (source[name] !== undefined) {
        admitted[name] = parseValidated(
          (isVariant(name)
            ? schemas.polymorphic[name]!
            : schemas.relations[name]!
          ).update,
          source[name],
          "update",
          `data.${name}`
        );
      }
    }
    return admitted;
  }
  member(model: AnyModel, relation: string, source: Input): Input {
    const schema =
      this.registry.getModelSchemas(model).relations[relation]!.update;
    const parsed = record(
      parseValidated(
        schema,
        { updateMany: { data: source } },
        "update",
        `data.${relation}`
      )
    );
    return record(entries(parsed.updateMany)[0]!.data);
  }
  keys(model: AnyModel): readonly string[] {
    return getModelKeyCatalog(model).rowKey!.fields;
  }
  identity(model: AnyModel, row: Input): Input {
    return Object.fromEntries(
      this.keys(model).map((field) => [field, row[field]])
    );
  }
  scalars(model: AnyModel, admitted: Input): Input {
    return Object.fromEntries(
      model["~"].scalarFieldNames
        .filter((field) => admitted[field] !== undefined)
        .map((field) => [field, admitted[field]])
    );
  }
}
