/**
 * The three list positions plan 2.1 excludes that a SCALAR chain never sees.
 *
 * `.id()` and `.unique()` are refused by the decimal declaration itself. An
 * index member, a compound-key member and a foreign-key member are named by
 * STRING from the model and from the relation, so the scalar has no way to
 * know it is being used as one; the model rule (I004) and the stored-reference
 * subowner (FK010) are where those positions are decided.
 *
 * "Relation identity members" are the referenced tuple, and they need no fourth
 * check: a reference must address a key (FK005), and after I004 and the
 * declaration's own refusal there is no key a decimal list can belong to.
 */

import { s } from "@schema";
import { validateSchema } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

const MONEY = { precision: 10, scale: 2 } as const;

const INDEX_MEMBER = /'amounts'.*fixed-decimal list.*an index/i;
const COMPOUND_ID = /compound ID/i;
const FK_MEMBER = /FK 'amounts'.*fixed-decimal list.*foreign-key member/i;

const codes = (result: ReturnType<typeof validateSchema>): string[] =>
  result.errors.map((issue) => issue.code);

const messages = (result: ReturnType<typeof validateSchema>): string =>
  result.errors.map((issue) => issue.message).join("\n");

describe("a fixed-decimal list is not a key member", () => {
  it("refuses an index over one", () => {
    const ledger = s
      .model({
        id: s.string().id(),
        amounts: s.decimal(MONEY).array(),
      })
      // @ts-expect-error - hostile JavaScript can still reach the runtime rule
      .index(["amounts"]);

    const result = validateSchema({ ledger });

    expect(codes(result)).toContain("I004");
    expect(messages(result)).toMatch(INDEX_MEMBER);
  });

  it("refuses a unique index over one", () => {
    const ledger = s
      .model({
        id: s.string().id(),
        amounts: s.decimal(MONEY).array(),
      })
      // @ts-expect-error - hostile JavaScript can still reach the runtime rule
      .index(["amounts"], { unique: true });

    expect(codes(validateSchema({ ledger }))).toContain("I004");
  });

  it("refuses a compound ID member", () => {
    const ledger = s
      .model({
        region: s.string(),
        amounts: s.decimal(MONEY).array(),
      })
      // @ts-expect-error - hostile JavaScript can still reach the runtime rule
      .id(["region", "amounts"]);

    const result = validateSchema({ ledger });

    expect(codes(result)).toContain("I004");
    expect(messages(result)).toMatch(COMPOUND_ID);
  });

  it("refuses a compound unique member", () => {
    const ledger = s
      .model({
        id: s.string().id(),
        region: s.string(),
        amounts: s.decimal(MONEY).array(),
      })
      // @ts-expect-error - hostile JavaScript can still reach the runtime rule
      .unique(["region", "amounts"]);

    expect(codes(validateSchema({ ledger }))).toContain("I004");
  });

  it("refuses a foreign-key member", () => {
    const vault = s.model({
      id: s.string().id(),
      total: s.decimal(MONEY).unique(),
      baskets: s.toMany(() => basket),
    });
    const basket = s.model({
      id: s.string().id(),
      amounts: s.decimal(MONEY).array(),
      vault: s
        .toOne(() => vault)
        .fields("amounts")
        .references("total"),
    });

    const result = validateSchema({ vault, basket });

    expect(codes(result)).toContain("FK010");
    expect(messages(result)).toMatch(FK_MEMBER);
  });

  it("leaves a scalar decimal in every one of those positions alone", () => {
    const vault = s.model({
      id: s.string().id(),
      total: s.decimal(MONEY).unique(),
      baskets: s.toMany(() => basket),
    });
    const basket = s
      .model({
        id: s.string().id(),
        region: s.string(),
        amount: s.decimal(MONEY),
        amounts: s.decimal(MONEY).array(),
        vault: s
          .toOne(() => vault)
          .fields("amount")
          .references("total"),
      })
      .index(["amount"])
      .unique(["region", "amount"]);

    const result = validateSchema({ vault, basket });

    expect(codes(result)).not.toContain("I004");
    expect(codes(result)).not.toContain("FK010");
  });

  it("leaves an array of another scalar type alone", () => {
    const ledger = s
      .model({
        id: s.string().id(),
        tags: s.string().array(),
      })
      .index(["tags"]);

    expect(codes(validateSchema({ ledger }))).not.toContain("I004");
  });
});
