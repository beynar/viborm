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
}

/** The key that holds a condition in a filter: no field name starts with `$`. */
const CONDITION = "$if";

const values = new WeakSet<object>();
const conditions = new WeakSet<object>();

/** The admission in progress, while a domain predicate is parsed. */
let admitting: DomainMarkers | undefined;

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
  Object.defineProperty(standard, "validate", {
    value: (value: unknown) => {
      if (typeof value === "object" && value !== null && conditions.has(value))
        return ok(value);
      if (!(admitting && isRecord(value) && Object.hasOwn(value, CONDITION)))
        return validate(value);
      const { [CONDITION]: spec, ...filter } = value;
      const node = admitting.condition(spec);
      if (typeof node === "string") return fail(node, [CONDITION]);
      conditions.add(node);
      return Object.keys(filter).length === 0
        ? ok(node)
        : validate({ AND: [filter, node] });
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
  admit: () => T
): T {
  const previous = admitting;
  admitting = markers;
  try {
    return withoutFilterDepthBound(admit);
  } finally {
    admitting = previous;
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
