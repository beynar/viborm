import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import type { AnyDriver } from "@drivers";
import { getExecutionExtensionChain } from "@drivers/execution-context";
import { QueryError, UnsupportedOperationError } from "@errors";
import { appendResolvedExtension } from "@extensions/chain";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { s } from "@schema";
import { raw, type Sql, sql } from "@sql";
import { createClient, defineExtension } from "@src/index";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { afterEach, describe, expect, test } from "vitest";

const author = s.model({ id: s.string().id(), name: s.string() });
const schema = { author };
const clients: Array<{ $disconnect(): Promise<void> }> = [];

interface StatementCall {
  readonly extension: string;
  readonly model: string | undefined;
  readonly operation: string;
  readonly statement: Sql;
}

function baseClient(
  driver: AnyDriver = new SqlOnlyDriver(new PostgresAdapter(), "postgresql")
) {
  const client = createClient({ schema, driver });
  clients.push(client);
  return { client, driver };
}

function recordingExtension(name: string, prefix: Sql, calls: StatementCall[]) {
  return defineExtension<typeof schema>()({
    name,
    statement(context) {
      calls.push({
        extension: name,
        model: context.model,
        operation: context.operation,
        statement: context.statement,
      });
      return sql`${prefix}${context.statement}`;
    },
  });
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("deterministic statement-transform integration", () => {
  test("runs direct model transforms in application order before dispatch", async () => {
    const { client: base } = baseClient();
    const calls: StatementCall[] = [];
    const client = base
      .$extends(recordingExtension("A", raw("/* A */ "), calls))
      .$extends(recordingExtension("B", raw("/* B */ "), calls));

    await expect(client.author.findMany()).resolves.toEqual([]);
    expect(calls.map(({ extension }) => extension)).toEqual(["A", "B"]);
    expect(calls.map(({ model }) => model)).toEqual(["author", "author"]);
    expect(calls.map(({ operation }) => operation)).toEqual([
      "findMany",
      "findMany",
    ]);
    expect(calls[1]?.statement).not.toBe(calls[0]?.statement);
  });

  test("transforms tagged raw work and excludes verbatim unsafe raw", async () => {
    const { client: base } = baseClient();
    const calls: StatementCall[] = [];
    const client = base.$extends(
      recordingExtension("raw", raw("/* raw */ "), calls)
    );

    await expect(client.$queryRaw`SELECT ${1}`).resolves.toEqual([]);
    await expect(client.$queryRawUnsafe("SELECT 1")).resolves.toEqual([]);
    expect(calls.map(({ operation }) => operation)).toEqual(["$queryRaw"]);
    expect(calls.map(({ model }) => model)).toEqual(["$raw"]);
  });

  test("rejects an invalid transform before provider dispatch", async () => {
    const { client: base } = baseClient();
    const client = base.$extends({
      name: "invalid-return",
      // @ts-expect-error - hostile JavaScript can violate the public Sql return
      statement() {
        return "SELECT 1";
      },
    });

    await expect(client.author.findMany()).rejects.toMatchObject({
      name: QueryError.name,
      message: expect.stringContaining('Extension "invalid-return"'),
    });
  });

  test("checks the verified bind limit only after an active transform", async () => {
    const driver = new PlanningDriver("postgresql", {
      maxBindParametersPerStatement: 1,
    });
    const { client: base } = baseClient(driver);
    const client = base.$extends({
      name: "bind-growth",
      statement({ statement }) {
        return sql`${statement}${"first"}${"second"}`;
      },
    });

    await expect(client.author.findMany()).rejects.toMatchObject({
      name: UnsupportedOperationError.name,
      message: expect.stringContaining(
        "2 bound values, above the verified limit of 1"
      ),
    });
  });

  test("ignores caller-spoofed provenance and honors the trusted execution context", () => {
    const driver = new PlanningDriver("postgresql");
    const calls: StatementCall[] = [];
    const chain = appendResolvedExtension(
      undefined,
      recordingExtension("trusted", raw("/* trusted */ "), calls),
      schema
    );
    const spoofedContext = {
      model: "author",
      operation: "findMany",
      extensionChain: chain,
    };

    expect(getExecutionExtensionChain(spoofedContext)).toBeUndefined();
    expect(driver._prepare(sql`SELECT 1`, spoofedContext).sql).not.toContain(
      "/* trusted */"
    );
    expect(calls).toEqual([]);

    const trustedContext = createOperationExecutionContext(
      "$transaction",
      "$transaction(callback)",
      undefined,
      chain
    );
    expect(Reflect.ownKeys(trustedContext)).toEqual([
      "model",
      "operation",
      "correlationId",
    ]);
    expect(getExecutionExtensionChain(trustedContext)).toBe(chain);
    expect(driver._prepare(sql`SELECT 1`, trustedContext).sql).toContain(
      "/* trusted */"
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: "$transaction",
      operation: "$transaction(callback)",
    });
  });
});
