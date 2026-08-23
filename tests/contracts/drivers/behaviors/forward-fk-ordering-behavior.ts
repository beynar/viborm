import { defineContract } from "@tests/contracts/contract";
/**
 * Forward-reference foreign-key push ordering — live driver behavior.
 *
 * The regression witness for the push() forward-FK DDL-ordering bug: a schema
 * that declares a child model (holding a `manyToOne` FK) BEFORE its parent used
 * to emit the FK constraint before the referenced table's CREATE TABLE ran,
 * aborting the whole transactional push (Postgres 42P01, MySQL analogous) with
 * zero tables created. SQLite/LibSQL were always immune (inline FK + lazy
 * resolution); this behavior proves the inline path did not regress there.
 *
 * Reused across all five drivers (PGlite tx + batch, SQLite3, LibSQL, Docker
 * mysql, Docker pg). Every case pushes a forward-declared schema, then proves
 * the tables exist by round-tripping a create + read through the FK, and that a
 * second push is an idempotent no-op (no duplicate ADD CONSTRAINT).
 */

import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, describe, expect, test } from "vitest";

// --- Case 1: simple forward reference (child declared before parent) ---------
const fwdPost = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string(),
    // References `fwdUser`, which is declared AFTER this model.
    author: s
      .toOne(() => fwdUser)
      .fields("authorId")
      .references("id"),
  })
  .map("fwd_fk_posts");

const fwdUser = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => fwdPost),
  })
  .map("fwd_fk_users");

const simpleSchema = { fwdPost, fwdUser };

// --- Case 2: multi-model forward chain (every parent declared last) ----------
const chainA = s
  .model({
    id: s.string().id(),
    bId: s.string(),
    b: s
      .toOne(() => chainB)
      .fields("bId")
      .references("id"),
  })
  .map("fwd_fk_chain_a");

const chainB = s
  .model({
    id: s.string().id(),
    cId: s.string(),
    as: s.toMany(() => chainA),
    c: s
      .toOne(() => chainC)
      .fields("cId")
      .references("id"),
  })
  .map("fwd_fk_chain_b");

const chainC = s
  .model({
    id: s.string().id(),
    bs: s.toMany(() => chainB),
  })
  .map("fwd_fk_chain_c");

const chainSchema = { chainA, chainB, chainC };

// --- Case 3: self reference (tree of nodes) ----------------------------------
const treeNode = s
  .model({
    id: s.string().id(),
    label: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => treeNode)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => treeNode),
  })
  .map("fwd_fk_tree_nodes");

const selfRefSchema = { treeNode };

type AnySchema =
  | typeof simpleSchema
  | typeof chainSchema
  | typeof selfRefSchema;

export interface ForwardFkOrderingBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
  /**
   * Whether the driver's introspection round-trips FK constraint names, so a
   * re-push produces zero operations. Postgres/MySQL store constraint names and
   * round-trip cleanly. SQLite/LibSQL do not store FK names — introspection
   * synthesizes `<table>_fk_N`, which never matches the desired name, so every
   * re-push re-drops and re-adds the FK (a pre-existing no-op churn, unrelated
   * to the forward-ref ordering fix, that also affects referenced-first
   * schemas). Defaults to true.
   */
  fkNamesRoundTrip?: boolean;
}

export function runForwardFkOrderingBehavior({
  driverName,
  createDriver,
  fkNamesRoundTrip = true,
}: ForwardFkOrderingBehaviorOptions) {
  describe(`${driverName} forward-ref FK push ordering`, () => {
    let client:
      | VibORMClient<VibORMConfig & { schema: AnySchema; driver: AnyDriver }>
      | undefined;

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    function make(schema: AnySchema) {
      client = createClient({
        schema: schema as never,
        driver: createDriver(),
      }) as never;
      return client as never as Record<string, any>;
    }

    test("simple forward ref: push creates every table + FK round-trips", async () => {
      const c = make(simpleSchema);

      // Would 42P01 before the fix (FK on fwd_fk_posts precedes CREATE users).
      await push(client as never, { force: true });

      await c.fwdUser.create({ data: { id: "u1", name: "Ann" } });
      await c.fwdPost.create({
        data: { id: "p1", title: "Hello", authorId: "u1" },
      });

      const posts = await c.fwdPost.findMany({ include: { author: true } });
      expect(posts).toHaveLength(1);
      expect(posts[0]?.author?.id).toBe("u1");

      const users = await c.fwdUser.findMany({ include: { posts: true } });
      expect(users[0]?.posts).toHaveLength(1);
    });

    test("multi-model forward chain: push + create through the chain", async () => {
      const c = make(chainSchema);
      await push(client as never, { force: true });

      await c.chainC.create({ data: { id: "c1" } });
      await c.chainB.create({ data: { id: "b1", cId: "c1" } });
      await c.chainA.create({ data: { id: "a1", bId: "b1" } });

      const found = await c.chainA.findMany({
        include: { b: { include: { c: true } } },
      });
      expect(found).toHaveLength(1);
      expect(found[0]?.b?.c?.id).toBe("c1");
    });

    test("self reference: push + parent/child round-trip", async () => {
      const c = make(selfRefSchema);
      await push(client as never, { force: true });

      await c.treeNode.create({ data: { id: "root", label: "root" } });
      await c.treeNode.create({
        data: { id: "leaf", label: "leaf", parentId: "root" },
      });

      const leaf = await c.treeNode.findMany({
        where: { id: "leaf" },
        include: { parent: true },
      });
      expect(leaf[0]?.parent?.id).toBe("root");
    });

    test("idempotency: re-pushing a forward-ref schema does not recreate tables", async () => {
      const c = make(simpleSchema);
      await push(client as never, { force: true });

      const second = await push(client as never, { force: true });

      // The forward-ref fix must never make a re-push recreate tables.
      expect(
        second.operations.filter((o) => o.type === "createTable")
      ).toHaveLength(0);

      if (fkNamesRoundTrip) {
        // Postgres/MySQL round-trip FK names: re-push is a full no-op, so no
        // duplicate ADD CONSTRAINT is emitted.
        expect(second.operations).toHaveLength(0);
        expect(second.sql).toHaveLength(0);
      }

      // Whatever the re-push emitted, the schema still works end to end.
      await c.fwdUser.create({ data: { id: "u9", name: "Zed" } });
      await c.fwdPost.create({
        data: { id: "p9", title: "Again", authorId: "u9" },
      });
      const posts = await c.fwdPost.findMany({ include: { author: true } });
      expect(posts).toHaveLength(1);
      expect(posts[0]?.author?.id).toBe("u9");
    });
  });
}

export const forwardFkOrderingContract = defineContract({
  id: "drivers.forward-fk-ordering",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runForwardFkOrderingBehavior,
});
