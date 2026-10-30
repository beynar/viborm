# Raptor 3 evidence

The written reports of the Raptor 3 engine program (gates G0 to G4, September
2026): one summary per gate or review, in this folder.

The raw evidence those reports cite (run logs, generated corpora, parity
receipts, inventories, the recursive-query proofs; 28,775 files, 3.5 GB) was
removed from the tree on 2026-10-21. Nothing read it: every CI job already
checked out without this folder. It is still in Git history: to read one file,
`git show 29e43e6de:docs/architecture/raptor3-evidence/<path>`, or to restore the
whole tree, `git checkout 29e43e6de -- docs/architecture/raptor3-evidence`.
Paths into `g3/`, `g4/`, `recursive-query/` and the other subfolders, in these
reports and in `src/query-engine/raptor3/AGENTS.md`, refer to that commit.
