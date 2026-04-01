# Query Rewrite Rule Contribution Report

- K: 5
- Rules file: backend/config/query_rewrite_rules.json
- Harmful threshold (ndcg contribution): < 0

## Overall

| Variant | Recall@K | MRR@K | NDCG@K |
| --- | ---: | ---: | ---: |
| Baseline (no rewrite) | 0.8333 | 1.0000 | 0.9459 |
| Full rules | 0.8333 | 1.0000 | 0.9407 |
| Pruned rules | 0.8333 | 1.0000 | 0.9459 |

## Term Contribution (full - remove_term)

| Match | Term | dRecall | dMRR | dNDCG |
| --- | --- | ---: | ---: | ---: |
| 散热 | 热管理 | 0.0000 | 0.0000 | -0.0018 |
| 散热 | 温控 | 0.0000 | 0.0000 | -0.0018 |
| 无线充电 | 充电 | 0.0000 | 0.0000 | 0.0000 |
| 无线充电 | 电能传输 | 0.0000 | 0.0000 | 0.0000 |
| 快充 | 快速充电 | 0.0000 | 0.0000 | 0.0000 |
| 快充 | 充电 | 0.0000 | 0.0000 | 0.0000 |
| 电池 | 储能 | 0.0000 | 0.0000 | 0.0000 |
| 电池 | 电芯 | 0.0000 | 0.0000 | 0.0000 |
| 逆变器 | 功率变换 | 0.0000 | 0.0000 | 0.0000 |
| 逆变器 | 电力电子 | 0.0000 | 0.0000 | 0.0000 |
| 变流器 | 功率变换 | 0.0000 | 0.0000 | 0.0000 |
| 变流器 | 电力电子 | 0.0000 | 0.0000 | 0.0000 |

## Harmful Terms

- 散热 -> 热管理 (dNDCG=-0.0018)
- 散热 -> 温控 (dNDCG=-0.0018)

