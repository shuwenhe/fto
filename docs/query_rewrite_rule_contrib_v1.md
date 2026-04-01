# Query Rewrite Rule Contribution Report

- K: 5
- Rules file: backend/config/query_rewrite_rules.json
- Harmful threshold (ndcg contribution): < 0
- Min hit queries to allow pruning: 2

## Overall

| Variant | Recall@K | MRR@K | NDCG@K |
| --- | ---: | ---: | ---: |
| Baseline (no rewrite) | 0.8333 | 1.0000 | 0.9459 |
| Full rules | 0.8333 | 1.0000 | 0.9459 |
| Pruned rules | 0.8333 | 1.0000 | 0.9459 |

## Term Contribution (full - remove_term)

| Match | Term | Hit Queries | Applied Queries | dRecall | dMRR | dNDCG |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 无线充电 | 充电 | 1 | 0 | 0.0000 | 0.0000 | 0.0000 |
| 无线充电 | 电能传输 | 1 | 1 | 0.0000 | 0.0000 | 0.0000 |
| 快充 | 快速充电 | 0 | 0 | 0.0000 | 0.0000 | 0.0000 |
| 快充 | 充电 | 0 | 0 | 0.0000 | 0.0000 | 0.0000 |
| 电池 | 储能 | 1 | 1 | 0.0000 | 0.0000 | 0.0000 |
| 电池 | 电芯 | 1 | 1 | 0.0000 | 0.0000 | 0.0000 |
| 逆变器 | 功率变换 | 0 | 0 | 0.0000 | 0.0000 | 0.0000 |
| 逆变器 | 电力电子 | 0 | 0 | 0.0000 | 0.0000 | 0.0000 |
| 变流器 | 功率变换 | 0 | 0 | 0.0000 | 0.0000 | 0.0000 |
| 变流器 | 电力电子 | 0 | 0 | 0.0000 | 0.0000 | 0.0000 |

## Harmful Terms

- none

## Protected by Min Samples

- none

