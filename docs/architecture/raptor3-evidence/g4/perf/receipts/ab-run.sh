#!/bin/zsh
SP=/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/perf-safe
AB=$SP/ab
OUT=$SP/ab-samples.jsonl
: > $OUT
run() { # arm engine workload stage iters warmup
  cd $AB/$1
  TMPDIR=/private/tmp/viborm-g4-perfsafe-tmp VIBORM_BENCH_ENGINE=$2 \
    node --expose-gc $SP/ab-stage.mjs $AB/$1 $3 $4 $5 $6 2>>$SP/ab-errors.log \
    | sed "s/^{/{\"arm\":\"$1\",/" >> $OUT
}
for pair in 1 2 3; do
  for cell in "scalar-find-unique prepare 20000 2000" "fixed-collection-rowref-20 prepare 20000 2000" "bulk-update-returning-100 prepare 5000 1000" "nested-conditional-found full 3000 600"; do
    set -- ${=cell}
    for engine in shipped candidate; do
      run before $engine $1 $2 $3 $4
      run after  $engine $1 $2 $3 $4
    done
  done
done
wc -l $OUT
