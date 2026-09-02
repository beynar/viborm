import { applyClientOmit, createClientOmitResolver } from "@client/omit";
import { s } from "@schema";
import { indexFor, prepareSchema } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  email: s.string(),
  passwordHash: s.string(),
});
const schema = { user };

prepareSchema(schema);

const resolver = createClientOmitResolver(
  schema,
  { user: { passwordHash: true } },
  indexFor(user)
);
if (!resolver) throw new Error("Expected a configured omit resolver");

describe("default omit on bulk write projections", () => {
  test.each([
    "createMany",
    "updateMany",
    "deleteMany",
  ])("merges defaults into an explicit %s row projection", (operation) => {
    const args = { omit: { email: true } };

    expect(applyClientOmit(user, operation, args, resolver)).toEqual({
      omit: { passwordHash: true, email: true },
    });
  });

  test("does not let a client default turn a bulk count into rows", () => {
    for (const operation of ["createMany", "updateMany", "deleteMany"]) {
      const args = {};
      expect(applyClientOmit(user, operation, args, resolver)).toBe(args);
    }
  });

  test("an explicit local false re-includes one globally hidden field", () => {
    expect(
      applyClientOmit(
        user,
        "deleteMany",
        { omit: { passwordHash: false } },
        resolver
      )
    ).toEqual({ omit: { passwordHash: false } });
  });
});
