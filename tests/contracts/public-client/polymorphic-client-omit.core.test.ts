import { applyClientOmit, createClientOmitResolver } from "@client/omit";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const author = s.model({
  id: s.string().id(),
  name: s.string(),
  credential: s.string(),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  secret: s.string(),
  authorId: s.string(),
  author: s
    .manyToOne(() => author)
    .fields("authorId")
    .references("id"),
});

const video = s.model({
  id: s.string().id(),
  duration: s.int(),
  token: s.string(),
});

const comment = s.model({
  id: s.string().id(),
  subject: s.polymorphic(
    { post: () => post, video: () => video },
    { values: { post: "content.post.v1", video: "content.video.v1" } }
  ),
});

const schema = { author, post, video, comment };

function configuredResolver() {
  const resolver = createClientOmitResolver(schema, {
    author: { credential: true },
    post: { secret: true },
    video: { token: true },
  });
  if (!resolver) throw new Error("Expected a configured omit resolver");
  return resolver;
}

describe("client omit through polymorphic projections", () => {
  test("promotes a true relation node for every configured target default", () => {
    const args = { include: { subject: true } };

    expect(
      applyClientOmit(comment, "findMany", args, configuredResolver())
    ).toEqual({
      include: {
        subject: {
          post: { omit: { secret: true } },
          video: { omit: { token: true } },
        },
      },
    });
  });

  test("rewrites explicit and defaulted variants with their own target model", () => {
    const args = {
      include: {
        subject: {
          post: { include: { author: true } },
        },
      },
    };

    expect(
      applyClientOmit(comment, "findMany", args, configuredResolver())
    ).toEqual({
      include: {
        subject: {
          post: {
            include: { author: { omit: { credential: true } } },
            omit: { secret: true },
          },
          video: { omit: { token: true } },
        },
      },
    });
  });

  test("leaves relation-level false and an unaffected payload identical", () => {
    const falseArgs = { include: { subject: false } };
    const unconfigured = () => undefined;
    const trueArgs = { include: { subject: true } };

    expect(
      applyClientOmit(comment, "findMany", falseArgs, configuredResolver())
    ).toBe(falseArgs);
    expect(applyClientOmit(comment, "findMany", trueArgs, unconfigured)).toBe(
      trueArgs
    );
  });
});
