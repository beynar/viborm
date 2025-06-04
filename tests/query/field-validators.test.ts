import { describe, test, expect } from "vitest";
import { QueryParser } from "../../src/query-parser/query-parser";
import { PostgresAdapter } from "../../src/adapters/databases/postgres/postgres-adapter";
import { s } from "../../src/schema";

// Mock model for testing all field types
const testModel = s.model("testModel", {
  id: s.string().id(),
  name: s.string(),
  age: s.int(),
  score: s.float(),
  balance: s.bigInt(),
  isActive: s.boolean(),
  createdAt: s.dateTime(),
  metadata: s.json(),
  tags: s.json(), // Array field
  profileId: s.string(), // Remove .optional() as it's not available in current schema
});

const adapter = new PostgresAdapter();
const parser = new QueryParser(adapter);
