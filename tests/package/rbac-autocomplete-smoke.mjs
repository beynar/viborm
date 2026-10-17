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
const db = base.$extends(rbac({ actor, models: { post: { actions: { read: [], update: [] }, read: { ownerId: { actor: "userId" } }, update: {} } } }));
base.$extends(rbac({ actor, models: { /*models*/ } }));
base.$extends(rbac({ actor, models: { post: { /*policy*/ } } }));
base.$extends(rbac({ actor, models: { post: { read: { /*fields*/ } } } }));
base.$extends(rbac({ actor, models: { post: { mandatory: { /*mandatoryFields*/ }, read: {} } } }));
base.$extends(rbac({ actor, models: { post: { create: { /*createFields*/ }, read: {} } } }));
base.$extends(rbac({ actor, models: { post: { update: { OR: [{ /*grantFields*/ }] } } } }));
base.$extends(rbac({ actor, models: { post: { read: { owner: { is: { /*related*/ } } } } } }));
base.$extends(rbac({ actor, models: { post: { read: { ownerId: { actor: "/*paths*/" } } } } }));
base.$extends(rbac({ actor, models: { post: { update: (action, model) => ({ /*callbackFields*/ }) } } }));
base.$extends(rbac({ actor, models: { post: { update: (action, model) => { model./*modelMetadata*/; return {}; } } } }));
base.$extends(rbac({ actor, models: { post: { update: { OR: [(action, model) => ({ /*nestedCallbackFields*/ })] } } } }));
base.$extends(rbac({ actor, levels: ["read", "update", "full"], models: { post: { "read, /*groupActions*/": {} } } }));
base.$extends(rbac({ actor, models: { post: { actions: { read: [], update: [], export: [] }, "read,update, /*graphGroupActions*/": {} } } }));
base.$extends(rbac({ actor, models: { post: { "read, update": { /*groupFields*/ } } } }));
/*dynamicStart*/
const dynamic = base.$extends(rbac({ actor, levels: ["read", "update"], models: { post: { "read, update": (action, model) => ({ OR: [{ id: action }, (requested, current) => ({ ownerId: current.name })] }) } } }));
dynamic.post.can("update", { id: "p" });
/*dynamicEnd*/
db.post.can("/*actions*/", { id: "p" });
db.$as({ /*binding*/ });
db.$as({ userId: "u", organizationId: "o" }, ["/*scopes*/"]);
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
      ["groupActions", ["read, update", "read, full"], ["read, read"]],
      [
        "graphGroupActions",
        ["read,update, export"],
        ["read,update, read", "read,update, update"],
      ],
      ["groupFields", ["id", "ownerId", "owner"], ["name"]],
      [
        "policy",
        ["mandatory", "create", "read", "update", "delete"],
        ["within", "arms"],
      ],
      ["fields", ["id", "ownerId", "owner"], ["name"]],
      ["mandatoryFields", ["id", "ownerId", "owner"], ["name"]],
      ["createFields", ["id", "ownerId", "owner"], ["name"]],
      ["grantFields", ["id", "ownerId", "owner"], ["name"]],
      ["callbackFields", ["id", "ownerId", "owner"], ["name"]],
      [
        "modelMetadata",
        ["name", "actions"],
        ["above", "related", "levels", "leveled"],
      ],
      ["nestedCallbackFields", ["id", "ownerId", "owner"], ["name"]],
      ["related", ["id", "name"], ["ownerId"]],
      ["paths", ["userId", "organizationId"], ["ownerId"]],
      ["actions", ["read", "update"], ["publish"]],
      ["binding", ["userId", "organizationId"], ["id"]],
      [
        "scopes",
        ["post.read", "post.update"],
        ["post.publish", "user.read", "post.*"],
      ],
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
    const start = source.indexOf("/*dynamicStart*/");
    const end = source.indexOf("/*dynamicEnd*/");
    const errors = service
      .getSemanticDiagnostics(file)
      .filter(
        (diagnostic) => diagnostic.start >= start && diagnostic.start < end
      );
    assert.deepEqual(
      errors.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      ),
      [],
      "dynamic policies must type-check, not just offer suggestions"
    );
  } finally {
    service.dispose();
  }
});
