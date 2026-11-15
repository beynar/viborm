/**
 * The entry's types (plan §1.1, D0, D8, K6; §11.2 F5 and F8): `permissions(config)`
 * applied to a client (`base.$extends(policy)`, one step) is that client governed; `db.$as(actor)` is the same
 * client again (a polymorphic `this`, OD-1 option 2), its argument the actor
 * schema's input; every listed model's `$access` names its own declared
 * actions; the actor is never an argument, and `as` takes the policy's modes
 * only.
 */

import type { PermissionsAppClient } from "@tests/contracts/public-client/permissions-app-behavior";
import { describe, expectTypeOf, test } from "vitest";
import { policy } from "./acceptance-policy";

declare const base: PermissionsAppClient;
const actor = { userId: "user-01", organizationId: "org-1", network: "office" };

describe("base.$extends(permissions(config))", () => {
  const db = base.$extends(policy);
  const call = db.$as(actor);

  test("$as returns the governed client itself", () => {
    expectTypeOf(call).toEqualTypeOf<typeof db>();
  });

  test("$as takes the actor as its schema parses it", () => {
    db.$as({ ...actor, session: "s", key: undefined });
    // @ts-expect-error - `userId` is a string
    db.$as({ ...actor, userId: 1 });
    // @ts-expect-error - `organizationId` is required
    db.$as({ userId: "user-01", network: "office" });
  });

  test("$access names the model's own actions; can and assert were removed", async () => {
    const team = await call.team.findUnique({
      where: { id: "t1" },
      select: { $access: ["invite"] },
    });
    expectTypeOf(team!.$access).toEqualTypeOf<{ readonly invite: boolean }>();
    // @ts-expect-error - `export` is not an action of team, beside one that is
    call.team.findMany({ select: { $access: ["invite", "export"] } });
    // @ts-expect-error - `archive` is document's, not page's
    call.page.findMany({ select: { id: true, $access: ["read", "archive"] } });
    // @ts-expect-error - can was removed: read `$access` instead
    call.team.can("invite", { id: "t1" });
    // @ts-expect-error - assert was removed: read `$access` instead
    call.organization.assert("export", { id: "org-1" });
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
    // A ladder graph keeps the same boolean-map evidence shape.
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
    // @ts-expect-error - `session` is not listed: it declares no action
    call.session.findMany({ select: { id: true, $access: ["read"] } });
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
