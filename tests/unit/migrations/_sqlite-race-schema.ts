/**
 * The 15-field account model the SQLite exactly-once race migrates. Not a
 * suite: shared by `sqlite-exactly-once.test.ts` and its child runner.
 *
 * Two next versions of `v1`: `column` adds a nullable column, which SQLite
 * alters in place; `rebuild` changes the `currency` default, which it cannot,
 * so that migration rebuilds the table and lifts the foreign-key pragmas
 * around its own transaction.
 */

import { s } from "@schema";

export type RaceVersion = "v1" | "column" | "rebuild";

export function raceSchema(version: RaceVersion) {
  return {
    account: s.model({
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      status: s.enum(["active", "suspended", "closed"]),
      tier: s.enum(["free", "pro", "enterprise"]),
      balance: s.int(),
      creditLimit: s.int().default(0),
      currency: s.string().default(version === "rebuild" ? "USD" : "EUR"),
      country: s.string().nullable(),
      metadata: s.json().nullable(),
      flags: s.int().default(0),
      note: s.string().nullable(),
      lastLoginAt: s.dateTime().nullable(),
      createdAt: s.dateTime().now(),
      updatedAt: s.dateTime().updatedAt(),
      ...(version === "column" ? { referrer: s.string().nullable() } : {}),
    }),
  };
}
