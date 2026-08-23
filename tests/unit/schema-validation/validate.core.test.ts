/**
 * Schema Validation Tests
 *
 * End-to-end coverage of validateSchema()/validateSchemaOrThrow() and each
 * definition-time rule's trigger case. These rules were dead code until the
 * getRelations/getRelationValues/getScalars helpers were fixed (they
 * recursed into themselves), so nothing here was ever exercised before.
 */

import { s } from "@src/schema";
import { isValidSchemaIdentifier } from "@src/schema/identifier";
import { validateSchema, validateSchemaOrThrow } from "@src/schema/validation";
import {
  clientUserPostSchema,
  sqlGenerationUserPostSchema,
} from "@tests/fixtures/user-post-schema";
import { describe, expect, it } from "vitest";

function codes(result: { errors: { code: string }[] }): string[] {
  return result.errors.map((e) => e.code);
}

function warningCodes(result: { warnings: { code: string }[] }): string[] {
  return result.warnings.map((w) => w.code);
}

const PROTOTYPE_COLLISION_IDENTIFIERS = [
  "__proto__",
  "constructor",
  "toString",
] as const;

function getIdentifierContracts() {
  return [
    {
      code: "M005",
      createSchema: (identifier: string) => ({
        [identifier]: s.model({ id: s.string().id() }),
      }),
      surface: "model key",
    },
    {
      code: "M007",
      createSchema: (identifier: string) => ({
        mappedTable: s.model({ id: s.string().id() }).map(identifier),
      }),
      surface: "mapped table",
    },
    {
      code: "F001",
      createSchema: (identifier: string) => ({
        scalarKey: s.model({
          id: s.string().id(),
          [identifier]: s.string(),
        }),
      }),
      surface: "scalar key",
    },
    {
      code: "F009",
      createSchema: (identifier: string) => ({
        mappedColumn: s.model({
          id: s.string().id(),
          value: s.string().map(identifier),
        }),
      }),
      surface: "mapped column",
    },
    {
      code: "F001",
      createSchema: (identifier: string) => {
        const relationParent = s.model({
          id: s.string().id(),
          [identifier]: s.toMany(() => relationChild),
        });
        const relationChild = s.model({
          id: s.string().id(),
          parentId: s.string(),
          parent: s
            .toOne(() => relationParent)
            .fields("parentId")
            .references("id"),
        });
        return { relationParent, relationChild };
      },
      surface: "relation key",
    },
  ];
}

// =============================================================================
// VALID SCHEMAS PASS END-TO-END
// =============================================================================

describe("validateSchema on valid schemas", () => {
  it("accepts the user/post fixture schema with no errors", () => {
    const result = validateSchema(clientUserPostSchema);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("accepts the sql-generation fixture (relations, M2M, compound keys)", () => {
    const result = validateSchema(sqlGenerationUserPostSchema);
    expect(result.errors).toEqual([]);
  });

  it("validateSchemaOrThrow does not crash or throw on a valid schema", () => {
    // Regression: this used to stack-overflow before any rule ran
    expect(() => validateSchemaOrThrow(clientUserPostSchema)).not.toThrow();
  });

  it("does not warn CM001 for compound key member fields", () => {
    // Membership has orgId/memberId (compound id) and tenantId (compound unique)
    const result = validateSchema(sqlGenerationUserPostSchema);
    expect(warningCodes(result)).not.toContain("CM001");
  });
});

// =============================================================================
// SELF-RELATIONS
// =============================================================================

describe("self-referential relations", () => {
  it("accepts a valid parent/children self-relation", () => {
    const category = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => category)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => category),
    });
    const result = validateSchema({ category });
    expect(result.errors).toEqual([]);
    expect(warningCodes(result)).not.toContain("R007");
  });
});

// =============================================================================
// MULTIPLE RELATIONS BETWEEN THE SAME MODELS
// =============================================================================

describe("multiple relations between the same models", () => {
  it("accepts two relationships disambiguated with .name()", () => {
    const user = s.model({
      id: s.string().id(),
      authored: s.toMany(() => post).name("author"),
      edited: s.toMany(() => post).name("editor"),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      editorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id")
        .name("author"),
      editor: s
        .toOne(() => user)
        .fields("editorId")
        .references("id")
        .name("editor"),
    });
    const result = validateSchema({ user, post });
    expect(result.errors).toEqual([]);
    expect(warningCodes(result)).not.toContain("R007");
  });
});

// =============================================================================
// RELATION RULES
// =============================================================================

describe("relation rules", () => {
  it("errors R006 when a relation targets an unregistered model", () => {
    const user = s.model({ id: s.string().id() });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    const result = validateSchema({ post }); // user not registered
    expect(codes(result)).toContain("R006");
  });
});

// =============================================================================
// JUNCTION TABLE RULES
// =============================================================================

describe("junction table rules", () => {
  it("errors JT001 when a junction table is shared by more than one relationship", () => {
    const post = s.model({
      id: s.string().id(),
      tags: s.toMany(() => tag).through("shared"),
      users: s.toMany(() => user).through("shared"),
    });
    const tag = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    });
    const user = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    });
    const result = validateSchema({ post, tag, user });
    expect(codes(result)).toContain("JT001");
    // Schema-level rule must report once, not once per model
    expect(codes(result).filter((c) => c === "JT001")).toHaveLength(1);
  });

  it("errors JT003 when A and B are the same column", () => {
    const post = s.model({
      id: s.string().id(),
      tags: s
        .toMany(() => tag)
        .source("same")
        .target("same"),
    });
    const tag = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    });
    const result = validateSchema({ post, tag });
    expect(codes(result)).toContain("JT003");
  });
});

// =============================================================================
// FOREIGN KEY RULES
// =============================================================================

describe("foreign key rules", () => {
  it("errors FK003 on FK/reference type mismatch", () => {
    const user = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.int(), // user.id is string
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    const result = validateSchema({ user, post });
    expect(codes(result)).toContain("FK003");
  });

  it("errors FK005 when the referenced field is not unique", () => {
    const user = s.model({
      id: s.string().id(),
      email: s.string(), // not unique
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorEmail: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorEmail")
        .references("email"),
    });
    const result = validateSchema({ user, post });
    expect(codes(result)).toContain("FK005");
    expect(warningCodes(result)).not.toContain("FK005");
  });

  it("accepts an owning 1:1 FK marked .unique()", () => {
    const user = s.model({
      id: s.string().id(),
      profile: s.toOne(() => profile),
    });
    const profile = s.model({
      id: s.string().id(),
      userId: s.string().unique(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
    });
    const result = validateSchema({ user, profile });
    expect(codes(result)).not.toContain("FK008");
    expect(result.errors).toEqual([]);
  });

  it("accepts a compound 1:1 FK covered by a compound unique", () => {
    const user = s.model({
      id: s.string().id(),
      orgId: s.string(),
      profile: s.toOne(() => profile),
    });
    const profile = s
      .model({
        id: s.string().id(),
        userId: s.string(),
        userOrgId: s.string(),
        user: s
          .toOne(() => user)
          .fields("userId", "userOrgId")
          .references("id", "orgId"),
      })
      .unique(["userId", "userOrgId"]);
    const result = validateSchema({ user, profile });
    expect(codes(result)).not.toContain("FK008");
  });

  it("accepts an owning 1:1 FK covered by a unique index", () => {
    const user = s.model({
      id: s.string().id(),
      profile: s.toOne(() => profile),
    });
    const profile = s
      .model({
        id: s.string().id(),
        userId: s.string(),
        user: s
          .toOne(() => user)
          .fields("userId")
          .references("id"),
      })
      .index(["userId"], { unique: true });
    const result = validateSchema({ user, profile });
    expect(codes(result)).not.toContain("FK008");
  });
});

// =============================================================================
// REFERENTIAL ACTION RULES (RA003-RA004)
// =============================================================================

describe("referential action rules", () => {
  it("warns RA003 on cascade delete for a required relation", () => {
    const user = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id")
        .onDelete("cascade"),
    });
    const result = validateSchema({ user, post });
    expect(warningCodes(result)).toContain("RA003");
  });

  it("errors RA004 when SET NULL targets a non-nullable FK", () => {
    const user = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(), // not nullable
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id")
        .onDelete("setNull"),
    });
    const result = validateSchema({ user, post });
    expect(codes(result)).toContain("RA004");
  });
});

// =============================================================================
// MODEL & FIELD RULES
// =============================================================================

describe("model and field rules", () => {
  it("accepts 63-byte identifiers and rejects 64-byte identifiers", () => {
    const validIdentifier = `f${"a".repeat(62)}`;
    const invalidIdentifier = `f${"a".repeat(63)}`;
    const identifierContracts = getIdentifierContracts();

    for (const contract of identifierContracts) {
      expect(
        codes(validateSchema(contract.createSchema(validIdentifier))),
        `${contract.surface} should accept 63 bytes`
      ).not.toContain(contract.code);
      expect(
        codes(validateSchema(contract.createSchema(invalidIdentifier))),
        `${contract.surface} should reject 64 bytes`
      ).toContain(contract.code);
    }
  });

  it("rejects every Object.prototype property name as an identifier", () => {
    for (const identifier of Object.getOwnPropertyNames(Object.prototype)) {
      expect(isValidSchemaIdentifier(identifier), identifier).toBe(false);
    }
  });

  it.each(
    PROTOTYPE_COLLISION_IDENTIFIERS
  )("rejects Object.prototype collision %j across schema name surfaces", (identifier) => {
    for (const contract of getIdentifierContracts()) {
      expect(
        codes(validateSchema(contract.createSchema(identifier))),
        `${contract.surface} should reject ${identifier}`
      ).toContain(contract.code);
    }
  });

  it("rejects empty mapped table and column names", () => {
    const emptyTable = s.model({ id: s.string().id() }).map("");
    const emptyColumn = s.model({
      id: s.string().id(),
      value: s.string().map(""),
    });

    expect(codes(validateSchema({ emptyTable }))).toContain("M007");
    expect(codes(validateSchema({ emptyColumn }))).toContain("F009");
    expect(isValidSchemaIdentifier(null)).toBe(false);
    expect(isValidSchemaIdentifier(Symbol("identifier"))).toBe(false);
  });

  it("errors M001 when a model has no ID", () => {
    const user = s.model({ name: s.string() });
    expect(codes(validateSchema({ user }))).toContain("M001");
  });

  it("does not error M001 for a compound-ID model", () => {
    const membership = s
      .model({ orgId: s.string(), memberId: s.string() })
      .id(["orgId", "memberId"]);
    const result = validateSchema({ membership });
    expect(codes(result)).not.toContain("M001");
    expect(result.errors).toEqual([]);
  });

  it("errors M004 when two models map to the same table", () => {
    const a = s.model({ id: s.string().id() }).map("things");
    const b = s.model({ id: s.string().id() }).map("things");
    expect(codes(validateSchema({ a, b }))).toContain("M004");
  });

  it("errors M005/M006/M007 on bad names", () => {
    const badKey = s.model({ id: s.string().id() });
    const reserved = s.model({ id: s.string().id() });
    const badTable = s.model({ id: s.string().id() }).map("bad table");
    const result = validateSchema({
      "bad-name": badKey,
      select: reserved,
      ok: badTable,
    });
    expect(codes(result)).toEqual(
      expect.arrayContaining(["M005", "M006", "M007"])
    );
  });

  it("errors F002 when two fields are marked .id()", () => {
    const user = s.model({
      id: s.string().id(),
      other: s.string().id(),
    });
    expect(codes(validateSchema({ user }))).toContain("F002");
  });

  it.each([
    "0viborm_vector_distance",
    "0viborm_relation_counts",
  ])("errors F001 when a relation uses private carrier name %j", (name) => {
    const parent = s.model({
      id: s.string().id(),
      [name]: s.toMany(() => child),
    });
    const child = s.model({
      id: s.string().id(),
      parentId: s.string(),
      parent: s
        .toOne(() => parent)
        .fields("parentId")
        .references("id"),
    });

    expect(codes(validateSchema({ parent, child }))).toContain("F001");
  });

  it("errors F002 when .id() is called twice on a model", () => {
    const user = s.model({ a: s.string(), b: s.string() }).id(["a"]).id(["b"]);
    expect(codes(validateSchema({ user }))).toContain("F002");
  });

  it("errors F003 when two fields map to the same column", () => {
    const user = s.model({
      id: s.string().id(),
      a: s.string().map("col"),
      b: s.string().map("col"),
    });
    expect(codes(validateSchema({ user }))).toContain("F003");
  });

  it("errors F006 on a nullable ID", () => {
    const user = s.model({ id: s.string().nullable().id() });
    expect(codes(validateSchema({ user }))).toContain("F006");
  });

  it("errors I002 on duplicate index names", () => {
    const user = s
      .model({ id: s.string().id(), a: s.string(), b: s.string() })
      .index(["a"], { name: "idx" })
      .index(["b"], { name: "idx" });
    expect(codes(validateSchema({ user }))).toContain("I002");
  });

  it("warns CM001 on an orphan *Id field", () => {
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(), // no relation uses it
    });
    expect(warningCodes(validateSchema({ post }))).toContain("CM001");
  });

  it("errors CM002 on a circular chain of required relations", () => {
    const a = s.model({
      id: s.string().id(),
      bId: s.string(),
      b: s
        .toOne(() => b)
        .name("AtoB")
        .fields("bId")
        .references("id"),
      backrefs: s.toMany(() => b).name("BtoA"),
    });
    const b = s.model({
      id: s.string().id(),
      aId: s.string(),
      a: s
        .toOne(() => a)
        .name("BtoA")
        .fields("aId")
        .references("id"),
      backrefs: s.toMany(() => a).name("AtoB"),
    });
    const result = validateSchema({ a, b });
    expect(codes(result)).toContain("CM002");
    // Schema-level rule must report the cycle once
    expect(codes(result).filter((c) => c === "CM002")).toHaveLength(1);
  });
});

// =============================================================================
// COMPOUND CONSTRAINT ACCUMULATION
// =============================================================================

describe("compound constraint accumulation", () => {
  it("accumulates multiple .unique() calls instead of replacing", () => {
    const membership = s
      .model({
        orgId: s.string(),
        memberId: s.string(),
        email: s.string(),
        tenantId: s.string(),
      })
      .id(["orgId", "memberId"])
      .unique(["email", "tenantId"])
      .unique(["orgId", "email"]);

    const uniques = membership["~"].state.compoundUniques;
    expect(Object.keys(uniques ?? {})).toHaveLength(2);
    expect(validateSchema({ membership }).errors).toEqual([]);
  });
});
