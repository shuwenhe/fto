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
	local             *LocalPatentRepository
	es                *ElasticsearchPatentRepository
	milvus            *MilvusPatentRepository
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
	patentIDs, err := r.fetchCandidatePatentIDs(ctx, query, limit)
	if err != nil || len(patentIDs) == 0 {
		return r.local.ExplainQuery(ctx, query, limit)
	}
	return r.local.ExplainQueryForPatentIDs(query, limit, patentIDs)
}

func (r *HybridPatentRepository) ExplainEncoder(ctx context.Context, query string, limit int) (*model.EncoderExplainResponse, error) {
	patentIDs, err := r.fetchCandidatePatentIDs(ctx, query, limit)
	if err != nil || len(patentIDs) == 0 {
		return r.local.ExplainEncoder(ctx, query, limit)
	}
	return r.local.ExplainEncoderForPatentIDs(query, limit, patentIDs)
}

func (r *HybridPatentRepository) Search(ctx context.Context, query string, limit int) ([]model.TaskResultItem, error) {
	if !r.local.useDualForQuery(query) {
		return r.local.Search(ctx, query, limit)
	}
	patentIDs, err := r.fetchCandidatePatentIDs(ctx, query, limit)
	if err != nil || len(patentIDs) == 0 {
		return r.local.Search(ctx, query, limit)
	}
	return r.local.searchDualForPatentIDs(query, limit, patentIDs), nil
}

func (r *HybridPatentRepository) fetchCandidatePatentIDs(ctx context.Context, query string, limit int) ([]string, error) {
	if strings.TrimSpace(query) == "" {
		return nil, nil
	}
	var fetchers []patentCandidateFetcher
	if r.preferElasticsearch {
		if r.es != nil {
			fetchers = append(fetchers, r.es)
		}
		if r.milvus != nil {
			fetchers = append(fetchers, r.milvus)
		}
	} else {
		if r.milvus != nil {
			fetchers = append(fetchers, r.milvus)
		}
		if r.es != nil {
			fetchers = append(fetchers, r.es)
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
		if len(ids) > 0 {
			resultSets = append(resultSets, ids)
		}
	}
	if len(resultSets) == 0 {
		return nil, firstErr
	}
	return interleaveUniquePatentIDs(resultSets...), nil
}

func interleaveUniquePatentIDs(groups ...[]string) []string {
	total := 0
	for _, group := range groups {
		total += len(group)
	}
	out := make([]string, 0, total)
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
				continue
			}
			seen[id] = struct{}{}
			out = append(out, id)
		}
		if !advanced {
			break
		}
	}
	return out
}
