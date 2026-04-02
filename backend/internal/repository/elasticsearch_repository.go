package repository

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"fto-backend/internal/model"
)

type ElasticsearchPatentRepository struct {
	local               *LocalPatentRepository
	baseURL             string
	index               string
	candidateMultiplier int
	client              *http.Client
}

func NewElasticsearchPatentRepository(local *LocalPatentRepository, baseURL string, index string, candidateMultiplier int) *ElasticsearchPatentRepository {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if candidateMultiplier < 2 {
		candidateMultiplier = 6
	}
	return &ElasticsearchPatentRepository{
		local:               local,
		baseURL:             baseURL,
		index:               strings.TrimSpace(index),
		candidateMultiplier: candidateMultiplier,
		client: &http.Client{
			Timeout: 8 * time.Second,
		},
	}
}

func (r *ElasticsearchPatentRepository) GetRankingConfig() (string, int) {
	return r.local.GetRankingConfig()
}

func (r *ElasticsearchPatentRepository) UpdateRankingConfig(mode string, dualRatio int) {
	r.local.UpdateRankingConfig(mode, dualRatio)
}

func (r *ElasticsearchPatentRepository) GetRankingModelStatus() model.RankingModelStatus {
	status := r.local.GetRankingModelStatus()
	status.ElasticsearchEnabled = true
	status.ElasticsearchIndex = r.index
	return status
}

func (r *ElasticsearchPatentRepository) ExplainQuery(ctx context.Context, query string, limit int) (*model.RankingExplainResponse, error) {
	patentIDs, err := r.fetchCandidatePatentIDs(ctx, query, limit)
	if err != nil || len(patentIDs) == 0 {
		resp, localErr := r.local.ExplainQuery(ctx, query, limit)
		if resp != nil {
			resp.RecallDebug = &model.RecallDebugInfo{
				ElasticsearchCount: 0,
				MergedCount:        resp.CandidateCount,
				MergedIDs:          esRankingExplainPatentIDs(resp.Results),
				HybridActive:       false,
				Sources:            []string{"local"},
				Fallback:           "local_only",
			}
		}
		return resp, localErr
	}
	resp, explainErr := r.local.ExplainQueryForPatentIDs(query, limit, patentIDs)
	if resp != nil {
		resp.RecallDebug = &model.RecallDebugInfo{
			ElasticsearchCount: len(patentIDs),
			MergedCount:        len(patentIDs),
			MergedIDs:          append([]string(nil), patentIDs...),
			HybridActive:       false,
			Sources:            []string{"elasticsearch"},
			ElasticsearchIDs:   append([]string(nil), patentIDs...),
		}
	}
	return resp, explainErr
}

func (r *ElasticsearchPatentRepository) ExplainEncoder(ctx context.Context, query string, limit int) (*model.EncoderExplainResponse, error) {
	patentIDs, err := r.fetchCandidatePatentIDs(ctx, query, limit)
	if err != nil || len(patentIDs) == 0 {
		resp, localErr := r.local.ExplainEncoder(ctx, query, limit)
		if resp != nil {
			resp.RecallDebug = &model.RecallDebugInfo{
				ElasticsearchCount: 0,
				MergedCount:        resp.CandidateCount,
				MergedIDs:          esEncoderExplainPatentIDs(resp.Results),
				HybridActive:       false,
				Sources:            []string{"local"},
				Fallback:           "local_only",
			}
		}
		return resp, localErr
	}
	resp, explainErr := r.local.ExplainEncoderForPatentIDs(query, limit, patentIDs)
	if resp != nil {
		resp.RecallDebug = &model.RecallDebugInfo{
			ElasticsearchCount: len(patentIDs),
			MergedCount:        len(patentIDs),
			MergedIDs:          append([]string(nil), patentIDs...),
			HybridActive:       false,
			Sources:            []string{"elasticsearch"},
			ElasticsearchIDs:   append([]string(nil), patentIDs...),
		}
	}
	return resp, explainErr
}

func (r *ElasticsearchPatentRepository) Search(ctx context.Context, query string, limit int) ([]model.TaskResultItem, error) {
	if !r.local.useDualForQuery(query) {
		return r.local.Search(ctx, query, limit)
	}
	patentIDs, err := r.fetchCandidatePatentIDs(ctx, query, limit)
	if err != nil || len(patentIDs) == 0 {
		return r.local.Search(ctx, query, limit)
	}
	return r.local.searchDualForPatentIDs(query, limit, patentIDs), nil
}

func esRankingExplainPatentIDs(items []model.RankingExplainItem) []string {
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

func esEncoderExplainPatentIDs(items []model.EncoderExplainItem) []string {
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

func (r *ElasticsearchPatentRepository) fetchCandidatePatentIDs(ctx context.Context, query string, limit int) ([]string, error) {
	if strings.TrimSpace(query) == "" {
		return nil, nil
	}
	start := time.Now()
	size := limit * r.candidateMultiplier
	if size < 12 {
		size = 12
	}

	body := map[string]interface{}{
		"size":    size,
		"_source": []string{"patent_id"},
		"query": map[string]interface{}{
			"multi_match": map[string]interface{}{
				"query":  query,
				"fields": []string{"title^4", "abstract^2", "claim^3", "keywords^2"},
				"type":   "best_fields",
			},
		},
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	payloadText := string(payload)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/%s/_search", r.baseURL, r.index), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := r.client.Do(req)
	if err != nil {
		log.Printf("[es] request_failed index=%s query=%q limit=%d size=%d elapsed_ms=%d payload=%s err=%v", r.index, query, limit, size, time.Since(start).Milliseconds(), payloadText, err)
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		log.Printf("[es] request_error index=%s query=%q limit=%d size=%d status=%d elapsed_ms=%d payload=%s body=%q", r.index, query, limit, size, resp.StatusCode, time.Since(start).Milliseconds(), payloadText, strings.TrimSpace(string(data)))
		return nil, fmt.Errorf("elasticsearch search failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(data)))
	}

	var parsed struct {
		Hits struct {
			Hits []struct {
				Source struct {
					PatentID string `json:"patent_id"`
				} `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, err
	}

	out := make([]string, 0, len(parsed.Hits.Hits))
	for _, hit := range parsed.Hits.Hits {
		if strings.TrimSpace(hit.Source.PatentID) == "" {
			continue
		}
		out = append(out, hit.Source.PatentID)
	}
	log.Printf("[es] request_ok index=%s query=%q limit=%d size=%d status=%d elapsed_ms=%d candidates=%d payload=%s", r.index, query, limit, size, resp.StatusCode, time.Since(start).Milliseconds(), len(out), payloadText)
	return out, nil
}
