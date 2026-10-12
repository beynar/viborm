// biome-ignore lint/performance/noNamespaceImport: the test asserts on the whole barrel namespace object.
import * as publicInstrumentation from "@src/instrumentation/exports";
import { describe, expect, it } from "vitest";

describe("instrumentation source entry", () => {
  it("executes the public barrel and exposes its owned runtime surface", () => {
    expect(publicInstrumentation).toMatchObject({
      ATTR_DB_COLLECTION: "db.collection.name",
      ATTR_DB_QUERY_TEXT: "db.query.text",
      SPAN_EXECUTE: "viborm.execute",
      SPAN_OPERATION: "viborm.operation",
    });
  });
});
