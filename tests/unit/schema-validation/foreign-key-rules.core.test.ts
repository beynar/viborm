import { s } from "@src/schema";
import {
  resolveSchemaOrThrow,
  SchemaValidator,
  validateSchema,
} from "@src/schema/validation";
import { describe, expect, it } from "vitest";

function codes(result: ReturnType<typeof validateSchema>): string[] {
  return result.errors.map((issue) => issue.code);
}

function warnings(result: ReturnType<typeof validateSchema>): string[] {
  return result.warnings.map((issue) => issue.code);
}

describe("foreign-key definition rules", () => {
  it("rejects a missing local FK scalar once through FK001", () => {
    const user = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      author: s
        .toOne(() => user)
        .fields("missing")
        .references("id")
        .onDelete("setNull"),
    });
    const result = validateSchema({ user, post });

    expect(codes(result)).toContain("FK001");
    expect(codes(result)).not.toContain("FK006");
  });

  it("rejects a missing referenced scalar through FK002", () => {
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
        .references("missing"),
    });

    expect(codes(validateSchema({ user, post }))).toContain("FK002");
  });

  it("refuses mismatched FK and reference arity at the reference stage", () => {
    // FK007 has no successor at the GATE: `.references(...)` accepts only an
    // equal-arity tuple, so an unequal pair can no longer be constructed and
    // never reaches a schema. The refusal moved to the call the author wrote.
    const user = s
      .model({ tenantId: s.string(), id: s.string() })
      .id(["tenantId", "id"]);

    expect(() =>
      s
        .toOne(() => user)
        .fields("tenantId", "authorId")
        // @ts-expect-error §11.1.8: `.references(...)` is equal-arity.
        .references("id")
    ).toThrow("pairs them positionally");
  });

  it("accepts SET NULL when every owned FK is nullable", () => {
    const user = s.model({
      id: s.string().id(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id")
        .onDelete("setNull"),
    });
    const result = validateSchema({ user, post });

    expect(codes(result)).not.toContain("RA004");
    expect(warnings(result)).not.toContain("RA003");
  });

  it("accepts an owning one-to-one FK covered by the local compound ID", () => {
    const user = s
      .model({
        tenantId: s.string(),
        id: s.string(),
        account: s.toOne(() => account),
      })
      .id(["tenantId", "id"]);
    const account = s
      .model({
        tenantId: s.string(),
        userId: s.string(),
        user: s
          .toOne(() => user)
          .fields("tenantId", "userId")
          .references("tenantId", "id"),
      })
      .id(["tenantId", "userId"]);

    expect(codes(validateSchema({ user, account }))).not.toContain("FK008");
  });

  it("accepts a reference addressed by a declared UNIQUE index, and carries onUpdate", () => {
    // `.index([...], { unique: true })` is a key the target row can be
    // addressed by even though no scalar carries `.unique()` — reading only the
    // per-scalar flags would advise against referencing the very tuple the
    // model declares. `onUpdate` rides on the same resolved reference, so the
    // two facts are pinned together where the FK is built.
    const user = s
      .model({
        id: s.string().id(),
        region: s.string(),
        handle: s.string(),
        posts: s.toMany(() => post),
      })
      .index(["region", "handle"], { unique: true });
    const post = s.model({
      id: s.string().id(),
      authorRegion: s.string(),
      authorHandle: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorRegion", "authorHandle")
        .references("region", "handle")
        .onUpdate("cascade"),
    });
    const result = validateSchema({ user, post });

    expect(codes(result)).toEqual([]);
    expect(warnings(result)).not.toContain("FK005");
  });

  it("refuses a reference addressed only by a partial unique index", () => {
    const user = s
      .model({
        id: s.string().id(),
        handle: s.string(),
        posts: s.toMany(() => post),
      })
      .index(["handle"], { unique: true, where: "handle IS NOT NULL" });
    const post = s.model({
      id: s.string().id(),
      authorHandle: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorHandle")
        .references("handle"),
    });
    const validator = new SchemaValidator().registerAll({ user, post });
    const resolution = validator.resolve();

    expect(codes(validator.validate())).toContain("FK005");
    expect(resolution.ok).toBe(false);
    expect(resolution).not.toHaveProperty("index");
  });

  it("reports SET NULL once per non-null field when either action requests it", () => {
    const user = s
      .model({
        tenantId: s.string(),
        id: s.string(),
        posts: s.toMany(() => post),
      })
      .id(["tenantId", "id"]);
    const post = s.model({
      id: s.string().id(),
      tenantId: s.string(),
      authorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("tenantId", "authorId")
        .references("tenantId", "id")
        .onDelete("setNull")
        .onUpdate("setNull"),
    });
    const result = validateSchema({ user, post });

    expect(
      result.errors.filter((issue) => issue.code === "RA004")
    ).toHaveLength(2);
  });

  it("rejects onUpdate SET NULL for a non-null foreign field", () => {
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
        .onUpdate("setNull"),
    });

    expect(codes(validateSchema({ user, post }))).toContain("RA004");
  });

  it.each([
    "onDelete",
    "onUpdate",
  ] as const)("accepts an all-null compound SET NULL on %s and preserves the action", (action) => {
    const user = s
      .model({
        tenantId: s.string(),
        id: s.string(),
        posts: s.toMany(() => post),
      })
      .id(["tenantId", "id"]);
    const reference = s
      .toOne(() => user)
      .fields("tenantId", "authorId")
      .references("tenantId", "id");
    const post = s.model({
      id: s.string().id(),
      tenantId: s.string().nullable(),
      authorId: s.string().nullable(),
      author:
        action === "onDelete"
          ? reference.onDelete("setNull")
          : reference.onUpdate("setNull"),
    });
    const index = resolveSchemaOrThrow({ user, post });
    const edge = index.get(post)?.get("author")?.edge;

    expect(codes(validateSchema({ user, post }))).not.toContain("RA004");
    expect(edge?.kind).toBe("foreignKey");
    if (edge?.kind !== "foreignKey") return;
    expect(edge.reference[action]).toBe("setNull");
  });
});
