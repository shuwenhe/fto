#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"
PYTHON_BIN=""
PIP_BIN=""
LOG_DIR="${ROOT_DIR}/logs"
RECALL_ARTIFACT="${ROOT_DIR}/model_artifacts/fto_recall_dual_v1.json"
RERANKER_ARTIFACT="${ROOT_DIR}/model_artifacts/fto_reranker_neurx_v1.json"
JUDGE_ARTIFACT="${ROOT_DIR}/model_artifacts/fto_judge_neurx_v1.json"
TS="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="${LOG_DIR}/fto_judge_train_eval_${TS}.log"

# Force neurx to use Ascend NPU backend by default.
: "${ASCEND_VISIBLE_DEVICES:=0,1,2,3,4,5,6,7}"
export ASCEND_VISIBLE_DEVICES
: "${TENSOR_DEVICE:=npu}"
export TENSOR_DEVICE
: "${MASTER_ADDR:=127.0.0.1}"
export MASTER_ADDR
: "${MASTER_PORT:=29501}"
export MASTER_PORT
: "${TENSOR_DIST_BACKEND:=hccl}"
export TENSOR_DIST_BACKEND

if [[ -n "${WORLD_SIZE:-}" ]]; then
  WORLD_SIZE="${WORLD_SIZE}"
else
  WORLD_SIZE=$(awk -F, '{print NF}' <<<"${ASCEND_VISIBLE_DEVICES}")
fi
export WORLD_SIZE

mkdir -p "${LOG_DIR}"

exec > >(tee -a "${LOG_FILE}") 2>&1

echo "[info] root=${ROOT_DIR}"
echo "[info] log_file=${LOG_FILE}"
echo "[info] tensor_device=${TENSOR_DEVICE}"
echo "[info] ascend_visible_devices=${ASCEND_VISIBLE_DEVICES}"
echo "[info] world_size=${WORLD_SIZE}"
echo "[info] dist_backend=${TENSOR_DIST_BACKEND}"
echo "[info] master_addr=${MASTER_ADDR}"
echo "[info] master_port=${MASTER_PORT}"

if ! command -v npu-smi >/dev/null 2>&1; then
  echo "[error] npu-smi not found, cannot validate 310P3 runtime"
  exit 1
fi

if [[ "${TENSOR_DEVICE}" == "npu" ]]; then
  if [[ ! -f /usr/local/Ascend/ascend-toolkit/set_env.sh ]]; then
    echo "[error] CANN set_env.sh not found at /usr/local/Ascend/ascend-toolkit/set_env.sh"
    exit 1
  fi
  echo "[info] loading CANN runtime env"
  # shellcheck source=/dev/null
  source /usr/local/Ascend/ascend-toolkit/set_env.sh
  export PYTHONPATH="/app/neurx/python:/app/neurx:${PYTHONPATH:-}"
  PYTHON_BIN="/usr/bin/python3"
  echo "[info] using python=${PYTHON_BIN} (CANN runtime)"
else
  PYTHON_BIN="${VENV_DIR}/bin/python"
  PIP_BIN="${VENV_DIR}/bin/pip"

  if [[ ! -x "${PYTHON_BIN}" ]]; then
    echo "[info] creating venv at ${VENV_DIR}"
    python3 -m venv "${VENV_DIR}"
  fi

  echo "[info] upgrading pip/setuptools/wheel"
  "${PIP_BIN}" install --upgrade pip setuptools wheel

  echo "[info] installing neurx editable package and scipy"
  "${PIP_BIN}" install -e /app/neurx scipy
fi

echo "[info] validating neurx npu backend"
"${PYTHON_BIN}" - <<'PY'
import neurx
from neurx.core import neurx as core

print(f"[info] neurx_accel_available={core._accelerator_available()}")

x = neurx.Tensor([[1.0, 2.0], [3.0, 4.0]], requires_grad=False)
x2 = neurx.Tensor([[2.0, 2.0], [2.0, 2.0]], requires_grad=False)
bias = neurx.Tensor([[1.0, 1.0], [1.0, 1.0]], requires_grad=False)
y = (x * x2 + bias).mean()
print(f"[ok] neurx_npu_smoke={float(y.to_numpy()):.6f}")
print(f"[info] neurx_tensor_device={x.device}")
PY

if [[ ! -f "${RECALL_ARTIFACT}" ]]; then
  echo "[info] recall artifact missing, bootstrapping recall training"
  "${PYTHON_BIN}" "${ROOT_DIR}/recall/train_fto_recall_model.py" --out "${RECALL_ARTIFACT}"
fi

if [[ ! -f "${RERANKER_ARTIFACT}" ]]; then
  echo "[info] reranker artifact missing, bootstrapping reranker training"
  "${PYTHON_BIN}" "${ROOT_DIR}/reranker/train_fto_model_neurx.py" \
    --recall-model "${RECALL_ARTIFACT}" \
    --out "${RERANKER_ARTIFACT}"
fi

echo "[info] training judge model with neurx"
if [[ "${TENSOR_DEVICE}" == "npu" && "${WORLD_SIZE}" -gt 1 ]]; then
  echo "[info] launching distributed training on ${WORLD_SIZE} NPUs"
  "${PYTHON_BIN}" -m torch.distributed.run \
    --nproc_per_node "${WORLD_SIZE}" \
    --master_addr "${MASTER_ADDR}" \
    --master_port "${MASTER_PORT}" \
    "${ROOT_DIR}/judge/train_fto_judge_model_neurx.py" \
    --distributed \
    --backend "${TENSOR_DIST_BACKEND}" \
    --recall-model "${RECALL_ARTIFACT}" \
    --reranker-model "${RERANKER_ARTIFACT}" \
    --out "${JUDGE_ARTIFACT}"
else
  "${PYTHON_BIN}" "${ROOT_DIR}/judge/train_fto_judge_model_neurx.py" \
    --recall-model "${RECALL_ARTIFACT}" \
    --reranker-model "${RERANKER_ARTIFACT}" \
    --out "${JUDGE_ARTIFACT}"
fi

echo "[info] evaluating judge model with trained artifact"
"${PYTHON_BIN}" "${ROOT_DIR}/scripts/eval_judge_model.py" \
  --candidate-k 24 \
  --recall-model "${RECALL_ARTIFACT}" \
  --reranker-model "${RERANKER_ARTIFACT}" \
  --model "${JUDGE_ARTIFACT}" \
  --verbose

echo "[ok] done"
echo "[ok] recall_artifact=${RECALL_ARTIFACT}"
echo "[ok] reranker_artifact=${RERANKER_ARTIFACT}"
echo "[ok] judge_artifact=${JUDGE_ARTIFACT}"
echo "[ok] log=${LOG_FILE}"
