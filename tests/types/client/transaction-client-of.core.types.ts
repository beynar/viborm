/** `TransactionClient` and `TransactionClientOf<Client>` name a callback's `tx`. */

import { createClient } from "@src/drivers/sqlite3";
import {
  s,
  type TransactionClient,
  type TransactionClientOf,
  type VibORMConfig,
} from "@src/index";
import { permissions } from "@src/permissions";
import { v } from "@src/validation";
import { expectTypeOf } from "vitest";

export function checkTransactionClientOf() {
  const page = s.model({ id: s.string().id(), title: s.string() });
  const base = createClient({ schema: { page }, dataDir: ":memory:" });

  // The client's own transaction client, by inference and by name.
  base.$transaction(async (tx) => {
    expectTypeOf(tx).toEqualTypeOf<TransactionClientOf<typeof base>>();
    expectTypeOf(tx).toEqualTypeOf<
      TransactionClient<VibORMConfig<{ page: typeof page }>>
    >();
  });

  // A function taking "a client or a transaction" works on both.
  type Tx = TransactionClientOf<typeof base>;
  const rename = (db: typeof base | Tx, id: string) =>
    db.page.update({ where: { id }, data: { title: "x" } });
  rename(base, "a");
  base.$transaction((tx) => rename(tx, "a"));

  // A governed view's transaction client keeps the view's models.
  const governed = base
    .$extends(
      permissions({
        actor: v.object({ userId: v.string() }),
        models: { page: { read: true, update: true } },
      })
    )
    .$as({ userId: "u" });
  governed.$transaction(async (tx) => {
    expectTypeOf(tx).toEqualTypeOf<TransactionClientOf<typeof governed>>();
  });

  // Not a client: nothing.
  expectTypeOf<TransactionClientOf<{ page: unknown }>>().toBeNever();
}
