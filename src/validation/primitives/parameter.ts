// A domain predicate (an extension's `rule`) names values the call supplies
// and conditions on them. While one is admitted, every value position of the
// `where` schemas asks the admission what its value stands for, and every
// `where` asks what a filter word in its place stands for: the schemas, which
// own which place is a value and which a filter, are the one judge of where a
// word can sit. The nodes the admission answers are registered here and kept
// as they are, by identity, so an admitted predicate admits again as itself.
// Nothing else can produce one: the registries are module-private, so a
// caller's payload never carries a node.

import type { VibSchema } from "../types";
import { withoutFilterDepthBound } from "./filter-depth";
import { createSchema, fail, ok, validateSchema } from "./helpers";

/**
 * What a filter word stands for: `nodes`, kept as they are, and the filter
 * written with them that is parsed in the word's place (the first node
 * itself where there is none); or why the word is refused, at a path inside
 * it.
 */
export type FilterWord =
  | { readonly nodes: readonly object[]; readonly where?: unknown }
  | { readonly message: string; readonly path: readonly PropertyKey[] };

/** What a domain predicate's admission makes of the markers it meets. */
export interface DomainMarkers {
  /** The node a value stands for (a call value), `undefined` for a literal. */
  value(value: unknown): object | undefined;
  /** What a filter word stands for, `undefined` for a value that is none. */
  filter(value: object): FilterWord | undefined;
}

const values = new WeakSet<object>();
const conditions = new WeakSet<object>();

/** The admission in progress, while a domain predicate is parsed. */
let admitting: DomainMarkers | undefined;

/**
 * One admission's parsed filters, per `where` schema and input object. A
 * predicate shares sub-filters freely (a relation's target predicate is
 * inlined wherever it is read), so each shared object is parsed once per
 * schema and its admitted value shared alike. Only successes are kept: a
 * refusal is always reported from the place that reached it.
 */
export type AdmittedFilters = WeakMap<object, WeakMap<object, unknown>>;
let parsed: AdmittedFilters | undefined;

/**
 * The node `value` is, or, while a domain predicate is admitted, the node it
 * stands for; `undefined` for any other value.
 */
export function valueNodeOf(value: unknown): object | undefined {
  if (typeof value === "object" && value !== null && values.has(value))
    return value;
  const node = admitting?.value(value);
  if (node !== undefined) values.add(node);
  return node;
}

/** A value position that also keeps a value node. */
export function valueNodeOr<S extends VibSchema<any, any>>(wrapped: S): S {
  const schema = createSchema<unknown, unknown>("value_node_or", (value) => {
    const node = valueNodeOf(value);
    return node === undefined ? validateSchema(wrapped, value) : ok(node);
  });
  Object.assign(schema, {
    wrapped,
    acceptsUndefined:
      (wrapped as { acceptsUndefined?: boolean }).acceptsUndefined === true,
  });
  return schema as unknown as S;
}

/**
 * A `where` that also keeps a condition node, and, while a domain predicate is
 * admitted, reads a filter word in its place as what the word stands for.
 * Wrapped in place: a `where` reaches itself through `AND`/`OR`/`NOT`, so
 * every nested position keeps one.
 */
export function conditionNodeOr<S extends VibSchema<any, any>>(where: S): S {
  const standard = where["~standard"];
  const validate = standard.validate;
  const admit = (value: object) => {
    const word = admitting?.filter(value);
    if (word === undefined) return validate(value);
    if ("message" in word) return fail(word.message, [...word.path]);
    for (const node of word.nodes) conditions.add(node);
    return word.where === undefined ? ok(word.nodes[0]) : validate(word.where);
  };
  Object.defineProperty(standard, "validate", {
    value: (value: unknown) => {
      if (typeof value !== "object" || value === null) return validate(value);
      if (conditions.has(value)) return ok(value);
      const seen = admitting && parsed;
      if (!seen) return admit(value);
      let byValue = seen.get(standard);
      if (byValue === undefined) seen.set(standard, (byValue = new WeakMap()));
      const known = byValue.get(value);
      if (known !== undefined) return known;
      const result = admit(value) as { issues?: unknown };
      if (result.issues === undefined) byValue.set(value, result);
      return result;
    },
  });
  return where;
}

/**
 * Parse with a domain predicate's rules: its markers are `markers`' nodes, it
 * is the application's own finite data, so the caller payload's nesting
 * bound does not apply, and a recursion writes its depth.
 */
export function admittingDomainPredicate<T>(
  markers: DomainMarkers,
  admit: () => T,
  filters: AdmittedFilters = new WeakMap()
): T {
  const previous = admitting;
  const previousFilters = parsed;
  admitting = markers;
  parsed = filters;
  try {
    return withoutFilterDepthBound(admit);
  } finally {
    admitting = previous;
    parsed = previousFilters;
  }
}

/**
 * A filter's `recurse`, which a domain predicate must give a depth: the
 * default one would stop inheritance at a number nobody wrote.
 */
export function writtenDepth<S extends VibSchema<any, any>>(recurrence: S): S {
  const schema = createSchema<unknown, unknown>("written_depth", (value) =>
    admitting &&
    (value === true ||
      (typeof value === "object" &&
        value !== null &&
        (value as { depth?: unknown }).depth === undefined))
      ? fail(
          "A row predicate's recurse must write its depth (false, or a number)"
        )
      : validateSchema(recurrence, value)
  );
  Object.assign(schema, {
    wrapped: recurrence,
    acceptsUndefined:
      (recurrence as { acceptsUndefined?: boolean }).acceptsUndefined === true,
  });
  return schema as unknown as S;
}
