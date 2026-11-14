/**
 * An extension value carries the host parts its builders bring, and a chain
 * holds the state those parts wrote: what a program that builds no part of
 * a kind does not carry.
 */
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { ClientInitializationError } from "@errors";
import type { ResolvedExtensionChain } from "@extensions/chain";
import { isAppliedExtension } from "@extensions/extension";
import { PlainDomain } from "@extensions/plain-domain";
import { FilterDomain } from "@extensions/row-domain";
import type { RowDomain } from "@query-engine/raptor3/shared/row-scope";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import {
  arg,
  args,
  around,
  call,
  createClient,
  defaults,
  extension,
  methods,
  oneOf,
  reads,
  rule,
  s,
  target,
  watch,
  when,
  writes,
} from "@src/index";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { afterEach, describe, expect, it } from "vitest";

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

/** The chain `value` makes over `previous`, as `$extends` builds it. */
const chainOf = (
  value: unknown,
  previous?: ResolvedExtensionChain
): ResolvedExtensionChain => {
  if (!isAppliedExtension(value)) throw new TypeError("not an extension");
  return value.append(previous, schema);
};

describe("extension parts", () => {
  it("a chain holds what the extension's parts wrote, and nothing else", () => {
    const watching = chainOf(
      extension(
        "watching",
        call((c) => {
          watch(c, { wants: () => true, rows: () => undefined });
        }, target(writes))
      )
    );
    expect(watching.request?.handlers("item", "create")).toHaveLength(1);
    expect(watching.written?.handlers).toHaveLength(1);
    expect(watching.query).toBeUndefined();
    expect(watching.methods).toBeUndefined();

    const tools = chainOf(
      extension(
        "tools",
        methods(() => ({}))
      )
    );
    expect(tools.methods).toBeDefined();
    expect(tools.request).toBeUndefined();
    expect(tools.written).toBeUndefined();
  });

  it("coordinates a chain as the most its parts need, never less", () => {
    const patched = chainOf(
      extension(
        "patched",
        call((c) => c.set({ take: 1 }), target(reads))
      )
    );
    // A part that only patches brings nothing that wraps a call.
    expect(patched.coordination).toBeUndefined();

    const watched = chainOf(
      extension(
        "watched",
        call(() => undefined, target(writes))
      ),
      patched
    );
    expect(watched.coordination?.executeArray).toBeDefined();

    const wrapped = chainOf(
      extension(
        "wrapped",
        around(() => (run) => run())
      ),
      watched
    );
    expect(wrapped.coordination?.rank).toBeGreaterThan(
      watched.coordination?.rank ?? Number.POSITIVE_INFINITY
    );

    const later = chainOf(
      extension(
        "later",
        call(() => undefined, target(writes))
      ),
      wrapped
    );
    expect(later.coordination).toBe(wrapped.coordination);
  });

  it("a factory scope on a chain that declares no argument binds nothing and refuses one", () => {
    type Scope = { $bind(values: Readonly<Record<string, unknown>>): unknown };
    let scope: Scope | undefined;
    const client = baseClient().$extends(
      extension(
        "binder",
        methods((given) => {
          scope = given as Scope;
          return {};
        })
      )
    );

    expect(Reflect.get(client, "$schema")).toBe(schema);
    expect(() => scope?.$bind({ actor: "ada" })).toThrow(
      'Extension "binder" binds control "actor", which it does not declare.'
    );
    // Binding no value is a view of the same client.
    expect(() => scope?.$bind({})).not.toThrow();
  });

  it("refuses what is not an extension value", () => {
    const apply = () =>
      Reflect.apply(baseClient().$extends, baseClient(), [{ name: "literal" }]);
    expect(apply).toThrow(ClientInitializationError);
    expect(apply).toThrow(
      "client.$extends takes an extension: client.$extends(extension(name, ...parts))."
    );
  });

  it("refuses a nameless extension and a part no builder made", () => {
    expect(() => extension(" ")).toThrow(
      "An extension's name must be a non-empty string."
    );
    expect(() => Reflect.apply(extension, undefined, ["loose", {}])).toThrow(
      `Extension "loose" takes parts built by viborm's part builders.`
    );
  });
});

describe("the parts that read rows", () => {
  const queries = new SqlQueries(
    new EngineSchema(schema),
    new PostgresAdapter()
  );
  const now = () => new Date(0);
  const ordered = extension(
    "ordered",
    defaults({
      item: { orderBy: { name: "asc" }, create: { name: "stamped" } },
    })
  );
  const filtered = extension(
    "filtered",
    args({ scope: oneOf("named", "all").default("named") }),
    rule({ item: { root: when(arg("scope"), "named", { name: "a" }) } })
  );
  const appendResolvedExtension = (
    previous: ResolvedExtensionChain | undefined,
    value: unknown,
    _schema: typeof schema
  ) => chainOf(value, previous);
  const scopeOf = (chain: ResolvedExtensionChain) =>
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
});
