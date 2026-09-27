/**
 * One schema that carries the three declarations issues #45, #46 and #47 added
 * or tightened, so their owners are exercised TOGETHER rather than one lane at
 * a time (the integration plan's combined falsifiers 1-4):
 *
 *   · #45 — native-type maps: the post key's compact identifier storage, the
 *     topic key's varchar, the post title, and the creation timestamp's SQLite
 *     INTEGER form;
 *   · #47 — `createdAt` is a `.now()` creation timestamp, insert-only;
 *   · #46 — `post.topics` owns an asymmetric junction: deleting a post cascades
 *     its memberships (`source`), deleting an assigned topic is refused
 *     (`target: "noAction"`);
 *   · #42 — the names are chosen so catalog order is the WRONG drop order on
 *     SQLite: `aaa_topic` sorts first, and dropping it while `zzz_membership`
 *     still holds its rows is refused by the target key.
 *
 * `post` owns the junction and sorts second among the junction's sides, so an
 * alphabetical reading of `source` / `target` would put the cascade on the topic
 * key. Consumers: `tests/unit/schema-json/issue-combination.core.test.ts`
 * (document, snapshots, diffs) and `issue-combination-behavior.ts` (live).
 */

import { s } from "@schema";
import type { JunctionReferentialAction } from "@schema/relation/types";
import {
  MYSQL,
  type NativeTypeMap,
  PG,
  SQLITE,
} from "@schema/scalars/native-types";

/** The post key: a compact uuid, bytea on PostgreSQL, text on MySQL. */
export const POST_KEY_STORAGE: NativeTypeMap = {
  pg: PG.BLOB.BYTEA,
  mysql: MYSQL.STRING.VARCHAR(36),
};

/** The topic key: a bounded varchar where the dialect has one. */
export const TOPIC_KEY_STORAGE: NativeTypeMap = {
  pg: PG.STRING.VARCHAR(30),
  mysql: MYSQL.STRING.VARCHAR(30),
};

export const TITLE_STORAGE: NativeTypeMap = {
  pg: PG.STRING.VARCHAR(80),
  mysql: MYSQL.STRING.VARCHAR(80),
  sqlite: SQLITE.STRING.TEXT,
};

export const CREATED_STORAGE: NativeTypeMap = {
  sqlite: SQLITE.DATETIME.INTEGER,
};

export const JUNCTION_TABLE = "zzz_membership";

export interface CombinationVariant {
  /** The title's storage; moving one entry is a change on that dialect only. */
  readonly title?: NativeTypeMap;
  /** The creation timestamp's storage. */
  readonly created?: NativeTypeMap;
  /** The junction's `target` (topic-side) delete action. */
  readonly topicDelete?: JunctionReferentialAction;
  /**
   * Restate the same physical schema in the other spelling each new form
   * allows: the topic name as a map of each dialect's default type, and the
   * symmetric update action as an equal side map. A pure representation
   * change: no dialect may plan work for it.
   */
  readonly respelled?: boolean;
}

export function combinationSchema(variant: CombinationVariant = {}) {
  const topic = s
    .model({
      id: s.string(TOPIC_KEY_STORAGE).id(),
      name: variant.respelled
        ? s.string({ pg: PG.STRING.TEXT, sqlite: SQLITE.STRING.TEXT })
        : s.string(),
      posts: s.toMany(() => post),
    })
    .map("aaa_topic");
  const topics = s
    .toMany(() => topic)
    .through(JUNCTION_TABLE)
    .onDelete({
      source: "cascade",
      target: variant.topicDelete ?? "noAction",
    });
  const post = s
    .model({
      id: s.string(POST_KEY_STORAGE).uuid().id(),
      title: s.string(variant.title ?? TITLE_STORAGE),
      createdAt: s.dateTime(variant.created ?? CREATED_STORAGE).now(),
      topics: variant.respelled
        ? topics.onUpdate({ source: "cascade", target: "cascade" })
        : topics.onUpdate("cascade"),
    })
    .map("bbb_post");
  return { topic, post };
}

export type CombinationSchema = ReturnType<typeof combinationSchema>;
