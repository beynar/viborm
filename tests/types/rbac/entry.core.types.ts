/**
 * The entry's types (plan §1.1, D0, D8, K6; §11.2 F5 and F8): `rbac(config)`
 * applied to a client is that client governed; `db.$as(actor)` is the same
 * client again (a polymorphic `this`, OD-1 option 2), its argument the actor
 * schema's input; every listed model answers `can` and `assert` at its own
 * declared actions, over its own `where`; the actor is never an argument,
 * and `as` takes the policy's modes only.
 */

import type { RbacAppClient } from "@tests/contracts/public-client/rbac-app-behavior";
import { describe, expectTypeOf, test } from "vitest";
import { policy } from "./acceptance-policy";

declare const base: RbacAppClient;
const actor = { userId: "user-01", organizationId: "org-1", network: "office" };

describe("rbac(config)(base)", () => {
  const db = policy(base);
  const call = db.$as(actor);

  test("$as returns the governed client itself, in either composition", () => {
    expectTypeOf(call).toEqualTypeOf<typeof db>();
    const extended = base.$extends(policy);
    expectTypeOf(extended).toEqualTypeOf<typeof db>();
    const steps = policy.methods(policy.rows(base));
    expectTypeOf(steps.$as(actor)).toEqualTypeOf<typeof steps>();
  });

  test("$as takes the actor as its schema parses it", () => {
    db.$as({ ...actor, session: "s", key: undefined });
    // @ts-expect-error - `userId` is a string
    db.$as({ ...actor, userId: 1 });
    // @ts-expect-error - `organizationId` is required
    db.$as({ userId: "user-01", network: "office" });
  });

  test("can and assert take the model's own actions and a unique where", () => {
    expectTypeOf(call.team.can("invite", { id: "t1" })).toEqualTypeOf<
      Promise<boolean>
    >();
    expectTypeOf(
      call.organization.assert("export", { id: "org-1" })
    ).toEqualTypeOf<Promise<void>>();
    // @ts-expect-error - a filter is not a unique selector (review Fsecurity-2)
    call.document.can("archive", { parentId: null });
    // @ts-expect-error - `export` is not an action of team
    call.team.can("export", { id: "t1" });
    // @ts-expect-error - `archive` is document's, not page's
    call.page.assert("archive", { id: "p" });
    // @ts-expect-error - `nope` is not a field of page
    call.page.can("read", { nope: true });
  });

  test("can with a list answers a record of exactly the listed actions", () => {
    expectTypeOf(
      call.document.can(["comment", "share"], { id: "d1" })
    ).toEqualTypeOf<
      Promise<{ readonly comment: boolean; readonly share: boolean }>
    >();
    expectTypeOf(
      call.page.assert(["read", "update"], { id: "p" })
    ).toEqualTypeOf<Promise<void>>();
    // @ts-expect-error - `archive` is not an action of page
    call.page.can(["read", "archive"], { id: "p" });
  });

  test("$access is a projection key at every depth, typed by each model's actions (D6, OD-2)", async () => {
    const documents = await call.document.findMany({
      select: {
        id: true,
        $access: true,
        children: { select: { id: true, $access: ["share"] } },
      },
    });
    expectTypeOf(documents[0]!.$access).toEqualTypeOf<{
      readonly read: boolean;
      readonly comment: boolean;
      readonly archive: boolean;
      readonly update: boolean;
      readonly share: boolean;
      readonly export: boolean;
      readonly create: boolean;
    }>();
    expectTypeOf(documents[0]!.children[0]!.$access).toEqualTypeOf<{
      readonly share: boolean;
    }>();
    // Levels retain the same boolean-map evidence shape.
    const pages = await call.page.findMany({
      include: { $access: true, group: { include: { $access: true } } },
    });
    expectTypeOf(pages[0]!.$access).toEqualTypeOf<{
      readonly read: boolean;
      readonly update: boolean;
      readonly full: boolean;
      readonly create: boolean;
    }>();
    // @ts-expect-error - `archive` is not one of page's names
    await call.page.findMany({ select: { id: true, $access: ["archive"] } });
  });

  test("a read-gated field is omitted from the default row and present when selected (D5)", async () => {
    // A default omit decided per row: absent where the actor lacks `full`.
    const [row] = await call.collection.findMany();
    expectTypeOf(row!.budget).toEqualTypeOf<number | undefined>();
    const [named] = await call.collection.findMany({
      select: { id: true, budget: true },
    });
    expectTypeOf(named!.budget).toEqualTypeOf<number>();
  });

  test("a model the policy does not list has no answers", () => {
    // @ts-expect-error - `session` is not listed
    call.session.can("read", { id: "s" });
  });

  test("the actor is bound only; `as` takes the policy's modes", () => {
    // @ts-expect-error - the actor is never an argument
    call.page.findMany({ actor });
    call.page.findMany({ as: "given" });
    call.document.findMany({ as: "comment" });
    // @ts-expect-error - no model declares `nope`
    call.page.findMany({ as: "nope" });
  });
});
