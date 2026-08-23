/**
 * FROZEN relation → DDL baseline, captured from HEAD before the unified
 * relation language switch (plan §9.3, §11.5; ruling D4).
 *
 * Generated data, hand-frozen: every value is the EXACT SchemaSnapshot HEAD's
 * serializer produced for the matching case in `relation-ddl-corpus.ts`.
 * Nothing here is a digest — the whole structural artifact is inspectable, as
 * plan §11.5.8 requires.
 *
 * DO NOT regenerate this file to make a failing test pass. The declarations in
 * the corpus are rewritten to the final relation language; these artifacts are
 * the preservation theorem and only a deliberate, plan-sanctioned verdict change
 * may edit them — with the reason recorded on the corpus case.
 *
 * Array order is significant everywhere: table order (model tables, then member
 * junctions, then ordinary junctions), column order, index order, foreign-key
 * order, and history member order are all part of what is pinned. Object KEY
 * order is not pinned; `JSON.stringify` drops undefined-valued keys, so the
 * deep-equality comparison and the snapshot file's bytes agree modulo key order.
 */

import type { SchemaSnapshot } from "@src/migrations/types";
import type { DdlDialect } from "./relation-ddl-corpus";

export const relationDdlBaseline: Readonly<
  Record<string, Partial<Record<DdlDialect, SchemaSnapshot>>>
> = {
  "one-to-one-declared-unique": {
    postgres: {
      tables: [
        {
          name: "o2o_declared_users",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "email",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "o2o_declared_users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "o2o_declared_profiles",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "userId",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
            {
              name: "bio",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "o2o_declared_profiles_pkey" },
          indexes: [],
          foreignKeys: [
            {
              name: "o2o_declared_profiles_userId_fkey",
              columns: ["userId"],
              referencedTable: "o2o_declared_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [
            { name: "o2o_declared_profiles_userId_key", columns: ["userId"] },
          ],
        },
      ],
    },
  },
  "one-to-one-fk-is-primary-key": {
    postgres: {
      tables: [
        {
          name: "o2o_pk_users",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "o2o_pk_users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "o2o_pk_profiles",
          columns: [
            {
              name: "userId",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["userId"], name: "o2o_pk_profiles_pkey" },
          indexes: [],
          foreignKeys: [
            {
              name: "o2o_pk_profiles_userId_fkey",
              columns: ["userId"],
              referencedTable: "o2o_pk_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "one-to-one-derived-unique": {
    postgres: {
      tables: [
        {
          name: "o2o_derived_users",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "o2o_derived_users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "o2o_derived_profiles",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "userId",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "o2o_derived_profiles_pkey" },
          indexes: [],
          foreignKeys: [
            {
              name: "o2o_derived_profiles_userId_fkey",
              columns: ["userId"],
              referencedTable: "o2o_derived_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [
            { name: "o2o_derived_profiles_userId_key", columns: ["userId"] },
          ],
        },
      ],
    },
  },
  "one-to-many-required-fk": {
    postgres: {
      tables: [
        {
          name: "o2m_required_users",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "o2m_required_users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "o2m_required_posts",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "title",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
            {
              name: "authorId",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "o2m_required_posts_pkey" },
          indexes: [
            {
              name: "o2m_required_posts_authorId_idx",
              columns: ["authorId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "o2m_required_posts_authorId_fkey",
              columns: ["authorId"],
              referencedTable: "o2m_required_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "one-to-many-nullable-fk": {
    postgres: {
      tables: [
        {
          name: "o2m_nullable_users",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "o2m_nullable_users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "o2m_nullable_posts",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "authorId",
              type: "text",
              nullable: true,
              default: "NULL",
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "o2m_nullable_posts_pkey" },
          indexes: [
            {
              name: "o2m_nullable_posts_authorId_idx",
              columns: ["authorId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "o2m_nullable_posts_authorId_fkey",
              columns: ["authorId"],
              referencedTable: "o2m_nullable_users",
              referencedColumns: ["id"],
              onDelete: "setNull",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "many-to-many-default-names": {
    postgres: {
      tables: [
        {
          name: "m2mdefpost",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "m2mdefpost_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "m2mdeftag",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "m2mdeftag_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "m2mdefpost_m2mdeftag",
          columns: [
            { name: "m2mdefpostId", type: "text", nullable: false },
            { name: "m2mdeftagId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["m2mdefpostId", "m2mdeftagId"] },
          indexes: [
            {
              name: "m2mdefpost_m2mdeftag_m2mdeftagId_idx",
              columns: ["m2mdeftagId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "m2mdefpost_m2mdeftag_m2mdefpostId_fkey",
              columns: ["m2mdefpostId"],
              referencedTable: "m2mdefpost",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "m2mdefpost_m2mdeftag_m2mdeftagId_fkey",
              columns: ["m2mdeftagId"],
              referencedTable: "m2mdeftag",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "many-to-many-one-sided-overrides": {
    postgres: {
      tables: [
        {
          name: "m2m_one_sided_posts",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "m2m_one_sided_posts_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "m2m_one_sided_tags",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "m2m_one_sided_tags_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "m2m_one_sided_join",
          columns: [
            { name: "post_ref", type: "text", nullable: false },
            { name: "tag_ref", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["post_ref", "tag_ref"] },
          indexes: [
            {
              name: "m2m_one_sided_join_tag_ref_idx",
              columns: ["tag_ref"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "m2m_one_sided_join_post_ref_fkey",
              columns: ["post_ref"],
              referencedTable: "m2m_one_sided_posts",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "cascade",
            },
            {
              name: "m2m_one_sided_join_tag_ref_fkey",
              columns: ["tag_ref"],
              referencedTable: "m2m_one_sided_tags",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "many-to-many-both-endpoints-equal-overrides": {
    postgres: {
      tables: [
        {
          name: "m2m_mirrored_posts",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "m2m_mirrored_posts_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "m2m_mirrored_tags",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "m2m_mirrored_tags_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "m2m_mirrored_join",
          columns: [
            { name: "post_ref", type: "text", nullable: false },
            { name: "tag_ref", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["post_ref", "tag_ref"] },
          indexes: [
            {
              name: "m2m_mirrored_join_tag_ref_idx",
              columns: ["tag_ref"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "m2m_mirrored_join_post_ref_fkey",
              columns: ["post_ref"],
              referencedTable: "m2m_mirrored_posts",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "cascade",
            },
            {
              name: "m2m_mirrored_join_tag_ref_fkey",
              columns: ["tag_ref"],
              referencedTable: "m2m_mirrored_tags",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "many-to-many-named-multi-pair": {
    postgres: {
      tables: [
        {
          name: "m2mnamedalpha",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "m2mnamedalpha_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "m2mnamedbeta",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "m2mnamedbeta_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "m2mnamedalpha_m2mnamedbeta_primary",
          columns: [
            { name: "m2mnamedalphaId", type: "text", nullable: false },
            { name: "m2mnamedbetaId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["m2mnamedalphaId", "m2mnamedbetaId"] },
          indexes: [
            {
              name: "m2mnamedalpha_m2mnamedbeta_primary_m2mnamedbetaId_idx",
              columns: ["m2mnamedbetaId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "m2mnamedalpha_m2mnamedbeta_primary_m2mnamedalphaId_fkey",
              columns: ["m2mnamedalphaId"],
              referencedTable: "m2mnamedalpha",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "m2mnamedalpha_m2mnamedbeta_primary_m2mnamedbetaId_fkey",
              columns: ["m2mnamedbetaId"],
              referencedTable: "m2mnamedbeta",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "m2mnamedalpha_m2mnamedbeta_secondary",
          columns: [
            { name: "m2mnamedalphaId", type: "text", nullable: false },
            { name: "m2mnamedbetaId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["m2mnamedalphaId", "m2mnamedbetaId"] },
          indexes: [
            {
              name: "m2mnamedalpha_m2mnamedbeta_secondary_m2mnamedbetaId_idx",
              columns: ["m2mnamedbetaId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "m2mnamedalpha_m2mnamedbeta_secondary_m2mnamedalphaId_fkey",
              columns: ["m2mnamedalphaId"],
              referencedTable: "m2mnamedalpha",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "m2mnamedalpha_m2mnamedbeta_secondary_m2mnamedbetaId_fkey",
              columns: ["m2mnamedbetaId"],
              referencedTable: "m2mnamedbeta",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "many-to-many-compound-keys": {
    postgres: {
      tables: [
        {
          name: "m2m_compound_posts",
          columns: [
            {
              name: "post_tenant",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
            {
              name: "post_slug",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: {
            columns: ["post_tenant", "post_slug"],
            name: "m2m_compound_posts_pkey",
          },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "m2m_compound_tags",
          columns: [
            {
              name: "tag_locale",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
            {
              name: "tag_code",
              type: "integer",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: {
            columns: ["tag_locale", "tag_code"],
            name: "m2m_compound_tags_pkey",
          },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "compoundpost_compoundtag",
          columns: [
            { name: "post_1", type: "text", nullable: false },
            { name: "post_2", type: "text", nullable: false },
            { name: "tag_1", type: "text", nullable: false },
            { name: "tag_2", type: "integer", nullable: false },
          ],
          primaryKey: { columns: ["post_1", "post_2", "tag_1", "tag_2"] },
          indexes: [
            {
              name: "compoundpost_compoundtag_tag_idx",
              columns: ["tag_1", "tag_2"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "compoundpost_compoundtag_post_fkey",
              columns: ["post_1", "post_2"],
              referencedTable: "m2m_compound_posts",
              referencedColumns: ["post_tenant", "post_slug"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "compoundpost_compoundtag_tag_fkey",
              columns: ["tag_1", "tag_2"],
              referencedTable: "m2m_compound_tags",
              referencedColumns: ["tag_locale", "tag_code"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "self-to-one-pair": {
    postgres: {
      tables: [
        {
          name: "self_fk_nodes",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "parentId",
              type: "text",
              nullable: true,
              default: "NULL",
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "self_fk_nodes_pkey" },
          indexes: [
            {
              name: "self_fk_nodes_parentId_idx",
              columns: ["parentId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "self_fk_nodes_parentId_fkey",
              columns: ["parentId"],
              referencedTable: "self_fk_nodes",
              referencedColumns: ["id"],
              onDelete: "setNull",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "self-many-to-many-explicit-tokens": {
    postgres: {
      tables: [
        {
          name: "self_m2m_nodes",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "self_m2m_nodes_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "node_node",
          columns: [
            { name: "follower_id", type: "text", nullable: false },
            { name: "following_id", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["follower_id", "following_id"] },
          indexes: [
            {
              name: "node_node_following_id_idx",
              columns: ["following_id"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "node_node_follower_id_fkey",
              columns: ["follower_id"],
              referencedTable: "self_m2m_nodes",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "node_node_following_id_fkey",
              columns: ["following_id"],
              referencedTable: "self_m2m_nodes",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "compound-fk-mixed-nullability": {
    postgres: {
      tables: [
        {
          name: "mixed_fk_nodes",
          columns: [
            {
              name: "tenantId",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "parentId",
              type: "text",
              nullable: true,
              default: "NULL",
              autoIncrement: false,
            },
          ],
          primaryKey: {
            columns: ["tenantId", "id"],
            name: "mixed_fk_nodes_pkey",
          },
          indexes: [
            {
              name: "mixed_fk_nodes_tenantId_parentId_idx",
              columns: ["tenantId", "parentId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "mixed_fk_nodes_tenantId_parentId_fkey",
              columns: ["tenantId", "parentId"],
              referencedTable: "mixed_fk_nodes",
              referencedColumns: ["tenantId", "id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "mapped-names-and-fk-actions": {
    postgres: {
      tables: [
        {
          name: "mapped_authors",
          columns: [
            {
              name: "author_pk",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["author_pk"], name: "mapped_authors_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "mapped_books",
          columns: [
            {
              name: "book_pk",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
            {
              name: "book_author_fk",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["book_pk"], name: "mapped_books_pkey" },
          indexes: [
            {
              name: "mapped_books_book_author_fk_idx",
              columns: ["book_author_fk"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "mapped_books_book_author_fk_fkey",
              columns: ["book_author_fk"],
              referencedTable: "mapped_authors",
              referencedColumns: ["author_pk"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "extends-shared-relation": {
    postgres: {
      tables: [
        {
          name: "ext_users",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "ext_users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "ext_images",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "ownerId",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
            {
              name: "width",
              type: "integer",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "ext_images_pkey" },
          indexes: [
            {
              name: "ext_images_ownerId_idx",
              columns: ["ownerId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "ext_images_ownerId_fkey",
              columns: ["ownerId"],
              referencedTable: "ext_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "ext_videos",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "ownerId",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
            {
              name: "duration",
              type: "integer",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "ext_videos_pkey" },
          indexes: [
            {
              name: "ext_videos_ownerId_idx",
              columns: ["ownerId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "ext_videos_ownerId_fkey",
              columns: ["ownerId"],
              referencedTable: "ext_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
      ],
    },
  },
  "variant-row-direct-only": {
    postgres: {
      tables: [
        {
          name: "vrow_direct_posts",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "title",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "vrow_direct_posts_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vrow_direct_videos",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "title",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "vrow_direct_videos_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vrow_direct_comments",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            { name: "subject_type", type: "text", nullable: false },
            { name: "subject_id", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["id"], name: "vrow_direct_comments_pkey" },
          indexes: [
            {
              name: "vrow_direct_comments_subject_poly_idx",
              columns: ["subject_type", "subject_id"],
              unique: false,
            },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
          relationStorage: {
            subject_type: {
              kind: "polymorphicToOne",
              typeColumn: "subject_type",
              idColumn: "subject_id",
              index: "vrow_direct_comments_subject_poly_idx",
            },
          },
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "vrow_direct_comments",
          relation: "subject",
          kind: "toOne",
          storageRef: "subject_type",
          members: [
            {
              publicType: "post",
              storedType: "content.post.v1",
              targetTable: "vrow_direct_posts",
            },
            {
              publicType: "video",
              storedType: "content.video.v1",
              targetTable: "vrow_direct_videos",
            },
          ],
        },
      ],
    },
  },
  "variant-row-to-one-inverse": {
    postgres: {
      tables: [
        {
          name: "vrow_one_posts",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vrow_one_posts_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vrow_one_videos",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vrow_one_videos_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vrow_one_comments",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            { name: "subject_type", type: "text", nullable: false },
            { name: "subject_id", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["id"], name: "vrow_one_comments_pkey" },
          indexes: [
            {
              name: "vrow_one_comments_subject_poly_idx",
              columns: ["subject_type", "subject_id"],
              unique: true,
            },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
          relationStorage: {
            subject_type: {
              kind: "polymorphicToOne",
              typeColumn: "subject_type",
              idColumn: "subject_id",
              index: "vrow_one_comments_subject_poly_idx",
            },
          },
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "vrow_one_comments",
          relation: "subject",
          kind: "toOne",
          storageRef: "subject_type",
          members: [
            {
              publicType: "post",
              storedType: "post",
              targetTable: "vrow_one_posts",
            },
            {
              publicType: "video",
              storedType: "video",
              targetTable: "vrow_one_videos",
            },
          ],
        },
      ],
    },
  },
  "variant-row-to-many-inverse": {
    postgres: {
      tables: [
        {
          name: "vrow_many_posts",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vrow_many_posts_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vrow_many_videos",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vrow_many_videos_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vrow_many_comments",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            { name: "subject_type", type: "text", nullable: false },
            { name: "subject_id", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["id"], name: "vrow_many_comments_pkey" },
          indexes: [
            {
              name: "vrow_many_comments_subject_poly_idx",
              columns: ["subject_type", "subject_id"],
              unique: false,
            },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
          relationStorage: {
            subject_type: {
              kind: "polymorphicToOne",
              typeColumn: "subject_type",
              idColumn: "subject_id",
              index: "vrow_many_comments_subject_poly_idx",
            },
          },
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "vrow_many_comments",
          relation: "subject",
          kind: "toOne",
          storageRef: "subject_type",
          members: [
            {
              publicType: "post",
              storedType: "post",
              targetTable: "vrow_many_posts",
            },
            {
              publicType: "video",
              storedType: "video",
              targetTable: "vrow_many_videos",
            },
          ],
        },
      ],
    },
  },
  "variant-row-optional": {
    postgres: {
      tables: [
        {
          name: "vrow_opt_posts",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vrow_opt_posts_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vrow_opt_videos",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vrow_opt_videos_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vrow_opt_comments",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            { name: "subject_type", type: "text", nullable: true },
            { name: "subject_id", type: "text", nullable: true },
          ],
          primaryKey: { columns: ["id"], name: "vrow_opt_comments_pkey" },
          indexes: [
            {
              name: "vrow_opt_comments_subject_poly_idx",
              columns: ["subject_type", "subject_id"],
              unique: false,
            },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
          relationStorage: {
            subject_type: {
              kind: "polymorphicToOne",
              typeColumn: "subject_type",
              idColumn: "subject_id",
              index: "vrow_opt_comments_subject_poly_idx",
            },
          },
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "vrow_opt_comments",
          relation: "subject",
          kind: "toOne",
          storageRef: "subject_type",
          members: [
            {
              publicType: "post",
              storedType: "opt.post.v1",
              targetTable: "vrow_opt_posts",
            },
            {
              publicType: "video",
              storedType: "opt.video.v1",
              targetTable: "vrow_opt_videos",
            },
          ],
        },
      ],
    },
  },
  "variant-row-repeated-target": {
    postgres: {
      tables: [
        {
          name: "vrow_repeat_docs",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "title",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "vrow_repeat_docs_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vrow_repeat_audits",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            { name: "subject_type", type: "text", nullable: false },
            { name: "subject_id", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["id"], name: "vrow_repeat_audits_pkey" },
          indexes: [
            {
              name: "vrow_repeat_audits_subject_poly_idx",
              columns: ["subject_type", "subject_id"],
              unique: false,
            },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
          relationStorage: {
            subject_type: {
              kind: "polymorphicToOne",
              typeColumn: "subject_type",
              idColumn: "subject_id",
              index: "vrow_repeat_audits_subject_poly_idx",
            },
          },
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "vrow_repeat_audits",
          relation: "subject",
          kind: "toOne",
          storageRef: "subject_type",
          members: [
            {
              publicType: "draft",
              storedType: "doc.draft.v1",
              targetTable: "vrow_repeat_docs",
            },
            {
              publicType: "published",
              storedType: "doc.published.v1",
              targetTable: "vrow_repeat_docs",
            },
          ],
        },
      ],
    },
  },
  "variant-member-direct-only": {
    postgres: {
      tables: [
        {
          name: "vmem_direct_books",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "title",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "vmem_direct_books_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_direct_videos",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "title",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "vmem_direct_videos_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_direct_shelves",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_direct_shelves_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_direct_shelves_items_book",
          columns: [
            { name: "bookId", type: "text", nullable: false },
            { name: "shelfId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["bookId", "shelfId"] },
          indexes: [
            {
              name: "vmem_direct_shelves_items_book_shelfId_idx",
              columns: ["shelfId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "vmem_direct_shelves_items_book_bookId_fkey",
              columns: ["bookId"],
              referencedTable: "vmem_direct_books",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "vmem_direct_shelves_items_book_shelfId_fkey",
              columns: ["shelfId"],
              referencedTable: "vmem_direct_shelves",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "vmem_direct_shelves_items_video",
          columns: [
            { name: "shelfId", type: "text", nullable: false },
            { name: "videoId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["shelfId", "videoId"] },
          indexes: [
            {
              name: "vmem_direct_shelves_items_video_videoId_idx",
              columns: ["videoId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "vmem_direct_shelves_items_video_shelfId_fkey",
              columns: ["shelfId"],
              referencedTable: "vmem_direct_shelves",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "vmem_direct_shelves_items_video_videoId_fkey",
              columns: ["videoId"],
              referencedTable: "vmem_direct_videos",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "vmem_direct_shelves",
          relation: "items",
          kind: "toMany",
          members: [
            {
              publicType: "book",
              storedType: "shelf.book.v1",
              targetTable: "vmem_direct_books",
              memberJunctionTable: "vmem_direct_shelves_items_book",
              inverseCardinality: "many",
            },
            {
              publicType: "video",
              storedType: "shelf.video.v1",
              targetTable: "vmem_direct_videos",
              memberJunctionTable: "vmem_direct_shelves_items_video",
              inverseCardinality: "many",
            },
          ],
        },
      ],
    },
  },
  "variant-member-to-one-inverse": {
    postgres: {
      tables: [
        {
          name: "vmem_one_books",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_one_books_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_one_videos",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_one_videos_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_one_shelves",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_one_shelves_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_one_shelves_items_book",
          columns: [
            { name: "bookId", type: "text", nullable: false },
            { name: "shelfId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["bookId", "shelfId"] },
          indexes: [
            {
              name: "vmem_one_shelves_items_book_shelfId_idx",
              columns: ["shelfId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "vmem_one_shelves_items_book_bookId_fkey",
              columns: ["bookId"],
              referencedTable: "vmem_one_books",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "vmem_one_shelves_items_book_shelfId_fkey",
              columns: ["shelfId"],
              referencedTable: "vmem_one_shelves",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [
            {
              name: "vmem_one_shelves_items_book_bookId_key",
              columns: ["bookId"],
            },
          ],
        },
        {
          name: "vmem_one_shelves_items_video",
          columns: [
            { name: "shelfId", type: "text", nullable: false },
            { name: "videoId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["shelfId", "videoId"] },
          indexes: [
            {
              name: "vmem_one_shelves_items_video_videoId_idx",
              columns: ["videoId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "vmem_one_shelves_items_video_shelfId_fkey",
              columns: ["shelfId"],
              referencedTable: "vmem_one_shelves",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "vmem_one_shelves_items_video_videoId_fkey",
              columns: ["videoId"],
              referencedTable: "vmem_one_videos",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [
            {
              name: "vmem_one_shelves_items_video_videoId_key",
              columns: ["videoId"],
            },
          ],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "vmem_one_shelves",
          relation: "items",
          kind: "toMany",
          members: [
            {
              publicType: "book",
              storedType: "one.book.v1",
              targetTable: "vmem_one_books",
              memberJunctionTable: "vmem_one_shelves_items_book",
              inverseCardinality: "one",
            },
            {
              publicType: "video",
              storedType: "one.video.v1",
              targetTable: "vmem_one_videos",
              memberJunctionTable: "vmem_one_shelves_items_video",
              inverseCardinality: "one",
            },
          ],
        },
      ],
    },
  },
  "variant-member-to-many-inverse": {
    postgres: {
      tables: [
        {
          name: "vmem_many_books",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_many_books_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_many_videos",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_many_videos_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_many_shelves",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_many_shelves_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_many_shelves_items_book",
          columns: [
            { name: "bookId", type: "text", nullable: false },
            { name: "shelfId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["bookId", "shelfId"] },
          indexes: [
            {
              name: "vmem_many_shelves_items_book_shelfId_idx",
              columns: ["shelfId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "vmem_many_shelves_items_book_bookId_fkey",
              columns: ["bookId"],
              referencedTable: "vmem_many_books",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "vmem_many_shelves_items_book_shelfId_fkey",
              columns: ["shelfId"],
              referencedTable: "vmem_many_shelves",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "vmem_many_shelves_items_video",
          columns: [
            { name: "shelfId", type: "text", nullable: false },
            { name: "videoId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["shelfId", "videoId"] },
          indexes: [
            {
              name: "vmem_many_shelves_items_video_videoId_idx",
              columns: ["videoId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "vmem_many_shelves_items_video_shelfId_fkey",
              columns: ["shelfId"],
              referencedTable: "vmem_many_shelves",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "vmem_many_shelves_items_video_videoId_fkey",
              columns: ["videoId"],
              referencedTable: "vmem_many_videos",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "vmem_many_shelves",
          relation: "items",
          kind: "toMany",
          members: [
            {
              publicType: "book",
              storedType: "many.book.v1",
              targetTable: "vmem_many_books",
              memberJunctionTable: "vmem_many_shelves_items_book",
              inverseCardinality: "many",
            },
            {
              publicType: "video",
              storedType: "many.video.v1",
              targetTable: "vmem_many_videos",
              memberJunctionTable: "vmem_many_shelves_items_video",
              inverseCardinality: "many",
            },
          ],
        },
      ],
    },
  },
  "variant-member-mixed-inverses": {
    postgres: {
      tables: [
        {
          name: "vmem_mixed_books",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_mixed_books_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_mixed_videos",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_mixed_videos_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_mixed_shelves",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_mixed_shelves_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_mixed_shelves_items_book",
          columns: [
            { name: "bookId", type: "text", nullable: false },
            { name: "shelfId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["bookId", "shelfId"] },
          indexes: [
            {
              name: "vmem_mixed_shelves_items_book_shelfId_idx",
              columns: ["shelfId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "vmem_mixed_shelves_items_book_bookId_fkey",
              columns: ["bookId"],
              referencedTable: "vmem_mixed_books",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "vmem_mixed_shelves_items_book_shelfId_fkey",
              columns: ["shelfId"],
              referencedTable: "vmem_mixed_shelves",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [
            {
              name: "vmem_mixed_shelves_items_book_bookId_key",
              columns: ["bookId"],
            },
          ],
        },
        {
          name: "vmem_mixed_shelves_items_video",
          columns: [
            { name: "shelfId", type: "text", nullable: false },
            { name: "videoId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["shelfId", "videoId"] },
          indexes: [
            {
              name: "vmem_mixed_shelves_items_video_videoId_idx",
              columns: ["videoId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "vmem_mixed_shelves_items_video_shelfId_fkey",
              columns: ["shelfId"],
              referencedTable: "vmem_mixed_shelves",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "vmem_mixed_shelves_items_video_videoId_fkey",
              columns: ["videoId"],
              referencedTable: "vmem_mixed_videos",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "vmem_mixed_shelves",
          relation: "items",
          kind: "toMany",
          members: [
            {
              publicType: "book",
              storedType: "mixed.book.v1",
              targetTable: "vmem_mixed_books",
              memberJunctionTable: "vmem_mixed_shelves_items_book",
              inverseCardinality: "one",
            },
            {
              publicType: "video",
              storedType: "mixed.video.v1",
              targetTable: "vmem_mixed_videos",
              memberJunctionTable: "vmem_mixed_shelves_items_video",
              inverseCardinality: "many",
            },
          ],
        },
      ],
    },
  },
  "variant-member-explicit-through": {
    postgres: {
      tables: [
        {
          name: "vmem_through_posts",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_through_posts_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_through_videos",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_through_videos_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_through_mentions",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_through_mentions_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_through_mention_post",
          columns: [
            { name: "mentionRef", type: "text", nullable: false },
            { name: "postRef", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["mentionRef", "postRef"] },
          indexes: [
            {
              name: "vmem_through_mention_post_postRef_idx",
              columns: ["postRef"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "vmem_through_mention_post_mentionRef_fkey",
              columns: ["mentionRef"],
              referencedTable: "vmem_through_mentions",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "vmem_through_mention_post_postRef_fkey",
              columns: ["postRef"],
              referencedTable: "vmem_through_posts",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "vmem_through_mention_video",
          columns: [
            { name: "mentionRef", type: "text", nullable: false },
            { name: "videoRef", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["mentionRef", "videoRef"] },
          indexes: [
            {
              name: "vmem_through_mention_video_videoRef_idx",
              columns: ["videoRef"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "vmem_through_mention_video_mentionRef_fkey",
              columns: ["mentionRef"],
              referencedTable: "vmem_through_mentions",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "vmem_through_mention_video_videoRef_fkey",
              columns: ["videoRef"],
              referencedTable: "vmem_through_videos",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "vmem_through_mentions",
          relation: "targets",
          kind: "toMany",
          members: [
            {
              publicType: "post",
              storedType: "post",
              targetTable: "vmem_through_posts",
              memberJunctionTable: "vmem_through_mention_post",
              inverseCardinality: "many",
            },
            {
              publicType: "video",
              storedType: "video",
              targetTable: "vmem_through_videos",
              memberJunctionTable: "vmem_through_mention_video",
              inverseCardinality: "many",
            },
          ],
        },
      ],
    },
  },
  "variant-member-compound-target-key": {
    postgres: {
      tables: [
        {
          name: "vmem_compound_articles",
          columns: [
            {
              name: "article_tenant",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
            {
              name: "article_slug",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: {
            columns: ["article_tenant", "article_slug"],
            name: "vmem_compound_articles_pkey",
          },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_compound_clips",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_compound_clips_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_compound_feeds",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "vmem_compound_feeds_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "vmem_compound_feeds_entries_article",
          columns: [
            { name: "article_1", type: "text", nullable: false },
            { name: "article_2", type: "text", nullable: false },
            { name: "feedId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["article_1", "article_2", "feedId"] },
          indexes: [
            {
              name: "vmem_compound_feeds_entries_article_feedId_idx",
              columns: ["feedId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "vmem_compound_feeds_entries_article_article_fkey",
              columns: ["article_1", "article_2"],
              referencedTable: "vmem_compound_articles",
              referencedColumns: ["article_tenant", "article_slug"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "vmem_compound_feeds_entries_article_feedId_fkey",
              columns: ["feedId"],
              referencedTable: "vmem_compound_feeds",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "vmem_compound_feeds_entries_clip",
          columns: [
            { name: "clipId", type: "text", nullable: false },
            { name: "feedId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["clipId", "feedId"] },
          indexes: [
            {
              name: "vmem_compound_feeds_entries_clip_feedId_idx",
              columns: ["feedId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "vmem_compound_feeds_entries_clip_clipId_fkey",
              columns: ["clipId"],
              referencedTable: "vmem_compound_clips",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "vmem_compound_feeds_entries_clip_feedId_fkey",
              columns: ["feedId"],
              referencedTable: "vmem_compound_feeds",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "vmem_compound_feeds",
          relation: "entries",
          kind: "toMany",
          members: [
            {
              publicType: "article",
              storedType: "article",
              targetTable: "vmem_compound_articles",
              memberJunctionTable: "vmem_compound_feeds_entries_article",
              inverseCardinality: "many",
            },
            {
              publicType: "clip",
              storedType: "clip",
              targetTable: "vmem_compound_clips",
              memberJunctionTable: "vmem_compound_feeds_entries_clip",
              inverseCardinality: "many",
            },
          ],
        },
      ],
    },
  },
  "ordinary-junction-before-variant-carrier": {
    postgres: {
      tables: [
        {
          name: "ord_first_archives",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "ord_first_archives_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "ord_first_tags",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "ord_first_tags_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "ord_first_shelves",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "ord_first_shelves_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "ord_first_books",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "ord_first_books_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "ord_first_clips",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "ord_first_clips_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "ord_first_shelves_items_book",
          columns: [
            { name: "bookId", type: "text", nullable: false },
            { name: "shelfId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["bookId", "shelfId"] },
          indexes: [
            {
              name: "ord_first_shelves_items_book_shelfId_idx",
              columns: ["shelfId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "ord_first_shelves_items_book_bookId_fkey",
              columns: ["bookId"],
              referencedTable: "ord_first_books",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "ord_first_shelves_items_book_shelfId_fkey",
              columns: ["shelfId"],
              referencedTable: "ord_first_shelves",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "ord_first_shelves_items_clip",
          columns: [
            { name: "clipId", type: "text", nullable: false },
            { name: "shelfId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["clipId", "shelfId"] },
          indexes: [
            {
              name: "ord_first_shelves_items_clip_shelfId_idx",
              columns: ["shelfId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "ord_first_shelves_items_clip_clipId_fkey",
              columns: ["clipId"],
              referencedTable: "ord_first_clips",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "ord_first_shelves_items_clip_shelfId_fkey",
              columns: ["shelfId"],
              referencedTable: "ord_first_shelves",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "archive_tag",
          columns: [
            { name: "archiveId", type: "text", nullable: false },
            { name: "tagId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["archiveId", "tagId"] },
          indexes: [
            {
              name: "archive_tag_tagId_idx",
              columns: ["tagId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "archive_tag_archiveId_fkey",
              columns: ["archiveId"],
              referencedTable: "ord_first_archives",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "archive_tag_tagId_fkey",
              columns: ["tagId"],
              referencedTable: "ord_first_tags",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "ord_first_shelves",
          relation: "items",
          kind: "toMany",
          members: [
            {
              publicType: "book",
              storedType: "book",
              targetTable: "ord_first_books",
              memberJunctionTable: "ord_first_shelves_items_book",
              inverseCardinality: "many",
            },
            {
              publicType: "clip",
              storedType: "clip",
              targetTable: "ord_first_clips",
              memberJunctionTable: "ord_first_shelves_items_clip",
              inverseCardinality: "many",
            },
          ],
        },
      ],
    },
  },
  "variant-carrier-after-inverse-models": {
    postgres: {
      tables: [
        {
          name: "anchor_posts",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "anchor_posts_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "anchor_videos",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "anchor_videos_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "anchor_comments",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            { name: "subject_type", type: "text", nullable: false },
            { name: "subject_id", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["id"], name: "anchor_comments_pkey" },
          indexes: [
            {
              name: "anchor_comments_subject_poly_idx",
              columns: ["subject_type", "subject_id"],
              unique: true,
            },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
          relationStorage: {
            subject_type: {
              kind: "polymorphicToOne",
              typeColumn: "subject_type",
              idColumn: "subject_id",
              index: "anchor_comments_subject_poly_idx",
            },
          },
        },
        {
          name: "anchor_boards",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "anchor_boards_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "anchor_boards_items_post",
          columns: [
            { name: "boardId", type: "text", nullable: false },
            { name: "postId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["boardId", "postId"] },
          indexes: [
            {
              name: "anchor_boards_items_post_postId_idx",
              columns: ["postId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "anchor_boards_items_post_boardId_fkey",
              columns: ["boardId"],
              referencedTable: "anchor_boards",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "anchor_boards_items_post_postId_fkey",
              columns: ["postId"],
              referencedTable: "anchor_posts",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [
            {
              name: "anchor_boards_items_post_postId_key",
              columns: ["postId"],
            },
          ],
        },
        {
          name: "anchor_boards_items_video",
          columns: [
            { name: "boardId", type: "text", nullable: false },
            { name: "videoId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["boardId", "videoId"] },
          indexes: [
            {
              name: "anchor_boards_items_video_videoId_idx",
              columns: ["videoId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "anchor_boards_items_video_boardId_fkey",
              columns: ["boardId"],
              referencedTable: "anchor_boards",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "anchor_boards_items_video_videoId_fkey",
              columns: ["videoId"],
              referencedTable: "anchor_videos",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "anchor_comments",
          relation: "subject",
          kind: "toOne",
          storageRef: "subject_type",
          members: [
            {
              publicType: "post",
              storedType: "post",
              targetTable: "anchor_posts",
            },
            {
              publicType: "video",
              storedType: "video",
              targetTable: "anchor_videos",
            },
          ],
        },
        {
          ownerTable: "anchor_boards",
          relation: "items",
          kind: "toMany",
          members: [
            {
              publicType: "post",
              storedType: "post",
              targetTable: "anchor_posts",
              memberJunctionTable: "anchor_boards_items_post",
              inverseCardinality: "one",
            },
            {
              publicType: "video",
              storedType: "video",
              targetTable: "anchor_videos",
              memberJunctionTable: "anchor_boards_items_video",
              inverseCardinality: "many",
            },
          ],
        },
      ],
    },
  },
  "dialect-witness": {
    postgres: {
      tables: [
        {
          name: "dw_users",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "dw_profiles",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "userId",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "dw_profiles_pkey" },
          indexes: [],
          foreignKeys: [
            {
              name: "dw_profiles_userId_fkey",
              columns: ["userId"],
              referencedTable: "dw_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [
            { name: "dw_profiles_userId_key", columns: ["userId"] },
          ],
        },
        {
          name: "dw_posts",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            {
              name: "authorId",
              type: "text",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "dw_posts_pkey" },
          indexes: [
            {
              name: "dw_posts_authorId_idx",
              columns: ["authorId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "dw_posts_authorId_fkey",
              columns: ["authorId"],
              referencedTable: "dw_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "dw_teams",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_teams_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "dw_comments",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
            { name: "subject_type", type: "text", nullable: false },
            { name: "subject_id", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_comments_pkey" },
          indexes: [
            {
              name: "dw_comments_subject_poly_idx",
              columns: ["subject_type", "subject_id"],
              unique: false,
            },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
          relationStorage: {
            subject_type: {
              kind: "polymorphicToOne",
              typeColumn: "subject_type",
              idColumn: "subject_id",
              index: "dw_comments_subject_poly_idx",
            },
          },
        },
        {
          name: "dw_boards",
          columns: [
            { name: "id", type: "text", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_boards_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "dw_boards_items_post",
          columns: [
            { name: "boardId", type: "text", nullable: false },
            { name: "postId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["boardId", "postId"] },
          indexes: [
            {
              name: "dw_boards_items_post_postId_idx",
              columns: ["postId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "dw_boards_items_post_boardId_fkey",
              columns: ["boardId"],
              referencedTable: "dw_boards",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "dw_boards_items_post_postId_fkey",
              columns: ["postId"],
              referencedTable: "dw_posts",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "dw_boards_items_team",
          columns: [
            { name: "boardId", type: "text", nullable: false },
            { name: "teamId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["boardId", "teamId"] },
          indexes: [
            {
              name: "dw_boards_items_team_teamId_idx",
              columns: ["teamId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "dw_boards_items_team_boardId_fkey",
              columns: ["boardId"],
              referencedTable: "dw_boards",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "dw_boards_items_team_teamId_fkey",
              columns: ["teamId"],
              referencedTable: "dw_teams",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "team_user",
          columns: [
            { name: "teamId", type: "text", nullable: false },
            { name: "userId", type: "text", nullable: false },
          ],
          primaryKey: { columns: ["teamId", "userId"] },
          indexes: [
            {
              name: "team_user_userId_idx",
              columns: ["userId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "team_user_teamId_fkey",
              columns: ["teamId"],
              referencedTable: "dw_teams",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "team_user_userId_fkey",
              columns: ["userId"],
              referencedTable: "dw_users",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "dw_comments",
          relation: "subject",
          kind: "toOne",
          storageRef: "subject_type",
          members: [
            { publicType: "post", storedType: "post", targetTable: "dw_posts" },
            { publicType: "team", storedType: "team", targetTable: "dw_teams" },
          ],
        },
        {
          ownerTable: "dw_boards",
          relation: "items",
          kind: "toMany",
          members: [
            {
              publicType: "post",
              storedType: "post",
              targetTable: "dw_posts",
              memberJunctionTable: "dw_boards_items_post",
              inverseCardinality: "many",
            },
            {
              publicType: "team",
              storedType: "team",
              targetTable: "dw_teams",
              memberJunctionTable: "dw_boards_items_team",
              inverseCardinality: "many",
            },
          ],
        },
      ],
    },
    mysql: {
      tables: [
        {
          name: "dw_users",
          columns: [
            {
              name: "id",
              type: "VARCHAR(191)",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "dw_users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "dw_profiles",
          columns: [
            {
              name: "id",
              type: "VARCHAR(191)",
              nullable: false,
              autoIncrement: false,
            },
            {
              name: "userId",
              type: "VARCHAR(191)",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "dw_profiles_pkey" },
          indexes: [
            {
              name: "dw_profiles_userId_key",
              columns: ["userId"],
              unique: true,
            },
          ],
          foreignKeys: [
            {
              name: "dw_profiles_userId_fkey",
              columns: ["userId"],
              referencedTable: "dw_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "dw_posts",
          columns: [
            {
              name: "id",
              type: "VARCHAR(191)",
              nullable: false,
              autoIncrement: false,
            },
            {
              name: "authorId",
              type: "VARCHAR(191)",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "dw_posts_pkey" },
          indexes: [
            {
              name: "dw_posts_authorId_idx",
              columns: ["authorId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "dw_posts_authorId_fkey",
              columns: ["authorId"],
              referencedTable: "dw_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "dw_teams",
          columns: [
            {
              name: "id",
              type: "VARCHAR(191)",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "dw_teams_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "dw_comments",
          columns: [
            {
              name: "id",
              type: "VARCHAR(191)",
              nullable: false,
              autoIncrement: false,
            },
            { name: "subject_type", type: "VARCHAR(191)", nullable: false },
            { name: "subject_id", type: "VARCHAR(191)", nullable: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_comments_pkey" },
          indexes: [
            {
              name: "dw_comments_subject_poly_idx",
              columns: ["subject_type", "subject_id"],
              unique: false,
            },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
          relationStorage: {
            subject_type: {
              kind: "polymorphicToOne",
              typeColumn: "subject_type",
              idColumn: "subject_id",
              index: "dw_comments_subject_poly_idx",
            },
          },
        },
        {
          name: "dw_boards",
          columns: [
            {
              name: "id",
              type: "VARCHAR(191)",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "dw_boards_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "dw_boards_items_post",
          columns: [
            { name: "boardId", type: "VARCHAR(191)", nullable: false },
            { name: "postId", type: "VARCHAR(191)", nullable: false },
          ],
          primaryKey: { columns: ["boardId", "postId"] },
          indexes: [
            {
              name: "dw_boards_items_post_postId_idx",
              columns: ["postId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "dw_boards_items_post_boardId_fkey",
              columns: ["boardId"],
              referencedTable: "dw_boards",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "dw_boards_items_post_postId_fkey",
              columns: ["postId"],
              referencedTable: "dw_posts",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "dw_boards_items_team",
          columns: [
            { name: "boardId", type: "VARCHAR(191)", nullable: false },
            { name: "teamId", type: "VARCHAR(191)", nullable: false },
          ],
          primaryKey: { columns: ["boardId", "teamId"] },
          indexes: [
            {
              name: "dw_boards_items_team_teamId_idx",
              columns: ["teamId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "dw_boards_items_team_boardId_fkey",
              columns: ["boardId"],
              referencedTable: "dw_boards",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "dw_boards_items_team_teamId_fkey",
              columns: ["teamId"],
              referencedTable: "dw_teams",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "team_user",
          columns: [
            { name: "teamId", type: "VARCHAR(191)", nullable: false },
            { name: "userId", type: "VARCHAR(191)", nullable: false },
          ],
          primaryKey: { columns: ["teamId", "userId"] },
          indexes: [
            {
              name: "team_user_userId_idx",
              columns: ["userId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "team_user_teamId_fkey",
              columns: ["teamId"],
              referencedTable: "dw_teams",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "team_user_userId_fkey",
              columns: ["userId"],
              referencedTable: "dw_users",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "dw_comments",
          relation: "subject",
          kind: "toOne",
          storageRef: "subject_type",
          members: [
            { publicType: "post", storedType: "post", targetTable: "dw_posts" },
            { publicType: "team", storedType: "team", targetTable: "dw_teams" },
          ],
        },
        {
          ownerTable: "dw_boards",
          relation: "items",
          kind: "toMany",
          members: [
            {
              publicType: "post",
              storedType: "post",
              targetTable: "dw_posts",
              memberJunctionTable: "dw_boards_items_post",
              inverseCardinality: "many",
            },
            {
              publicType: "team",
              storedType: "team",
              targetTable: "dw_teams",
              memberJunctionTable: "dw_boards_items_team",
              inverseCardinality: "many",
            },
          ],
        },
      ],
    },
    sqlite: {
      tables: [
        {
          name: "dw_users",
          columns: [
            { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "dw_profiles",
          columns: [
            { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
            {
              name: "userId",
              type: "TEXT",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "dw_profiles_pkey" },
          indexes: [],
          foreignKeys: [
            {
              name: "dw_profiles_userId_fkey",
              columns: ["userId"],
              referencedTable: "dw_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [
            { name: "dw_profiles_userId_key", columns: ["userId"] },
          ],
        },
        {
          name: "dw_posts",
          columns: [
            { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
            {
              name: "authorId",
              type: "TEXT",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "dw_posts_pkey" },
          indexes: [
            {
              name: "dw_posts_authorId_idx",
              columns: ["authorId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "dw_posts_authorId_fkey",
              columns: ["authorId"],
              referencedTable: "dw_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "dw_teams",
          columns: [
            { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_teams_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "dw_comments",
          columns: [
            { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
            { name: "subject_type", type: "TEXT", nullable: false },
            { name: "subject_id", type: "TEXT", nullable: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_comments_pkey" },
          indexes: [
            {
              name: "dw_comments_subject_poly_idx",
              columns: ["subject_type", "subject_id"],
              unique: false,
            },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
          relationStorage: {
            subject_type: {
              kind: "polymorphicToOne",
              typeColumn: "subject_type",
              idColumn: "subject_id",
              index: "dw_comments_subject_poly_idx",
            },
          },
        },
        {
          name: "dw_boards",
          columns: [
            { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_boards_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "dw_boards_items_post",
          columns: [
            { name: "boardId", type: "TEXT", nullable: false },
            { name: "postId", type: "TEXT", nullable: false },
          ],
          primaryKey: { columns: ["boardId", "postId"] },
          indexes: [
            {
              name: "dw_boards_items_post_postId_idx",
              columns: ["postId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "dw_boards_items_post_boardId_fkey",
              columns: ["boardId"],
              referencedTable: "dw_boards",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "dw_boards_items_post_postId_fkey",
              columns: ["postId"],
              referencedTable: "dw_posts",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "dw_boards_items_team",
          columns: [
            { name: "boardId", type: "TEXT", nullable: false },
            { name: "teamId", type: "TEXT", nullable: false },
          ],
          primaryKey: { columns: ["boardId", "teamId"] },
          indexes: [
            {
              name: "dw_boards_items_team_teamId_idx",
              columns: ["teamId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "dw_boards_items_team_boardId_fkey",
              columns: ["boardId"],
              referencedTable: "dw_boards",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "dw_boards_items_team_teamId_fkey",
              columns: ["teamId"],
              referencedTable: "dw_teams",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "team_user",
          columns: [
            { name: "teamId", type: "TEXT", nullable: false },
            { name: "userId", type: "TEXT", nullable: false },
          ],
          primaryKey: { columns: ["teamId", "userId"] },
          indexes: [
            {
              name: "team_user_userId_idx",
              columns: ["userId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "team_user_teamId_fkey",
              columns: ["teamId"],
              referencedTable: "dw_teams",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "team_user_userId_fkey",
              columns: ["userId"],
              referencedTable: "dw_users",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "dw_comments",
          relation: "subject",
          kind: "toOne",
          storageRef: "subject_type",
          members: [
            { publicType: "post", storedType: "post", targetTable: "dw_posts" },
            { publicType: "team", storedType: "team", targetTable: "dw_teams" },
          ],
        },
        {
          ownerTable: "dw_boards",
          relation: "items",
          kind: "toMany",
          members: [
            {
              publicType: "post",
              storedType: "post",
              targetTable: "dw_posts",
              memberJunctionTable: "dw_boards_items_post",
              inverseCardinality: "many",
            },
            {
              publicType: "team",
              storedType: "team",
              targetTable: "dw_teams",
              memberJunctionTable: "dw_boards_items_team",
              inverseCardinality: "many",
            },
          ],
        },
      ],
    },
    libsql: {
      tables: [
        {
          name: "dw_users",
          columns: [
            { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_users_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "dw_profiles",
          columns: [
            { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
            {
              name: "userId",
              type: "TEXT",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "dw_profiles_pkey" },
          indexes: [],
          foreignKeys: [
            {
              name: "dw_profiles_userId_fkey",
              columns: ["userId"],
              referencedTable: "dw_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [
            { name: "dw_profiles_userId_key", columns: ["userId"] },
          ],
        },
        {
          name: "dw_posts",
          columns: [
            { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
            {
              name: "authorId",
              type: "TEXT",
              nullable: false,
              autoIncrement: false,
            },
          ],
          primaryKey: { columns: ["id"], name: "dw_posts_pkey" },
          indexes: [
            {
              name: "dw_posts_authorId_idx",
              columns: ["authorId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "dw_posts_authorId_fkey",
              columns: ["authorId"],
              referencedTable: "dw_users",
              referencedColumns: ["id"],
              onDelete: "restrict",
              onUpdate: "noAction",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "dw_teams",
          columns: [
            { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_teams_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "dw_comments",
          columns: [
            { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
            { name: "subject_type", type: "TEXT", nullable: false },
            { name: "subject_id", type: "TEXT", nullable: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_comments_pkey" },
          indexes: [
            {
              name: "dw_comments_subject_poly_idx",
              columns: ["subject_type", "subject_id"],
              unique: false,
            },
          ],
          foreignKeys: [],
          uniqueConstraints: [],
          relationStorage: {
            subject_type: {
              kind: "polymorphicToOne",
              typeColumn: "subject_type",
              idColumn: "subject_id",
              index: "dw_comments_subject_poly_idx",
            },
          },
        },
        {
          name: "dw_boards",
          columns: [
            { name: "id", type: "TEXT", nullable: false, autoIncrement: false },
          ],
          primaryKey: { columns: ["id"], name: "dw_boards_pkey" },
          indexes: [],
          foreignKeys: [],
          uniqueConstraints: [],
        },
        {
          name: "dw_boards_items_post",
          columns: [
            { name: "boardId", type: "TEXT", nullable: false },
            { name: "postId", type: "TEXT", nullable: false },
          ],
          primaryKey: { columns: ["boardId", "postId"] },
          indexes: [
            {
              name: "dw_boards_items_post_postId_idx",
              columns: ["postId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "dw_boards_items_post_boardId_fkey",
              columns: ["boardId"],
              referencedTable: "dw_boards",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "dw_boards_items_post_postId_fkey",
              columns: ["postId"],
              referencedTable: "dw_posts",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "dw_boards_items_team",
          columns: [
            { name: "boardId", type: "TEXT", nullable: false },
            { name: "teamId", type: "TEXT", nullable: false },
          ],
          primaryKey: { columns: ["boardId", "teamId"] },
          indexes: [
            {
              name: "dw_boards_items_team_teamId_idx",
              columns: ["teamId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "dw_boards_items_team_boardId_fkey",
              columns: ["boardId"],
              referencedTable: "dw_boards",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "dw_boards_items_team_teamId_fkey",
              columns: ["teamId"],
              referencedTable: "dw_teams",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
        {
          name: "team_user",
          columns: [
            { name: "teamId", type: "TEXT", nullable: false },
            { name: "userId", type: "TEXT", nullable: false },
          ],
          primaryKey: { columns: ["teamId", "userId"] },
          indexes: [
            {
              name: "team_user_userId_idx",
              columns: ["userId"],
              unique: false,
            },
          ],
          foreignKeys: [
            {
              name: "team_user_teamId_fkey",
              columns: ["teamId"],
              referencedTable: "dw_teams",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
            {
              name: "team_user_userId_fkey",
              columns: ["userId"],
              referencedTable: "dw_users",
              referencedColumns: ["id"],
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          ],
          uniqueConstraints: [],
        },
      ],
      polymorphicStorage: [
        {
          ownerTable: "dw_comments",
          relation: "subject",
          kind: "toOne",
          storageRef: "subject_type",
          members: [
            { publicType: "post", storedType: "post", targetTable: "dw_posts" },
            { publicType: "team", storedType: "team", targetTable: "dw_teams" },
          ],
        },
        {
          ownerTable: "dw_boards",
          relation: "items",
          kind: "toMany",
          members: [
            {
              publicType: "post",
              storedType: "post",
              targetTable: "dw_posts",
              memberJunctionTable: "dw_boards_items_post",
              inverseCardinality: "many",
            },
            {
              publicType: "team",
              storedType: "team",
              targetTable: "dw_teams",
              memberJunctionTable: "dw_boards_items_team",
              inverseCardinality: "many",
            },
          ],
        },
      ],
    },
  },
};
