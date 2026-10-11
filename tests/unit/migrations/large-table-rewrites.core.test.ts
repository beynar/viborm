/**
 * T5a's classifier: which PostgreSQL statements rewrite or scan an existing
 * table under a lock that blocks it, and which do neither. The live refusal
 * is pinned on PGlite in `large-table-refusal.test.ts`.
 */

import { tableRewrites } from "@src/migrations/compile";
import { describe, expect, it } from "vitest";

const T = '"public"."accounts"';

describe("tableRewrites", () => {
  it("names the generated rewrites and scans with their table", () => {
    expect(
      tableRewrites([
        `ALTER TABLE ${T} ALTER COLUMN "age" TYPE bigint USING "age"::bigint`,
        `ALTER TABLE ${T} ALTER COLUMN "status" TYPE text USING "status"::text`,
        `ALTER TABLE ${T} ALTER COLUMN "score" SET NOT NULL`,
        `ALTER TABLE ${T} ADD COLUMN "trackingId" uuid NOT NULL DEFAULT gen_random_uuid()`,
        `ALTER TABLE ${T} ADD COLUMN "seq" SERIAL NOT NULL`,
        `ALTER TABLE ${T} ADD CONSTRAINT "accounts_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."teams" ("id")`,
        `ALTER TABLE ${T} ADD CONSTRAINT "viborm_decimal" CHECK ("price" = "price"::numeric(12,4))`,
      ])
    ).toEqual([
      { table: T, operation: 'column type change of "age"' },
      { table: T, operation: 'column type change of "status"' },
      { table: T, operation: 'SET NOT NULL on "score"' },
      { table: T, operation: 'volatile default on new column "trackingId"' },
      { table: T, operation: 'volatile default on new column "seq"' },
      { table: T, operation: "FOREIGN KEY validation" },
      { table: T, operation: "CHECK validation" },
    ]);
  });

  it("reads manual spellings, one per ALTER TABLE in a dispatch", () => {
    expect(
      tableRewrites([
        "alter table only accounts alter age set data type bigint;\nALTER TABLE teams\n  ADD COLUMN token text DEFAULT md5(random()::text)",
      ])
    ).toEqual([
      { table: "accounts", operation: "column type change of age" },
      { table: "teams", operation: "volatile default on new column token" },
    ]);
  });

  it("reads ADD without COLUMN, and NOT VALID only on its own action", () => {
    expect(
      tableRewrites([
        "ALTER TABLE accounts ADD token uuid DEFAULT gen_random_uuid()",
        "ALTER TABLE accounts ADD CONSTRAINT a FOREIGN KEY (x) REFERENCES t (id), ADD CONSTRAINT b CHECK (y > 0) NOT VALID",
        "ALTER TABLE teams ADD PRIMARY KEY (id), ADD CONSTRAINT c FOREIGN KEY (a, b) REFERENCES t (a, b) NOT VALID",
      ])
    ).toEqual([
      { table: "accounts", operation: "volatile default on new column token" },
      { table: "accounts", operation: "FOREIGN KEY validation" },
    ]);
  });

  it("leaves a table the program created earlier by that spelling: it is empty", () => {
    expect(
      tableRewrites([
        `ALTER TABLE ${T} ALTER COLUMN "age" TYPE bigint`,
        `DROP TABLE ${T}`,
        `CREATE TABLE ${T} ("id" text PRIMARY KEY, "teamId" text)`,
        `ALTER TABLE ${T} ADD CONSTRAINT "accounts_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."teams" ("id")`,
        'CREATE TABLE IF NOT EXISTS "teams" ("id" text); ALTER TABLE "teams" ALTER COLUMN "id" SET NOT NULL',
      ])
    ).toEqual([
      { table: T, operation: 'column type change of "age"' },
      { table: '"teams"', operation: 'SET NOT NULL on "id"' },
    ]);
  });

  it("leaves what rewrites nothing and scans nothing under a blocking lock", () => {
    expect(
      tableRewrites([
        `ALTER TABLE ${T} ALTER COLUMN "score" DROP NOT NULL`,
        `ALTER TABLE ${T} ADD COLUMN "nickname" text`,
        `ALTER TABLE ${T} ADD COLUMN "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
        `ALTER TABLE ${T} ADD CONSTRAINT "accounts_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "public"."teams" ("id") NOT VALID`,
        `ALTER TABLE ${T} VALIDATE CONSTRAINT "accounts_teamId_fkey"`,
        `ALTER TABLE ${T} ALTER COLUMN "status" SET DEFAULT 'trial'`,
        `ALTER TABLE ${T} RENAME COLUMN "age" TO "years"`,
        `CREATE INDEX "accounts_age_idx" ON ${T} ("age")`,
        `UPDATE ${T} SET "age" = 1`,
      ])
    ).toEqual([]);
  });
});
