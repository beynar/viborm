import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { getOfficialDefaultOmitRequestCapability } from "@client/default-omit-extension";
import { ClientInitializationError, ValidationError } from "@errors";
import { instrumentation } from "@instrumentation/extension";
import { defaultOmit } from "@src/client/exports";
import { createClient, s } from "@src/index";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { isRecord } from "@validation/value-guards";
import { afterEach, describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  email: s.string(),
  passwordHash: s.string(),
});
const schema = { user };
const disposableClients: Array<{ $disconnect(): Promise<void> }> = [];

function omission() {
  return defaultOmit<typeof schema>()({ user: { passwordHash: true } });
}

function extensionOnlyBase() {
  const client = createClient({
    schema,
    driver: new PlanningDriver("sqlite"),
  });
  disposableClients.push(client);
  return client;
}

function applyUnsafe(client: object, extension: unknown): object {
  const extend = Reflect.get(client, "$extends");
  if (typeof extend !== "function") throw new Error("Expected $extends");
  return Reflect.apply(extend, client, [extension]);
}

afterEach(async () => {
  for (const client of disposableClients.splice(0)) {
    await client.$disconnect();
  }
});

describe("official default omit foundation", () => {
  test("snapshots one frozen capability without mutating caller config", () => {
    const reads = { model: 0, field: 0 };
    const fields = {
      get passwordHash(): true {
        reads.field += 1;
        return true;
      },
    };
    const config = {
      get user() {
        reads.model += 1;
        return fields;
      },
    };

    const extension = defaultOmit<typeof schema>()(config);
    const capability = getOfficialDefaultOmitRequestCapability(
      extension.request
    );

    expect(extension.name).toBe("viborm.defaultOmit");
    expect(Reflect.ownKeys(extension)).toEqual(["name", "request"]);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(Object.isFrozen(config)).toBe(false);
    expect(Object.isFrozen(fields)).toBe(false);
    expect(reads).toEqual({ model: 1, field: 1 });
    expect(capability).toBeDefined();
    expect(
      getOfficialDefaultOmitRequestCapability({ ...extension }.request)
    ).toBe(capability);
    expect(getOfficialDefaultOmitRequestCapability(() => ({}))).toBeUndefined();
    expect(Object.isFrozen(capability)).toBe(true);
    expect(Object.isFrozen(capability?.config)).toBe(true);
    expect(Object.isFrozen(Reflect.get(capability?.config ?? {}, "user"))).toBe(
      true
    );
    expect(reads).toEqual({ model: 1, field: 1 });
  });

  test("normalizes hostile configuration inspection without leaking values", () => {
    const hostileKeys = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("private-default-omit-ownKeys");
        },
      }
    );
    const hostileField = {
      get user() {
        // biome-ignore lint/style/useThrowOnlyError: exercises non-Error normalization
        throw "private-default-omit-field";
      },
    };
    const create = defaultOmit<typeof schema>();

    for (const hostile of [hostileKeys, hostileField]) {
      let failure: unknown;
      try {
        Reflect.apply(create, undefined, [hostile]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ClientInitializationError);
      if (!(failure instanceof ClientInitializationError)) continue;
      expect(failure.originalCause).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain("private-default-omit");
    }
  });

  test("accepts an exact clone and rejects provenance attacks atomically", () => {
    const base = extensionOnlyBase();
    const official = omission();
    const cloned = { ...official };
    const derived = base.$extends(cloned);

    expect(derived.$schema).toBe(schema);
    expect(() =>
      applyUnsafe(base, { name: "viborm.defaultOmit", request: () => ({}) })
    ).toThrow(ClientInitializationError);
    expect(() =>
      applyUnsafe(base, { ...official, name: "renamed-default-omit" })
    ).toThrow(ClientInitializationError);
    expect(() =>
      applyUnsafe(base, { ...official, request: () => ({}) })
    ).toThrow(ClientInitializationError);
    expect(() =>
      applyUnsafe(base, {
        ...official,
        request: official.request.bind(undefined),
      })
    ).toThrow(ClientInitializationError);
    expect(() => applyUnsafe(derived, official)).toThrow(
      ClientInitializationError
    );
    expect(derived.$extends({ name: "after-refusals" }).$schema).toBe(schema);
  });

  test("preserves official hybrid admission error precedence", () => {
    const base = extensionOnlyBase();
    const omit = omission();
    const observed = instrumentation({ logging: { error: true } });
    const derived = base.$extends(omit).$extends(observed);

    expect(() =>
      applyUnsafe(derived, {
        name: omit.name,
        request: omit.request,
        observe: observed.observe,
      })
    ).toThrow(
      "The official instrumentation extension is already present on this client."
    );
  });

  test("admits result-agnostic extensions before omit and refuses prior result consumers", () => {
    const base = extensionOnlyBase();
    const official = omission();
    const admitted = [
      base.$extends({ name: "request", request: () => ({}) }),
      base.$extends({
        name: "generic-query",
        query: async ({ proceed }) => proceed(),
      }),
      base.$extends({
        name: "statement",
        statement: ({ statement }) => statement,
      }),
      base.$extends({
        name: "observe",
        observe: (_unit, proceed) => proceed(),
      }),
      base.$extends(cache({ driver: new MemoryCache() })),
      base.$extends(instrumentation({ tracing: true })),
    ];
    const refused = [
      base.$extends({
        name: "mapped-query",
        query: {
          user: {
            findMany: async ({ proceed }) => proceed(),
          },
        },
      }),
      base.$extends({
        name: "client",
        client: () => ({ $prior: () => true }),
      }),
      base.$extends({
        name: "model",
        model: { user: () => ({ prior: () => true }) },
      }),
    ];

    for (const client of admitted) {
      const withDefaultOmit = applyUnsafe(client, official);
      expect(Reflect.get(withDefaultOmit, "$schema")).toBe(schema);
    }
    for (const client of refused) {
      expect(() => applyUnsafe(client, official)).toThrow(
        "The default omit extension cannot follow an extension that defines model-mapped query, client, or model behavior."
      );
    }
    expect(base.$extends({ name: "still-usable" }).$schema).toBe(schema);
  });

  test("does not read the removed built-in omit configuration", () => {
    let reads = 0;
    const config = {
      schema,
      driver: new PlanningDriver("sqlite"),
      get omit() {
        reads += 1;
        throw new Error("removed omit accessor was read");
      },
    };

    const client = Reflect.apply(createClient, undefined, [config]);
    disposableClients.push(client);

    expect(reads).toBe(0);
    expect(Reflect.get(client, "$schema")).toBe(schema);
  });
});

describe("official default omit deterministic public boundary", () => {
  test("runs request work before default omission and gives query work the prepared projection", async () => {
    const events: string[] = [];
    const client = extensionOnlyBase()
      .$extends(omission())
      .$extends({
        name: "default-omit-boundary",
        request: {
          user: {
            findMany({ input }) {
              events.push(
                Object.hasOwn(input, "omit") ? "request:omit" : "request:plain"
              );
              return { where: { id: "u1" } };
            },
          },
        },
        query: {
          user: {
            // @ts-expect-error a read interceptor may deliberately answer
            // without proceed() (docs/content/docs/extensions/index.mdx), but
            // QueryHandlerMap defers its result on the handler's own `Arg`
            // parameter (src/extensions/query.ts:140), so only proceed()'s
            // value or an empty array is spellable here.
            async findMany({ input }) {
              const select = Reflect.get(input, "select");
              events.push(
                isRecord(select) &&
                  Object.hasOwn(select, "email") &&
                  !Object.hasOwn(select, "passwordHash")
                  ? "query:select"
                  : "query:unprepared"
              );
              return [{ id: "u1", email: "ada@example.test" }];
            },
          },
        },
      });

    await expect(client.user.findMany({ take: -1 })).resolves.toEqual([
      { id: "u1", email: "ada@example.test" },
    ]);
    expect(events).toEqual(["request:plain", "query:select"]);
  });

  test("still lets core validation own unknown ordinary input", async () => {
    const client = extensionOnlyBase().$extends(omission());
    const findMany = Reflect.get(client.user, "findMany");

    await expect(
      Reflect.apply(findMany, client.user, [{ where: { emale: "typo" } }])
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
