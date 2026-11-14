/**
 * `rule({ [model]: entry })`: what binds every caller of a model, per model.
 * The leaves are the ORM's own `where`, checked once where the extension is
 * applied by the model's `where` schema (`admission.ts`), with the words of
 * `rule-words.ts` where a value or a filter goes. The part reads the keys it
 * owns, the filters by role and the confinements; every other value is a
 * word that carries what applies it (`judge-words.ts`), which rows a write
 * may take and an entry given lazily included, called where it is written
 * and never named here.
 */
import type { Schema } from "@client/types";
import { isPlainRecord } from "@schema/relation/terminal";
import type { VerbsDraft } from "./admission";
import type {
  AnyTarget,
  ExactEntries,
  FromSchema,
  ModelName,
  Part,
  RuleFacts,
  RuleInput,
} from "./contract";
import { extensionError } from "./definition";
import { builtPart, type DefinitionDraft } from "./extension";
import { rulePart } from "./rows";
import { CarriedValue } from "./rule-words";

type Entry = Readonly<Record<string, unknown>>;

const RULE_KEYS = new Set([
  "read",
  "root",
  "related",
  "create",
  "update",
  "delete",
  "acyclic",
  "confine",
]);

const isPlain = isPlainRecord;
const own = (value: unknown): Entry => (isPlain(value) ? value : {});
/** A filter list as written, copied: one filter or several. */
export const listOf = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? [...value] : [value];

/** The keys of an entry that hold a word, by the key holding them. */
const WORD_SLOTS = [
  ["create", ["check"]],
  ["update", ["where", "check"]],
  ["delete", ["where", "instead"]],
] as const;

/**
 * One entry's keys beyond its filters as a draft, each word called where it
 * is written: `undefined` where it holds none. Inside an entry given lazily
 * (`lazy`), its `read.where` is one of them.
 */
export function draftOf(
  entry: unknown,
  model: string,
  schema: Schema,
  draft: DefinitionDraft,
  refuse: (problem: string) => never,
  lazy: boolean
): VerbsDraft | undefined {
  let verbs: VerbsDraft | undefined;
  const join = (value: unknown, key: string, field?: string): void => {
    if (value === undefined) return;
    if (!(value instanceof CarriedValue))
      refuse(
        `${key} is written ${key.endsWith("where") ? "only(where)" : "with a word"}`
      );
    value.join({
      model,
      key,
      field,
      schema,
      draft,
      lazy,
      verbs: () => (verbs ??= {}),
      refuse,
    });
  };
  // `lazy(() => entry)`: it brings what reads the entry later.
  if (entry instanceof CarriedValue) {
    join(entry, "the entry");
    return;
  }
  if (!isPlain(entry))
    return refuse(
      typeof entry === "function"
        ? "an entry given as a function is written lazy(() => entry)"
        : "an entry is an object"
    );
  for (const key of Object.keys(entry))
    if (!RULE_KEYS.has(key)) refuse(`"${key}" is not a rule key`);
  const read = own(entry.read);
  if (lazy && read.where !== undefined) (verbs ??= {}).read = read.where;
  for (const map of ["fields", "select"] as const)
    for (const [key, word] of Object.entries(own(read[map])))
      join(word, `read.${map}.${key}`, key);
  for (const [slot, keys] of WORD_SLOTS)
    for (const key of keys) join(own(entry[slot])[key], `${slot}.${key}`);
  const { state } = schema[model]!["~"];
  for (const [field, slot] of Object.entries(own(own(entry.update).fields))) {
    if (
      !(
        Object.hasOwn(state.scalars, field) ||
        Object.hasOwn(state.relations, field)
      )
    )
      refuse(`update.fields names unknown field "${field}"`);
    if (!isPlain(slot)) refuse(`update.fields.${field} is { where?, check? }`);
    join(slot.where, `update.fields.${field}.where`, field);
    join(slot.check, `update.fields.${field}.check`, field);
  }
  if (
    !lazy &&
    read.where !== undefined &&
    (verbs?.as !== undefined || verbs?.reads !== undefined)
  )
    verbs.shown = read.where;
  const { acyclic } = entry;
  if (acyclic !== undefined) {
    if (!(Array.isArray(acyclic) || typeof acyclic === "function"))
      refuse("acyclic lists relations, or is a function returning them");
    // A loop is refused where the row an update produces is judged.
    if (verbs?.judge === undefined)
      refuse(
        "acyclic is judged with the rows a write produces: write a check() on the model beside it"
      );
    verbs.acyclic = acyclic as VerbsDraft["acyclic"];
  }
  return verbs;
}

/** One rule part's entries, written on its extension's layer. */
function writeRule(
  draft: DefinitionDraft,
  entries: Entry,
  schema: Schema
): void {
  const { name } = draft;
  // Every rule part of one extension writes one layer, made at its first.
  const layer = (draft.rule ??= {
    root: {},
    related: {},
    verbs: {},
    confine: {},
  });
  for (const [model, entry] of Object.entries(entries)) {
    if (!Object.hasOwn(schema, model))
      extensionError(
        `Extension "${name}" rule names unknown model "${model}".`,
        name
      );
    const refuse = (problem: string): never =>
      extensionError(`Extension "${name}" rule.${model}: ${problem}.`, name);
    const verbs = draftOf(entry, model, schema, draft, refuse, false);
    const written = own(entry);
    const { where } = own(written.read);
    for (const purpose of ["root", "related"] as const) {
      const items = listOf(written[purpose]);
      if (where !== undefined) items.unshift(where);
      if (items.length > 0)
        layer[purpose][model] = [...(layer[purpose][model] ?? []), ...items];
    }
    if (verbs !== undefined) {
      if (Object.hasOwn(layer.verbs, model))
        refuse("two rule parts of one extension judge the model");
      layer.verbs[model] = verbs;
    }
    if (written.confine !== undefined) layer.confine[model] = written.confine;
  }
}

/**
 * What binds every caller of the models named: filters, checks, gated
 * fields, projections and kept rows. Given a function of the schema, it is
 * read where the extension is applied (an extension that depends on the
 * schema is written apart from any client).
 */
export function rule<T extends AnyTarget, const R = RuleInput<T>>(
  rules: R &
    (RuleInput<T> | FromSchema<T, RuleInput<T>>) &
    NoInfer<ExactEntries<R, RuleInput<T>>>
): Part<T, RuleFacts<R, ModelName<T>>>;
export function rule(rules: Entry | ((schema: Schema) => Entry)): unknown {
  return builtPart([rulePart], (draft, schema) =>
    writeRule(
      draft,
      typeof rules === "function" ? rules(schema) : rules,
      schema
    )
  );
}
