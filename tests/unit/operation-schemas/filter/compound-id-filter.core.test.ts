/**
 * Compound ID Filter Schema Tests
 *
 * Tests the _filter.compoundId schema which includes compound primary key
 * constraints as single keys with nested field objects.
 */

import { generateCacheKey } from "@cache/key";
import { ValidationError } from "@errors";
import { s } from "@schema";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  compoundIdSchemas,
  compoundUniqueSchemas,
  simpleSchemas,
} from "@tests/unit/operation-schemas/fixtures";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

// =============================================================================
// TYPE TESTS - Compound ID Model
// =============================================================================

describe("Compound ID Filter - Types", () => {
  test("type: empty object matches (all optional)", () => {
    // All compound constraint keys are optional
    const input: Record<string, unknown> = {};
    expectTypeOf(input).toMatchTypeOf<Record<string, unknown>>();
  });
});

// =============================================================================
// RUNTIME TESTS - Compound ID Model
// =============================================================================

describe("Compound ID Filter - Compound ID Model Runtime", () => {
  const schema = compoundIdSchemas.compoundIdFilter;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: accepts compound key object", () => {
    const result = parse(schema, {
      orgId_memberId: { orgId: "org-1", memberId: "member-1" },
    });
    expect(result.issues).toBeUndefined();
  });

  test("runtime: compound key requires all fields", () => {
    const result = parse(schema, {
      orgId_memberId: { orgId: "org-1" }, // missing memberId
    });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Simple Model (no compound id)
// =============================================================================

describe("Compound ID Filter - Simple Model Runtime (no compound id)", () => {
  const schema = simpleSchemas.compoundIdFilter;

  test("runtime: accepts empty object", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects unknown key (strict schema)", () => {
    // Schema is strict to prevent invalid SQL from extra keys
    const result = parse(schema, { anyKey: {} });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Compound Unique Model (no compound id, has compound unique)
// =============================================================================

describe("Compound ID Filter - Compound Unique Model Runtime", () => {
  const schema = compoundUniqueSchemas.compoundIdFilter;

  test("runtime: accepts empty object (no compound ID)", () => {
    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
  });

  test("runtime: rejects compound unique key (strict schema)", () => {
    // Schema is strict - only compound ID keys are valid here
    const result = parse(schema, {
      email_tenantId: { email: "a@b.com", tenantId: "t1" },
    });
    expect(result.issues).toBeDefined();
  });
});

// =============================================================================
// RUNTIME TESTS - Identifier members
// =============================================================================

/**
 * A compound key's members are FIELDS, and a field with an identifier domain
 * admits and normalizes exactly what it admits everywhere else. The declaration
 * snapshots each member's PRE-domain schema, so a `.uuid()` member was
 * validated as a plain string: an out-of-domain value crossed the args boundary
 * and surfaced later as an engine error, and an alias was never folded, which
 * hashed one row's selector to two cache keys.
 */
describe("Compound ID Filter - identifier members", () => {
  const UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

  const seat = s
    .model({
      roomId: s.string().uuid(),
      slotId: s.string().ulid(),
      label: s.string(),
    })
    .id(["roomId", "slotId"]);
  const tenant = s.model({
    id: s.string().id().uuid("t"),
    docs: s.toMany(() => doc),
  });
  const doc = s
    .model({
      tenantId: s.string(),
      slug: s.string(),
      tenant: s
        .toOne(() => tenant)
        .fields("tenantId")
        .references("id"),
    })
    .id(["tenantId", "slug"]);
  const registry = createSchemaRegistry({ seat, tenant, doc }).proxy;

  /** The value a schema admitted, or `undefined` when it refused. */
  const admitted = (schema: StandardSchemaV1, value: unknown): unknown => {
    const result = parse(schema, value);
    return result.issues ? undefined : result.value;
  };

  test("runtime: a member normalizes its alias", () => {
    expect(
      admitted(registry.seat.core.compoundIdFilter, {
        roomId_slotId: {
          roomId: UUID.toUpperCase(),
          slotId: ULID.toLowerCase(),
        },
      })
    ).toEqual({ roomId_slotId: { roomId: UUID, slotId: ULID } });
  });

  test("runtime: a member outside its domain is refused here", () => {
    const result = parse(registry.seat.core.compoundIdFilter, {
      roomId_slotId: { roomId: "not-a-uuid", slotId: ULID },
    });
    expect(result.issues?.[0]?.message).toBe("Expected a uuid value");
  });

  test("runtime: a member whose domain is DERIVED is admitted too", () => {
    expect(
      admitted(registry.doc.core.compoundIdFilter, {
        tenantId_slug: { tenantId: `t-${UUID.toUpperCase()}`, slug: "x" },
      })
    ).toEqual({ tenantId_slug: { tenantId: `t-${UUID}`, slug: "x" } });
    expect(
      admitted(registry.doc.core.compoundIdFilter, {
        tenantId_slug: { tenantId: UUID, slug: "x" },
      })
    ).toBeUndefined();
  });
});

/**
 * The MIXED compound: one member derives its domain from the key it references
 * and the other declares its own. Both halves have to be rebuilt from the
 * FIELD's schema for this selector to work at all — the declaration snapshot
 * has neither — and the proof that they were is identity, not admission: two
 * spellings of one row's key hash to ONE cache key, which is what a selector
 * built from `state.base` could not do for either member.
 */
describe("Compound ID Filter - a derived member beside a declared one", () => {
  const UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

  const room = s.model({
    id: s.string().id().uuid("rm"),
    seats: s.toMany(() => seat),
  });
  const seat = s
    .model({
      roomId: s.string(),
      slotId: s.string().ulid(),
      label: s.string(),
      room: s
        .toOne(() => room)
        .fields("roomId")
        .references("id"),
    })
    .id(["roomId", "slotId"]);
  const registry = createSchemaRegistry({ room, seat });

  const selector = (roomId: string, slotId: string) => ({
    where: { roomId_slotId: { roomId, slotId } },
  });

  test("runtime: both members normalize their alias", () => {
    expect(
      registry.validate("seat", "findUnique", {
        ...selector(`rm-${UUID.toUpperCase()}`, ULID.toLowerCase()),
      })
    ).toEqual(selector(`rm-${UUID}`, ULID));
  });

  test("runtime: either member outside its domain is a ValidationError", () => {
    expect(() =>
      registry.validate("seat", "findUnique", selector(UUID, ULID))
    ).toThrow(ValidationError);
    expect(() =>
      registry.validate("seat", "findUnique", selector(`rm-${UUID}`, "nope"))
    ).toThrow(ValidationError);
  });

  test("runtime: the boundary answers for a payload with no shape at all", () => {
    // The tests above reach `registry.validate` — the throwing boundary a
    // client calls — through a well-formed payload. Its other two answers are
    // an issue that belongs to no field, and an operation whose whole argument
    // is optional.
    try {
      registry.validate("seat", "findUnique", "not-an-object");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues).toEqual([
        { path: "", message: "Expected object" },
      ]);
    }
    expect(registry.validate("seat", "findMany", undefined)).toEqual({});
  });

  test("runtime: two spellings of one key make one cache key", () => {
    const keyFor = (roomId: string, slotId: string) =>
      generateCacheKey(
        "seat",
        "findUnique",
        registry.validate("seat", "findUnique", selector(roomId, slotId))
      );

    expect(keyFor(`rm-${UUID.toUpperCase()}`, ULID.toLowerCase())).toBe(
      keyFor(`rm-${UUID}`, ULID)
    );
  });
});
