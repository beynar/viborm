import { s } from "@schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

/**
 * PACKAGE H — **the to-one composition lattice, one witness per decision.**
 *
 * `to-one-mutation-schema.ts` counts the ACTIVE intents of a to-one payload and then
 * asks one question of them: is this composition on the accepted list for this
 * relation's direction. Every branch of that answer is driven here through the real
 * registry schemas rather than through the predicate, because the interesting half of
 * each row is which SURFACE owns which keys — a create root has no `update`, a required
 * relation has no vacate, and the direction is decided from `.fields()`.
 *
 * This file owns the LATTICE and nothing else; `parity-h-to-one-lattice.test.ts` owns
 * what the engine then compiles, and `vacate-then-supply.test.ts` owns what a live
 * database ends up holding. Almost everything the lattice accepts now executes —
 * residual Package E took the last engine refusal, so `create` / `connectOrCreate`
 * beside an `update` runs as a supplier plus a one-member record-series continuation.
 * What is still admitted here and refused elsewhere is `delete` beside a CONNECT and a
 * modify, which the own-write ledger declines because `delete: true` names a row the
 * analyzer cannot tell apart from the one that modify's construction-time selector
 * reads. Accepted below therefore means "this shape is coherent", never "this shape
 * runs" — that refusal is pinned verbatim in those two files.
 */
const lattice = (() => {
  const owner = s
    .model({
      id: s.string().id(),
      name: s.string(),
      /** Child-held: the badge row carries the foreign key. */
      badge: s.oneToOne(() => badge).optional(),
      deskId: s.string().nullable(),
      /** Parent-held: this row carries the foreign key. */
      desk: s
        .manyToOne(() => desk)
        .fields("deskId")
        .references("id")
        .optional(),
      /** Parent-held and REQUIRED: no vacate key exists on this surface at all. */
      zoneId: s.string(),
      zone: s
        .manyToOne(() => zone)
        .fields("zoneId")
        .references("id"),
    })
    .map("h_lattice_owners");
  const badge = s
    .model({
      id: s.string().id(),
      tag: s.string(),
      ownerId: s.string().unique().nullable(),
      owner: s
        .oneToOne(() => owner)
        .fields("ownerId")
        .references("id")
        .optional(),
    })
    .map("h_lattice_badges");
  const desk = s
    .model({
      id: s.string().id(),
      label: s.string(),
      owners: s.oneToMany(() => owner),
    })
    .map("h_lattice_desks");
  const zone = s
    .model({
      id: s.string().id(),
      code: s.string(),
      owners: s.oneToMany(() => owner),
    })
    .map("h_lattice_zones");
  return { badge, desk, owner, zone };
})();

const registry = createSchemaRegistry(lattice);
/** Child-held to-one update: the direction that composes freely. */
const childHeld = registry.proxy.owner.relations.badge.update;
/** Parent-held to-one update: the direction that folds to one foreign-key value. */
const parentHeld = registry.proxy.owner.relations.desk.update;
/** Parent-held and required: neither vacate key is spellable. */
const requiredParentHeld = registry.proxy.owner.relations.zone.update;
/** The create root: no `update` key, so no composition is spellable. */
const childHeldCreate = registry.proxy.owner.relations.badge.create;

const CONNECT = { id: "b-alt" };
const CREATE = { id: "b9", tag: "fresh" };
const CONNECT_OR_CREATE = {
  where: { id: "b-alt" },
  create: { id: "b-alt", tag: "n" },
};
const UPDATE = { tag: "t" };
const DESK_CONNECT = { id: "d-alt" };
const DESK_CREATE = { id: "d9", label: "fresh" };
const DESK_CONNECT_OR_CREATE = {
  where: { id: "d-alt" },
  create: { id: "d-alt", label: "n" },
};
const DESK_UPDATE = { label: "l" };

const refusalOf = (
  schema: StandardSchemaV1,
  input: unknown
): string | undefined => parse(schema, input).issues?.[0]?.message;

describe("H — the child-held direction composes supplier, modify, and one vacate", () => {
  test.each([
    ["connect + update", { connect: CONNECT, update: UPDATE }],
    [
      "connectOrCreate + update",
      { connectOrCreate: CONNECT_OR_CREATE, update: UPDATE },
    ],
    ["create + update", { create: CREATE, update: UPDATE }],
    [
      "disconnect + connect + update",
      { disconnect: true, connect: CONNECT, update: UPDATE },
    ],
    [
      "disconnect + create + update",
      { disconnect: true, create: CREATE, update: UPDATE },
    ],
    [
      "disconnect + connectOrCreate + update",
      { disconnect: true, connectOrCreate: CONNECT_OR_CREATE, update: UPDATE },
    ],
    [
      "delete + connect + update",
      { delete: true, connect: CONNECT, update: UPDATE },
    ],
    [
      "delete + create + update",
      { delete: true, create: CREATE, update: UPDATE },
    ],
  ])("accepts %s", (_label, input) => {
    expect(refusalOf(childHeld, input)).toBeUndefined();
  });

  test("the five replacements keep composing without a modify", () => {
    expect(
      refusalOf(childHeld, { disconnect: true, connect: CONNECT })
    ).toBeUndefined();
    expect(
      refusalOf(childHeld, { disconnect: true, create: CREATE })
    ).toBeUndefined();
    expect(
      refusalOf(childHeld, {
        disconnect: true,
        connectOrCreate: CONNECT_OR_CREATE,
      })
    ).toBeUndefined();
    expect(
      refusalOf(childHeld, { delete: true, connect: CONNECT })
    ).toBeUndefined();
    expect(
      refusalOf(childHeld, { delete: true, create: CREATE })
    ).toBeUndefined();
  });

  test.each([
    [
      "two suppliers name two identities for one slot",
      { connect: CONNECT, create: CREATE },
      "Unsupported to-one operation combination: create, connect",
    ],
    [
      "two suppliers stay refused even behind an accepted vacate",
      { disconnect: true, connect: CONNECT, create: CREATE },
      "Unsupported to-one operation combination: create, connect, disconnect",
    ],
    [
      "two vacates",
      { disconnect: true, delete: true },
      "Unsupported to-one operation combination: disconnect, delete",
    ],
    [
      "upsert beside another target intent",
      { upsert: { create: CREATE, update: UPDATE }, connect: CONNECT },
      "Unsupported to-one operation combination: connect, upsert",
    ],
    [
      "upsert beside a modify",
      { upsert: { create: CREATE, update: UPDATE }, update: UPDATE },
      "Unsupported to-one operation combination: update, upsert",
    ],
    [
      "a vacate with no supplier to follow it",
      { disconnect: true, update: UPDATE },
      "Unsupported to-one operation combination: update, disconnect",
    ],
    [
      "delete + connectOrCreate, the replacement the accepted set never contained",
      { delete: true, connectOrCreate: CONNECT_OR_CREATE },
      "Unsupported to-one operation combination: connectOrCreate, delete",
    ],
    [
      "delete + connectOrCreate stays refused with a modify beside it too",
      { delete: true, connectOrCreate: CONNECT_OR_CREATE, update: UPDATE },
      "Unsupported to-one operation combination: connectOrCreate, update, delete",
    ],
  ])("refuses %s", (_label, input, message) => {
    expect(refusalOf(childHeld, input)).toBe(message);
  });
});

describe("H — the parent-held direction folds to one foreign-key value", () => {
  test.each([
    ["disconnect + connect", { disconnect: true, connect: DESK_CONNECT }],
    ["disconnect + create", { disconnect: true, create: DESK_CREATE }],
    [
      "disconnect + connectOrCreate",
      { disconnect: true, connectOrCreate: DESK_CONNECT_OR_CREATE },
    ],
    ["delete + connect", { delete: true, connect: DESK_CONNECT }],
    ["delete + create", { delete: true, create: DESK_CREATE }],
    ["connect + update", { connect: DESK_CONNECT, update: DESK_UPDATE }],
  ])("accepts %s", (_label, input) => {
    expect(refusalOf(parentHeld, input)).toBeUndefined();
  });

  test.each([
    [
      "create + update — the modify would address a row this statement is producing",
      { create: DESK_CREATE, update: DESK_UPDATE },
      "Unsupported to-one operation combination: create, update",
    ],
    [
      "connectOrCreate + update, for the same reason on its missing arm",
      { connectOrCreate: DESK_CONNECT_OR_CREATE, update: DESK_UPDATE },
      "Unsupported to-one operation combination: connectOrCreate, update",
    ],
    [
      "a replacement composed with a modify",
      { disconnect: true, connect: DESK_CONNECT, update: DESK_UPDATE },
      "Unsupported to-one operation combination: connect, update, disconnect",
    ],
    [
      "delete + connectOrCreate here too",
      { delete: true, connectOrCreate: DESK_CONNECT_OR_CREATE },
      "Unsupported to-one operation combination: connectOrCreate, delete",
    ],
  ])("refuses %s", (_label, input, message) => {
    expect(refusalOf(parentHeld, input)).toBe(message);
  });
});

describe("H — a surface that does not own a key cannot compose with it", () => {
  test("a required parent-held relation owns no vacate, so the composition is an unknown key", () => {
    expect(
      refusalOf(requiredParentHeld, {
        disconnect: true,
        connect: { id: "z-alt" },
      })
    ).toBe("Unknown key: disconnect");
    // What it CAN spell still composes.
    expect(
      refusalOf(requiredParentHeld, {
        connect: { id: "z-alt" },
        update: { code: "c" },
      })
    ).toBeUndefined();
  });

  test("the create root owns no `update`, so supply-then-modify is an unknown key there", () => {
    expect(refusalOf(childHeldCreate, { create: CREATE, update: UPDATE })).toBe(
      "Unknown key: update"
    );
    expect(
      refusalOf(childHeldCreate, { connect: CONNECT, create: CREATE })
    ).toBe("Unsupported to-one operation combination: create, connect");
  });
});

describe("H — what counts as active, and what the count never gets to see", () => {
  test("an absent key and a `false` verb are both inactive", () => {
    expect(refusalOf(childHeld, {})).toBeUndefined();
    expect(refusalOf(childHeld, { disconnect: false })).toBeUndefined();
    expect(
      refusalOf(childHeld, {
        disconnect: false,
        delete: false,
        connect: CONNECT,
      })
    ).toBeUndefined();
    // Two INACTIVE vacates beside an active supplier are still one active intent.
    expect(
      refusalOf(childHeld, { disconnect: false, delete: false, update: UPDATE })
    ).toBeUndefined();
  });

  test("the underlying object is validated FIRST, and its issue path survives", () => {
    // A shape failure inside an arm is answered before any counting happens — the
    // combination sentence would otherwise hide which field was wrong.
    expect(
      parse(childHeld, { connect: { id: 123 }, update: UPDATE }).issues
    ).toEqual([{ path: ["connect", "id"], message: "Expected string" }]);
  });

  test("the composed schema still converts to JSON Schema, through the object it wraps", () => {
    // The lattice is a rule about which COMBINATIONS of properties may be active,
    // which JSON Schema has no vocabulary for; the document is therefore the
    // underlying object's, reached through this schema rather than rebuilt — and
    // reached lazily, because building it eagerly would resolve a self-referential
    // relation's target while this schema is still under construction.
    const converted = childHeld["~standard"].jsonSchema.input({
      target: "draft-07",
    }) as { type?: string; properties?: Record<string, unknown> };
    expect(converted.type).toBe("object");
    expect(Object.keys(converted.properties ?? {}).sort()).toEqual([
      "connect",
      "connectOrCreate",
      "create",
      "delete",
      "disconnect",
      "update",
      "upsert",
    ]);
  });

  test("an optional to-one create input that is absent never reaches the count", () => {
    // The create surface is `{ optional: true }`: the parsed output is `undefined`,
    // which owns no keys to count.
    const result = parse(childHeldCreate, undefined);
    expect(result.issues).toBeUndefined();
    expect((result as { value: unknown }).value).toBeUndefined();
  });
});
