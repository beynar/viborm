# Intent Layer Construction Guide

You are building an **Intent Layer** for a codebase - a hierarchical system of AGENTS.md files that give AI agents the context they need to work effectively without re-discovering implicit knowledge on every task.

## The Problem You're Solving

Every time an agent starts a task, it enters a "dark room" - it has no idea where things are, what patterns exist, what mistakes to avoid, or why the code is structured the way it is. Code alone doesn't convey:

- Why abstractions exist
- What invariants must never be violated
- Where actual boundaries live between layers
- What past bugs shaped current patterns
- What looks wrong but is intentional

The Intent Layer solves this by placing dense context files at semantic boundaries throughout the codebase.

---

## Core Principles

### 1. Fractal Compression

The Intent Layer is hierarchical:
- **Leaf nodes** compress code into dense context
- **Parent nodes** compress their children (not raw code again)
- A 150-line parent might represent 10,000 lines of underlying code

This enables **progressive disclosure**: agents load high-level overview first, drilling into detail only when tasks require it.

### 2. Least Common Ancestor (LCA) Placement

Place facts at the **shallowest node** where they're always relevant:
- If a fact applies to all of `src/schema/`, put it in `src/schema/AGENTS.md`
- If it only applies to `src/schema/fields/`, put it there
- Never duplicate facts across siblings - move them to parent

Ask: "What's the shallowest node where this fact is always needed?"

### 3. Ownership Clarity

Every AGENTS.md must clearly state:
- What this area **owns** (its responsibilities)
- What it **doesn't own** (common confusions, with redirects)

This prevents agents from putting code in the wrong place.

### 4. Invisible Knowledge Priority

The most valuable content is what code doesn't show:
- Why was this pattern chosen over alternatives?
- What bug or failure led to this design?
- What invariants must never be violated?
- What looks wrong but is intentional?

If you're just describing what the code does, you're not adding value. Describe **why**.

---

## Phase 1: Discovery & Mapping

Before writing any content, understand the codebase structure.

### Step 1: Identify Semantic Boundaries

Look for natural divisions:
- Directory structure (often reflects architecture)
- Layer separations (validation → schema → engine → adapters)
- Module boundaries (clear public APIs)
- Concern groupings (all auth code, all database code)

Ask: "If I changed X, what else would I need to change?" Areas that change together belong together.

### Step 2: Map the Hierarchy

Create a tree of planned AGENTS.md locations:

```
/AGENTS.md                          # Root - architecture overview
├── src/layer1/AGENTS.md            # Layer overview
│   ├── sublayer/AGENTS.md          # Subdirectory (if complex enough)
├── src/layer2/AGENTS.md
│   └── critical-subdir/AGENTS.md
└── src/layer3/AGENTS.md
```

**Guidelines:**
- Root: 150-250 lines (10,000-foot view)
- Layer nodes: 120-180 lines (1,000-foot view)
- Leaf nodes: 80-120 lines (100-foot view)
- Maximum depth: 3-4 levels

### Step 3: Identify Critical Boundaries

Which separations cause the most confusion? These get:
- More emphasis in documentation
- Strategic repetition across relevant nodes
- Explicit anti-patterns

Example: "Query engine vs Adapter" boundary might appear in root AGENTS.md, query-engine/AGENTS.md, AND adapters/AGENTS.md because it's the #1 source of architectural violations.

---

## Phase 2: Knowledge Extraction

For each node, extract knowledge through systematic questioning. Start from **leaves and work up** - parent nodes summarize children.

### Questions to Answer for Each Node

#### Purpose & Ownership
- What does this area own? (one sentence)
- What does it explicitly NOT own? (common confusions)
- If code is put here that belongs elsewhere, where should it go?

#### Entry Points
- Which 3-5 files should someone read first?
- What's the main public API or interface?
- Which file is the "entry point" for this area?

#### Invisible Knowledge (CRITICAL - This Is the Value)
- What would surprise a new engineer?
- What past bugs or failures shaped current patterns?
- What design decisions were made and why?
- What alternatives were rejected and why?
- What invariants must NEVER be violated?
- What looks wrong but is actually intentional?

#### Patterns & Rules
- What's the canonical way to do X in this area?
- What are the 2-4 most important rules?
- For each rule: what happens if you violate it?

#### Anti-Patterns
- What should NEVER be done here?
- What mistakes do people commonly make?
- What code patterns indicate something is in the wrong layer?

#### Dependencies & Flow
- What does this area consume from other areas?
- What does it provide to other areas?
- How does data/control flow through here?

---

## Phase 3: Content Structure

Use this template for each AGENTS.md file:

```markdown
# [Area Name] - [One-Line Purpose]

**Location:** `path/to/directory/`
**Parent:** [Link to parent AGENTS.md] (if not root)
**Layer:** [Position in architecture]

## Purpose

[2-3 sentences on what this area does and why it exists]

## Why This Layer Exists

[The design rationale. What problem does this solve? What alternatives were rejected?
This is where invisible knowledge lives - the "why" that code doesn't show.]

---

## Entry Points

| File | Purpose | Lines |
|------|---------|-------|
| `main-file.ts` | [description] | ~X |
| `types.ts` | [description] | ~X |

---

## What Lives Here

[Bulleted list of concepts this area owns]

## What Doesn't Live Here

[Explicit exclusions with redirects to correct location]
❌ **[Concept]** → `path/to/correct/location/`

---

## Core Rules

### Rule 1: [Name]
[What the rule is]

**Why:** [The invisible knowledge - what breaks if violated, what past bug led to this]

### Rule 2: [Name]
[Continue for 2-4 most important rules]

---

## Anti-Patterns

### [Anti-pattern Name]
[What NOT to do - described without verbose code, just the concept and consequence]

### [Anti-pattern Name]
[Continue for 3-5 most common mistakes]

---

## [Section specific to this layer]

[Tables, diagrams, or other content specific to this area.
Examples: capability matrices, type flow diagrams, workflow descriptions]

---

## Common Tasks

### [Task Name]
1. [Step 1]
2. [Step 2]
3. [Step 3]

### [Task Name]
[Continue for 2-4 most common tasks]

---

## Invisible Knowledge

### [Topic]
[Non-obvious design decision or historical context]

### [Topic]
[Continue for 2-4 important pieces of invisible knowledge]

---

## Related Layers

| Layer | Relationship |
|-------|--------------|
| **[Layer Name]** ([link]) | [How they interact] |
```

---

## Phase 4: Content Guidelines

### Do Include
- **Why** things are the way they are (design rationale)
- **What breaks** if rules are violated (consequences)
- **Where to look** for specific concerns (navigation)
- **What NOT to do** (anti-patterns with brief explanation)
- **Minimal examples** for critical patterns (2-4 lines max)
- **Historical context** that shapes current design

### Don't Include
- **Verbose code examples** (code is in the codebase)
- **API documentation** (that's what docstrings are for)
- **Tutorials** (too long, agents need dense briefings)
- **Obvious information** (what code already shows)
- **Duplicated content** (use LCA placement)

### Tone
Write like you're briefing a senior engineer who just joined:
- Assume technical competence
- Be direct and dense
- Focus on what's non-obvious
- Use tables and lists for scannability

---

## Phase 5: Hierarchical Compression

After leaf nodes exist, build parent nodes by:

### 1. Summarizing Children
Don't repeat details - reference child AGENTS.md files:
```markdown
## Subdirectories

- `fields/` - Field type definitions ([fields/AGENTS.md](fields/AGENTS.md))
- `model/` - Model composition ([model/AGENTS.md](model/AGENTS.md))
```

### 2. Adding Cross-Cutting Concerns
What applies across multiple children? Put it in parent:
- Shared patterns
- Common pitfalls that span areas
- Architectural decisions that affect all children

### 3. Creating Navigation Aids
Help agents find the right place:
```markdown
## Which Layer Do I Modify?

| I want to... | Go to |
|--------------|-------|
| Add field type | [fields/AGENTS.md](fields/AGENTS.md) |
| Add query operator | [query-engine/](query-engine/AGENTS.md) + [adapters/](adapters/AGENTS.md) |
```

### 4. Emphasizing Critical Boundaries
The most important separations get:
- Dedicated sections with diagrams
- Explicit ❌/✅ examples (minimal)
- Appearance in multiple nodes (strategic repetition)

---

## Phase 6: Validation

Test the Intent Layer by simulating agent tasks:

### Navigation Test
Can an agent find the right file in 2-3 hops from root?
- Start at root AGENTS.md
- Follow links based on task description
- Should reach correct location quickly

### Boundary Test
Does an agent correctly identify which layer owns what?
- Give agent a task that spans layers
- Check if it modifies correct files
- Check if it avoids putting code in wrong layer

### Anti-Pattern Test
Does an agent avoid documented mistakes?
- Review agent-generated code
- Check for anti-patterns listed in AGENTS.md
- Verify agent followed stated rules

### Context Test
Can an agent implement a feature touching multiple layers?
- Complex feature requiring coordination
- Agent should understand data flow
- Agent should update all necessary locations

---

## Quality Metrics

### Size Targets
| Level | Target Lines | Represents |
|-------|--------------|------------|
| Root | 150-250 | Entire codebase |
| Layer | 120-180 | Major subsystem |
| Subdirectory | 80-120 | Specific concern |

### Compression Ratio
- Total AGENTS.md lines should be **10-20%** of code lines
- Smaller ratio = more compressed = better for large codebases
- Larger ratio acceptable for complex architectures

### Coverage
- Every major directory should have AGENTS.md or be covered by parent
- Critical boundaries documented in multiple relevant nodes
- No orphan areas that agents can't navigate to

---

## Common Mistakes to Avoid

### ❌ Single Bloated Root File
Putting everything in root defeats progressive disclosure. Agents load entire file even for small tasks.

### ❌ Duplicating Code Documentation
If you're describing what code does, you're not adding value. Describe **why**.

### ❌ Human-Oriented Structure
Agents are token-limited. Dense, scannable content beats narrative prose.

### ❌ Over-Compression
Too terse = missing critical context. If agents keep making the same mistakes, add more detail.

### ❌ Under-Compression
Too verbose = wasted tokens, buried signal. If agents skip sections, compress them.

### ❌ No Maintenance Plan
Intent Layers rot without upkeep. Update AGENTS.md when architecture changes.

### ❌ Missing Anti-Patterns
What NOT to do is often more valuable than what to do. Agents learn by counter-example.

### ❌ Forgetting Invisible Knowledge
The most valuable content is what code doesn't show. If you're not capturing design rationale, you're missing the point.

---

## Maintenance

### When to Update
- Architecture changes (new layer, moved boundary)
- Repeated agent mistakes (add anti-pattern)
- New critical pattern (add to rules)
- Major refactoring (update file references)

### Update Process
1. Update leaf nodes first (specific changes)
2. Update parent nodes if cross-cutting
3. Update root only if architecture-level

### Staleness Prevention
- Include file references with line counts (can verify mechanically)
- Update AGENTS.md in same PR as architecture changes
- Periodic review: do line counts still match?

---

## Example: Before and After

### Before (No Intent Layer)
Agent receives task: "Add a new query operator `startsWith`"

Agent explores randomly, finds similar code, copies pattern, puts implementation in wrong layer, misses adapter implementations for MySQL and SQLite, creates bug that only manifests in production with MySQL.

### After (With Intent Layer)
Agent reads root AGENTS.md, sees "New query operator? → query-engine + adapters", navigates to both AGENTS.md files, sees:
- Rule: "Every operator needs implementation in ALL THREE adapters"
- Anti-pattern: "Hardcoded PostgreSQL syntax in query-engine"
- Common task: Step-by-step for adding operator

Agent implements correctly in all locations, tests across databases, no production bug.

---

## Final Checklist

Before considering the Intent Layer complete:

- [ ] Root AGENTS.md provides architecture overview
- [ ] Every major layer has AGENTS.md
- [ ] Critical boundaries documented with examples
- [ ] Anti-patterns listed for common mistakes
- [ ] Navigation aids help agents find correct layer
- [ ] Invisible knowledge captured (why, not just what)
- [ ] Cross-references link related areas
- [ ] Total size within 10-20% of code size
- [ ] Validated with simulated agent tasks
