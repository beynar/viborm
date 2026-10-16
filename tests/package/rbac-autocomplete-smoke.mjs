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
base.$extends(rbac({ actor, models: { post: { /*policy*/ } } }));
base.$extends(rbac({ actor, models: { post: { view: { /*fields*/ } } } }));
base.$extends(rbac({ actor, models: { post: { mandatory: { /*mandatoryFields*/ }, view: {} } } }));
base.$extends(rbac({ actor, models: { post: { create: { /*createFields*/ }, view: {} } } }));
base.$extends(rbac({ actor, models: { post: { edit: { OR: [{ /*grantFields*/ }] } } } }));
base.$extends(rbac({ actor, models: { post: { view: { owner: { is: { /*related*/ } } } } } }));
base.$extends(rbac({ actor, models: { post: { view: { ownerId: { actor: "/*paths*/" } } } } }));
base.$extends(rbac({ actor, models: { post: { edit: (action, model) => ({ /*callbackFields*/ }) } } }));
base.$extends(rbac({ actor, models: { post: { edit: (action, model) => { model./*modelMetadata*/; return {}; } } } }));
base.$extends(rbac({ actor, models: { post: { edit: { OR: [(action, model) => ({ /*nestedCallbackFields*/ })] } } } }));
base.$extends(rbac({ actor, levels: ["view", "edit", "full"], models: { post: { "view, /*groupActions*/": {} } } }));
base.$extends(rbac({ actor, models: { post: { actions: { view: [], edit: [], export: [] }, "view,edit, /*graphGroupActions*/": {} } } }));
base.$extends(rbac({ actor, models: { post: { "view, edit": { /*groupFields*/ } } } }));
/*dynamicStart*/
const dynamic = base.$extends(rbac({ actor, levels: ["view", "edit"], models: { post: { "view, edit": (action, model) => ({ OR: [{ id: action }, (requested, current) => ({ ownerId: current.name })] }) } } }));
dynamic.post.can("edit", { id: "p" });
/*dynamicEnd*/
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
      ["groupActions", ["view, edit", "view, full"], ["view, view"]],
      [
        "graphGroupActions",
        ["view,edit, export"],
        ["view,edit, view", "view,edit, edit"],
      ],
      ["groupFields", ["id", "ownerId", "owner"], ["name"]],
      ["policy", ["mandatory", "create"], ["within", "arms"]],
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
