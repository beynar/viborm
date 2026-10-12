/**
 * Shared T1 fixture: one tenant schema document, the same document with its
 * models and fields reordered, and the facts both dialects must agree on.
 *
 * Not a suite: `_`-prefixed support module for the migration suites.
 */

import { createMigrationClient } from "@migrations/client";
import { MemoryEstateStorage } from "@migrations/storage/memory";

export const INVOICE_ROWS = 2000;

const invoiceFields = {
  id: { type: "string", id: true },
  number: { type: "string", unique: true },
  customerEmail: { type: "string" },
  status: { type: "enum", enum: "invoiceStatus", default: "draft" },
  currency: { type: "string", default: "EUR" },
  amountCents: { type: "int" },
  taxCents: { type: "int", default: 0 },
  balanceCents: { type: "int" },
  notes: { type: "string", nullable: true },
  metadata: { type: "json", nullable: true },
  dueAt: { type: "datetime", nullable: true },
  paidAt: { type: "datetime", nullable: true },
  reminderCount: { type: "int", default: 0 },
  createdAt: { type: "datetime", generate: { kind: "now" } },
};
const customerFields = {
  id: { type: "string", id: true },
  email: { type: "string", unique: true },
  name: { type: "string" },
  country: { type: "string", nullable: true },
};
const enums = { invoiceStatus: { values: ["draft", "sent", "paid", "void"] } };

export const invoiceDocument = {
  version: 1,
  enums,
  models: {
    invoice: { fields: invoiceFields },
    customer: { fields: customerFields },
  },
};

const reversed = (record: object) =>
  Object.fromEntries(Object.entries(record).reverse());

/** The same schema: model keys swapped, every model's fields reversed. */
export const reorderedDocument = {
  version: 1,
  enums,
  models: {
    customer: { fields: reversed(customerFields) },
    invoice: { fields: reversed(invoiceFields) },
  },
};

/** Valid on SQLite and PostgreSQL: 2,000 invoices through a recursive CTE. */
const SEED_INVOICES = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${INVOICE_ROWS})
INSERT INTO "invoice" ("id", "number", "customerEmail", "amountCents", "balanceCents")
SELECT 'inv-' || i, 'N-' || i, 'c' || i || '@example.test', 1000, 1000 FROM n`;

type TenantClient = Parameters<typeof createMigrationClient>[0] & {
  $disconnect(): Promise<void>;
};

/**
 * Generates the document twice on fresh estates, then migrates one estate,
 * seeds it, and generates the reordered document over it.
 */
export async function documentOrderFacts(
  open: (documentText: string) => TenantClient,
  exec: (sqlText: string) => Promise<unknown>
) {
  const generateFresh = async () => {
    const client = open(JSON.stringify(invoiceDocument));
    try {
      return await createMigrationClient(client, {
        storage: new MemoryEstateStorage(),
      }).generate({ name: "init" });
    } finally {
      await client.$disconnect();
    }
  };
  const first = await generateFresh();
  const second = await generateFresh();

  const storage = new MemoryEstateStorage();
  const original = open(JSON.stringify(invoiceDocument));
  const migrations = createMigrationClient(original, { storage });
  await migrations.generate({ name: "init" });
  await migrations.apply();
  await exec(SEED_INVOICES);
  await original.$disconnect();

  const reordered = open(JSON.stringify(reorderedDocument));
  try {
    const tenant = createMigrationClient(reordered, { storage });
    const statesBefore = (await tenant.list()).length;
    const reorder = await tenant.generate({ name: "reorder" });
    return {
      first,
      second,
      reorder,
      published: (await tenant.list()).length - statesBefore,
      pending: (await tenant.status()).pending,
      verified: (await tenant.verify()).ok,
    };
  } finally {
    await reordered.$disconnect();
  }
}
