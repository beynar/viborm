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
- Do not validate a shared worktree while a subagent is editing any source that
  the selected tests can import. Directory ownership does not isolate the
  runtime graph: a write test can transform a result module mid-edit. Wait for
  a stable tree, then run every bounded check serially.
- A process-group teardown falsifier must actually let its group leader exit.
  When that leader spawns the descendant under test, call `unref()` on the
  child; otherwise the witness measures the wall timeout instead of orphan
  cleanup. Verify the stop reason and the empty process group after return.
- On macOS, `kill(-pgid, 0)` or a second group signal can return `EPERM` after
  the leader and workers have already exited. Verify live group membership from
  `ps` state, ignore zombie-only groups, and tolerate `EPERM` only when a second
  `ps` check proves that no live member remains. Keep a low-memory RSS witness
  with a leader and worker exiting together so this safety race stays pinned.
- A non-configurable JavaScript data property can be redefined when every
  descriptor field and its value stay identical. To prove that an installed
  seam cannot be replaced, retry with a distinct value and verify the refusal;
  reinstalling the same object is not a replacement witness.
- Before starting another Node verification, inspect the process table for all
  Vitest, layer-runner, and TypeScript processes. Waiting for one observed PID
  is insufficient because another task can start its next phase immediately;
  make this preflight fail closed, not observational, and continue only after
  the complete test estate is process-table clean. After a launcher returns,
  verify the process table again before trusting its completion. In a Vitest
  workspace, pin focused file runs to one project or overlapping projects can
  execute the same file twice.
- Do not place an observational `ps` command before a test in the same shell
  sequence. Either inspect in a separate tool call or make the shell exit when
  any test process is found; otherwise an occupied machine falls through into
  the new run before the output can be evaluated.
- Do not reclaim a stale lock by checking a PID and then unlinking the shared
  path. Another contender can replace the file between those operations. Fail
  closed on stale or unreadable ownership, prove the process estate is empty,
  and require explicit removal.
- Before a focused Vitest run, read `vitest.workspace.ts` and use the declared
  project name exactly. Do not infer a project name from a package or directory
  label; a misspelled filter fails before collecting the intended witness.
- Before invoking a formatter through a package runner, verify the repository's
  configured formatter and that its installed entry point resolves. If one
  formatter shim points at a missing package, use the already-installed project
  formatter instead of changing dependencies merely to format the task diff.
- When a coverage score drops after test-tier reclassification, compare the
  files selected by the coverage project with the full owning-layer inventory
  before adding tests. Measure the full safe selection first; fix coverage
  routing when tested behavior was omitted from the report.
- A shared subsystem must not obtain coverage by running every suite that
  happens to import it. Select its owner contracts first, then add only the
  exact integration witness a missing boundary requires. Broad incidental
  selections duplicate work, obscure ownership, and can breach the RSS cap.
- A focused orchestration suite must not boot a lower layer only to prove
  parsing or routing. Replace the lower owner at its module boundary with a
  deterministic contract fake, and leave graph, storage, DDL, and provider
  behavior in their owning suites. Keep an end-to-end witness only when the
  cross-layer seam has a unique failure that neither owner can prove alone.
- When an integration test is replaced by a deterministic command-boundary
  test, inventory every observable output field first. A faster fake must still
  pin reviewed SQL parameters, exit status, cleanup, and other public command
  behavior; coverage improvement does not authorize silent output removal.
- When a strict coverage gate fails during branch validation, compare every
  uncovered source, owning test, and coverage configuration with the base
  revision. Test reachable branch behavior and remove branch-introduced dead
  fallbacks; do not manufacture a runtime witness for structurally unreachable
  baseline exhaustiveness code.
- A test fixture that registers process-global state must undo the registration,
  not only shut down the registered object. Verify the fixture in the complete
  shared-worker order because isolated-file success cannot expose a stale global
  provider.
- Size memory limits by workload and split a type graph instead of raising one
  monolithic heap. Keep Vitest at 768 MB, TypeScript shards at 1280 MB, and
  sample every complete process group against the shared 1536 MiB RSS ceiling.
  One allowlisted departure: an isolated live-PGlite provider stage may take
  2560 MiB, selected by importing a frozen named export rather than by any flag.
  It is a runaway detector, not a budget - PGlite's floor is 1294 MiB and it
  grows into whatever headroom it is given, so sizing the bar from observed
  maxima is circular.
  Describe a polling threshold as sampled, not as an OS-enforced hard limit.
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
- In a syntax census, define an inspectable lexical region and token family.
  Importing a domain module is not proof that every value in the consumer
  belongs to that domain. Give each detector a falsifier shaped like the retired
  implementation, not only a convenient invented spelling.
- Before adding tests for several physical forms of one logical value, define
  the logical domain once and thread that owner through input validation,
  result parsing, storage codecs, and migration conversion. Then test each
  physical form against the same boundary values; otherwise the tests can
  entrench contradictory domains instead of proving representation parity.
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
  For repeated hooks, state the ceiling per semantic invocation; a percentage
  of an amortized batch is invalid, and a fixed cost beyond 2×MAD is compared
  with an explicit per-invocation budget rather than treated as automatic
  failure.
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
- A new path alias is incomplete until every standalone resolver and config has
  been audited and its isolated project collects. A green main TypeScript or
  Vitest run does not prove that D1, worker, or other separately configured
  projects can resolve the alias.
- When concurrent work partially changes mixed files, validate the feature from
  an explicit clean snapshot: start from a known base, overlay only owned paths,
  and assert that excluded blobs still match the base. Never obtain that proof
  by reverting or cleaning the live worktree. Start validation only from a
  frozen HEAD, and never advance, mutate, or reuse its worktree while a
  validator or benchmark is running there; create each successor snapshot in a
  separate worktree before validating it.
- In zsh automation, never use `path` as a loop or shell variable: it aliases
  the executable search path and makes later commands disappear. Use a
  task-specific name such as `file_path`.
- Start multi-step mutation scripts with fail-fast shell behavior. A failed
  `git add` pathspec must stop before `git commit`; for a rename, stage the
  existing destination and the source directory instead of naming a source
  path that no longer exists.
- A performance program must name its own exact pre-feature runtime baseline.
  Do not reuse an earlier program's baseline merely because the benchmark
  protocol is shared: unrelated retained improvements can hide a regression in
  the feature under test. Candidate-only workloads may share the newer harness,
  but the control comparison still starts from the feature's true parent.
- When a mutable-value invariant is checked before an extension, middleware, or
  provider transform, map every execution route to the last transform and
  enforce the invariant again at that new trust boundary. Pin direct, queued,
  and batch routes with a transform-created falsifier; a pre-transform test does
  not prove provider dispatch is safe. Run the full type gate after focused
  runtime tests because transpilation can execute a witness that the public
  TypeScript contract still rejects.
- When a queued statement keeps private executable provenance beside its public
  parameter array, detach both representations at the queue boundary. A copied
  public bag is not a snapshot if later materialization reads an older mutable
  owner; mutate the source after queue admission and inspect the provider value.
- Copying an accessor descriptor onto a new object changes its receiver and can
  break WeakMap-backed or identity-sensitive getters. At a snapshot boundary,
  keep a provider-visible accessor carrier identity-opaque unless the contract
  explicitly permits rebinding; prove the choice with a receiver-sensitive
  getter, not descriptor equality alone.
- When a read-count test is meant to isolate diagnostic disclosure, use a value
  that the ordinary execution boundary classifies as opaque. A Proxy presenting
  a plain container legitimately participates in admission and final dispatch
  snapshots, so its reflection count measures those boundaries too and cannot
  prove that inactive instrumentation stayed inert.
- When hardening a representation boundary, inspect the downstream public
  identity contract before normalizing every admitted subtype. Remove hostile
  metadata without replacing an established local value such as Buffer unless
  the requested contract explicitly permits that observable change; prove both
  the hostile input and the compatible subtype in the full owning-layer suite.
- Keep logical-domain authentication separate from ambient-runtime identity
  trust. A signed or otherwise authenticated snapshot may carry a logical
  marker that unmarked live introspection cannot prove; treat the live shape as
  a candidate and validate it before adoption. Likewise, intrinsic slot and
  metadata reads can prove a built-in value's representation, but preserving
  identity is a separate boundary: trust only captured exact local prototypes,
  and normalize foreign-realm, subclassed, caller-owned custom-prototype, or
  own-shadowed values before downstream use.
- Use cardinality to attribute an opaque one-statement provider failure only
  when stronger execution evidence is absent. If an error carries a complete
  but mismatched correlation context, reject that stale context instead of
  letting cardinality overwrite the contradiction.
- When a transport close rejects, retain its exact handle only for cleanup
  retry; do not infer that it remains queryable. Some providers close admission
  before a later connection cleanup fails. Quarantine the handle, refuse new
  work and replacement initialization, and reopen the lifecycle only after the
  retry succeeds. Run observer, disposal, connect, query, and repeated-retry
  contracts; fixtures must withdraw injected failures before teardown.
- For a broad review or repair with independent ownership seams, launch bounded
  Sol-high agents in parallel for reproduction, owner analysis, and adversarial
  coverage. The root agent still inspects each artifact and reruns the decisive
  validation; delegation changes latency, not accountability.
- In CI, `git diff --check` on a clean checkout proves nothing, and a full-estate
  formatter can turn historical debt into an unrelated permanent red gate.
  Resolve the event's exact base commit, fetch it, and run whitespace and
  formatting checks over that committed delta.
- Test a declared runtime floor at the exact minimum version against the packed
  consumer artifact. The repository's development toolchain can require a
  newer patch without raising the package runtime floor; do not conflate those
  two contracts.
- A publication workflow must resume from every partially durable external
  state. Verify an existing registry version, draft release, published release,
  tag, and asset by identity before deciding to create, complete, or refuse;
  retrying a multi-call `create` command is not idempotency.
- `npm pack` does not prove the manifest that `npm publish` accepts. Run npm's
  package-metadata normalization against the packed package before publication
  and refuse any semantic rewrite; bin paths are a concrete failure mode.
- A documented release protection is not an implemented protection until the
  live repository or registry setting is provisioned. Separate code readiness
  from one-time control-plane setup and name both before the first release.
- When Arnaud says to merge a completed branch, finish the operation by pushing
  the resulting target branch unless he explicitly asks for a local-only merge.
