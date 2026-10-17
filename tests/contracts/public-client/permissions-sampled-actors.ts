/**
 * The actors the server substrates judge (Docker PostgreSQL and MySQL): one
 * actor of each class of the seed, so every class is met at a fraction of the
 * cost (the server plans each correlated recursive predicate afresh; the
 * compiled policy over 23 actors took 75 minutes on PostgreSQL). The classes
 * are what the policy reads of an actor: an active admin (on the office
 * network, so `export` is held), member and reader (each organization's
 * role, on a live session); an inactive one (a banned
 * user, or no live credential: an expired, absent or unknown session); and a
 * key, live (scoped, without resources, or beside a session) or dead
 * (disabled, expired, unknown). Within each class the actor is drawn by a
 * seeded generator, so the sample is the same on every run and machine.
 *
 * `VIBORM_PERMISSIONS_ACTORS=all` judges every seeded actor instead, on any
 * substrate. SQLite3 and PGlite judge every actor by default.
 */

import { actors, seed } from "@tests/package/fixtures/permissions-app/seed";

const ORDINARY = /^u\d+$/;
const DEAD_CREDENTIAL = /^u\d+-(expired|no-credential|unknown-session)$/;
/** A key no `apiKey` row keeps alive: disabled, expired or unknown. */
const DEAD_KEY = /-(disabled|expired|unknown)-key$/;

type Actor = (typeof actors)[string];

const roleOf = (actor: Actor) =>
  seed.member.find(
    (m) =>
      m.userId === actor.userId &&
      m.organizationId === actor.organizationId &&
      m.deletedAt === null
  )?.role;
/** Banned with no expiry or one in the future (the seed's users 13 and 31). */
const banned = (actor: Actor) => {
  const user = seed.user.find((u) => u.id === actor.userId)!;
  return (
    user.banned === true &&
    (user.banExpires === null || user.banExpires.getTime() > Date.now())
  );
};
const active = (name: string, actor: Actor, role: string) =>
  ORDINARY.test(name) && !banned(actor) && roleOf(actor) === role;

/** Each class of actor the policy distinguishes, by name and facts. */
export const ACTOR_CLASSES: Readonly<
  Record<string, (name: string, actor: Actor) => boolean>
> = {
  // On the office network: the one class that can hold `export` (W-A5).
  admin: (name, actor) =>
    active(name, actor, "admin") && actor.network === "office",
  member: (name, actor) => active(name, actor, "member"),
  reader: (name, actor) => active(name, actor, "reader"),
  inactive: (name, actor) =>
    (ORDINARY.test(name) && banned(actor)) || DEAD_CREDENTIAL.test(name),
  "live key": (name, actor) => actor.key !== undefined && !DEAD_KEY.test(name),
  "dead key": (name) => DEAD_KEY.test(name),
};

/** Park and Miller's minimal standard generator: a fixed sequence for a fixed seed. */
function generator(seed: number) {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}

function sample(): string[] {
  const next = generator(20_261_015);
  const names = Object.keys(actors);
  return Object.values(ACTOR_CLASSES).map((member) => {
    const candidates = names.filter((name) => member(name, actors[name]!));
    return candidates[Math.floor(next() * candidates.length)]!;
  });
}

export const SAMPLED_ACTORS: readonly string[] =
  process.env.VIBORM_PERMISSIONS_ACTORS === "all"
    ? Object.keys(actors)
    : sample();
