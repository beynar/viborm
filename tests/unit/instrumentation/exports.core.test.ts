import { describe, expect, it } from "vitest";
import * as internalInstrumentation from "@src/instrumentation";
import * as publicInstrumentation from "@src/instrumentation/exports";

describe("instrumentation source entries", () => {
  it("executes both barrels and exposes their owned runtime surface", () => {
    expect(publicInstrumentation).toMatchObject({
      ATTR_DB_COLLECTION: "db.collection.name",
      ATTR_DB_QUERY_TEXT: "db.query.text",
      SPAN_EXECUTE: "viborm.execute",
      SPAN_OPERATION: "viborm.operation",
    });
    expect(internalInstrumentation).toMatchObject({
      createInstrumentationContext: expect.any(Function),
      createLogger: expect.any(Function),
      createTracerWrapper: expect.any(Function),
      SPAN_OPERATION: "viborm.operation",
    });
  });
});
