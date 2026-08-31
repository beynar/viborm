import { s } from "@schema";
import {
  type CreateRacePin,
  createDataSpellsRacePin,
  createRacePin,
} from "@src/query-engine/write-engine/create-race-pin";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const entry = s
  .model({
    id: s.string().id(),
    tenant: s.string(),
    slug: s.string(),
    archived: s.boolean(),
  })
  .unique(["tenant", "slug"], { name: "tenantSlug" })
  .map("race_pin_entries");

prepareSchema({ entry });

const scope = scopeFor(new PlanningDriver("postgresql").adapter, entry);

const foldableKeys: ReadonlyArray<
  readonly [string, string | number | bigint | boolean]
> = [
  ["string", "entry-1"],
  ["number", 1],
  ["bigint", 1n],
  ["boolean", true],
];

function raceFor(value: unknown): CreateRacePin {
  return {
    pin: {
      fields: ["id"],
      table: "race_pin_entries",
      columns: ["id"],
      constraints: ["race_pin_entries_pkey", "PRIMARY"],
    },
    values: [{ fieldName: "id", value }],
  };
}

describe("create race pins", () => {
  test("an exact compound selector publishes one pin and its proposed tuple", () => {
    const race = createRacePin(scope, {
      tenantSlug: { tenant: "tenant-1", slug: "welcome" },
    });

    expect(race).toEqual({
      pin: {
        fields: ["tenant", "slug"],
        table: "race_pin_entries",
        columns: ["tenant", "slug"],
        constraints: ["race_pin_entries_tenantSlug_key"],
      },
      values: [
        { fieldName: "tenant", value: "tenant-1" },
        { fieldName: "slug", value: "welcome" },
      ],
    });
  });

  test("an extended selector cannot claim that its unique tuple was absent", () => {
    expect(
      createRacePin(scope, {
        id: "entry-1",
        archived: { equals: false },
      })
    ).toBeUndefined();
  });

  test("the proposed insert must spell the exact primitive tuple", () => {
    const race = createRacePin(scope, { id: "entry-1" });
    if (!race) throw new Error("Expected an exact primary-key race pin.");

    expect(
      createDataSpellsRacePin(
        { id: "entry-1", tenant: "tenant-1", slug: "welcome" },
        race
      )
    ).toBe(true);
    expect(createDataSpellsRacePin({ id: "other" }, race)).toBe(false);
    expect(createDataSpellsRacePin({}, race)).toBe(false);
  });

  test.each(foldableKeys)(
    "a matching %s key is foldable create evidence",
    (_kind, value) => {
      expect(createDataSpellsRacePin({ id: value }, raceFor(value))).toBe(true);
    }
  );

  test("provider-shaped objects are not foldable create-key evidence", () => {
    const value = new Date(0);
    expect(createDataSpellsRacePin({ id: value }, raceFor(value))).toBe(false);
  });
});
