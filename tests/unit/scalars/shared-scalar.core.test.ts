/**
 * Test: Shared Scalar Across Multiple Models
 *
 * This test verifies that the same scalar instance can be reused across multiple models
 * without name collision. Previously, scalars stored their own names which would be
 * overwritten when the same scalar was used in multiple models.
 *
 * The fix: Models now own the nameRegistry, not scalars.
 */

import {
  getFieldSqlName,
  getModelSqlName,
  getRelationSqlName,
  hydrateSchemaNames,
  isSchemaHydrated,
} from "@src/schema/hydration";
import { model } from "@src/schema/model";
import { toMany } from "@src/schema/relation";
import { enumScalar, string } from "@src/schema/scalars";

describe("Shared Scalar Across Models", () => {
  test("same enum scalar can be used in multiple models with different keys", () => {
    // Create a shared status enum scalar
    const statusEnum = enumScalar(["ACTIVE", "INACTIVE", "PENDING"] as const);

    // Use the same scalar in two different models with different keys
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

    // Verify the underlying scalar state is unchanged (columnName is undefined since no .map())
    expect(statusEnum["~"].state.columnName).toBeUndefined();
  });

  test("shared scalar with .map() is correctly resolved per-model", () => {
    // Create a shared scalar with a mapped column name
    const createdAt = string().map("created_at_column");

    const user = model({
      id: string().id(),
      createdAt,
    });

    const post = model({
      id: string().id(),
      publishedAt: createdAt, // Using same scalar with different TS key
    });

    const schema = { user, post };
    hydrateSchemaNames(schema);

    // Both models should use the shared scalar's .map() column name for SQL
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
      'Scalar "email" not found in nameRegistry'
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

describe("Schema hydration metadata", () => {
  test("reports hydration state and exposes resolved model and field names", () => {
    const child = model({ id: string().id() });
    const children = toMany(() => child);
    const parent = model({
      id: string().id().map("parent_id"),
      children,
    }).map("parents");

    expect(isSchemaHydrated({})).toBe(true);
    expect(isSchemaHydrated({ parent })).toBe(false);
    expect(() => getModelSqlName(parent)).toThrow(
      "Schema not hydrated. Call hydrateSchemaNames() or create a client first."
    );

    hydrateSchemaNames({ parent, child });

    expect(isSchemaHydrated({ parent, child })).toBe(true);
    expect(getModelSqlName(parent)).toBe("parents");
    expect(getFieldSqlName(parent, "id")).toBe("parent_id");
    // The relation's name lands in the MODEL's registry. Hydration writes no
    // source model onto the relation itself: one relation object may be reused
    // under more than one model (`.extends()`), so a source binding on it would
    // be a second, mutable answer to a question the schema already owns.
    expect(parent["~"].getRelationName("children")).toEqual({
      ts: "children",
      sql: "children",
    });
    expect(children["~"].state).not.toHaveProperty("source");
  });

  test("reports an invalid model key without inventing a model location", () => {
    const invalid = model({ id: string().id() });

    expect(() => hydrateSchemaNames({ "": invalid })).toThrow(
      "Model '' is invalid identifier; identifiers must be ASCII, at most 63 bytes, and must not collide with Object.prototype properties"
    );
  });

  test.each([
    {
      boundary: "mapped table",
      schema: () => ({ invalid: model({ id: string().id() }).map("") }),
      message: "Mapped table '' in 'invalid' is invalid identifier",
    },
    {
      boundary: "field key",
      schema: () => ({ invalid: model({ "": string() }) }),
      message: "Field '' in 'invalid' is invalid identifier",
    },
    {
      boundary: "mapped column",
      schema: () => ({ invalid: model({ value: string().map("") }) }),
      message: "Mapped column '' in 'invalid' is invalid identifier",
    },
  ])("rejects an invalid $boundary", ({ schema, message }) => {
    expect(() => hydrateSchemaNames(schema())).toThrow(message);
  });
});

describe("coverage low value", () => {
  test("forwards the unused relation SQL-name helper to the model registry", () => {
    const child = model({ id: string().id() });
    const parent = model({ children: toMany(() => child) });
    hydrateSchemaNames({ parent, child });

    expect(getRelationSqlName(parent, "children")).toBe("children");
  });
});
