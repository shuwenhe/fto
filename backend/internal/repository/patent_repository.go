package repository

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math"
	"os"
	"sort"
	"strings"
	"sync"
	"unicode"

	"fto-backend/internal/model"
)

type PatentDataRepository interface {
	Search(ctx context.Context, query string, limit int) ([]model.TaskResultItem, error)
}

type RankingConfigController interface {
	GetRankingConfig() (string, int)
	UpdateRankingConfig(mode string, dualRatio int)
}

type RankingModelStatusProvider interface {
	GetRankingModelStatus() model.RankingModelStatus
}

type RankingExplainProvider interface {
	ExplainQuery(ctx context.Context, query string, limit int) (*model.RankingExplainResponse, error)
}

var neurxFeatureNames = []string{
	"title_score",
	"abstract_score",
	"claim_score",
	"keyword_hits",
	"matched_count",
	"token_count",
	"lexical_score",
	"semantic_score",
	"lexical_norm",
	"semantic_norm",
}

type scoredPatent struct {
	record        model.PatentRecord
	titleScore    int
	abstractScore int
	claimScore    int
	keywordHits   int
	lexicalScore  int
	semanticScore float64
	fusionScore   float64
	lexicalNorm   float64
	semanticNorm  float64
	features      []float64
	modelScore    float64
	usedModel     bool
	deepScore     float64
	usedDeep      bool
	tokenCount    int
	matched       []string
}

type neurxRankerArtifact struct {
	ModelType    string    `json:"model_type"`
	Version      int       `json:"version"`
	FeatureNames []string  `json:"feature_names"`
	FeatureMeans []float64 `json:"feature_means"`
	FeatureStds  []float64 `json:"feature_stds"`
	Weights      []float64 `json:"weights"`
	Bias         float64   `json:"bias"`
	Activation   string    `json:"activation"`
}

type neurxRanker struct {
	modelType    string
	version      int
	featureNames []string
	means        []float64
	stds         []float64
	weights      []float64
	bias         float64
	activation   string
}

type LocalPatentRepository struct {
	mu          sync.RWMutex
	records     []model.PatentRecord
	semanticVec []map[string]float64
	rankingMode string
	dualRatio   int
	ranker      *neurxRanker
	deepEnabled bool
	deepTopN    int
	deepMixAlpha float64
}

func NewLocalPatentRepository(dataPath string) (*LocalPatentRepository, error) {
	return NewLocalPatentRepositoryWithStrategy(dataPath, "dual", 50)
}

func LoadNeurxRanker(modelPath string) (*neurxRanker, error) {
	if strings.TrimSpace(modelPath) == "" {
		return nil, nil
	}
	data, err := os.ReadFile(modelPath)
	if err != nil {
		return nil, err
	}

	var artifact neurxRankerArtifact
	if err := json.Unmarshal(data, &artifact); err != nil {
		return nil, fmt.Errorf("invalid neurx ranker artifact: %w", err)
	}
	if len(artifact.FeatureNames) == 0 {
		return nil, fmt.Errorf("invalid neurx ranker artifact: feature_names empty")
	}
	if len(artifact.FeatureMeans) != len(artifact.FeatureNames) || len(artifact.FeatureStds) != len(artifact.FeatureNames) || len(artifact.Weights) != len(artifact.FeatureNames) {
		return nil, fmt.Errorf("invalid neurx ranker artifact: feature dimensions mismatch")
	}
	stds := make([]float64, len(artifact.FeatureStds))
	copy(stds, artifact.FeatureStds)
	for i, v := range stds {
		if math.Abs(v) < 1e-9 {
			stds[i] = 1.0
		}
	}
	return &neurxRanker{
		modelType:    artifact.ModelType,
		version:      artifact.Version,
		featureNames: append([]string(nil), artifact.FeatureNames...),
		means:        append([]float64(nil), artifact.FeatureMeans...),
		stds:         stds,
		weights:      append([]float64(nil), artifact.Weights...),
		bias:         artifact.Bias,
		activation:   strings.ToLower(strings.TrimSpace(artifact.Activation)),
	}, nil
}

func clampPercent(v int) int {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}

func normalizeRankingMode(mode string) string {
	mode = strings.ToLower(strings.TrimSpace(mode))
	switch mode {
	case "lexical", "dual", "gray", "dual_deep":
		return mode
	default:
		return "dual"
	}
}

func clampTopN(v int) int {
	if v < 1 {
		return 1
	}
	if v > 100 {
		return 100
	}
	return v
}

func clampMixAlpha(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func NewLocalPatentRepositoryWithStrategy(dataPath string, rankingMode string, dualRatio int) (*LocalPatentRepository, error) {
	return NewLocalPatentRepositoryWithModel(dataPath, rankingMode, dualRatio, nil)
}

func NewLocalPatentRepositoryWithModel(dataPath string, rankingMode string, dualRatio int, ranker *neurxRanker) (*LocalPatentRepository, error) {
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
	semanticVec := make([]map[string]float64, 0, len(records))
	for _, rec := range records {
		docText := fmt.Sprintf("%s %s %s %s", rec.Title, rec.Abstract, rec.Claim, strings.Join(rec.Keywords, " "))
		semanticVec = append(semanticVec, buildSemanticVector(docText))
	}
	return &LocalPatentRepository{
		records:     records,
		semanticVec: semanticVec,
		rankingMode: normalizeRankingMode(rankingMode),
		dualRatio:   clampPercent(dualRatio),
		ranker:      ranker,
		deepEnabled: false,
		deepTopN:    8,
		deepMixAlpha: 0.35,
	}, nil
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

func sigmoid(v float64) float64 {
	if v >= 0 {
		z := math.Exp(-v)
		return 1 / (1 + z)
	}
	z := math.Exp(v)
	return z / (1 + z)
}

func (r *neurxRanker) Score(features []float64) float64 {
	if r == nil || len(features) != len(r.weights) {
		return 0
	}
	sum := r.bias
	for i, value := range features {
		std := r.stds[i]
		if math.Abs(std) < 1e-9 {
			std = 1.0
		}
		sum += ((value - r.means[i]) / std) * r.weights[i]
	}
	if r.activation == "sigmoid" || r.activation == "" {
		return sigmoid(sum)
	}
	return sum
}

func buildNeurxFeatures(item scoredPatent, tokenCount int, maxLex int, maxSem float64) []float64 {
	lexNorm := 0.0
	semNorm := 0.0
	if maxLex > 0 {
		lexNorm = float64(item.lexicalScore) / float64(maxLex)
	}
	if maxSem > 0 {
		semNorm = item.semanticScore / maxSem
	}
	return []float64{
		float64(item.titleScore),
		float64(item.abstractScore),
		float64(item.claimScore),
		float64(item.keywordHits),
		float64(len(item.matched)),
		float64(tokenCount),
		float64(item.lexicalScore),
		item.semanticScore,
		lexNorm,
		semNorm,
	}
}

func hashPercent(s string) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return int(h.Sum32() % 100)
}

func (r *LocalPatentRepository) useDualForQuery(query string) bool {
	mode, ratio := r.GetRankingConfig()
	switch mode {
	case "dual":
		return true
	case "dual_deep":
		return true
	case "lexical":
		return false
	case "gray":
		return hashPercent(query) < ratio
	default:
		return true
	}
}

func (r *LocalPatentRepository) GetRankingConfig() (string, int) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.rankingMode, r.dualRatio
}

func (r *LocalPatentRepository) UpdateRankingConfig(mode string, dualRatio int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.rankingMode = normalizeRankingMode(mode)
	r.dualRatio = clampPercent(dualRatio)
}

func (r *LocalPatentRepository) GetRankingModelStatus() model.RankingModelStatus {
	mode, ratio := r.GetRankingConfig()
	status := model.RankingModelStatus{
		RankingMode:  mode,
		DualRatio:    ratio,
		ModelLoaded:  r.ranker != nil,
		DeepEnabled:  r.deepEnabled,
		DeepTopN:     r.deepTopN,
		DeepMixAlpha: r.deepMixAlpha,
		FeatureNames: append([]string(nil), neurxFeatureNames...),
		FeatureCount: len(neurxFeatureNames),
		PatentCount:  len(r.records),
	}
	if r.ranker != nil {
		status.ModelType = r.ranker.modelType
		status.ModelVersion = r.ranker.version
		status.Activation = r.ranker.activation
		if len(r.ranker.featureNames) > 0 {
			status.FeatureNames = append([]string(nil), r.ranker.featureNames...)
			status.FeatureCount = len(r.ranker.featureNames)
		}
	}
	return status
}

func (r *LocalPatentRepository) ConfigureDeepReranker(enabled bool, topN int, mixAlpha float64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.deepEnabled = enabled
	r.deepTopN = clampTopN(topN)
	r.deepMixAlpha = clampMixAlpha(mixAlpha)
}

func buildResultItemDual(item scoredPatent) model.TaskResultItem {
	matched := strings.Join(item.matched, ", ")
	if matched == "" {
		matched = "(语义召回命中)"
	}
	reason := ""
	if item.usedModel {
		if item.usedDeep {
			reason = fmt.Sprintf(
				"命中关键词: %s；Neurx模型分=%.4f，Deep重排分=%.4f，融合后=%.4f（lexical=%d semantic=%.4f lex_norm=%.4f sem_norm=%.4f）；法律状态: %s。",
				matched,
				item.modelScore,
				item.deepScore,
				item.fusionScore,
				item.lexicalScore,
				item.semanticScore,
				item.lexicalNorm,
				item.semanticNorm,
				item.record.LegalStatus,
			)
		} else {
		reason = fmt.Sprintf(
			"命中关键词: %s；Neurx模型分=%.4f（lexical=%d semantic=%.4f lex_norm=%.4f sem_norm=%.4f）；法律状态: %s。",
			matched,
			item.modelScore,
			item.lexicalScore,
			item.semanticScore,
			item.lexicalNorm,
			item.semanticNorm,
			item.record.LegalStatus,
		)
		}
	} else {
		reason = fmt.Sprintf(
			"命中关键词: %s；启发式融合分=%.4f（lexical=%d semantic=%.4f lex_norm=%.4f sem_norm=%.4f）；法律状态: %s。",
			matched,
			item.fusionScore,
			item.lexicalScore,
			item.semanticScore,
			item.lexicalNorm,
			item.semanticNorm,
			item.record.LegalStatus,
		)
	}
	return model.TaskResultItem{
		PatentID:  item.record.PatentID,
		PatentURL: buildPatentURL(item.record.PatentID),
		Title:     item.record.Title,
		RiskLevel: calcRiskByFusion(item.fusionScore),
		Reason:    reason,
	}
}

func deepRerankScore(item scoredPatent) float64 {
	lex := item.lexicalNorm
	sem := item.semanticNorm
	matchedDensity := 0.0
	if item.tokenCount > 0 {
		matchedDensity = math.Min(1.0, float64(len(item.matched))/float64(item.tokenCount))
	}
	kwNorm := math.Min(1.0, float64(item.keywordHits)/4.0)
	claimNorm := math.Min(1.0, float64(item.claimScore)/3.0)
	lenPenalty := math.Min(1.0, float64(item.tokenCount)/12.0)

	h1 := math.Tanh(1.20*sem + 0.80*lex + 0.60*matchedDensity - 0.20*lenPenalty)
	h2 := math.Tanh(1.40*sem*matchedDensity + 0.50*kwNorm + 0.30*claimNorm)
	return sigmoid(1.10*h1 + 0.90*h2 + 0.70*sem + 0.30*lex - 0.20)
}

func (r *LocalPatentRepository) shouldUseDeepReranker() bool {
	if r.ranker == nil {
		return false
	}
	if !r.deepEnabled {
		return false
	}
	if r.deepTopN <= 0 {
		return false
	}
	if r.deepMixAlpha <= 0 {
		return false
	}
	return true
}

func (r *LocalPatentRepository) applyDeepRerank(ranked []scoredPatent) {
	if len(ranked) == 0 || !r.shouldUseDeepReranker() {
		return
	}
	topN := r.deepTopN
	if topN > len(ranked) {
		topN = len(ranked)
	}
	alpha := r.deepMixAlpha
	for i := 0; i < topN; i++ {
		deep := deepRerankScore(ranked[i])
		ranked[i].deepScore = deep
		ranked[i].usedDeep = true
		ranked[i].fusionScore = (1.0-alpha)*ranked[i].fusionScore + alpha*deep
	}
}

func buildResultItemLexical(item scoredPatent) model.TaskResultItem {
	matched := strings.Join(item.matched, ", ")
	if matched == "" {
		matched = "(无词法命中)"
	}
	reason := fmt.Sprintf(
		"命中关键词: %s；词法召回分 lexical=%d；法律状态: %s。",
		matched,
		item.lexicalScore,
		item.record.LegalStatus,
	)
	return model.TaskResultItem{
		PatentID:  item.record.PatentID,
		PatentURL: buildPatentURL(item.record.PatentID),
		Title:     item.record.Title,
		RiskLevel: calcRisk(item.lexicalScore),
		Reason:    reason,
	}
}

func (r *LocalPatentRepository) rankDualCandidates(query string, limit int) ([]scoredPatent, int) {
	tokens := splitQuery(query)
	if len(tokens) == 0 {
		return []scoredPatent{}, 0
	}
	if limit <= 0 {
		limit = 5
	}
	queryVec := buildSemanticVector(query)

	ranked := make([]scoredPatent, 0, len(r.records))
	maxLex := 0
	maxSem := 0.0
	for i, rec := range r.records {
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
		semantic := cosineSim(queryVec, r.semanticVec[i])

		if lexical == 0 && semantic == 0 {
			continue
		}
		matched := append(titleMatched, absMatched...)
		matched = append(matched, claimMatched...)
		matched = append(matched, keywordMatched...)

		ranked = append(ranked, scoredPatent{
			record:        rec,
			titleScore:    titleScore,
			abstractScore: absScore,
			claimScore:    claimScore,
			keywordHits:   keywordHits,
			lexicalScore:  lexical,
			semanticScore: semantic,
			matched:       uniqSorted(matched),
			tokenCount:    len(tokens),
		})
		if lexical > maxLex {
			maxLex = lexical
		}
		if semantic > maxSem {
			maxSem = semantic
		}
	}

	totalCandidates := len(ranked)
	if totalCandidates == 0 {
		return []scoredPatent{}, 0
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
		ranked[i].lexicalNorm = lexNorm
		ranked[i].semanticNorm = semNorm
		ranked[i].features = buildNeurxFeatures(ranked[i], len(tokens), maxLex, maxSem)
		ranked[i].fusionScore = lexNorm*0.65 + semNorm*0.35
		if r.ranker != nil {
			ranked[i].modelScore = r.ranker.Score(ranked[i].features)
			ranked[i].usedModel = true
			ranked[i].fusionScore = ranked[i].modelScore
		}
	}

	if r.ranker != nil {
		sort.SliceStable(ranked, func(i, j int) bool {
			if ranked[i].fusionScore == ranked[j].fusionScore {
				return ranked[i].lexicalScore > ranked[j].lexicalScore
			}
			return ranked[i].fusionScore > ranked[j].fusionScore
		})
		r.applyDeepRerank(ranked)
		sort.SliceStable(ranked, func(i, j int) bool {
			if ranked[i].fusionScore == ranked[j].fusionScore {
				return ranked[i].lexicalScore > ranked[j].lexicalScore
			}
			return ranked[i].fusionScore > ranked[j].fusionScore
		})
		if len(ranked) > limit {
			ranked = ranked[:limit]
		}
		return ranked, totalCandidates
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
	return fused, totalCandidates
}

func (r *LocalPatentRepository) ExplainQuery(_ context.Context, query string, limit int) (*model.RankingExplainResponse, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("query is required")
	}
	ranked, totalCandidates := r.rankDualCandidates(query, limit)
	mode, _ := r.GetRankingConfig()
	resp := &model.RankingExplainResponse{
		Query:          query,
		Limit:          limit,
		RankingMode:    mode,
		ModelLoaded:    r.ranker != nil,
		FeatureNames:   append([]string(nil), neurxFeatureNames...),
		CandidateCount: totalCandidates,
		Results:        make([]model.RankingExplainItem, 0, len(ranked)),
	}
	if r.ranker != nil && len(r.ranker.featureNames) > 0 {
		resp.FeatureNames = append([]string(nil), r.ranker.featureNames...)
	}
	for idx, item := range ranked {
		matched := make([]string, len(item.matched))
		copy(matched, item.matched)
		entry := model.RankingExplainItem{
			Rank:          idx + 1,
			PatentID:      item.record.PatentID,
			PatentURL:     buildPatentURL(item.record.PatentID),
			Title:         item.record.Title,
			Matched:       matched,
			TitleScore:    item.titleScore,
			AbstractScore: item.abstractScore,
			ClaimScore:    item.claimScore,
			KeywordHits:   item.keywordHits,
			MatchedCount:  len(item.matched),
			TokenCount:    item.tokenCount,
			LexicalScore:  item.lexicalScore,
			SemanticScore: item.semanticScore,
			LexicalNorm:   item.lexicalNorm,
			SemanticNorm:  item.semanticNorm,
			Features:      append([]float64(nil), item.features...),
			FinalScore:    item.fusionScore,
			Reason:        buildResultItemDual(item).Reason,
			RiskLevel:     calcRiskByFusion(item.fusionScore),
		}
		if item.usedModel {
			score := item.modelScore
			entry.ModelScore = &score
		}
		if item.usedDeep {
			score := item.deepScore
			entry.DeepScore = &score
		}
		resp.Results = append(resp.Results, entry)
	}
	return resp, nil
}

func (r *LocalPatentRepository) searchDual(query string, limit int) []model.TaskResultItem {
	ranked, _ := r.rankDualCandidates(query, limit)
	results := make([]model.TaskResultItem, 0, len(ranked))
	for _, item := range ranked {
		results = append(results, buildResultItemDual(item))
	}
	return results
}

func (r *LocalPatentRepository) searchLexical(query string, limit int) []model.TaskResultItem {
	tokens := splitQuery(query)
	if len(tokens) == 0 {
		return []model.TaskResultItem{}
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

		lexical := titleScore*4 + absScore*2 + claimScore*3 + keywordHits*2
		if lexical <= 0 {
			continue
		}
		matched := append(titleMatched, absMatched...)
		matched = append(matched, claimMatched...)
		matched = append(matched, keywordMatched...)
		ranked = append(ranked, scoredPatent{
			record:        rec,
			titleScore:    titleScore,
			abstractScore: absScore,
			claimScore:    claimScore,
			keywordHits:   keywordHits,
			lexicalScore:  lexical,
			matched:       uniqSorted(matched),
		})
	}

	sort.SliceStable(ranked, func(i, j int) bool {
		return ranked[i].lexicalScore > ranked[j].lexicalScore
	})

	if len(ranked) > limit {
		ranked = ranked[:limit]
	}

	results := make([]model.TaskResultItem, 0, len(ranked))
	for _, item := range ranked {
		results = append(results, buildResultItemLexical(item))
	}
	return results
}

func (r *LocalPatentRepository) Search(_ context.Context, query string, limit int) ([]model.TaskResultItem, error) {
	if limit <= 0 {
		limit = 5
	}
	if r.useDualForQuery(query) {
		return r.searchDual(query, limit), nil
	}
	return r.searchLexical(query, limit), nil
}
