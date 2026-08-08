import { s } from "@src/schema";
import { validateSchema } from "@src/schema/validation";
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
      posts: s.oneToMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      author: s
        .manyToOne(() => user)
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
      posts: s.oneToMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string(),
      author: s
        .manyToOne(() => user)
        .fields("authorId")
        .references("missing"),
    });

    expect(codes(validateSchema({ user, post }))).toContain("FK002");
  });

  it("rejects mismatched FK and reference cardinality", () => {
    const user = s
      .model({
        tenantId: s.string(),
        id: s.string(),
        posts: s.oneToMany(() => post),
      })
      .id(["tenantId", "id"]);
    const post = s.model({
      id: s.string().id(),
      tenantId: s.string(),
      authorId: s.string(),
      author: s
        .manyToOne(() => user)
        .fields("tenantId", "authorId")
        .references("id"),
    });

    expect(codes(validateSchema({ user, post }))).toContain("FK007");
  });

  it("accepts SET NULL when every owned FK is nullable", () => {
    const user = s.model({
      id: s.string().id(),
      posts: s.oneToMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string().nullable(),
      author: s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id")
        .optional()
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
        account: s.oneToOne(() => account),
      })
      .id(["tenantId", "id"]);
    const account = s
      .model({
        tenantId: s.string(),
        userId: s.string(),
        user: s
          .oneToOne(() => user)
          .fields("tenantId", "userId")
          .references("tenantId", "id"),
      })
      .id(["tenantId", "userId"]);

    expect(codes(validateSchema({ user, account }))).not.toContain("FK008");
  });
});
