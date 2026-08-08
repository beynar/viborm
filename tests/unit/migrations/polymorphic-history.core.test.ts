import { s } from "@schema";
import { createClient } from "@src/client/client";
import { hydrateSchemaNames } from "@schema/hydration";
import { validateSchemaOrThrow } from "@schema/validation";
import { diff } from "@src/migrations/differ";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { generate } from "@src/migrations/generate";
import { resolvePolymorphicMemberHistory } from "@src/migrations/generate/polymorphic-history";
import type { MigrationClient } from "@src/migrations/push";
import { serializeModels } from "@src/migrations/serializer";
import { MigrationStorageDriver } from "@src/migrations/storage";
import type {
  DiffOperation,
  PolymorphicMemberHistoryChange,
  PolymorphicSnapshotMember,
  PolymorphicSnapshotStorage,
  SchemaSnapshot,
} from "@src/migrations/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";

const postMember: PolymorphicSnapshotMember = {
  publicType: "post",
  storedType: "content.post.v1",
  targetTable: "post",
  referencedColumn: "id",
};

const videoMember: PolymorphicSnapshotMember = {
  publicType: "video",
  storedType: "content.video.v1",
  targetTable: "video",
  referencedColumn: "id",
};

function storage(
  members: readonly PolymorphicSnapshotMember[],
  overrides: Partial<PolymorphicSnapshotStorage> = {}
): PolymorphicSnapshotStorage {
  return {
    ownerTable: "content",
    relation: "subject",
    typeColumn: "subjectType",
    idColumn: "subjectId",
    members,
    ...overrides,
  };
}

function snapshot(
  polymorphicStorage: readonly PolymorphicSnapshotStorage[]
): SchemaSnapshot {
  return { tables: [], polymorphicStorage };
}

describe("polymorphic migration member history", () => {
  it("keeps member history outside the structural differ", async () => {
    await expect(
      diff(
        snapshot([storage([postMember])]),
        snapshot([storage([postMember, videoMember])])
      )
    ).resolves.toEqual({ operations: [], ambiguousChanges: [] });
  });

  it("treats target additions and public-key renames as safe metadata", async () => {
    const resolver = vi.fn();

    await resolvePolymorphicMemberHistory(
      snapshot([storage([postMember])]),
      snapshot([
        storage(
          [
            { ...postMember, publicType: "article" },
            videoMember,
          ],
          { relation: "attachment" }
        ),
      ]),
      [],
      resolver
    );

    expect(resolver).not.toHaveBeenCalled();
  });

  it("refuses a stored discriminator change unless it is acknowledged", async () => {
    const desired = {
      ...postMember,
      storedType: "content.post.v2",
    };
    const changes: PolymorphicMemberHistoryChange[] = [];

    await expect(
      resolvePolymorphicMemberHistory(
        snapshot([storage([postMember])]),
        snapshot([storage([desired])]),
        [],
        (change) => {
          changes.push(change);
          return change.reject();
        }
      )
    ).rejects.toThrow("explicit data-migration acknowledgement");

    await expect(
      resolvePolymorphicMemberHistory(
        snapshot([storage([postMember])]),
        snapshot([storage([desired])]),
        [],
        () => "acknowledged"
      )
    ).rejects.toThrow("explicit data-migration acknowledgement");

    expect(changes).toMatchObject([
      {
        kind: "storedValueChanged",
        ownerTable: "content",
        relation: "subject",
        typeColumn: "subjectType",
        from: postMember,
        to: desired,
      },
    ]);

    await expect(
      resolvePolymorphicMemberHistory(
        snapshot([storage([postMember])]),
        snapshot([storage([desired])]),
        [],
        (change) => change.acknowledgeMigrated()
      )
    ).resolves.toBe(true);
  });

  it("reports removals and both forms of target retargeting", async () => {
    const cases: Array<{
      desired: readonly PolymorphicSnapshotMember[];
      kind: PolymorphicMemberHistoryChange["kind"];
    }> = [
      { desired: [], kind: "memberRemoved" },
      {
        desired: [{ ...postMember, targetTable: "article" }],
        kind: "memberRetargeted",
      },
      {
        desired: [{ ...postMember, referencedColumn: "externalId" }],
        kind: "memberRetargeted",
      },
    ];

    for (const historyCase of cases) {
      const changes: PolymorphicMemberHistoryChange[] = [];
      await resolvePolymorphicMemberHistory(
        snapshot([storage([postMember])]),
        snapshot([storage(historyCase.desired)]),
        [],
        (change) => {
          changes.push(change);
          return change.acknowledgeMigrated();
        }
      );
      expect(changes.map((change) => change.kind)).toEqual([
        historyCase.kind,
      ]);
    }
  });

  it("pairs descriptors and target members after accepted physical renames", async () => {
    const operations: DiffOperation[] = [
      { type: "renameTable", from: "content", to: "asset" },
      {
        type: "renameColumn",
        tableName: "asset",
        from: "subjectType",
        to: "attachmentType",
      },
      {
        type: "renameColumn",
        tableName: "asset",
        from: "subjectId",
        to: "attachmentId",
      },
      { type: "renameTable", from: "post", to: "article" },
      {
        type: "renameColumn",
        tableName: "article",
        from: "id",
        to: "externalId",
      },
    ];
    const resolver = vi.fn();

    await resolvePolymorphicMemberHistory(
      snapshot([storage([postMember])]),
      snapshot([
        storage(
          [
            {
              ...postMember,
              targetTable: "article",
              referencedColumn: "externalId",
            },
          ],
          {
            ownerTable: "asset",
            relation: "attachment",
            typeColumn: "attachmentType",
            idColumn: "attachmentId",
          }
        ),
      ]),
      operations,
      resolver
    );

    expect(resolver).not.toHaveBeenCalled();
  });

  it("matches stored identities globally before public identities", async () => {
    const changes: PolymorphicMemberHistoryChange[] = [];
    const previousSecond = {
      ...videoMember,
      publicType: "legacyVideo",
    };

    await resolvePolymorphicMemberHistory(
      snapshot([storage([postMember, previousSecond])]),
      snapshot([
        storage([{ ...videoMember, publicType: "post" }]),
      ]),
      [],
      (change) => {
        changes.push(change);
        return change.acknowledgeMigrated();
      }
    );

    expect(changes.map((change) => change.kind)).toEqual(["memberRemoved"]);
    expect(changes[0]?.from).toEqual(postMember);
  });

  it("ignores descriptor and member array order when detecting metadata changes", async () => {
    await expect(
      resolvePolymorphicMemberHistory(
        snapshot([
          storage([postMember, videoMember]),
          storage([videoMember], {
            relation: "attachment",
            typeColumn: "attachmentType",
            idColumn: "attachmentId",
          }),
        ]),
        snapshot([
          storage([videoMember], {
            relation: "attachment",
            typeColumn: "attachmentType",
            idColumn: "attachmentId",
          }),
          storage([videoMember, postMember]),
        ]),
        [],
        undefined
      )
    ).resolves.toBe(false);
  });
});

class MemoryStorage extends MigrationStorageDriver {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];

  constructor() {
    super("memory");
  }

  get(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  put(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this.writes.push(path);
    return Promise.resolve();
  }

  delete(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
}

const metadataDrivers: ReturnType<typeof createInMemorySQLite3Driver>[] = [];

function metadataOnlyFixture(): {
  client: MigrationClient;
  current: SchemaSnapshot;
} {
  const post = s.model({ id: s.string().id() });
  const video = s.model({ id: s.string().id() });
  const content = s.model({
    id: s.string().id(),
    subject: s
      .polymorphic(
        { post: () => post, video: () => video },
        {
          values: {
            post: "content.post.v1",
            video: "content.video.v1",
          },
        }
      )
      .optional(),
  });
  const schema = { post, video, content };
  hydrateSchemaNames(schema);
  validateSchemaOrThrow(schema);
  const driver = createInMemorySQLite3Driver();
  metadataDrivers.push(driver);

  return {
    client: createClient({
      schema,
      driver,
    }),
    current: serializeModels(schema, {
      migrationDriver: sqlite3MigrationDriver,
    }),
  };
}

afterEach(async () => {
  for (const driver of metadataDrivers.splice(0)) {
    await driver.disconnect();
  }
});

describe("generate polymorphic metadata-only snapshots", () => {
  it("is a no-op when the stored snapshot already has current metadata", async () => {
    const { client, current } = metadataOnlyFixture();
    const storageDriver = new MemoryStorage();
    await storageDriver.writeSnapshot(current);
    storageDriver.writes.length = 0;

    const result = await generate(client, { storageDriver });

    expect(result).toMatchObject({
      entry: null,
      operations: [],
      sql: [],
      written: false,
      message: "No schema changes detected.",
    });
    expect(storageDriver.writes).toEqual([]);
  });

  it("updates only the snapshot for a safe target addition", async () => {
    const { client, current } = metadataOnlyFixture();
    const storageDriver = new MemoryStorage();
    const currentStorage = current.polymorphicStorage?.[0];
    expect(currentStorage).toBeDefined();
    await storageDriver.writeSnapshot({
      ...current,
      polymorphicStorage: [
        {
          ...currentStorage!,
          members: currentStorage!.members.slice(0, 1),
        },
      ],
    });
    storageDriver.writes.length = 0;

    const result = await generate(client, { storageDriver });

    expect(result).toMatchObject({
      entry: null,
      operations: [],
      sql: [],
      written: true,
      message: "Updated polymorphic migration metadata snapshot.",
    });
    expect(storageDriver.writes).toEqual(["meta/_snapshot.json"]);
    expect(await storageDriver.readJournal()).toBeNull();
    expect(await storageDriver.readSnapshot()).toEqual(current);
  });

  it("reports a dry-run metadata update without writing", async () => {
    const { client, current } = metadataOnlyFixture();
    const storageDriver = new MemoryStorage();
    const currentStorage = current.polymorphicStorage?.[0];
    await storageDriver.writeSnapshot({
      ...current,
      polymorphicStorage: [
        {
          ...currentStorage!,
          members: currentStorage!.members.slice(0, 1),
        },
      ],
    });
    storageDriver.writes.length = 0;

    const result = await generate(client, {
      storageDriver,
      dryRun: true,
    });

    expect(result).toMatchObject({
      entry: null,
      operations: [],
      written: false,
      message: "Would update polymorphic migration metadata snapshot.",
    });
    expect(storageDriver.writes).toEqual([]);
  });

  it("refuses unsafe history before any storage write, then advances after acknowledgement", async () => {
    const { client, current } = metadataOnlyFixture();
    const storageDriver = new MemoryStorage();
    const currentStorage = current.polymorphicStorage?.[0];
    const firstMember = currentStorage?.members[0];
    expect(firstMember).toBeDefined();
    await storageDriver.writeSnapshot({
      ...current,
      polymorphicStorage: [
        {
          ...currentStorage!,
          members: [
            { ...firstMember!, storedType: "content.post.legacy" },
            ...currentStorage!.members.slice(1),
          ],
        },
      ],
    });
    storageDriver.writes.length = 0;

    await expect(generate(client, { storageDriver })).rejects.toThrow(
      "explicit data-migration acknowledgement"
    );
    expect(storageDriver.writes).toEqual([]);

    const result = await generate(client, {
      storageDriver,
      polymorphicMemberResolver: (change) =>
        change.acknowledgeMigrated(),
    });
    expect(result.entry).toBeNull();
    expect(result.operations).toEqual([]);
    expect(storageDriver.writes).toEqual(["meta/_snapshot.json"]);
    expect(await storageDriver.readSnapshot()).toEqual(current);
  });
});
