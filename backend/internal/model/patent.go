package model

type PatentRecord struct {
	PatentID    string   `json:"patent_id"`
	Title       string   `json:"title"`
	Abstract    string   `json:"abstract"`
	Claim       string   `json:"claim"`
	Keywords    []string `json:"keywords"`
	LegalStatus string   `json:"legal_status"`
}
