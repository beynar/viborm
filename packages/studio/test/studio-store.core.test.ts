import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  makeTempProject,
  type TempProject,
} from "@tests/contracts/public-client/cli/_harness";
import { afterEach, beforeEach, expect, test } from "vitest";
import { defaultStoreDir, projectStore } from "../src/store";

let project: TempProject;
beforeEach(() => {
  project = makeTempProject();
});
afterEach(() => project.cleanup());

test("one file per project keeps each name, says its config, and tells", async () => {
  const told: string[] = [];
  const dir = join(project.dir, "store");
  const store = projectStore(dir, "/work/app/viborm.config.ts", (name) =>
    told.push(name)
  );
  expect(await store.read("views")).toBeUndefined();
  await store.write("views", [{ id: "a" }]);
  await store.write("layout", { user: { x: 1, y: 2 } });
  expect(await store.read("views")).toEqual([{ id: "a" }]);
  expect(told).toEqual(["views", "layout"]);
  const other = projectStore(dir, "/work/other/viborm.config.ts", () => {});
  expect(await other.read("views")).toBeUndefined();
});

test("a file that is not JSON, or not an object, keeps nothing", async () => {
  const dir = join(project.dir, "store");
  const store = projectStore(dir, "/p", () => {});
  await store.write("views", []);
  const [file] = (await import("node:fs")).readdirSync(dir);
  expect(JSON.parse(readFileSync(join(dir, file!), "utf8"))).toMatchObject({
    project: "/p",
    views: [],
  });
  writeFileSync(join(dir, file!), "not json");
  expect(await store.read("views")).toBeUndefined();
  writeFileSync(join(dir, file!), "7");
  expect(await store.read("views")).toBeUndefined();
});

test("the store lives under the user's home", () => {
  expect(defaultStoreDir()).toBe(join(homedir(), ".viborm", "studio"));
});
