import { QueryError } from "@errors";
import type { Config } from "@planetscale/database";
import { getTopLevelStatementTokens } from "../shared/sql-statement-tokens";

type PlanetScaleFetch = NonNullable<Config["fetch"]>;
type PlanetScaleResponse = Awaited<ReturnType<PlanetScaleFetch>>;

const NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)$/;
const BASE64_REGEX =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ROW_COMMANDS = new Set([
  "ANALYZE",
  "CALL",
  "DESC",
  "DESCRIBE",
  "EXPLAIN",
  "SELECT",
  "SHOW",
  "VALUES",
]);
const MUTATION_COMMANDS = new Set(["DELETE", "INSERT", "REPLACE", "UPDATE"]);
const NO_ROW_COMMANDS = new Set([
  "ALTER",
  "BEGIN",
  "COMMIT",
  "CREATE",
  "DROP",
  "LOCK",
  "RELEASE",
  "RENAME",
  "ROLLBACK",
  "SAVEPOINT",
  "SET",
  "TRUNCATE",
  "UNLOCK",
  "USE",
]);
const WITH_COMMANDS = new Set([...ROW_COMMANDS, ...MUTATION_COMMANDS]);

type StatementResultKind = "rows" | "no-rows" | "unknown";

const defaultFetch: PlanetScaleFetch = async (input, init) => {
  return globalThis.fetch(input, init);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

function isExecuteEndpoint(input: string): boolean {
  try {
    return new URL(input).pathname === "/psdb.v1alpha1.Database/Execute";
  } catch {
    return false;
  }
}

function getRequestQuery(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(body);
    return isRecord(value) && typeof value.query === "string"
      ? value.query
      : undefined;
  } catch {
    return undefined;
  }
}

function classifyStatement(sql: string | undefined): StatementResultKind {
  if (!sql) return "unknown";
  const tokens = getTopLevelStatementTokens(sql, { backslashEscapes: true });
  const first = tokens?.[0];
  if (!(tokens && first) || first.kind !== "word") return "unknown";

  let commandIndex = 0;
  if (first.value === "WITH") {
    commandIndex = tokens.findIndex(
      (token, index) =>
        index > 0 && token.kind === "word" && WITH_COMMANDS.has(token.value)
    );
    if (commandIndex < 0) return "unknown";
  }

  const command = tokens[commandIndex]?.value;
  if (!command) return "unknown";
  if (ROW_COMMANDS.has(command)) return "rows";
  if (MUTATION_COMMANDS.has(command)) {
    return tokens
      .slice(commandIndex + 1)
      .some((token) => token.kind === "word" && token.value === "RETURNING")
      ? "rows"
      : "no-rows";
  }
  return NO_ROW_COMMANDS.has(command) ? "no-rows" : "unknown";
}

function malformedPlanetScaleResponse(reason: string): QueryError {
  return new QueryError(
    `Driver "planetscale" returned a malformed successful response: ${reason}.`,
    { meta: { driver: "planetscale" } }
  );
}

function assertDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function validateFields(value: unknown): Record<string, unknown>[] {
  if (!assertDenseArray(value)) {
    throw malformedPlanetScaleResponse("result.fields is not a dense array");
  }
  const fields: Record<string, unknown>[] = [];
  const fieldNames = new Set<string>();
  for (const field of value) {
    if (
      !isRecord(field) ||
      typeof field.name !== "string" ||
      field.name.length === 0 ||
      (field.type !== undefined && typeof field.type !== "string")
    ) {
      throw malformedPlanetScaleResponse(
        "result.fields contains an invalid field descriptor"
      );
    }
    if (field.name === "__proto__" || fieldNames.has(field.name)) {
      throw malformedPlanetScaleResponse(
        "result.fields contains an unsafe or duplicate field name"
      );
    }
    fieldNames.add(field.name);
    fields.push(field);
  }
  return fields;
}

function validateRows(
  value: unknown,
  fields: readonly Record<string, unknown>[]
): void {
  if (!assertDenseArray(value)) {
    throw malformedPlanetScaleResponse("result.rows is not a dense array");
  }
  if (value.length > 0 && fields.length === 0) {
    throw malformedPlanetScaleResponse(
      "non-empty result.rows has no matching field metadata"
    );
  }
  for (const row of value) {
    if (!(isRecord(row) && assertDenseArray(row.lengths))) {
      throw malformedPlanetScaleResponse(
        "result.rows contains a row that does not match result.fields"
      );
    }
    const expectedBytes = getExpectedRowByteLength(row.lengths, fields.length);
    const actualBytes = getBase64ByteLength(row.values);
    if (expectedBytes === undefined || actualBytes !== expectedBytes) {
      throw malformedPlanetScaleResponse(
        "result.rows contains a row that does not match result.fields"
      );
    }
  }
}

function getExpectedRowByteLength(
  lengths: readonly unknown[],
  fieldCount: number
): number | undefined {
  if (lengths.length !== fieldCount) return undefined;
  let total = 0;
  for (const length of lengths) {
    if (length === "-1") continue;
    if (typeof length !== "string" || !NON_NEGATIVE_DECIMAL.test(length)) {
      return undefined;
    }
    const parsed = Number(length);
    if (
      !Number.isSafeInteger(parsed) ||
      total > Number.MAX_SAFE_INTEGER - parsed
    ) {
      return undefined;
    }
    total += parsed;
  }
  return total;
}

function getBase64ByteLength(value: unknown): number | undefined {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !BASE64_REGEX.test(value)) return undefined;
  try {
    const decoded = atob(value);
    return btoa(decoded) === value ? decoded.length : undefined;
  } catch {
    return undefined;
  }
}

function validateExecuteEnvelope(
  value: unknown,
  statementKind: StatementResultKind
): void {
  if (!isRecord(value)) {
    throw malformedPlanetScaleResponse("the response body is not an object");
  }

  // The SDK owns database-error translation. HTTP-200 error envelopes may omit
  // result, so leave them intact for its existing DatabaseError path.
  if (Object.hasOwn(value, "error") && value.error != null) return;

  if (!Object.hasOwn(value, "result")) {
    throw malformedPlanetScaleResponse("the result member is absent");
  }
  const result = value.result;
  if (result === null) {
    if (statementKind === "no-rows") return;
    throw malformedPlanetScaleResponse(
      "a row-producing or unknown statement has a null result member"
    );
  }
  if (!isRecord(result)) {
    throw malformedPlanetScaleResponse(
      "the result member is not an object or null"
    );
  }

  let fields: Record<string, unknown>[] = [];
  if (Object.hasOwn(result, "fields") && result.fields !== null) {
    fields = validateFields(result.fields);
  }
  if (statementKind !== "no-rows" && fields.length === 0) {
    throw malformedPlanetScaleResponse(
      "a row-producing or unknown statement has no field metadata"
    );
  }
  if (Object.hasOwn(result, "rows")) {
    validateRows(result.rows, fields);
  }
  if (
    Object.hasOwn(result, "rowsAffected") &&
    result.rowsAffected !== null &&
    (typeof result.rowsAffected !== "string" ||
      !NON_NEGATIVE_DECIMAL.test(result.rowsAffected))
  ) {
    throw malformedPlanetScaleResponse("result.rowsAffected is malformed");
  }
  if (
    Object.hasOwn(result, "insertId") &&
    result.insertId !== null &&
    (typeof result.insertId !== "string" ||
      !NON_NEGATIVE_DECIMAL.test(result.insertId))
  ) {
    throw malformedPlanetScaleResponse("result.insertId is malformed");
  }
}

function wrapExecuteResponse(
  response: PlanetScaleResponse,
  statementKind: StatementResultKind
): PlanetScaleResponse {
  return new Proxy(response, {
    get(target, property) {
      if (property === "json") {
        return async () => {
          let value: unknown;
          try {
            value = await target.json();
          } catch {
            throw malformedPlanetScaleResponse(
              "the response body is not valid JSON"
            );
          }
          validateExecuteEnvelope(value, statementKind);
          return value;
        };
      }
      if (property === "text") {
        return async () => {
          const body = await target.text();
          let value: unknown;
          try {
            value = JSON.parse(body);
          } catch {
            throw malformedPlanetScaleResponse(
              "the response body is not valid JSON"
            );
          }
          validateExecuteEnvelope(value, statementKind);
          return body;
        };
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
}

export function createValidatedPlanetScaleFetch(
  fetchOption: Config["fetch"]
): PlanetScaleFetch {
  const fetchImpl = fetchOption ?? defaultFetch;
  return async (input, init) => {
    const statementKind = classifyStatement(getRequestQuery(init?.body));
    const response = await fetchImpl(input, init);
    return isExecuteEndpoint(input) && response.ok
      ? wrapExecuteResponse(response, statementKind)
      : response;
  };
}
