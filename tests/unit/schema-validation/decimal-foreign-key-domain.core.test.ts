import { s } from "@schema";
import {
  SchemaValidationError,
  validateSchema,
  validateSchemaOrThrow,
} from "@schema/validation";
import { describe, expect, it } from "vitest";

const MONEY = { precision: 12, scale: 2 };
const SAME_DECIMAL_DOMAIN = /same.*precision.*scale/i;

function decimalReference(domain: { precision: number; scale: number }) {
  const account = s.model({
    amount: s.decimal(MONEY).unique(),
    entries: s.toMany(() => entry),
  });
  const entry = s.model({
    id: s.string().id(),
    accountAmount: s.decimal(domain),
    account: s
      .toOne(() => account)
      .fields("accountAmount")
      .references("amount"),
  });
  return validateSchema({ account, entry });
}

function compoundDecimalReference(domain: {
  precision: number;
  scale: number;
}) {
  const account = s
    .model({
      currency: s.string(),
      amount: s.decimal(MONEY),
      entries: s.toMany(() => entry),
    })
    .unique(["currency", "amount"]);
  const entry = s.model({
    id: s.string().id(),
    accountCurrency: s.string(),
    accountAmount: s.decimal(domain),
    account: s
      .toOne(() => account)
      .fields("accountCurrency", "accountAmount")
      .references("currency", "amount"),
  });
  return { account, entry };
}

describe("fixed-decimal foreign-key domains", () => {
  it.each([
    ["precision", { precision: 13, scale: 2 }],
    ["scale", { precision: 12, scale: 3 }],
  ])("refuses a different %s through FK003", (_member, domain) => {
    const result = decimalReference(domain);
    const issue = result.errors.find((candidate) => candidate.code === "FK003");

    expect(issue).toBeDefined();
    expect(issue?.message).toContain("decimal(12,2)");
    expect(issue?.message).toContain(
      `decimal(${domain.precision},${domain.scale})`
    );
    expect(issue?.repair).toMatch(SAME_DECIMAL_DOMAIN);
  });

  it("accepts identical precision and scale", () => {
    const result = decimalReference({ precision: 12, scale: 2 });

    expect(result.errors.map((issue) => issue.code)).not.toContain("FK003");
  });

  it("refuses a later compound member mismatch instead of publishing topology", () => {
    const schema = compoundDecimalReference({ precision: 13, scale: 2 });
    let publication: ReturnType<typeof validateSchemaOrThrow> | undefined;
    let refusal: unknown;

    try {
      publication = validateSchemaOrThrow(schema);
    } catch (error) {
      refusal = error;
    }

    expect(publication).toBeUndefined();
    expect(refusal).toBeInstanceOf(SchemaValidationError);
    if (!(refusal instanceof SchemaValidationError)) throw refusal;
    const issue = refusal.issues.find(
      (candidate) => candidate.code === "FK003"
    );
    expect(issue?.message).toContain("'accountAmount' (decimal(13,2))");
    expect(issue?.message).toContain("'amount' (decimal(12,2))");
    expect(issue?.repair).toMatch(SAME_DECIMAL_DOMAIN);
  });
});
