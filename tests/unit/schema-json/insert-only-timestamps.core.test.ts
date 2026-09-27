/**
 * A schema-JSON round trip keeps creation timestamps insert-only (#47).
 *
 * The document needs no field of its own for the rule: `generate.kind` already
 * records the generator standing after every modifier, and the reader applies
 * `generate` before `default`, so `.now().default(v)` comes back a creation
 * timestamp and `.now().updatedAt()` / `.updatedAt().now()` come back with
 * their last generator. These cells read the update admission of the PARSED
 * schema, which is what a round trip has to preserve.
 */

import { s } from "@schema";
import type { Schema } from "@schema/hydration";
import { parseSchema, serializeSchema } from "@schema/json";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, it } from "vitest";

const LATER = "2026-02-01T00:00:00.000Z";

const declared = {
  event: s.model({
    id: s.string().id(),
    createdAt: s.dateTime().now(),
    bornOn: s.date().nullable().now(),
    openedAt: s.time().now().map("opened_at"),
    touchedAt: s.dateTime().updatedAt(),
    nowThenUpdatedAt: s.dateTime().now().updatedAt(),
    updatedAtThenNow: s.dateTime().updatedAt().now(),
    nowWithLiteral: s.dateTime().now().default(new Date(LATER)),
    plain: s.dateTime().default(new Date(LATER)),
  }),
};

const INSERT_ONLY = [
  "createdAt",
  "bornOn",
  "openedAt",
  "updatedAtThenNow",
  "nowWithLiteral",
];
const UPDATABLE = ["touchedAt", "nowThenUpdatedAt", "plain"];

/** Which of the event's fields its update admission refuses. */
const refusedUpdateKeys = (schema: Schema): string[] => {
  const update = createSchemaRegistry(schema).proxy.event!.core.update;
  return [...INSERT_ONLY, ...UPDATABLE].filter((key) => {
    const value = key === "openedAt" ? "11:00:00" : LATER;
    return parse(update, { [key]: value }).issues !== undefined;
  });
};

describe("schema JSON round trip of insert-only timestamps", () => {
  it("the declared schema refuses exactly the creation timestamps", () => {
    expect(refusedUpdateKeys(declared)).toEqual(INSERT_ONLY);
  });

  it("serialize → parse preserves the restriction and the modifier precedence", () => {
    const document = serializeSchema(declared);
    const fields = document.models.event?.fields ?? {};
    expect(
      Object.fromEntries(
        Object.entries(fields).map(([key, field]) => [
          key,
          "generate" in field ? field.generate?.kind : undefined,
        ])
      )
    ).toEqual({
      // `.id()`'s own implicit generator is restated by `id: true`.
      id: undefined,
      createdAt: "now",
      bornOn: "now",
      openedAt: "now",
      touchedAt: "updatedAt",
      nowThenUpdatedAt: "updatedAt",
      updatedAtThenNow: "now",
      nowWithLiteral: "now",
      plain: undefined,
    });
    const reparsed = parseSchema(document);
    expect(refusedUpdateKeys(reparsed)).toEqual(INSERT_ONLY);
    expect(serializeSchema(reparsed)).toEqual(document);
  });

  it("an authored document with `generate: now` is insert-only too", () => {
    const authored = parseSchema({
      version: 1,
      models: {
        event: {
          fields: {
            id: { type: "string", id: true },
            createdAt: { type: "datetime", generate: { kind: "now" } },
            touchedAt: { type: "datetime", generate: { kind: "updatedAt" } },
          },
        },
      },
    });
    const update = createSchemaRegistry(authored).proxy.event!.core.update;
    expect(parse(update, { createdAt: LATER }).issues?.[0]?.message).toBe(
      "Unknown key: createdAt"
    );
    expect(parse(update, { touchedAt: LATER }).issues).toBeUndefined();
  });
});
