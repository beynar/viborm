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
- Before a focused Vitest run, read `vitest.workspace.ts` and use the declared
  project name exactly. Do not infer a project name from a package or directory
  label; a misspelled filter fails before collecting the intended witness.
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
- When compressing a public API, inventory the existing owner of every required
  fact before proposing syntax. Do not add a selector, options object, or atomic
  configuration as a second spelling for facts the current fluent API already
  states; a new spelling earns its place only by representing independent truth.
- When a definition pipeline mutates hydrated or cached names, place identity
  preflight before the first mutation—not merely before the final index or I/O.
  Pin that a refused rebind leaves earlier consumers' names and behavior intact.
- For one dependency repair in a workspace with ranged versions, do not use a
  broad `pnpm update`: it refreshes unrelated lockfile resolutions.
  Change the one manifest entry, then run an offline lockfile-only install and
  verify that the lock diff contains only that package and its required
  transitive changes before synchronizing `node_modules`.
- When an explicit implementation request supersedes a plan's prototype keep
  gate, do not report the old gate as the endpoint. Keep the safety invariants,
  identify the smallest exact semantic fact the engine lacks, and prototype
  that fact through its existing owner until the capability works or a real
  provider impossibility is proved.
- Permission to accept partial commits does not permit a guard-to-write TOCTOU
  window. A premise that protects a write must share its atomic database unit;
  otherwise lower the premise into conditional DML or keep the substrate
  boundary explicit.
- Do not widen a public scalar naming token into an array merely because its
  storage expands to several members. When schema arity and order are already
  known, keep the public token scalar and let one topology owner derive the
  complete ordered group.
- Do not turn a raw unsupported-error constructor census into a product backlog.
  One constructor can format several distinct boundaries, while one capability
  can cross several constructors. Classify public shapes and semantic reasons
  first; use the raw count only as an audit checksum.
- When two roadmap items consume the same semantic fact, present them under one
  user-facing capability but keep their execution owners distinct. Name the
  shared truth, show what each consumer does with it, and separate unrelated
  work that merely happens to share an error factory.
- For an unreleased product, design the final V1 representation directly. Do
  not add dual readers, legacy snapshot shims, or manual compatibility
  choreography for a format no user has received. Treat ordinary future schema
  evolution separately: automate exact conversions and fail loudly when data
  cannot fit the new domain.
- In a rollback or uniqueness falsifier, derive the duplicate key from the row
  that established the constraint. A visually similar hand-written key is not
  evidence of a collision; assert the duplicate equality before execution when
  the witness is assembled indirectly.
- Before propagating projection demand across recursive compilers, distinguish
  a projection-only field set from one that also controls write ordering. Add
  remote field demand only to the projection owner; otherwise asking for one
  more value can silently move a write across a key-transition barrier.
- When a generated string will be cached, measure retained heap as well as
  construction throughput. Repeated `+=` can benchmark faster while retaining a
  large cons-string tree; use flat assembly when the cached representation must
  stay compact, and verify both first-use latency and post-GC retention.
- Treat allocation-profile stack attribution as inclusive unless the report
  explicitly names self size. Do not describe an inclusive frame as one direct
  allocation or copy; isolate the mechanism with a controlled before/after
  probe, then confirm its effect on the faithful complete workload.
- Keep HeapProfiler sampling uncertainty separate from run-to-run MAD. Clearing
  2×MAD does not make a delta trustworthy when it is smaller than the
  independent A/B sampling standard error. Preserve that result as a diagnostic
  and repeat it at an appropriate interval before using it as a keep decision.
- When V8 allocation sampling includes collected objects across many hot-path
  iterations, use a coarse interval such as 8 KiB; a 128-byte interval can make
  the inspector response exceed Node's maximum string size. Reserve a fine
  interval for a bounded operation, measure an empty-profile control, and check
  retained heap in a fresh process without the profiler.
- When replacing per-call callbacks with stable callbacks, measure retained heap
  before keeping the change. Reuse an existing persistent closure in more than
  one continuation role when signatures permit; otherwise a large transient
  allocation win can hide a per-parser retained-state regression.
- Size CPU and wall-time runs so each measured interval is long enough to
  dominate timer and process-start noise. More short samples do not repair a
  noisy interval; increase useful work per sample before interpreting MAD.
- When asked to add regression coverage, test the existing public contract. Do
  not turn a documented limitation into an API or architecture redesign unless
  the user explicitly asks to change that contract. If an exact assertion would
  require such a redesign, pin the supported behavior and report the limitation
  separately.
- When a user accepts a safety or consistency trade-off while revising an
  architecture plan, encode it as the recommended route with its exact failure
  contract. Do not preserve the superseded hard boundary, and do not mistake a
  plan amendment for authorization to implement production code.
- When one architecture plan depends on prototypes from another, rebase it on
  the prototypes' recorded dispositions before implementation. Name retained
  owners as dependencies, treat rejected concepts as forbidden—not missing—and
  replace only the narrow responsibility that the downstream plan genuinely
  still needs.
- Assert one concurrent winner only when the contenders are synchronized to the
  same captured premise. Unsynchronized transactions can serialize, observe
  different states, and both succeed under legitimate last-writer semantics.
- In a duplicate-skipping pipeline, an attempted key is not yet a resolved row.
  Preserve every child attempt in input order and coalesce only the downstream
  effect after the target's existence is known or tested by the write itself.
- For MySQL same-table insertion, distinguish an allowed aliased outer
  `INSERT ... SELECT ... FROM target` from a forbidden same-table subquery.
  Verify the final SQL on a real server instead of inferring legality from a
  nearby subquery restriction.
- After a production deployment, verify the exact user-facing HTTPS path from
  a real browser before declaring success. An independent fetch proxy proves
  the origin is reachable, but it can bypass the user's DNS, TLS, and network
  policy boundary; when the two disagree, inspect the local denial response and
  report that boundary explicitly.
