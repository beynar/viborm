/**
 * Review of the third extension wave (2026-11-15): since e027c8cdc a unit's
 * parameter snapshot is kept where the driver keeps its own. In
 * `statements(u)`, a native batch member's `parameters` passes the driver's
 * snapshot where `shownOf` takes the property KEY (`unit-words.ts`), so the
 * snapshot the driver took is never read and every read takes another. On
 * f656c7aa5 each read returned the driver's snapshot, the one
 * `parameters(u)` also returns. Values are the same either way: no unit
 * sees another's parameters.
 *
 * Runs on PGlite through the batch-only driver, the parameters disclosed.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import { extension, parameters, statements, unit } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import {
  closeTestPGlite,
  openTestPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

const post = s.model({ id: s.int().id(), title: s.string() });

test("a batch member's parameters are the driver's snapshot, the one parameters(u) reads", async () => {
  const database = openTestPGlite();
  const base = createClient({
    schema: { post },
    driver: new BatchOnlyPGliteDriver({ client: database }),
  });
  try {
    await syncLiveSchema(base as never);
    const seen: { member: unknown; again: unknown; unit: unknown }[] = [];
    const db = base
      .$extends(
        extension(
          "reader",
          unit((u, next) => {
            const members = statements(u);
            if (members !== undefined)
              seen.push({
                member: members[0]?.parameters,
                again: members[0]?.parameters,
                unit: parameters(u)?.[0],
              });
            return next();
          })
        )
      )
      .$extends(
        instrumentation({
          tracing: {
            tracer: {
              startActiveSpan: (_name, fn) =>
                fn({
                  setAttribute: () => undefined,
                  end: () => undefined,
                }),
            },
            includeParams: true,
          },
          diagnostics: { includeParams: true },
        })
      );
    await db.$transaction([
      db.post.findMany({ where: { title: "x" } }),
      db.post.findMany({ where: { title: "y" } }),
    ]);
    expect(seen).toHaveLength(1);
    const [{ member, again, unit: fromUnit }] = seen as [(typeof seen)[0]];
    expect(member).toEqual(["x"]);
    expect(again).toBe(member);
    expect(fromUnit).toBe(member);
  } finally {
    await base.$disconnect();
    await closeTestPGlite(database);
  }
});
