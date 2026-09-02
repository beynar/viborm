import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { hydrateSchemaNames, s } from "@schema";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * E2-U1 — **the inverse-side to-one `update` folds the relations in its data.**
 *
 * The boundary this file replaces (`RelationWritePart.interpretChildParts`) asked for a
 * unique `where` before it would fold a nested relation write. A to-many target has one;
 * an inverse-side to-one NEVER does — its locator is the foreign-key correlation alone
 * (V1's `normalizeUpdateInputs` yields `{ data }` for a to-one) — so the
 * whole family declined, measured live on both substrates before the lift:
 *
 *   UnsupportedOperationError: query-engine-v2 update for relation 'profile' does not
 *   support nested relation writes in its data.        (0 statements, both substrates)
 *
 * The `where` was never the premise. What the deeper edges need is the target's primary
 * key, and this part's own correlated probe LOCATES the row and selects that key — the
 * same probe N4-U1 already Refs when a to-many target is named by some OTHER unique. So
 * the to-one takes the identical `planned` source, and the `where` decides only whether
 * that identity is ALSO a compile-time literal.
 *
 * What this file pins beyond "it works":
 *
 *  · **Both substrates.** A transaction locks the located row (`FOR UPDATE`) and inlines
 *    the probe's key at compile; an atomic batch re-asserts the located row with the
 *    split-witness presence guard and ships one unit. Same payloads, same state.
 *  · **Decoys.** A second user owns a second profile with its own notes. Every write
 *    must land under the profile of the user the root located, and the decoy's rows must
 *    be untouched — the assertion a "take the first row" resolution fails.
 *  · **Provenance** (the wrong-row doctrine). The decoys cannot catch a RE-DERIVATION:
 *    re-reading `WHERE userId = <parent>` a second time finds the same row. Only
 *    corrupting what the probe RETURNED separates "the value came from the row this step
 *    locked" from "the value was derived again from the correlation", so the
 *    `CorruptLocate` instrument (`depth-seam.test.ts`, `located-parent-ref.test.ts`) is
 *    aimed at this probe too.
 *  · **The batch ordering.** The child Parts' writes are compiled AFTER this part's
 *    presence guard (`RelationWritePart.compileTargeted` pushes the guard first, then
 *    the self-UPDATE, then the child steps). In one atomic unit a failed guard aborts
 *    everything after it, so there is no arm under which a grandchild lands beside a
 *    target that vanished — no orphan.
 *  · **The carve-outs, both now lifted.** The inverse-side to-one UPSERT arm used to
 *    keep the refusal (its compile decided the three-way and its found arm emitted the
 *    update leaf alone); PACKAGE G routed that found arm through the same record
 *    compiler, and the `PACKAGE G …UPSERT arm with relations` describe below carries
 *    the same depth claims on both substrates plus the two the upsert alone can make —
 *    the missing arm binds and validates none of the update subtree, and found-arm
 *    legality runs only once the found arm is selected. The
 *    second carve-out — a payload that transitions the target's primary key with no
 *    where-pinned pre-value — was LIFTED by Package D2 and the two tests at the bottom
 *    now pin both halves of it: the occupied old slot still refuses, with the
 *    relation-level occupied message instead of a construction-time one that named the
 *    wrong remedy, and an empty old slot compiles.
 */
const inverseDepthSchema = (() => {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      profile: s.toOne(() => profile),
    })
    .map("e2u1_users");
  const profile = s
    .model({
      id: s.string().id(),
      bio: s.string(),
      // `.unique()` is structural for a 1:1 (FK008 refuses to define one without it).
      userId: s.string().unique().nullable(),
      user: s
        .toOne(() => user)
        .fields("userId")
        .references("id"),
      notes: s.toMany(() => note),
      labels: s.toMany(() => label),
    })
    .map("e2u1_profiles");
  const note = s
    .model({
      id: s.string().id(),
      text: s.string(),
      profileId: s.string(),
      profile: s
        .toOne(() => profile)
        .fields("profileId")
        .references("id"),
      attachments: s.toMany(() => attachment),
    })
    .map("e2u1_notes");
  const attachment = s
    .model({
      id: s.string().id(),
      name: s.string(),
      noteId: s.string(),
      note: s
        .toOne(() => note)
        .fields("noteId")
        .references("id"),
    })
    .map("e2u1_attachments");
  const label = s
    .model({
      id: s.string().id(),
      name: s.string(),
      profiles: s.toMany(() => profile),
    })
    .map("e2u1_labels");
  return { user, profile, note, attachment, label };
})();

hydrateSchemaNames(inverseDepthSchema);
const getFamily = usePGliteSchemaFamily(inverseDepthSchema);

/** Records every statement, in order — the protected seam, so transaction-bound
 *  statements are seen too. */
class RecordingBatchDriver extends BatchOnlyPGliteDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.execute<T>(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(sql);
    return super.executeRaw<T>(client, sql, params, context);
  }
}

/**
 * Rewrites one column of the FIRST read of the target's table — this part's correlated
 * probe. `mode: "wrong"` substitutes another live row's key (a value that EXISTS, so no
 * constraint can stand in for the assertion); `mode: "drop"` removes it (the locate that
 * forgot to select what a Ref promised).
 */
class CorruptProbePGliteDriver extends PGliteDriver {
  private readonly table: string;
  private readonly column: string;
  private readonly mode: "drop" | "wrong";
  private readonly wrongValue: unknown;
  private armed = true;

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    config: {
      table: string;
      column: string;
      mode: "drop" | "wrong";
      wrongValue?: unknown;
    }
  ) {
    super(options);
    this.table = config.table;
    this.column = config.column;
    this.mode = config.mode;
    this.wrongValue = config.wrongValue;
  }

  private corrupt<T>(sql: string, result: QueryResult<T>): QueryResult<T> {
    const isProbe =
      this.armed &&
      sql.startsWith("SELECT") &&
      sql.includes(this.table) &&
      result.rows.length > 0;
    if (!isProbe) return result;
    // One shot: the FIRST read of the profile table is this part's probe. The batch
    // substrate's later presence guard reads the truth, so the corruption is a property
    // of the located VALUE, not of the whole connection.
    this.armed = false;
    return {
      ...result,
      rows: result.rows.map((row) => {
        const next = { ...(row as Record<string, unknown>) };
        if (this.mode === "drop") delete next[this.column];
        else next[this.column] = this.wrongValue;
        return next as T;
      }),
    };
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.corrupt(
      sql,
      await super.execute<T>(client, sql, params, context)
    );
  }

  protected override async executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.corrupt(
      sql,
      await super.executeRaw<T>(client, sql, params, context)
    );
  }
}

class CorruptProbeBatchDriver extends CorruptProbePGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

/** V1's verbatim not-found abort for this family, spelled in full. */
const PROFILE_NOT_FOUND =
  /Cannot update relation 'profile': target record was not found for this parent\./;
const NOTE_NOT_FOUND =
  /Cannot update relation 'notes': target record was not found for this parent\./;
/** The executor's typed refusal when a declared `firstRowField` output is absent. */
const UNRESOLVED_LOCATED_PK = /did not produce row field 'id'/;

function makeClient(driver: PGliteDriver) {
  return createClient({ schema: inverseDepthSchema, driver });
}

type Client = ReturnType<typeof makeClient>;

/** `owner` holds the profile every payload writes through; `decoy` holds a second
 *  profile with its own note, so a write that resolved "some profile" lands visibly
 *  wrong instead of silently right. */
async function seed(client: Client): Promise<void> {
  await client.user.create({ data: { id: "owner", name: "owner" } });
  await client.user.create({ data: { id: "decoy", name: "decoy" } });
  await client.profile.create({
    data: { id: "p-owner", bio: "before", userId: "owner" },
  });
  await client.profile.create({
    data: { id: "p-decoy", bio: "decoy", userId: "decoy" },
  });
  await client.note.create({
    data: { id: "n-owner", text: "owned", profileId: "p-owner" },
  });
  await client.note.create({
    data: { id: "n-decoy", text: "decoy", profileId: "p-decoy" },
  });
  await client.label.create({ data: { id: "l1", name: "label" } });
}

async function setup(driver: PGliteDriver) {
  const client = makeClient(driver);
  await seed(client);
  return client;
}

async function state(client: Client) {
  return {
    profiles: await client.profile.findMany({ orderBy: { id: "asc" } }),
    notes: await client.note.findMany({ orderBy: { id: "asc" } }),
    attachments: await client.attachment.findMany({ orderBy: { id: "asc" } }),
  };
}

for (const substrate of ["transaction", "atomic batch"] as const) {
  const makeDriver = (family: ReturnType<typeof getFamily>) =>
    substrate === "transaction"
      ? new PGliteDriver({
          client: family.database,
          namespace: family.namespace,
        })
      : new BatchOnlyPGliteDriver({
          client: family.database,
          namespace: family.namespace,
        });

  describe(`E2-U1 inverse-side to-one update with relations (${substrate})`, () => {
    test("folds a deeper create against the located target", async () => {
      const client = await setup(makeDriver(getFamily()));
      await client.user.update({
        where: { id: "owner" },
        data: {
          profile: {
            update: {
              bio: "after",
              notes: { create: { id: "n-fresh", text: "fresh" } },
            },
          },
        },
      });
      await expect(state(client)).resolves.toEqual({
        profiles: [
          { id: "p-decoy", bio: "decoy", userId: "decoy" },
          { id: "p-owner", bio: "after", userId: "owner" },
        ],
        notes: [
          { id: "n-decoy", text: "decoy", profileId: "p-decoy" },
          { id: "n-fresh", text: "fresh", profileId: "p-owner" },
          { id: "n-owner", text: "owned", profileId: "p-owner" },
        ],
        attachments: [],
      });
    }, 30_000);

    test("folds a junction edge one level deeper", async () => {
      const client = await setup(makeDriver(getFamily()));
      await client.user.update({
        where: { id: "owner" },
        data: { profile: { update: { labels: { connect: { id: "l1" } } } } },
      });
      // Membership is the join row, so the claim is read back through the relation.
      await expect(
        client.label.findMany({
          where: { profiles: { some: { id: "p-owner" } } },
        })
      ).resolves.toEqual([{ id: "l1", name: "label" }]);
      await expect(
        client.label.findMany({
          where: { profiles: { some: { id: "p-decoy" } } },
        })
      ).resolves.toEqual([]);
    }, 30_000);

    test("folds a four-level tree (the created note carries its own attachment)", async () => {
      const client = await setup(makeDriver(getFamily()));
      await client.user.update({
        where: { id: "owner" },
        data: {
          profile: {
            update: {
              notes: {
                create: {
                  id: "n-tree",
                  text: "tree",
                  attachments: { create: { id: "a1", name: "a.txt" } },
                },
              },
            },
          },
        },
      });
      await expect(
        client.note.findUnique({ where: { id: "n-tree" } })
      ).resolves.toEqual({
        id: "n-tree",
        text: "tree",
        profileId: "p-owner",
      });
      await expect(
        client.attachment.findMany({ orderBy: { id: "asc" } })
      ).resolves.toEqual([{ id: "a1", name: "a.txt", noteId: "n-tree" }]);
    }, 30_000);

    test("a relation-only payload writes no target row", async () => {
      const family = getFamily();
      const driver = new RecordingBatchDriver({
        client: family.database,
        namespace: family.namespace,
      });
      const client = await setup(driver);
      driver.recording = true;
      await client.user.update({
        where: { id: "owner" },
        data: {
          profile: {
            update: { notes: { create: { id: "n-only", text: "only" } } },
          },
        },
      });
      driver.recording = false;
      // No empty-SET self-UPDATE: the target row is untouched, only its child edge.
      expect(
        driver.statements.filter((sql) => sql.startsWith("UPDATE"))
      ).toEqual([]);
      await expect(
        client.profile.findUnique({ where: { id: "p-owner" } })
      ).resolves.toEqual({ id: "p-owner", bio: "before", userId: "owner" });
      await expect(
        client.note.findUnique({ where: { id: "n-only" } })
      ).resolves.toMatchObject({ profileId: "p-owner" });
    }, 30_000);

    test("a deeper targeted update reaches only this parent's rows", async () => {
      const client = await setup(makeDriver(getFamily()));
      await client.user.update({
        where: { id: "owner" },
        data: {
          profile: {
            update: {
              notes: {
                update: {
                  where: { id: "n-owner" },
                  data: { text: "edited" },
                },
              },
            },
          },
        },
      });
      await expect(
        client.note.findMany({ orderBy: { id: "asc" } })
      ).resolves.toEqual([
        { id: "n-decoy", text: "decoy", profileId: "p-decoy" },
        { id: "n-owner", text: "edited", profileId: "p-owner" },
      ]);
    }, 30_000);

    test("a deeper targeted update naming the DECOY's row aborts", async () => {
      const client = await setup(makeDriver(getFamily()));
      await expect(
        client.user.update({
          where: { id: "owner" },
          data: {
            profile: {
              update: {
                bio: "never",
                notes: {
                  update: {
                    where: { id: "n-decoy" },
                    data: { text: "stolen" },
                  },
                },
              },
            },
          },
        })
      ).rejects.toThrow(NOTE_NOT_FOUND);
      await expect(state(client)).resolves.toEqual({
        profiles: [
          { id: "p-decoy", bio: "decoy", userId: "decoy" },
          { id: "p-owner", bio: "before", userId: "owner" },
        ],
        notes: [
          { id: "n-decoy", text: "decoy", profileId: "p-decoy" },
          { id: "n-owner", text: "owned", profileId: "p-owner" },
        ],
        attachments: [],
      });
    }, 30_000);

    test("a parent with no connected target aborts before any deeper write", async () => {
      const client = await setup(makeDriver(getFamily()));
      await client.user.create({ data: { id: "lonely", name: "lonely" } });
      await expect(
        client.user.update({
          where: { id: "lonely" },
          data: {
            profile: {
              update: { notes: { create: { id: "n-never", text: "never" } } },
            },
          },
        })
      ).rejects.toThrow(PROFILE_NOT_FOUND);
      await expect(
        client.note.findUnique({ where: { id: "n-never" } })
      ).resolves.toBeNull();
    }, 30_000);
  });

  /**
   * PACKAGE G — the same depth, through the UPSERT arm. Until G this whole describe
   * was one refusal (`…upsert for relation 'profile' does not support nested relation
   * writes in its data.`, thrown at construction with an empty statement log). The
   * relation owner still decides found vs missing; what changed is that the FOUND arm
   * is now the ordinary selected record, and the MISSING arm still runs none of it.
   */
  describe(`PACKAGE G inverse-side to-one UPSERT arm with relations (${substrate})`, () => {
    test("the FOUND arm folds a deeper create against the located target", async () => {
      const client = await setup(makeDriver(getFamily()));
      await client.user.update({
        where: { id: "owner" },
        data: {
          profile: {
            upsert: {
              create: { id: "p-unused", bio: "unused" },
              update: {
                bio: "after",
                notes: { create: { id: "n-fresh", text: "fresh" } },
              },
            },
          },
        },
      });
      await expect(state(client)).resolves.toEqual({
        profiles: [
          { id: "p-decoy", bio: "decoy", userId: "decoy" },
          { id: "p-owner", bio: "after", userId: "owner" },
        ],
        notes: [
          { id: "n-decoy", text: "decoy", profileId: "p-decoy" },
          { id: "n-fresh", text: "fresh", profileId: "p-owner" },
          { id: "n-owner", text: "owned", profileId: "p-owner" },
        ],
        attachments: [],
      });
    }, 30_000);

    test("a grandchild edge on the FOUND arm lands under the located note", async () => {
      const client = await setup(makeDriver(getFamily()));
      await client.user.update({
        where: { id: "owner" },
        data: {
          profile: {
            upsert: {
              create: { id: "p-unused", bio: "unused" },
              update: {
                notes: {
                  update: {
                    where: { id: "n-owner" },
                    data: {
                      text: "deep",
                      attachments: { create: { id: "a-deep", name: "deep" } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      await expect(state(client)).resolves.toMatchObject({
        notes: [
          { id: "n-decoy", text: "decoy", profileId: "p-decoy" },
          { id: "n-owner", text: "deep", profileId: "p-owner" },
        ],
        attachments: [{ id: "a-deep", name: "deep", noteId: "n-owner" }],
      });
    }, 30_000);

    /**
     * The missing arm binds and validates NOTHING of the update subtree. The payload
     * carries a to-many `update` whose own probe expects exactly one row; the
     * superset plan still ISSUES that probe (technique #2), correlated to a located
     * profile key that does not exist, so without the untaken-arm relaxation the
     * operation would abort with `Cannot update relation 'notes'…` instead of
     * creating.
     */
    test("the MISSING arm creates and runs none of the update subtree", async () => {
      const client = await setup(makeDriver(getFamily()));
      await client.user.create({ data: { id: "lonely", name: "lonely" } });
      await client.user.update({
        where: { id: "lonely" },
        data: {
          profile: {
            upsert: {
              create: { id: "p-lonely", bio: "created" },
              update: {
                bio: "never",
                notes: {
                  update: { where: { id: "n-owner" }, data: { text: "never" } },
                },
              },
            },
          },
        },
      });
      await expect(state(client)).resolves.toMatchObject({
        profiles: [
          { id: "p-decoy", bio: "decoy", userId: "decoy" },
          { id: "p-lonely", bio: "created", userId: "lonely" },
          { id: "p-owner", bio: "before", userId: "owner" },
        ],
        // `n-owner` belongs to another parent's profile and is untouched: the update
        // subtree never bound.
        notes: [
          { id: "n-decoy", text: "decoy", profileId: "p-decoy" },
          { id: "n-owner", text: "owned", profileId: "p-owner" },
        ],
      });
    }, 30_000);

    test("the missing arm leaves nested updateMany inert and the found arm executes it on both substrates", async () => {
      const client = await setup(makeDriver(getFamily()));
      const nestedSeriesUpdate = {
        notes: {
          updateMany: {
            where: {},
            data: { profile: { connect: { id: "p-decoy" } } },
          },
        },
      };
      await client.user.create({ data: { id: "lonely", name: "lonely" } });
      await expect(
        client.user.update({
          where: { id: "lonely" },
          data: {
            profile: {
              upsert: {
                create: { id: "p-lonely", bio: "created" },
                update: nestedSeriesUpdate,
              },
            },
          },
        })
      ).resolves.toEqual({ id: "lonely", name: "lonely" });
      await expect(
        client.profile.findUnique({ where: { id: "p-lonely" } })
      ).resolves.toMatchObject({ bio: "created" });

      await expect(
        client.user.update({
          where: { id: "owner" },
          data: {
            profile: {
              upsert: {
                create: { id: "p-unused", bio: "unused" },
                update: nestedSeriesUpdate,
              },
            },
          },
        })
      ).resolves.toEqual({ id: "owner", name: "owner" });

      await expect(state(client)).resolves.toEqual({
        profiles: [
          { id: "p-decoy", bio: "decoy", userId: "decoy" },
          { id: "p-lonely", bio: "created", userId: "lonely" },
          { id: "p-owner", bio: "before", userId: "owner" },
        ],
        notes: [
          { id: "n-decoy", text: "decoy", profileId: "p-decoy" },
          { id: "n-owner", text: "owned", profileId: "p-decoy" },
        ],
        attachments: [],
      });
    }, 30_000);

    test("an empty found update writes nothing at all", async () => {
      const family = getFamily();
      const driver = new RecordingBatchDriver({
        client: family.database,
        namespace: family.namespace,
      });
      const client = await setup(driver);
      driver.recording = true;
      await client.user.update({
        where: { id: "owner" },
        data: {
          profile: {
            upsert: { create: { id: "p-unused", bio: "unused" }, update: {} },
          },
        },
      });
      driver.recording = false;
      const profiles = `"${family.namespace}"."e2u1_profiles"`;
      expect(
        driver.statements.filter(
          (sql) =>
            sql.startsWith(`UPDATE ${profiles}`) ||
            sql.startsWith(`INSERT INTO ${profiles}`)
        )
      ).toEqual([]);
      await expect(state(client)).resolves.toMatchObject({
        profiles: [
          { id: "p-decoy", bio: "decoy", userId: "decoy" },
          { id: "p-owner", bio: "before", userId: "owner" },
        ],
      });
    }, 30_000);

    test("a deeper targeted update on the FOUND arm naming the DECOY's row aborts", async () => {
      const client = await setup(makeDriver(getFamily()));
      await expect(
        client.user.update({
          where: { id: "owner" },
          data: {
            profile: {
              upsert: {
                create: { id: "p-unused", bio: "unused" },
                update: {
                  bio: "never",
                  notes: {
                    update: {
                      where: { id: "n-decoy" },
                      data: { text: "stolen" },
                    },
                  },
                },
              },
            },
          },
        })
      ).rejects.toThrow(NOTE_NOT_FOUND);
      await expect(state(client)).resolves.toEqual({
        profiles: [
          { id: "p-decoy", bio: "decoy", userId: "decoy" },
          { id: "p-owner", bio: "before", userId: "owner" },
        ],
        notes: [
          { id: "n-decoy", text: "decoy", profileId: "p-decoy" },
          { id: "n-owner", text: "owned", profileId: "p-owner" },
        ],
        attachments: [],
      });
    }, 30_000);
  });
}

describe("E2-U1 batch ordering: the child Parts compile under the presence guard", () => {
  test("the located-target guard precedes every deeper write in the unit", async () => {
    const family = getFamily();
    const driver = new RecordingBatchDriver({
      client: family.database,
      namespace: family.namespace,
    });
    const client = await setup(driver);
    driver.recording = true;
    await client.user.update({
      where: { id: "owner" },
      data: {
        profile: {
          update: {
            bio: "after",
            notes: { create: { id: "n-guarded", text: "guarded" } },
          },
        },
      },
    });
    driver.recording = false;
    // `RelationWritePart.compileTargeted` pushes the presence guard, then the
    // self-UPDATE, then the child steps — so in ONE atomic unit a guard failure
    // aborts before any grandchild write. There is no arm under which the note
    // lands beside a target that moved: no arm, no orphan.
    const guard = driver.statements.findIndex(
      (sql) =>
        sql.includes("__viborm_assert__") && sql.includes("e2u1_profiles")
    );
    const selfUpdate = driver.statements.findIndex((sql) =>
      sql.startsWith(`UPDATE "${family.namespace}"."e2u1_profiles"`)
    );
    const deeperInsert = driver.statements.findIndex((sql) =>
      sql.startsWith(`INSERT INTO "${family.namespace}"."e2u1_notes"`)
    );
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(selfUpdate).toBeGreaterThan(guard);
    expect(deeperInsert).toBeGreaterThan(guard);
  }, 30_000);
});

describe("E2-U1 provenance: the deeper key comes from the row the probe locked", () => {
  const deepCreate = {
    where: { id: "owner" },
    data: {
      profile: {
        update: {
          bio: "moved",
          notes: { create: { id: "n-prov", text: "prov" } },
        },
      },
    },
  } as const;

  test("the transaction leg follows the PROBE's returned key, not the correlation", async () => {
    const { database: db, namespace } = getFamily();
    const stateClient = makeClient(new PGliteDriver({ client: db, namespace }));
    await seed(stateClient);
    // The probe hands back the DECOY profile's key — a live value, so no constraint can
    // catch it, and one no correlation would ever produce (`p-decoy` carries
    // `userId = 'decoy'`). If the note still landed on `p-owner` the key would be
    // re-derived from the correlation rather than consumed from the located row.
    const client = makeClient(
      new CorruptProbePGliteDriver(
        { client: db, namespace },
        {
          table: "e2u1_profiles",
          column: "id",
          mode: "wrong",
          wrongValue: "p-decoy",
        }
      )
    );
    await client.user.update(deepCreate);
    await expect(
      stateClient.note.findUnique({ where: { id: "n-prov" } })
    ).resolves.toMatchObject({ profileId: "p-decoy" });
    // ONE identity, not two: the self-UPDATE addressed the same corrupted key.
    await expect(
      stateClient.profile.findUnique({ where: { id: "p-decoy" } })
    ).resolves.toMatchObject({ bio: "moved" });
    await expect(
      stateClient.profile.findUnique({ where: { id: "p-owner" } })
    ).resolves.toMatchObject({ bio: "before" });
  }, 30_000);

  test("the atomic batch re-checks the located key against the correlation and aborts", async () => {
    const { database: db, namespace } = getFamily();
    const stateClient = makeClient(new PGliteDriver({ client: db, namespace }));
    await seed(stateClient);
    // Same corruption, other substrate. The presence guard re-asserts
    // `fk = parent AND pk = <located>` on ONE row, so a located key belonging to another
    // parent never reaches a write — stronger than the transaction leg, and for that
    // reason blind to provenance, which is why the claim above is measured there.
    const client = makeClient(
      new CorruptProbeBatchDriver(
        { client: db, namespace },
        {
          table: "e2u1_profiles",
          column: "id",
          mode: "wrong",
          wrongValue: "p-decoy",
        }
      )
    );
    await expect(client.user.update(deepCreate)).rejects.toThrow(
      PROFILE_NOT_FOUND
    );
    await expect(
      stateClient.note.findUnique({ where: { id: "n-prov" } })
    ).resolves.toBeNull();
    await expect(
      stateClient.profile.findMany({ orderBy: { id: "asc" } })
    ).resolves.toEqual([
      { id: "p-decoy", bio: "decoy", userId: "decoy" },
      { id: "p-owner", bio: "before", userId: "owner" },
    ]);
  }, 30_000);

  for (const substrate of ["transaction", "atomic batch"] as const) {
    test(`a probe row without the located key fails closed at planning (${substrate})`, async () => {
      const { database: db, namespace } = getFamily();
      const stateClient = makeClient(
        new PGliteDriver({ client: db, namespace })
      );
      await seed(stateClient);
      // The deeper edges Ref a DECLARED `firstRowField` output of the probe, not a raw
      // row read — which is what makes an absent value a typed planning failure before
      // any write instead of an `undefined` reaching the INSERT as a NULL foreign key.
      const config = {
        table: "e2u1_profiles",
        column: "id",
        mode: "drop" as const,
      };
      const client = makeClient(
        substrate === "transaction"
          ? new CorruptProbePGliteDriver({ client: db, namespace }, config)
          : new CorruptProbeBatchDriver({ client: db, namespace }, config)
      );
      await expect(client.user.update(deepCreate)).rejects.toThrow(
        UNRESOLVED_LOCATED_PK
      );
      await expect(
        stateClient.note.findUnique({ where: { id: "n-prov" } })
      ).resolves.toBeNull();
      await expect(
        stateClient.profile.findUnique({ where: { id: "p-owner" } })
      ).resolves.toMatchObject({ bio: "before" });
    }, 30_000);
  }
});

describe("E2-U1 the carve-outs that stay refused", () => {
  /**
   * PACKAGE G DISCHARGED the first carve-out. This test used to assert the refusal:
   *
   *   UnsupportedOperationError: query-engine-v2 upsert for relation 'profile' does
   *   not support nested relation writes in its data.   (0 statements, both substrates)
   *
   * measured on this exact payload at a8349793. Its replacement is the
   * `PACKAGE G inverse-side to-one UPSERT arm with relations` describe above, which
   * runs on both substrates. What remains here is the second carve-out's two halves.
   */
  test("a primary-key transition with an OCCUPIED old slot is refused by the occupied guard", async () => {
    const family = getFamily();
    const driver = new RecordingBatchDriver({
      client: family.database,
      namespace: family.namespace,
    });
    const client = await setup(driver);
    driver.recording = true;
    // RETARGETED BY PACKAGE D2. This payload used to be refused at CONSTRUCTION by
    // `assertPinnedTransitionIsCompilable`, whose message named the wrong remedy:
    //
    //   query-engine-v2 update for relation 'profile' transitions the target primary
    //   key 'id' while writing a deeper edge whose foreign key does not cascade on
    //   update; it must locate the target by that primary key.
    //
    // Locating by the primary key would NOT have helped — the note foreign key does
    // not cascade, `n-owner` sits in the slot `p-owner` is vacating, and moving the
    // profile strands it whatever the locator says. D2 gives the nested compiler the
    // pre-transition value (from the located row, not from a `where` it does not
    // have), so the relation-level occupied guard answers instead, with the reason
    // that is actually true. The accept half is the next test.
    //
    // The class and the timing moved with the wording: `NestedWriteError` rather than
    // `UnsupportedOperationError`, decided after a planning probe rather than at
    // construction, so the statement log is no longer empty. Nothing is written
    // either way, which is what the two reads below assert.
    await expect(
      client.user.update({
        where: { id: "owner" },
        data: {
          profile: {
            update: {
              id: "p-moved",
              notes: { create: { id: "n-moved", text: "moved" } },
            },
          },
        },
      })
    ).rejects.toThrow(
      "Cannot update relation 'notes' with onUpdate('restrict') while the current relation is occupied."
    );
    driver.recording = false;
    await expect(
      client.profile.findUnique({ where: { id: "p-owner" } })
    ).resolves.toMatchObject({ id: "p-owner" });
    await expect(
      client.note.findUnique({ where: { id: "n-moved" } })
    ).resolves.toBeNull();
  }, 30_000);

  test("D2 LIFT: with the old slot empty, the transition compiles and the deeper create takes the NEW key", async () => {
    const family = getFamily();
    const driver = new RecordingBatchDriver({
      client: family.database,
      namespace: family.namespace,
    });
    const client = await setup(driver);
    // The half the deleted construction-time refusal could never reach: the profile
    // has no notes, so nothing is stranded, and the payload is exactly compilable.
    // The pre-transition value lives only in the located row (an inverse-side to-one
    // target has no `where`), and the fresh note's foreign key is derived from it at
    // COMPILE. The decoy profile and its note must not move.
    await client.note.delete({ where: { id: "n-owner" } });
    driver.recording = true;
    await client.user.update({
      where: { id: "owner" },
      data: {
        profile: {
          update: {
            id: "p-moved",
            notes: { create: { id: "n-moved", text: "moved" } },
          },
        },
      },
    });
    driver.recording = false;
    await expect(state(client)).resolves.toMatchObject({
      profiles: [
        expect.objectContaining({ id: "p-decoy" }),
        expect.objectContaining({ id: "p-moved", userId: "owner" }),
      ],
      notes: [
        { id: "n-decoy", text: "decoy", profileId: "p-decoy" },
        { id: "n-moved", text: "moved", profileId: "p-moved" },
      ],
    });
  }, 30_000);
});
