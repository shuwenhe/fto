package model

type TaskCreateRequest struct {
	Query string `json:"query" binding:"required"`
}

type RankingExplainRequest struct {
	Query string `json:"query" binding:"required"`
	Limit int    `json:"limit"`
}

type TaskResultItem struct {
	PatentID  string `json:"patent_id"`
	PatentURL string `json:"patent_url"`
	Title     string `json:"title"`
	RiskLevel string `json:"risk_level"`
	Reason    string `json:"reason"`
}

type RankingModelStatus struct {
	RankingMode         string   `json:"ranking_mode"`
	DualRatio           int      `json:"dual_ratio"`
	ModelLoaded         bool     `json:"model_loaded"`
	EncoderLoaded       bool     `json:"encoder_loaded"`
	ElasticsearchEnabled bool    `json:"elasticsearch_enabled"`
	DeepEnabled         bool     `json:"deep_enabled"`
	DeepTopN            int      `json:"deep_top_n"`
	DeepMixAlpha        float64  `json:"deep_mix_alpha"`
	ModelType           string   `json:"model_type,omitempty"`
	EncoderModelType    string   `json:"encoder_model_type,omitempty"`
	ElasticsearchIndex  string   `json:"elasticsearch_index,omitempty"`
	ModelVersion        int      `json:"model_version,omitempty"`
	EncoderModelVersion int      `json:"encoder_model_version,omitempty"`
	Activation          string   `json:"activation,omitempty"`
	FeatureNames        []string `json:"feature_names,omitempty"`
	FeatureCount        int      `json:"feature_count"`
	PatentCount         int      `json:"patent_count"`
}

type RankingExplainItem struct {
	Rank          int       `json:"rank"`
	PatentID      string    `json:"patent_id"`
	PatentURL     string    `json:"patent_url"`
	Title         string    `json:"title"`
	Matched       []string  `json:"matched"`
	TitleScore    int       `json:"title_score"`
	AbstractScore int       `json:"abstract_score"`
	ClaimScore    int       `json:"claim_score"`
	KeywordHits   int       `json:"keyword_hits"`
	MatchedCount  int       `json:"matched_count"`
	TokenCount    int       `json:"token_count"`
	LexicalScore  int       `json:"lexical_score"`
	SemanticScore float64   `json:"semantic_score"`
	LexicalNorm   float64   `json:"lexical_norm"`
	SemanticNorm  float64   `json:"semantic_norm"`
	Features      []float64 `json:"features"`
	FinalScore    float64   `json:"final_score"`
	ModelScore    *float64  `json:"model_score,omitempty"`
	DeepScore     *float64  `json:"deep_score,omitempty"`
	Reason        string    `json:"reason"`
	RiskLevel     string    `json:"risk_level"`
}

type RankingExplainResponse struct {
	Query          string               `json:"query"`
	Limit          int                  `json:"limit"`
	RankingMode    string               `json:"ranking_mode"`
	ModelLoaded    bool                 `json:"model_loaded"`
	FeatureNames   []string             `json:"feature_names"`
	CandidateCount int                  `json:"candidate_count"`
	Results        []RankingExplainItem `json:"results"`
}

type EncoderExplainItem struct {
	Rank         int       `json:"rank"`
	PatentID     string    `json:"patent_id"`
	PatentURL    string    `json:"patent_url"`
	Title        string    `json:"title"`
	Matched      []string  `json:"matched"`
	Features     []float64 `json:"features"`
	Embedding    []float64 `json:"embedding"`
	EncoderScore float64   `json:"encoder_score"`
	FinalScore   float64   `json:"final_score"`
	ModelScore   *float64  `json:"model_score,omitempty"`
	DeepScore    *float64  `json:"deep_score,omitempty"`
	RiskLevel    string    `json:"risk_level"`
	Reason       string    `json:"reason"`
}

type EncoderExplainResponse struct {
	Query          string               `json:"query"`
	Limit          int                  `json:"limit"`
	ModelLoaded    bool                 `json:"model_loaded"`
	ModelType      string               `json:"model_type,omitempty"`
	ModelVersion   int                  `json:"model_version,omitempty"`
	FeatureNames   []string             `json:"feature_names"`
	EmbeddingDim   int                  `json:"embedding_dim"`
	CandidateCount int                  `json:"candidate_count"`
	Results        []EncoderExplainItem `json:"results"`
}

type TaskState struct {
	TaskID    string           `json:"task_id"`
	Query     string           `json:"query"`
	Status    string           `json:"status"`
	Progress  int              `json:"progress"`
	CreatedAt string           `json:"created_at"`
	UpdatedAt string           `json:"updated_at"`
	Result    []TaskResultItem `json:"result"`
}
