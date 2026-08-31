import { defaultOmit } from "@client/exports";
import {
  ClientInitializationError,
  TransactionError,
  VibORMError,
  VibORMErrorCode,
} from "@errors";
import { createClient, s } from "@src/index";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { afterEach, describe, expect, test } from "vitest";

const record = s.model({
  id: s.string().id(),
  name: s.string(),
  secret: s.string(),
});
const schema = { record };

const clients: Array<{ $disconnect(): Promise<void> }> = [];

function createPlanningClient(
  options: { supportsTransactions?: boolean } = {}
) {
  const client = createClient({
    schema,
    driver: new PlanningDriver("sqlite", options),
  });
  clients.push(client);
  return client;
}

function createDefaultOmitUnsafe(config: unknown): unknown {
  return Reflect.apply(defaultOmit<typeof schema>(), undefined, [config]);
}

function extendUnsafe(client: object, extension: unknown): object {
  const extend = Reflect.get(client, "$extends");
  if (typeof extend !== "function") {
    throw new Error("Expected the public $extends method");
  }
  const extended: unknown = Reflect.apply(extend, client, [extension]);
  if (typeof extended !== "object" || extended === null) {
    throw new TypeError("Expected $extends to return an extended client");
  }
  return extended;
}

function captureFailure(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.$disconnect();
  }
});

describe("default omit public configuration boundary", () => {
  test.each([
    {
      name: "a non-object configuration",
      config: null,
      message: "Default omit configuration must be an object.",
    },
    {
      name: "a primitive configuration",
      config: 42,
      message: "Default omit configuration must be an object.",
    },
    {
      name: "an array configuration",
      config: [],
      message: "Default omit configuration must be an object.",
    },
    {
      name: "a non-string model key",
      config: { [Symbol("model")]: { secret: true } },
      message: "Default omit configuration contains a non-string model key.",
    },
    {
      name: "a non-object model entry",
      config: { record: null },
      message: 'Default omit configuration member "record" must be an object.',
    },
    {
      name: "an array model entry",
      config: { record: [] },
      message: 'Default omit configuration member "record" must be an object.',
    },
    {
      name: "a non-string field key",
      config: { record: { [Symbol("field")]: true } },
      message:
        'Default omit configuration member "record" contains a non-string field key.',
    },
    {
      name: "a false field flag",
      config: { record: { secret: false } },
      message:
        'Default omit configuration member "record.secret" must be true.',
    },
  ])("refuses $name atomically", ({ config, message }) => {
    const failure = captureFailure(() => createDefaultOmitUnsafe(config));

    expect(failure).toBeInstanceOf(ClientInitializationError);
    expect(failure).toMatchObject({ message });
  });

  test.each([
    {
      name: "configuration record inspection",
      create() {
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        return revoked.proxy;
      },
      message: "Default omit configuration could not be inspected.",
    },
    {
      name: "nested record inspection",
      create() {
        const revoked = Proxy.revocable({}, {});
        revoked.revoke();
        return { record: revoked.proxy };
      },
      message: "Default omit configuration.record could not be inspected.",
    },
    {
      name: "nested key inspection",
      create: () => ({
        record: new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("private nested keys");
            },
          }
        ),
      }),
      message:
        "Default omit configuration.record members could not be inspected.",
    },
    {
      name: "nested field reading",
      create: () => ({
        record: {
          get secret() {
            throw new Error("private nested field");
          },
        },
      }),
      message:
        'Default omit configuration.record member "secret" could not be read.',
    },
  ])("contains hostile $name", ({ create, message }) => {
    const failure = captureFailure(() => createDefaultOmitUnsafe(create()));

    expect(failure).toBeInstanceOf(ClientInitializationError);
    expect(failure).toMatchObject({ message });
    expect(String(failure)).not.toContain("private nested");
  });

  test.each([
    {
      name: "model",
      config: { ghost: { secret: true } },
      message: "Client 'omit' names model 'ghost'",
      meta: { model: "ghost" },
    },
    {
      name: "field",
      config: { record: { missing: true } },
      message: "Client 'omit' names field 'missing' on model 'record'",
      meta: { model: "record", field: "missing" },
    },
  ])("refuses an unknown schema $name when the extension binds", (entry) => {
    const client = createPlanningClient();
    const extension = createDefaultOmitUnsafe(entry.config);
    const failure = captureFailure(() => extendUnsafe(client, extension));

    expect(failure).toBeInstanceOf(VibORMError);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.INVALID_INPUT,
      message: expect.stringContaining(entry.message),
      meta: entry.meta,
    });
  });

  test("keeps an empty exact configuration as a harmless no-op extension", () => {
    const client = createPlanningClient();
    const extended = extendUnsafe(client, createDefaultOmitUnsafe({}));

    expect(Reflect.get(extended, "$schema")).toBe(schema);
    expect(Reflect.get(extended, "$driver")).toBe(
      Reflect.get(client, "$driver")
    );
    expect(Reflect.get(extended, "record")).toBeDefined();
  });
});

describe("transaction capability boundary", () => {
  test("refuses a callback before dispatch when the driver has no transaction capability", async () => {
    const client = createPlanningClient({ supportsTransactions: false });
    let entered = false;

    await expect(
      client.$transaction(async () => {
        entered = true;
        return "unreachable";
      })
    ).rejects.toMatchObject({
      name: TransactionError.name,
      meta: {
        driver: "planning-sqlite",
        method: "$transaction(callback)",
      },
    });
    expect(entered).toBe(false);
  });
});
