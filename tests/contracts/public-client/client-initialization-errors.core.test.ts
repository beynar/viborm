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
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import {
  ClientInitializationError,
  isClientInitializationError,
  VibORMError,
  VibORMErrorCode,
} from "@errors";
import { s } from "@schema";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

function makeDriver(): PGliteDriver {
  return new PGliteDriver({ client: new PGlite() });
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

  test("unknown model access is typed on both the plain and cached surfaces", async () => {
    const client = createClient({
      schema: { user },
      driver: makeDriver(),
    }).$extends(cache({ driver: new MemoryCache() }));

    let caught: unknown;
    try {
      (
        client as unknown as { ghost: { findMany: () => unknown } }
      ).ghost.findMany();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ClientInitializationError);
    if (!(caught instanceof VibORMError)) throw new Error("expected VibORM");
    expect(caught.message).toBe('Model "ghost" not found in schema');
    expect(caught.prismaCode).toBe("P1012");
    expect(caught.meta).toMatchObject({
      model: "ghost",
      operation: "findMany",
    });

    // The cached surface returns a rejected promise instead of throwing, and must be typed
    // the same way.
    const cachedCaught = await (
      client.$withCache() as unknown as {
        ghost: { findMany: () => Promise<unknown> };
      }
    ).ghost
      .findMany()
      .catch((error: unknown) => error);

    expect(cachedCaught).toBeInstanceOf(ClientInitializationError);
    if (!(cachedCaught instanceof VibORMError)) {
      throw new Error("expected VibORM");
    }
    expect(cachedCaught.prismaCode).toBe("P1012");

    await client.$disconnect();
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
