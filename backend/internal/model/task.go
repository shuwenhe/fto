package model

type TaskCreateRequest struct {
	Query string `json:"query" binding:"required"`
}

type TaskResultItem struct {
	PatentID  string `json:"patent_id"`
	PatentURL string `json:"patent_url"`
	Title     string `json:"title"`
	RiskLevel string `json:"risk_level"`
	Reason    string `json:"reason"`
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
