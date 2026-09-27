// The closed per-dialect native-type catalog, and the scalar factories' one
// native-type admission.
//
// A native type's `type` is the ONE declaration string a migration driver emits
// into DDL verbatim — the three drivers write it as a column's type with no
// escaping, because a coded schema takes it from a typed constant. A schema
// document is written by whoever hands you one, and a native-type MAP is new
// surface with no legacy to keep, so both decide what may occupy that position
// here. The round-1 answer was a word grammar; the reviewer proved it cannot
// work: `TEXT REFERENCES victims(id)`, `TEXT UNIQUE` and `TEXT CHECK(0)` are
// letters and spaces with an optional parenthesized group, indistinguishable
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
// is the narrowest rule the trees justify. A coded schema's constants are
// catalog members by construction. The schema-document reader and serializer
// consult this owner for the tagged `native` form; `admitNativeType` consults it
// for every map entry. A TAGGED declaration written in code keeps its historical
// open contract (a custom `{ db, type }` still reaches DDL as written) — only a
// document refuses one outside the catalog. Nothing downstream sanitizes native
// types, and nothing can.
//
// This lives beside `native-types.ts` rather than in the document module because
// the scalar factories need it; it imports the constant trees, so the trees'
// module cannot import it back.

import { ValidationError } from "@errors";
import { isRecord } from "@validation/value-guards";
import {
  type DialectNativeType,
  isTaggedNativeType,
  MYSQL,
  NATIVE_DIALECTS,
  type NativeDialect,
  type NativeTypeDeclaration,
  type NativeTypeMap,
  PG,
  SQLITE,
} from "./native-types";

type Dialect = NativeDialect;

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

// =============================================================================
// SCALAR FACTORY ADMISSION
// =============================================================================

/** The one construction-time refusal of a native-type argument. */
function refuse(builder: string, path: string, message: string): never {
  throw new ValidationError({ kind: "schema-builder", builder, path }, [
    { path, message },
  ]);
}

/**
 * A scalar factory's native-type argument, admitted: the declaration the scalar
 * stores and every modifier carries.
 *
 * The tagged shorthand is returned AS GIVEN — its open historical contract,
 * custom spellings and unrelated extra keys included, is unchanged — once it
 * names one of the three dialects as `db` and a string `type` (a value that does
 * not would be silently ignored by every dialect, or reach DDL as `undefined`),
 * and unless it also carries a dialect key, which makes it two declarations at
 * once. A map is the new form and is
 * held to its whole contract here, where types can be bypassed: only the three
 * dialect keys, at least one of them, each an OWN entry of its own dialect whose
 * type the catalog admits. It is then SNAPSHOT into a frozen map of frozen
 * `{ db, type }` entries, so the caller's object — or an entry it shares with
 * another declaration — can change afterwards without changing this scalar.
 */
export function admitNativeType(
  builder: string,
  declaration: NativeTypeDeclaration | undefined
): NativeTypeDeclaration | undefined {
  if (declaration === undefined) return undefined;
  if (!isRecord(declaration)) {
    refuse(
      builder,
      "nativeType",
      "A native type is a `{ db, type }` constant or a map of them by dialect (`{ pg, mysql, sqlite }`)"
    );
  }
  if (isTaggedNativeType(declaration)) {
    const { db, type } = declaration;
    if (!NATIVE_DIALECTS.includes(db) || typeof type !== "string") {
      refuse(
        builder,
        "nativeType",
        `A tagged native type is \`{ db, type }\`: \`db\` one of ${NATIVE_DIALECTS.join(", ")} and \`type\` a string`
      );
    }
    const beside = NATIVE_DIALECTS.find((dialect) =>
      Object.hasOwn(declaration, dialect)
    );
    if (beside !== undefined) {
      refuse(
        builder,
        `nativeType.${beside}`,
        `A tagged native type ('db: ${db}') cannot also carry a '${beside}' entry: declare one tagged type, or a map by dialect (\`{ pg, mysql, sqlite }\`)`
      );
    }
    return declaration;
  }
  return admitNativeTypeMap(builder, declaration);
}

function admitNativeTypeMap(
  builder: string,
  map: NativeTypeMap
): NativeTypeMap {
  for (const key of Object.keys(map)) {
    if (!NATIVE_DIALECTS.some((dialect) => dialect === key)) {
      refuse(
        builder,
        `nativeType.${key}`,
        `'${key}' is not a dialect: a native-type map names only ${NATIVE_DIALECTS.join(", ")}`
      );
    }
  }
  const snapshot: {
    pg?: DialectNativeType<"pg">;
    mysql?: DialectNativeType<"mysql">;
    sqlite?: DialectNativeType<"sqlite">;
  } = {};
  if (Object.hasOwn(map, "pg")) snapshot.pg = admitEntry(builder, "pg", map.pg);
  if (Object.hasOwn(map, "mysql")) {
    snapshot.mysql = admitEntry(builder, "mysql", map.mysql);
  }
  if (Object.hasOwn(map, "sqlite")) {
    snapshot.sqlite = admitEntry(builder, "sqlite", map.sqlite);
  }
  if (Object.keys(snapshot).length === 0) {
    refuse(
      builder,
      "nativeType",
      "A native-type map names at least one dialect; omit the argument to keep every automatic column"
    );
  }
  return Object.freeze(snapshot);
}

/** One map entry: a native type of exactly its key's dialect, in its catalog. */
function admitEntry<Entry extends Dialect>(
  builder: string,
  dialect: Entry,
  entry: unknown
): DialectNativeType<Entry> {
  const db = isRecord(entry) ? entry.db : undefined;
  const type = isRecord(entry) ? entry.type : undefined;
  if (db !== dialect || typeof type !== "string") {
    refuse(
      builder,
      `nativeType.${dialect}`,
      `The '${dialect}' entry must be a ${CONSTANT_NAMES[dialect]} native type (\`{ db: "${dialect}", type }\`)`
    );
  }
  if (!isNativeTypeInCatalog(dialect, type)) {
    refuse(
      builder,
      `nativeType.${dialect}.type`,
      `'${type}' is not in the '${dialect}' native-type catalog: a map entry must be a value the ${CONSTANT_NAMES[dialect]} native-type constants produce. See the native types documentation (docs/schema/native-types).`
    );
  }
  return Object.freeze({ db: dialect, type });
}

// =============================================================================
// CATALOG CONSTRUCTION
// =============================================================================

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
