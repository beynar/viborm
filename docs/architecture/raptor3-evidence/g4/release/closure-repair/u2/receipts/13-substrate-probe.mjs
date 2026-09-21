/**
 * Why the effect's own predicate is NOT protection, and what is.
 *
 * Run from the worktree root with PG_TEST_CONNECTION_STRING set. It creates
 * and drops its own `se_u2_*` tables and touches nothing else. Three A/B
 * schedules, all with B's membership change HELD UNCOMMITTED while A runs:
 *
 *  1. identity-only        — the reviewed engine's consuming DELETE.
 *  2. exists-predicate     — the membership carried into the effect as SQL.
 *  3. junction-forupdate   — the membership's OWN row taken under lock.
 *
 * PostgreSQL re-evaluates a blocked write's qualification against the updated
 * TARGET row, but subqueries over other tables keep the original snapshot, so
 * (2) waits for B, wakes, re-reads a stale junction and deletes anyway. Only
 * (3) answers the truth — and, run the other way round, makes B wait for A.
 */
import { Client } from "pg";
const url = process.env.PG_TEST_CONNECTION_STRING;
const mk = async () => { const c = new Client({ connectionString: url }); await c.connect(); return c; };
const setup = await mk();
const ddl = async () => {
  await setup.query("DROP TABLE IF EXISTS se_u2_j, se_u2_m, se_u2_t CASCADE");
  await setup.query("CREATE TABLE se_u2_t (id text primary key)");
  await setup.query("CREATE TABLE se_u2_m (id text primary key, active boolean not null)");
  await setup.query("CREATE TABLE se_u2_j (member_ref text not null references se_u2_m(id) on delete cascade, team_ref text not null references se_u2_t(id) on delete cascade, primary key (member_ref, team_ref))");
};
const seed = async () => {
  await setup.query("TRUNCATE se_u2_j, se_u2_m, se_u2_t CASCADE");
  await setup.query("INSERT INTO se_u2_t VALUES ('t1'),('t2')");
  await setup.query("INSERT INTO se_u2_m VALUES ('m1',true),('m2',true)");
  await setup.query("INSERT INTO se_u2_j VALUES ('m1','t1'),('m2','t1')");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waiting = async () => (await setup.query("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE NOT l.granted AND a.datname=current_database()")).rows[0].n;
await ddl();

async function held(name, run) {
  await seed();
  const A = await mk(); const B = await mk();
  await B.query("BEGIN");
  await B.query("DELETE FROM se_u2_j WHERE team_ref='t1' AND member_ref='m1'");
  await B.query("INSERT INTO se_u2_j VALUES ('m1','t2')");
  await A.query("BEGIN");
  let done = false; let outcome = "deleted m1";
  const running = (async () => { try { outcome = await run(A); } catch (e) { outcome = e.message; } finally { done = true; } })();
  let blocked = false;
  for (let i = 0; i < 60 && !done; i++) { if (await waiting() > 0) { blocked = true; break; } await sleep(50); }
  await sleep(150);
  await B.query("COMMIT");
  await running;
  await A.query("COMMIT").catch(() => {});
  const members = (await setup.query("SELECT id FROM se_u2_m ORDER BY id")).rows.map((r) => r.id).join(",");
  console.log(`[held ${name}] A waited=${blocked} outcome=${outcome} members=${members}`);
  await A.end(); await B.end();
}

await held("identity-only", async (A) => { await A.query("DELETE FROM se_u2_m WHERE id='m1'"); return "deleted m1"; });
await held("exists-predicate", async (A) => { await A.query("DELETE FROM se_u2_m WHERE id='m1' AND EXISTS (SELECT 1 FROM se_u2_j j WHERE j.member_ref=se_u2_m.id AND j.team_ref='t1')"); return "deleted m1"; });
await held("junction-forupdate", async (A) => {
  const p = await A.query("SELECT 1 FROM se_u2_j WHERE member_ref='m1' AND team_ref='t1' LIMIT 1 FOR UPDATE");
  if (p.rowCount === 0) return "REQUIREMENT LOST — nothing written";
  await A.query("DELETE FROM se_u2_m WHERE id='m1'");
  return "deleted m1";
});

// The other order: A takes the membership first, and B must wait for it.
await seed();
{
  const A = await mk(); const B = await mk();
  await A.query("BEGIN");
  await A.query("SELECT 1 FROM se_u2_j WHERE member_ref='m1' AND team_ref='t1' LIMIT 1 FOR UPDATE");
  await B.query("BEGIN");
  let bDone = false;
  const bRun = (async () => { try { await B.query("DELETE FROM se_u2_j WHERE team_ref='t1' AND member_ref='m1'"); await B.query("COMMIT"); } finally { bDone = true; } })();
  let bBlocked = false;
  for (let i = 0; i < 40 && !bDone; i++) { if (await waiting() > 0) { bBlocked = true; break; } await sleep(50); }
  await A.query("DELETE FROM se_u2_m WHERE id='m1'");
  await A.query("COMMIT");
  await bRun;
  const members = (await setup.query("SELECT id FROM se_u2_m ORDER BY id")).rows.map((r) => r.id).join(",");
  console.log(`[A first, junction-forupdate] B waited=${bBlocked} members=${members}`);
  await A.end(); await B.end();
}
await setup.query("DROP TABLE IF EXISTS se_u2_j, se_u2_m, se_u2_t CASCADE");
await setup.end();
