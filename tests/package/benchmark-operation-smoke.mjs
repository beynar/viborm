import { createClient, s } from "../../dist/index.mjs";
import { readBenchmarkOperation } from "../../dist/internal/benchmark-operation.mjs";
import { SQLite3Driver } from "../../dist/sqlite3.mjs";

const record = s.model({ id: s.string().id() });
const client = createClient({
  schema: { record },
  driver: new SQLite3Driver({ dataDir: ":memory:" }),
});
const operation = client.record.findMany();

if (!readBenchmarkOperation(operation)) {
  throw new Error(
    "The built benchmark friend did not share operation identity"
  );
}
if (readBenchmarkOperation({}) !== undefined) {
  throw new Error("The built benchmark friend accepted a fake operation");
}

console.log("benchmark operation friend: genuine resolved, fake refused");
