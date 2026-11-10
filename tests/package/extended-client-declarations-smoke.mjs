/**
 * A package exports clients extended by each official factory, and by all
 * four composed, from the packed package alone; its declaration names each
 * one as `VibORMClient<…>` within a budget, and a downstream file types its
 * calls through that declaration (1.10 review, Sol B #1: one ordered model
 * emitted 1.2 MB, soft delete failed TS7056 and permissions TS4023).
 *
 * The source twin, `tests/types/client/declaration-emit/`, runs in
 * `pnpm test:types`; this one proves the published entries name everything
 * the declaration needs. Run after `pnpm package:build`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryRoot, withPackedConsumer } from "./packed-consumer.mjs";

const clients = `import { createClient, s } from "viborm";
import { on } from "viborm/on";
import { ordering } from "viborm/ordering";
import { permissions } from "viborm/permissions";
import { softDelete } from "viborm/soft-delete";
import { SQLite3Driver } from "viborm/sqlite3";
import { v } from "viborm/validation";

const item = s.model({
  id: s.string().id(),
  rank: s.string(),
  tenant: s.string(),
  title: s.string(),
  deletedAt: s.dateTime().nullable(),
});
const policy = permissions({
  actor: v.object({ tenant: v.string() }),
  models: {
    item: { read: { tenant: { actor: "tenant" } }, create: true, update: true, delete: true },
  },
});
const tombstones = softDelete({ models: { item: { deletedAt: "deletedAt" } } });
const ranks = ordering({ models: { item: { key: "rank" } } });
const hooks = on({ item: { update: () => undefined } });

export const base = createClient({ schema: { item }, driver: new SQLite3Driver() });
export const ordered = base.$extends(ranks);
export const softDeleted = base.$extends(tombstones);
export const governed = base.$extends(policy);
export const governedAs = governed.$as({ tenant: "a" });
export const hooked = base.$extends(hooks);
export const composed = base.$extends(policy).$extends(tombstones).$extends(ranks).$extends(hooks);
export const composedAs = composed.$as({ tenant: "a" });
`;

const downstream = `import { composedAs, governedAs, hooked, ordered, softDeleted } from "./clients.js";
type IsAny<T> = 0 extends 1 & T ? true : false;
type AssertFalse<T extends false> = T;
export type ClientNotAny = AssertFalse<IsAny<typeof composedAs>>;
export async function use() {
  const moved = await composedAs.item.move({ where: { id: "a" }, first: true, select: { id: true, $access: true } });
  const update: boolean = moved.$access.update;
  const restored = await softDeleted.item.restore({ where: { id: "a" }, select: { title: true } });
  const title: string = restored.title;
  const can: boolean = await governedAs.item.can("update", { id: "a" });
  const rows = await hooked.item.findMany({ select: { id: true } });
  const id: string | undefined = rows[0]?.id;
  // @ts-expect-error - move's where names the model's fields
  void ordered.item.move({ where: { id: "a", idd: "b" }, first: true });
  // @ts-expect-error - restore exists only where softDelete applied
  void ordered.item.restore({ where: { id: "a" } });
  return { update, title, can, id };
}
`;

const entries = `import type {} from "viborm";
import type {} from "viborm/on";
import type {} from "viborm/ordering";
import type {} from "viborm/permissions";
import type {} from "viborm/soft-delete";
`;

const compilers = [
  ["TS5.9", join(repositoryRoot, "node_modules/typescript/bin/tsc")],
  ["native", join(repositoryRoot, "node_modules/typescript-native/bin/tsc")],
];
// Bytes per exported declaration; measured at a quarter to a half of these.
const COMPOSED_BUDGET = 96 * 1024;
const budgets = {
  base: 8 * 1024,
  ordered: 24 * 1024,
  softDeleted: 24 * 1024,
  governed: 32 * 1024,
  governedAs: 32 * 1024,
  hooked: 8 * 1024,
  composed: COMPOSED_BUDGET,
  composedAs: COMPOSED_BUDGET,
};
const EXPORTED_CONST = /^export declare const (\w+): /m;
const EACH_EXPORT = /^(?=export declare const )/m;
const CLIENT_REFERENCE = /^import\("viborm"\)\.VibORMClient<|^VibORMClient</;

function compile(compiler, cwd, args) {
  try {
    execFileSync(process.execPath, [compiler, ...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 60_000,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    throw new Error(
      `${compiler} ${args.join(" ")} failed:\n${error.stdout ?? ""}${error.stderr ?? ""}`
    );
  }
}

withPackedConsumer(
  "viborm-extended-client-declarations",
  { "clients.ts": clients },
  ({ root }) => {
    for (const [label, compiler] of compilers) {
      const outDir = join(root, label);
      const project = join(root, `tsconfig-${label}.json`);
      writeFileSync(
        project,
        JSON.stringify({
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            declaration: true,
            emitDeclarationOnly: true,
            skipLibCheck: true,
            outDir,
            types: ["node"],
            typeRoots: [join(repositoryRoot, "node_modules/@types")],
            lib: ["ES2022", "DOM", "esnext.disposable"],
          },
          files: ["./clients.ts"],
        })
      );
      compile(compiler, root, ["--project", project]);
      const declaration = readFileSync(join(outDir, "clients.d.ts"), "utf8");
      const failures = [];
      const seen = new Set();
      for (const text of declaration.split(EACH_EXPORT).slice(1)) {
        const [head, name] = text.match(EXPORTED_CONST) ?? [];
        if (!Object.hasOwn(budgets, name)) {
          failures.push(`${name ?? text.slice(0, 40)} has no budget`);
          continue;
        }
        seen.add(name);
        if (!CLIENT_REFERENCE.test(text.slice(head.length)))
          failures.push(`${name} is not written as a VibORMClient reference`);
        if (text.length > budgets[name])
          failures.push(
            `${name}: ${text.length} bytes, budget ${budgets[name]}`
          );
      }
      for (const name of Object.keys(budgets))
        if (!seen.has(name)) failures.push(`${name} was not emitted`);
      if (failures.length > 0)
        throw new Error(`${label} declarations:\n${failures.join("\n")}`);

      // The downstream file sees the declaration only.
      writeFileSync(join(outDir, "use.ts"), downstream);
      compile(compiler, outDir, [
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--lib",
        "ES2022,DOM,esnext.disposable",
        "--types",
        "node",
        "--typeRoots",
        join(repositoryRoot, "node_modules/@types"),
        "use.ts",
      ]);
      // A consumer that checks its libraries reads what these entries
      // publish: none of it may fail to compile.
      writeFileSync(join(outDir, "entries.ts"), entries);
      compile(compiler, outDir, [
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--lib",
        "ES2022,DOM,esnext.disposable",
        "--types",
        "node",
        "--typeRoots",
        join(repositoryRoot, "node_modules/@types"),
        "entries.ts",
      ]);
      const sizes = Object.fromEntries(
        declaration
          .split(EACH_EXPORT)
          .slice(1)
          .map((text) => [text.match(EXPORTED_CONST)?.[1], text.length])
      );
      console.log(`${label}: ${JSON.stringify(sizes)}`);
    }
  }
);
