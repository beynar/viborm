// T4 (decision 11): bounded history with authored checkpoints. An explicitly
// authored null -> checkpoint transition (generate({ from: null })) on a
// populated estate is published with the leaf's snapshot; once the old
// states are pruned from the history, the marker is re-anchored onto the
// checkpoint (T3's reanchor(), the only marker-moving verb the plan names)
// and the tenant keeps working: verify ok, apply noop, and the next change
// generates and applies from the checkpoint. Pruning is EMULATED by copying
// the object store without the old state manifests (the plan names no prune
// verb), so this probe proves the checkpoint and the re-anchor, not a prune
// capability; it does check that check() on the pruned history reports only
// orphan-* findings (the leftover snapshot and SQL blobs a prune would
// collect). 1.1.0 refuses the checkpoint: V11012 "A second virtual-root
// transition is refused".
import Database from "better-sqlite3";
import { s } from "viborm";
import {
  createMigrationClient,
  MemoryConditionalObjectStore,
  ObjectStoreEstateStorage,
} from "viborm/migrations";
import { createClient } from "viborm/sqlite3";

export const meta = {
  id: "T4-authored-checkpoint",
  title:
    "generate({ from: null }) authors a checkpoint; after an emulated prune, check() sees only orphans and reanchor() keeps the tenant working",
  plan: "phase-4/T4",
  needs: [],
  source:
    "completion-plan-2026-10/code-check/migrations-sqlite.md (T4); src/migrations/AGENTS.md:807; docs migrate.mdx:499",
};

const ROWS = 2000;

const base = {
  id: s.string().id(),
  number: s.string().unique(),
  customerEmail: s.string(),
  status: s.enum(["draft", "sent", "paid", "void"]).default("draft"),
  amountCents: s.int(),
  balanceCents: s.int(),
  metadata: s.json().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
};
const generations = [
  base,
  { ...base, notes: s.string().nullable() },
  { ...base, notes: s.string().nullable(), dueAt: s.dateTime().nullable() },
  {
    ...base,
    notes: s.string().nullable(),
    dueAt: s.dateTime().nullable(),
    currency: s.string().default("EUR"),
  },
];

const code = async (fn) => {
  try {
    await fn();
    return "ok";
  } catch (error) {
    return `${error.code ?? error.name} ${String(error.message).split("\n")[0].slice(0, 90)}`;
  }
};

export default async function probe() {
  const db = new Database(":memory:");
  const store = new MemoryConditionalObjectStore();
  const storage = new ObjectStoreEstateStorage(store);
  const clients = generations.map((fields) =>
    createClient({ client: db, schema: { invoice: s.model(fields) } })
  );
  try {
    const old = [];
    for (const [index, client] of clients.slice(0, 3).entries()) {
      const m = createMigrationClient(client, { storage });
      old.push(await m.generate({ name: `s${index + 1}` }));
      await m.apply();
    }
    await clients[2].invoice.createMany({
      data: Array.from({ length: ROWS }, (_, i) => ({
        id: `inv-${i}`,
        number: `N-${i}`,
        customerEmail: `c${i}@example.test`,
        amountCents: 1000,
        balanceCents: 1000,
      })),
    });
    const current = createMigrationClient(clients[2], { storage });
    let checkpoint;
    try {
      checkpoint = await current.generate({ name: "checkpoint", from: null });
    } catch (error) {
      return {
        status: "fail",
        evidence: `generate({ from: null }) on a populated estate: ${error.code} ${String(error.message).split("\n")[0].slice(0, 120)}`,
      };
    }
    const leafSnapshot = old[2].snapshotHash;
    if (
      checkpoint.outcome !== "published" ||
      checkpoint.snapshotHash !== leafSnapshot
    ) {
      return {
        status: "fail",
        evidence: `checkpoint ${checkpoint.outcome}, snapshot equals leaf: ${checkpoint.snapshotHash === leafSnapshot}`,
      };
    }
    const pruned = new MemoryConditionalObjectStore();
    const oldIds = old.map((state) => state.stateId);
    for (const key of await store.list("")) {
      if (oldIds.some((id) => key.includes(id))) continue;
      await pruned.putIfAbsent(key, await store.get(key));
    }
    const prunedStorage = new ObjectStoreEstateStorage(pruned);
    const m = createMigrationClient(clients[2], { storage: prunedStorage });
    const { findings } = await m.check();
    const orphans = findings.map((finding) => finding.code);
    if (
      !orphans.includes("orphan-sql") ||
      orphans.some((found) => !found.startsWith("orphan-"))
    ) {
      return {
        status: "fail",
        evidence: `check() after the emulated prune: [${orphans.join(",")}] (expected only orphan-* findings, orphan-sql among them)`,
      };
    }
    if (typeof m.reanchor !== "function") {
      return {
        status: "fail",
        evidence: "checkpoint published; migration client has no reanchor()",
      };
    }
    const reanchored = await code(() => m.reanchor());
    const marker = (await m.status()).marker?.stateId === checkpoint.stateId;
    const verified = await m.verify().then(
      (r) => r.ok,
      (error) => error.code
    );
    const again = await m.apply().then(
      (r) => r.outcome,
      (error) => error.code
    );
    const next = createMigrationClient(clients[3], { storage: prunedStorage });
    const nextState = await code(async () => {
      await next.generate({ name: "s4" });
      await next.apply();
    });
    const rows = db.prepare(`SELECT count(*) AS n FROM "invoice"`).get().n;
    const ok =
      reanchored === "ok" &&
      marker &&
      verified === true &&
      again === "noop" &&
      nextState === "ok" &&
      rows === ROWS;
    return {
      status: ok ? "pass" : "fail",
      evidence: `checkpoint published (leaf snapshot); pruned ${oldIds.length} states, check() [${orphans.join(",")}]; reanchor ${reanchored}, marker at checkpoint ${marker}, verify ${verified}, apply ${again}, next change ${nextState}, rows ${rows}`,
    };
  } finally {
    for (const client of clients) await client.$disconnect();
    db.close();
  }
}
