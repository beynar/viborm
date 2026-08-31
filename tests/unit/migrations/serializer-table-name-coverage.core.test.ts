import { getTableName } from "@src/migrations/serializer";
import { s } from "@src/schema";
import { describe, expect, test } from "vitest";

describe("coverage low value", () => {
  test("projects mapped and default model table names", () => {
    const implicit = s.model({ id: s.string().id() });
    const mapped = s.model({ id: s.string().id() }).map("audit_events");

    expect(getTableName(implicit, "AuditEvent")).toBe("auditevent");
    expect(getTableName(mapped, "IgnoredFallback")).toBe("audit_events");
  });
});
