import { hydrateSchemaNames, s } from "@schema";
import { findAddressableKey, getColumnName, getTableName } from "@schema/model";
import { describe, expect, test } from "vitest";

describe("schema model runtime projections", () => {
  test("resolves bare and grouped public selector keys", () => {
    const account = s
      .model({
        id: s.string().id(),
        email: s.string().unique(),
        region: s.string(),
        handle: s.string(),
      })
      .unique(["region", "handle"], { name: "regionalHandle" });

    expect(findAddressableKey(account, "email")).toEqual({
      kind: "unique",
      fields: ["email"],
    });
    expect(findAddressableKey(account, "regionalHandle")).toEqual({
      kind: "compoundUnique",
      name: "regionalHandle",
      fields: ["region", "handle"],
    });
    expect(findAddressableKey(account, "region")).toBeUndefined();
  });

  test("projects hydrated SQL names through the model registry", () => {
    const account = s
      .model({ id: s.string().id().map("account_id") })
      .map("accounts");

    expect(getTableName(account)).toBe("accounts");
    expect(getTableName(s.model({ id: s.string() }), "fallback_table")).toBe(
      "fallback_table"
    );

    hydrateSchemaNames({ account });

    expect(getTableName(account)).toBe("accounts");
    expect(getColumnName(account, "id")).toBe("account_id");
  });
});

describe("coverage low value", () => {
  test("silently excludes malformed members from classified model maps", () => {
    const malformed = s.model({
      primitive: 1 as never,
      callable: (() => undefined) as never,
      nullState: { "~": { state: null } } as never,
    });

    expect(malformed["~"].state.scalars).toEqual({});
    expect(malformed["~"].state.relations).toEqual({});
  });
});
