// A domain predicate (an extension's `rows`) names values the call supplies
// and conditions on them. While one is admitted, every value position of the
// `where` schemas asks the admission what its value stands for, and every
// `where` asks what its `$if` stands for: the schemas, which own which place
// is a value and which a filter, are the one judge of where a marker can sit.
// The nodes the admission answers are registered here and kept as they are,
// by identity, so an admitted predicate admits again as itself. Nothing else
// can produce one: the registries are module-private, so a caller's payload
// never carries a node.

import type { VibSchema } from "../types";
import { isRecord } from "../value-guards";
import { withoutFilterDepthBound } from "./filter-depth";
import { createSchema, fail, ok, validateSchema } from "./helpers";

/** What a domain predicate's admission makes of the markers it meets. */
export interface DomainMarkers {
  /** The node a value stands for (a call value), `undefined` for a literal. */
  value(value: unknown): object | undefined;
  /** The node a `$if` stands for, or why it is refused. */
  condition(spec: unknown): object | string;
  /**
   * The node an `$exists` stands for, or why it is refused, at a path
   * inside it. Absent: the key is not a marker (an unknown key).
   */
  exists?(
    spec: unknown
  ):
    | object
    | { readonly message: string; readonly path: readonly PropertyKey[] };
}

/** The key that holds a condition in a filter: no field name starts with `$`. */
const CONDITION = "$if";
/** The key that holds an existence check of another model's rows. */
const EXISTS = "$exists";

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
 * admitted, reads its `$if` as one, conjoined with the filter it sits beside.
 * Wrapped in place: a `where` reaches itself through `AND`/`OR`/`NOT`, so
 * every nested position keeps one.
 */
export function conditionNodeOr<S extends VibSchema<any, any>>(where: S): S {
  const standard = where["~standard"];
  const validate = standard.validate;
  const admit = (value: unknown) => {
    const markers = admitting;
    const condition = isRecord(value) && Object.hasOwn(value, CONDITION);
    const exists =
      isRecord(value) &&
      markers?.exists !== undefined &&
      Object.hasOwn(value, EXISTS);
    if (!(markers && (condition || exists))) return validate(value);
    const {
      [CONDITION]: spec,
      [EXISTS]: existence,
      ...filter
    } = value as Record<string, unknown>;
    if (!exists && Object.hasOwn(value as object, EXISTS))
      filter[EXISTS] = existence;
    const nodes: object[] = [];
    if (condition) {
      const node = markers.condition(spec);
      if (typeof node === "string") return fail(node, [CONDITION]);
      nodes.push(node);
    }
    if (exists) {
      const node = markers.exists!(existence);
      if ("message" in node && "path" in node)
        return fail(node.message as string, [EXISTS, ...node.path]);
      nodes.push(node);
    }
    for (const node of nodes) conditions.add(node);
    return Object.keys(filter).length === 0 && nodes.length === 1
      ? ok(nodes[0])
      : validate({
          AND: [
            ...(Object.keys(filter).length === 0 ? [] : [filter]),
            ...nodes,
          ],
        });
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
