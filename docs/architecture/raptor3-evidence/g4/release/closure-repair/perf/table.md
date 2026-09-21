| cell | pass | baseline CPU µs/op | candidate | CPU ratio | wall ratio | valid | statements B/C |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| bulk-update-returning-100/full | 1 | 129.37 | 121.18 | **0.937** | 0.922 | true | 1/1 |
| bulk-update-returning-100/prepare | 1 | 20.64 | 32.72 | **1.585** | 1.234 | true | 1/1 |
| fixed-collection-rowref-1000/parse | 1 | 441.98 | 306.50 | **0.693** | 0.702 | true | 1/1 |
| key-transition-cascade/full | 1 | 108.44 | 97.08 | **0.895** | 1.010 | true | 3/3 |
| nested-conditional-found/full | 1 | 157.98 | 151.59 | **0.960** | 1.119 | true | 4/4 |
| nested-conditional-missing/full | 1 | 154.39 | 127.97 | **0.829** | 0.947 | true | 4/4 |
| bulk-update-returning-100/full | 2 | 130.08 | 122.49 | **0.942** | 0.928 | true | 1/1 |
| bulk-update-returning-100/prepare | 2 | 21.33 | 33.56 | **1.573** | 1.248 | true | 1/1 |
| fixed-collection-rowref-1000/parse | 2 | 446.57 | 303.82 | **0.680** | 0.687 | true | 1/1 |
| key-transition-cascade/full | 2 | 111.27 | 99.09 | **0.891** | 1.010 | true | 3/3 |
| nested-conditional-found/full | 2 | 158.84 | 152.03 | **0.957** | 1.100 | true | 4/4 |
| nested-conditional-missing/full | 2 | 185.00 | 141.46 | **0.765** | 0.944 | true | 4/4 |
