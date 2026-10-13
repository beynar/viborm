/**
 * PlanetScale's Neki is PostgreSQL behind a router that implements a subset of
 * it. VibORM keeps one PostgreSQL migration driver and asks the server once
 * per command what it is: `serverIsNeki` in the PostgreSQL migration driver
 * owns that question, and the rest of the protocol reads its answer through
 * the driver's capability (`holdsSessionLock`) or the preflight's result,
 * never by asking again. Where a portable form works on every PostgreSQL, the
 * code uses it instead of a branch.
 *
 * This census keeps the question in its owner: a second detection would be a
 * second authority deciding, on its own, where PostgreSQL and Neki differ.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../../../src");
const OWNER = "migrations/drivers/postgres/index.ts";
const DETECTION = /\(Neki\)/;
const CAPABILITY_CALL = /\.holdsSessionLock\(/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path).split("\\").join("/"),
  text: readFileSync(path, "utf8"),
}));

it("asks the server whether it is Neki in one place", () => {
  expect(
    files.filter(({ text }) => DETECTION.test(text)).map(({ path }) => path)
  ).toEqual([OWNER]);
});

it("reads the answer through the driver's capability, from the lock protocol only", () => {
  expect(
    files
      .filter(({ text }) => CAPABILITY_CALL.test(text))
      .map(({ path }) => path)
  ).toEqual(["migrations/pinned-session.ts"]);
});
