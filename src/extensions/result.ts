/**
 * `result`: fields a client computes on the rows it returns (Prisma's result
 * extensions).
 *
 * A computed field names what it reads (`needs`) and how (`compute`). It is
 * not a column: the payload is rewritten before validation so the engine reads
 * the fields it needs and never sees the computed one, and the rows are
 * finished after the operation settles — the field computed, the fields read
 * only for it removed. Both steps run only on a client whose chain declares
 * `result`; any other client builds and runs none of this.
 *
 * Which rows: every row of the model an operation returns, nested relation
 * rows included, the way a `select` or `include` reaches them. A field is
 * selected and omitted by its name, as a column is; a field may shadow a
 * scalar of the same name. A later extension's field may need an earlier
 * one's, even under the same name, and is computed after it. Filtering,
 * ordering, grouping and aggregating by a computed field stay refused: the
 * database never sees it. A variant relation's rows do not carry computed
 * fields; a recursive projection carries them at every level.
 */

import {
  directVariantCarrier,
  PROJECTING_OPERATIONS,
  slotTarget,
} from "@client/omit";
import type { Schema } from "@client/types";
import type { AnyModel } from "@schema/model";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import { projectableScalarNames } from "@validation/model/core/projection";
import { isFunction, isRecord } from "@validation/value-guards";
import { extensionError } from "./definition";

type Row = Record<string, unknown>;

/** One computed field as a definition declares it, read once. */
export interface RuntimeComputedField {
  readonly needs: readonly string[];
  readonly compute: (row: Row) => unknown;
}

/** A definition's `result`: per model key (or `$allModels`), its fields. */
export type RuntimeResultContribution = Readonly<
  Record<string, Readonly<Record<string, RuntimeComputedField>>>
>;

/**
 * One model's computed field on the chain. Each need is a column's name, or
 * the index of the earlier computed field it reads.
 */
interface ResolvedComputedField {
  readonly name: string;
  readonly compute: (row: Row) => unknown;
  readonly needs: readonly (string | number)[];
}

/**
 * Per model name, every computed field the chain declares, in chain order: a
 * field's needs point only at columns and at fields before it.
 */
export type ResolvedResultFields = Readonly<
  Record<string, readonly ResolvedComputedField[]>
>;

const ALL_MODELS = "$allModels";

/** Read a definition's `result` once into a frozen snapshot. */
export function snapshotResult(
  component: unknown,
  extension: string,
  schema?: Schema
): RuntimeResultContribution {
  function refuse(path: string, problem: string): never {
    return extensionError(
      `Extension "${extension}" result${path} ${problem}.`,
      extension
    );
  }
  if (!isRecord(component)) refuse("", "must be a model map");
  const models: Record<
    string,
    Record<string, RuntimeComputedField>
  > = Object.create(null);
  for (const modelKey of Object.keys(component)) {
    if (modelKey !== ALL_MODELS && schema && !Object.hasOwn(schema, modelKey))
      refuse("", `names unknown model "${modelKey}"`);
    const entries = component[modelKey];
    if (!isRecord(entries)) refuse(`.${modelKey}`, "must be an object");
    const fields: Record<string, RuntimeComputedField> = Object.create(null);
    for (const name of Object.keys(entries)) {
      const entry = entries[name];
      const compute = isRecord(entry) ? entry.compute : undefined;
      const needs = isRecord(entry) ? (entry.needs ?? {}) : undefined;
      if (!(isRecord(needs) && isFunction(compute)))
        refuse(
          `.${modelKey}.${name}`,
          "must be an object with a compute function and a needs object"
        );
      const read: string[] = [];
      for (const need of Object.keys(needs)) {
        if (typeof needs[need] !== "boolean")
          refuse(`.${modelKey}.${name}.needs.${need}`, "must be a boolean");
        if (needs[need]) read.push(need);
      }
      fields[name] = Object.freeze({
        needs: Object.freeze(read),
        compute: compute as RuntimeComputedField["compute"],
      });
    }
    models[modelKey] = Object.freeze(fields);
  }
  return Object.freeze(models);
}

/**
 * The chain's computed fields with one extension's appended: `$allModels`
 * first, then the model's own, so a model's field can replace or need an
 * `$allModels` one. Every need is resolved here, against the model's
 * readable scalars and the fields before it.
 */
export function appendResultFields(
  previous: ResolvedResultFields | undefined,
  extension: string,
  contribution: RuntimeResultContribution,
  schema: Schema
): ResolvedResultFields {
  const next: Record<string, readonly ResolvedComputedField[]> = {
    ...previous,
  };
  for (const modelName of Object.keys(schema)) {
    const model = schema[modelName]!;
    const fields = [...(next[modelName] ?? [])];
    const readable = new Set(projectableScalarNames(model));
    for (const key of [ALL_MODELS, modelName]) {
      const declared = contribution[key] ?? {};
      for (const name of Object.keys(declared)) {
        const at = `Extension "${extension}" result.${key}.${name}`;
        if (
          name === "_count" ||
          Object.hasOwn(model["~"].state.relations, name)
        )
          extensionError(
            `${at} cannot be computed: "${name}" is a relation of model "${modelName}".`,
            extension
          );
        const needs = declared[name]!.needs.map((need) => {
          for (let earlier = fields.length - 1; earlier >= 0; earlier--) {
            if (fields[earlier]!.name === need) return earlier;
          }
          if (readable.has(need)) return need;
          return extensionError(
            `${at} needs "${need}", which is not a readable scalar or an earlier computed field of model "${modelName}".`,
            extension
          );
        });
        fields.push({ name, compute: declared[name]!.compute, needs });
      }
    }
    if (fields.length > 0) next[modelName] = fields;
  }
  return Object.freeze(next);
}

/**
 * One projection node's work on its rows, and its relations' nodes. A
 * recursive relation's node lists itself under the repeated key, so the
 * finish follows the tree the projection repeats.
 */
interface ResultNode {
  readonly compute: readonly ResolvedComputedField[];
  readonly strip: readonly string[];
  readonly relations: (readonly [string, ResultNode])[];
}

/** A bulk write returns rows only when it carries a projection. */
const BULK_OPERATIONS = new Set(["createMany", "updateMany", "deleteMany"]);

/**
 * Plan one operation: the payload the engine runs, and the function that
 * finishes its value. `undefined` when nothing this operation returns has a
 * computed field.
 */
export function planResultFields(
  fields: ResolvedResultFields,
  relations: ResolvedRelationIndex,
  model: AnyModel,
  operation: string,
  args: Row
):
  | { readonly args: Row; readonly finish: (value: unknown) => unknown }
  | undefined {
  const returnsRows =
    PROJECTING_OPERATIONS.has(operation) ||
    (BULK_OPERATIONS.has(operation) &&
      (args.select !== undefined || args.omit !== undefined));
  if (!returnsRows) return undefined;
  const planned = planNode(fields, relations, model, args);
  if (planned === undefined) return undefined;
  const { node } = planned;
  return {
    args: planned.args ?? args,
    finish: (value) => finishValue(value, node),
  };
}

function planNode(
  fields: ResolvedResultFields,
  relations: ResolvedRelationIndex,
  model: AnyModel,
  args: Row | undefined
): { readonly args: Row | undefined; readonly node: ResultNode } | undefined {
  const declared = fields[model["~"].names.ts ?? ""];
  const select = isRecord(args?.select) ? args.select : undefined;
  const include = isRecord(args?.include) ? args.include : undefined;
  const omit = isRecord(args?.omit) ? args.omit : undefined;

  // The relations first: a node with no field of its own may still lead to
  // one that has.
  const nested: (readonly [string, ResultNode])[] = [];
  const projection = select ?? include;
  let nextProjection = projection;
  if (projection !== undefined) {
    const slots = relations.get(model);
    for (const key of Object.keys(projection)) {
      const resolved = slots?.get(key);
      const value = projection[key];
      if (!resolved || directVariantCarrier(resolved)) continue;
      if (value !== true && !isRecord(value)) continue;
      const target = slotTarget(resolved, model);
      if (!target) continue;
      const childArgs = value === true ? undefined : value;
      const child = planNode(fields, relations, target, childArgs);
      if (child === undefined) continue;
      nested.push([key, child.node]);
      if (childArgs?.recurse !== undefined)
        child.node.relations.push([key, child.node]);
      if (child.args !== childArgs) {
        if (nextProjection === projection) nextProjection = { ...projection };
        nextProjection![key] = child.args;
      }
    }
  }

  // The latest declaration of each name is the visible field.
  const visible = new Map<string, number>();
  for (const [index, field] of (declared ?? []).entries())
    visible.set(field.name, index);
  const wanted: number[] = [];
  // A payload that names a field it does not want still loses that key.
  let named = false;
  for (const [name, index] of visible) {
    named ||= (select ?? omit)?.[name] !== undefined;
    if (select ? select[name] === true : omit?.[name] !== true)
      wanted.push(index);
  }
  if (wanted.length === 0 && nested.length === 0 && !named) return undefined;

  // Every field the wanted ones read, computed first; the columns they read.
  const computing = new Set<number>();
  const reads = new Set<string>();
  const close = (index: number) => {
    if (computing.has(index)) return;
    computing.add(index);
    for (const need of declared![index]!.needs) {
      if (typeof need === "number") close(need);
      else reads.add(need);
    }
  };
  for (const index of wanted) close(index);
  const outputs = new Set(wanted.map((index) => declared![index]!.name));
  const strip = new Set<string>();
  for (const index of computing) {
    const { name } = declared![index]!;
    if (!outputs.has(name)) strip.add(name);
  }

  let next = args;
  const rewrite = (key: string, value: Row) => {
    if (next === args) next = { ...args };
    next![key] = value;
  };
  if (select !== undefined) {
    const nextSelect: Row = { ...(nextProjection ?? select) };
    for (const name of visible.keys()) delete nextSelect[name];
    for (const field of reads) {
      if (nextSelect[field] === true) continue;
      nextSelect[field] = true;
      if (!outputs.has(field)) strip.add(field);
    }
    if (!Object.values(nextSelect).some((value) => value !== false)) {
      const [first] = projectableScalarNames(model);
      if (first !== undefined) {
        nextSelect[first] = true;
        if (!outputs.has(first)) strip.add(first);
      }
    }
    rewrite("select", nextSelect);
  } else {
    if (nextProjection !== projection) rewrite("include", nextProjection!);
    let nextOmit: Row | undefined;
    const omitted = (field: string) => (nextOmit ?? omit)?.[field] === true;
    for (const name of visible.keys()) {
      // An omitted field that shadows a column keeps the column omitted.
      if (omit?.[name] === undefined || readsColumn(model, name)) continue;
      nextOmit ??= { ...omit };
      delete nextOmit[name];
    }
    for (const field of reads) {
      if (!omitted(field)) continue;
      nextOmit ??= { ...omit };
      nextOmit[field] = false;
      if (!outputs.has(field)) strip.add(field);
    }
    if (nextOmit !== undefined) rewrite("omit", nextOmit);
  }

  return {
    args: next,
    node: {
      compute: [...computing]
        .sort((a, b) => a - b)
        .map((index) => declared![index]!),
      strip: [...strip],
      relations: nested,
    },
  };
}

const readsColumn = (model: AnyModel, name: string): boolean =>
  Object.hasOwn(model["~"].state.scalars, name);

function finishValue(value: unknown, node: ResultNode): unknown {
  if (Array.isArray(value)) return value.map((row) => finishRow(row, node));
  return finishRow(value, node);
}

/** A copy of one row, its relations finished, its fields computed. */
function finishRow(value: unknown, node: ResultNode): unknown {
  if (!isRecord(value)) return value;
  const row: Row = { ...value };
  for (const [key, child] of node.relations) {
    if (row[key] !== undefined) row[key] = finishValue(row[key], child);
  }
  for (const field of node.compute) row[field.name] = field.compute(row);
  for (const key of node.strip) delete row[key];
  return row;
}
