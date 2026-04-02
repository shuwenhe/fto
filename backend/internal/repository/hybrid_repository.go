package repository

import (
	"context"
	"log"
	"strings"

	"fto-backend/internal/model"
)

type patentCandidateFetcher interface {
	fetchCandidatePatentIDs(ctx context.Context, query string, limit int) ([]string, error)
}

type HybridPatentRepository struct {
	local               *LocalPatentRepository
	es                  *ElasticsearchPatentRepository
	milvus              *MilvusPatentRepository
	preferElasticsearch bool
}

func NewHybridPatentRepository(local *LocalPatentRepository, es *ElasticsearchPatentRepository, milvus *MilvusPatentRepository) *HybridPatentRepository {
	return &HybridPatentRepository{
		local:               local,
		es:                  es,
		milvus:              milvus,
		preferElasticsearch: true,
	}
}

func (r *HybridPatentRepository) GetRankingConfig() (string, int) {
	return r.local.GetRankingConfig()
}

func (r *HybridPatentRepository) UpdateRankingConfig(mode string, dualRatio int) {
	r.local.UpdateRankingConfig(mode, dualRatio)
}

func (r *HybridPatentRepository) GetRankingModelStatus() model.RankingModelStatus {
	status := r.local.GetRankingModelStatus()
	if r.es != nil {
		status.ElasticsearchEnabled = true
		status.ElasticsearchIndex = r.es.index
	}
	if r.milvus != nil {
		status.MilvusEnabled = true
		status.MilvusCollection = r.milvus.collection
	}
	return status
}

func (r *HybridPatentRepository) ExplainQuery(ctx context.Context, query string, limit int) (*model.RankingExplainResponse, error) {
	patentIDs, debug, err := r.fetchCandidatePatentIDsWithDebug(ctx, query, limit)
	if err != nil || len(patentIDs) == 0 {
		resp, localErr := r.local.ExplainQuery(ctx, query, limit)
		if resp != nil && debug != nil {
			debug.MergedCount = resp.CandidateCount
			debug.MergedIDs = rankingExplainPatentIDs(resp.Results)
			debug.Fallback = "local_only"
			resp.RecallDebug = debug
		}
		return resp, localErr
	}
	resp, explainErr := r.local.ExplainQueryForPatentIDs(query, limit, patentIDs)
	if resp != nil {
		resp.RecallDebug = debug
	}
	return resp, explainErr
}

func (r *HybridPatentRepository) ExplainEncoder(ctx context.Context, query string, limit int) (*model.EncoderExplainResponse, error) {
	patentIDs, debug, err := r.fetchCandidatePatentIDsWithDebug(ctx, query, limit)
	if err != nil || len(patentIDs) == 0 {
		resp, localErr := r.local.ExplainEncoder(ctx, query, limit)
		if resp != nil && debug != nil {
			debug.MergedCount = resp.CandidateCount
			debug.MergedIDs = encoderExplainPatentIDs(resp.Results)
			debug.Fallback = "local_only"
			resp.RecallDebug = debug
		}
		return resp, localErr
	}
	resp, explainErr := r.local.ExplainEncoderForPatentIDs(query, limit, patentIDs)
	if resp != nil {
		resp.RecallDebug = debug
	}
	return resp, explainErr
}

func (r *HybridPatentRepository) Search(ctx context.Context, query string, limit int) ([]model.TaskResultItem, error) {
	if !r.local.useDualForQuery(query) {
		return r.local.Search(ctx, query, limit)
	}
	patentIDs, _, err := r.fetchCandidatePatentIDsWithDebug(ctx, query, limit)
	if err != nil || len(patentIDs) == 0 {
		return r.local.Search(ctx, query, limit)
	}
	return r.local.searchDualForPatentIDs(query, limit, patentIDs), nil
}

func (r *HybridPatentRepository) fetchCandidatePatentIDs(ctx context.Context, query string, limit int) ([]string, error) {
	ids, _, err := r.fetchCandidatePatentIDsWithDebug(ctx, query, limit)
	return ids, err
}

func (r *HybridPatentRepository) fetchCandidatePatentIDsWithDebug(ctx context.Context, query string, limit int) ([]string, *model.RecallDebugInfo, error) {
	if strings.TrimSpace(query) == "" {
		return nil, nil, nil
	}
	var fetchers []patentCandidateFetcher
	debug := &model.RecallDebugInfo{
		HybridActive: r.es != nil && r.milvus != nil,
		Sources:      []string{},
	}
	if r.preferElasticsearch {
		if r.es != nil {
			fetchers = append(fetchers, r.es)
			debug.Sources = append(debug.Sources, "elasticsearch")
		}
		if r.milvus != nil {
			fetchers = append(fetchers, r.milvus)
			debug.Sources = append(debug.Sources, "milvus")
		}
	} else {
		if r.milvus != nil {
			fetchers = append(fetchers, r.milvus)
			debug.Sources = append(debug.Sources, "milvus")
		}
		if r.es != nil {
			fetchers = append(fetchers, r.es)
			debug.Sources = append(debug.Sources, "elasticsearch")
		}
	}

	resultSets := make([][]string, 0, len(fetchers))
	var firstErr error
	for _, fetcher := range fetchers {
		ids, err := fetcher.fetchCandidatePatentIDs(ctx, query, limit)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			log.Printf("[hybrid] candidate_fetch_failed query=%q err=%v", query, err)
			continue
		}
		switch fetcher.(type) {
		case *ElasticsearchPatentRepository:
			debug.ElasticsearchCount = len(ids)
			debug.ElasticsearchIDs = append([]string(nil), ids...)
		case *MilvusPatentRepository:
			debug.MilvusCount = len(ids)
			debug.MilvusIDs = append([]string(nil), ids...)
		}
		if len(ids) > 0 {
			resultSets = append(resultSets, ids)
		}
	}
	if len(resultSets) == 0 {
		return nil, debug, firstErr
	}
	merged, deduped := interleaveUniquePatentIDsWithDeduped(resultSets...)
	debug.MergedCount = len(merged)
	debug.MergedIDs = append([]string(nil), merged...)
	debug.DedupedIDs = deduped
	return merged, debug, nil
}

func rankingExplainPatentIDs(items []model.RankingExplainItem) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		id := strings.TrimSpace(item.PatentID)
		if id == "" {
			continue
		}
		out = append(out, id)
	}
	return out
}

func encoderExplainPatentIDs(items []model.EncoderExplainItem) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		id := strings.TrimSpace(item.PatentID)
		if id == "" {
			continue
		}
		out = append(out, id)
	}
	return out
}

func interleaveUniquePatentIDs(groups ...[]string) []string {
	out, _ := interleaveUniquePatentIDsWithDeduped(groups...)
	return out
}

func interleaveUniquePatentIDsWithDeduped(groups ...[]string) ([]string, []string) {
	total := 0
	for _, group := range groups {
		total += len(group)
	}
	out := make([]string, 0, total)
	deduped := make([]string, 0)
	seen := make(map[string]struct{}, total)
	for step := 0; ; step++ {
		advanced := false
		for _, group := range groups {
			if step >= len(group) {
				continue
			}
			advanced = true
			id := strings.TrimSpace(group[step])
			if id == "" {
				continue
			}
			if _, ok := seen[id]; ok {
				deduped = append(deduped, id)
				continue
			}
			seen[id] = struct{}{}
			out = append(out, id)
		}
		if !advanced {
			break
		}
	}
	return out, uniqStrings(deduped)
}

func uniqStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}
