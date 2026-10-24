/**
 * Neon Realtime signatures: each `<op>Realtime` takes the ordinary read's own
 * arguments and carries its result type; the browser half infers it back
 * from a query that crossed a JSON transport. Nothing here is called.
 */

import { PGliteDriver } from "@drivers/pglite";
import { createClient, s } from "@src/index";
import { expectTypeOf } from "vitest";
import {
  neonRealtime,
  type RealtimeQuery,
  type RealtimeRenewal,
} from "../../../src/neon-realtime";
import { realtimeData, subscribe } from "../../../src/neon-realtime/client";

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  at: s.dateTime(),
});
declare const realtime: Parameters<typeof neonRealtime>[0]["realtime"];
const db = createClient({
  schema: { post },
  driver: new PGliteDriver(),
}).$extends(neonRealtime({ realtime }));
type Row = { id: string; title: string; at: Date };

export async function signatures() {
  const many = await db.post.findManyRealtime({ select: { id: true } });
  expectTypeOf(many).toEqualTypeOf<RealtimeQuery<{ id: string }[]>>();
  // Present only on the server that read it: transports drop it.
  expectTypeOf(many.data).toEqualTypeOf<{ id: string }[] | undefined>();
  expectTypeOf(realtimeData(many)).toEqualTypeOf<{ id: string }[]>();
  expectTypeOf(
    await db.post.findUniqueRealtime({ where: { id: "p" } })
  ).toEqualTypeOf<RealtimeQuery<Row | null>>();
  expectTypeOf(
    await db.post.findUniqueOrThrowRealtime({ where: { id: "p" } })
  ).toEqualTypeOf<RealtimeQuery<Row>>();
  expectTypeOf(await db.post.countRealtime()).toEqualTypeOf<
    RealtimeQuery<number>
  >();
  expectTypeOf(await db.post.existRealtime()).toEqualTypeOf<
    RealtimeQuery<boolean>
  >();
  expectTypeOf(
    await db.post.findManyRealtime(undefined, { initialData: false })
  ).toEqualTypeOf<RealtimeRenewal<Row[]>>();

  // The ordinary read's argument checks hold.
  // @ts-expect-error: no such field.
  await db.post.findManyRealtime({ where: { nope: 1 } });
  // @ts-expect-error: findUnique needs its unique selector.
  await db.post.findUniqueRealtime();

  // A query that crossed JSON still names its result.
  const wire: typeof many = JSON.parse(JSON.stringify(many));
  const subscription = subscribe(wire, { url: "wss://realtime" });
  expectTypeOf(subscription.getSnapshot().data).toEqualTypeOf<
    { id: string }[] | undefined
  >();
  expectTypeOf(realtimeData(wire)).toEqualTypeOf<{ id: string }[]>();
  const count = await db.post.countRealtime(undefined, { initialData: false });
  // @ts-expect-error: a renewal carries no first result.
  realtimeData(count);
  // @ts-expect-error: a renewal is for the same read's result.
  await subscription.renew(count);
}
