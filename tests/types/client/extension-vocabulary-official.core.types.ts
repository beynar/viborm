/**
 * Official extensions applied in one step (D11), typed against the client
 * they are applied to.
 */

import { defaultOmit } from "@src/client/exports";
import { softDelete } from "@src/soft-delete";
import { expectTypeOf } from "vitest";
import { base } from "./extension-vocabulary.fixture";

const hidesHash = base.$extends(defaultOmit({ user: { passwordHash: true } }));
const _omitted = async () => {
  const [row] = await hidesHash.user.findMany();
  expectTypeOf(row!).toEqualTypeOf<{
    id: string;
    tenantId: string;
    firstName: string;
    lastName: string;
  }>();
};
// @ts-expect-error - "passwordHsh" is refused beside the real "passwordHash"
base.$extends(defaultOmit({ user: { passwordHash: true, passwordHsh: true } }));
// @ts-expect-error - "usr" is not a model, beside the real "user"
base.$extends(defaultOmit({ user: { passwordHash: true }, usr: {} }));

const soft = base.$extends(
  softDelete({ models: { user: { deletedAt: "lastName" } } })
);
soft.post.findMany({ deleted: "only" });
soft.user.delete({ where: { id: "u" }, mode: "hard" });
const _restored = async () => {
  const user = await soft.user.restore({ where: { id: "u" } });
  expectTypeOf(user.firstName).toEqualTypeOf<string>();
  const [row] = await soft.post.findMany({ include: { author: true } });
  expectTypeOf(row!.author).toBeNullable();
};
base.$extends(
  softDelete({
    models: {
      // @ts-expect-error - "deletdAt" is refused beside the real "deletedAt"
      user: { deletedAt: "lastName", deletdAt: "lastName" },
    },
  })
);
// @ts-expect-error - "lastNam" is not a field of user
base.$extends(softDelete({ models: { user: { deletedAt: "lastNam" } } }));
