/**
 * Test: Shared Field Across Multiple Models
 *
 * This test verifies that the same field instance can be reused across multiple models
 * without name collision. Previously, fields stored their own names which would be
 * overwritten when the same field was used in multiple models.
 *
 * The fix: Models now own the nameRegistry, not fields.
 */

import { enumField, string } from "../../src/schema/fields";
import { hydrateSchemaNames } from "../../src/schema/hydration";
import { model } from "../../src/schema/model";

describe("Shared Field Across Models", () => {
  test("same enum field can be used in multiple models with different keys", () => {
    // Create a shared status enum field
    const statusEnum = enumField(["ACTIVE", "INACTIVE", "PENDING"] as const);

    // Use the same field in two different models with different keys
    const user = model({
      id: string().id(),
      userStatus: statusEnum,
    });

    const organization = model({
      id: string().id(),
      orgStatus: statusEnum,
    });

    // Hydrate the schema (this is where the bug used to occur)
    const schema = { user, organization };
    hydrateSchemaNames(schema);

    // Verify each model has correct field names in its nameRegistry
    expect(user["~"].getFieldName("userStatus").ts).toBe("userStatus");
    expect(user["~"].getFieldName("userStatus").sql).toBe("userStatus");

    expect(organization["~"].getFieldName("orgStatus").ts).toBe("orgStatus");
    expect(organization["~"].getFieldName("orgStatus").sql).toBe("orgStatus");

    // Verify the underlying field state is unchanged (columnName is undefined since no .map())
    expect(statusEnum["~"].state.columnName).toBeUndefined();
  });

  test("shared field with .map() is correctly resolved per-model", () => {
    // Create a shared field with a mapped column name
    const createdAt = string().map("created_at_column");

    const user = model({
      id: string().id(),
      createdAt,
    });

    const post = model({
      id: string().id(),
      publishedAt: createdAt, // Using same field with different TS key
    });

    const schema = { user, post };
    hydrateSchemaNames(schema);

    // Both models should use the field's .map() column name for SQL
    // but have different TS names
    expect(user["~"].getFieldName("createdAt").ts).toBe("createdAt");
    expect(user["~"].getFieldName("createdAt").sql).toBe("created_at_column");

    expect(post["~"].getFieldName("publishedAt").ts).toBe("publishedAt");
    expect(post["~"].getFieldName("publishedAt").sql).toBe("created_at_column");
  });

  test("model nameRegistry is populated correctly during hydration", () => {
    const user = model({
      id: string().id(),
      email: string().unique().map("email_address"),
      name: string(),
    });

    hydrateSchemaNames({ user });

    // Check nameRegistry contents
    const registry = user["~"].nameRegistry;
    expect(registry.fields.size).toBe(3);

    expect(registry.fields.get("id")).toEqual({ ts: "id", sql: "id" });
    expect(registry.fields.get("email")).toEqual({
      ts: "email",
      sql: "email_address",
    });
    expect(registry.fields.get("name")).toEqual({ ts: "name", sql: "name" });
  });

  test("getFieldName throws for non-hydrated models", () => {
    const user = model({
      id: string().id(),
      email: string().map("email_column"),
    });

    // Without hydration, getFieldName should throw
    expect(() => user["~"].getFieldName("email")).toThrow(
      'Field "email" not found in nameRegistry'
    );
  });

  test("getRelationName throws for non-hydrated models", () => {
    const user = model({
      id: string().id(),
    });

    // Without hydration, getRelationName should throw
    expect(() => user["~"].getRelationName("posts")).toThrow(
      'Relation "posts" not found in nameRegistry'
    );
  });
});
