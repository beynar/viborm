/**
 * Construction-time failures are typed.
 *
 * Building a client, hydrating its schema and resolving a model name all happen before any
 * I/O. Those failures used to be bare `Error`s, which meant a caller could not tell a
 * misconfiguration from a query failure without matching on message text. They are now
 * `ClientInitializationError` (V1004 / Prisma P1012) — with the original messages kept, so
 * existing diagnostics and message assertions still read the same.
 */

import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import {
  ClientInitializationError,
  isClientInitializationError,
  VibORMError,
  VibORMErrorCode,
} from "@errors";
import { s } from "@schema";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { vi } from "vitest";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

function makeDriver(): PlanningDriver {
  return new PlanningDriver("postgresql");
}

const DRIVER_REQUIRED_PATTERN = /Driver is required/;
const INVALID_IDENTIFIER_PATTERN = /invalid identifier/i;

describe("client construction errors", () => {
  test("a missing driver fails at construction, not at first query", () => {
    let caught: unknown;
    try {
      createClient({ schema: { user } } as unknown as Parameters<
        typeof createClient
      >[0]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClientInitializationError);
    expect(isClientInitializationError(caught)).toBe(true);
    if (!(caught instanceof VibORMError)) throw new Error("expected VibORM");
    expect(caught.code).toBe(VibORMErrorCode.CLIENT_INITIALIZATION);
    expect(caught.prismaCode).toBe("P1012");
    expect(caught.message).toMatch(DRIVER_REQUIRED_PATTERN);
  });

  test("a malformed schema is re-typed but keeps its message verbatim", () => {
    const badTable = s.model({ id: s.string().id() }).map("");

    let caught: unknown;
    try {
      createClient({ schema: { badTable }, driver: makeDriver() });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClientInitializationError);
    if (!(caught instanceof VibORMError)) throw new Error("expected VibORM");
    expect(caught.prismaCode).toBe("P1012");
    // The hydration message is preserved word for word — only the class changed.
    expect(caught.message).toMatch(INVALID_IDENTIFIER_PATTERN);
    expect(caught.originalCause?.name).toBe("Error");
  });

  test("model reflection and optional access agree on plain and cached clients", async () => {
    const client = createClient({
      schema: { user },
      driver: makeDriver(),
    }).$extends(cache({ driver: new MemoryCache() }));
    for (const view of [client, client.$withCache()]) {
      expect(Object.keys(view)).toEqual(["user"]);
      expect("user" in view).toBe(true);
      expect("ghost" in view).toBe(false);
      expect(Reflect.get(view, "ghost")).toBeUndefined();
      expect(Reflect.get(view, "then")).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(view, "user")?.value).toBe(
        view.user
      );
      expect(Object.keys(view.user)).toContain("findMany");
      expect("findMany" in view.user).toBe(true);
      expect(Reflect.get(view.user, "typo")).toBeUndefined();
      expect(view.user.findMany).toBe(view.user.findMany);
    }
    await client.$disconnect();
  });

  test("model delegates honor spies, direct stubs, and restoration without dispatch", async () => {
    const client = createClient({ schema: { user }, driver: makeDriver() });
    const original = client.user.findMany;
    const rows = [{ id: "stub-id", email: "stub@example.test" }];
    const spy = vi.spyOn(client.user, "findMany").mockResolvedValue(rows);
    expect(await client.user.findMany()).toEqual(rows);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    expect(client.user.findMany).toBe(original);
    const stub = vi.fn(async () => rows);
    expect(Reflect.set(client.user, "findMany", stub)).toBe(true);
    expect(await client.user.findMany()).toEqual(rows);
    expect(stub).toHaveBeenCalledOnce();
    const independent = createClient({
      schema: { user },
      driver: makeDriver(),
    });
    expect(independent.user.findMany).not.toBe(stub);
    await client.$disconnect();
    await independent.$disconnect();
  });

  test("serialized construction errors carry both codes", () => {
    const error = new ClientInitializationError(
      'Model "ghost" not found in schema'
    );

    expect(error.toJSON()).toMatchObject({
      name: "ClientInitializationError",
      code: "V1004",
      prismaCode: "P1012",
    });
  });
});
