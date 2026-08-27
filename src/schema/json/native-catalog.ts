// The closed per-dialect native-type catalog.
//
// `native.type` is the ONE document string a migration driver emits into DDL
// verbatim — the three drivers write `nativeType.type` as a column's type with
// no escaping, because a coded schema takes it from a typed constant. A document
// is written by whoever hands you one, so this boundary decides what may occupy
// that position. The round-1 answer was a word grammar; the reviewer proved it
// cannot work: `TEXT REFERENCES victims(id)`, `TEXT UNIQUE` and `TEXT CHECK(0)`
// are letters and spaces with an optional parenthesized group, indistinguishable
// from a multi-word type name, yet each appends a CONSTRAINT to a column in DDL.
// No regex over arbitrary SQL words separates a type from a clause.
//
// So the admissible set is CLOSED and derived, per dialect, from the one owner
// that already enumerates native types: the shipped `PG`/`MYSQL`/`SQLITE`
// constant trees. Derivation, not duplication —
//
//   - a string leaf (`{ db, type: "text" }`) contributes its EXACT value;
//   - a function leaf (a parameterized type) is probe-called at zero, one and
//     two integer arguments to learn its base name and which argument arities it
//     publishes; the catalog then admits that base bare, or with one or two
//     INTEGER arguments, at exactly those arities.
//
// The trees produce no word-argument type THROUGH A FUNCTION — `geometry(Point)`
// is a string leaf, matched exactly — so there is no word-argument rule, which
// is the narrowest rule the trees justify. A coded schema is unaffected: its
// native type is one of these constants, so it is a catalog member by
// construction. Both directions of the boundary (reader and serializer) consult
// this one owner; nothing downstream sanitizes native types, and nothing can.

import {
  MYSQL,
  type NativeType,
  PG,
  SQLITE,
} from "@schema/scalars/native-types";

type Dialect = NativeType["db"];

type DialectCatalog = {
  /** The exact type strings every string leaf produces. */
  readonly exact: Set<string>;
  /** A parameterized base name → the argument arities it publishes (0 = bare). */
  readonly templates: Map<string, Set<number>>;
};

/** Distinct non-zero probe arguments, so a produced form is unambiguous. */
const PROBE_ARGUMENTS: readonly number[][] = [[], [1], [1, 2]];

/** A parameterized-type argument the trees produce: a non-negative integer. */
const INTEGER_ARGUMENT = /^\d+$/;

/**
 * A native type at the matching boundary: a base identifier, optionally followed
 * by one parenthesized group of comma-separated integers. This gate REJECTS
 * everything a clause needs — a quote, a space, a semicolon, a comment, a second
 * group, a non-integer argument — so what survives is only shaped like a type,
 * and the catalog then decides whether it IS one.
 */
const TYPE_EXPRESSION = /^[A-Za-z_][A-Za-z0-9_]*(\(\d+(,\d+)*\))?$/;

const CONSTANT_NAMES: Record<Dialect, string> = {
  pg: "PG",
  mysql: "MYSQL",
  sqlite: "SQLITE",
};

const CATALOGS: Record<Dialect, DialectCatalog> = buildCatalogs();

/**
 * Whether `type` is a native type the declared dialect's catalog admits. The
 * gate's single statement, used by the reader and the serializer alike.
 */
export function isNativeTypeInCatalog(db: Dialect, type: string): boolean {
  const catalog = CATALOGS[db];
  if (catalog.exact.has(type)) {
    return true;
  }
  if (!TYPE_EXPRESSION.test(type)) {
    return false;
  }
  const open = type.indexOf("(");
  if (open === -1) {
    return catalog.templates.get(type)?.has(0) === true;
  }
  const base = type.slice(0, open);
  const arity = type.slice(open + 1, -1).split(",").length;
  return catalog.templates.get(base)?.has(arity) === true;
}

/**
 * The refusal both directions carry, naming the dialect whose catalog was
 * consulted and pointing at the documented list.
 */
export function nativeTypeRefusal(db: Dialect): string {
  return `A \`native.type\` is written into DDL verbatim, so a document may carry only a native type from the '${db}' dialect's closed catalog — the values the ${CONSTANT_NAMES[db]} native-type constants produce. See the native types documentation (docs/schema/native-types).`;
}

function buildCatalogs(): Record<Dialect, DialectCatalog> {
  const catalogs: Record<Dialect, DialectCatalog> = {
    pg: emptyCatalog(),
    mysql: emptyCatalog(),
    sqlite: emptyCatalog(),
  };
  walk(PG, catalogs.pg);
  walk(MYSQL, catalogs.mysql);
  walk(SQLITE, catalogs.sqlite);
  return catalogs;
}

function emptyCatalog(): DialectCatalog {
  return { exact: new Set(), templates: new Map() };
}

// The trees are trusted, shipped constants — objects, categories and function
// leaves, never a primitive or null — so this walk reads their shape directly.
// The node type is `any` because a walk over a heterogeneous tree erases the
// leaf types, and narrowing back to them would need the casts the house forbids.
function walk(node: any, catalog: DialectCatalog): void {
  if (typeof node === "function") {
    deriveFunction(node, catalog);
    return;
  }
  const type = node.type;
  if (typeof type === "string") {
    catalog.exact.add(type);
    return;
  }
  for (const value of Object.values(node)) {
    walk(value, catalog);
  }
}

/** A parameterized-type leaf, called generically — hence the erased type. */
function deriveFunction(factory: any, catalog: DialectCatalog): void {
  for (const args of PROBE_ARGUMENTS) {
    const type: string = factory(...args).type;
    const open = type.indexOf("(");
    if (open === -1) {
      admit(catalog, type, 0);
      continue;
    }
    // A required-argument function called with too few produces `base(undefined)`
    // — never a value the constant yields — so a non-integer argument is skipped.
    const parts = type.slice(open + 1, -1).split(",");
    if (parts.every((part) => INTEGER_ARGUMENT.test(part))) {
      admit(catalog, type.slice(0, open), parts.length);
    }
  }
}

function admit(catalog: DialectCatalog, base: string, arity: number): void {
  const arities = catalog.templates.get(base);
  if (arities === undefined) {
    catalog.templates.set(base, new Set([arity]));
    return;
  }
  arities.add(arity);
}
