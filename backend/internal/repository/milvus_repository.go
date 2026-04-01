package repository

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strings"
	"time"
)

type MilvusPatentRepository struct {
	baseURL             string
	token               string
	collection          string
	annsField           string
	candidateMultiplier int
	hashDim             int
	client              *http.Client
}

func NewMilvusPatentRepository(baseURL string, token string, collection string, annsField string, candidateMultiplier int, hashDim int) *MilvusPatentRepository {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if candidateMultiplier < 2 {
		candidateMultiplier = 6
	}
	if hashDim <= 0 {
		hashDim = 256
	}
	if strings.TrimSpace(annsField) == "" {
		annsField = "embedding"
	}
	return &MilvusPatentRepository{
		baseURL:             baseURL,
		token:               strings.TrimSpace(token),
		collection:          strings.TrimSpace(collection),
		annsField:           strings.TrimSpace(annsField),
		candidateMultiplier: candidateMultiplier,
		hashDim:             hashDim,
		client: &http.Client{
			Timeout: 8 * time.Second,
		},
	}
}

func (r *MilvusPatentRepository) fetchCandidatePatentIDs(ctx context.Context, query string, limit int) ([]string, error) {
	if strings.TrimSpace(query) == "" || strings.TrimSpace(r.collection) == "" {
		return nil, nil
	}
	size := limit * r.candidateMultiplier
	if size < 12 {
		size = 12
	}
	vector := hashEmbedding(query, r.hashDim)
	body := map[string]interface{}{
		"collectionName": r.collection,
		"data":           [][]float64{vector},
		"annsField":      r.annsField,
		"limit":          size,
		"outputFields":   []string{"patent_id"},
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/v2/vectordb/entities/search", r.baseURL), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if r.token != "" {
		req.Header.Set("Authorization", "Bearer "+r.token)
	}

	resp, err := r.client.Do(req)
	if err != nil {
		log.Printf("[milvus] request_failed collection=%s query=%q limit=%d size=%d elapsed_ms=%d err=%v", r.collection, query, limit, size, time.Since(start).Milliseconds(), err)
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		log.Printf("[milvus] request_error collection=%s query=%q limit=%d size=%d status=%d elapsed_ms=%d body=%q", r.collection, query, limit, size, resp.StatusCode, time.Since(start).Milliseconds(), strings.TrimSpace(string(data)))
		return nil, fmt.Errorf("milvus search failed: status=%d body=%s", resp.StatusCode, strings.TrimSpace(string(data)))
	}

	var parsed struct {
		Code int                      `json:"code"`
		Data []map[string]interface{} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(parsed.Data))
	for _, row := range parsed.Data {
		id := extractPatentID(row)
		if id == "" {
			continue
		}
		out = append(out, id)
	}
	log.Printf("[milvus] request_ok collection=%s query=%q limit=%d size=%d status=%d elapsed_ms=%d candidates=%d", r.collection, query, limit, size, resp.StatusCode, time.Since(start).Milliseconds(), len(out))
	return out, nil
}

func extractPatentID(row map[string]interface{}) string {
	if row == nil {
		return ""
	}
	if value, ok := row["patent_id"]; ok {
		if id := strings.TrimSpace(fmt.Sprintf("%v", value)); id != "" && id != "<nil>" {
			return id
		}
	}
	if entity, ok := row["entity"].(map[string]interface{}); ok {
		if value, ok := entity["patent_id"]; ok {
			if id := strings.TrimSpace(fmt.Sprintf("%v", value)); id != "" && id != "<nil>" {
				return id
			}
		}
	}
	if value, ok := row["id"]; ok {
		if id := strings.TrimSpace(fmt.Sprintf("%v", value)); id != "" && id != "<nil>" {
			return id
		}
	}
	return ""
}

func hashEmbedding(text string, dim int) []float64 {
	if dim <= 0 {
		dim = 256
	}
	vec := make([]float64, dim)
	for _, token := range strings.Fields(strings.ToLower(strings.TrimSpace(text))) {
		sum := sha256.Sum256([]byte(token))
		idx := int(binary.BigEndian.Uint32(sum[:4]) % uint32(dim))
		sign := 1.0
		if sum[4]%2 == 1 {
			sign = -1.0
		}
		vec[idx] += sign
	}
	var norm float64
	for _, value := range vec {
		norm += value * value
	}
	norm = math.Sqrt(norm)
	if norm <= 1e-12 {
		return vec
	}
	for i, value := range vec {
		vec[i] = value / norm
	}
	return vec
}
