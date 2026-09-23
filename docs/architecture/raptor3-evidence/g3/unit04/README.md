# G3-04 qualification evidence

This directory contains the source-bound evidence for the frozen G3-04
qualification. Start with [qualification-report.md](qualification-report.md)
for the result and [qualification-index.json](qualification-index.json) for the
machine-readable inventory. [retained-files.json](retained-files.json) defines
the compact retained tree; `SHA256SUMS` verifies it.

Large nonselected raw campaign corpora remain local evidence. They are not part
of the retained tree. All 200 G3 child corpora are retained losslessly as gzip
archives with adjacent archive descriptors.
