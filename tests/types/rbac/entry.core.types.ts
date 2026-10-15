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

  test("can and assert take the model's own actions and where", () => {
    expectTypeOf(call.team.can("invite", { id: "t1" })).toEqualTypeOf<
      Promise<boolean>
    >();
    expectTypeOf(
      call.organization.assert("export", { id: "org-1" })
    ).toEqualTypeOf<Promise<void>>();
    call.document.can("archive", { parentId: null });
    // @ts-expect-error - `export` is not an action of team
    call.team.can("export", { id: "t1" });
    // @ts-expect-error - `archive` is document's, not page's
    call.page.assert("archive", { id: "p" });
    // @ts-expect-error - `nope` is not a field of page
    call.page.can("view", { nope: true });
  });

  test("a model the policy does not list has no answers", () => {
    // @ts-expect-error - `session` is not listed
    call.session.can("view", { id: "s" });
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
