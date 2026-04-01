package service

import "strings"

type QueryRewriter interface {
	Rewrite(query string) (string, bool)
}

type RuleBasedQueryRewriter struct {
	rules map[string][]string
}

func NewRuleBasedQueryRewriter() *RuleBasedQueryRewriter {
	return &RuleBasedQueryRewriter{
		rules: map[string][]string{
			"无线充电": {"充电", "电能传输"},
			"快充":   {"快速充电", "充电"},
			"散热":   {"热管理", "温控"},
			"电池":   {"储能", "电芯"},
			"逆变器":  {"功率变换", "电力电子"},
			"变流器":  {"功率变换", "电力电子"},
		},
	}
}

func (r *RuleBasedQueryRewriter) Rewrite(query string) (string, bool) {
	q := strings.TrimSpace(query)
	if q == "" {
		return q, false
	}
	out := q
	applied := false
	for phrase, expansions := range r.rules {
		if !strings.Contains(out, phrase) {
			continue
		}
		for _, ex := range expansions {
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
