import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assertChain5ClientIntegrity } from "../../package/emitted-client-integrity.mjs";
import { assertBuiltPublicDistMatchesArchive } from "../../package/packed-consumer.mjs";

let fixture: string;
afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
});

function setup(built: Record<string, string>) {
  fixture = mkdtempSync(join(tmpdir(), "viborm-dist-consistency-test-"));
  const root = join(fixture, "built");
  const files = {
    "index.mjs": "export const value = 1;",
    "index.d.mts": "export declare const value: number;",
  };
  for (const { directory, values } of [
    { directory: join(fixture, "package", "dist"), values: files },
    { directory: join(root, "dist"), values: built },
  ]) {
    mkdirSync(directory, { recursive: true });
    for (const [path, text] of Object.entries(values)) {
      const target = join(directory, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
  const archive = join(fixture, "package.tgz");
  execFileSync("tar", ["-czf", archive, "-C", fixture, "package"]);
  return () => assertBuiltPublicDistMatchesArchive(archive, root);
}

describe("package probes observe the supplied public artifact", () => {
  test("identical public bytes allow the deliberately unpublished friend", () => {
    const check = setup({
      "index.mjs": "export const value = 1;",
      "index.d.mts": "export declare const value: number;",
      "internal/benchmark-operation.mjs": "export const friend = true;",
    });
    expect(check).not.toThrow();
  });

  test("stale public bytes fail before any built-only probe", () => {
    const check = setup({
      "index.mjs": "export const value = 0;",
      "index.d.mts": "export declare const value: number;",
    });
    expect(check).toThrow("differs from supplied archive: index.mjs");
  });

  test("missing published declarations fail", () => {
    expect(setup({ "index.mjs": "export const value = 1;" })).toThrow(
      "missing index.d.mts"
    );
  });

  test("extra public output cannot hide behind artifact selection", () => {
    const check = setup({
      "index.mjs": "export const value = 1;",
      "index.d.mts": "export declare const value: number;",
      "stale.mjs": "export const stale = true;",
    });
    expect(check).toThrow("extra stale.mjs");
  });
});

const chainLinks = `{
  m0: { children: "m1" },
  m1: { parent: "m0"; children: "m2" },
  m2: { parent: "m1"; children: "m3" },
  m3: { parent: "m2"; children: "m4" },
  m4: { parent: "m3" }
}`;
const clientDeclaration = `export declare const db: {
  schema: { target: { getter: unknown } };
  " vibLinks"?: ${chainLinks} | undefined;
};`;

describe("emitted client integrity is independent of model reconstruction", () => {
  test("accepts exact materialized links and intentionally lossy plain models", () => {
    expect(() =>
      assertChain5ClientIntegrity(
        `export declare const model: Model</*elided*/ any>;\n${clientDeclaration}`
      )
    ).not.toThrow();
  });

  test("accepts the prior named Links carrier with the same exact literals", () => {
    expect(() =>
      assertChain5ClientIntegrity(
        `export declare const db: View & Links<${chainLinks}>;`
      )
    ).not.toThrow();
  });

  test("inspects a local alias without resolving imported library aliases", () => {
    expect(() =>
      assertChain5ClientIntegrity(
        `import type { View } from "viborm";
type LocalSchema = { target: { getter: unknown } };
export declare const db: View<LocalSchema> & Links<${chainLinks}>;`
      )
    ).not.toThrow();
  });

  test.each([
    [
      "wrong literal",
      clientDeclaration.replace('children: "m1"', 'children: "m2"'),
    ],
    [
      "union target",
      clientDeclaration.replace('children: "m1"', 'children: "m1" | "m2"'),
    ],
    [
      "any target",
      clientDeclaration.replace('children: "m1"', "children: any"),
    ],
    [
      "missing target",
      clientDeclaration.replace('m4: { parent: "m3" }', "m4: {}"),
    ],
    [
      "original callable getter",
      clientDeclaration.replace(
        "getter: unknown",
        "getter: () => OriginalModel"
      ),
    ],
    [
      "elided client",
      clientDeclaration.replace("getter: unknown", "getter: /*elided*/ any"),
    ],
    ["missing marker", "export declare const db: View;"],
    [
      "getter hidden in a local alias",
      `type LocalSchema = { target: { getter: () => OriginalModel } };
export declare const db: View<LocalSchema> & Links<${chainLinks}>;`,
    ],
    [
      "elision hidden in a local alias",
      `type LocalSchema = Model</*elided*/ any>;
export declare const db: View<LocalSchema> & Links<${chainLinks}>;`,
    ],
    [
      "schema hidden in a local value query",
      `declare const models: { target: { getter: () => OriginalModel } };
export declare const db: View<typeof models> & Links<${chainLinks}>;`,
    ],
    [
      "schema hidden in a generic local alias",
      `type LocalSchema<T> = { target: { getter: T } };
export declare const db: View<LocalSchema<() => OriginalModel>> & Links<${chainLinks}>;`,
    ],
    [
      "schema hidden in a local interface",
      `interface LocalSchema { target: { getter: () => OriginalModel } }
export declare const db: View<LocalSchema> & Links<${chainLinks}>;`,
    ],
    [
      "schema hidden in a local namespace alias",
      `declare namespace Local { type Schema = { getter: () => OriginalModel } }
export declare const db: View<Local.Schema> & Links<${chainLinks}>;`,
    ],
  ])("rejects %s", (_kind, declaration) => {
    expect(() => assertChain5ClientIntegrity(declaration)).toThrow();
  });
});
