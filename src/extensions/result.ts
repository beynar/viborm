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
import type { AnyModel } from "@schema/model";
import type { ResolvedRelationIndex } from "@schema/validation/relation-resolution";
import { projectableScalarNames } from "@validation/model/core/projection";
import { isRecord } from "@validation/value-guards";
import type { ExtensionPart } from "./chain";
import { extensionError } from "./chain";

type Row = Record<string, unknown>;

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
type ResolvedResultFields = Readonly<
  Record<string, readonly ResolvedComputedField[]>
>;

const ALL_MODELS = "$allModels";

/** A computed field as `fields(…)` is written: what it needs, and how. */
export interface ComputedFieldDeclaration {
  readonly needs?: Readonly<Record<string, boolean>>;
  readonly compute: (row: Row) => unknown;
}

/**
 * One projection node's work on its rows, and its relations' nodes. A
 * recursive relation's node lists itself under the repeated key, so the
 * finish follows the tree the projection repeats.
 */
interface ResultNode {
  /** The model's computed fields; `outputs` indexes the ones returned. */
  readonly fields: readonly ResolvedComputedField[];
  readonly outputs: readonly number[];
  /** The columns the returned fields read, through earlier fields too. */
  readonly reads: readonly string[];
  readonly strip: readonly string[];
  readonly relations: (readonly [string, ResultNode])[];
}

/** A bulk write returns rows only when it carries a projection. */
const BULK_OPERATIONS = new Set(["createMany", "updateMany", "deleteMany"]);

function planNode(
  fields: ResolvedResultFields,
  relations: ResolvedRelationIndex,
  model: AnyModel,
  args: Row | undefined
): { readonly args: Row | undefined; readonly node: ResultNode } | undefined {
  // A hydrated model always has its name.
  const declared = fields[model["~"].names.ts!] ?? [];
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
      if (
        !resolved ||
        directVariantCarrier(resolved) ||
        (value !== true && !isRecord(value))
      )
        continue;
      const target = slotTarget(resolved, model);
      const childArgs = value === true ? undefined : value;
      const child = planNode(fields, relations, target, childArgs);
      if (child === undefined) continue;
      nested.push([key, child.node]);
      if (childArgs?.recurse !== undefined)
        child.node.relations.push([key, child.node]);
      if (child.args !== childArgs)
        nextProjection = { ...nextProjection, [key]: child.args };
    }
  }

  // The latest declaration of each name is the visible field.
  const visible = new Map<string, number>();
  for (const [index, field] of declared.entries())
    visible.set(field.name, index);
  // A name the payload keeps: a column it returns, or a field it computes.
  const kept = (name: string) =>
    (select ? select[name] === true : true) && omit?.[name] !== true;
  const wanted: number[] = [];
  // A payload that names a field it does not want still loses that key.
  let named = false;
  for (const [name, index] of visible) {
    named ||= (select ?? omit)?.[name] !== undefined;
    if (kept(name)) wanted.push(index);
  }
  if (wanted.length === 0 && nested.length === 0 && !named) return undefined;

  // Every field the wanted ones read, computed first; the columns they read.
  const computing = new Set<number>();
  const reads = new Set<string>();
  const close = (index: number) => {
    if (computing.has(index)) return;
    computing.add(index);
    for (const need of declared[index]!.needs) {
      if (typeof need === "number") close(need);
      else reads.add(need);
    }
  };
  for (const index of wanted) close(index);
  // The columns read only for a field: removed from the rows again (a kept
  // name that is a field is computed over its column).
  const strip = new Set<string>();
  for (const field of reads) if (!kept(field)) strip.add(field);

  // Each key the plan changes is replaced in a copy, in its place.
  let next = args;
  // `omit` subtracts from either projection: a computed name leaves it (a
  // column it shadows stays omitted), and a column a field reads is read
  // anyway, then removed again.
  if (omit !== undefined) {
    const nextOmit = { ...omit };
    for (const name of visible.keys())
      if (
        omit[name] !== undefined &&
        !Object.hasOwn(model["~"].state.scalars, name)
      )
        delete nextOmit[name];
    for (const field of reads)
      if (omit[field] === true) nextOmit[field] = false;
    next = { ...next, omit: nextOmit };
  }
  if (select !== undefined) {
    const nextSelect: Row = { ...nextProjection };
    for (const name of visible.keys()) delete nextSelect[name];
    for (const field of reads) nextSelect[field] = true;
    if (!Object.values(nextSelect).some((value) => value !== false)) {
      const [first] = projectableScalarNames(model);
      if (first !== undefined) {
        nextSelect[first] = true;
        if (!kept(first)) strip.add(first);
      }
    }
    next = { ...next, select: nextSelect };
  } else if (nextProjection !== projection) {
    next = { ...next, include: nextProjection };
  }

  return {
    args: next,
    node: {
      fields: declared,
      outputs: wanted,
      reads: [...reads],
      strip: [...strip],
      relations: nested,
    },
  };
}

function finishValue(value: unknown, node: ResultNode): unknown {
  if (Array.isArray(value)) return value.map((row) => finishRow(row, node));
  return finishRow(value, node);
}

/**
 * A copy of one row, its relations finished, the columns read only for a
 * field removed, and each field an enumerable getter, as Prisma's are: it is
 * computed on first read, once, from the values the call read (the row as
 * fetched, never the copy its caller may change: a JSON, date, list or binary
 * value a field reads is copied here, before the caller can edit it, and
 * only then), so a `compute` that throws
 * throws where the field is read and never fails the operation, nor a write
 * that already committed. A field assigned before it is read keeps the value
 * assigned.
 */
function finishRow(value: unknown, node: ResultNode): unknown {
  if (!isRecord(value)) return value;
  const row: Row = { ...value };
  for (const [key, child] of node.relations) {
    if (row[key] !== undefined) row[key] = finishValue(row[key], child);
  }
  for (const key of node.strip) delete row[key];
  let fetched: Row = value;
  for (const column of node.reads) {
    const held = value[column];
    if (held === null || typeof held !== "object") continue;
    if (fetched === value) fetched = { ...value };
    fetched[column] = detached(held);
  }
  const values = new Map<number, unknown>();
  const computed = (index: number): unknown => {
    if (values.has(index)) return values.get(index);
    const field = node.fields[index]!;
    const input: Row = {};
    for (const need of field.needs) {
      if (typeof need === "number")
        input[node.fields[need]!.name] = computed(need);
      else input[need] = fetched[need];
    }
    const result = field.compute(input);
    values.set(index, result);
    return result;
  };
  for (const index of node.outputs) {
    const name = node.fields[index]!.name;
    const settle = (settled: unknown) => {
      Object.defineProperty(row, name, {
        value: settled,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      return settled;
    };
    Object.defineProperty(row, name, {
      get: () => settle(computed(index)),
      set: settle,
      enumerable: true,
      configurable: true,
    });
  }
  return row;
}

/**
 * A copy of a value the caller could edit: JSON objects and lists, dates and
 * binary or numeric arrays. A class instance (a `Decimal`) is immutable and
 * shared.
 */
function detached(held: unknown): unknown {
  if (held === null || typeof held !== "object") return held;
  if (Array.isArray(held)) return held.map(detached);
  if (held instanceof Date) return new Date(held.getTime());
  // The typed arrays' own `slice`, read here and not at module scope: a
  // top-level read is a side effect every bundle importing viborm would keep.
  // No provider row holds a `DataView`: a view is a typed array.
  if (ArrayBuffer.isView(held))
    return (
      Object.getPrototypeOf(Uint8Array.prototype).slice as (
        this: ArrayBufferView
      ) => ArrayBufferView
    ).call(held);
  const prototype = Object.getPrototypeOf(held);
  if (prototype !== Object.prototype && prototype !== null) return held;
  const copy: Row = {};
  // A plain object past the checks above: a record of values.
  for (const key in held) copy[key] = detached((held as Row)[key]);
  return copy;
}

/**
 * A chain's computed fields, and what plans one call: the payload the engine
 * runs, and the function that finishes its value; `undefined` when nothing
 * the operation returns has a computed field.
 */
export interface ResultFields {
  readonly fields: ResolvedResultFields;
  readonly plan: (
    relations: ResolvedRelationIndex,
    model: AnyModel,
    operation: string,
    args: Row
  ) =>
    | { readonly args: Row; readonly finish: (value: unknown) => unknown }
    | undefined;
}

/**
 * `fields`: fields computed from each row a call returns. Joined, the
 * chain's computed fields with this extension's appended: per model,
 * `$allModels` first, then the model's own, so a model's field can replace
 * or need an `$allModels` one. Every need is resolved here, against the
 * model's readable scalars and the fields before it; a model the schema
 * does not hold is refused, as a field computed on no row would otherwise
 * be.
 */
export function fieldsPart(
  declared: Readonly<
    Record<string, Readonly<Record<string, ComputedFieldDeclaration>>>
  >
): ExtensionPart {
  return {
    join({ next, name: extension, schema }) {
      for (const key of Object.keys(declared))
        if (key !== ALL_MODELS && !Object.hasOwn(schema, key))
          extensionError(
            `Extension "${extension}" result names unknown model "${key}".`,
            extension
          );
      const fields: Record<string, readonly ResolvedComputedField[]> = {
        ...next.fields?.fields,
      };
      for (const modelName of Object.keys(schema)) {
        const model = schema[modelName]!;
        const resolved = [...(fields[modelName] ?? [])];
        const readable = new Set(projectableScalarNames(model));
        for (const key of [ALL_MODELS, modelName]) {
          for (const [name, { needs = {}, compute }] of Object.entries(
            declared[key] ?? {}
          )) {
            const at = `Extension "${extension}" result.${key}.${name}`;
            if (
              name === "_count" ||
              Object.hasOwn(model["~"].state.relations, name)
            )
              extensionError(
                `${at} cannot be computed: "${name}" is a relation of model "${modelName}".`,
                extension
              );
            const needed = Object.keys(needs)
              .filter((need) => needs[need])
              .map((need) => {
                for (let earlier = resolved.length - 1; earlier >= 0; earlier--)
                  if (resolved[earlier]!.name === need) return earlier;
                if (readable.has(need)) return need;
                return extensionError(
                  `${at} needs "${need}", which is not a readable scalar or an earlier computed field of model "${modelName}".`,
                  extension
                );
              });
            resolved.push({ name, compute, needs: needed });
          }
        }
        if (resolved.length > 0) fields[modelName] = resolved;
      }
      next.fields = {
        fields,
        plan: (relations, model, operation, args) => {
          const returnsRows =
            PROJECTING_OPERATIONS.has(operation) ||
            (BULK_OPERATIONS.has(operation) &&
              (args.select !== undefined || args.omit !== undefined));
          if (!returnsRows) return undefined;
          const planned = planNode(fields, relations, model, args);
          if (planned === undefined) return undefined;
          const { node } = planned;
          return {
            // Planned from `args`, never absent: only a relation's may be.
            args: planned.args!,
            finish: (value) => finishValue(value, node),
          };
        },
      };
    },
  };
}
