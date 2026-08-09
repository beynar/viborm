/**
 * Relation Schema Test Fixtures
 *
 * Test models with various relation configurations:
 * - Required to-one relation (manyToOne)
 * - Optional to-one relation (oneToOne optional)
 * - Required to-many relation (oneToMany)
 * - Self-referential relation (for circular reference testing)
 */

import { s } from "@schema";
import { createSchemaRegistry } from "@validation";

// =============================================================================
// BASE MODELS
// =============================================================================

/**
 * Author model with oneToMany relation to Post
 */
export const Author = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string(),
  posts: s.oneToMany(() => Post),
});

/**
 * Post model with manyToOne relation to Author (required)
 */
export const Post = s.model({
  id: s.string().id(),
  title: s.string(),
  content: s.string(),
  published: s.boolean().default(false),
  authorId: s.string(),
  author: s.manyToOne(() => Author),
});

/**
 * Profile model with optional oneToOne relation to User
 */
export const Profile = s.model({
  id: s.string().id(),
  bio: s.string().nullable(),
  userId: s.string().nullable().unique(),
  user: s
    .oneToOne(() => User)
    .fields("userId")
    .references("id")
    .optional(),
});

/**
 * User model with oneToOne relation to Profile and self-referential relation
 */
export const User = s.model({
  id: s.string().id(),
  username: s.string(),
  profile: s.oneToOne(() => Profile).optional(),
  managerId: s.string().nullable(),
  manager: s.manyToOne(() => User).optional(),
  subordinates: s.oneToMany(() => User),
});

// =============================================================================
// RELATION STATES (for direct schema factory testing)
// =============================================================================

// Extract relation states from models for direct testing
const authorShape = Author["~"].state.shape;
const postShape = Post["~"].state.shape;
const profileShape = Profile["~"].state.shape;
const userShape = User["~"].state.shape;

/**
 * Required manyToOne relation state (Post.author)
 */
export const requiredManyToOneState = postShape.author["~"].state;

/**
 * Required oneToMany relation state (Author.posts)
 */
export const requiredOneToManyState = authorShape.posts["~"].state;

/**
 * Optional oneToOne relation state (Profile.user)
 */
export const optionalOneToOneState = profileShape.user["~"].state;

/**
 * Optional manyToOne relation state (User.manager - self-referential)
 */
export const optionalManyToOneState = userShape.manager["~"].state;

/**
 * Self-referential oneToMany relation state (User.subordinates)
 */
export const selfRefOneToManyState = userShape.subordinates["~"].state;

// =============================================================================
// RELATION SCHEMAS (generated from states)
// =============================================================================

const schemaRegistry = createSchemaRegistry({ Author, Post, Profile, User });

/**
 * Schemas for required manyToOne relation (Post.author)
 */
export const requiredManyToOneSchemas =
  schemaRegistry.proxy.Post.relations.author;

/**
 * Schemas for required oneToMany relation (Author.posts)
 */
export const requiredOneToManySchemas =
  schemaRegistry.proxy.Author.relations.posts;

/**
 * Schemas for optional oneToOne relation (Profile.user)
 */
export const optionalOneToOneSchemas =
  schemaRegistry.proxy.Profile.relations.user;

/**
 * Schemas for optional manyToOne relation (User.manager)
 */
export const optionalManyToOneSchemas =
  schemaRegistry.proxy.User.relations.manager;

/**
 * Schemas for self-referential oneToMany relation (User.subordinates)
 */
export const selfRefOneToManySchemas =
  schemaRegistry.proxy.User.relations.subordinates;

// =============================================================================
// TYPE EXPORTS
// =============================================================================

export type AuthorState = (typeof Author)["~"]["state"];
export type PostState = (typeof Post)["~"]["state"];
export type ProfileState = (typeof Profile)["~"]["state"];
export type UserState = (typeof User)["~"]["state"];

export type RequiredManyToOneState = typeof requiredManyToOneState;
export type RequiredOneToManyState = typeof requiredOneToManyState;
export type OptionalOneToOneState = typeof optionalOneToOneState;
export type OptionalManyToOneState = typeof optionalManyToOneState;
export type SelfRefOneToManyState = typeof selfRefOneToManyState;
