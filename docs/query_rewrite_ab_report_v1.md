# Query Rewrite A/B Report

- K: 5
- Queries: 5
- Rewrite applied: 2/5 (40.00%)
- Rules: backend/config/query_rewrite_rules.json

## Summary

| Metric | Base | Rewrite | Delta |
| --- | ---: | ---: | ---: |
| Recall@5 | 0.8333 | 0.8333 | 0.0000 |
| MRR@5 | 1.0000 | 1.0000 | 0.0000 |
| NDCG@5 | 0.9459 | 0.9407 | -0.0052 |

## Per Query Delta (Top 10 by NDCG gain)

| Query ID | Rewrite Applied | Delta Recall | Delta MRR | Delta NDCG |
| --- | ---: | ---: | ---: | ---: |
| q1 | yes | 0.0000 | 0.0000 | 0.0000 |
| q3 | no | 0.0000 | 0.0000 | 0.0000 |
| q4 | no | 0.0000 | 0.0000 | 0.0000 |
| q5 | no | 0.0000 | 0.0000 | 0.0000 |
| q2 | yes | 0.0000 | 0.0000 | -0.0262 |

