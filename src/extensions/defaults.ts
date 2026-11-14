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
import { getModelKeyCatalog } from "@schema/model/keys";
import type { ExtensionPart } from "./chain";
import type {
  AnyTarget,
  DefaultsFacts,
  DefaultsInput,
  EmptyFacts,
  Exact,
  OmittedWord,
  Part,
  SchemaOf,
} from "./contract";
import type { DataContribution, OrderContribution } from "./controls";
import { extensionError } from "./definition";
import { builtPart, type DefinitionDraft } from "./extension";
import { rowsPart } from "./rows-part";
import { hostValue } from "./rows-translation";

/** `omitted`'s value. */
class OmittedValue {}

/** The field leaves a model's default results; `omit: { f: false }` or a `select` brings it back. */
export const omitted: OmittedWord = /* @__PURE__ */ omittedValue();
function omittedValue(): OmittedWord;
function omittedValue(): unknown {
  return Object.freeze(new OmittedValue());
}

const DIRECTIONS = new Set(["asc", "desc"]);
const UNORDERED_SCALARS = new Set(["json", "vector", "point", "blob"]);

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
    const scalars = schema[model]!["~"].state.scalars;
    const fields = (kind: string, given: unknown): Record<string, unknown> => {
      if (!isPlain(given)) refuse(`${kind} is an object of fields`);
      const out: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(given)) {
        if (!Object.hasOwn(scalars, field))
          refuse(`${kind} names unknown field "${field}"`);
        out[field] = hostValue(value);
      }
      return out;
    };
    for (const key of Object.keys(entry))
      if (!["orderBy", "create", "update", "fields"].includes(key))
        refuse(`"${key}" is not a defaults key`);
    if (entry.create !== undefined || entry.update !== undefined)
      (data.models as Record<string, object>)[model] = {
        ...data.models[model],
        ...(entry.create === undefined
          ? {}
          : { create: fields("create", entry.create) }),
        ...(entry.update === undefined
          ? {}
          : { update: fields("update", entry.update) }),
      };
    if (entry.orderBy !== undefined) {
      const terms = Array.isArray(entry.orderBy)
        ? entry.orderBy
        : [entry.orderBy];
      // Its reads end with the model's key, so the order is total.
      if (getModelKeyCatalog(schema[model]!).rowKey === undefined)
        refuse("orderBy needs a model with a key");
      const admitted = terms.map((term: unknown) => {
        const [field, ...others] = isPlain(term) ? Object.keys(term) : [];
        const state =
          field !== undefined && Object.hasOwn(scalars, field)
            ? scalars[field]!["~"].state
            : undefined;
        if (
          others.length > 0 ||
          state === undefined ||
          state.array ||
          UNORDERED_SCALARS.has(state.type) ||
          !DIRECTIONS.has(String((term as Record<string, unknown>)[field!]))
        )
          refuse(
            'orderBy is { field: "asc" | "desc" } terms over its ordered scalars'
          );
        return Object.freeze({ ...(term as Record<string, "asc" | "desc">) });
      });
      if (admitted.length === 0) refuse("orderBy names a term");
      (order.models as Record<string, object>)[model] = Object.freeze(admitted);
    }
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

/** Whether an entry omits a field: then the part brings what omits it. */
const omits = (entry: unknown): boolean =>
  isPlain(entry) && entry.fields !== undefined;
/** Whether an entry writes or orders: then the part brings what does. */
const stamps = (entry: unknown): boolean =>
  isPlain(entry) &&
  (entry.create !== undefined ||
    entry.update !== undefined ||
    entry.orderBy !== undefined);

/**
 * What holds where the caller says nothing: the order of reads, the fields
 * writes stamp, the fields results leave out. Given a function of the
 * schema, it is read where the extension is applied.
 */
export function defaults<T extends AnyTarget, const D = DefaultsInput<T>>(
  defaults: D & DefaultsInput<T> & NoInfer<Exact<D, DefaultsInput<T>>>
): Part<T, DefaultsFacts<D>>;
export function defaults<T extends AnyTarget>(
  build: (schema: SchemaOf<T>) => Readonly<Record<string, object>>
): Part<T, EmptyFacts>;
export function defaults(
  entries:
    | Readonly<Record<string, unknown>>
    | ((schema: Schema) => Readonly<Record<string, unknown>>)
): unknown {
  const lazy = typeof entries === "function";
  const host: ExtensionPart[] = [];
  if (lazy || Object.values(entries).some(stamps)) host.push(rowsPart);
  if (lazy || Object.values(entries).some(omits)) host.push(omitPart);
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
): unknown {
  return builtPart(host, (draft, schema) =>
    writeDefaults(
      draft,
      typeof entries === "function" ? entries(schema) : entries,
      schema
    )
  );
}
