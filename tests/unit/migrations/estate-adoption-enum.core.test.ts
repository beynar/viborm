/**
 * Adopting a PostgreSQL table that uses a named enum (`.name()`): the enum is the database's,
 * so it exists with the table and the transition never creates it, even
 * where a new managed table of the same transition uses it too.
 */

import { generateV1 as generate } from "@migrations/generate-v1";
import type { MigrationClient } from "@migrations/push/planner";
import { MANAGED_TABLES } from "@migrations/target";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import { MemoryStorage, pgEstateDriver } from "./_estate";

const STATUS = ["queued", "done"] as const;
const users = s.model({ id: s.string().id() }).map("users");
const dependency = s
  .model({ id: s.string().id(), status: s.enum(STATUS).name("status") })
  .map("dependency");
const jobs = s
  .model({ id: s.string().id(), status: s.enum(STATUS).name("status") })
  .map("jobs");
const CREATE_TYPE = /CREATE TYPE/;
const CREATE_JOBS = /CREATE TABLE "alpha"\."jobs"/;
const CREATE_DEPENDENCY = /CREATE TABLE "alpha"\."dependency"/;

const clientFor = (
  schema: Record<string, unknown>,
  tables: readonly string[]
): MigrationClient =>
  ({
    $driver: pgEstateDriver("alpha"),
    $schema: schema,
    [MANAGED_TABLES]: Object.freeze([...tables].sort()),
  }) as never;

describe("adopting a table whose enum a new table shares", () => {
  it("creates the new table on the existing enum, and no enum", async () => {
    const storage = new MemoryStorage();
    await generate(clientFor({ users }, ["users"]), storage, { name: "base" });
    const adopted = await generate(
      clientFor({ users, dependency, jobs }, ["dependency", "jobs", "users"]),
      storage,
      { name: "adopt", adopt: ["dependency"] }
    );
    expect(adopted.outcome).toBe("published");
    expect(adopted.sql).toMatch(CREATE_JOBS);
    expect(adopted.sql).not.toMatch(CREATE_DEPENDENCY);
    expect(adopted.sql).not.toMatch(CREATE_TYPE);
  });

  it("still creates the enum when no adopted table uses it", async () => {
    const storage = new MemoryStorage();
    await generate(clientFor({ users }, ["users"]), storage, { name: "base" });
    const plain = s.model({ id: s.string().id() }).map("dependency");
    const created = await generate(
      clientFor({ users, dependency: plain, jobs }, [
        "dependency",
        "jobs",
        "users",
      ]),
      storage,
      { name: "adopt", adopt: ["dependency"] }
    );
    expect(created.sql).toMatch(CREATE_TYPE);
    expect(created.sql).toMatch(CREATE_JOBS);
  });
});
