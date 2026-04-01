package service

import (
	"encoding/json"
	"os"
	"strings"
)

type QueryRewriter interface {
	Rewrite(query string) (string, bool)
}

type QueryRewriteRule struct {
	Match  string   `json:"match"`
	Append []string `json:"append"`
}

type queryRewriteRuleFile struct {
	Rules []QueryRewriteRule `json:"rules"`
}

type RuleBasedQueryRewriter struct {
	rules []QueryRewriteRule
}

func NewRuleBasedQueryRewriterFromFile(path string) (*RuleBasedQueryRewriter, error) {
	data, err := os.ReadFile(strings.TrimSpace(path))
	if err != nil {
		return nil, err
	}

	parsed := queryRewriteRuleFile{}
	if err := json.Unmarshal(data, &parsed); err == nil && len(parsed.Rules) > 0 {
		return &RuleBasedQueryRewriter{rules: normalizeRules(parsed.Rules)}, nil
	}

	// Backward-compatible format: {"关键词": ["扩展1", "扩展2"]}
	legacy := map[string][]string{}
	if err := json.Unmarshal(data, &legacy); err != nil {
		return nil, err
	}
	rules := make([]QueryRewriteRule, 0, len(legacy))
	for match, appends := range legacy {
		rules = append(rules, QueryRewriteRule{Match: match, Append: appends})
	}
	return &RuleBasedQueryRewriter{rules: normalizeRules(rules)}, nil
}

func normalizeRules(raw []QueryRewriteRule) []QueryRewriteRule {
	out := make([]QueryRewriteRule, 0, len(raw))
	for _, rule := range raw {
		m := strings.TrimSpace(rule.Match)
		if m == "" {
			continue
		}
		appendTerms := make([]string, 0, len(rule.Append))
		for _, term := range rule.Append {
			t := strings.TrimSpace(term)
			if t == "" {
				continue
			}
			appendTerms = append(appendTerms, t)
		}
		if len(appendTerms) == 0 {
			continue
		}
		out = append(out, QueryRewriteRule{Match: m, Append: appendTerms})
	}
	return out
}

func (r *RuleBasedQueryRewriter) Rewrite(query string) (string, bool) {
	q := strings.TrimSpace(query)
	if q == "" {
		return q, false
	}
	out := q
	applied := false
	for _, rule := range r.rules {
		if !strings.Contains(out, rule.Match) {
			continue
		}
		for _, ex := range rule.Append {
			ex = strings.TrimSpace(ex)
			if ex == "" || strings.Contains(out, ex) {
				continue
			}
			out += " " + ex
			applied = true
		}
	}
	return strings.TrimSpace(out), applied
}
