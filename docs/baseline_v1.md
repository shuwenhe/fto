# 检索基线冻结 v1

冻结时间：2026-03-31
目标：固定当前检索+排序能力，作为后续优化对照基线。

## 1. 数据快照

文件与 SHA256：

- data_sources/patents.jsonl
  - 6b081961d3075753e063a41649b6eec8d6e0c373996b514daaa286857a86b43a
- data_sources/patents.json
  - 45ca841d0d3315f630bb45da6358fbd7641416f1ba5a3f3379e436d4c4c3b454
- data_sources/queries.jsonl
  - 58469c66b455a27135afcacf311b040db4f13b8f3c7b5d686edf93a45b1043fb
- data_sources/qrels.jsonl
  - 3ff5b5bd1d769c9c687a5b4a0eca4721bda5e42d93cbb745b186e6e3921cd064

## 2. 固定参数

- top-k: 5
- 词法权重：title*4, abstract*2, claim*3, keyword*2
- 语义向量：splitWords + CJK bigram + cosine similarity
- 融合权重：lexical_norm*0.65 + semantic_norm*0.35
- 双路召回深度：max(6, k*3)
- 最终排序：fusion desc，若并列按 lexical desc

## 3. 复现命令

在 /app/fto 下执行：

```bash
sha256sum data_sources/patents.jsonl data_sources/patents.json data_sources/queries.jsonl data_sources/qrels.jsonl
node scripts/eval_retrieval.mjs --k 5
node scripts/compare_online_offline.mjs --k 5 --sample 5 --seed 20260331 --base-url http://127.0.0.1/fto/api
```

## 4. 当前基线结果

离线评测：

- Eval@5
- queries=5
- Recall@5=0.8333
- MRR@5=1.0000
- NDCG@5=0.9459

线上/离线一致性：

- ConsistencyCheck@5
- sample=5 seed=20260331 baseUrl=http://127.0.0.1/fto/api
- passed=5 failed=0

## 5. 锁定策略

以下任一变更都需升级基线版本号（v1 -> v2）：

- 数据文件内容变更（哈希变化）
- 排序参数变更
- 检索逻辑或特征工程变更
- 线上接口任务流程变更（影响 top-k 产出）
