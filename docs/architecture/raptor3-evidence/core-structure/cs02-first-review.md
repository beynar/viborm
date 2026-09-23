# CS-02 first-package independent review

Date: 2026-09-13. Status: **BLOCKED; package preserved unchanged.**

Independent review rejected `cs02-qualification` for four concrete reasons:

1. its candidate instrumentation counted yielded writes but omitted actual
   ancestor, prior-sibling, and read-only subtree traversal;
2. its reference receipt used Node 24.14.0 instead of the required 24.21.0;
3. its measured reference contained unrecorded formatting drift and was not the
   accepted 6,031-line / 200,477-byte endpoint;
4. a repeated finalized membership publication retained the first placement's
   occurrence owner.

The sealed package remains historical evidence. It is not qualifying input to
CS-03. The bounded repair and fresh evidence are in `cs02-requalification`.
