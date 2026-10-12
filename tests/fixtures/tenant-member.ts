/**
 * Tenant schema documents for the tenant migrator suites (plan D4): one
 * 15-field model, the same document reordered, a drop, and two additions.
 */

import type { MigrationDecisionV1 } from "@src/migrations/v1-types";

export const MEMBER_ROWS = 10_000;

const fields = {
  id: { type: "string", id: true },
  email: { type: "string", unique: true },
  displayName: { type: "string" },
  plan: { type: "enum", enum: "plan", default: "free" },
  seats: { type: "int", default: 1 },
  legacyRef: { type: "string", nullable: true },
  profile: { type: "json", nullable: true },
  lastSeenAt: { type: "datetime", nullable: true },
  locale: { type: "string", default: "en" },
  timezone: { type: "string", nullable: true },
  invitedBy: { type: "string", nullable: true },
  loginCount: { type: "int", default: 0 },
  archived: { type: "boolean", default: false },
  createdAt: { type: "datetime", generate: { kind: "now" } },
  updatedAt: { type: "datetime", generate: { kind: "updatedAt" } },
};
const note = { type: "string", nullable: true };
const document = (memberFields: object) => ({
  version: 1,
  enums: { plan: { values: ["free", "team", "business"] } },
  models: { member: { fields: memberFields } },
});
const { legacyRef: _legacyRef, ...withoutLegacyRef } = fields;

export const memberDocument = document(fields);
/** The same schema with its fields in reverse order. */
export const reorderedMemberDocument = document(
  Object.fromEntries(Object.entries(fields).reverse())
);
export const droppedLegacyRefDocument = document(withoutLegacyRef);
export const noteDocument = document({ ...fields, note });
export const noteTagDocument = document({ ...fields, note, tag: note });

export const approveLegacyRefDrop: MigrationDecisionV1 = {
  type: "destructive",
  operation: "dropColumn",
  table: "member",
  column: "legacyRef",
};

export const TENANT_OUTCOMES = [
  "applied",
  "noop",
  "refused",
  "failed",
  "ambiguous",
] as const;

/** `MEMBER_ROWS` members, in SQL both SQLite and PostgreSQL run. */
export function seedMembersSql(table: string, now: string): string {
  return `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${MEMBER_ROWS})
INSERT INTO ${table} ("id", "email", "displayName", "legacyRef", "createdAt", "updatedAt")
SELECT 'm-' || i, 'm' || i || '@example.test', 'Member ' || i, 'L-' || i, ${now}, ${now} FROM n`;
}
