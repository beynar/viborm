/**
 * Decimal Precision in Relations Test
 *
 * This test verifies that Decimal values preserve their full precision
 * when fetched through relations using JSON aggregation.
 *
 * The issue: When using include/select on relations, the ORM uses database
 * JSON functions (json_agg, JSON_ARRAYAGG, json_group_array) to aggregate
 * related data. Decimal values in JSON may lose precision due to JavaScript
 * number limitations (IEEE 754 double-precision).
 *
 * The fix: Cast Decimal fields to TEXT in SQL before JSON aggregation,
 * then convert back to number during result parsing.
 *
 * Key precision limits:
 * - JavaScript numbers have ~15-17 significant digits of precision
 * - PostgreSQL DECIMAL can store much higher precision
 * - Values with more than 15 significant digits may lose precision
 */

import { createClient as PGliteCreateClient } from "@drivers/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// =============================================================================
// TEST CONSTANTS
// =============================================================================

// Note: JavaScript numbers are IEEE 754 double-precision, which has ~15-17
// significant digits of precision. Values beyond this will lose precision
// in JavaScript itself, not due to the ORM.
//
// These tests verify that decimal values are correctly:
// 1. Stored in the database
// 2. Retrieved through relations (JSON aggregation)
// 3. Parsed back to numbers without additional precision loss

// Large value within safe precision (15 significant digits)
const LARGE_DECIMAL = 123_456_789_012_345.67;

// High precision - many decimal places within safe range
const HIGH_PRECISION_DECIMAL = 0.123_456_789_012_345;

// Near max safe integer with decimals
const NEAR_MAX_PRECISION = 9_007_199_254_740.99;

// Negative large value
const NEGATIVE_LARGE_DECIMAL = -123_456_789_012_345.67;

// Standard decimal values (control values)
const SAFE_DECIMAL = 123_456.789;
const SIMPLE_DECIMAL = 99.99;

// Currency-like precision values
const CURRENCY_VALUE_1 = 1_234_567_890.12;
const CURRENCY_VALUE_2 = 9_876_543_210.99;

// Scientific notation values (internally stored as decimal)
const SMALL_SCIENTIFIC = 0.000_001;
const LARGE_SCIENTIFIC = 1_000_000.001;

// Regex pattern for high precision decimal verification
const HIGH_PRECISION_PATTERN = /^0\.1234/;

// =============================================================================
// MODEL DEFINITIONS
// =============================================================================

const merchant = s.model({
  id: s.string().id(),
  name: s.string(),
  // Decimal fields that will be fetched through relations
  totalRevenue: s.decimal(),
  averageRating: s.decimal().nullable(),
  transactions: s.oneToMany(() => transaction),
});

const transaction = s.model({
  id: s.string().id(),
  description: s.string(),
  // Decimal field on the child model
  amount: s.decimal(),
  taxAmount: s.decimal().nullable(),
  // Foreign key
  merchantId: s.string(),
  merchant: s
    .manyToOne(() => merchant)
    .fields("merchantId")
    .references("id"),
});

const schema = { merchant, transaction };

// =============================================================================
// TEST SETUP
// =============================================================================

let client: Awaited<
  ReturnType<typeof PGliteCreateClient<{ schema: typeof schema }>>
>;

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const pglite = new PGlite();
  client = await PGliteCreateClient({ schema, client: pglite });
  await push(client, { force: true });
});

afterAll(async () => {
  await client.$disconnect();
});

// =============================================================================
// DECIMAL PRECISION TESTS
// =============================================================================

describe("Decimal Precision in Relations", () => {
  beforeAll(async () => {
    // Create merchant with large Decimal values
    await client.merchant.create({
      data: {
        id: "merchant-1",
        name: "Large Revenue Merchant",
        totalRevenue: LARGE_DECIMAL,
        averageRating: HIGH_PRECISION_DECIMAL,
      },
    });

    await client.merchant.create({
      data: {
        id: "merchant-2",
        name: "Standard Merchant",
        totalRevenue: SAFE_DECIMAL,
        averageRating: null,
      },
    });

    await client.merchant.create({
      data: {
        id: "merchant-3",
        name: "Currency Merchant",
        totalRevenue: CURRENCY_VALUE_1,
        averageRating: 4.5,
      },
    });

    // Create transactions with various decimal values
    await client.transaction.create({
      data: {
        id: "txn-1",
        description: "Large Transaction",
        amount: NEAR_MAX_PRECISION,
        taxAmount: NEGATIVE_LARGE_DECIMAL,
        merchantId: "merchant-1",
      },
    });

    await client.transaction.create({
      data: {
        id: "txn-2",
        description: "Standard Transaction",
        amount: LARGE_DECIMAL,
        taxAmount: SIMPLE_DECIMAL,
        merchantId: "merchant-1",
      },
    });

    await client.transaction.create({
      data: {
        id: "txn-3",
        description: "Currency Transaction",
        amount: CURRENCY_VALUE_2,
        taxAmount: null,
        merchantId: "merchant-3",
      },
    });

    await client.transaction.create({
      data: {
        id: "txn-4",
        description: "Small Value Transaction",
        amount: SMALL_SCIENTIFIC,
        taxAmount: LARGE_SCIENTIFIC,
        merchantId: "merchant-2",
      },
    });
  });

  test("oneToMany: Decimal precision preserved when fetching children", async () => {
    const merchantWithTxns = await client.merchant.findUnique({
      where: { id: "merchant-1" },
      include: { transactions: true },
    });

    expect(merchantWithTxns).not.toBeNull();
    if (!merchantWithTxns) throw new Error("Merchant not found");

    // Verify children Decimal values have precision
    expect(merchantWithTxns.transactions.length).toBe(2);

    const txn1 = merchantWithTxns.transactions.find((t) => t.id === "txn-1")!;
    const txn2 = merchantWithTxns.transactions.find((t) => t.id === "txn-2")!;

    // Test precision preservation - compare as numbers
    expect(Number(txn1.amount)).toBeCloseTo(NEAR_MAX_PRECISION, 0);
    expect(Number(txn1.taxAmount)).toBeCloseTo(NEGATIVE_LARGE_DECIMAL, 0);
    expect(Number(txn2.amount)).toBeCloseTo(LARGE_DECIMAL, 0);
    expect(Number(txn2.taxAmount)).toBe(SIMPLE_DECIMAL);

    // Verify type (PostgreSQL returns decimal as string or number)
    expect(
      typeof txn1.amount === "number" || typeof txn1.amount === "string"
    ).toBe(true);
    expect(
      typeof txn2.amount === "number" || typeof txn2.amount === "string"
    ).toBe(true);
  });

  test("manyToOne: Decimal precision preserved when fetching parent", async () => {
    const txnWithMerchant = await client.transaction.findUnique({
      where: { id: "txn-1" },
      include: { merchant: true },
    });

    expect(txnWithMerchant).not.toBeNull();
    if (!txnWithMerchant) throw new Error("Transaction not found");

    // Verify parent Decimal values have precision
    expect(Number(txnWithMerchant.merchant.totalRevenue)).toBeCloseTo(
      LARGE_DECIMAL,
      0
    );
    expect(Number(txnWithMerchant.merchant.averageRating)).toBeCloseTo(
      HIGH_PRECISION_DECIMAL,
      10
    );

    // Verify type
    expect(
      typeof txnWithMerchant.merchant.totalRevenue === "number" ||
        typeof txnWithMerchant.merchant.totalRevenue === "string"
    ).toBe(true);
  });

  test("nested relations: Decimal precision preserved through multiple levels", async () => {
    const merchantWithTxns = await client.merchant.findUnique({
      where: { id: "merchant-1" },
      include: {
        transactions: {
          include: { merchant: true },
        },
      },
    });

    expect(merchantWithTxns).not.toBeNull();
    if (!merchantWithTxns) throw new Error("Merchant not found");

    // First level: merchant Decimal
    expect(Number(merchantWithTxns.totalRevenue)).toBeCloseTo(LARGE_DECIMAL, 0);

    // Second level: transactions Decimal
    const txn1 = merchantWithTxns.transactions.find((t) => t.id === "txn-1")!;
    expect(Number(txn1.amount)).toBeCloseTo(NEAR_MAX_PRECISION, 0);

    // Third level: nested merchant Decimal (back reference)
    expect(Number(txn1.merchant.totalRevenue)).toBeCloseTo(LARGE_DECIMAL, 0);
  });

  test("findMany with include: Decimal precision preserved across multiple results", async () => {
    const allTxns = await client.transaction.findMany({
      include: { merchant: true },
    });

    expect(allTxns.length).toBe(4);

    for (const txn of allTxns) {
      // Transaction Decimal values
      expect(
        typeof txn.amount === "number" || typeof txn.amount === "string"
      ).toBe(true);

      // Merchant Decimal values through relation
      expect(
        typeof txn.merchant.totalRevenue === "number" ||
          typeof txn.merchant.totalRevenue === "string"
      ).toBe(true);
    }

    // Verify specific values
    const txn1 = allTxns.find((t) => t.id === "txn-1")!;
    expect(Number(txn1.amount)).toBeCloseTo(NEAR_MAX_PRECISION, 0);
    expect(Number(txn1.merchant.totalRevenue)).toBeCloseTo(LARGE_DECIMAL, 0);
  });

  test("select with include: Decimal precision preserved with field selection", async () => {
    const result = await client.merchant.findUnique({
      where: { id: "merchant-1" },
      select: {
        id: true,
        totalRevenue: true,
        transactions: {
          select: {
            id: true,
            amount: true,
          },
        },
      },
    });

    expect(result).not.toBeNull();
    if (!result) throw new Error("Result not found");

    // Parent Decimal with select
    expect(Number(result.totalRevenue)).toBeCloseTo(LARGE_DECIMAL, 0);

    // Children Decimal with nested select
    const txn1 = result.transactions.find((t) => t.id === "txn-1")!;
    expect(Number(txn1.amount)).toBeCloseTo(NEAR_MAX_PRECISION, 0);
  });

  test("nullable Decimal: null values handled correctly in relations", async () => {
    const merchantWithNullDecimal = await client.merchant.findUnique({
      where: { id: "merchant-2" },
    });

    expect(merchantWithNullDecimal).not.toBeNull();
    if (!merchantWithNullDecimal) throw new Error("Merchant not found");

    // Nullable Decimal that is null
    expect(merchantWithNullDecimal.averageRating).toBeNull();

    // Verify through relation too
    const txnWithMerchant = await client.transaction.findUnique({
      where: { id: "txn-1" },
      include: { merchant: true },
    });

    expect(Number(txnWithMerchant?.merchant.averageRating)).toBeCloseTo(
      HIGH_PRECISION_DECIMAL,
      10
    );
  });

  test("currency-like precision: values with 2 decimal places preserved", async () => {
    const merchantWithTxns = await client.merchant.findUnique({
      where: { id: "merchant-3" },
      include: { transactions: true },
    });

    expect(merchantWithTxns).not.toBeNull();
    if (!merchantWithTxns) throw new Error("Merchant not found");

    // Currency values should preserve 2 decimal places exactly
    expect(Number(merchantWithTxns.totalRevenue)).toBe(CURRENCY_VALUE_1);

    const txn = merchantWithTxns.transactions.find((t) => t.id === "txn-3")!;
    expect(Number(txn.amount)).toBe(CURRENCY_VALUE_2);
  });

  test("small decimal values: precision preserved for values close to zero", async () => {
    const txnWithMerchant = await client.transaction.findUnique({
      where: { id: "txn-4" },
      include: { merchant: true },
    });

    expect(txnWithMerchant).not.toBeNull();
    if (!txnWithMerchant) throw new Error("Transaction not found");

    // Small values should be preserved
    expect(Number(txnWithMerchant.amount)).toBeCloseTo(SMALL_SCIENTIFIC, 10);
    expect(Number(txnWithMerchant.taxAmount)).toBeCloseTo(LARGE_SCIENTIFIC, 10);
  });

  test("negative decimal values: sign preserved in relations", async () => {
    const merchantWithTxns = await client.merchant.findUnique({
      where: { id: "merchant-1" },
      include: { transactions: true },
    });

    expect(merchantWithTxns).not.toBeNull();
    if (!merchantWithTxns) throw new Error("Merchant not found");

    const txn1 = merchantWithTxns.transactions.find((t) => t.id === "txn-1")!;

    // Negative value should preserve sign
    const taxAmount = Number(txn1.taxAmount);
    expect(taxAmount).toBeLessThan(0);
    expect(taxAmount).toBeCloseTo(NEGATIVE_LARGE_DECIMAL, 0);
  });

  test("high precision decimal: many decimal places preserved", async () => {
    const txnWithMerchant = await client.transaction.findUnique({
      where: { id: "txn-1" },
      include: { merchant: true },
    });

    expect(txnWithMerchant).not.toBeNull();
    if (!txnWithMerchant) throw new Error("Transaction not found");

    // High precision value - check first several decimal places
    const rating = Number(txnWithMerchant.merchant.averageRating);
    expect(rating).toBeCloseTo(HIGH_PRECISION_DECIMAL, 10);

    // Verify it starts with 0.1234...
    expect(rating.toString()).toMatch(HIGH_PRECISION_PATTERN);
  });

  test("decimal arrays in findMany: all values preserved", async () => {
    const allMerchants = await client.merchant.findMany({
      include: { transactions: true },
      orderBy: { id: "asc" },
    });

    expect(allMerchants.length).toBe(3);

    // Verify merchant-1 values
    const merchant1 = allMerchants.find((m) => m.id === "merchant-1")!;
    expect(Number(merchant1.totalRevenue)).toBeCloseTo(LARGE_DECIMAL, 0);
    expect(merchant1.transactions.length).toBe(2);

    // Verify merchant-2 values
    const merchant2 = allMerchants.find((m) => m.id === "merchant-2")!;
    expect(Number(merchant2.totalRevenue)).toBe(SAFE_DECIMAL);
    expect(merchant2.averageRating).toBeNull();

    // Verify merchant-3 values
    const merchant3 = allMerchants.find((m) => m.id === "merchant-3")!;
    expect(Number(merchant3.totalRevenue)).toBe(CURRENCY_VALUE_1);
    expect(Number(merchant3.averageRating)).toBe(4.5);
  });

  test("decimal type verification: values are number type after parsing", async () => {
    // Fetch a simple decimal value directly
    const merchant = await client.merchant.findUnique({
      where: { id: "merchant-3" },
    });

    expect(merchant).not.toBeNull();
    if (!merchant) throw new Error("Merchant not found");

    // After ORM parsing, the value should be usable as a number
    const revenue = Number(merchant.totalRevenue);
    expect(typeof revenue).toBe("number");
    expect(Number.isNaN(revenue)).toBe(false);
    expect(Number.isFinite(revenue)).toBe(true);

    // Can perform arithmetic operations
    const doubled = revenue * 2;
    expect(doubled).toBe(CURRENCY_VALUE_1 * 2);
  });
});

// =============================================================================
// DECIMAL EDGE CASES
// =============================================================================

describe("Decimal Edge Cases", () => {
  beforeAll(async () => {
    // Create edge case test data
    await client.merchant.create({
      data: {
        id: "merchant-edge-zero",
        name: "Zero Values",
        totalRevenue: 0,
        averageRating: 0.0,
      },
    });

    await client.merchant.create({
      data: {
        id: "merchant-edge-tiny",
        name: "Tiny Values",
        totalRevenue: 0.000_000_1,
        averageRating: 0.999_999_999_9,
      },
    });

    await client.transaction.create({
      data: {
        id: "txn-edge-zero",
        description: "Zero Transaction",
        amount: 0,
        taxAmount: 0.0,
        merchantId: "merchant-edge-zero",
      },
    });

    await client.transaction.create({
      data: {
        id: "txn-edge-tiny",
        description: "Tiny Transaction",
        amount: 0.000_000_000_1,
        taxAmount: 0.999_999_999_999_9,
        merchantId: "merchant-edge-tiny",
      },
    });
  });

  test("zero values: preserved through relations", async () => {
    const result = await client.merchant.findUnique({
      where: { id: "merchant-edge-zero" },
      include: { transactions: true },
    });

    expect(result).not.toBeNull();
    if (!result) throw new Error("Result not found");

    // Zero values
    expect(Number(result.totalRevenue)).toBe(0);
    expect(Number(result.averageRating)).toBe(0);

    const txn = result.transactions.find((t) => t.id === "txn-edge-zero")!;
    expect(Number(txn.amount)).toBe(0);
    expect(Number(txn.taxAmount)).toBe(0);
  });

  test("very small positive values: preserved through relations", async () => {
    const result = await client.merchant.findUnique({
      where: { id: "merchant-edge-tiny" },
      include: { transactions: true },
    });

    expect(result).not.toBeNull();
    if (!result) throw new Error("Result not found");

    // Tiny values should be preserved
    expect(Number(result.totalRevenue)).toBeCloseTo(0.000_000_1, 10);
    expect(Number(result.averageRating)).toBeCloseTo(0.999_999_999_9, 10);

    const txn = result.transactions.find((t) => t.id === "txn-edge-tiny")!;
    expect(Number(txn.amount)).toBeCloseTo(0.000_000_000_1, 12);
    expect(Number(txn.taxAmount)).toBeCloseTo(0.999_999_999_999_9, 10);
  });

  test("manyToOne with edge values: precision preserved", async () => {
    const result = await client.transaction.findUnique({
      where: { id: "txn-edge-tiny" },
      include: { merchant: true },
    });

    expect(result).not.toBeNull();
    if (!result) throw new Error("Result not found");

    // Parent with tiny values
    expect(Number(result.merchant.totalRevenue)).toBeCloseTo(0.000_000_1, 10);
    expect(Number(result.merchant.averageRating)).toBeCloseTo(
      0.999_999_999_9,
      10
    );
  });

  test("mixed zero and non-zero in findMany", async () => {
    // Fetch edge case transactions using OR condition
    const allTxns = await client.transaction.findMany({
      where: {
        OR: [{ id: "txn-edge-zero" }, { id: "txn-edge-tiny" }],
      },
      include: { merchant: true },
      orderBy: { id: "asc" },
    });

    expect(allTxns.length).toBe(2);

    // Zero transaction
    const zeroTxn = allTxns.find((t) => t.id === "txn-edge-zero")!;
    expect(Number(zeroTxn.amount)).toBe(0);
    expect(Number(zeroTxn.merchant.totalRevenue)).toBe(0);

    // Tiny transaction
    const tinyTxn = allTxns.find((t) => t.id === "txn-edge-tiny")!;
    expect(Number(tinyTxn.amount)).toBeCloseTo(0.000_000_000_1, 12);
    expect(Number(tinyTxn.merchant.totalRevenue)).toBeCloseTo(0.000_000_1, 10);
  });
});

// =============================================================================
// DECIMAL COMPARISON TESTS (Value integrity)
// =============================================================================

describe("Decimal Value Integrity", () => {
  test("decimal values match between direct query and relation include", async () => {
    // Get merchant directly
    const merchantDirect = await client.merchant.findUnique({
      where: { id: "merchant-1" },
    });

    // Get merchant through relation
    const txn = await client.transaction.findUnique({
      where: { id: "txn-1" },
      include: { merchant: true },
    });

    expect(merchantDirect).not.toBeNull();
    expect(txn).not.toBeNull();
    if (!(merchantDirect && txn)) throw new Error("Data not found");

    // Values should match exactly
    expect(Number(merchantDirect.totalRevenue)).toBe(
      Number(txn.merchant.totalRevenue)
    );
    expect(Number(merchantDirect.averageRating)).toBe(
      Number(txn.merchant.averageRating)
    );
  });

  test("transaction decimal values match between direct and included", async () => {
    // Get transaction directly
    const txnDirect = await client.transaction.findUnique({
      where: { id: "txn-1" },
    });

    // Get transaction through relation
    const merchant = await client.merchant.findUnique({
      where: { id: "merchant-1" },
      include: { transactions: true },
    });

    expect(txnDirect).not.toBeNull();
    expect(merchant).not.toBeNull();
    if (!(txnDirect && merchant)) throw new Error("Data not found");

    const txnIncluded = merchant.transactions.find((t) => t.id === "txn-1")!;

    // Values should match exactly
    expect(Number(txnDirect.amount)).toBe(Number(txnIncluded.amount));
    expect(Number(txnDirect.taxAmount)).toBe(Number(txnIncluded.taxAmount));
  });

  test("decimal precision maintained through multiple relation loads", async () => {
    // Load the same data multiple times
    const results = await Promise.all([
      client.merchant.findUnique({
        where: { id: "merchant-1" },
        include: { transactions: true },
      }),
      client.merchant.findUnique({
        where: { id: "merchant-1" },
        include: { transactions: true },
      }),
      client.merchant.findUnique({
        where: { id: "merchant-1" },
        include: { transactions: true },
      }),
    ]);

    // All results should have identical decimal values
    for (let i = 1; i < results.length; i++) {
      expect(Number(results[i]!.totalRevenue)).toBe(
        Number(results[0]!.totalRevenue)
      );
      expect(Number(results[i]!.averageRating)).toBe(
        Number(results[0]!.averageRating)
      );

      for (const txn of results[i]!.transactions) {
        const matchingTxn = results[0]!.transactions.find(
          (t) => t.id === txn.id
        )!;
        expect(Number(txn.amount)).toBe(Number(matchingTxn.amount));
      }
    }
  });
});
