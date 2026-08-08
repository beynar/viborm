/**
 * Unit tests for `src/cli/utils.ts` — the CLI's pure/config layer.
 *
 * Three concerns, three styles:
 *   1. loadConfig — driven through real `viborm.config.ts` fixtures written by
 *      the harness (`writeConfigFixture`) + `process.cwd()` chdir, so path
 *      discovery, module-shape extraction, client/model validation and the
 *      schema-validation gate all run exactly as in production. No mock of the
 *      unit under test.
 *   2. validateSchemaOrThrow — the schema-validation entry loadConfig calls. It
 *      once infinitely recursed; tested directly (accept, reject, and a
 *      self-referential-schema regression guard against the old stack overflow).
 *   3. formatBytes / formatDuration / defineConfig — pure, tested by value.
 */

import { chdir, cwd } from "node:process";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defineConfig,
  formatBytes,
  formatDuration,
  loadConfig,
} from "@src/cli/utils";
import {
  SchemaValidationError,
  validateSchemaOrThrow,
} from "@src/schema/validation";
import {
  makeTempProject,
  type TempProject,
  writeConfigFixture,
} from "@tests/contracts/public-client/cli/_harness";

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

  it("preserves an import-time polymorphic schema validation error", async () => {
    writeConfigFixture(project, {
      schemaBody: `
        const target = s.model({ id: s.string().id() });
        const owner = s.model({
          id: s.string().id(),
          target: s.polymorphic(
            { target: () => target },
            { values: {} }
          ),
        });
        const schema = { target, owner };
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
      expect.arrayContaining([expect.objectContaining({ code: "P003" })])
    );
    expect(thrown.message).not.toContain(
      "Make sure you're running with a TypeScript loader"
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

  it("accepts a real createClient() client (regression: isValidClient probe)", async () => {
    // BUG #1 regression: `"$driver" in client` was always false on the get-only
    // Proxy, so every real config threw Invalid "client". A clean load proves
    // the property-access probe accepts a genuine client.
    writeConfigFixture(project);

    await expect(
      loadConfig({ config: project.configPath })
    ).resolves.toMatchObject({ driver: expect.anything() });
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
          posts: s.oneToMany(() => post),
        });
        const post = s.model({
          id: s.string().id(),
          title: s.string(),
          authorId: s.string(),
          author: s.manyToOne(() => author).fields("authorId").references("id"),
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

  it("returns { client, driver, models } with driver === client.$driver", async () => {
    writeConfigFixture(project);

    const loaded = await loadConfig({ config: project.configPath });

    expect(loaded.client).toBeDefined();
    expect(loaded.driver).toBe(loaded.client.$driver);
    expect(loaded.models).toBeTypeOf("object");
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

  it("ACCEPT: a valid schema loads without throwing (validation runs)", async () => {
    writeConfigFixture(project);

    await expect(
      loadConfig({ config: project.configPath })
    ).resolves.toBeDefined();
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
// validateSchemaOrThrow (the resurrected validation entry)
// ===========================================================================

describe("validateSchemaOrThrow", () => {
  it("accepts a valid single-model schema", () => {
    const user = s.model({ id: s.string().id(), email: s.string() });

    expect(() => validateSchemaOrThrow({ user })).not.toThrow();
  });

  it("rejects a model with no ID field (M001)", () => {
    const user = s.model({ email: s.string() });

    expect(() => validateSchemaOrThrow({ user })).toThrow(
      /Schema validation failed/
    );
    expect(() => validateSchemaOrThrow({ user })).toThrow(/must have an ID/);
  });

  it("rejects a bad relation config (relation with no matching inverse)", () => {
    // manyToOne on `post` with no oneToMany inverse on `user` -> R004.
    const post: any = s.model({
      id: s.string().id(),
      title: s.string(),
      authorId: s.string(),
      author: s
        .manyToOne(() => user)
        .fields("authorId")
        .references("id"),
    });
    const user: any = s.model({ id: s.string().id() });

    expect(() => validateSchemaOrThrow({ user, post })).toThrow(
      /Schema validation failed/
    );
    expect(() => validateSchemaOrThrow({ user, post })).toThrow(
      /missing inverse/
    );
  });

  it("does NOT infinitely recurse on a self-referential schema (stack-overflow regression)", () => {
    // This is the shape that used to blow the stack. A validation that returns
    // (valid, no throw) proves the recursion is bounded.
    const employee: any = s.model({
      id: s.string().id(),
      managerId: s.string().nullable(),
      manager: s
        .manyToOne(() => employee)
        .fields("managerId")
        .references("id")
        .optional(),
      reports: s.oneToMany(() => employee),
    });

    expect(() => validateSchemaOrThrow({ employee })).not.toThrow();
  });
});

// ===========================================================================
// Pure formatters + defineConfig
// ===========================================================================

describe("formatBytes", () => {
  it("formats 0 as '0 B'", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("keeps sub-kilobyte values in bytes", () => {
    expect(formatBytes(500)).toBe("500 B");
  });

  it("formats 1536 as '1.5 KB'", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it("formats MB and GB boundaries", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1024 ** 2)).toBe("1 MB");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
  });
});

describe("formatDuration", () => {
  it("formats sub-second durations as milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats 1000–59999ms as seconds with one decimal", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(59_999)).toBe("60.0s");
  });

  it("formats >= 60000ms as minutes with one decimal", () => {
    expect(formatDuration(60_000)).toBe("1.0m");
    expect(formatDuration(90_000)).toBe("1.5m");
  });
});

describe("defineConfig", () => {
  it("returns its argument unchanged (identity)", () => {
    const config = { client: {} as any, migrations: { dir: "./m" } };

    expect(defineConfig(config)).toBe(config);
  });
});
