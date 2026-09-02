// biome-ignore lint/performance/noNamespaceImport: the test asserts on the whole barrel namespace object.
import * as internalInstrumentation from "@src/instrumentation";
// biome-ignore lint/performance/noNamespaceImport: the test asserts on the whole barrel namespace object.
import * as publicInstrumentation from "@src/instrumentation/exports";
import { describe, expect, it } from "vitest";

describe("instrumentation source entries", () => {
  it("executes both barrels and exposes their owned runtime surface", () => {
    expect(publicInstrumentation).toMatchObject({
      ATTR_DB_COLLECTION: "db.collection.name",
      ATTR_DB_QUERY_TEXT: "db.query.text",
      SPAN_EXECUTE: "viborm.execute",
      SPAN_OPERATION: "viborm.operation",
      SPAN_RECORD_SERIES_SEGMENT: "viborm.write.record_series.segment",
    });
    expect(internalInstrumentation).toMatchObject({
      createInstrumentationContext: expect.any(Function),
      createLogger: expect.any(Function),
      createTracerWrapper: expect.any(Function),
      SPAN_OPERATION: "viborm.operation",
      SPAN_RECORD_SERIES_SEGMENT: "viborm.write.record_series.segment",
    });
  });
});
