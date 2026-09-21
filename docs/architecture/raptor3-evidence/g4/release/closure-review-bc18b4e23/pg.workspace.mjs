const root = process.cwd();
const pgFile = "tests/providers/docker/pg-captured-set-concurrency.test.ts";
export default [{
  extends: `${root}/vitest.config.ts`,
  root,
  plugins: [{
    name: "closure-review-schedule",
    enforce: "pre",
    transform(source, id) {
      if (!id.endsWith(pgFile)) return;
      let code = source.replaceAll('"fcpg_closure"', '"albert_closure_review_20260921"');
      if (process.env.CLOSURE_REVIEW_LATE === "1") {
        const title = '"batch route: a member whose required membership was reassigned is not deleted for the parent that no longer holds it"';
        const start = code.indexOf(title);
        if (start < 0) throw new Error("Review witness title was not found");
        const tail = code.slice(start);
        const placement = 'placement: "before-premises"';
        const offset = tail.indexOf(placement);
        if (offset < 0 || offset > 1000) throw new Error("Review placement was not found beside its title");
        const position = start + offset;
        code = code.slice(0, position) + 'placement: "between-premises-and-writes"' + code.slice(position + placement.length);
      }
      if (process.env.CLOSURE_REVIEW_LISTENER === "1") {
        for (const [title, verb] of [
          ['"batch route: a captured row that stops matching between the last premise and the first write is not deleted, and the effects that committed are reported"', "deleteMany"],
          ['"batch route: a root UPDATE in the same window leaves the row that stopped matching untouched, and never reaches its non-RETURNING read-back"', "updateMany"],
        ]) {
          const start = code.indexOf(title);
          const end = code.indexOf("\n    test(", start + title.length);
          if (start < 0 || end < 0) throw new Error("Listener witness block missing");
          let block = code.slice(start, end);
          if (!block.includes("const client = boot(driver);")) throw new Error("Listener client insertion missing");
          block = block.replace("const client = boot(driver);", `const client = boot(driver).$extends({
            name: "review-failed-outcome", query: { note: { ${verb}({ proceed, onWriteOutcome }) {
              onWriteOutcome(() => { throw new Error("review write-outcome listener failed"); });
              return proceed();
            } } },
          });`);
          block = block.replace("expect(messageOf(raised))", "expect.soft(messageOf(raised))");
          block = block.replace("expect(progressOf(raised))", "expect.soft(progressOf(raised))");
          code = code.slice(0, start) + block + code.slice(end);
        }
      }
      return { code, map: null };
    },
  }],
  test: {
    name: "closure-review",
    include: [pgFile],
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
  },
}];
