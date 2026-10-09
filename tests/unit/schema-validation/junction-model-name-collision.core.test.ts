import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { SchemaValidator } from "@schema/validation";
import { resolveCheckedSchemaOrThrow } from "@schema/validation/validator";
import { createClient } from "@src/index";
import { expect, test } from "vitest";

const pair = (table?: string) => {
  const left = s.model({
    id: s.string().id(),
    rights: table
      ? s.toMany(() => right).through(table)
      : s.toMany(() => right),
  });
  const right = s.model({ id: s.string().id(), lefts: s.toMany(() => left) });
  return { left, right };
};

test("a junction cannot occupy a model's mapped table before client work", () => {
  const schema = {
    ...pair("links"),
    unrelated: s.model({ id: s.string().id() }).map("links"),
  };
  expect(() => createClient({ schema, driver: new SQLite3Driver() })).toThrow(
    "collides with the table"
  );
  const resolution = new SchemaValidator().registerAll(schema).resolve();
  expect(resolution.ok).toBe(false);
  expect(
    resolution.issues.filter((issue) => issue.code === "JT003")
  ).toHaveLength(1);
  expect(() => resolveCheckedSchemaOrThrow(schema)).toThrow(
    "collides with the table"
  );
});

test("an implicit junction reserves its physical name against all registered models", () => {
  const schema = pair();
  hydrateSchemaNames(schema);
  const resolution = new SchemaValidator().registerAll(schema).resolve();
  if (!resolution.ok) throw new Error("valid pair did not resolve");
  let table: string | undefined;
  for (const slots of resolution.index.values())
    for (const slot of slots.values()) {
      if (slot.edge.kind === "junction") table = slot.edge.topology.table;
    }
  if (!table) throw new Error("no junction");
  const collision = {
    ...schema,
    unrelated: s.model({ id: s.string().id() }).map(table),
  };
  expect(() =>
    createClient({ schema: collision, driver: new SQLite3Driver() })
  ).toThrow("collides with the table");
  expect(() =>
    createClient({
      schema: {
        ...pair("distinct_links"),
        unrelated: s.model({ id: s.string().id() }).map(table),
      },
      driver: new SQLite3Driver(),
    })
  ).not.toThrow();
});
