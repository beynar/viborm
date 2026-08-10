import { s } from "@schema";
import {
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * PACKAGE C — C2 step 6 / C3: an INVERSE polymorphic relation whose TARGET has a
 * COMPOUND row key.
 *
 * This topology had no contract anywhere in the estate (Package A named it as an
 * unpinned hole: every polymorphic witness schema keys its targets by one column),
 * and `RecordUpdateCompiler.interpretPolymorphicChildHeld` refused it outright.
 * The refusal is deleted, so this file is the evidence for what replaced it.
 *
 * THE TWO KEYS ARE DIFFERENT FACTS, and the schema makes them collide on purpose:
 *
 *   · ROW KEY of the target      — `(tenantId, code)`, and nothing else. It is what a
 *     targeted update/delete addresses, both members of it.
 *   · MEMBERSHIP KEY of the edge — the stored reference `holder_id → hub.id` PLUS the
 *     fixed discriminator `holder_type = 'polyc.hub.v1'`. The discriminator qualifies
 *     the membership; it is never a member of the row key, never selected as one, and
 *     never addressed as one.
 *
 * THE DECOYS ARE THE MEASUREMENT.
 *   · `t1|c2` agrees with the target on the TENANT alone and `t2|c1` on the CODE
 *     alone, so a row key narrowed to its first member does not write a wrong string —
 *     it writes A DIFFERENT ROW.
 *   · `vault` is a second polymorphic member and its id is SPELLED THE SAME as the
 *     hub's ("x1"), so the slot it owns has an identical `holder_id`. A membership
 *     predicate that dropped the discriminator would treat that row as the hub's.
 *
 * Both substrates run every test: transaction mode decides on a locked read, atomic
 * batch mode pins the same premises with guards, and neither may reach a decoy.
 */
const polymorphicCompoundSchema = (() => {
  const hub = s
    .model({
      id: s.string().id(),
      name: s.string(),
      slots: s.oneToMany(() => slot).name("holder"),
    })
    .map("polyc_hubs");

  const vault = s
    .model({
      id: s.string().id(),
      name: s.string(),
    })
    .map("polyc_vaults");

  /** The compound-row-key polymorphic child. */
  const slot = s
    .model({
      tenantId: s.string(),
      code: s.string(),
      note: s.string(),
      holder: s
        .polymorphic(
          { hub: () => hub, vault: () => vault },
          {
            values: { hub: "polyc.hub.v1", vault: "polyc.vault.v1" },
          }
        )
        .name("holder")
        .optional(),
    })
    .id(["tenantId", "code"])
    .map("polyc_slots");

  return { hub, vault, slot };
})();

type PolymorphicCompoundFamily = PGliteSchemaFamily<
  typeof polymorphicCompoundSchema
>;

interface StoredSlot {
  readonly tenantId: string;
  readonly code: string;
  readonly note: string;
  readonly holder_type: string | null;
  readonly holder_id: string | null;
}

/** Every slot with its raw private pair, so membership is read as stored. */
async function storedSlots(
  family: PolymorphicCompoundFamily
): Promise<Record<string, string>> {
  const rows = await family.client.$queryRawUnsafe<StoredSlot>(
    'SELECT "tenantId", "code", "note", "holder_type", "holder_id" FROM "polyc_slots" ORDER BY "tenantId", "code"'
  );
  return Object.fromEntries(
    rows.map((row) => [
      `${row.tenantId}|${row.code}`,
      `${row.note}/${row.holder_type ?? "-"}/${row.holder_id ?? "-"}`,
    ])
  );
}

/**
 * One hub and one vault that SHARE the id "x1"; three slots held by the hub and one
 * held by the vault. Seeding goes through the child's own direct polymorphic payload,
 * which is the storage owner for the private pair.
 */
async function seed(family: PolymorphicCompoundFamily): Promise<void> {
  const { client } = family;
  await client.hub.create({ data: { id: "x1", name: "hub" } });
  await client.vault.create({ data: { id: "x1", name: "vault" } });
  for (const [tenantId, code] of [
    ["t1", "c1"],
    ["t1", "c2"],
    ["t2", "c1"],
  ] as const) {
    await client.slot.create({
      data: {
        tenantId,
        code,
        note: "n",
        holder: { connect: { type: "hub", where: { id: "x1" } } },
      },
    });
  }
  await client.slot.create({
    data: {
      tenantId: "t9",
      code: "c9",
      note: "n",
      holder: { connect: { type: "vault", where: { id: "x1" } } },
    },
  });
}

const HUB = "polyc.hub.v1/x1";
const VAULT = "polyc.vault.v1/x1";

function registerPolymorphicCompoundTargetBehavior(
  name: string,
  mode: "transaction" | "atomicBatch"
): void {
  describe(`inverse polymorphic relation with a compound-keyed target (${name})`, () => {
    const getFamily = usePGliteSchemaFamily(polymorphicCompoundSchema, mode);

    test("a targeted update addresses BOTH row-key members of the member row", async () => {
      const family = getFamily();
      await seed(family);

      await family.client.hub.update({
        where: { id: "x1" },
        data: {
          slots: {
            update: [
              {
                where: { tenantId_code: { tenantId: "t1", code: "c1" } },
                data: { note: "moved" },
              },
            ],
          },
        },
      });

      expect(await storedSlots(family)).toEqual({
        "t1|c1": `moved/${HUB}`,
        "t1|c2": `n/${HUB}`,
        "t2|c1": `n/${HUB}`,
        "t9|c9": `n/${VAULT}`,
      });
    });

    test("a targeted delete removes only the row both members name", async () => {
      const family = getFamily();
      await seed(family);

      await family.client.hub.update({
        where: { id: "x1" },
        data: {
          slots: {
            delete: [{ tenantId_code: { tenantId: "t1", code: "c1" } }],
          },
        },
      });

      expect(await storedSlots(family)).toEqual({
        "t1|c2": `n/${HUB}`,
        "t2|c1": `n/${HUB}`,
        "t9|c9": `n/${VAULT}`,
      });
    });

    test("disconnect clears the private pair of exactly that row", async () => {
      const family = getFamily();
      await seed(family);

      await family.client.hub.update({
        where: { id: "x1" },
        data: {
          slots: {
            disconnect: [{ tenantId_code: { tenantId: "t1", code: "c1" } }],
          },
        },
      });

      expect(await storedSlots(family)).toEqual({
        "t1|c1": "n/-/-",
        "t1|c2": `n/${HUB}`,
        "t2|c1": `n/${HUB}`,
        "t9|c9": `n/${VAULT}`,
      });
    });

    test("connect adopts a compound-keyed row across the discriminator", async () => {
      const family = getFamily();
      await seed(family);

      // The vault's slot is NOT a member of the hub, so this is an adopt: the
      // discriminator is rewritten together with the stored reference, atomically,
      // and the row is still named by both of its row-key members.
      await family.client.hub.update({
        where: { id: "x1" },
        data: {
          slots: {
            connect: [{ tenantId_code: { tenantId: "t9", code: "c9" } }],
          },
        },
      });

      expect(await storedSlots(family)).toEqual({
        "t1|c1": `n/${HUB}`,
        "t1|c2": `n/${HUB}`,
        "t2|c1": `n/${HUB}`,
        "t9|c9": `n/${HUB}`,
      });
    });

    test("set keeps the named member, clears the departing ones, and never touches a foreign discriminator", async () => {
      const family = getFamily();
      await seed(family);

      await family.client.hub.update({
        where: { id: "x1" },
        data: {
          slots: {
            set: [{ tenantId_code: { tenantId: "t1", code: "c2" } }],
          },
        },
      });

      expect(await storedSlots(family)).toEqual({
        // Departing members, cleared: the membership read found them by the exact
        // (discriminator, stored reference) pair and addressed each by both members.
        "t1|c1": "n/-/-",
        "t2|c1": "n/-/-",
        "t1|c2": `n/${HUB}`,
        // Same `holder_id`, different discriminator: never a member, never cleared.
        "t9|c9": `n/${VAULT}`,
      });
    });

    test("an upsert found arm runs on the member row and leaves the twins alone", async () => {
      const family = getFamily();
      await seed(family);

      await family.client.hub.update({
        where: { id: "x1" },
        data: {
          slots: {
            upsert: [
              {
                where: { tenantId_code: { tenantId: "t1", code: "c1" } },
                create: { tenantId: "t1", code: "c1", note: "unused" },
                update: { note: "found-arm" },
              },
            ],
          },
        },
      });

      expect(await storedSlots(family)).toEqual({
        "t1|c1": `found-arm/${HUB}`,
        "t1|c2": `n/${HUB}`,
        "t2|c1": `n/${HUB}`,
        "t9|c9": `n/${VAULT}`,
      });
    });
  });
}

registerPolymorphicCompoundTargetBehavior("transaction", "transaction");
registerPolymorphicCompoundTargetBehavior("atomic batch", "atomicBatch");
