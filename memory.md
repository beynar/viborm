# Albert's procedural memory

- Before a large refactor or dependency restore, verify that the workspace has
  enough durable free space for installs, build output, and test databases. If a
  write fails with `ENOSPC`, stop and ask for space to be freed. Do not delete
  dependency trees, generated output, or user files as an improvised recovery.
- When a request says "every" or otherwise claims repository-wide coverage,
  derive the search root from that scope. Scan all relevant tracked and
  untracked files, then report the exact root and file count used for
  verification.
- When Blume development owns `.blume`, run isolated checks directly with
  `pnpm exec blume check --isolated`; do not pass `--isolated` through the pnpm
  script separator because Blume receives the separator as an argument.
- Before running a large Vitest selection, force single-file execution and cap
  the Node heap. Launch the test process in its own process group, and terminate
  that whole group on timeout, interruption, or parent exit so worker processes
  cannot survive and exhaust the development machine.
- Before starting another Node verification, inspect the process table for all
  Vitest, layer-runner, and TypeScript processes. Waiting for one observed PID
  is insufficient because another task can start its next phase immediately;
  make this preflight fail closed, not observational, and continue only after
  the complete test estate is process-table clean. After a launcher returns,
  verify the process table again before trusting its completion. In a Vitest
  workspace, pin focused file runs to one project or overlapping projects can
  execute the same file twice.
- When a coverage score drops after test-tier reclassification, compare the
  files selected by the coverage project with the full owning-layer inventory
  before adding tests. Measure the full safe selection first; fix coverage
  routing when tested behavior was omitted from the report.
- A test fixture that registers process-global state must undo the registration,
  not only shut down the registered object. Verify the fixture in the complete
  shared-worker order because isolated-file success cannot expose a stale global
  provider.
- Size memory limits by workload instead of reusing the Vitest limit. In this
  repository the complete TypeScript graph exhausts 2 GB but passes with a
  4 GB ceiling; keep Vitest at 768 MB and record both caps in the command.
- A green full type-check can hide a layer-specific type-memory regression
  because its heap is larger. Run the owning layer after adding a recursive
  mapped union. If the same structural type is instantiated throughout a model
  graph, expose it through an interface so TypeScript can cache the boundary;
  verify again under the layer's smaller heap before keeping the abstraction.
- In zsh, never use `path` as a loop or local variable: it is tied to `PATH` and
  makes later commands disappear. Use a concern-specific name such as
  `report_file`, then verify the remaining commands ran.
- In shell search commands, never place raw Markdown backticks inside a
  double-quoted argument: zsh treats them as command substitution. Use a
  single-quoted shell pattern or search for the surrounding words instead.
- Treat a SQL predicate's value provenance and its statement qualifier as
  independent facts. A planning value can be correct while an alias copied from
  a read statement makes the final write invalid. Pass the physical or aliased
  qualifier at the statement boundary, and verify the same mutation on both
  transaction and atomic-batch substrates.
- When a repository counts capability refusals, reserve its unsupported-error
  type for real public capability boundaries. Impossible compiler states use
  the internal error model; otherwise a semantic inventory reports invented
  product limitations.
- Before widening a race guard for a proposed representation, trace the public
  schema to confirm that the representation is reachable. If the current schema
  makes the added value identical to an existing captured value, the extra guard
  is speculative redundant defense and must be removed.
- When relation optionality affects an API, separate three questions before
  deriving capabilities: may the public slot be empty, can stored membership be
  cleared while both records survive, and is non-empty membership valid. Do not
  use one `optional` flag as a proxy for all three.
