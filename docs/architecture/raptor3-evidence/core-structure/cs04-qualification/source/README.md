# CS-04 final source chain

The selected source is reconstructed from the accepted member-scope baseline
in two explicit steps:

1. Apply `candidate-foundation.patch`. It contains the same-owner structural
   cleanup and the repeated-enclosing-placement repair.
2. Apply one feature patch: `candidate-extension-a.patch`,
   `candidate-extension-b.patch`, or `candidate-extension-a-b.patch`.

The feature patch headers retain their original scope-baseline blob identities.
Their hunks are context-compatible and non-overlapping with the foundation
patch; this does not make the foundation work part of an extension delta.
`candidate-final.patch` is the direct scope-baseline-to-selected-source patch
and provides an independent apply/reverse check for the composed endpoint.

`cost.json` records the four source identities and separates foundation cost
from marginal feature cost. `source-accounting.json` records every file and
checksum in the 12-owner core and 28-owner broader census. The exact standalone
A and B identities respectively pass their focused 6/6 and 4/4 contracts in
receipts `ObEKKZ` and `bSGBoZ`. Full seeded-campaign and saved-corpus replay
qualification is owned by the composed source.
