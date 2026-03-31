#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"
PYTHON_BIN="${VENV_DIR}/bin/python"
PIP_BIN="${VENV_DIR}/bin/pip"
LOG_DIR="${ROOT_DIR}/logs"
TS="$(date +%Y%m%d_%H%M%S)"
LOG_FILE="${LOG_DIR}/fto_recall_train_eval_${TS}.log"

mkdir -p "${LOG_DIR}"

# Mirror all output to a timestamped log for reproducibility and auditing.
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

echo "[info] training recall model with neurx"
"${PYTHON_BIN}" "${ROOT_DIR}/scripts/train_fto_recall_model.py" \
  --out "${ROOT_DIR}/model_artifacts/fto_recall_dual_v1.json"

echo "[info] evaluating retrieval model with trained artifact"
(
  cd "${ROOT_DIR}"
  node scripts/eval_retrieval.mjs \
    --k 5 \
    --model model_artifacts/fto_recall_dual_v1.json \
    --verbose
)

echo "[ok] done"
echo "[ok] artifact=${ROOT_DIR}/model_artifacts/fto_recall_dual_v1.json"
echo "[ok] log=${LOG_FILE}"
