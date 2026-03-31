#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"
PYTHON_BIN="${VENV_DIR}/bin/python"
PIP_BIN="${VENV_DIR}/bin/pip"
LOG_DIR="${ROOT_DIR}/logs"
RECALL_ARTIFACT="${ROOT_DIR}/model_artifacts/fto_recall_dual_v1.json"
RERANKER_ARTIFACT="${ROOT_DIR}/model_artifacts/fto_reranker_neurx_v1.json"
TS="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="${LOG_DIR}/fto_reranker_train_eval_${TS}.log"

mkdir -p "${LOG_DIR}"

exec > >(tee -a "${LOG_FILE}") 2>&1

echo "[info] root=${ROOT_DIR}"
echo "[info] log_file=${LOG_FILE}"

if [[ ! -x "${PYTHON_BIN}" ]]; then
  echo "[info] creating venv at ${VENV_DIR}"
  python3 -m venv "${VENV_DIR}"
fi

echo "[info] upgrading pip/setuptools/wheel"
"${PIP_BIN}" install --upgrade pip setuptools wheel

echo "[info] installing neurx editable package and scipy"
"${PIP_BIN}" install -e /app/neurx scipy

if [[ ! -f "${RECALL_ARTIFACT}" ]]; then
  echo "[info] recall artifact missing, bootstrapping recall training"
  "${PYTHON_BIN}" "${ROOT_DIR}/scripts/train_fto_recall_model.py" --out "${RECALL_ARTIFACT}"
fi

echo "[info] training reranker model with neurx"
"${PYTHON_BIN}" "${ROOT_DIR}/scripts/train_fto_model_neurx.py" \
  --recall-model "${RECALL_ARTIFACT}" \
  --out "${RERANKER_ARTIFACT}"

echo "[info] evaluating reranker model with trained artifact"
(
  cd "${ROOT_DIR}"
  node scripts/eval_reranker_model.mjs \
    --k 5 \
    --candidate-k 24 \
    --recall-model model_artifacts/fto_recall_dual_v1.json \
    --model model_artifacts/fto_reranker_neurx_v1.json \
    --verbose
)

echo "[ok] done"
echo "[ok] recall_artifact=${RECALL_ARTIFACT}"
echo "[ok] reranker_artifact=${RERANKER_ARTIFACT}"
echo "[ok] log=${LOG_FILE}"