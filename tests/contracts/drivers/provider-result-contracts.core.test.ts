import { BunSQLDriver } from "@drivers/bun-sql";
import { LibSQLDriver } from "@drivers/libsql";
import { MySQL2Driver } from "@drivers/mysql2";
import { assertNormalizedQueryResult } from "@drivers/normalized-result";
import { PgDriver } from "@drivers/pg";
import { PGliteDriver } from "@drivers/pglite";
import { PlanetScaleDriver } from "@drivers/planetscale";
import { createValidatedPlanetScaleFetch } from "@drivers/planetscale/response-contract";
import { PostgresDriver } from "@drivers/postgres";
import { QueryError } from "@errors";
import {
  type Config,
  Client as PlanetScaleClient,
} from "@planetscale/database";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test, vi } from "vitest";

async function captureQueryError(
  promise: Promise<unknown>
): Promise<QueryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof QueryError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected malformed provider row count to throw QueryError.");
}

function createLibSQLDriver(rowsAffected: unknown, rows: unknown[] = []) {
  const client = {
    execute: vi.fn(async () => ({ rows, rowsAffected })),
    close: vi.fn(),
  } as unknown as NonNullable<
    ConstructorParameters<typeof LibSQLDriver>[0]
  >["client"];
  return new LibSQLDriver({ client });
}

function createPlanetScaleDriver(rowsAffected: unknown, insertId: unknown) {
  const client = {
    execute: vi.fn(async () => ({
      rows: [],
      rowsAffected,
      insertId,
    })),
  } as unknown as NonNullable<
    ConstructorParameters<typeof PlanetScaleDriver>[0]
  >["client"];
  return new PlanetScaleDriver({ client });
}

function createPlanetScaleFetch(
  payload: unknown,
  response: { ok?: boolean; status?: number; statusText?: string } = {}
): NonNullable<Config["fetch"]> {
  return vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    statusText: response.statusText ?? "OK",
    json: vi.fn(async () => payload),
    text: vi.fn(async () => JSON.stringify(payload)),
  }));
}

function createPlanetScaleSDKDriver(
  payload: unknown,
  mode: "driver-created" | "injected",
  response?: { ok?: boolean; status?: number; statusText?: string }
): PlanetScaleDriver {
  const fetch = createPlanetScaleFetch(payload, response);
  const url = "https://user:password@phase6.test/database";
  if (mode === "injected") {
    return new PlanetScaleDriver({
      client: new PlanetScaleClient({ url, fetch }),
    });
  }
  return new PlanetScaleDriver({
    databaseUrl: url,
    options: { fetch },
  });
}

async function readValidatedPlanetScaleText(
  payload: unknown,
  query: string
): Promise<string> {
  const fetch = createValidatedPlanetScaleFetch(
    createPlanetScaleFetch(payload)
  );
  const response = await fetch(
    "https://phase6.test/psdb.v1alpha1.Database/Execute",
    {
      body: JSON.stringify({ query }),
      headers: {},
      method: "POST",
    }
  );
  return response.text();
}

function createMySQL2Driver(affectedRows: unknown, insertId: unknown) {
  const pool = {
    query: vi.fn(async () => [{ affectedRows, insertId }, undefined]),
    execute: vi.fn(async () => [{ affectedRows, insertId }, undefined]),
    end: vi.fn(),
  } as unknown as NonNullable<
    ConstructorParameters<typeof MySQL2Driver>[0]
  >["pool"];
  return new MySQL2Driver({ pool });
}

function createMySQL2ResultDriver(result: unknown, fields: unknown) {
  const pool = {
    query: vi.fn(async () => [result, fields]),
    execute: vi.fn(async () => [result, fields]),
    end: vi.fn(),
  } as unknown as NonNullable<
    ConstructorParameters<typeof MySQL2Driver>[0]
  >["pool"];
  return new MySQL2Driver({ pool });
}

function createPostgresDriver(
  count: unknown,
  rows: unknown[] = [],
  command: unknown = "CREATE"
) {
  const result = Object.assign(rows, { command, count });
  const client = {
    unsafe: vi.fn(async () => result),
    end: vi.fn(),
  } as unknown as NonNullable<
    ConstructorParameters<typeof PostgresDriver>[0]
  >["client"];
  return new PostgresDriver({ client });
}

function createPgDriver(
  rowCount: unknown,
  rows: unknown[] = [],
  command: unknown = "CREATE"
) {
  const pool = {
    query: vi.fn(async () => ({ command, rowCount, rows })),
    end: vi.fn(),
  } as unknown as NonNullable<
    ConstructorParameters<typeof PgDriver>[0]
  >["pool"];
  return new PgDriver({ pool });
}

function createPGliteDriver(affectedRows: unknown, rows: unknown[] = []) {
  const client = {
    query: vi.fn(async () => ({ affectedRows, rows })),
    close: vi.fn(),
  } as unknown as NonNullable<
    ConstructorParameters<typeof PGliteDriver>[0]
  >["client"];
  return new PGliteDriver({ client });
}

function createBunSQLDriver(count: unknown, rows: unknown[] = []) {
  const result = Object.assign(rows, { count });
  const client = {
    unsafe: vi.fn(async () => result),
    close: vi.fn(),
  } as unknown as NonNullable<
    ConstructorParameters<typeof BunSQLDriver>[0]
  >["client"];
  return new BunSQLDriver({ client });
}

describe("provider row-count normalization", () => {
  test("normalized results reject sparse row arrays", () => {
    const rows = new Array<Record<string, unknown>>(1);

    expect(() =>
      assertNormalizedQueryResult(
        { rows, rowCount: 0 },
        { provider: "fixture", operation: "executeRaw" }
      )
    ).toThrow(QueryError);
  });
  test.each([
    undefined,
    null,
  ])("libSQL rejects missing required rowsAffected (%s)", async (rowsAffected) => {
    const error = await captureQueryError(
      createLibSQLDriver(rowsAffected)._executeRaw("SELECT 1")
    );
    expect(error.meta).toMatchObject({
      driver: "libsql",
      operation: "executeRaw",
    });
    expect(error.meta).not.toHaveProperty("query");
    expect(error.meta).not.toHaveProperty("params");
  });

  test("PlanetScale normalizes canonical decimal insertId", async () => {
    const result = await createPlanetScaleDriver(
      1,
      "9007199254740993"
    )._executeRaw("INSERT INTO t VALUES (1)");

    expect(result.insertId).toBe(9_007_199_254_740_993n);
  });

  test("PlanetScale preview sends GeoPoint SQL through its SDK formatter", async () => {
    const location = { longitude: 12.5, latitude: -7.25 };
    const locationText = JSON.stringify(location);
    const encodedLocation = btoa(locationText);
    const response = createPlanetScaleFetch({
      result: {
        fields: [{ name: "location", type: "VARCHAR" }],
        rows: [
          { lengths: [String(locationText.length)], values: encodedLocation },
        ],
      },
    });
    let requestBody: unknown;
    const fetch: NonNullable<Config["fetch"]> = async (input, init) => {
      requestBody = init?.body;
      return response(input, init);
    };
    const place = s.model({
      id: s.string().id(),
      location: s.point(),
    });
    const driver = new PlanetScaleDriver({
      databaseUrl: "https://user:password@geopoint-preview.test/database",
      options: { fetch },
    });
    const models = { place };
    const registry = createModelRegistry(models, createSchemaRegistry(models));
    const query = new QueryEngine(driver, registry).build(place, "findMany", {
      where: { location: { equals: location } },
      select: { location: true },
    });

    try {
      await expect(driver._execute(query)).resolves.toMatchObject({
        rows: [{ location: locationText }],
      });
    } finally {
      await driver.disconnect();
    }

    if (typeof requestBody !== "string") {
      throw new Error("Expected the PlanetScale SDK request body");
    }
    const request = JSON.parse(requestBody);
    expect(request.query).toBe(
      "SELECT JSON_OBJECT('longitude', ST_Longitude(`t0`.`location`), 'latitude', ST_Latitude(`t0`.`location`)) AS `location` FROM `place` AS `t0` WHERE (ST_Longitude(`t0`.`location`) = 12.5 AND ST_Latitude(`t0`.`location`) = -7.25)"
    );
  });

  test("PlanetScale validates the wrapped response text consumer path", async () => {
    const rowPayload = {
      result: {
        fields: [{ name: "id", type: "INT64" }],
        rows: [],
      },
    };
    await expect(
      readValidatedPlanetScaleText(rowPayload, "SELECT id FROM phase6")
    ).resolves.toBe(JSON.stringify(rowPayload));
    await expect(
      readValidatedPlanetScaleText(
        { result: null },
        "CREATE TABLE phase6 (id bigint)"
      )
    ).resolves.toBe(JSON.stringify({ result: null }));

    const error = await captureQueryError(
      readValidatedPlanetScaleText({ result: null }, "SELECT id FROM phase6")
    );
    expect(error.meta).toEqual({ driver: "planetscale" });
    expect(error.message).not.toContain("executeRaw");
    expect(error.meta).not.toHaveProperty("query");
    expect(error.meta).not.toHaveProperty("params");
  });

  test.each([
    undefined,
    null,
    "01",
    "-1",
    "1.5",
  ])("PlanetScale rejects malformed required insertId (%s)", async (insertId) => {
    const error = await captureQueryError(
      createPlanetScaleDriver(1, insertId)._executeRaw(
        "INSERT INTO t VALUES (1)"
      )
    );
    expect(error.meta).toMatchObject({
      driver: "planetscale",
      operation: "executeRaw",
    });
  });

  test.each([
    "driver-created",
    "injected",
  ] as const)("PlanetScale rejects a missing raw result through a %s SDK client", async (mode) => {
    const error = await captureQueryError(
      createPlanetScaleSDKDriver({}, mode)._executeRaw("SELECT id FROM users")
    );

    expect(error.meta).toMatchObject({
      driver: "planetscale",
      operation: "executeRaw",
    });
    expect(error.meta).not.toHaveProperty("query");
    expect(error.meta).not.toHaveProperty("params");
  });

  test("PlanetScale leaves ORM operation attribution to the outer driver context", async () => {
    const error = await captureQueryError(
      createPlanetScaleSDKDriver({}, "driver-created")._executeRaw(
        "SELECT id FROM users",
        [],
        {
          model: "user",
          operation: "findMany",
          correlationId: "planetscale-find-many",
        }
      )
    );

    expect(error.meta).toMatchObject({
      driver: "planetscale",
      model: "user",
      operation: "findMany",
      correlationId: "planetscale-find-many",
    });
    expect(error.message).not.toContain("executeRaw");
  });

  test.each([
    "driver-created",
    "injected",
  ] as const)("PlanetScale distinguishes DDL from a malformed zero-row SELECT (%s)", async (mode) => {
    await expect(
      createPlanetScaleSDKDriver({ result: {} }, mode)._executeRaw(
        "CREATE TABLE phase6 (id bigint)"
      )
    ).resolves.toEqual({ rows: [], rowCount: 0 });

    const error = await captureQueryError(
      createPlanetScaleSDKDriver({ result: {} }, mode)._executeRaw(
        "SELECT id FROM phase6"
      )
    );
    expect(error.meta).toMatchObject({
      driver: "planetscale",
      operation: "executeRaw",
    });

    await expect(
      createPlanetScaleSDKDriver(
        {
          result: {
            fields: [{ name: "id", type: "INT64" }],
            rows: [],
          },
        },
        mode
      )._executeRaw("SELECT id FROM phase6")
    ).resolves.toEqual({ rows: [], rowCount: 0 });

    await expect(
      createPlanetScaleSDKDriver(
        {
          result: {
            fields: [{ name: "id", type: "INT64" }],
            rows: [{ lengths: ["-1"] }],
          },
        },
        mode
      )._executeRaw("SELECT id FROM phase6")
    ).resolves.toEqual({ rows: [{ id: null }], rowCount: 0 });
  });

  test.each([
    "driver-created",
    "injected",
  ] as const)("PlanetScale accepts SDK-compatible null no-row results (%s)", async (mode) => {
    for (const statement of [
      "BEGIN",
      "COMMIT",
      "CREATE TABLE phase6 (id bigint)",
      "UPDATE phase6 SET id = 2 WHERE id = 1",
    ]) {
      await expect(
        createPlanetScaleSDKDriver({ result: null }, mode)._executeRaw(
          statement
        )
      ).resolves.toEqual({ rows: [], rowCount: 0 });
    }

    for (const statement of ["SELECT id FROM phase6", "BROKEN STATEMENT"]) {
      const error = await captureQueryError(
        createPlanetScaleSDKDriver({ result: null }, mode)._executeRaw(
          statement
        )
      );
      expect(error.meta).toMatchObject({
        driver: "planetscale",
        operation: "executeRaw",
      });
    }

    await expect(
      createPlanetScaleSDKDriver(
        {
          result: {
            fields: null,
            rowsAffected: null,
            insertId: null,
          },
        },
        mode
      )._executeRaw("UPDATE phase6 SET id = 2 WHERE id = 1")
    ).resolves.toEqual({ rows: [], rowCount: 0 });

    await expect(
      createPlanetScaleSDKDriver(
        {
          result: {
            fields: [{ name: "id", type: "INT64" }],
            rows: [],
            rowsAffected: null,
            insertId: null,
          },
        },
        mode
      )._executeRaw("SELECT id FROM phase6")
    ).resolves.toEqual({ rows: [], rowCount: 0 });

    for (const statement of ["SELECT id FROM phase6", "ANALYZE TABLE phase6"]) {
      const error = await captureQueryError(
        createPlanetScaleSDKDriver(
          { result: { fields: null } },
          mode
        )._executeRaw(statement)
      );
      expect(error.meta).toMatchObject({
        driver: "planetscale",
        operation: "executeRaw",
      });
    }
  });

  test.each([
    "driver-created",
    "injected",
  ] as const)("PlanetScale classifies SDK-formatted apostrophe mutations (%s)", async (mode) => {
    await expect(
      createPlanetScaleSDKDriver(
        { result: { rowsAffected: "1" } },
        mode
      )._executeRaw("UPDATE users SET name = ? WHERE id = ?", [
        "O'Brien",
        "user-1",
      ])
    ).resolves.toEqual({ rows: [], rowCount: 1 });
  });

  test.each([
    null,
    { rows: [{ values: "", lengths: [] }] },
    {
      fields: [{ name: "id", type: "INT64" }],
      rows: [{ values: "", lengths: ["-0"] }],
    },
    {
      fields: [{ name: "id", type: "INT64" }],
      rows: [{ values: "", lengths: ["-2"] }],
    },
    {
      fields: [{ name: "id", type: "INT64" }],
      rows: [{ values: "@@==", lengths: ["1"] }],
    },
    {
      fields: [{ name: "id", type: "INT64" }],
      rows: [{ values: "MR==", lengths: ["1"] }],
    },
    {
      fields: [{ name: "id", type: "INT64" }],
      rows: [{ values: "MQ==", lengths: ["2"] }],
    },
    {
      fields: [{ name: "id", type: "INT64" }],
      rows: [{ values: "MTI=", lengths: ["1"] }],
    },
    {
      fields: [{ name: "id", type: "INT64" }],
      rows: [{ lengths: ["1"] }],
    },
    {
      fields: [
        { name: "id", type: "INT64" },
        { name: "id", type: "INT64" },
      ],
      rows: [{ values: "MTI=", lengths: ["1", "1"] }],
    },
    {
      fields: [{ name: "__proto__", type: "VARCHAR" }],
      rows: [{ values: "eA==", lengths: ["1"] }],
    },
  ])("PlanetScale rejects malformed raw result payload %#", async (result) => {
    const error = await captureQueryError(
      createPlanetScaleSDKDriver({ result }, "driver-created")._executeRaw(
        "SELECT id FROM phase6"
      )
    );
    expect(error.meta).toMatchObject({
      driver: "planetscale",
      operation: "executeRaw",
    });
  });

  test("PlanetScale preserves HTTP-200 database error envelopes for the SDK", async () => {
    const error = await captureQueryError(
      createPlanetScaleSDKDriver(
        { error: { code: "INVALID_ARGUMENT", message: "syntax rejected" } },
        "driver-created"
      )._executeRaw("BROKEN STATEMENT")
    );

    expect(error.message).toBe("Query execution failed");
    expect(JSON.stringify(error.toJSON())).not.toContain("syntax rejected");
    expect(error.message).not.toContain("malformed successful response");
  });

  test("PlanetScale leaves non-OK responses to the SDK error path", async () => {
    const error = await captureQueryError(
      createPlanetScaleSDKDriver({}, "driver-created", {
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
      })._executeRaw("SELECT id FROM phase6")
    );

    expect(error.message).toBe("Query execution failed");
    expect(JSON.stringify(error.toJSON())).not.toContain("Bad Gateway");
    expect(error.message).not.toContain("malformed successful response");
  });

  test("mysql2 rejects explicitly enabled multiple statements", () => {
    expect(
      () =>
        new MySQL2Driver({
          options: { multipleStatements: true },
        })
    ).toThrow("multipleStatements");
  });

  test.each([
    ["rowsAsArray", { rowsAsArray: true }],
    ["nestTables", { nestTables: true }],
    ["nestTables", { nestTables: "." }],
  ] as const)("mysql2 rejects enabled %s", (optionName, options) => {
    expect(() => new MySQL2Driver({ options })).toThrow(optionName);
  });

  test.each([
    [
      "all-mutation results",
      [
        { affectedRows: 1, insertId: 0 },
        { affectedRows: 2, insertId: 0 },
      ],
      [undefined, undefined],
    ],
    [
      "mixed row and mutation results",
      [[{ id: 1 }], { affectedRows: 1, insertId: 0 }],
      [[{ name: "id" }], undefined],
    ],
    [
      "nested row-set results",
      [[{ id: 1 }], [{ id: 2 }]],
      [[{ name: "id" }], [{ name: "id" }]],
    ],
  ])("mysql2 rejects %s", async (_label, result, fields) => {
    const error = await captureQueryError(
      createMySQL2ResultDriver(result, fields)._executeRaw("fixture statement")
    );

    expect(error.meta).toMatchObject({
      driver: "mysql2",
      operation: "executeRaw",
    });
  });

  test("mysql2 keeps ordinary rows with header-like field names", async () => {
    const rows = [{ affectedRows: 1, insertId: 2 }];
    const result = await createMySQL2ResultDriver(rows, [
      { name: "affectedRows" },
      { name: "insertId" },
    ])._executeRaw("SELECT affectedRows, insertId FROM events");

    expect(result).toEqual({ rows, rowCount: 1 });
  });

  test("mysql2 rejects row arrays without flat field metadata", async () => {
    const error = await captureQueryError(
      createMySQL2ResultDriver([{ id: 1 }], undefined)._executeRaw("SELECT 1")
    );

    expect(error.meta).toMatchObject({
      driver: "mysql2",
      operation: "executeRaw",
    });
  });

  test("mysql2 rejects mutation headers carrying field metadata", async () => {
    const error = await captureQueryError(
      createMySQL2ResultDriver({ affectedRows: 1, insertId: 0 }, [
        { name: "id" },
      ])._executeRaw("UPDATE events SET active = true")
    );

    expect(error.meta).toMatchObject({
      driver: "mysql2",
      operation: "executeRaw",
    });
  });

  test("mysql2 normalizes runtime decimal strings", async () => {
    const result = await createMySQL2Driver(
      "2",
      "9007199254740993"
    )._executeRaw("INSERT INTO t VALUES (1), (2)");

    expect(result.rowCount).toBe(2);
    expect(result.insertId).toBe(9_007_199_254_740_993n);
  });

  test.each([
    0,
    "0",
  ])("mysql2 omits the no-generated-id sentinel (%s)", async (insertId) => {
    const result = await createMySQL2Driver(1, insertId)._executeRaw(
      "UPDATE t SET value = 1"
    );

    expect(result).not.toHaveProperty("insertId");
  });

  test.each([
    { explicitId: "-1", label: "safe integer", insertId: -1 },
    { explicitId: "-1", label: "canonical decimal string", insertId: "-1" },
    {
      explicitId: "-9007199254740993",
      label: "canonical decimal string outside the safe integer range",
      insertId: "-9007199254740993",
    },
    {
      explicitId: "-9223372036854775808",
      label: "minimum signed BIGINT decimal string",
      insertId: "-9223372036854775808",
    },
  ])("mysql2 omits an explicit negative auto-increment header echo ($label)", async ({
    explicitId,
    insertId,
  }) => {
    const result = await createMySQL2Driver(1, insertId)._executeRaw(
      `INSERT INTO t (id) VALUES (${explicitId})`
    );

    expect(result).toEqual({ rows: [], rowCount: 1 });
  });

  test.each([
    undefined,
    null,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.MIN_SAFE_INTEGER - 1,
    -1.5,
    "01",
    "-0",
    "-01",
    " -1",
    "+1",
    "1.5",
  ])("mysql2 rejects malformed required insertId (%s)", async (insertId) => {
    const error = await captureQueryError(
      createMySQL2Driver(1, insertId)._executeRaw("INSERT INTO t VALUES (1)")
    );
    expect(error.meta).toMatchObject({
      driver: "mysql2",
      operation: "executeRaw",
    });
  });

  test.each([
    undefined,
    null,
    "9007199254740993",
    "01",
  ])("mysql2 rejects malformed affectedRows (%s)", async (affectedRows) => {
    const error = await captureQueryError(
      createMySQL2Driver(affectedRows, 0)._executeRaw("UPDATE t SET value = 1")
    );
    expect(error.meta).toMatchObject({
      driver: "mysql2",
      operation: "executeRaw",
    });
  });

  test("libSQL does not hide missing rowsAffected behind RETURNING rows", async () => {
    const error = await captureQueryError(
      createLibSQLDriver(undefined, [{ id: "row-1" }])._executeRaw(
        "INSERT INTO t DEFAULT VALUES RETURNING id"
      )
    );
    expect(error.meta).toMatchObject({
      driver: "libsql",
      operation: "executeRaw",
    });
  });

  test.each([
    undefined,
    null,
  ])("PlanetScale rejects missing required rowsAffected (%s)", async (rowsAffected) => {
    const error = await captureQueryError(
      createPlanetScaleDriver(rowsAffected, "0")._executeRaw("SELECT 1")
    );
    expect(error.meta).toMatchObject({
      driver: "planetscale",
      operation: "executeRaw",
    });
    expect(error.meta).not.toHaveProperty("query");
    expect(error.meta).not.toHaveProperty("params");
  });

  test("postgres.js normalizes explicit null count for DDL", async () => {
    const result = await createPostgresDriver(null)._executeRaw(
      "CREATE TABLE example (id text)"
    );

    expect(result.rows).toHaveLength(0);
    expect(result.rowCount).toBe(0);
  });

  test("postgres.js normalizes a full uncounted command tag", async () => {
    const result = await createPostgresDriver(
      null,
      [],
      "CREATE TABLE"
    )._executeRaw("CREATE TABLE example (id text)");

    expect(result.rowCount).toBe(0);
  });

  test("postgres.js rejects an absent count", async () => {
    const error = await captureQueryError(
      createPostgresDriver(undefined)._executeRaw(
        "CREATE TABLE example (id text)"
      )
    );
    expect(error.meta).toMatchObject({
      driver: "postgres",
      operation: "executeRaw",
    });
  });

  test.each([
    ["postgres.js", createPostgresDriver(null, [], "SELECT")],
    ["pg", createPgDriver(null, [], "SELECT")],
  ])("%s rejects null count for a counted command", async (_label, driver) => {
    const error = await captureQueryError(driver._executeRaw("SELECT 1"));

    expect(error.meta).toMatchObject({ operation: "executeRaw" });
  });

  test.each([
    ["postgres.js", createPostgresDriver(null, [{ setting: "on" }], "SHOW")],
    ["pg", createPgDriver(null, [{ setting: "on" }], "SHOW")],
  ])("%s derives rows for a valid uncounted command", async (_label, driver) => {
    const result = await driver._executeRaw("SHOW setting");

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({ setting: "on" });
    expect(result.rowCount).toBe(1);
  });

  test.each([
    ["postgres.js", createPostgresDriver(null, [], "MYSTERY")],
    ["pg", createPgDriver(null, [], "MYSTERY")],
  ])("%s rejects null count for an unknown command", async (_label, driver) => {
    const error = await captureQueryError(
      driver._executeRaw("fixture statement")
    );

    expect(error.meta).toMatchObject({ operation: "executeRaw" });
  });

  test.each([
    ["postgres.js empty", createPostgresDriver(0, [], "")],
    ["postgres.js malformed", createPostgresDriver(0, [], "123")],
    ["postgres.js unknown", createPostgresDriver(0, [], "MYSTERY")],
    ["pg empty", createPgDriver(0, [], "")],
    ["pg malformed", createPgDriver(0, [], "123")],
    ["pg unknown", createPgDriver(0, [], "MYSTERY")],
  ])("%s rejects numeric count without a valid command", async (_label, driver) => {
    const error = await captureQueryError(
      driver._executeRaw("fixture statement")
    );

    expect(error.meta).toMatchObject({ operation: "executeRaw" });
  });

  test("pg rejects an absent rowCount", async () => {
    const error = await captureQueryError(
      createPgDriver(undefined)._executeRaw("CREATE TABLE events(id text)")
    );

    expect(error.meta).toMatchObject({
      driver: "pg",
      operation: "executeRaw",
    });
  });

  test("PGlite uses returned row cardinality after validating affectedRows", async () => {
    await expect(
      createPGliteDriver(0, [{ id: 1 }])._executeRaw("SELECT id FROM events")
    ).resolves.toEqual({ rows: [{ id: 1 }], rowCount: 1 });
  });

  test("PGlite uses affectedRows for a result without rows", async () => {
    await expect(
      createPGliteDriver(2)._executeRaw("UPDATE events SET active = true")
    ).resolves.toEqual({ rows: [], rowCount: 2 });
  });

  test.each([
    undefined,
    null,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("PGlite rejects malformed affectedRows (%s)", async (affectedRows) => {
    const error = await captureQueryError(
      createPGliteDriver(affectedRows, [{ id: 1 }])._executeRaw(
        "SELECT id FROM events"
      )
    );

    expect(error.meta).toMatchObject({
      driver: "pglite",
      operation: "executeRaw",
    });
  });

  test("Bun SQL requires its provider count", async () => {
    const result = await createBunSQLDriver(2)._executeRaw(
      "UPDATE events SET active = true"
    );

    expect(result.rows).toHaveLength(0);
    expect(result.rowCount).toBe(2);
  });

  test.each([
    undefined,
    null,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])("Bun SQL rejects malformed count (%s)", async (count) => {
    const error = await captureQueryError(
      createBunSQLDriver(count, [{ id: 1 }])._executeRaw(
        "SELECT id FROM events"
      )
    );

    expect(error.meta).toMatchObject({
      driver: "bun-sql",
      operation: "executeRaw",
    });
  });
});
