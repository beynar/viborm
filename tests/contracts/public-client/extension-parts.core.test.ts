/**
 * A definition carries the parts it was built with, and a chain holds the
 * state those parts wrote: what a program that builds no part of a kind
 * does not carry.
 */
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { ClientInitializationError } from "@errors";
import { appendResolvedExtension } from "@extensions/chain";
import { PlainDomain } from "@extensions/plain-domain";
import { FilterDomain } from "@extensions/row-domain";
import type { RowDomain } from "@query-engine/raptor3/shared/row-scope";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import {
  createClient,
  defaultDataPart,
  defaultOrderPart,
  defineWith,
  filtersPart,
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

describe("the parts that read rows", () => {
  const queries = new SqlQueries(
    new EngineSchema(schema),
    new PostgresAdapter()
  );
  const now = () => new Date(0);
  const ordered = defineWith(
    defaultOrderPart,
    defaultDataPart
  )({
    name: "ordered",
    order: { models: { item: { name: "asc" as const } } },
    data: { models: { item: { create: { name: "stamped" } } } },
  });
  const filtered = defineWith(filtersPart)({
    name: "filtered",
    rows: {
      control: "scope",
      default: "named",
      models: { item: { named: { root: { name: "a" } }, all: {} } },
    },
  });
  const scopeOf = (chain: ReturnType<typeof appendResolvedExtension>) =>
    chain.callRows!.call("item", undefined).prepare(queries, now);

  it("binds a chain that only orders and stamps rows to a plain domain, and a filter later on the chain to its own binding, which reads them", () => {
    const plain = appendResolvedExtension(undefined, ordered, schema);
    const scope = scopeOf(plain);
    expect(scope.domain).toBeInstanceOf(PlainDomain);
    expect(scope.defaults).toBe(scope.domain);
    expect(scope.rows.stamps?.get("item")?.create).toEqual({ name: "stamped" });
    // One prepared domain per query owner and chain.
    expect(scopeOf(plain).domain).toBe(scope.domain);
    for (const chain of [
      appendResolvedExtension(plain, filtered, schema),
      appendResolvedExtension(
        appendResolvedExtension(undefined, filtered, schema),
        ordered,
        schema
      ),
    ]) {
      const { domain, rows } = scopeOf(chain);
      expect(domain).toBeInstanceOf(FilterDomain);
      expect(domain.rows.order?.get("item")).toEqual([{ name: "asc" }]);
      expect(rows.stamps?.get("item")?.create).toEqual({ name: "stamped" });
    }
  });

  it("answers in a plain domain as a filtered domain with no layer does", () => {
    const rows: RowDomain = { root: new Map(), related: new Map() };
    const plain = new PlainDomain(rows, queries);
    const layered = new FilterDomain(rows, queries);
    expect(plain.defaults).toBe(plain);
    expect([plain.judge, plain.project]).toEqual([undefined, undefined]);
    expect(plain.selector()).toBe(layered.selector(item, "root"));
    expect(plain.bound()).toBe(layered.bound(item, [0]));
    expect(plain.restrictsLinkWrite()).toBe(
      layered.restrictsLinkWrite(queries, item)
    );
    expect(plain.conjunction()).toBe(layered.conjunction(item, []));
    expect(plain.prepare(item, { name: "a" })).toEqual(
      layered.prepare(item, { name: "a" })
    );
    expect(plain.refuseHiddenLinkRow()).toBeUndefined();
    expect(plain.reads()).toBe(plain.reads());
  });

  it("refuses verbs built without what reads them, rather than reading the filters alone", () => {
    expect(() =>
      appendResolvedExtension(
        undefined,
        defineWith(filtersPart)({
          name: "judged",
          rows: {
            control: "scope",
            default: "all",
            models: {},
            verbs: { item: { predicates: {} } },
          },
        }),
        schema
      )
    ).toThrow("must be built with defineExtension()");
  });
});
