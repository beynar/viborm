/**
 * `defaults({ [model]: { orderBy?, create?, update?, fields? } })`: what
 * holds where the caller says nothing, and the caller may override: the
 * order a read takes without `orderBy`, the fields a create or an update
 * writes where the caller leaves them out, and the fields a result leaves
 * out by default (`fields: { passwordHash: omitted }`, the word bringing
 * what omits). A chain whose parts filter nothing reads them on a domain
 * that filters nothing (`plain-domain.ts`).
 */
import { omitPart } from "@client/default-omit-identity";
import type { Schema } from "@client/types";
import {
  type ModelStamps,
  Parameter,
} from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { isPlainRecord } from "@schema/relation/terminal";
import { rebind, refuseUndeclared } from "./call-rows";
import { type ExtensionPart, extensionError, shared } from "./chain";
import type {
  AnyTarget,
  DefaultsFacts,
  DefaultsInput,
  ExactEntries,
  FromSchema,
  ModelName,
  OmittedWord,
  Part,
} from "./contract";
import { orderOf } from "./order";
import { bindPlain } from "./plain-domain";
import { CarriedValue, PredicateWord, type Site } from "./rule-words";
import { Stamps } from "./stamps";

type Entry = Readonly<Record<string, unknown>>;

const DEFAULTS_KEYS = new Set(["orderBy", "create", "update", "fields"]);

/** `omitted`'s value: it brings what omits. */
class Omitted extends CarriedValue {
  join({ key, field, model, bring, refuse }: Site): void {
    if (key !== `fields.${field}`) refuse(`${key} does not take omitted`);
    bring(omitPart(model, field!));
  }
}

/** The field leaves a model's default results; `omit: { f: false }` or a `select` brings it back. */
export const omitted: OmittedWord = /* @__PURE__ */ omittedValue();
function omittedValue(): OmittedWord;
function omittedValue(): unknown {
  return new Omitted();
}

/**
 * One kind's fields as a call writes them, each a constant, the call's
 * instant, or an argument's value (a parameter read per call).
 */
function stampOf(
  given: unknown,
  scalars: Readonly<Record<string, unknown>>,
  refuse: (problem: string) => never
): Input | undefined {
  if (given === undefined) return undefined;
  if (!isPlainRecord(given)) return refuse("data is an object of fields");
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(given)) {
    if (!Object.hasOwn(scalars, field))
      refuse(`names unknown field "${field}"`);
    out[field] =
      value instanceof PredicateWord && value.stamp ? value.stamp() : value;
  }
  return out;
}

/** One kind's fields with an extension's own merged in: it wins a field. */
const merged = (
  previous: Input | undefined,
  fields: Input | undefined
): Input | undefined =>
  fields === undefined ? previous : { ...previous, ...fields };

/** What one defaults part writes of one schema. */
interface Written {
  /** Per model, the order its reads take without one. */
  readonly order: Record<string, readonly Input[]>;
  /** Per model, the fields its creates and updates write. */
  readonly data: Record<string, ModelStamps>;
  /** The parts its words bring (`omitted`). */
  readonly brought: ExtensionPart[];
}

/** One defaults part's entries, read once per schema. */
function writeDefaults(name: string, entries: Entry, schema: Schema): Written {
  const written: Written = { order: {}, data: {}, brought: [] };
  const { order, data, brought } = written;
  for (const [model, entry] of Object.entries(entries)) {
    const refuse: (problem: string) => never = (problem) =>
      extensionError(
        `Extension "${name}" defaults.${model}: ${problem}.`,
        name
      );
    if (!Object.hasOwn(schema, model))
      extensionError(
        `Extension "${name}" defaults names unknown model "${model}".`,
        name
      );
    if (!isPlainRecord(entry)) refuse("an entry is an object");
    for (const key of Object.keys(entry))
      if (!DEFAULTS_KEYS.has(key)) refuse(`"${key}" is not a defaults key`);
    const own = schema[model]!;
    const { scalars } = own["~"].state;
    if (entry.orderBy !== undefined)
      order[model] =
        orderOf(own, entry.orderBy) ??
        refuse(
          'orderBy maps a model with a key to { field: "asc" | "desc" } terms over its ordered scalars'
        );
    for (const kind of ["create", "update"] as const) {
      const stamp = stampOf(entry[kind], scalars, refuse);
      if (stamp === undefined) continue;
      data[model] = {
        ...data[model],
        [kind]: merged(data[model]?.[kind], stamp),
      };
    }
    if (entry.fields === undefined) continue;
    if (!isPlainRecord(entry.fields)) refuse("fields is an object");
    for (const [field, word] of Object.entries(entry.fields)) {
      const key = `fields.${field}`;
      if (!(word instanceof CarriedValue)) refuse(`${key} is written omitted`);
      word.join({
        model,
        key,
        field,
        schema,
        bring: (part) => brought.push(part),
        lazy: false,
        entry: () => refuse(`${key} is written omitted`),
        refuse,
      });
    }
  }
  return written;
}

/**
 * `defaults`: the default order (a later entry for a model replaces one)
 * and the default data (a later one wins a field). The arguments a field
 * names are declared on the chain by its own or an earlier extension.
 */
function defaultsPart(read: (schema: Schema) => Entry): ExtensionPart {
  const part: ExtensionPart = {
    join(application) {
      const { name, next, schema } = application;
      const { order, data, brought } = shared(application, part, () =>
        writeDefaults(name, read(schema), schema)
      );
      for (const omits of brought) application.bring(omits);
      if (Object.keys(order).length > 0)
        next.defaultOrder = { ...next.defaultOrder, ...order };
      if (Object.keys(data).length === 0) return;
      const names: string[] = [];
      const entries: Record<string, ModelStamps> = { ...next.defaultData };
      for (const [model, entry] of Object.entries(data)) {
        const known = entries[model];
        entries[model] = {
          create: merged(known?.create, entry.create),
          update: merged(known?.update, entry.update),
        };
        for (const value of [
          ...Object.values(entry.create ?? {}),
          ...Object.values(entry.update ?? {}),
        ])
          if (value instanceof Parameter && value.arg !== undefined)
            names.push(value.arg);
      }
      refuseUndeclared(application, names);
      next.defaultData = entries;
      next.stamps = new Stamps(next.defaultData);
    },
    seal(application) {
      rebind(application, bindPlain);
    },
  };
  return part;
}

/**
 * What holds where the caller says nothing: the order of reads, the fields
 * writes stamp, the fields results leave out. Given a function of the
 * schema, it is read where the extension is applied.
 */
export function defaults<T extends AnyTarget, const D = DefaultsInput<T>>(
  defaults: D &
    (DefaultsInput<T> | FromSchema<T, DefaultsInput<T>>) &
    NoInfer<ExactEntries<D, DefaultsInput<T>>>
): Part<T, DefaultsFacts<D, ModelName<T>>>;
export function defaults(
  entries: Entry | ((schema: Schema) => Entry)
): unknown {
  return defaultsPart((schema) =>
    typeof entries === "function" ? entries(schema) : entries
  );
}
