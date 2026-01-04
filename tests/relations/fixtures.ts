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
import type { RelationState } from "@schema/relation/relation";
import { getRelationSchemas } from "@schema/relation/schemas";

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
  userId: s.string().nullable(),
  user: s.oneToOne(() => User, { optional: true }),
});

/**
 * User model with oneToOne relation to Profile and self-referential relation
 */
export const User = s.model({
  id: s.string().id(),
  username: s.string(),
  profile: s.oneToOne(() => Profile, { optional: true }),
  managerId: s.string().nullable(),
  manager: s.manyToOne(() => User, { optional: true }),
  subordinates: s.oneToMany(() => User),
});

// =============================================================================
// RELATION STATES (for direct schema factory testing)
// =============================================================================

// Extract relation states from models for direct testing
const authorFields = Author["~"].state.fields;
const postFields = Post["~"].state.fields;
const profileFields = Profile["~"].state.fields;
const userFields = User["~"].state.fields;

/**
 * Required manyToOne relation state (Post.author)
 */
export const requiredManyToOneState = postFields.author["~"]
  .state as RelationState;

/**
 * Required oneToMany relation state (Author.posts)
 */
export const requiredOneToManyState = authorFields.posts["~"]
  .state as RelationState;

/**
 * Optional oneToOne relation state (Profile.user)
 */
export const optionalOneToOneState = profileFields.user["~"]
  .state as RelationState;

/**
 * Optional manyToOne relation state (User.manager - self-referential)
 */
export const optionalManyToOneState = userFields.manager["~"]
  .state as RelationState;

/**
 * Self-referential oneToMany relation state (User.subordinates)
 */
export const selfRefOneToManyState = userFields.subordinates["~"]
  .state as RelationState;

// =============================================================================
// RELATION SCHEMAS (generated from states)
// =============================================================================

/**
 * Schemas for required manyToOne relation (Post.author)
 */
export const requiredManyToOneSchemas = getRelationSchemas(
  requiredManyToOneState
);

/**
 * Schemas for required oneToMany relation (Author.posts)
 */
export const requiredOneToManySchemas = getRelationSchemas(
  requiredOneToManyState
);

/**
 * Schemas for optional oneToOne relation (Profile.user)
 */
export const optionalOneToOneSchemas = getRelationSchemas(
  optionalOneToOneState
);

/**
 * Schemas for optional manyToOne relation (User.manager)
 */
export const optionalManyToOneSchemas = getRelationSchemas(
  optionalManyToOneState
);

/**
 * Schemas for self-referential oneToMany relation (User.subordinates)
 */
export const selfRefOneToManySchemas = getRelationSchemas(
  selfRefOneToManyState
);

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
