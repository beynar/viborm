/**
 * The actors the server substrates judge: every special actor of the seed
 * (credentials absent, expired, unknown; keys scoped, disabled, expired,
 * unknown, without resources; a second organization) and every fifth
 * ordinary one, so each role, network and organization of the seed is met.
 */

import { actors } from "@tests/package/fixtures/rbac-app/seed";

const ORDINARY = /^u\d+$/;

export const SAMPLED_ACTORS: readonly string[] = Object.keys(actors).filter(
  (name, index) => !ORDINARY.test(name) || index % 5 === 0
);
