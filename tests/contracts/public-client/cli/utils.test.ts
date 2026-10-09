import { readSuppressedFailures } from "@src/drivers/shared/suppressed-failure";
import {
  MigrationError,
  UnsupportedOperationError,
  VibORMErrorCode,
} from "@src/errors";
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
import {
  defineConfig,
  failCli,
  finishCli,
  loadCliModule,
  loadConfig,
} from "@src/cli/utils";
import {
  makeTempProject,
  type TempProject,
  writeConfigFixture,
} from "@tests/contracts/public-client/cli/_harness";
import { SOURCE_ROOT } from "@tests/fixtures/repo-paths";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MISSING_CONFIG_FILE_PATTERN = /Could not find VibORM configuration file/;
const MISSING_CLIENT_PATTERN = /Missing "client"/;
const INVALID_CLIENT_PATTERN = /Invalid "client"/;
const NO_MODELS_PATTERN = /No models found in client schema/;
const SCHEMA_VALIDATION_FAILED_PATTERN = /Schema validation failed/;

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

  it.each([
    {
      name: "named config",
      source: "export const config = { marker: 'named' };",
      ownDefault: false,
      expected: { config: { marker: "named" } },
    },
    {
      name: "module exports",
      source: "export const client = { marker: 'module' };",
      ownDefault: false,
      expected: { client: { marker: "module" } },
    },
    {
      name: "authored default",
      source: "export default { marker: 'authored' };",
      ownDefault: true,
      expected: { marker: "authored" },
    },
  ])("distinguishes the $name from a synthetic loader default", async (entry) => {
    writeConfigFixture(project, { rawConfigSource: entry.source });
    const module = await loadCliModule<{ default?: unknown }>(
      project.configPath
    );
    expect(Object.hasOwn(module, "default")).toBe(entry.ownDefault);
    expect(module.default).toBeDefined();
    expect(entry.ownDefault ? module.default : module).toEqual(entry.expected);
  });

  it("refuses an invalid authored default instead of choosing a named config", async () => {
    writeConfigFixture(project, {
      rawConfigSource:
        "export default { migrations: {} }; export const config = { client: 1 };",
    });
    await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
      MISSING_CLIENT_PATTERN
    );
  });

  // --- config file discovery ---------------------------------------------

  it.each([
    "namedConfig",
    "moduleItself",
  ] as const)("loads the supported %s module export", async (exportKind) => {
    writeConfigFixture(project, {
      exportKind,
      dialect: "sqlite3",
      migrationsBlock: 'migrations: { dir: "named-options" }',
    });
    const loaded = await loadConfig({ config: project.configPath });
    expect(Object.keys(loaded.models)).toEqual(["user"]);
    if (exportKind === "namedConfig")
      expect(loaded.migrations).toEqual({ dir: "named-options" });
    expect(
      (await loaded.driver._executeRaw<{ ready: number }>("SELECT 1 AS ready"))
        .rows
    ).toEqual([{ ready: 1 }]);
    await loaded.client.$disconnect();
  });

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
      MISSING_CONFIG_FILE_PATTERN
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

  it("preserves the original error from a TypeScript config", async () => {
    writeConfigFixture(project, {
      rawConfigSource: "throw new Error('boom inside config');",
    });

    await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
      "boom inside config"
    );
  });

  it("preserves the original error from a discovered .mts config", async () => {
    writeConfigFixture(project, {
      configName: "viborm.config.mts",
      rawConfigSource: "throw new Error('boom inside mts config');",
    });
    chdir(project.dir);

    await expect(loadConfig()).rejects.toThrow("boom inside mts config");
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

    expect(thrown).toMatchObject({ name: "SchemaValidationError" });
    if (!(thrown instanceof Error && "issues" in thrown)) {
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

    expect(thrown).toMatchObject({ name: "SchemaValidationError" });
    if (!(thrown instanceof Error && "issues" in thrown)) {
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
      MISSING_CLIENT_PATTERN
    );
  });

  it('throws Invalid "client" for a plain object without $driver/$schema', async () => {
    writeConfigFixture(project, {
      rawConfigSource: "export default { client: { not: 'a real client' } };",
    });

    await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
      INVALID_CLIENT_PATTERN
    );
  });

  it('throws Invalid "client" for a truthy primitive', async () => {
    writeConfigFixture(project, {
      rawConfigSource: "export default { client: 1 };",
    });

    await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
      INVALID_CLIENT_PATTERN
    );
  });

  it('throws Invalid "client" when $driver exists but $schema is absent', async () => {
    writeConfigFixture(project, {
      rawConfigSource:
        "export default { client: { $driver: {}, $schema: undefined } };",
    });

    await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
      INVALID_CLIENT_PATTERN
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
      NO_MODELS_PATTERN
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
      SCHEMA_VALIDATION_FAILED_PATTERN
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
  it("keeps trusted codes and untrusted JSON/string/object failures distinct", () => {
    const sentinel = new Error("exited");
    const output: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw sentinel;
    });
    const cases: readonly (readonly [unknown, number])[] = [
      [
        new MigrationError(
          "decision",
          VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
        ),
        20,
      ],
      [new UnsupportedOperationError("unsupported"), 2],
      [new Error("ordinary"), 1],
      ["string", 1],
      [42, 1],
    ];
    try {
      for (const [failure, code] of cases) {
        expect(() => failCli(failure, true)).toThrow(sentinel);
        expect(JSON.parse(output.pop()!)).toMatchObject({ exitCode: code });
        expect(exit).toHaveBeenLastCalledWith(code);
        expect(() => failCli(failure)).toThrow(sentinel);
        expect(output.pop()).toContain(
          failure === 42
            ? "CLI operation failed"
            : failure instanceof Error
              ? failure.message
              : String(failure)
        );
      }
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
    }
  });
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
        rawConfigSource: "function client() {}\nexport default { client };\n",
      });

      await expect(loadConfig({ config: project.configPath })).rejects.toThrow(
        INVALID_CLIENT_PATTERN
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

describe("CLI finalization", () => {
  afterEach(() => vi.restoreAllMocks());
  it("awaits disconnect before reporting the trusted primary and preserves cleanup evidence", async () => {
    const primary = new MigrationError(
      "Rename decision required",
      VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
    );
    const cleanup = new Error("close failed");
    const order: string[] = [];
    const client = {
      $disconnect: async () => {
        order.push("cleanup");
        throw cleanup;
      },
    };
    const output: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    const sentinel = new Error("exited");
    vi.spyOn(process, "exit").mockImplementation(() => {
      order.push("exit");
      throw sentinel;
    });
    await expect(finishCli(client, { value: primary }, true)).rejects.toBe(
      sentinel
    );
    expect(order).toEqual(["cleanup", "exit"]);
    expect(JSON.parse(output.join(""))).toMatchObject({
      error: { code: "V11010", message: "Rename decision required" },
      exitCode: 20,
    });
    expect(readSuppressedFailures(primary)).toEqual([cleanup]);
  });
  it("reports a failed close even without an operation failure", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const sentinel = new Error("exited");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw sentinel;
    });
    await expect(
      finishCli(
        {
          $disconnect: async () => {
            throw new Error("close");
          },
        },
        undefined
      )
    ).rejects.toBe(sentinel);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
