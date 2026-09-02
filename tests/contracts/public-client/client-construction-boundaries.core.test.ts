import { createClient } from "@client/client";
import {
  ClientInitializationError,
  ValidationError,
  VibORMErrorCode,
} from "@errors";
import { s } from "@schema";
import {
  type PlanningDialect,
  PlanningDriver,
} from "@tests/fixtures/drivers/planning";
import { describe, expect, test } from "vitest";

const record = s.model({
  id: s.string().id(),
  name: s.string(),
});

const client = createClient({
  schema: { record },
  driver: new PlanningDriver("postgresql"),
});

const decimalRefusals: ReadonlyArray<{
  dialect: PlanningDialect;
  precision: number;
  scale: number;
  reason: string;
}> = [
  {
    dialect: "postgresql",
    precision: 1001,
    scale: 2,
    reason: "maximum precision of 1000",
  },
  {
    dialect: "mysql",
    precision: 66,
    scale: 2,
    reason: "maximum precision of 65",
  },
  {
    dialect: "sqlite",
    precision: 19,
    scale: 0,
    reason: "maximum precision of 18",
  },
];

const uniqueSelectorCases: ReadonlyArray<{
  name: string;
  expectedOperation: string;
  run: () => PromiseLike<unknown>;
}> = [
  {
    name: "findUnique",
    expectedOperation: "findUnique",
    // @ts-expect-error runtime boundary rejects an empty unique selector
    run: () => client.record.findUnique({ where: {} }),
  },
  {
    name: "findUniqueOrThrow",
    expectedOperation: "findUnique",
    // @ts-expect-error runtime boundary rejects an empty unique selector
    run: () => client.record.findUniqueOrThrow({ where: {} }),
  },
  {
    name: "update",
    expectedOperation: "update",
    run: () =>
      client.record.update({
        // @ts-expect-error runtime boundary rejects an empty unique selector
        where: {},
        data: { name: "updated" },
      }),
  },
  {
    name: "delete",
    expectedOperation: "delete",
    // @ts-expect-error runtime boundary rejects an empty unique selector
    run: () => client.record.delete({ where: {} }),
  },
  {
    name: "upsert",
    expectedOperation: "upsert",
    run: () =>
      client.record.upsert({
        // @ts-expect-error runtime boundary rejects an empty unique selector
        where: {},
        create: { id: "created", name: "created" },
        update: { name: "updated" },
      }),
  },
];

async function captureFailure(
  run: () => PromiseLike<unknown>
): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

function captureConstructionFailure(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("client construction capability boundaries", () => {
  test.each(
    decimalRefusals
  )("refuses a decimal domain outside the $dialect physical limit before execution", ({
    dialect,
    precision,
    scale,
    reason,
  }) => {
    const ledger = s.model({
      id: s.string().id(),
      amount: s.decimal({ precision, scale }),
    });

    const failure = captureConstructionFailure(() =>
      createClient({
        schema: { ledger },
        driver: new PlanningDriver(dialect),
      })
    );

    expect(failure).toBeInstanceOf(ClientInitializationError);
    expect(failure).toMatchObject({
      message: expect.stringContaining(reason),
    });
  });

  test("uses the adapter GeoPoint protocol, not the dialect name", () => {
    const place = s.model({
      id: s.string().id(),
      location: s.point(),
    });

    const failure = captureConstructionFailure(() =>
      createClient({
        schema: { place },
        driver: new PlanningDriver("postgresql"),
      })
    );

    expect(failure).toBeInstanceOf(ClientInitializationError);
    expect(failure).toMatchObject({
      message: expect.stringContaining("place.location"),
    });
    expect(() =>
      createClient({
        schema: { place },
        driver: new PlanningDriver("sqlite"),
      })
    ).not.toThrow();
  });

  test("an adapter without GeoPoint still admits scalar-only schemas", () => {
    expect(() =>
      createClient({
        schema: { record },
        driver: new PlanningDriver("postgresql"),
      })
    ).not.toThrow();
  });
});

describe("unique selector validation", () => {
  test.each(
    uniqueSelectorCases
  )("$name refuses an empty selector under its public validation operation", async ({
    expectedOperation,
    run,
  }) => {
    const failure = await captureFailure(run);

    expect(failure).toBeInstanceOf(ValidationError);
    expect(failure).toMatchObject({
      operation: expectedOperation,
      issues: [
        {
          path: "where",
          message: "whereUnique requires at least one unique discriminator.",
        },
      ],
    });
  });

  test("an undefined-only selector is empty while a defined discriminator proceeds to validation", async () => {
    const emptyFailure = await captureFailure(() =>
      client.record.findUnique({
        // @ts-expect-error the unique selector type demands a defined
        // discriminator; this probes the runtime refusal a JavaScript caller
        // reaches by spelling the only unique field as undefined.
        where: { id: undefined },
      })
    );

    expect(emptyFailure).toBeInstanceOf(ValidationError);
    expect(emptyFailure).toMatchObject({
      issues: [expect.objectContaining({ path: "where" })],
    });

    const defined = client.record.findUnique({ where: { id: "record-1" } });
    await expect(defined).rejects.toMatchObject({
      code: VibORMErrorCode.QUERY_FAILED,
      meta: {
        driver: "planning-postgresql",
        model: "record",
        operation: "findUnique",
      },
    });
  });
});
