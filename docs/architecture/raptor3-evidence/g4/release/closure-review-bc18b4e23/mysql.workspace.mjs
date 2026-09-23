import { readFileSync } from "node:fs";
const root = process.cwd();
const mysqlFile = "tests/providers/docker/mysql2-concurrency-policy.test.ts";
const witnesses = readFileSync(new URL("mysql-witness.txt", import.meta.url), "utf8");
export default [{
  extends: `${root}/vitest.config.ts`, root,
  plugins: [{
    name: "closure-review-mysql-found", enforce: "pre",
    transform(source, id) {
      if (!id.endsWith(mysqlFile)) return;
      const original = "  return { tag, author, post, owner, profile };";
      if (!source.includes(original)) throw new Error("Review schema insertion point missing");
      let code = source.replace(original, `
  const badge = s.model({ id: s.string().id(), slug: s.string().unique(), code: s.string().unique(), holders: s.toMany(() => holder) }).map("review_badges");
  const holder = s.model({ id: s.string().id(), badgeCode: s.string(), badge: s.toOne(() => badge).fields("badgeCode").references("code").onUpdate("cascade") }).map("review_holders");
  return { tag, author, post, owner, profile, badge, holder };`);
      const end = code.lastIndexOf("\n});");
      if (end < 0) throw new Error("Review suite insertion point missing");
      code = code.slice(0, end) + witnesses + code.slice(end);
      return { code, map: null };
    },
  }],
  test: { name: "closure-review-mysql", include: [mysqlFile], fileParallelism: false, minWorkers: 1, maxWorkers: 1 },
}];
