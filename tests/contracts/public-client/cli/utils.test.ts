/**
 * Unit tests for `src/cli/utils.ts` — the CLI's pure/config layer.
 *
 * Two concerns, two styles:
 *   1. loadConfig — driven through real `viborm.config.ts` fixtures written by
 *      the harness (`writeConfigFixture`) + `process.cwd()` chdir, so path
 *      discovery, module-shape extraction, client/model validation and the
 *      schema-validation gate all run exactly as in production. No mock of the
 *      unit under test.
 *   2. defineConfig — the public config-subpath identity helper.
 */

import { join } from "node:path";
import { chdir, cwd } from "node:process";
import { pathToFileURL } from "node:url";
import { defineConfig, failCli, loadConfig } from "@src/cli/utils";
import { SchemaValidationError } from "@src/schema/validation";
import {
  makeTempProject,
  type TempProject,
  writeConfigFixture,
} from "@tests/contracts/public-client/cli/_harness";
import { SOURCE_ROOT } from "@tests/fixtures/repo-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// loadConfig
// ===========================================================================

describe("loadConfig", () => {
  let project: TempProject;
  let origCwd: string;

  beforeEach(() => {
    project = makeTempProject();
    origCwd = cwd();
  });

  afterEach(() => {
    // loadConfig reads process.cwd(); always restore it even if a test chdir'd.
    chdir(origCwd);
    project.cleanup();
  });

  // --- config file discovery ---------------------------------------------

  it("loads an existing file given by absolute --config path", async () => {
    writeConfigFixture(project);

    const loaded = await loadConfig({ config: project.configPath });

    expect(Object.keys(loaded.models)).toEqual(["user"]);
    expect(loaded.driver).toBe(loaded.client.$driver);
  });

  it("discovers viborm.config.ts in cwd when no --config given", async () => {
    writeConfigFixture(project);
    chdir(project.dir);

    const loaded = await loadConfig();

    expect(Object.keys(loaded.models)).toContain("user");
  });

  it("prefers .ts over .mts/.js/.mjs when several config files exist", async () => {
    // A working .ts and a deliberately-broken .mjs. Discovery order lists .ts
    // first, so a successful load proves .ts won (a .mjs pick would throw).
    writeConfigFixture(project, { configName: "viborm.config.ts" });
    writeConfigFixture(project, {
      configName: "viborm.config.mjs",
      rawConfigSource: "throw new Error('mjs must not be chosen');",
    });
    chdir(project.dir);

    const loaded = await loadConfig();

    expect(Object.keys(loaded.models)).toContain("user");
  });

  it("discovers viborm.config.mjs when earlier candidates are absent", async () => {
    writeConfigFixture(project, { configName: "viborm.config.mjs" });
    chdir(project.dir);

    const loaded = await loadConfig();

    expect(Object.keys(loaded.models)).toContain("user");
  });

  it("throws (listing the searched path) when --config points at a missing file", async () => {
    const missing = `${project.dir}/nope.config.ts`;

    await expect(loadConfig({ config: missing })).rejects.toThrow(
      /Could not find VibORM configuration file/
    );
    await expect(loadConfig({ config: missing })).rejects.toThrow(missing);
  });

  it("throws listing all 4 candidates when no config exists anywhere", async () => {
    chdir(project.dir); // empty temp dir, no config written

    let message = "";
    try {
      await loadConfig();
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain("Could not find VibORM configuration file");
    expect(message).toContain("viborm.config.ts");
    expect(message).toContain("viborm.config.mts");
    expect(message).toContain("viborm.config.js");
    expect(message).toContain("viborm.config.mjs");
  });

  it("re-throws the TypeScript-loader hint when a .ts config fails to import", async () => {
    // A .ts file whose import blows up hits the endsWith(.ts) branch of
    // importModule, which swallows the raw error and returns the loader hint.
    writeConfigFixture(project, {
      rawConfigSource: "throw new Error('boom inside config');",
    });

    await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
      /Make sure you're running with a TypeScript loader/
    );
  });

  it("re-throws the TypeScript-loader hint when a discovered .mts config fails", async () => {
    writeConfigFixture(project, {
      configName: "viborm.config.mts",
      rawConfigSource: "throw new Error('boom inside mts config');",
    });
    chdir(project.dir);

    await expect(loadConfig()).rejects.toThrow(
      /Make sure you're running with a TypeScript loader/
    );
  });

  it("preserves a JavaScript config import failure", async () => {
    const configPath = writeConfigFixture(project, {
      configName: "viborm.config.mjs",
      rawConfigSource: "throw new Error('plain JavaScript config exploded');",
    });

    await expect(loadConfig({ config: configPath })).rejects.toThrow(
      "plain JavaScript config exploded"
    );
  });

  it("preserves an import-time polymorphic schema validation error", async () => {
    // A variant target the schema does not register: a GRAPH fact, so it is the
    // resolver's `SchemaValidationError` rather than a construction refusal.
    // (A malformed `values` map is structurally knowable and now fails at the
    // factory as V4002 — a different class, pinned with the factory.)
    writeConfigFixture(project, {
      schemaBody: `
        const target = s.model({ id: s.string().id() });
        const owner = s.model({
          id: s.string().id(),
          target: s.toOne(
            { target: () => target },
            { values: { target: "owner.target.v1" } }
          ),
        });
        const schema = { owner };
      `,
    });

    const thrown = await loadConfig({ config: project.configPath }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(thrown).toBeInstanceOf(SchemaValidationError);
    if (!(thrown instanceof SchemaValidationError)) {
      throw new Error("expected the original SchemaValidationError");
    }
    expect(thrown.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "P001" })])
    );
    expect(thrown.message).not.toContain(
      "Make sure you're running with a TypeScript loader"
    );
  });

  it("surfaces R002, with its model and relation, for a slot with no inverse", async () => {
    // R008 ("a required non-owning one-to-one must call .optional()") died with
    // no successor: non-owner nullability is derived, so the invariant itself is
    // gone. What this test pins is unchanged — the CLI hands back the resolver's
    // own issue objects, context fields and all — re-founded on the diagnostic
    // that survives at the same boundary.
    writeConfigFixture(project, {
      schemaBody: `
        const user = s.model({
          id: s.string().id(),
          profile: s.toOne(() => profile),
        });
        const profile = s.model({
          id: s.string().id(),
        });
        const schema = { user, profile };
      `,
    });

    const thrown = await loadConfig({ config: project.configPath }).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(thrown).toBeInstanceOf(SchemaValidationError);
    if (!(thrown instanceof SchemaValidationError)) {
      throw new Error("expected the original SchemaValidationError");
    }
    expect(thrown.issues).toContainEqual(
      expect.objectContaining({
        code: "R002",
        model: "user",
        relation: "profile",
        message: "'user.profile' has no inverse relation in 'profile'",
      })
    );
  });

  // --- module-shape extraction -------------------------------------------

  it("uses the default export ({ client })", async () => {
    // The harness fixture is a default export by construction.
    writeConfigFixture(project);

    const loaded = await loadConfig({ config: project.configPath });

    expect(loaded.client).toBeDefined();
    expect(Object.keys(loaded.models)).toContain("user");
  });

  it("uses a named `config` export when there is no default", async () => {
    writeConfigFixture(project, { exportKind: "namedConfig" });

    const loaded = await loadConfig({ config: project.configPath });

    expect(Object.keys(loaded.models)).toContain("user");
  });

  it("falls back to the module itself when there is no default/config export", async () => {
    writeConfigFixture(project, { exportKind: "moduleItself" });

    const loaded = await loadConfig({ config: project.configPath });

    expect(Object.keys(loaded.models)).toContain("user");
  });

  it('throws Missing "client" when the config has no client key', async () => {
    writeConfigFixture(project, {
      rawConfigSource: "export default { migrations: {} };",
    });

    await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
      /Missing "client"/
    );
  });

  it('throws Invalid "client" for a plain object without $driver/$schema', async () => {
    writeConfigFixture(project, {
      rawConfigSource: "export default { client: { not: 'a real client' } };",
    });

    await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
      /Invalid "client"/
    );
  });

  it('throws Invalid "client" for a truthy primitive', async () => {
    writeConfigFixture(project, {
      rawConfigSource: "export default { client: 1 };",
    });

    await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
      /Invalid "client"/
    );
  });

  it('throws Invalid "client" when $driver exists but $schema is absent', async () => {
    writeConfigFixture(project, {
      rawConfigSource:
        "export default { client: { $driver: {}, $schema: undefined } };",
    });

    await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
      /Invalid "client"/
    );
  });

  // --- model extraction + validation -------------------------------------

  it("returns both models for a two-model schema (regression: extractModels)", async () => {
    // BUG #2 regression: extractModels probed `"fields" in state` (never true),
    // so it always returned {} and loadConfig threw "No models found".
    writeConfigFixture(project, {
      schemaBody: `
        const author = s.model({
          id: s.string().id(),
          name: s.string(),
          posts: s.toMany(() => post),
        });
        const post = s.model({
          id: s.string().id(),
          title: s.string(),
          authorId: s.string(),
          author: s.toOne(() => author).fields("authorId").references("id"),
        });
        const schema = { author, post };
      `,
    });

    const loaded = await loadConfig({ config: project.configPath });

    expect(Object.keys(loaded.models).sort()).toEqual(["author", "post"]);
  });

  it('throws "No models found" for a client whose schema has zero models', async () => {
    writeConfigFixture(project, { schemaBody: "const schema = {};" });

    await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
      /No models found in client schema/
    );
  });

  it("passes the migrations config block through", async () => {
    writeConfigFixture(project, {
      migrationsBlock: `migrations: { dir: "./db/migrations", tableName: "_my_migrations" }`,
    });

    const loaded = await loadConfig({ config: project.configPath });

    expect(loaded.migrations).toEqual({
      dir: "./db/migrations",
      tableName: "_my_migrations",
    });
  });

  it('REJECT: a model with no .id() throws "Schema validation failed"', async () => {
    // Proves loadConfig actually invokes validateSchemaOrThrow (and it no longer
    // infinitely recurses — it returns a real error).
    writeConfigFixture(project, {
      schemaBody: `
        const user = s.model({ email: s.string() });
        const schema = { user };
      `,
    });

    await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
      /Schema validation failed/
    );
  });
});

// ===========================================================================
// Public config helper
// ===========================================================================

describe("defineConfig", () => {
  it("returns its argument unchanged (identity)", () => {
    const config = { client: {} as any, migrations: { dir: "./m" } };

    expect(defineConfig(config)).toBe(config);
  });
});

describe("CLI failure boundary", () => {
  it("prints Error and non-Error failures before exiting unsuccessfully", () => {
    const exitSentinel = new Error("process exited");
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw exitSentinel;
    });

    try {
      expect(() => failCli(new Error("typed failure"))).toThrow(exitSentinel);
      expect(() => failCli("string failure")).toThrow(exitSentinel);
      expect(stderr.mock.calls.map(([message]) => message)).toEqual([
        "typed failure\n",
        "string failure\n",
      ]);
      expect(exit).toHaveBeenCalledTimes(2);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
    }
  });
});

describe("coverage low value", () => {
  it("refuses a callable impostor client", async () => {
    const project = makeTempProject();
    try {
      writeConfigFixture(project, {
        rawConfigSource:
          "function client() {}\nexport default { client };\n",
      });

      await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
        /Invalid "client"/
      );
    } finally {
      project.cleanup();
    }
  });

  it("ignores malformed non-model members behind the config client shape", async () => {
    const project = makeTempProject();
    const schemaUrl = pathToFileURL(join(SOURCE_ROOT, "schema/index.ts")).href;
    try {
      writeConfigFixture(project, {
        rawConfigSource: `import { hydrateSchemaNames, s } from ${JSON.stringify(schemaUrl)};
const user = s.model({ id: s.string().id() });
hydrateSchemaNames({ user });
const schema = {
  user,
  nullMember: null,
  primitiveMember: 1,
  objectMember: {},
  nullMetadata: { "~": null },
  missingState: { "~": {} },
  nullState: { "~": { state: null } },
  missingScalars: { "~": { state: {} } },
};
export default { client: { $driver: {}, $schema: schema } };
`,
      });

      const loaded = await loadConfig({ config: project.configPath });

      expect(Object.keys(loaded.models)).toEqual(["user"]);
    } finally {
      project.cleanup();
    }
  });
});
