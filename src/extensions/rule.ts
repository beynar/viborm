/**
 * `rule({ [model]: entry })`: what binds every caller of a model, per model.
 * The leaves are the ORM's own `where`, checked once where the extension is
 * applied by the model's `where` schema (`admission.ts`), with the words of
 * `rule-words.ts` where a value or a filter goes. The part reads the keys it
 * owns, the filters by role and which rows a write may take; every other
 * value is a word that carries what applies it (`judge-words.ts`), called
 * where it is written and never named here.
 */
import type { Schema } from "@client/types";
import { isPlainRecord } from "@schema/relation/terminal";
import type { RuleLayer, VerbsDraft } from "./admission";
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
import { ArgTestFilter, CarriedValue } from "./rule-words";

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
const listOf = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * One entry's keys beyond its filters as a draft, each word called where it
 * is written: `undefined` where it holds none. Inside an entry given as a
 * function (`lazy`), its `read.where` is one of them.
 */
export function draftOf(
  entry: unknown,
  model: string,
  schema: Schema,
  draft: DefinitionDraft,
  refuse: (problem: string) => never,
  lazy: boolean
): VerbsDraft | undefined {
  if (!isPlain(entry)) return refuse("an entry is an object or a function");
  for (const key of Object.keys(entry))
    if (!RULE_KEYS.has(key)) refuse(`"${key}" is not a rule key`);
  let verbs: VerbsDraft | undefined;
  const made = () => (verbs ??= {});
  const join = (value: unknown, key: string, field?: string) => {
    if (value === undefined) return;
    if (!(value instanceof CarriedValue))
      refuse(`${key} is written with a word`);
    value.join({
      model,
      key,
      ...(field !== undefined && { field }),
      schema,
      draft,
      lazy,
      verbs: made,
      refuse,
    });
  };
  const { state } = schema[model]!["~"];
  const read = own(entry.read);
  if (lazy && read.where !== undefined) made().read = read.where;
  for (const [field, word] of Object.entries(own(read.fields)))
    join(word, `read.fields.${field}`, field);
  for (const [key, word] of Object.entries(own(read.select)))
    join(word, `read.select.${key}`, key);
  join(own(entry.create).check, "create.check");
  const update = own(entry.update);
  if (update.where !== undefined) made().update = update.where;
  join(update.check, "update.check");
  for (const [field, slot] of Object.entries(own(update.fields))) {
    if (
      !(
        Object.hasOwn(state.scalars, field) ||
        Object.hasOwn(state.relations, field)
      )
    )
      refuse(`update.fields names unknown field "${field}"`);
    if (!isPlain(slot)) refuse(`update.fields.${field} is { where?, check? }`);
    if (slot.where !== undefined)
      made().writes = { ...verbs!.writes, [field]: slot.where };
    join(slot.check, `update.fields.${field}.check`, field);
  }
  const remove = own(entry.delete);
  if (remove.where !== undefined) made().delete = remove.where;
  join(remove.instead, "delete.instead");
  const { acyclic } = entry;
  if (acyclic !== undefined) {
    if (!(Array.isArray(acyclic) || typeof acyclic === "function"))
      refuse("acyclic lists relations, or is a function returning them");
    made().acyclic = acyclic as VerbsDraft["acyclic"];
    // A loop is refused where the row an update produces is judged.
    if (verbs!.judge === undefined)
      refuse(
        "acyclic is judged with the rows a write produces: write a check() on the model beside it"
      );
  }
  return verbs;
}

/** The layer every rule part of one extension writes, made at its first. */
function layerOf(draft: DefinitionDraft): RuleLayer {
  if (draft.rule !== undefined) return draft.rule;
  const layer: RuleLayer = { root: {}, related: {}, verbs: {}, confine: {} };
  draft.rule = layer;
  // Once every part wrote: the argument a mode test reads is the
  // extension's, declared by its `args` part wherever it stands.
  draft.finish.push(() => {
    for (const item of [
      ...Object.values(layer.root),
      ...Object.values(layer.related),
    ].flat()) {
      if (!(item instanceof ArgTestFilter) || item.kind === "provided")
        continue;
      if (item.arg.path !== undefined) continue;
      const spec = draft.args?.[item.arg.name];
      if (
        spec === undefined ||
        !("oneOf" in spec) ||
        spec.default === undefined
      )
        continue;
      layer.mode = {
        name: item.arg.name,
        values: spec.oneOf.map(String),
        fallback: String(spec.default),
      };
      return;
    }
    // An entry given as a function is read later: its filters are decided
    // by the first argument of the extension a value of which picks a mode.
    if (
      !Object.values(layer.verbs).some((entry) => typeof entry === "function")
    )
      return;
    for (const [name, spec] of Object.entries(draft.args ?? {}))
      if ("oneOf" in spec && spec.default !== undefined) {
        layer.mode = {
          name,
          values: spec.oneOf.map(String),
          fallback: String(spec.default),
        };
        return;
      }
  });
  return layer;
}

/** One rule part's entries, written on its extension's layer. */
function writeRule(
  draft: DefinitionDraft,
  entries: Entry,
  schema: Schema
): void {
  const { name } = draft;
  const layer = layerOf(draft);
  for (const [model, entry] of Object.entries(entries)) {
    const refuse: (problem: string) => never = (problem) =>
      extensionError(`Extension "${name}" rule.${model}: ${problem}.`, name);
    if (!Object.hasOwn(schema, model))
      extensionError(
        `Extension "${name}" rule names unknown model "${model}".`,
        name
      );
    const judged = (): void => {
      if (Object.hasOwn(layer.verbs, model))
        refuse("two rule parts of one extension judge the model");
    };
    if (typeof entry === "function") {
      judged();
      const read = () => {
        const given: unknown = Reflect.apply(entry, undefined, []);
        const written = own(given);
        if (written.confine !== undefined)
          refuse("an entry given as a function holds no confine");
        const verbs = draftOf(given, model, schema, draft, refuse, true) ?? {};
        const root = listOf(written.root);
        const related = listOf(written.related);
        return root.length + related.length === 0
          ? verbs
          : { ...verbs, root, related };
      };
      layer.verbs[model] = read;
      continue;
    }
    const verbs = draftOf(entry, model, schema, draft, refuse, false);
    // `draftOf` refused an entry that is no object.
    const written = own(entry);
    const { where } = own(written.read);
    const root = [...listOf(written.root)];
    const related = [...listOf(written.related)];
    if (where !== undefined) {
      root.unshift(where);
      related.unshift(where);
    }
    if (root.length > 0)
      layer.root[model] = [...(layer.root[model] ?? []), ...root];
    if (related.length > 0)
      layer.related[model] = [...(layer.related[model] ?? []), ...related];
    if (verbs !== undefined) {
      judged();
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
