/**
 * A definition carries the parts it was built with, and a chain holds the
 * state those parts wrote: what a program that builds no part of a kind
 * does not carry.
 */
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { ClientInitializationError } from "@errors";
import { appendResolvedExtension } from "@extensions/chain";
import {
  createClient,
  defineWith,
  methodsPart,
  queryPart,
  s,
  unitPart,
  writtenPart,
} from "@src/index";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { afterEach, describe, expect, it, vi } from "vitest";

const item = s.model({ id: s.string().id(), name: s.string() });
const schema = { item };

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function baseClient() {
  const client = createClient({
    schema,
    driver: new SqlOnlyDriver(new PostgresAdapter(), "postgresql"),
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

describe("extension parts", () => {
  it("builds a definition whose own members are the definition's, applied by its parts", () => {
    const written = () => undefined;
    const built = defineWith(writtenPart)({ name: "watching", written });

    expect(Reflect.ownKeys(built)).toEqual(["name", "written"]);
    expect(Object.isFrozen(built)).toBe(true);
    const chain = appendResolvedExtension(undefined, built, schema);
    expect(chain.written?.handlers.map(({ handler }) => handler)).toEqual([
      written,
    ]);
    // What the chain holds is that part's alone.
    expect(chain.request).toBeUndefined();
    expect(chain.methods).toBeUndefined();
  });

  it("refuses a member none of the definition's parts reads", () => {
    const built = defineWith(writtenPart)({
      name: "unread",
      request: () => ({}),
    });

    expect(() => appendResolvedExtension(undefined, built, schema)).toThrow(
      ClientInitializationError
    );
    expect(() => appendResolvedExtension(undefined, built, schema)).toThrow(
      'Extension "unread" declares request, which none of the parts it was built with reads'
    );
  });

  it("coordinates a chain as the most its parts need, never less", () => {
    const retried = appendResolvedExtension(
      undefined,
      defineWith(unitPart)({ name: "retried", retry: () => false }),
      schema
    );
    expect(retried.coordination?.executeArray).toBeUndefined();

    const queried = appendResolvedExtension(
      retried,
      defineWith(queryPart)({
        name: "queried",
        query: ({ proceed }: { proceed(): Promise<unknown> }) => proceed(),
      }),
      schema
    );
    expect(queried.coordination?.rank).toBeGreaterThan(
      retried.coordination?.rank ?? Number.POSITIVE_INFINITY
    );

    const routed = appendResolvedExtension(
      queried,
      defineWith(unitPart)({ name: "routed", route: () => undefined }),
      schema
    );
    expect(routed.coordination).toBe(queried.coordination);
  });

  it("a factory scope on a chain that declares no control binds nothing and refuses a control", () => {
    type Scope = { $bind(values: Readonly<Record<string, unknown>>): unknown };
    let scope: Scope | undefined;
    const client = baseClient().$extends(
      defineWith(methodsPart)({
        name: "binder",
        client: (given: Scope) => {
          scope = given;
          return {};
        },
      })
    );

    expect(Reflect.get(client, "$schema")).toBe(schema);
    expect(() => scope?.$bind({ actor: "ada" })).toThrow(
      'Extension "binder" binds control "actor", which it does not declare.'
    );
    // Binding no value is a view of the same client.
    expect(() => scope?.$bind({})).not.toThrow();
  });

  it("refuses an object literal while nothing brought the parts that apply it", async () => {
    vi.resetModules();
    const { extensionParts } = await import("@extensions/host-slot");

    expect(() => extensionParts({ name: "literal" })).toThrow(
      "nothing brought the code that runs extensions"
    );
  });
});
