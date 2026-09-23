#!/bin/zsh
# Alternating A/B pairs over the six cells, both engines, both arms.
# usage: ab-run.sh <outfile> <pairs> [arms]   arms default "before after"
SP2=/private/tmp/claude-501/-Users-arnaud-code-viborm/c2c775da-2927-4590-8677-3bb0f5d1aa98/scratchpad/perf2
OUT=$1; PAIRS=${2:-3}; ARMS=${3:-"before after"}
: > $OUT
run() { # arm engine workload stage iters warmup
  cd $SP2/ab/$1
  TMPDIR=/private/tmp/viborm-g4-perf2-tmp VIBORM_BENCH_ENGINE=$2 \
    node --expose-gc $SP2/ab-stage.mjs $SP2/ab/$1 $3 $4 $5 $6 2>>$SP2/ab-errors.log \
    | sed "s/^{/{\"arm\":\"$1\",/" >> $OUT
}
CELLS=(
  "scalar-find-unique prepare 20000 2000"
  "fixed-collection-rowref-20 prepare 20000 2000"
  "fixed-collection-rowref-1000 prepare 3000 600"
  "bulk-update-returning-100 prepare 5000 1000"
  "nested-conditional-found full 3000 600"
  "scalar-find-unique full 5000 1000"
)
for pair in $(seq 1 $PAIRS); do
  for cell in $CELLS; do
    set -- ${=cell}
    for engine in shipped candidate; do
      for arm in ${=ARMS}; do run $arm $engine $1 $2 $3 $4; done
    done
  done
done
wc -l $OUT
