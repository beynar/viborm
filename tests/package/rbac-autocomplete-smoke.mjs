// biome-ignore-all lint/suspicious/noMisplacedAssertion: Standalone language-service regression run by the package harness.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import ts from "typescript";
import { withPackedConsumer } from "./packed-consumer.mjs";

// Editor behavior, not just assignability: no fixture file is written or run.
const source = `
import { createClient } from "viborm/sqlite3";
import { s } from "viborm";
import { rbac } from "viborm/rbac";
import { v } from "viborm/validation";
const user = s.model({ id: s.string().id(), name: s.string() });
const post = s.model({ id: s.string().id(), ownerId: s.string(), owner: s.toOne(() => user).fields("ownerId").references("id") });
const base = createClient({ schema: { post, user }, dataDir: ":memory:" });
const actor = v.object({ userId: v.string(), organizationId: v.string() });
const db = base.$extends(rbac({ actor, models: { post: { actions: { view: [], edit: [] }, view: { ownerId: { actor: "userId" } }, edit: {} } } }));
base.$extends(rbac({ actor, models: { /*models*/ } }));
base.$extends(rbac({ actor, models: { post: { view: { /*fields*/ } } } }));
base.$extends(rbac({ actor, models: { post: { view: { owner: { is: { /*related*/ } } } } } }));
base.$extends(rbac({ actor, models: { post: { view: { ownerId: { actor: "/*paths*/" } } } } }));
db.post.can("/*actions*/", { id: "p" });
db.$as({ /*binding*/ });
`;
withPackedConsumer("rbac-autocomplete", {}, ({ root }) => {
  const file = resolve(root, "autocomplete.ts");
  const options = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
  };
  const read = (path) => (path === file ? source : ts.sys.readFile(path));
  const service = ts.createLanguageService({
    getScriptFileNames: () => [file],
    getScriptVersion: () => "0",
    getScriptSnapshot: (path) => {
      const text = read(path);
      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => options,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: (path) => path === file || ts.sys.fileExists(path),
    readFile: read,
    readDirectory: ts.sys.readDirectory,
  });
  try {
    for (const [marker, expected, excluded] of [
      ["models", ["post", "user"], ["ownerId"]],
      ["fields", ["id", "ownerId", "owner"], ["name"]],
      ["related", ["id", "name"], ["ownerId"]],
      ["paths", ["userId", "organizationId"], ["ownerId"]],
      ["actions", ["view", "edit"], ["publish"]],
      ["binding", ["userId", "organizationId"], ["id"]],
    ]) {
      const position = source.indexOf(`/*${marker}*/`);
      assert.ok(position >= 0);
      const entries =
        service.getCompletionsAtPosition(file, position, {})?.entries ?? [];
      const names = new Set(entries.map((entry) => entry.name));
      for (const name of expected)
        assert.ok(names.has(name), `${marker}: missing ${name}`);
      for (const name of excluded)
        assert.ok(!names.has(name), `${marker}: unexpected ${name}`);
      console.log(`${marker}: ${expected.join(", ")}`);
    }
  } finally {
    service.dispose();
  }
});
