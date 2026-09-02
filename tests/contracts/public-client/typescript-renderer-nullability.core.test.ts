import {
  renderOperationResultType,
  renderSchemaType,
} from "@client/schema-introspection";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

describe("TypeScript renderer nullability contracts", () => {
  test("renders nullable selected relations without making their rows optional", () => {
    const author = s.model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
    });
    const post = s.model({
      id: s.string().id(),
      authorId: s.string().nullable(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
    });

    expect(
      renderOperationResultType({ author, post }, "post", "findMany", {
        select: { author: { select: { name: true } } },
      })
    ).toBe(`Array<{
  author: {
    name: string;
  } | null;
}>`);
  });

  test("renders optional singular and plural polymorphic schema slots", () => {
    const article = s.model({ id: s.string().id(), title: s.string() });
    const clip = s.model({ id: s.string().id(), duration: s.int() });
    const reaction = s.model({
      id: s.string().id(),
      subject: s.toOne({ article: () => article, clip: () => clip }).optional(),
    });
    const library = s.model({
      id: s.string().id(),
      items: s.toMany({ article: () => article, clip: () => clip }),
    });
    const schema = { article, clip, reaction, library };
    const renderedSchema = renderSchemaType(schema);

    expect(renderedSchema).toContain(`subject: {
      readonly type: "article";
      readonly data: VibORMSchema["article"];
    } | {
      readonly type: "clip";
      readonly data: VibORMSchema["clip"];
    } | null;`);
    expect(renderedSchema).toContain(`items: ReadonlyArray<{
      readonly type: "article";
      readonly data: VibORMSchema["article"];
    } | {
      readonly type: "clip";
      readonly data: VibORMSchema["clip"];
    }>;`);
    expect(
      renderOperationResultType(schema, "reaction", "findMany", {
        select: { subject: true },
      })
    ).toContain(`} | null;
}>`);
  });

  test("flattens and de-duplicates nullable aggregate leaf unions", () => {
    const account = s.model({
      id: s.string().id(),
      nickname: s.string().nullable(),
    });

    expect(
      renderOperationResultType({ account }, "account", "aggregate", {
        _min: { nickname: true },
      })
    ).toBe(`{
  _min: {
    nickname: string | null;
  };
}`);
  });
});
