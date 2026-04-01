#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS="$(date +%Y%m%d_%H%M%S)"
LOG_DIR="${ROOT_DIR}/logs"
mkdir -p "${LOG_DIR}"
LOG_FILE="${LOG_DIR}/query_rewrite_auto_prune_${TS}.log"
exec > >(tee -a "${LOG_FILE}") 2>&1

: "${REWRITE_RULES_PATH:=${ROOT_DIR}/backend/config/query_rewrite_rules.json}"
: "${REWRITE_PRUNED_RULES_PATH:=${ROOT_DIR}/backend/config/query_rewrite_rules.pruned.json}"
: "${REWRITE_ANALYSIS_JSON:=${ROOT_DIR}/docs/query_rewrite_rule_contrib_v1.json}"
: "${REWRITE_ANALYSIS_MD:=${ROOT_DIR}/docs/query_rewrite_rule_contrib_v1.md}"
: "${REWRITE_K:=5}"
: "${REWRITE_MIN_NDCG_CONTRIBUTION:=0}"
: "${REWRITE_MIN_HIT_QUERIES:=2}"
: "${REWRITE_AUTO_APPLY:=1}"
: "${REWRITE_RESTART_BACKEND_ON_APPLY:=1}"
: "${REWRITE_MODEL_PATH:=${ROOT_DIR}/model_artifacts/fto_recall_dual_v1.json}"

echo "[info] root=${ROOT_DIR}"
echo "[info] rules=${REWRITE_RULES_PATH}"
echo "[info] min_ndcg_contribution=${REWRITE_MIN_NDCG_CONTRIBUTION}"
echo "[info] min_hit_queries=${REWRITE_MIN_HIT_QUERIES}"
echo "[info] auto_apply=${REWRITE_AUTO_APPLY}"

cd "${ROOT_DIR}"
node scripts/analyze_query_rewrite_rule_contrib.mjs \
  --k "${REWRITE_K}" \
  --model "${REWRITE_MODEL_PATH}" \
  --rules "${REWRITE_RULES_PATH}" \
  --out-json "${REWRITE_ANALYSIS_JSON}" \
  --out-md "${REWRITE_ANALYSIS_MD}" \
  --min-ndcg-contribution "${REWRITE_MIN_NDCG_CONTRIBUTION}" \
  --min-hit-queries "${REWRITE_MIN_HIT_QUERIES}" \
  --write-pruned-rules "${REWRITE_PRUNED_RULES_PATH}"

summary="$(${ROOT_DIR}/.venv/bin/python - <<PY
import json
from pathlib import Path
p=Path('${REWRITE_ANALYSIS_JSON}')
d=json.loads(p.read_text(encoding='utf-8'))
full=float(d['full_rules']['ndcg_at_k'])
pruned=float(d['pruned_rules_eval']['ndcg_at_k'])
harmful=len(d.get('harmful_terms',[]))
print(f"{full} {pruned} {harmful}")
PY
)"

full_ndcg="$(awk '{print $1}' <<<"${summary}")"
pruned_ndcg="$(awk '{print $2}' <<<"${summary}")"
harmful_terms="$(awk '{print $3}' <<<"${summary}")"

echo "[info] full_ndcg=${full_ndcg} pruned_ndcg=${pruned_ndcg} harmful_terms=${harmful_terms}"

if [[ "${REWRITE_AUTO_APPLY}" == "1" ]]; then
  should_apply="$(${ROOT_DIR}/.venv/bin/python - <<PY
full=float('${full_ndcg}')
pruned=float('${pruned_ndcg}')
harmful=int('${harmful_terms}')
print('yes' if harmful>0 and pruned>=full else 'no')
PY
)"
  if [[ "${should_apply}" == "yes" ]]; then
    cp "${REWRITE_PRUNED_RULES_PATH}" "${REWRITE_RULES_PATH}"
    echo "[ok] applied pruned rules to active config"
    if [[ "${REWRITE_RESTART_BACKEND_ON_APPLY}" == "1" ]]; then
      if systemctl cat fto-backend >/dev/null 2>&1; then
        systemctl restart fto-backend
        echo "[ok] restarted fto-backend"
      else
        echo "[warn] fto-backend service not found, skip restart"
      fi
    fi
  else
    echo "[info] skip apply (no harmful terms or pruned score worse)"
  fi
else
  echo "[info] auto apply disabled"
fi

echo "[ok] report_json=${REWRITE_ANALYSIS_JSON}"
echo "[ok] report_md=${REWRITE_ANALYSIS_MD}"
echo "[ok] log=${LOG_FILE}"
