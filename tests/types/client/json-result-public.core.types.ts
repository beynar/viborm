/** Public result access must preserve the recursive JSON domain without expansion. */
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { createClient, type Decimal, type JsonValue } from "@src/index";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Prettify } from "@validation/types";
import { expectTypeOf } from "vitest";

const broad: StandardSchemaV1<JsonValue, JsonValue> = {
  "~standard": {
    version: 1,
    vendor: "json-result-probe",
    validate: () => Promise.reject(new Error("unsupported async validator")),
  },
};
type FiniteDocument = { mode: "stored"; nested: { enabled: boolean } };
const finite: StandardSchemaV1<JsonValue, FiniteDocument> = {
  "~standard": {
    version: 1,
    vendor: "json-result-probe",
    validate: () => ({ value: { mode: "stored", nested: { enabled: true } } }),
  },
};
const document = s
  .model({
    id: s.int().id(),
    payload: s.json().schema(broad),
    nullablePayload: s.json().schema(broad).nullable(),
    finite: s.json().schema(finite),
  })
  .map("json_result_documents");
const client = createClient({
  schema: { document },
  driver: new PGliteDriver(),
});

const _read = async () => {
  const row = await client.document.findUnique({ where: { id: 1 } });
  expectTypeOf(row?.payload).toEqualTypeOf<JsonValue | undefined>();
  expectTypeOf(row?.nullablePayload).toEqualTypeOf<JsonValue | undefined>();
  expectTypeOf(row?.finite).toEqualTypeOf<FiniteDocument | undefined>();
  expectTypeOf(row?.payload).not.toBeAny();
  return row?.payload;
};
const _readSelected = async () => {
  const row = await client.document.findUnique({
    where: { id: 1 },
    select: { payload: true },
  });
  expectTypeOf(row?.payload).toEqualTypeOf<JsonValue | undefined>();
  // @ts-expect-error - JSON preservation does not widen the selected row
  const _excluded = row?.finite;
  return row?.payload;
};
const _readMany = async () => {
  const rows = await client.document.findMany();
  return rows.map((row) => row.payload);
};
const _wrongId = () =>
  client.document.findUnique({
    // @ts-expect-error - the public unique selector retains its scalar domain
    where: { id: "one" },
  });
expectTypeOf(_readMany).returns.toEqualTypeOf<Promise<JsonValue[]>>();

expectTypeOf<Prettify<JsonValue>>().toEqualTypeOf<JsonValue>();
expectTypeOf<Prettify<JsonValue | undefined>>().toEqualTypeOf<
  JsonValue | undefined
>();
expectTypeOf<Prettify<JsonValue | Date>>().toEqualTypeOf<JsonValue | Date>();
expectTypeOf<
  Prettify<{ payload: JsonValue; finite: FiniteDocument }>
>().toEqualTypeOf<{ payload: JsonValue; finite: FiniteDocument }>();
expectTypeOf<Prettify<Date>>().toEqualTypeOf<Date>();
expectTypeOf<Prettify<Decimal>>().toMatchTypeOf<Decimal>();
expectTypeOf<Decimal>().toMatchTypeOf<Prettify<Decimal>>();
expectTypeOf<Prettify<(value: string) => Date>>().toEqualTypeOf<
  (value: string) => Date
>();
