#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${ROOT_DIR}/logs"
TS="$(date +%Y%m%d_%H%M%S)"
RUN_DIR="${LOG_DIR}/joint_tuning_8x310p3_${TS}"
ARTIFACT_DIR="${RUN_DIR}/artifacts"
RESULTS_JSONL="${RUN_DIR}/results.jsonl"
LEADERBOARD_JSON="${RUN_DIR}/leaderboard.json"
LEADERBOARD_MD="${RUN_DIR}/leaderboard.md"

: "${ASCEND_VISIBLE_DEVICES:=0,1,2,3,4,5,6,7}"
: "${TENSOR_DEVICE:=npu}"
: "${MASTER_ADDR:=127.0.0.1}"
: "${MASTER_PORT:=29511}"
: "${TENSOR_DIST_BACKEND:=hccl}"

export ASCEND_VISIBLE_DEVICES
export TENSOR_DEVICE
export MASTER_ADDR
export MASTER_PORT
export TENSOR_DIST_BACKEND

if [[ -n "${WORLD_SIZE:-}" ]]; then
  WORLD_SIZE="${WORLD_SIZE}"
else
  WORLD_SIZE=$(awk -F, '{print NF}' <<<"${ASCEND_VISIBLE_DEVICES}")
fi
export WORLD_SIZE

# Grid defaults are intentionally small to keep one full run practical.
: "${GRID_RECALL_ITERATIONS:=400 800}"
: "${GRID_RECALL_LR:=0.03 0.01}"
: "${GRID_RECALL_NEGATIVE_PER_QUERY:=8 16}"
: "${GRID_CANDIDATE_K:=24 40}"
: "${GRID_RERANKER_EPOCHS:=800}"
: "${GRID_RERANKER_LR:=0.05 0.02}"
: "${GRID_ENCODER_EMBEDDING_DIM:=8 16}"
: "${GRID_ENCODER_EPOCHS:=900}"
: "${GRID_ENCODER_LR:=0.03}"
: "${GRID_JUDGE_EPOCHS:=1000}"
: "${GRID_JUDGE_LR:=0.03 0.01}"
: "${GRID_JUDGE_MEDIUM_THRESHOLD:=2.0}"
: "${GRID_JUDGE_HIGH_THRESHOLD:=3.0}"

# Composite score weights (must sum to 1.0).
: "${SCORE_W_RECALL:=0.35}"
: "${SCORE_W_NDCG:=0.35}"
: "${SCORE_W_MACRO_F1:=0.30}"

mkdir -p "${RUN_DIR}" "${ARTIFACT_DIR}"
touch "${RESULTS_JSONL}"

exec > >(tee -a "${RUN_DIR}/run.log") 2>&1

echo "[info] root=${ROOT_DIR}"
echo "[info] run_dir=${RUN_DIR}"
echo "[info] ascend_visible_devices=${ASCEND_VISIBLE_DEVICES}"
echo "[info] world_size=${WORLD_SIZE}"
echo "[info] tensor_device=${TENSOR_DEVICE}"
echo "[info] dist_backend=${TENSOR_DIST_BACKEND}"

if ! command -v npu-smi >/dev/null 2>&1; then
  echo "[error] npu-smi not found, cannot validate 310P3 runtime"
  exit 1
fi

if [[ "${TENSOR_DEVICE}" != "npu" ]]; then
  echo "[error] this script is intended for Ascend NPU training, got TENSOR_DEVICE=${TENSOR_DEVICE}"
  exit 1
fi

if [[ ! -f /usr/local/Ascend/ascend-toolkit/set_env.sh ]]; then
  echo "[error] CANN set_env.sh not found at /usr/local/Ascend/ascend-toolkit/set_env.sh"
  exit 1
fi

echo "[info] loading CANN runtime env"
# shellcheck source=/dev/null
source /usr/local/Ascend/ascend-toolkit/set_env.sh

export PYTHONPATH="/app/neurx/python:/app/neurx:${PYTHONPATH:-}"
PYTHON_BIN="/usr/bin/python3"

echo "[info] validating neurx runtime"
"${PYTHON_BIN}" - <<'PY'
import neurx
from neurx.core import neurx as core

print(f"[info] neurx_accel_available={core._accelerator_available()}")
x = neurx.Tensor([[1.0, 2.0], [3.0, 4.0]], requires_grad=False)
print(f"[info] neurx_tensor_device={x.device}")
PY

read -r -a RECALL_ITER_LIST <<< "${GRID_RECALL_ITERATIONS}"
read -r -a RECALL_LR_LIST <<< "${GRID_RECALL_LR}"
read -r -a RECALL_NEG_LIST <<< "${GRID_RECALL_NEGATIVE_PER_QUERY}"
read -r -a CANDIDATE_K_LIST <<< "${GRID_CANDIDATE_K}"
read -r -a RERANKER_EPOCH_LIST <<< "${GRID_RERANKER_EPOCHS}"
read -r -a RERANKER_LR_LIST <<< "${GRID_RERANKER_LR}"
read -r -a ENCODER_DIM_LIST <<< "${GRID_ENCODER_EMBEDDING_DIM}"
read -r -a ENCODER_EPOCH_LIST <<< "${GRID_ENCODER_EPOCHS}"
read -r -a ENCODER_LR_LIST <<< "${GRID_ENCODER_LR}"
read -r -a JUDGE_EPOCH_LIST <<< "${GRID_JUDGE_EPOCHS}"
read -r -a JUDGE_LR_LIST <<< "${GRID_JUDGE_LR}"
read -r -a JUDGE_MED_LIST <<< "${GRID_JUDGE_MEDIUM_THRESHOLD}"
read -r -a JUDGE_HIGH_LIST <<< "${GRID_JUDGE_HIGH_THRESHOLD}"

run_id=0

for recall_iter in "${RECALL_ITER_LIST[@]}"; do
  for recall_lr in "${RECALL_LR_LIST[@]}"; do
    for recall_neg in "${RECALL_NEG_LIST[@]}"; do
      for candidate_k in "${CANDIDATE_K_LIST[@]}"; do
        for rerank_epoch in "${RERANKER_EPOCH_LIST[@]}"; do
          for rerank_lr in "${RERANKER_LR_LIST[@]}"; do
            for encoder_dim in "${ENCODER_DIM_LIST[@]}"; do
              for encoder_epoch in "${ENCODER_EPOCH_LIST[@]}"; do
                for encoder_lr in "${ENCODER_LR_LIST[@]}"; do
                  for judge_epoch in "${JUDGE_EPOCH_LIST[@]}"; do
                    for judge_lr in "${JUDGE_LR_LIST[@]}"; do
                      for judge_med in "${JUDGE_MED_LIST[@]}"; do
                        for judge_high in "${JUDGE_HIGH_LIST[@]}"; do
                          run_id=$((run_id + 1))
                          trial="trial_$(printf '%04d' "${run_id}")"
                          echo "[info] ===== ${trial} ====="
                          echo "[info] params recall(iter=${recall_iter},lr=${recall_lr},neg=${recall_neg}) reranker(epoch=${rerank_epoch},lr=${rerank_lr},k=${candidate_k}) encoder(dim=${encoder_dim},epoch=${encoder_epoch},lr=${encoder_lr}) judge(epoch=${judge_epoch},lr=${judge_lr},med=${judge_med},high=${judge_high})"

                          recall_out="${ARTIFACT_DIR}/${trial}_recall.json"
                          rerank_out="${ARTIFACT_DIR}/${trial}_reranker.json"
                          encoder_out="${ARTIFACT_DIR}/${trial}_encoder.json"
                          judge_out="${ARTIFACT_DIR}/${trial}_judge.json"

                          "${PYTHON_BIN}" "${ROOT_DIR}/model/recall/train_fto_recall_model.py" \
                            --iterations "${recall_iter}" \
                            --lr "${recall_lr}" \
                            --negative-per-query "${recall_neg}" \
                            --k 5 \
                            --out "${recall_out}"

                          "${PYTHON_BIN}" "${ROOT_DIR}/model/reranker/train_fto_model_neurx.py" \
                            --recall-model "${recall_out}" \
                            --epochs "${rerank_epoch}" \
                            --lr "${rerank_lr}" \
                            --candidate-k "${candidate_k}" \
                            --k 5 \
                            --out "${rerank_out}"

                          "${PYTHON_BIN}" "${ROOT_DIR}/model/encoder/train_fto_encoder_neurx.py" \
                            --recall-model "${recall_out}" \
                            --epochs "${encoder_epoch}" \
                            --lr "${encoder_lr}" \
                            --candidate-k "${candidate_k}" \
                            --embedding-dim "${encoder_dim}" \
                            --k 5 \
                            --out "${encoder_out}"

                          "${PYTHON_BIN}" -m torch.distributed.run \
                            --nproc_per_node "${WORLD_SIZE}" \
                            --master_addr "${MASTER_ADDR}" \
                            --master_port "${MASTER_PORT}" \
                            "${ROOT_DIR}/model/judge/train_fto_judge_model_neurx.py" \
                            --distributed \
                            --backend "${TENSOR_DIST_BACKEND}" \
                            --recall-model "${recall_out}" \
                            --reranker-model "${rerank_out}" \
                            --epochs "${judge_epoch}" \
                            --lr "${judge_lr}" \
                            --candidate-k "${candidate_k}" \
                            --medium-rel-threshold "${judge_med}" \
                            --high-rel-threshold "${judge_high}" \
                            --out "${judge_out}"

                          "${PYTHON_BIN}" - <<PY
import json
from pathlib import Path

trial = "${trial}"
recall_path = Path("${recall_out}")
rerank_path = Path("${rerank_out}")
encoder_path = Path("${encoder_out}")
judge_path = Path("${judge_out}")
results_path = Path("${RESULTS_JSONL}")

recall = json.loads(recall_path.read_text(encoding="utf-8"))
rerank = json.loads(rerank_path.read_text(encoding="utf-8"))
encoder = json.loads(encoder_path.read_text(encoding="utf-8"))
judge = json.loads(judge_path.read_text(encoding="utf-8"))

recall_at_5 = float(recall.get("metrics", {}).get("recall_at_k", 0.0))
ndcg_at_5 = float(rerank.get("metrics", {}).get("ndcg_at_k", 0.0))
macro_f1 = float(judge.get("metrics", {}).get("macro_f1", 0.0))

w_recall = float("${SCORE_W_RECALL}")
w_ndcg = float("${SCORE_W_NDCG}")
w_macro_f1 = float("${SCORE_W_MACRO_F1}")
composite = w_recall * recall_at_5 + w_ndcg * ndcg_at_5 + w_macro_f1 * macro_f1

record = {
    "trial": trial,
    "params": {
        "recall_iterations": int("${recall_iter}"),
        "recall_lr": float("${recall_lr}"),
        "recall_negative_per_query": int("${recall_neg}"),
        "candidate_k": int("${candidate_k}"),
        "reranker_epochs": int("${rerank_epoch}"),
        "reranker_lr": float("${rerank_lr}"),
        "encoder_embedding_dim": int("${encoder_dim}"),
        "encoder_epochs": int("${encoder_epoch}"),
        "encoder_lr": float("${encoder_lr}"),
        "judge_epochs": int("${judge_epoch}"),
        "judge_lr": float("${judge_lr}"),
        "judge_medium_threshold": float("${judge_med}"),
        "judge_high_threshold": float("${judge_high}"),
    },
    "metrics": {
        "recall_at_5": recall_at_5,
        "ndcg_at_5": ndcg_at_5,
        "macro_f1": macro_f1,
        "judge_accuracy": float(judge.get("metrics", {}).get("accuracy", 0.0)),
        "encoder_train_mse": float(encoder.get("metrics", {}).get("train_mse", 0.0)),
    },
    "score": {
        "weights": {
            "recall": w_recall,
            "ndcg": w_ndcg,
            "macro_f1": w_macro_f1,
        },
        "composite": composite,
    },
    "artifacts": {
        "recall": str(recall_path),
        "reranker": str(rerank_path),
        "encoder": str(encoder_path),
        "judge": str(judge_path),
    },
}

with results_path.open("a", encoding="utf-8") as f:
    f.write(json.dumps(record, ensure_ascii=False) + "\n")

print(
    f"[ok] {trial} recall@5={recall_at_5:.4f} ndcg@5={ndcg_at_5:.4f} macro_f1={macro_f1:.4f} composite={composite:.4f}"
)
PY

                          # Avoid rendezvous collisions across repeated distributed launches.
                          MASTER_PORT=$((MASTER_PORT + 1))
                          export MASTER_PORT
                        done
                      done
                    done
                  done
                done
              done
            done
          done
        done
      done
    done
  done
done

"${PYTHON_BIN}" - <<PY
import json
from pathlib import Path

results_path = Path("${RESULTS_JSONL}")
leaderboard_json = Path("${LEADERBOARD_JSON}")
leaderboard_md = Path("${LEADERBOARD_MD}")

rows = []
for line in results_path.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line:
        continue
    rows.append(json.loads(line))

rows.sort(key=lambda item: item.get("score", {}).get("composite", 0.0), reverse=True)

for idx, row in enumerate(rows, start=1):
    row["rank"] = idx

leaderboard_json.write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

lines = [
    "# Joint Tuning Leaderboard",
    "",
    "| Rank | Trial | Recall@5 | NDCG@5 | Macro-F1 | Composite | Candidate-K |",
    "| ---: | :--- | ---: | ---: | ---: | ---: | ---: |",
]
for row in rows:
    m = row.get("metrics", {})
    p = row.get("params", {})
    s = row.get("score", {})
    lines.append(
        "| {rank} | {trial} | {r:.4f} | {n:.4f} | {f:.4f} | {c:.4f} | {k} |".format(
            rank=row.get("rank", 0),
            trial=row.get("trial", "-"),
            r=float(m.get("recall_at_5", 0.0)),
            n=float(m.get("ndcg_at_5", 0.0)),
            f=float(m.get("macro_f1", 0.0)),
            c=float(s.get("composite", 0.0)),
            k=int(p.get("candidate_k", 0)),
        )
    )

leaderboard_md.write_text("\n".join(lines) + "\n", encoding="utf-8")

print(f"[ok] trials={len(rows)}")
if rows:
    top = rows[0]
    print(
        "[ok] best="
        + f"{top.get('trial')} composite={top.get('score', {}).get('composite', 0.0):.4f} "
        + f"recall@5={top.get('metrics', {}).get('recall_at_5', 0.0):.4f} "
        + f"ndcg@5={top.get('metrics', {}).get('ndcg_at_5', 0.0):.4f} "
        + f"macro_f1={top.get('metrics', {}).get('macro_f1', 0.0):.4f}"
    )
print(f"[ok] leaderboard_json={leaderboard_json}")
print(f"[ok] leaderboard_md={leaderboard_md}")
PY

echo "[ok] done run_dir=${RUN_DIR}"