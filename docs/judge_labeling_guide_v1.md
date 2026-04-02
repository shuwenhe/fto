# Judge 标注员操作说明 v1

本说明用于补充 [qrels.jsonl](/home/shuwen/fto/data_sources/qrels.jsonl) 中供 judge 训练使用的相关性标签。目标是形成稳定、可复核、可训练的 4 档 `relevance` 标签，再由训练脚本映射成 `low / medium / high` 三类。

## 一、输出格式

标注结果写入 JSONL，每行一条：

```json
{"query_id":"q13","patent_id":"CN123456789A","relevance":2}
```

字段说明：

- `query_id`: 必填，对应 [queries.jsonl](/home/shuwen/fto/data_sources/queries.jsonl) 中已有 query
- `patent_id`: 必填，待标注专利号
- `relevance`: 必填，取值只能是 `0/1/2/3`

模板文件：

- [qrels_template.jsonl](/home/shuwen/fto/data_sources/qrels_template.jsonl)

## 二、标签定义

统一使用 4 档标签：

- `0`: 无明显相关。只共享行业背景或泛化词汇，不构成有效风险参考。
- `1`: 弱相关。有局部术语、部件或场景重合，但核心技术路线不一致。
- `2`: 中相关。技术目标、关键结构、关键步骤中至少两项明显接近，值得进一步人工比对。
- `3`: 高相关。核心方案、关键结构或关键方法高度一致，属于高风险候选。

训练时的映射关系：

- `0/1` -> `low`
- `2` -> `medium`
- `3` -> `high`

## 三、标注步骤

1. 打开对应 query，先读 `query` 和 `desc`，明确要找的技术意图。
2. 查看候选专利的 `title`。
3. 查看 `abstract`，必要时再看 `claim`。
4. 按技术相似度给出 `relevance`。
5. 如果两档之间难以区分，优先保守打低一档，避免把 `1` 误标为 `3`。

## 四、判定准则

按以下四个维度综合判断：

1. 技术目标是否一致
2. 核心结构或模块是否一致
3. 关键步骤或方法流程是否一致
4. 关键词命中是否反映真实技术相似，而不是表面词汇重合

推荐判断方式：

- 只有场景词相同，没有技术方案重合：`0`
- 有部件或术语命中，但关键结构不同：`1`
- 关键结构和方法有明显接近，但仍存在核心差异：`2`
- 核心结构和方法都高度接近，差异主要在实现细节：`3`

## 五、每个 query 的配额要求

每个 query 建议标注 8 到 12 条候选，尽量满足：

- `relevance=3` 至少 1 条
- `relevance=2` 至少 2 条
- `relevance=0/1` 至少 3 条

如果某个 query 很难找到 `3`，可以没有 `3`；但不要长期缺少 `2`。`medium` 样本是当前最需要补齐的部分。

## 六、禁止事项

- 不要只看标题关键词就打 `3`
- 不要因为国家、申请人不同就直接打 `0`
- 不要把所有中间态都压成 `1`
- 不要在同一 query 下只标最像的几条样本

## 七、复核建议

每完成 10 个 query，抽 2 个 query 做复核，重点检查：

- `relevance=2` 是否真的代表“值得进一步比对”
- `relevance=3` 是否打得过宽
- 是否存在大量应为 `2` 却被打成 `1`

## 八、推荐工作流

1. 先在单独文件中补标，例如 `qrels_batch_20260402.jsonl`
2. 跑分布检查脚本确认类别和 query 覆盖
3. 人工抽样复核
4. 再合并进 [qrels.jsonl](/home/shuwen/fto/data_sources/qrels.jsonl)

分布检查脚本：

- [check_qrels_distribution.py](/home/shuwen/fto/scripts/check_qrels_distribution.py)
