/**
 * A compactly stored identifier offers no text predicate — at the TYPE level.
 *
 * The four compact formats (`uuid`, `uuidv7`, `ulid`, `ksuid`) are stored as
 * the identifier itself: sixteen or twenty bytes, or a PostgreSQL `uuid`.
 * `contains` / `startsWith` / `endsWith` / `mode` ask a question about the TEXT
 * a value is written as, which such a column never stored, so they are gone
 * from the filter type and refused at the engine boundary.
 *
 * WHY THE PROBES READ KEYS RATHER THAN WRITING LITERALS. The obvious probe —
 * a `@ts-expect-error` on `{ equals: "…", contains: "…" }` — measures nothing
 * here, and that is a property of the surface rather than of this narrowing: a
 * scalar filter's type is a UNION (a bare value, a field reference, an SQL
 * fragment, a callback, and the filter object), and TypeScript's excess-property
 * check against such a union does not fire. Measured, not assumed:
 * `{ equals: "x", bogusKey: 1 }` compiles today against an ORDINARY
 * `s.string()` filter, so a `@ts-expect-error` probe would pass whether or not
 * the key was removed. Reading the key SET off the public argument type is the
 * probe that discriminates, and the controls below prove it does: the same
 * expression answers `true` for every surface that keeps the operators.
 *
 * Everything here enters through the public API — `s`, `createClient`,
 * `client.<model>.findMany` — and never an internal schema alias.
 */

import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { createClient } from "@src/index";

const account = s.model({
  id: s.string().id().uuid("usr"),
  ulid: s.string().ulid(),
  ksuid: s.string().ksuid(),
  seventh: s.string().uuidv7(),
  slug: s.string().cuid(),
  short: s.string().nanoid(10),
  key: s.string().id(),
  label: s.string(),
});

const client = createClient({
  schema: { account },
  driver: new PGliteDriver(),
});

type FindManyArgs = NonNullable<Parameters<typeof client.account.findMany>[0]>;
type Where = NonNullable<FindManyArgs["where"]>;

/** The FILTER-OBJECT arm of one field's where surface, and nothing else. */
type FilterObject<Field extends keyof Where> = Extract<
  NonNullable<Where[Field]>,
  { equals?: unknown }
>;

/** Whether a field's filter object offers `Operator`. */
type Offers<
  Field extends keyof Where,
  Operator extends string,
> = Operator extends keyof FilterObject<Field> ? true : false;

/** A compile-time equality assertion with no runtime footprint. */
type Assert<Value extends Expected, Expected> = Value;

// ── Removed on every compact format ────────────────────────────────────────
type UuidHasNoContains = Assert<Offers<"id", "contains">, false>;
type UuidHasNoStartsWith = Assert<Offers<"id", "startsWith">, false>;
type UuidHasNoEndsWith = Assert<Offers<"id", "endsWith">, false>;
type UuidHasNoMode = Assert<Offers<"id", "mode">, false>;
type UlidHasNoContains = Assert<Offers<"ulid", "contains">, false>;
type KsuidHasNoStartsWith = Assert<Offers<"ksuid", "startsWith">, false>;
type UuidV7HasNoEndsWith = Assert<Offers<"seventh", "endsWith">, false>;

// ── Kept: equality, set membership, ordering, and the negation of each ─────
type UuidHasEquals = Assert<Offers<"id", "equals">, true>;
type UuidHasNot = Assert<Offers<"id", "not">, true>;
type UuidHasIn = Assert<Offers<"id", "in">, true>;
type UuidHasNotIn = Assert<Offers<"id", "notIn">, true>;
type UuidHasLt = Assert<Offers<"id", "lt">, true>;
type UuidHasLte = Assert<Offers<"id", "lte">, true>;
type UuidHasGt = Assert<Offers<"id", "gt">, true>;
type UuidHasGte = Assert<Offers<"id", "gte">, true>;

// ── The controls: every surface that KEEPS the four still offers them ──────
type OrdinaryStringHasContains = Assert<Offers<"label", "contains">, true>;
type OrdinaryStringHasMode = Assert<Offers<"label", "mode">, true>;
type CuidHasContains = Assert<Offers<"slug", "contains">, true>;
type NanoidHasStartsWith = Assert<Offers<"short", "startsWith">, true>;
/** A bare `.id()` declares a KEY, not a format: text storage, every operator. */
type BareKeyHasContains = Assert<Offers<"key", "contains">, true>;
type BareKeyHasEndsWith = Assert<Offers<"key", "endsWith">, true>;

/** The surfaces a compact identifier still spells, written as a user writes them. */
const compactIdentifierUsage = () => {
  client.account.findMany({
    where: {
      id: {
        equals: "usr-a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        not: "usr-x",
        in: ["usr-a"],
        notIn: ["usr-b"],
        lt: "usr-c",
        lte: "usr-d",
        gt: "usr-e",
        gte: "usr-f",
      },
      slug: { equals: "tz4a98xxat96iws9zmbrgj3a", contains: "tz4a" },
      short: { startsWith: "V1" },
      label: { endsWith: "z", mode: "insensitive" },
      key: { contains: "anything" },
    },
    orderBy: { id: "asc" },
    cursor: { id: "usr-a" },
  });
};

export type {
  BareKeyHasContains,
  BareKeyHasEndsWith,
  CuidHasContains,
  KsuidHasNoStartsWith,
  NanoidHasStartsWith,
  OrdinaryStringHasContains,
  OrdinaryStringHasMode,
  UlidHasNoContains,
  UuidHasEquals,
  UuidHasGt,
  UuidHasGte,
  UuidHasIn,
  UuidHasLt,
  UuidHasLte,
  UuidHasNot,
  UuidHasNoContains,
  UuidHasNoEndsWith,
  UuidHasNoMode,
  UuidHasNoStartsWith,
  UuidHasNotIn,
  UuidV7HasNoEndsWith,
};
export { compactIdentifierUsage };
