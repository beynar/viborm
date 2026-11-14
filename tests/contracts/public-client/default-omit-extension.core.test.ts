import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { ValidationError } from "@errors";
import { instrumentation } from "@instrumentation/extension";
import { defaultOmit } from "@src/client/exports";
import {
  around,
  call,
  createClient,
  extension as extExtension,
  methods,
  models,
  s,
  target,
  unit,
} from "@src/index";
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
  return defaultOmit({ user: { passwordHash: true } });
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
  test("admits every extension before omit: result consumers too, whose order rule is TypeScript's", () => {
    const base = extensionOnlyBase();
    const official = omission();
    const admitted = [
      base.$extends(
        extExtension(
          "request",
          call((c) => {
            c.set({});
          }, target(models))
        )
      ),
      base.$extends(
        extExtension(
          "generic-query",
          around(() => async (run) => run())
        )
      ),
      base.$extends(
        extExtension(
          "statement",
          unit((_u, next) => next(), ["statement"], { rewrites: true })
        )
      ),
      base.$extends(
        extExtension(
          "observe",
          unit((_u, next) => next())
        )
      ),
      base.$extends(cache({ driver: new MemoryCache() })),
      base.$extends(instrumentation({ tracing: true })),
      base.$extends(
        extExtension(
          "mapped-query",
          around(() => async (run) => run(), target("user", "findMany"))
        )
      ),
      base.$extends(
        extExtension(
          "client",
          methods(() => ({ $prior: () => true }))
        )
      ),
      base.$extends(
        extExtension(
          "model",
          methods(() => ({ user: { prior: () => true } }))
        )
      ),
    ];

    for (const client of admitted) {
      const withDefaultOmit = applyUnsafe(client, official);
      expect(Reflect.get(withDefaultOmit, "$schema")).toBe(schema);
    }
    expect(base.$extends(extExtension("still-usable")).$schema).toBe(schema);
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
      .$extends(
        extExtension(
          "default-omit-boundary",
          call(
            (c) => {
              events.push(
                Object.hasOwn(c.args, "omit") ? "request:omit" : "request:plain"
              );
              c.set({ where: { id: "u1" } });
            },
            target("user", "findMany")
          ),
          around(
            () => async (run) => {
              const select = Reflect.get(run.input, "select");
              events.push(
                isRecord(select) &&
                  Object.hasOwn(select, "email") &&
                  !Object.hasOwn(select, "passwordHash")
                  ? "query:select"
                  : "query:unprepared"
              );
              return [{ id: "u1", email: "ada@example.test" }];
            },
            target("user", "findMany")
          )
        )
      );

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
