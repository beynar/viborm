import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { validateSchema, validateSchemaOrThrow } from "@schema/validation";
import { createClient } from "@src/client/client";
import { MigrationError } from "@src/errors";
import { diff } from "@src/migrations/differ";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { generate } from "@src/migrations/generate";
import { parseStatements } from "@src/migrations/generate/file-writer";
import {
  pairPolymorphicMemberRenames,
  resolvePolymorphicMemberHistory,
} from "@src/migrations/generate/polymorphic-history";
import type { MigrationClient } from "@src/migrations/push";
import {
  resolveAmbiguousChanges,
  strictResolver,
} from "@src/migrations/resolver";
import { serializeModels } from "@src/migrations/serializer";
import {
  createEmptyJournal,
  formatMigrationFilename,
  MigrationStorageDriver,
} from "@src/migrations/storage";
import type {
  DiffOperation,
  GenerateOptions,
  MigrationTarget,
  PolymorphicSnapshotStorage,
  PolymorphicToManySnapshot,
  PolymorphicToManySnapshotMember,
  PolymorphicToOneSnapshot,
  PolymorphicToOneSnapshotMember,
  SchemaSnapshot,
  TableDef,
} from "@src/migrations/types";
import type { AnyModel } from "@src/schema/model";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const REFUSAL = /data-bearing polymorphic transition/;
const MEMBERSHIP_ROWS = /may hold membership rows/;
const OWNER_ROWS_REMOVAL = /was removed while owner rows/;
const POST_TO_ARTICLE_RETARGET = /changed its target from "post" to "article"/;
const TO_ONE_BECOMES_TO_MANY =
  /changed cardinality from s\.toOne\(\.\.\.\) to s\.toMany\(\.\.\.\)/;
const TO_MANY_BECOMES_TO_ONE =
  /changed cardinality from s\.toMany\(\.\.\.\) to s\.toOne\(\.\.\.\)/;
const UNRECOGNIZED_RENAME = /without a recognized rename/;
const POST_MEMBER_REMOVED = /"content\.subject\.post" was removed/;
const JUNCTION_TABLE_MISSING =
  /member junction table "content_subject_post" .* is missing/;
const TWO_LOGICAL_OWNERS = /two logical owners/;
const NO_REGISTRY_ENTRY = /resolves no relationStorage registry entry/;
const PHYSICAL_PARTS_MISSING = /names physical parts that are missing/;
const ORPHANED_REGISTRY = /no owning polymorphic metadata entry/;
const STALE_FORMAT = /predates the storage-kind snapshot format/;

const postMember: PolymorphicToOneSnapshotMember = {
  publicType: "post",
  storedType: "content.post.v1",
  targetTable: "post",
};

const videoMember: PolymorphicToOneSnapshotMember = {
  publicType: "video",
  storedType: "content.video.v1",
  targetTable: "video",
};

const postCollectionMember: PolymorphicToManySnapshotMember = {
  publicType: "post",
  storedType: "content.post.v1",
  targetTable: "post",
  memberJunctionTable: "content_subject_post",
  inverseCardinality: "many",
};

function toOneStorage(
  members: readonly PolymorphicToOneSnapshotMember[],
  overrides: Partial<Omit<PolymorphicToOneSnapshot, "kind" | "members">> = {}
): PolymorphicToOneSnapshot {
  return {
    ownerTable: "content",
    relation: "subject",
    kind: "toOne",
    storageRef: "subjectType",
    members,
    ...overrides,
  };
}

function toManyStorage(
  members: readonly PolymorphicToManySnapshotMember[],
  overrides: Partial<Omit<PolymorphicToManySnapshot, "kind" | "members">> = {}
): PolymorphicToManySnapshot {
  return {
    ownerTable: "content",
    relation: "subject",
    kind: "toMany",
    members,
    ...overrides,
  };
}

/**
 * Build a COHERENT snapshot around the metadata: toOne entries get their owner
 * table's physical columns, index and registry entry; toMany entries get one
 * TableDef per member junction table.
 */
function snapshot(
  storages: readonly PolymorphicSnapshotStorage[]
): SchemaSnapshot {
  const tables = new Map<string, TableDef>();
  const ensureTable = (name: string): TableDef => {
    const existing = tables.get(name);
    if (existing) return existing;
    const created: TableDef = {
      name,
      columns: [{ name: "id", type: "text", nullable: false }],
      indexes: [],
      foreignKeys: [],
      uniqueConstraints: [],
    };
    tables.set(name, created);
    return created;
  };
  for (const storage of storages) {
    const owner = ensureTable(storage.ownerTable);
    if (storage.kind === "toOne") {
      const idColumn = `${storage.storageRef}_id`;
      const index = `${storage.ownerTable}_${storage.relation}_poly_idx`;
      owner.columns.push(
        { name: storage.storageRef, type: "text", nullable: false },
        { name: idColumn, type: "text", nullable: false }
      );
      owner.indexes.push({
        name: index,
        columns: [storage.storageRef, idColumn],
        unique: false,
      });
      owner.relationStorage = {
        ...owner.relationStorage,
        [storage.storageRef]: {
          kind: "polymorphicToOne",
          typeColumn: storage.storageRef,
          idColumn,
          index,
        },
      };
    } else {
      for (const member of storage.members) {
        ensureTable(member.memberJunctionTable);
      }
    }
  }
  return { tables: [...tables.values()], polymorphicStorage: storages };
}

describe("polymorphic migration member history", () => {
  it("keeps member history outside the structural differ", async () => {
    await expect(
      diff(
        snapshot([toOneStorage([postMember])]),
        snapshot([toOneStorage([postMember, videoMember])])
      )
    ).resolves.toEqual({ operations: [], ambiguousChanges: [] });
  });

  it("emits zero operations for a registry-annotation-only change", async () => {
    const before = snapshot([toOneStorage([postMember])]);
    const after = snapshot([toOneStorage([postMember])]);
    const owner = after.tables.find((table) => table.name === "content");
    expect(owner?.relationStorage).toBeDefined();
    owner!.relationStorage = {
      subjectType: {
        kind: "polymorphicToOne",
        // Swapped annotation content: a registry-only difference must stay
        // invisible to the structural differ.
        typeColumn: "subjectType_id",
        idColumn: "subjectType",
        index: "content_subject_poly_idx",
      },
    };

    await expect(diff(before, after)).resolves.toEqual({
      operations: [],
      ambiguousChanges: [],
    });
  });

  it("treats target additions and public-key renames as safe metadata", () => {
    expect(
      resolvePolymorphicMemberHistory(
        snapshot([toOneStorage([postMember])]),
        snapshot([
          toOneStorage(
            [{ ...postMember, publicType: "article" }, videoMember],
            {
              relation: "attachment",
            }
          ),
        ]),
        []
      )
    ).toBe(true);
  });

  it("refuses a stored discriminator change outright", () => {
    const desired = { ...postMember, storedType: "content.post.v2" };

    expect(() =>
      resolvePolymorphicMemberHistory(
        snapshot([toOneStorage([postMember])]),
        snapshot([toOneStorage([desired])]),
        []
      )
    ).toThrow(REFUSAL);

    try {
      resolvePolymorphicMemberHistory(
        snapshot([toOneStorage([postMember])]),
        snapshot([toOneStorage([desired])]),
        []
      );
      expect.unreachable("stored discriminator change must refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationError);
      if (error instanceof MigrationError) {
        expect(error.code).toBe("V11010");
        expect(error.message).toContain('"content.subject.post"');
        expect(error.message).toContain("stored discriminator");
        // The message names the ONE seam that lifts the refusal, and both
        // halves it requires: the ordered up artifact and an honest policy.
        expect(error.message).toContain("GenerateOptions.manualMigration");
        expect(error.message).toContain("up");
        expect(error.message).toContain('{ kind: "manual", sql }');
        expect(error.message).toContain('{ kind: "irreversible", reason }');
      }
    }
  });

  it("refuses removals and retargets of toOne members", () => {
    const cases: ReadonlyArray<{
      desired: readonly PolymorphicToOneSnapshotMember[];
      message: RegExp;
    }> = [
      { desired: [], message: OWNER_ROWS_REMOVAL },
      {
        desired: [{ ...postMember, targetTable: "article" }],
        message: POST_TO_ARTICLE_RETARGET,
      },
    ];

    for (const historyCase of cases) {
      expect(() =>
        resolvePolymorphicMemberHistory(
          snapshot([toOneStorage([postMember])]),
          snapshot([toOneStorage(historyCase.desired)]),
          []
        )
      ).toThrow(historyCase.message);
    }
  });

  it("pairs descriptors and target members after accepted physical renames", () => {
    const operations: DiffOperation[] = [
      { type: "renameTable", from: "content", to: "asset" },
      {
        type: "renameColumn",
        tableName: "asset",
        from: "subjectType",
        to: "attachmentType",
      },
      { type: "renameTable", from: "post", to: "article" },
    ];

    expect(
      resolvePolymorphicMemberHistory(
        snapshot([toOneStorage([postMember])]),
        snapshot([
          toOneStorage([{ ...postMember, targetTable: "article" }], {
            ownerTable: "asset",
            relation: "attachment",
            storageRef: "attachmentType",
          }),
        ]),
        operations
      )
    ).toBe(true);
  });

  it("matches stored identities globally before public identities", () => {
    const previousSecond = { ...videoMember, publicType: "legacyVideo" };

    expect(() =>
      resolvePolymorphicMemberHistory(
        snapshot([toOneStorage([postMember, previousSecond])]),
        snapshot([toOneStorage([{ ...videoMember, publicType: "post" }])]),
        []
      )
    ).toThrow(POST_MEMBER_REMOVED);
  });

  it("ignores descriptor and member array order when detecting metadata changes", () => {
    expect(
      resolvePolymorphicMemberHistory(
        snapshot([
          toOneStorage([postMember, videoMember]),
          toOneStorage([videoMember], {
            relation: "attachment",
            storageRef: "attachmentType",
          }),
        ]),
        snapshot([
          toOneStorage([videoMember], {
            relation: "attachment",
            storageRef: "attachmentType",
          }),
          toOneStorage([videoMember, postMember]),
        ]),
        []
      )
    ).toBe(false);
  });
});

describe("polymorphic history kind dispatch", () => {
  it("refuses a direct cardinality change in both directions", () => {
    const asToOne = snapshot([toOneStorage([postMember])]);
    const asToMany = snapshot([toManyStorage([postCollectionMember])]);

    expect(() =>
      resolvePolymorphicMemberHistory(asToOne, asToMany, [])
    ).toThrow(TO_ONE_BECOMES_TO_MANY);
    expect(() =>
      resolvePolymorphicMemberHistory(asToMany, asToOne, [])
    ).toThrow(TO_MANY_BECOMES_TO_ONE);
    expect(() =>
      resolvePolymorphicMemberHistory(asToMany, asToOne, [])
    ).toThrow(REFUSAL);
  });

  it("dispatches a stored-value change by kind: toOne refuses, toMany is metadata-only", () => {
    // The SAME shape of change — one member's stored discriminator moves from
    // v1 to v2 — is data-bearing for a toOne slot (owner rows hold the value)
    // and pure metadata for a toMany collection (no row stores it).
    expect(() =>
      resolvePolymorphicMemberHistory(
        snapshot([toOneStorage([postMember])]),
        snapshot([
          toOneStorage([{ ...postMember, storedType: "content.post.v2" }]),
        ]),
        []
      )
    ).toThrow(REFUSAL);

    expect(
      resolvePolymorphicMemberHistory(
        snapshot([toManyStorage([postCollectionMember])]),
        snapshot([
          toManyStorage([
            { ...postCollectionMember, storedType: "content.post.v2" },
          ]),
        ]),
        []
      )
    ).toBe(true);
  });

  it("never silently ignores an unmatched previous storage", () => {
    // A removed toMany relation is data-bearing per member: its junction
    // tables may hold membership rows, and offline generation cannot prove
    // them empty — uniformly, including a member added and removed unused.
    expect(() =>
      resolvePolymorphicMemberHistory(
        snapshot([toManyStorage([postCollectionMember])]),
        snapshot([]),
        []
      )
    ).toThrow(MEMBERSHIP_ROWS);

    // A removed toOne relation is the structural differ's ordinary
    // destructive business (its columns drop); the metadata entry disappears.
    expect(
      resolvePolymorphicMemberHistory(
        snapshot([toOneStorage([postMember])]),
        snapshot([]),
        []
      )
    ).toBe(true);
  });

  it("classifies a renamed collection relation with intact junctions as metadata-only", () => {
    expect(
      resolvePolymorphicMemberHistory(
        snapshot([toManyStorage([postCollectionMember])]),
        snapshot([
          toManyStorage([postCollectionMember], { relation: "items" }),
        ]),
        []
      )
    ).toBe(true);
  });

  it("treats a collection inverse-cardinality change as exactly structural", () => {
    expect(
      resolvePolymorphicMemberHistory(
        snapshot([toManyStorage([postCollectionMember])]),
        snapshot([
          toManyStorage([
            { ...postCollectionMember, inverseCardinality: "one" },
          ]),
        ]),
        []
      )
    ).toBe(true);
  });

  it("refuses collection retargets, junction moves and member removals", () => {
    const base = snapshot([toManyStorage([postCollectionMember])]);

    expect(() =>
      resolvePolymorphicMemberHistory(
        base,
        snapshot([
          toManyStorage([{ ...postCollectionMember, targetTable: "article" }]),
        ]),
        []
      )
    ).toThrow(POST_TO_ARTICLE_RETARGET);

    expect(() =>
      resolvePolymorphicMemberHistory(
        base,
        snapshot([
          toManyStorage([
            {
              ...postCollectionMember,
              memberJunctionTable: "content_subject_article",
            },
          ]),
        ]),
        []
      )
    ).toThrow(UNRECOGNIZED_RENAME);

    expect(() =>
      resolvePolymorphicMemberHistory(base, snapshot([toManyStorage([])]), [])
    ).toThrow(MEMBERSHIP_ROWS);
  });
});

/** Hydrate, demand a CLEAN validation, serialize. */
function serializedCollectionSnapshot(
  schema: Record<string, AnyModel>
): SchemaSnapshot {
  hydrateSchemaNames(schema);
  const errorCodes = validateSchema(schema).errors.map((entry) => entry.code);
  // Since B3 deleted P014 a well-formed collection schema is simply valid, so
  // this gate demands SILENCE rather than tolerating a known refusal. It is
  // load-bearing: every history pin below reasons about a snapshot the
  // serializer produced, and a schema that failed validation stores no
  // descriptor and would serialize to a snapshot with no member tables at all
  // — the pins would then measure nothing while still passing.
  if (errorCodes.length > 0) {
    throw new Error(
      `collection fixture must validate clean, got: ${errorCodes.join(",")}`
    );
  }
  return serializeModels(schema, { migrationDriver: sqlite3MigrationDriver });
}

async function memberRenamePipeline(
  previous: SchemaSnapshot,
  desired: SchemaSnapshot
): Promise<DiffOperation[]> {
  const diffResult = await diff(previous, desired);
  // The Jaccard heuristic can never offer a default-named member rename
  // (target-side columns are variant-derived), so nothing is ambiguous here —
  // and strictResolver below throws if that ever stops holding.
  const resolved = await resolveAmbiguousChanges(
    diffResult,
    previous,
    desired,
    strictResolver
  );
  return pairPolymorphicMemberRenames(previous, desired, resolved);
}

describe("polymorphic member-junction rename pairing", () => {
  it("rewrites an explicit-values variant rename into renameTable+renameColumn with zero data movement", async () => {
    const before = serializedCollectionSnapshot(
      (() => {
        const post = s.model({ id: s.string().id() });
        const owner = s.model({
          id: s.string().id(),
          items: s.toMany(
            { post: () => post },
            { values: { post: "items.member.v1" } }
          ),
        });
        return { post, owner };
      })()
    );
    const after = serializedCollectionSnapshot(
      (() => {
        const post = s.model({ id: s.string().id() });
        const owner = s.model({
          id: s.string().id(),
          items: s.toMany(
            { story: () => post },
            { values: { story: "items.member.v1" } }
          ),
        });
        return { post, owner };
      })()
    );

    const finalOperations = await memberRenamePipeline(before, after);

    // One renameTable plus the topology-derived target-side renameColumn —
    // the drop+create pair is gone, and with it every membership row loss.
    expect(finalOperations).toEqual([
      {
        type: "renameTable",
        from: "owner_items_post",
        to: "owner_items_story",
      },
      {
        type: "renameColumn",
        tableName: "owner_items_story",
        from: "postId",
        to: "storyId",
      },
    ]);
    // Rename normalization runs before member comparison: the junction
    // identity carries over and history is metadata-only.
    expect(
      resolvePolymorphicMemberHistory(before, after, finalOperations)
    ).toBe(true);
  });

  it("treats a variant rename under an explicit .through() as pure metadata", async () => {
    const before = serializedCollectionSnapshot(
      (() => {
        const post = s.model({ id: s.string().id() });
        const owner = s.model({
          id: s.string().id(),
          items: s
            .toMany(
              { post: () => post },
              { values: { post: "items.member.v1" } }
            )
            .through({
              post: {
                table: "owner_items_links",
                source: "ownerRef",
                target: "memberRef",
              },
            }),
        });
        return { post, owner };
      })()
    );
    const after = serializedCollectionSnapshot(
      (() => {
        const post = s.model({ id: s.string().id() });
        const owner = s.model({
          id: s.string().id(),
          items: s
            .toMany(
              { story: () => post },
              { values: { story: "items.member.v1" } }
            )
            .through({
              story: {
                table: "owner_items_links",
                source: "ownerRef",
                target: "memberRef",
              },
            }),
        });
        return { post, owner };
      })()
    );

    const finalOperations = await memberRenamePipeline(before, after);

    // The pinned junction names never move, so there is no DDL at all — the
    // rename is a metadata-only snapshot advance.
    expect(finalOperations).toEqual([]);
    expect(
      resolvePolymorphicMemberHistory(before, after, finalOperations)
    ).toBe(true);
  });

  it("degrades an omitted-values variant rename to removal+addition and refuses", async () => {
    // With OMITTED values the stored discriminator derives from the public
    // type, so renaming the variant changes the stored value too — history
    // cannot prove same-member and the change is NOT a rename. This is the
    // §5.5 semantics witness for why the rename falsifiers use explicit
    // values.
    const before = serializedCollectionSnapshot(
      (() => {
        const post = s.model({ id: s.string().id() });
        const owner = s.model({
          id: s.string().id(),
          items: s.toMany({ post: () => post }),
        });
        return { post, owner };
      })()
    );
    const after = serializedCollectionSnapshot(
      (() => {
        const post = s.model({ id: s.string().id() });
        const owner = s.model({
          id: s.string().id(),
          items: s.toMany({ story: () => post }),
        });
        return { post, owner };
      })()
    );

    const finalOperations = await memberRenamePipeline(before, after);

    // The seam pairs on the stable stored value; with the value changed the
    // drop+create stays…
    expect(finalOperations.map((operation) => operation.type).sort()).toEqual([
      "createTable",
      "dropTable",
    ]);
    // …and member history classifies removal+addition, which refuses.
    expect(() =>
      resolvePolymorphicMemberHistory(before, after, finalOperations)
    ).toThrow(MEMBERSHIP_ROWS);
  });

  it("leaves a non-isomorphic junction move alone so history refuses it", async () => {
    const before = serializedCollectionSnapshot(
      (() => {
        const post = s.model({ id: s.string().id() });
        const owner = s.model({
          id: s.string().id(),
          items: s.toMany(
            { post: () => post },
            { values: { post: "items.member.v1" } }
          ),
        });
        return { post, owner };
      })()
    );
    // The variant renames AND its inverse cardinality flips to singular: the
    // desired member table carries a unique target side the previous one does
    // not, so the two shapes are not rename-isomorphic.
    const after = serializedCollectionSnapshot(
      (() => {
        const post = s.model({
          id: s.string().id(),
          itemsOwner: s.toOne(() => owner),
        });
        const owner = s.model({
          id: s.string().id(),
          items: s.toMany(
            { story: () => post },
            { values: { story: "items.member.v1" } }
          ),
        });
        return { post, owner };
      })()
    );

    const finalOperations = await memberRenamePipeline(before, after);

    expect(finalOperations.map((operation) => operation.type).sort()).toEqual([
      "createTable",
      "dropTable",
    ]);
    expect(() =>
      resolvePolymorphicMemberHistory(before, after, finalOperations)
    ).toThrow(UNRECOGNIZED_RENAME);
  });
});

describe("polymorphic snapshot coherence", () => {
  it("refuses a toMany member whose junction table is missing", () => {
    const broken = snapshot([toManyStorage([postCollectionMember])]);
    broken.tables = broken.tables.filter(
      (table) => table.name !== "content_subject_post"
    );

    expect(() =>
      resolvePolymorphicMemberHistory(broken, snapshot([]), [])
    ).toThrow(JUNCTION_TABLE_MISSING);
  });

  it("refuses one junction table with two logical owners", () => {
    const broken = snapshot([
      toManyStorage([postCollectionMember]),
      toManyStorage(
        [{ ...postCollectionMember, storedType: "attachments.post.v1" }],
        { relation: "attachments" }
      ),
    ]);

    expect(() =>
      resolvePolymorphicMemberHistory(broken, snapshot([]), [])
    ).toThrow(TWO_LOGICAL_OWNERS);
  });

  it("refuses a toOne entry that resolves no registry entry", () => {
    const broken = snapshot([toOneStorage([postMember])]);
    const owner = broken.tables.find((table) => table.name === "content");
    owner!.relationStorage = undefined;

    expect(() =>
      resolvePolymorphicMemberHistory(broken, snapshot([]), [])
    ).toThrow(NO_REGISTRY_ENTRY);
  });

  it("refuses a registry entry whose physical parts are missing", () => {
    const broken = snapshot([toOneStorage([postMember])]);
    const owner = broken.tables.find((table) => table.name === "content");
    owner!.relationStorage = {
      subjectType: {
        kind: "polymorphicToOne",
        typeColumn: "missing_column",
        idColumn: "subjectType_id",
        index: "content_subject_poly_idx",
      },
    };

    expect(() =>
      resolvePolymorphicMemberHistory(broken, snapshot([]), [])
    ).toThrow(PHYSICAL_PARTS_MISSING);
  });

  it("refuses an orphaned registry entry with no metadata owner", () => {
    const broken = snapshot([]);
    broken.tables.push({
      name: "content",
      columns: [
        { name: "id", type: "text", nullable: false },
        { name: "subjectType", type: "text", nullable: false },
        { name: "subjectType_id", type: "text", nullable: false },
      ],
      indexes: [
        {
          name: "content_subject_poly_idx",
          columns: ["subjectType", "subjectType_id"],
          unique: false,
        },
      ],
      foreignKeys: [],
      uniqueConstraints: [],
      relationStorage: {
        subjectType: {
          kind: "polymorphicToOne",
          typeColumn: "subjectType",
          idColumn: "subjectType_id",
          index: "content_subject_poly_idx",
        },
      },
    });

    expect(() =>
      resolvePolymorphicMemberHistory(broken, snapshot([]), [])
    ).toThrow(ORPHANED_REGISTRY);
  });

  it("refuses a pre-B3 snapshot format instead of reading it", () => {
    // The old flat toOne shape (typeColumn/idColumn, no kind) exists only as
    // out-of-type JSON on disk, so it enters through the parse boundary.
    const stale: SchemaSnapshot = JSON.parse(
      JSON.stringify({
        tables: [],
        polymorphicStorage: [
          {
            ownerTable: "content",
            relation: "subject",
            typeColumn: "subjectType",
            idColumn: "subjectId",
            members: [],
          },
        ],
      })
    );

    expect(() =>
      resolvePolymorphicMemberHistory(stale, snapshot([]), [])
    ).toThrow(STALE_FORMAT);
    // Both snapshot positions refuse: the desired side runs the same guard.
    expect(() =>
      resolvePolymorphicMemberHistory(snapshot([]), stale, [])
    ).toThrow(STALE_FORMAT);
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

/** The estate these SQLite fixtures describe: empty history, stored snapshot. */
const SQLITE_ESTATE: MigrationTarget = { dialect: "sqlite" };

/**
 * Writes a stored snapshot together with the journal that proves its estate.
 *
 * A snapshot with no journal is refused by the journal/snapshot state table:
 * nothing names the estate it describes.
 */
async function seedEstate(
  storageDriver: MemoryStorage,
  snapshot: SchemaSnapshot
): Promise<void> {
  await storageDriver.writeJournal(createEmptyJournal(SQLITE_ESTATE));
  await storageDriver.writeSnapshot(snapshot);
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
      .toOne(
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

function currentToOneStorage(
  current: SchemaSnapshot
): PolymorphicToOneSnapshot {
  const storage = current.polymorphicStorage?.[0];
  if (storage?.kind !== "toOne") {
    throw new Error("fixture must serialize a toOne storage");
  }
  return storage;
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
    await seedEstate(storageDriver, current);
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
    const currentStorage = currentToOneStorage(current);
    await seedEstate(storageDriver, {
      ...current,
      polymorphicStorage: [
        {
          ...currentStorage,
          members: currentStorage.members.slice(0, 1),
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
    expect(storageDriver.writes).toEqual([
      "meta/_journal.json",
      "meta/_snapshot.json",
    ]);
    expect((await storageDriver.readJournal())?.entries).toEqual([]);
    expect(await storageDriver.readSnapshot()).toEqual(current);
  });

  it("reports a dry-run metadata update without writing", async () => {
    const { client, current } = metadataOnlyFixture();
    const storageDriver = new MemoryStorage();
    const currentStorage = currentToOneStorage(current);
    await seedEstate(storageDriver, {
      ...current,
      polymorphicStorage: [
        {
          ...currentStorage,
          members: currentStorage.members.slice(0, 1),
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

  it("refuses unsafe history before any storage write, dry-run included", async () => {
    const { client, current } = metadataOnlyFixture();
    const storageDriver = new MemoryStorage();
    const currentStorage = currentToOneStorage(current);
    const firstMember = currentStorage.members[0];
    if (!firstMember) {
      throw new Error("fixture must serialize at least one toOne member");
    }
    await seedEstate(storageDriver, {
      ...current,
      polymorphicStorage: [
        {
          ...currentStorage,
          members: [
            { ...firstMember, storedType: "content.post.legacy" },
            ...currentStorage.members.slice(1),
          ],
        },
      ],
    });
    storageDriver.writes.length = 0;

    await expect(generate(client, { storageDriver })).rejects.toMatchObject({
      code: "V11010",
    });
    expect(storageDriver.writes).toEqual([]);
    expect((await storageDriver.readJournal())?.entries).toEqual([]);

    // The refusal flows through dry-run unchanged: only correcting the schema,
    // or owning the transition through `manualMigration`, lifts it.
    await expect(
      generate(client, { storageDriver, dryRun: true })
    ).rejects.toThrow(REFUSAL);
    expect(storageDriver.writes).toEqual([]);
  });

  it("refuses a kind flip before any write, with zero operations applied", async () => {
    const { client, current } = metadataOnlyFixture();
    const storageDriver = new MemoryStorage();
    expect(currentToOneStorage(current).kind).toBe("toOne");

    // Rewrite the STORED snapshot as the toMany spelling of the same
    // relation: owner table without the pair columns or registry, one member
    // junction table, and kind-"toMany" metadata.
    const previousTables = current.tables.map((table) => {
      if (table.name !== "content") return table;
      return {
        name: table.name,
        columns: table.columns.filter(
          (column) => !column.name.startsWith("subject_")
        ),
        indexes: table.indexes.filter(
          (index) => index.name !== "content_subject_poly_idx"
        ),
        foreignKeys: table.foreignKeys,
        uniqueConstraints: table.uniqueConstraints,
      };
    });
    await seedEstate(storageDriver, {
      ...current,
      tables: [
        ...previousTables,
        {
          name: "content_subject_post",
          columns: [
            { name: "contentId", type: "text", nullable: false },
            { name: "postId", type: "text", nullable: false },
          ],
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "content",
          relation: "subject",
          kind: "toMany",
          members: [
            {
              publicType: "post",
              storedType: "content.post.v1",
              targetTable: "post",
              memberJunctionTable: "content_subject_post",
              inverseCardinality: "many",
            },
          ],
        },
      ],
    });
    storageDriver.writes.length = 0;

    await expect(generate(client, { storageDriver })).rejects.toThrow(
      TO_MANY_BECOMES_TO_ONE
    );
    expect(storageDriver.writes).toEqual([]);

    await expect(
      generate(client, { storageDriver, dryRun: true })
    ).rejects.toThrow(REFUSAL);
    expect(storageDriver.writes).toEqual([]);
    expect((await storageDriver.readJournal())?.entries).toEqual([]);
  });
});

/**
 * The manual-migration artifact seam.
 *
 * The flagship shape is a to-one stored-value rewrite: the discriminator
 * lives in owner rows, so the transition is data-bearing, yet it produces ZERO
 * structural operations — the differ never looks at polymorphic metadata. Every
 * assertion below is an observable outcome: a recorded `put` path, the exact
 * bytes of an artifact, or a journal entry's persisted policy.
 */
const EMPTY_UP = /`up` artifact parses to no statements/;
const EMPTY_MANUAL_ROLLBACK = /rollback `sql` parses to no statements/;
const BLANK_IRREVERSIBLE_REASON = /irreversible but states no reason/;
const NO_MIGRATION_NAME = /no migration name was supplied/;

describe("generate manual migration artifacts", () => {
  const MANUAL_UP = [
    `UPDATE "content" SET "subject_type" = 'content.post.v1' WHERE "subject_type" = 'content.post.legacy';`,
  ];
  const MANUAL_DOWN = [
    `UPDATE "content" SET "subject_type" = 'content.post.legacy' WHERE "subject_type" = 'content.post.v1';`,
  ];

  /** A stored snapshot whose only difference is one member's stored value. */
  async function storedValueRewrite(): Promise<{
    client: MigrationClient;
    storageDriver: MemoryStorage;
  }> {
    const { client, current } = metadataOnlyFixture();
    const storageDriver = new MemoryStorage();
    const currentStorage = currentToOneStorage(current);
    const firstMember = currentStorage.members[0];
    if (!firstMember) {
      throw new Error("fixture must serialize at least one toOne member");
    }
    await seedEstate(storageDriver, {
      ...current,
      polymorphicStorage: [
        {
          ...currentStorage,
          members: [
            { ...firstMember, storedType: "content.post.legacy" },
            ...currentStorage.members.slice(1),
          ],
        },
      ],
    });
    storageDriver.writes.length = 0;
    return { client, storageDriver };
  }

  it("writes all four artifacts for a transition with ZERO structural operations", async () => {
    const { client, storageDriver } = await storedValueRewrite();

    const result = await generate(client, {
      storageDriver,
      name: "rewrite-subject-discriminator",
      manualMigration: {
        up: MANUAL_UP,
        rollback: { kind: "manual", sql: MANUAL_DOWN },
      },
    });

    // Without the manual artifact this transition refuses; with it, the whole
    // migration is the caller's — and it is NOT swallowed by the zero-op
    // early return.
    expect(result.entry).not.toBeNull();
    expect(result.operations).toEqual([]);
    expect(result.mode).toBe("manual");
    expect(result.rollback).toEqual({ kind: "manual" });
    expect(result.message).toContain("Generated manual migration:");

    const entry = result.entry!;
    expect(storageDriver.writes).toEqual([
      formatMigrationFilename(entry),
      `meta/_down/${formatMigrationFilename(entry)}`,
      "meta/_journal.json",
      "meta/_snapshot.json",
    ]);

    // The emitted SQL is EXACTLY the supplied statements: no generated DDL is
    // appended around them, in either direction.
    expect(result.sql).toEqual(MANUAL_UP);
    expect(result.downSql).toEqual(MANUAL_DOWN);
    expect(result.downWarnings).toEqual([]);
    const upArtifact = await storageDriver.readMigration(entry);
    const downArtifact = await storageDriver.readDownMigration(entry);
    expect(parseStatements(upArtifact!)).toEqual(MANUAL_UP);
    expect(parseStatements(downArtifact!)).toEqual(MANUAL_DOWN);

    // The policy is persisted, so `down()` can dispatch on it later.
    const journal = await storageDriver.readJournal();
    expect(journal?.entries).toHaveLength(1);
    expect(journal?.entries[0]).toMatchObject({
      mode: "manual",
      rollback: { kind: "manual" },
    });
  });

  it("writes a comment-only down artifact for an irreversible migration and persists its reason", async () => {
    const { client, storageDriver } = await storedValueRewrite();

    const result = await generate(client, {
      storageDriver,
      name: "collapse-legacy-discriminator",
      manualMigration: {
        up: MANUAL_UP,
        rollback: {
          kind: "irreversible",
          reason: "the previous discriminator values are not recoverable",
        },
      },
    });

    const entry = result.entry!;
    expect(result.rollback).toEqual({
      kind: "irreversible",
      reason: "the previous discriminator values are not recoverable",
    });
    expect(result.downSql).toEqual([]);

    // The four writes stay uniform; the down artifact is a readable record
    // that parses to nothing, which is safe only because `down()` dispatches
    // on the persisted policy BEFORE it opens any artifact.
    const downContent = await storageDriver.readDownMigration(entry);
    expect(downContent).toContain("-- IRREVERSIBLE:");
    expect(downContent).toContain("not recoverable");
    expect(parseStatements(downContent!)).toEqual([]);

    const journalJson = storageDriver.files.get("meta/_journal.json");
    expect(journalJson).toContain('"kind": "irreversible"');
    expect(journalJson).toContain("not recoverable");
  });

  it("still computes the complete diff and writes nothing in dry run", async () => {
    const { client, storageDriver } = await storedValueRewrite();

    const result = await generate(client, {
      storageDriver,
      dryRun: true,
      name: "rewrite-subject-discriminator",
      manualMigration: {
        up: MANUAL_UP,
        rollback: { kind: "manual", sql: MANUAL_DOWN },
      },
    });

    expect(result.entry).not.toBeNull();
    expect(result.written).toBe(false);
    expect(result.message).toContain("Would generate manual migration:");
    expect(result.sql).toEqual(MANUAL_UP);
    expect(storageDriver.writes).toEqual([]);
  });

  it("elects manual mode even when the migration is not data-bearing", async () => {
    // Manual mode is caller-elected and unconditional: a first migration with
    // real structural operations still emits ONLY the supplied statements.
    const { client } = metadataOnlyFixture();
    const storageDriver = new MemoryStorage();

    const result = await generate(client, {
      storageDriver,
      name: "hand-written-bootstrap",
      manualMigration: {
        up: ['CREATE TABLE "hand_written" ("id" text PRIMARY KEY);'],
        rollback: { kind: "manual", sql: ['DROP TABLE "hand_written";'] },
      },
    });

    expect(result.operations.length).toBeGreaterThan(0);
    expect(result.sql).toEqual([
      'CREATE TABLE "hand_written" ("id" text PRIMARY KEY);',
    ]);
    expect(result.content).not.toContain('CREATE TABLE "content"');
  });

  describe("incomplete artifacts refuse before any write", () => {
    const cases: ReadonlyArray<{
      label: string;
      name: string | undefined;
      manual: NonNullable<GenerateOptions["manualMigration"]>;
      message: RegExp;
    }> = [
      {
        label: "an empty up artifact",
        name: "empty-up",
        manual: { up: [], rollback: { kind: "manual", sql: MANUAL_DOWN } },
        message: EMPTY_UP,
      },
      {
        label: "a comment-only up artifact",
        name: "comment-only-up",
        manual: {
          up: ["-- move the rows by hand later", "   "],
          rollback: { kind: "manual", sql: MANUAL_DOWN },
        },
        message: EMPTY_UP,
      },
      {
        label: "an empty manual rollback",
        name: "empty-down",
        manual: { up: MANUAL_UP, rollback: { kind: "manual", sql: [] } },
        message: EMPTY_MANUAL_ROLLBACK,
      },
      {
        label: "a comment-only manual rollback",
        name: "comment-only-down",
        manual: {
          up: MANUAL_UP,
          rollback: { kind: "manual", sql: ["-- nothing to undo"] },
        },
        message: EMPTY_MANUAL_ROLLBACK,
      },
      {
        label: "a blank irreversible reason",
        name: "unexplained",
        manual: {
          up: MANUAL_UP,
          rollback: { kind: "irreversible", reason: "  \n " },
        },
        message: BLANK_IRREVERSIBLE_REASON,
      },
      {
        label: "no explicit name",
        name: undefined,
        manual: {
          up: MANUAL_UP,
          rollback: { kind: "manual", sql: MANUAL_DOWN },
        },
        message: NO_MIGRATION_NAME,
      },
    ];

    for (const artifactCase of cases) {
      it(`refuses ${artifactCase.label} with zero writes`, async () => {
        const { client, storageDriver } = await storedValueRewrite();

        await expect(
          generate(client, {
            storageDriver,
            ...(artifactCase.name ? { name: artifactCase.name } : {}),
            manualMigration: artifactCase.manual,
          })
        ).rejects.toMatchObject({ code: "V11010" });
        await expect(
          generate(client, {
            storageDriver,
            ...(artifactCase.name ? { name: artifactCase.name } : {}),
            manualMigration: artifactCase.manual,
          })
        ).rejects.toThrow(artifactCase.message);

        expect(storageDriver.writes).toEqual([]);
        expect((await storageDriver.readJournal())?.entries).toEqual([]);
      });
    }
  });
});
