/**
 * `defaults({ [model]: { orderBy?, create?, update?, fields? } })`: what
 * holds where the caller says nothing, and the caller may override: the
 * order a read takes without `orderBy`, the fields a create or an update
 * writes where the caller leaves them out, and the fields a result leaves
 * out by default (`fields: { passwordHash: omitted }`).
 *
 * Until the rows host reads defaults as they are, the part writes the
 * `data` and `order` members it reads (a temporary translation).
 */
import { omitPart } from "@client/default-omit-identity";
import type { ClientOmitConfig } from "@client/omit";
import type { Schema } from "@client/types";
import type { ExtensionPart } from "./chain";
import type {
  AnyTarget,
  DefaultsFacts,
  DefaultsInput,
  EmptyFacts,
  ExactEntries,
  FromSchema,
  ModelName,
  OmittedWord,
  Part,
} from "./contract";
import type { DataContribution, OrderContribution } from "./controls";
import { extensionError } from "./definition";
import { builtPart, type DefinitionDraft } from "./extension";
import { defaultOrderPart } from "./order";
import { hostValue } from "./rows-translation";
import { defaultDataPart } from "./stamps";

/** `omitted`'s value. */
class OmittedValue {}

/** The field leaves a model's default results; `omit: { f: false }` or a `select` brings it back. */
export const omitted: OmittedWord = /* @__PURE__ */ omittedValue();
function omittedValue(): OmittedWord;
function omittedValue(): unknown {
  return Object.freeze(new OmittedValue());
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function writeDefaults(
  draft: DefinitionDraft,
  entries: Readonly<Record<string, unknown>>,
  schema: Schema
): void {
  const { name } = draft;
  const data: Mutable<DataContribution> = {
    models: { ...draft.data?.models },
  };
  const order: Mutable<OrderContribution> = {
    models: { ...draft.order?.models },
  };
  const omit: ClientOmitConfig<Schema> = { ...draft.omit };
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
    if (!isPlain(entry)) refuse("an entry is an object");
    // The data and order parts check the fields and terms against the model.
    const fields = (given: unknown) =>
      hostValue(given) as Record<string, unknown>;
    for (const key of Object.keys(entry))
      if (!["orderBy", "create", "update", "fields"].includes(key))
        refuse(`"${key}" is not a defaults key`);
    if (entry.create !== undefined || entry.update !== undefined)
      (data.models as Record<string, object>)[model] = {
        ...data.models[model],
        ...(entry.create === undefined ? {} : { create: fields(entry.create) }),
        ...(entry.update === undefined ? {} : { update: fields(entry.update) }),
      };
    if (entry.orderBy !== undefined)
      (order.models as Record<string, unknown>)[model] = entry.orderBy;
    if (entry.fields !== undefined) {
      if (!isPlain(entry.fields)) refuse("fields is an object");
      const own: Partial<Record<string, true>> = { ...omit[model] };
      for (const [field, word] of Object.entries(entry.fields)) {
        // A field it cannot omit is refused by the client's own omission.
        if (!(word instanceof OmittedValue))
          refuse(`fields.${field} is written omitted`);
        own[field] = true;
      }
      omit[model] = own;
    }
  }
  if (Object.keys(data.models).length > 0) draft.data = data;
  if (Object.keys(order.models).length > 0) draft.order = order;
  if (Object.keys(omit).length > 0) draft.omit = omit;
}

/** Whether an entry holds one of `keys`: then the part brings what reads it. */
const has = (entry: unknown, ...keys: string[]): boolean =>
  isPlain(entry) && keys.some((key) => entry[key] !== undefined);

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
  entries:
    | Readonly<Record<string, unknown>>
    | ((schema: Schema) => Readonly<Record<string, unknown>>)
): unknown {
  const lazy = typeof entries === "function";
  const host: ExtensionPart[] = [];
  const given = lazy ? [] : Object.values(entries);
  if (lazy || given.some((entry) => has(entry, "create", "update")))
    host.push(defaultDataPart);
  if (lazy || given.some((entry) => has(entry, "orderBy")))
    host.push(defaultOrderPart);
  if (lazy || given.some((entry) => has(entry, "fields"))) host.push(omitPart);
  return buildDefaults(entries, host);
}

/**
 * `defaults` untyped: what an official extension builds its defaults with,
 * typed by its own entry point rather than by an inferred target, and with
 * the host parts it names (what stamps and orders, what omits): it carries
 * no other.
 */
export function buildDefaults(
  entries:
    | Readonly<Record<string, unknown>>
    | ((schema: Schema) => Readonly<Record<string, unknown>>),
  host: readonly ExtensionPart[]
): Part<AnyTarget, EmptyFacts>;
export function buildDefaults(
  entries:
    | Readonly<Record<string, unknown>>
    | ((schema: Schema) => Readonly<Record<string, unknown>>),
  host: readonly ExtensionPart[]
): unknown {
  return builtPart(host, (draft, schema) =>
    writeDefaults(
      draft,
      typeof entries === "function" ? entries(schema) : entries,
      schema
    )
  );
}
