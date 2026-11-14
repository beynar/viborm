/**
 * What a write costs beside its statements: two defects a functional test
 * does not see, each measured once and kept from coming back.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, s } from "@src/index";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

const SRC = join(import.meta.dirname, "../../../src");

/**
 * A function literal written as the right-hand side of an assignment to a
 * property or an element: `x.y = () => …`, `this.#z = async (…) => …`,
 * `list[i] = function () {…}`.
 */
const STORED_LITERAL =
  /^[ \t]*[A-Za-z_$][\w$.#!]*(?:\.#?[A-Za-z_$][\w$]*|\[[^\]\n]+\])\s*(?:\?\?|\|\|)?=\s*\n?\s*(?:async\s*)?(?:function\b|\([^()\n]*\)\s*(?::\s*[^=\n]+)?=>|[A-Za-z_$][\w$]*\s*=>)/gm;

function storedLiterals(folder: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(SRC, folder), { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...storedLiterals(path));
    else if (entry.name.endsWith(".ts")) {
      const text = readFileSync(join(SRC, path), "utf8");
      for (const match of text.matchAll(STORED_LITERAL))
        found.push(
          `${path}:${text.slice(0, match.index).split("\n").length} ${match[0].trim()}`
        );
    }
  }
  return found;
}

describe("what a write costs beside its statements", () => {
  // V8 allocates a function literal assigned to a property outside the young
  // generation: made on each call, it keeps the call's rows and statements
  // until a full collection. Two such lines cost every write 5 to 10 kB
  // promoted (measured 2026-11-12). A function is named first, then stored.
  test("the engine and the drivers store no function written where it is assigned", () => {
    expect([
      ...storedLiterals("query-engine"),
      ...storedLiterals("drivers"),
      ...storedLiterals("client"),
      ...storedLiterals("extensions"),
    ]).toEqual([]);
  });

  // What the caller wrote is paired with what was admitted of it, node by
  // node. A value is no node: walked, a blob costs time by the byte.
  test("a row is written without what its values hold being walked", async () => {
    const file = s.model({ id: s.string().id(), bytes: s.blob() });
    const db = createClient({
      schema: { file },
      driver: createInMemorySQLite3Driver(),
    });
    await syncLiveSchema(db);
    const bytes = new Uint8Array(4_000_000).fill(7);
    await db.file.create({ data: { id: "warm", bytes } });
    const started = performance.now();
    for (const id of ["a", "b", "c"])
      await db.file.create({ data: { id, bytes } });
    // Walked, each create took about 300 ms; written as they are, 2 ms.
    expect(performance.now() - started).toBeLessThan(300);
    expect(
      (await db.file.findUniqueOrThrow({ where: { id: "c" } })).bytes
    ).toHaveLength(bytes.length);
    await db.$disconnect();
  });
});
