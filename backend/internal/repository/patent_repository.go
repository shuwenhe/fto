package repository

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math"
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
	record        model.PatentRecord
	lexicalScore  int
	semanticScore float64
	fusionScore   float64
	matched       []string
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

func calcRiskByFusion(score float64) string {
	if score >= 0.66 {
		return "high"
	}
	if score >= 0.40 {
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

func buildPatentURL(patentID string) string {
	patentID = strings.TrimSpace(patentID)
	if patentID == "" {
		return ""
	}
	return fmt.Sprintf("https://patents.google.com/patent/%s", patentID)
}

func splitWords(text string) []string {
	text = normalize(text)
	if text == "" {
		return nil
	}
	parts := strings.FieldsFunc(text, func(r rune) bool {
		if unicode.IsSpace(r) {
			return true
		}
		seps := "，,。；;：:、|/\\()[]{}<>_+-=*&#@!?'\""
		return strings.ContainsRune(seps, r)
	})
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if len([]rune(p)) >= 2 {
			out = append(out, p)
		}
	}
	return out
}

func cjkBigrams(text string) []string {
	text = normalize(text)
	runes := []rune(text)
	out := make([]string, 0, len(runes))
	for i := 0; i < len(runes)-1; i++ {
		r1 := runes[i]
		r2 := runes[i+1]
		if !isCJK(r1) || !isCJK(r2) {
			continue
		}
		out = append(out, string([]rune{r1, r2}))
	}
	return out
}

func isCJK(r rune) bool {
	return unicode.In(r, unicode.Han)
}

func buildSemanticVector(text string) map[string]float64 {
	vec := map[string]float64{}
	for _, t := range splitWords(text) {
		vec[t] += 1.0
	}
	for _, bg := range cjkBigrams(text) {
		vec[bg] += 1.0
	}
	return vec
}

func cosineSim(a, b map[string]float64) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0.0
	}
	dot := 0.0
	na := 0.0
	nb := 0.0
	for k, va := range a {
		na += va * va
		if vb, ok := b[k]; ok {
			dot += va * vb
		}
	}
	for _, vb := range b {
		nb += vb * vb
	}
	if na == 0 || nb == 0 {
		return 0.0
	}
	return dot / (math.Sqrt(na) * math.Sqrt(nb))
}

func (r *LocalPatentRepository) Search(_ context.Context, query string, limit int) ([]model.TaskResultItem, error) {
	if limit <= 0 {
		limit = 5
	}
	tokens := splitQuery(query)
	if len(tokens) == 0 {
		return []model.TaskResultItem{}, nil
	}
	queryVec := buildSemanticVector(query)

	ranked := make([]scoredPatent, 0, len(r.records))
	maxLex := 0
	maxSem := 0.0
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

		lexical := titleScore*4 + absScore*2 + claimScore*3 + keywordHits*2
 		docText := fmt.Sprintf("%s %s %s %s", rec.Title, rec.Abstract, rec.Claim, strings.Join(rec.Keywords, " "))
		semantic := cosineSim(queryVec, buildSemanticVector(docText))

		if lexical == 0 && semantic == 0 {
			continue
		}
		matched := append(titleMatched, absMatched...)
		matched = append(matched, claimMatched...)
		matched = append(matched, keywordMatched...)

		ranked = append(ranked, scoredPatent{
			record:        rec,
			lexicalScore:  lexical,
			semanticScore: semantic,
			matched:       uniqSorted(matched),
		})
		if lexical > maxLex {
			maxLex = lexical
		}
		if semantic > maxSem {
			maxSem = semantic
		}
	}

	if len(ranked) == 0 {
		return []model.TaskResultItem{}, nil
	}

	for i := range ranked {
		lexNorm := 0.0
		semNorm := 0.0
		if maxLex > 0 {
			lexNorm = float64(ranked[i].lexicalScore) / float64(maxLex)
		}
		if maxSem > 0 {
			semNorm = ranked[i].semanticScore / maxSem
		}
		// Fused score for final ranking.
		ranked[i].fusionScore = lexNorm*0.65 + semNorm*0.35
	}

	idxLex := make([]int, len(ranked))
	idxSem := make([]int, len(ranked))
	for i := range ranked {
		idxLex[i] = i
		idxSem[i] = i
	}
	sort.SliceStable(idxLex, func(i, j int) bool {
		return ranked[idxLex[i]].lexicalScore > ranked[idxLex[j]].lexicalScore
	})
	sort.SliceStable(idxSem, func(i, j int) bool {
		return ranked[idxSem[i]].semanticScore > ranked[idxSem[j]].semanticScore
	})

	recallDepth := limit * 3
	if recallDepth < 6 {
		recallDepth = 6
	}
	if recallDepth > len(ranked) {
		recallDepth = len(ranked)
	}

	candidateIdx := map[int]struct{}{}
	for i := 0; i < recallDepth; i++ {
		if ranked[idxLex[i]].lexicalScore > 0 {
			candidateIdx[idxLex[i]] = struct{}{}
		}
		if ranked[idxSem[i]].semanticScore > 0 {
			candidateIdx[idxSem[i]] = struct{}{}
		}
	}

	fused := make([]scoredPatent, 0, len(candidateIdx))
	for i := range candidateIdx {
		fused = append(fused, ranked[i])
	}
	if len(fused) == 0 {
		fused = append(fused, ranked...)
	}

	sort.SliceStable(fused, func(i, j int) bool {
		if fused[i].fusionScore == fused[j].fusionScore {
			return fused[i].lexicalScore > fused[j].lexicalScore
		}
		return fused[i].fusionScore > fused[j].fusionScore
	})

	if len(fused) > limit {
		fused = fused[:limit]
	}

	results := make([]model.TaskResultItem, 0, len(fused))
	for _, item := range fused {
		matched := strings.Join(item.matched, ", ")
		if matched == "" {
			matched = "(语义召回命中)"
		}
		reason := fmt.Sprintf(
			"命中关键词: %s；双路召回分 lexical=%d semantic=%.4f fusion=%.4f；法律状态: %s。",
			matched,
			item.lexicalScore,
			item.semanticScore,
			item.fusionScore,
			item.record.LegalStatus,
		)
		results = append(results, model.TaskResultItem{
			PatentID:  item.record.PatentID,
			PatentURL: buildPatentURL(item.record.PatentID),
			Title:     item.record.Title,
			RiskLevel: calcRiskByFusion(item.fusionScore),
			Reason:    reason,
		})
	}
	return results, nil
}
