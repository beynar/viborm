import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  makeTempProject,
  type TempProject,
  writeConfigFixture,
} from "@tests/contracts/public-client/cli/_harness";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  findConfig,
  importFromProject,
  loadProject,
  watchFiles,
} from "../src/config";

let project: TempProject;

beforeEach(() => {
  project = makeTempProject();
  // A repository root: the upward search stops here.
  mkdirSync(join(project.dir, ".git"));
});

afterEach(() => project.cleanup());

const write = (path: string, source = "") => {
  const file = join(project.dir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, source);
  return file;
};
const DEFINES = `import { defineConfig } from "viborm/config";
import { client } from "./client";
export default defineConfig({ client });
`;

describe("finding the config", () => {
  test("a viborm.config in the working directory or a parent wins", () => {
    const config = write("viborm.config.mts");
    write("apps/api/src/index.ts");
    expect(findConfig(join(project.dir, "apps/api/src"))).toEqual({
      path: config,
      others: [],
    });
  });

  test("the upward search stops at the repository root", () => {
    write("apps/api/viborm.config.ts");
    mkdirSync(join(project.dir, "apps/web"));
    expect(findConfig(join(project.dir, "apps/web"))).toBeUndefined();
  });

  test("below, a viborm.config comes before a file that only defines one", () => {
    const named = write("apps/api/db/viborm.config.ts");
    const defined = write("apps/web/orm.ts", DEFINES);
    expect(findConfig(project.dir)).toEqual({ path: named, others: [defined] });
  });

  test("a file that imports viborm/config and calls defineConfig is a config", () => {
    const defined = write("server/db.config.ts", DEFINES);
    write("server/types.d.ts", DEFINES);
    write("server/other.ts", 'import { defineConfig } from "viborm/config";');
    write("server/call.ts", "defineConfig({ client });");
    expect(findConfig(project.dir)).toEqual({ path: defined, others: [] });
  });

  test("dependencies, builds, hidden folders and deep trees are not searched", () => {
    for (const skipped of ["node_modules", "dist", ".cache"]) {
      write(`${skipped}/viborm.config.ts`);
    }
    write("a/b/c/d/e/f/g/viborm.config.ts");
    write("README.md", DEFINES);
    expect(findConfig(project.dir)).toBeUndefined();
  });
});

describe("loading the config", () => {
  test("records the project files the config compiled", async () => {
    const config = writeConfigFixture(project, { dialect: "sqlite3" });
    const loaded = await loadProject(config);
    expect(Object.keys(loaded.config.models)).toEqual(["user"]);
    expect(loaded.files).toContain(config);
    expect(loaded.files.some((file) => file.includes("node_modules"))).toBe(
      false
    );
    await loaded.config.client.$disconnect();
  });

  test("a runtime's own importer replaces jiti", async () => {
    const config = writeConfigFixture(project, { dialect: "sqlite3" });
    const fresh = await loadProject(config);
    const imported: string[] = [];
    const loaded = await loadProject(config, async (path) => {
      imported.push(path);
      return { default: { client: fresh.config.client } };
    });
    expect(imported).toEqual([config]);
    expect(loaded.files).toEqual([config]);
    await fresh.config.client.$disconnect();
  });
});

describe("the project's own modules", () => {
  test("are resolved from beside its config", async () => {
    mkdirSync(join(project.dir, "node_modules", "viborm-probe"), {
      recursive: true,
    });
    writeFileSync(
      join(project.dir, "node_modules", "viborm-probe", "package.json"),
      JSON.stringify({
        name: "viborm-probe",
        type: "module",
        exports: "./index.js",
      })
    );
    writeFileSync(
      join(project.dir, "node_modules", "viborm-probe", "index.js"),
      "export const from = 'the project';\n"
    );
    const module = (await importFromProject(
      join(project.dir, "viborm.config.ts"),
      "viborm-probe"
    )) as { from: string };
    expect(module.from).toBe("the project");
  });
});

describe("watching", () => {
  test("a burst of saves to a watched file reloads once; other files do not", async () => {
    const watched = write("schema.ts", "a");
    const other = write("notes.ts", "a");
    // macOS reports the files' creation late: let it pass before watching.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    const changed = vi.fn();
    const stop = watchFiles([watched], changed, 50);
    try {
      writeFileSync(other, "b");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
      expect(changed).not.toHaveBeenCalled();
      writeFileSync(watched, "b");
      writeFileSync(watched, "c");
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    } finally {
      stop();
    }
    writeFileSync(watched, "d");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
