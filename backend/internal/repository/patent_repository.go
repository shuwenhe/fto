package repository

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"unicode"

	"fto-backend/internal/model"
)

type PatentDataRepository interface {
	Search(ctx context.Context, query string, limit int) ([]model.TaskResultItem, error)
}

type scoredPatent struct {
	record  model.PatentRecord
	score   int
	matched []string
}

type LocalPatentRepository struct {
	records []model.PatentRecord
}

func NewLocalPatentRepository(dataPath string) (*LocalPatentRepository, error) {
	f, err := os.Open(dataPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	records := make([]model.PatentRecord, 0, 256)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var rec model.PatentRecord
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			return nil, fmt.Errorf("invalid jsonl at line %d: %w", lineNo, err)
		}
		if rec.PatentID == "" || rec.Title == "" {
			continue
		}
		records = append(records, rec)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, fmt.Errorf("no patent records loaded from %s", dataPath)
	}
	return &LocalPatentRepository{records: records}, nil
}

func normalize(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

func uniqueTokens(tokens []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(tokens))
	for _, t := range tokens {
		t = normalize(t)
		if t == "" {
			continue
		}
		if _, ok := seen[t]; ok {
			continue
		}
		seen[t] = struct{}{}
		out = append(out, t)
	}
	return out
}

func splitQuery(query string) []string {
	query = normalize(query)
	if query == "" {
		return nil
	}
	tokens := []string{query}
	parts := strings.FieldsFunc(query, func(r rune) bool {
		if unicode.IsSpace(r) {
			return true
		}
		seps := "，,。；;：:、|/\\()[]{}<>"
		return strings.ContainsRune(seps, r)
	})
	for _, p := range parts {
		if len([]rune(p)) >= 2 {
			tokens = append(tokens, p)
		}
	}
	return uniqueTokens(tokens)
}

func containsAny(haystack string, tokens []string) (int, []string) {
	h := normalize(haystack)
	score := 0
	matched := make([]string, 0)
	for _, t := range tokens {
		if strings.Contains(h, t) {
			score++
			matched = append(matched, t)
		}
	}
	return score, matched
}

func calcRisk(score int) string {
	if score >= 18 {
		return "high"
	}
	if score >= 9 {
		return "medium"
	}
	return "low"
}

func uniqSorted(tokens []string) []string {
	m := map[string]struct{}{}
	for _, t := range tokens {
		m[t] = struct{}{}
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (r *LocalPatentRepository) Search(_ context.Context, query string, limit int) ([]model.TaskResultItem, error) {
	if limit <= 0 {
		limit = 5
	}
	tokens := splitQuery(query)
	if len(tokens) == 0 {
		return []model.TaskResultItem{}, nil
	}

	ranked := make([]scoredPatent, 0, len(r.records))
	for _, rec := range r.records {
		titleScore, titleMatched := containsAny(rec.Title, tokens)
		absScore, absMatched := containsAny(rec.Abstract, tokens)
		claimScore, claimMatched := containsAny(rec.Claim, tokens)

		keywordHits := 0
		keywordMatched := make([]string, 0)
		for _, kw := range rec.Keywords {
			kwN := normalize(kw)
			for _, t := range tokens {
				if strings.Contains(kwN, t) || strings.Contains(t, kwN) {
					keywordHits++
					keywordMatched = append(keywordMatched, t)
				}
			}
		}

		total := titleScore*4 + absScore*2 + claimScore*3 + keywordHits*2
		if total == 0 {
			continue
		}
		matched := append(titleMatched, absMatched...)
		matched = append(matched, claimMatched...)
		matched = append(matched, keywordMatched...)

		ranked = append(ranked, scoredPatent{record: rec, score: total, matched: uniqSorted(matched)})
	}

	sort.SliceStable(ranked, func(i, j int) bool {
		return ranked[i].score > ranked[j].score
	})

	if len(ranked) > limit {
		ranked = ranked[:limit]
	}

	results := make([]model.TaskResultItem, 0, len(ranked))
	for _, item := range ranked {
		reason := fmt.Sprintf("命中关键词: %s；法律状态: %s。", strings.Join(item.matched, ", "), item.record.LegalStatus)
		results = append(results, model.TaskResultItem{
			PatentID:  item.record.PatentID,
			Title:     item.record.Title,
			RiskLevel: calcRisk(item.score),
			Reason:    reason,
		})
	}
	return results, nil
}
