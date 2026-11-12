/**
 * The `written` capability as an extension author uses it, through public
 * entry points only (`viborm/on` is the first extension built on it, and
 * `on-behavior.ts` covers what it promises on every provider): what one
 * watch is asked and told, and in which order.
 */

import { QueryError } from "@errors";
import {
  defineExtension,
  type WrittenCall,
  type WrittenWatch,
} from "@src/index";
import { softDelete } from "@src/soft-delete";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { failure } from "@tests/fixtures/failure";
import { createBatchOnlySQLite3Driver } from "@tests/providers/local/sqlite3-fixtures";
import { afterEach, describe, expect, test } from "vitest";
import { openOnFixture } from "./on-behavior";

type Base = Awaited<ReturnType<typeof openOnFixture>>;

/** A watch that wants everything and records what it is told, in order. */
function recording(log: unknown[], label = "") {
  return (call: WrittenCall): WrittenWatch => {
    log.push(`${label}asked ${call.model}.${call.operation}`);
    return {
      wants: () => true,
      rows(model, kind, rows, nested) {
        log.push(
          `${label}${nested ? "nested " : ""}${model}.${kind} ${rows.map((row) => row.id).join(",")}`
        );
      },
      settled({ certainty }) {
        log.push(`${label}settled ${certainty}`);
      },
    };
  };
}

for (const [name, createDriver] of [
  ["SQLite3", createInMemorySQLite3Driver],
  ["SQLite3 batch-only", createBatchOnlySQLite3Driver],
] as const)
  describe(`${name}: written`, () => {
    const opened: Base[] = [];
    afterEach(async () => {
      for (const base of opened.splice(0)) await base.$disconnect();
    });
    async function open() {
      const base = await openOnFixture(createDriver());
      opened.push(base);
      return base;
    }

    test("a watch is asked before the write, told the call's rows, then its nested rows, then the commit", async () => {
      const base = await open();
      const log: unknown[] = [];
      const db = base.$extends({ name: "watch", written: recording(log) });
      const value = await db.user.update({
        where: { id: "u1" },
        data: {
          name: "Ada L.",
          posts: {
            create: { id: "p9", title: "new" },
            update: { where: { id: "p1" }, data: { views: 5 } },
            delete: { id: "p2" },
          },
        },
        select: { name: true },
      });
      expect(value).toEqual({ name: "Ada L." });
      expect(log).toEqual([
        "asked user.update",
        "user.update u1",
        "nested post.delete p2",
        "nested post.update p1",
        "nested post.create p9",
        "settled committed",
      ]);
    });

    test("rows are whole whatever the caller selects, and only the rows a watch wants are told", async () => {
      const base = await open();
      const told: unknown[] = [];
      const db = base.$extends({
        name: "watch",
        written: (): WrittenWatch => ({
          wants: (model, kind) => model === "post" && kind === "update",
          rows: (model, kind, rows) => told.push([model, kind, rows]),
          settled: () => undefined,
        }),
      });
      await db.user.update({
        where: { id: "u1" },
        data: { name: "A" },
        select: { id: true },
      });
      expect(told).toEqual([]);
      const value = await db.post.update({
        where: { id: "p3" },
        data: { views: 7 },
        select: { views: true },
      });
      expect(value).toEqual({ views: 7 });
      expect(told).toEqual([
        [
          "post",
          "update",
          [
            {
              id: "p3",
              title: "title p3",
              views: 7,
              price: null,
              authorId: "u2",
              editorId: null,
              deletedAt: null,
            },
          ],
        ],
      ]);
    });

    test("the kind is what happened: an upsert's arm, and the update a soft delete makes of a delete", async () => {
      const base = await open();
      const log: unknown[] = [];
      const db = softDelete({ models: { post: { deletedAt: "deletedAt" } } })(
        base
      ).$extends({ name: "watch", written: recording(log) });
      const upsert = (id: string) =>
        db.user.upsert({
          where: { id },
          create: { id, email: `${id}@example.com`, name: "New" },
          update: { name: "Found" },
        });
      await upsert("u1");
      await upsert("u9");
      await db.post.delete({ where: { id: "p1" } });
      await db.user.delete({ where: { id: "u9" } });
      expect(log.filter((line) => !String(line).startsWith("asked"))).toEqual([
        "user.update u1",
        "settled committed",
        "user.create u9",
        "settled committed",
        "post.update p1",
        "settled committed",
        "user.delete u9",
        "settled committed",
      ]);
    });

    test("a watch that answers nothing leaves the call as it is; a call that fails tells nothing", async () => {
      const base = await open();
      const log: unknown[] = [];
      const watch = recording(log);
      const db = base.$extends({
        name: "watch",
        written: (call) => (call.model === "user" ? watch(call) : undefined),
      });
      await db.post.update({ where: { id: "p1" }, data: { views: 1 } });
      expect(log).toEqual([]);
      await failure(
        db.user.update({ where: { id: "none" }, data: { name: "x" } })
      );
      expect(log).toEqual(["asked user.update"]);
    });

    test("inside a transaction a watch is told the rows at once and the commit at the end; a rollback tells no commit", async () => {
      const base = await open();
      if (!base.$driver.supportsTransactions) return;
      const log: unknown[] = [];
      const db = base.$extends({ name: "watch", written: recording(log) });
      await db.$transaction(async (tx) => {
        await tx.user.update({ where: { id: "u1" }, data: { name: "T" } });
        log.push("body");
      });
      await failure(
        db.$transaction(async (tx) => {
          await tx.user.update({ where: { id: "u2" }, data: { name: "R" } });
          throw new Error("undo");
        })
      );
      expect(log).toEqual([
        "asked user.update",
        "user.update u1",
        "body",
        "settled committed",
        "asked user.update",
        "user.update u2",
      ]);
    });

    test("$transaction([...]): each member's rows before its commit, one member after another", async () => {
      const base = await open();
      const log: unknown[] = [];
      const db = base.$extends({ name: "watch", written: recording(log) });
      await db.$transaction([
        db.user.update({ where: { id: "u1" }, data: { name: "One" } }),
        db.user.update({ where: { id: "u2" }, data: { name: "Two" } }),
      ]);
      const told = log.filter((line) => !String(line).startsWith("asked"));
      expect(told.indexOf("user.update u1")).toBeLessThan(
        told.indexOf("settled committed")
      );
      expect(told).toHaveLength(4);
      expect(told.filter((line) => line === "settled committed")).toHaveLength(
        2
      );
      expect(told.lastIndexOf("user.update u2")).toBeLessThan(
        told.lastIndexOf("settled committed")
      );
    });

    test("several extensions watch one call, each told in the order they were applied", async () => {
      const base = await open();
      const log: unknown[] = [];
      const db = base
        .$extends({ name: "first", written: recording(log, "1 ") })
        .$extends({ name: "second", written: recording(log, "2 ") });
      await db.user.update({ where: { id: "u1" }, data: { name: "Both" } });
      expect(log).toEqual([
        "1 asked user.update",
        "2 asked user.update",
        "1 user.update u1",
        "2 user.update u1",
        "1 settled committed",
        "2 settled committed",
      ]);
    });

    test("what settled throws rejects the call as a QueryError naming the extension; the write stays made", async () => {
      const base = await open();
      const db = base.$extends({
        name: "broken",
        written: (): WrittenWatch => ({
          wants: () => true,
          rows: () => undefined,
          settled() {
            throw new Error("sink down");
          },
        }),
      });
      const error = (await failure(
        db.user.update({ where: { id: "u1" }, data: { name: "Kept" } })
      )) as QueryError;
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toContain('Extension "broken"');
      expect(await base.user.findUnique({ where: { id: "u1" } })).toMatchObject(
        { name: "Kept" }
      );
    });

    test("a watch sees only the controls its own extension declares", async () => {
      const base = await open();
      const seen: unknown[] = [];
      const db = base
        .$extends(
          defineExtension({
            name: "other",
            controls: { reason: { oneOf: ["test"], on: "writes" } },
          })
        )
        .$extends(
          defineExtension({
            name: "watch",
            controls: { actor: { oneOf: ["ada"], on: "writes" } },
            written(call) {
              seen.push(call.controls);
              return undefined;
            },
          })
        );
      await db.user.update({
        where: { id: "u1" },
        data: { name: "C" },
        actor: "ada",
        reason: "test",
      } as never);
      expect(seen).toEqual([{ actor: "ada" }]);
    });

    test("written must be a function", async () => {
      const base = await open();
      expect(() =>
        base.$extends({ name: "bad", written: {} } as never)
      ).toThrow('Extension "bad" written must be a function.');
    });
  });
