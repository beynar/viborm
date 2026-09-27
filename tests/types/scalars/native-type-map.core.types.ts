/**
 * Issue #45 — the public type surface of a native type per dialect.
 *
 * Every probe enters through the public API spelled as a user spells it —
 * `s` from "viborm", the constants and `NativeTypeMap` from "viborm/schema" —
 * and each refusal of an unknown key sits BESIDE a real one, fresh and held in
 * a variable (the root guide's contextual-typing rules). A value with no real
 * key at all is probed HELD in a variable too: a fresh one is refused by the
 * weak-type rule alone, which is what hid the first version's hole — a map
 * generic constrained to the weak `NativeTypeMap` fell back to it and admitted
 * any object held in a variable.
 */

import { s } from "@src/index";
import {
  MYSQL,
  type NativeType,
  type NativeTypeMap,
  PG,
  SQLITE,
} from "@src/schema/exports";
import type { InferInput } from "@validation";

// =============================================================================
// THE ISSUE'S SPELLING, ON EVERY FACTORY THAT TAKES A NATIVE TYPE
// =============================================================================

const issueMap = {
  pg: PG.STRING.CITEXT,
  mysql: MYSQL.STRING.LONGTEXT,
  sqlite: SQLITE.STRING.TEXT,
};

export const acceptedMaps = [
  s.string({
    pg: PG.STRING.CITEXT,
    mysql: MYSQL.STRING.LONGTEXT,
    sqlite: SQLITE.STRING.TEXT,
  }),
  s.string(issueMap),
  s.string({ mysql: MYSQL.STRING.LONGTEXT }),
  s.int({ pg: PG.INT.SMALLINT, mysql: MYSQL.INT.SMALLINT_UNSIGNED }),
  s.number({ pg: PG.FLOAT.REAL, mysql: MYSQL.FLOAT.FLOAT }),
  s.bigInt({ mysql: MYSQL.BIGINT.BIGINT_UNSIGNED }),
  s.boolean({ pg: PG.BOOLEAN.BOOLEAN }),
  s.dateTime({
    pg: PG.DATETIME.TIMESTAMP(3),
    mysql: MYSQL.DATETIME.DATETIME(6),
    sqlite: SQLITE.DATETIME.INTEGER,
  }),
  s.date({ pg: PG.DATETIME.DATE, mysql: MYSQL.DATETIME.DATE }),
  s.time({ pg: PG.DATETIME.TIME(3), mysql: MYSQL.DATETIME.TIME(3) }),
  s.json({ pg: PG.JSON.JSON, sqlite: SQLITE.JSON.TEXT }),
  s.blob({ mysql: MYSQL.BLOB.VARBINARY(255), pg: PG.BLOB.BYTEA }),
  s.vector({ pg: PG.STRING.TEXT }),
  s.enum(["a", "b"], { pg: PG.STRING.TEXT, mysql: MYSQL.STRING.VARCHAR(8) }),
];

/** A variable annotated with the public map type is a map. */
const annotated: NativeTypeMap = { pg: PG.STRING.CITEXT };
export const fromAnnotated = s.string(annotated);

/** Either form, through a variable or a helper's parameter. */
declare const eitherForm: NativeType | NativeTypeMap;
export const fromEither = s.string(eitherForm);
export const forwardEither = (native?: NativeType | NativeTypeMap) =>
  s.int(native);
export const forwardMap = (native: NativeTypeMap) => s.bigInt(native);
declare const choose: boolean;
export const eitherByCondition = s.enum(
  ["a", "b"],
  choose ? { pg: PG.STRING.TEXT } : MYSQL.STRING.VARCHAR(3)
);

// =============================================================================
// THE TAGGED SHORTHAND STILL COMPILES EXACTLY AS BEFORE
// =============================================================================

type SqliteDateTime = (typeof SQLITE.DATETIME)[keyof typeof SQLITE.DATETIME];
declare const anyForm: SqliteDateTime;
declare const anyNative: NativeType;
declare const maybeNative: NativeType | undefined;
const annotatedLegacy = { db: "mysql", type: "TEXT", note: "legacy" } as const;

export const forwardGeneric = <T extends NativeType>(native: T) =>
  s.string(native);
export const forwardShorthand = (native?: NativeType) => s.int(native);

export const acceptedShorthands = [
  s.string(choose ? PG.STRING.CITEXT : undefined),
  s.string(choose ? PG.STRING.CITEXT : MYSQL.STRING.LONGTEXT),
  s.string(PG.STRING.CITEXT),
  s.string(PG.STRING.VARCHAR(80)),
  s.string({ db: "pg", type: 'text COLLATE "C"' }),
  s.string(anyNative),
  s.string(maybeNative),
  s.string(annotatedLegacy),
  s.string(),
  s.dateTime(anyForm),
  s.enum(["a", "b"], MYSQL.STRING.VARCHAR(10)),
];

// =============================================================================
// REFUSALS
// =============================================================================

// An unknown dialect beside a real one: fresh, then held in a variable.
export const unknownFresh = s.string({
  pg: PG.STRING.CITEXT,
  // @ts-expect-error - 'oracle' is not a dialect
  oracle: PG.STRING.TEXT,
});
const unknownHeld = { pg: PG.STRING.CITEXT, oracle: PG.STRING.TEXT };
// @ts-expect-error - 'oracle' is not a dialect, in a map held in a variable
export const unknownNonFresh = s.string(unknownHeld);
export const unknownEnum = s.enum(["a"], {
  pg: PG.STRING.TEXT,
  // @ts-expect-error - the same refusal on the enum factory's second argument
  oracel: PG.STRING.TEXT,
});

// A parameterized constant keeps its dialect, so it fills only its own entry.
export const wrongDialectParameterized = s.string({
  // @ts-expect-error - a MySQL constant is not a pg entry
  pg: MYSQL.STRING.VARCHAR(80),
});
export const wrongDialectBesideReal = s.string({
  pg: PG.STRING.TEXT,
  // @ts-expect-error - a PG constant is not a mysql entry
  mysql: PG.STRING.VARCHAR(80),
});
// @ts-expect-error - a SQLite constant is not a pg entry of s.dateTime
export const wrongDialectDateTime = s.dateTime({ pg: SQLITE.DATETIME.INTEGER });

// A tagged value beside a dialect key is two declarations at once.
export const mixedFresh = s.string({
  db: "pg",
  type: "text",
  // @ts-expect-error - a tagged native type cannot also carry a dialect entry
  mysql: MYSQL.STRING.LONGTEXT,
});
const mixedHeld = {
  db: "pg",
  type: "text",
  mysql: MYSQL.STRING.LONGTEXT,
} as const;
// @ts-expect-error - the same, held in a variable
export const mixedNonFresh = s.string(mixedHeld);

// @ts-expect-error - a map names at least one dialect
export const emptyMap = s.string({});
const emptyHeld = {};
// @ts-expect-error - the same, held in a variable
export const emptyMapHeld = s.string(emptyHeld);

// A value with no dialect key is no map, so it must be a whole tagged value.
// Each is held in a variable, where the weak-type rule does not apply.
const unknownOnly = { postgres: PG.STRING.CITEXT };
// @ts-expect-error - no dialect key at all
export const unknownOnlyHeld = s.string(unknownOnly);
const unknownOnlyEnum = { postgres: PG.STRING.TEXT } as const;
// @ts-expect-error - the same on the enum factory's second argument
export const unknownOnlyEnumHeld = s.enum(["a"], unknownOnlyEnum);
const twoUnknown = { postgres: PG.DATETIME.DATE, maria: MYSQL.DATETIME.DATE };
// @ts-expect-error - two unknown keys
export const twoUnknownHeld = s.dateTime(twoUnknown);
const unrelated = { foo: 1 };
// @ts-expect-error - an unrelated object
export const unrelatedHeld = s.string(unrelated);
const withoutDb = { type: "text" };
// @ts-expect-error - a tagged value without its db
export const withoutDbHeld = s.int(withoutDb);
const misspelledType = { db: "pg" as const, typ: "citext" };
// @ts-expect-error - a misspelled `type`: before, it compiled and crashed serializeModels
export const misspelledTypeHeld = s.string(misspelledType);
const misspelledOnVector = { db: "pg" as const, tpe: "vector" };
// @ts-expect-error - the same on s.vector
export const misspelledVector = s.vector(misspelledOnVector);
declare const aDate: Date;
// @ts-expect-error - a Date
export const dateHeld = s.string(aDate);
// @ts-expect-error - a dimension is not a native type
export const vectorDimension = s.vector(3);
declare const weakOrUnrelated: NativeTypeMap | { foo: number };
// @ts-expect-error - a union member that is no map is refused on its own
export const weakOrUnrelatedHeld = s.string(weakOrUnrelated);
declare const optionalUnknown: {
  pg?: typeof PG.STRING.TEXT;
  oracle?: typeof PG.STRING.TEXT;
};
// @ts-expect-error - an optional unknown key is still an unknown key
export const optionalUnknownHeld = s.string(optionalUnknown);

// The shorthand keeps main's refusals: an unknown db, and a fresh extra key.
// @ts-expect-error - 'oracle' is not a dialect
export const unknownDb = s.string({ db: "oracle", type: "x" });
export const freshExtraKey = s.string({
  db: "pg",
  type: "citext",
  // @ts-expect-error - excess property on a fresh tagged value, as before
  length: 40,
});

// The two scalars without a native type take no map either.
// @ts-expect-error - a fixed decimal derives its column from its domain
export const decimalMap = s.decimal({ pg: PG.STRING.TEXT });
// @ts-expect-error - GeoPoint takes no argument
export const pointMap = s.point({ pg: PG.STRING.TEXT });

// Measured limit (TS 7.0.2): the at-least-one-dialect test cannot distribute
// over a union (a distributive bound is a circular constraint, TS2313), so a
// union of maps with no dialect key IN COMMON is refused. The annotation above
// (`NativeTypeMap`) is the spelling that compiles; a union of maps sharing a
// key, or of a map and a tagged value, compiles as it is.
declare const sharedKey:
  | { pg: typeof PG.STRING.TEXT }
  | { pg: typeof PG.STRING.CITEXT; mysql: typeof MYSQL.STRING.TEXT };
export const unionSharingAKey = s.string(sharedKey);
declare const unionOfMaps:
  | { pg: typeof PG.STRING.TEXT }
  | { mysql: typeof MYSQL.STRING.TEXT };
// @ts-expect-error - pinned limit, see above
export const unionMapLimit = s.string(unionOfMaps);

// =============================================================================
// DIALECT-NARROWED CONSTANTS, AND UNCHANGED LOGICAL INFERENCE
// =============================================================================

export const narrowed: { readonly db: "pg"; readonly type: string } =
  PG.STRING.VARCHAR(80);
// @ts-expect-error - a pg constant is not a mysql native type
export const notMysql: { readonly db: "mysql"; readonly type: string } =
  PG.STRING.VARCHAR(80);

const nullableBody = s.string(issueMap).nullable();
type NullableBody = InferInput<(typeof nullableBody)["~"]["state"]["base"]>;
export const bodyText: NullableBody = "text";
export const bodyNull: NullableBody = null;
// @ts-expect-error - the map changes storage, not the logical type
export const bodyNumber: NullableBody = 1;

const stamp = s.dateTime({ sqlite: SQLITE.DATETIME.INTEGER }).now();
export const stampKind: "now" = stamp["~"].state.autoGenerate.kind;

// =============================================================================
// RECURSIVE MODELS KEEP INFERRING
// =============================================================================

const account = s.model({
  id: s
    .string({ pg: PG.BLOB.BYTEA, mysql: MYSQL.STRING.VARCHAR(36) })
    .uuid()
    .id(),
  handle: s.string(issueMap).unique(),
  invitedById: s
    .string({ pg: PG.BLOB.BYTEA, mysql: MYSQL.STRING.VARCHAR(36) })
    .nullable(),
  invitedBy: s
    .toOne(() => account)
    .name("invite")
    .fields("invitedById")
    .references("id"),
  invited: s.toMany(() => account).name("invite"),
});
export const recursiveHandle: "handle" extends keyof (typeof account)["~"]["state"]["scalars"]
  ? true
  : false = true;
