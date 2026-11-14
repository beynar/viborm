/**
 * What a `rule` writes, as the rows host reads it: until that host reads a
 * rule as it is, a rule's entries are translated to the rows member it
 * reads (`rows` with its modes, `verbs` with named predicates, `confine`,
 * `deletion`), once per schema. A temporary translation: `rule.ts` holds the
 * builder.
 */
import type { Schema } from "@client/types";
import { isPlainRecord } from "@schema/relation/terminal";
import type { ExtensionPart } from "./chain";
import type { AnyTarget, EmptyFacts, Part } from "./contract";
import type {
  DeletionContribution,
  RowsContribution,
  RowsVerbs,
} from "./controls";
import { extensionError } from "./definition";
import { builtPart, type DefinitionDraft } from "./extension";
import { Kept } from "./judge-words";
import { filtersPart } from "./rows";
import {
  ArgTestFilter,
  ArgValue,
  ExistsFilter,
  NowValue,
  RowValue,
} from "./rule-words";

type Where = Readonly<Record<string, unknown>>;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const isPlain = isPlainRecord;

/** A test of an argument as a `$if` condition reads it. */
function conditionOf(filter: ArgTestFilter): Where {
  const { test } = filter;
  return {
    control: filter.arg.name,
    ...(filter.arg.path === undefined ? {} : { path: filter.arg.path }),
    ...(isPlain(test) ? test : { equals: test }),
  };
}

/**
 * A rule's value, with every word as the rows host reads it: `arg` a
 * control reference, `now` the call's instant, `row` an enclosing column,
 * `exists` an existence, and `when`, `unless` and `provided` conditions.
 */
export function hostValue(value: unknown): unknown {
  if (value instanceof ArgValue)
    return value.path === undefined
      ? { control: value.name }
      : { control: value.name, path: value.path };
  if (value instanceof NowValue) return { now: true };
  if (value instanceof RowValue) return { $row: value.column, up: value.up };
  if (value instanceof ExistsFilter) return { $exists: hostValue(value.spec) };
  if (value instanceof ArgTestFilter) {
    const condition = { $if: conditionOf(value) };
    if (value.kind === "provided")
      return value.then === undefined
        ? condition
        : { AND: [condition, hostValue(value.then)] };
    return {
      OR: [
        value.kind === "when" ? { NOT: condition } : condition,
        hostValue(value.then),
      ],
    };
  }
  if (Array.isArray(value)) return value.map(hostValue);
  if (!isPlain(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = hostValue(item);
  return out;
}

/** What one extension's rule parts have written so far, per model. */
/** What translates an entry's judging keys to a `verbs` entry (`rule.ts`). */
export interface VerbsTranslation {
  readonly entry: (
    entry: Record<string, unknown>,
    scalars: readonly string[],
    refuse: (problem: string) => never
  ) => RowsVerbs | undefined;
  /** An entry given as a function: translated when its model is first read. */
  readonly lazy: (
    entry: () => unknown,
    scalars: readonly string[],
    refuse: (problem: string) => never
  ) => () => RowsVerbs;
}

interface RulesState {
  /** The argument whose value picks a mode, and its values. */
  mode?: {
    readonly name: string;
    readonly values: readonly string[];
    readonly fallback: string;
  };
  readonly root: Map<string, unknown[]>;
  readonly related: Map<string, unknown[]>;
  readonly verbs: Record<string, RowsVerbs | (() => RowsVerbs)>;
  readonly confine: Record<string, Where>;
  deletion?: Mutable<DeletionContribution>;
}

const states = new WeakMap<DefinitionDraft, RulesState>();

const listOf = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** A `when` or `unless` on the mode argument: it decides per mode, not per call. */
function modeTest(
  item: unknown,
  mode: RulesState["mode"]
): ArgTestFilter | undefined {
  return item instanceof ArgTestFilter &&
    item.kind !== "provided" &&
    item.arg.path === undefined &&
    item.arg.name === mode?.name
    ? item
    : undefined;
}

/** Whether a mode-argument test holds for one mode. */
function holds(filter: ArgTestFilter, mode: string): boolean {
  const { test } = filter;
  const passed = isPlain(test)
    ? "in" in test && Array.isArray(test.in)
      ? test.in.includes(mode)
      : "equals" in test
        ? test.equals === mode
        : "exists" in test
          ? test.exists === true
          : false
    : test === mode;
  return filter.kind === "when" ? passed : !passed;
}

/** The items of a filter list that hold in `mode`, as one `where`. */
function filterIn(
  items: readonly unknown[],
  mode: string | undefined,
  state: RulesState
): Where {
  const applied: unknown[] = [];
  for (const item of items) {
    const tested = modeTest(item, state.mode);
    if (tested === undefined) applied.push(hostValue(item));
    else if (mode !== undefined && holds(tested, mode))
      applied.push(hostValue(tested.then));
  }
  if (applied.length === 0) return {};
  if (applied.length === 1 && isPlain(applied[0])) return applied[0];
  return { AND: applied };
}

/** The first argument a `when` or `unless` tests that can pick a mode. */
function modeOf(
  draft: DefinitionDraft,
  entries: readonly unknown[]
): RulesState["mode"] {
  for (const item of entries) {
    if (!(item instanceof ArgTestFilter) || item.kind === "provided") continue;
    if (item.arg.path !== undefined) continue;
    const spec = draft.args?.[item.arg.name];
    if (spec === undefined || !("oneOf" in spec) || spec.default === undefined)
      continue;
    return {
      name: item.arg.name,
      values: spec.oneOf.map(String),
      fallback: String(spec.default),
    };
  }
  return undefined;
}

/** One rule part written on the draft: its entries, per model. */
function writeRule(
  draft: DefinitionDraft,
  entries: Readonly<Record<string, unknown>>,
  schema: Schema,
  judge: VerbsTranslation | undefined,
  host: readonly ExtensionPart[]
): void {
  const { name } = draft;
  let state = states.get(draft);
  if (state === undefined) {
    state = { root: new Map(), related: new Map(), verbs: {}, confine: {} };
    states.set(draft, state);
    const written = state;
    // Before the arguments are placed: the mode argument is the rows'.
    draft.finish.unshift(() => finishRules(draft, written));
  }
  const filters: unknown[] = [];
  for (const [model, entry] of Object.entries(entries)) {
    const refuse: (problem: string) => never = (problem) =>
      extensionError(`Extension "${name}" rule.${model}: ${problem}.`, name);
    if (!Object.hasOwn(schema, model))
      extensionError(
        `Extension "${name}" rule names unknown model "${model}".`,
        name
      );
    const scalars = Object.keys(schema[model]!["~"].state.scalars);
    // What judges rows is the rule builder's to bring: an official extension
    // whose rules only filter is built without it, and writes no such key.
    const translated = (own: Record<string, unknown>) =>
      judge?.entry(own, scalars, refuse);
    if (typeof entry === "function") {
      if (judge === undefined)
        refuse("an entry given as a function is written with rule()");
      if (Object.hasOwn(state.verbs, model))
        refuse("two rule parts of one extension judge the model");
      state.verbs[model] = judge.lazy(
        () => Reflect.apply(entry, undefined, []),
        scalars,
        refuse
      );
      continue;
    }
    if (!isPlain(entry)) refuse("an entry is an object or a function");
    for (const key of Object.keys(entry))
      if (
        ![
          "read",
          "root",
          "related",
          "create",
          "update",
          "delete",
          "acyclic",
          "confine",
        ].includes(key)
      )
        refuse(`"${key}" is not a rule key`);
    const read = isPlain(entry.read) ? entry.read : {};
    const own = [...listOf(entry.root)];
    const related = [...listOf(entry.related)];
    if (read.where !== undefined) {
      own.unshift(read.where);
      related.unshift(read.where);
    }
    if (own.length > 0)
      state.root.set(model, [...(state.root.get(model) ?? []), ...own]);
    if (related.length > 0)
      state.related.set(model, [
        ...(state.related.get(model) ?? []),
        ...related,
      ]);
    filters.push(...own, ...related);
    const verbs = translated(entry);
    if (verbs !== undefined) {
      if (Object.hasOwn(state.verbs, model))
        refuse("two rule parts of one extension judge the model");
      state.verbs[model] = verbs;
    }
    if (entry.confine !== undefined)
      state.confine[model] = hostValue(entry.confine) as Where;
    const remove = isPlain(entry.delete) ? entry.delete : {};
    if (remove.instead !== undefined) {
      const kept = remove.instead;
      if (!(kept instanceof Kept))
        refuse("delete.instead is written keep(data)");
      // What keeps deleted rows comes with `keep` in an entry written out.
      if (!host.includes(kept.host))
        refuse("keep() is written in an entry, not one given as a function");
      kept.write({
        model,
        args: draft.args,
        deletion: () => (state.deletion ??= { models: {} }),
        refuse,
      });
    }
  }
  state.mode ??= modeOf(draft, filters);
}

/** The rows member and the deletion every rule part of the extension wrote. */
function finishRules(draft: DefinitionDraft, state: RulesState): void {
  if (state.deletion !== undefined) draft.deletion = state.deletion;
  const filtered = state.root.size > 0 || state.related.size > 0;
  if (
    !filtered &&
    Object.keys(state.verbs).length === 0 &&
    Object.keys(state.confine).length === 0
  )
    return;
  // A rule with no mode argument filters in one mode, under a control no
  // call passes: the rows host reads a member with a control.
  const mode = state.mode ?? {
    name: `~${draft.name}`,
    values: ["on"],
    fallback: "on",
  };
  const models: Record<string, Record<string, Where>> = {};
  for (const model of new Set([
    ...state.root.keys(),
    ...state.related.keys(),
  ])) {
    const modes: Record<string, Where> = {};
    for (const value of mode.values) {
      // A mode that filters nothing names no filter, as a 1.14 mode did.
      const root = filterIn(state.root.get(model) ?? [], value, state);
      const related = filterIn(state.related.get(model) ?? [], value, state);
      modes[value] = {
        ...(Object.keys(root).length === 0 ? {} : { root }),
        ...(Object.keys(related).length === 0 ? {} : { related }),
      };
    }
    models[model] = modes;
  }
  const rows: Mutable<RowsContribution> = {
    control: mode.name,
    default: mode.fallback,
    models: models as RowsContribution["models"],
  };
  if (Object.keys(state.verbs).length > 0) rows.verbs = state.verbs;
  if (Object.keys(state.confine).length > 0) rows.confine = state.confine;
  draft.rows = rows;
}

/** Whether an entry holds what only judging rows applies. */
export const judges = (entry: unknown): boolean =>
  typeof entry === "function" ||
  (isPlain(entry) &&
    (entry.create !== undefined ||
      entry.update !== undefined ||
      (isPlain(entry.delete) && entry.delete.where !== undefined) ||
      entry.acyclic !== undefined ||
      entry.confine !== undefined ||
      (isPlain(entry.read) &&
        (entry.read.fields !== undefined || entry.read.select !== undefined))));

/**
 * `rule` untyped: what an official extension builds its rule with, typed by
 * its own entry point rather than by an inferred target, with the host parts
 * it is handed beside the filters' (what judges rows, what keeps deleted
 * rows): an extension whose rules only filter carries neither.
 */
export function buildRule(
  rules:
    | Readonly<Record<string, unknown>>
    | ((schema: Schema) => Readonly<Record<string, unknown>>),
  host: readonly ExtensionPart[],
  translate?: VerbsTranslation
): Part<AnyTarget, EmptyFacts>;
export function buildRule(
  rules:
    | Readonly<Record<string, unknown>>
    | ((schema: Schema) => Readonly<Record<string, unknown>>),
  host: readonly ExtensionPart[],
  translate?: VerbsTranslation
): unknown {
  return builtPart([filtersPart, ...host], (draft, schema) =>
    writeRule(
      draft,
      typeof rules === "function" ? rules(schema) : rules,
      schema,
      translate,
      host
    )
  );
}
