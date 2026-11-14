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
import type { ClientOmitConfig } from "@client/omit";
import type { Schema } from "@client/types";
import {
  type ModelStamps,
  Parameter,
} from "@query-engine/raptor3/shared/row-scope";
import type { Input } from "@query-engine/raptor3/shared/schema";
import { isPlainRecord } from "@schema/relation/terminal";
import { rebind, refuseUndeclared } from "./call-rows";
import type { ExtensionPart } from "./chain";
import type {
  AnyTarget,
  DefaultsFacts,
  DefaultsInput,
  Exact,
  OmittedWord,
  Part,
} from "./contract";
import { extensionError } from "./definition";
import { builtPart, type DefinitionDraft } from "./extension";
import { orderOf } from "./order";
import { bindPlain } from "./plain-domain";
import { ArgValue, CarriedValue, NowValue, type Site } from "./rule-words";
import { NOW, Stamps } from "./stamps";

type Entry = Readonly<Record<string, unknown>>;

const DEFAULTS_KEYS = new Set(["orderBy", "create", "update", "fields"]);

/** `omitted`'s value: it brings what omits. */
class Omitted extends CarriedValue {
  join({ key, field, model, draft, refuse }: Site): void {
    if (key !== `fields.${field}`) refuse(`${key} does not take omitted`);
    const omit: ClientOmitConfig<Schema> = (draft.omit ??= {});
    omit[model] = { ...omit[model], [field!]: true };
    (draft.parts ??= []).push(omitPart);
  }
}

/** The field leaves a model's default results; `omit: { f: false }` or a `select` brings it back. */
export const omitted: OmittedWord = /* @__PURE__ */ omittedValue();
function omittedValue(): OmittedWord;
function omittedValue(): unknown {
  return Object.freeze(new Omitted());
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
      value instanceof NowValue
        ? NOW
        : value instanceof ArgValue
          ? new Parameter(value.name, value.path)
          : value;
  }
  return Object.freeze(out);
}

/** One defaults part's entries, written on its extension's members. */
function writeDefaults(
  draft: DefinitionDraft,
  entries: Entry,
  schema: Schema
): void {
  const { name } = draft;
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
      (draft.order ??= {})[model] =
        orderOf(own, entry.orderBy) ??
        refuse(
          'orderBy maps a model with a key to { field: "asc" | "desc" } terms over its ordered scalars'
        );
    const create = stampOf(entry.create, scalars, refuse);
    const update = stampOf(entry.update, scalars, refuse);
    if (create !== undefined || update !== undefined) {
      const data = (draft.data ??= {});
      const prior = data[model];
      data[model] = Object.freeze({
        create: create ? { ...prior?.create, ...create } : prior?.create,
        update: update ? { ...prior?.update, ...update } : prior?.update,
      });
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
        draft,
        lazy: false,
        verbs: () => refuse(`${key} is written omitted`),
        refuse,
      });
    }
  }
}

/** One kind's fields with an extension's own merged in: it wins a field. */
const merged = (
  previous: Input | undefined,
  fields: Input | undefined
): Input | undefined =>
  fields === undefined ? previous : Object.freeze({ ...previous, ...fields });

/**
 * `defaults`: the default order (a later extension's entry for a model
 * replaces one) and the default data (a later extension wins a field). The
 * arguments a field names are declared on the chain by its own or an
 * earlier extension.
 */
const defaultsPart: ExtensionPart = {
  join(application) {
    const { definition, chain, next } = application;
    const { order, data } = definition;
    if (order !== undefined)
      next.order = Object.freeze({ ...chain?.order, ...order });
    if (data === undefined) return;
    const names: string[] = [];
    const entries: Record<string, ModelStamps> = { ...chain?.data };
    for (const [model, entry] of Object.entries(data)) {
      for (const stamp of [entry.create, entry.update])
        for (const value of Object.values(stamp ?? {}))
          if (value instanceof Parameter && value.control !== undefined)
            names.push(value.control);
      const known = entries[model];
      entries[model] = Object.freeze({
        create: merged(known?.create, entry.create),
        update: merged(known?.update, entry.update),
      });
    }
    refuseUndeclared(application, names);
    next.data = Object.freeze(entries);
    next.stamps = new Stamps(next.data);
  },
  seal(application) {
    rebind(application, bindPlain);
  },
};

/**
 * What holds where the caller says nothing: the order of reads, the fields
 * writes stamp, the fields results leave out. Given a function of the
 * schema, it is read where the extension is applied.
 */
export function defaults<T extends AnyTarget, const D = DefaultsInput<T>>(
  defaults: D & DefaultsInput<T> &
    NoInfer<Exact<D, DefaultsInput<T>>>
): Part<T, DefaultsFacts<D>>;
export function defaults(entries: Entry | ((schema: Schema) => Entry)): unknown {
  return builtPart([defaultsPart], (draft, schema) =>
    writeDefaults(
      draft,
      typeof entries === "function" ? entries(schema) : entries,
      schema
    )
  );
}
