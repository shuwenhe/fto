package observability

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

type statusCount struct {
	Path   string
	Method string
	Status int
	Count  uint64
}

type pathLatency struct {
	Path         string
	Method       string
	Count        uint64
	TotalLatency uint64
	Buckets      []uint64
}

type Metrics struct {
	mu sync.Mutex

	totalRequests uint64
	totalErrors   uint64
	taskCreates   uint64
	taskQuery     uint64

	statusByKey  map[string]uint64
	latencyByKey map[string]*pathLatency
	boundsMS     []uint64
}

func NewMetrics() *Metrics {
	return &Metrics{
		statusByKey:  map[string]uint64{},
		latencyByKey: map[string]*pathLatency{},
		boundsMS:     []uint64{50, 100, 200, 500, 1000, 2000, 5000},
	}
}

func pathKey(method, path string) string {
	return method + " " + path
}

func statusKey(method, path string, status int) string {
	return fmt.Sprintf("%s %s %d", method, path, status)
}

func (m *Metrics) ObserveHTTP(method, path string, status int, latencyMS uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.totalRequests++
	if status >= 500 {
		m.totalErrors++
	}

	sk := statusKey(method, path, status)
	m.statusByKey[sk]++

	pk := pathKey(method, path)
	lat, ok := m.latencyByKey[pk]
	if !ok {
		lat = &pathLatency{Path: path, Method: method, Buckets: make([]uint64, len(m.boundsMS)+1)}
		m.latencyByKey[pk] = lat
	}
	lat.Count++
	lat.TotalLatency += latencyMS

	idx := len(m.boundsMS)
	for i, b := range m.boundsMS {
		if latencyMS <= b {
			idx = i
			break
		}
	}
	lat.Buckets[idx]++
}

func (m *Metrics) IncTaskCreate() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.taskCreates++
}

func (m *Metrics) IncTaskQuery() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.taskQuery++
}

func (m *Metrics) snapshotStatusCounts() []statusCount {
	out := make([]statusCount, 0, len(m.statusByKey))
	for k, c := range m.statusByKey {
		parts := strings.Split(k, " ")
		if len(parts) < 3 {
			continue
		}
		status := 0
		fmt.Sscanf(parts[len(parts)-1], "%d", &status)
		method := parts[0]
		path := strings.Join(parts[1:len(parts)-1], " ")
		out = append(out, statusCount{Path: path, Method: method, Status: status, Count: c})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Method == out[j].Method {
			if out[i].Path == out[j].Path {
				return out[i].Status < out[j].Status
			}
			return out[i].Path < out[j].Path
		}
		return out[i].Method < out[j].Method
	})
	return out
}

func (m *Metrics) snapshotPathLatencies() []pathLatency {
	out := make([]pathLatency, 0, len(m.latencyByKey))
	for _, v := range m.latencyByKey {
		copyBuckets := make([]uint64, len(v.Buckets))
		copy(copyBuckets, v.Buckets)
		out = append(out, pathLatency{
			Path:         v.Path,
			Method:       v.Method,
			Count:        v.Count,
			TotalLatency: v.TotalLatency,
			Buckets:      copyBuckets,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Method == out[j].Method {
			return out[i].Path < out[j].Path
		}
		return out[i].Method < out[j].Method
	})
	return out
}

func (m *Metrics) p95FromBuckets(counts []uint64) uint64 {
	total := uint64(0)
	for _, c := range counts {
		total += c
	}
	if total == 0 {
		return 0
	}
	target := (total*95 + 99) / 100
	acc := uint64(0)
	for i, c := range counts {
		acc += c
		if acc >= target {
			if i < len(m.boundsMS) {
				return m.boundsMS[i]
			}
			return m.boundsMS[len(m.boundsMS)-1]
		}
	}
	return m.boundsMS[len(m.boundsMS)-1]
}

func (m *Metrics) RenderPrometheus() string {
	m.mu.Lock()
	totalRequests := m.totalRequests
	totalErrors := m.totalErrors
	taskCreates := m.taskCreates
	taskQuery := m.taskQuery
	statusCounts := m.snapshotStatusCounts()
	pathLatencies := m.snapshotPathLatencies()
	m.mu.Unlock()

	var sb strings.Builder
	sb.WriteString("# HELP fto_http_requests_total Total HTTP requests.\n")
	sb.WriteString("# TYPE fto_http_requests_total counter\n")
	sb.WriteString(fmt.Sprintf("fto_http_requests_total %d\n", totalRequests))

	sb.WriteString("# HELP fto_http_errors_total Total HTTP 5xx responses.\n")
	sb.WriteString("# TYPE fto_http_errors_total counter\n")
	sb.WriteString(fmt.Sprintf("fto_http_errors_total %d\n", totalErrors))

	sb.WriteString("# HELP fto_task_create_total Total task creation calls.\n")
	sb.WriteString("# TYPE fto_task_create_total counter\n")
	sb.WriteString(fmt.Sprintf("fto_task_create_total %d\n", taskCreates))

	sb.WriteString("# HELP fto_task_query_total Total task query calls.\n")
	sb.WriteString("# TYPE fto_task_query_total counter\n")
	sb.WriteString(fmt.Sprintf("fto_task_query_total %d\n", taskQuery))

	sb.WriteString("# HELP fto_http_requests_by_status Requests by method/path/status.\n")
	sb.WriteString("# TYPE fto_http_requests_by_status counter\n")
	for _, c := range statusCounts {
		sb.WriteString(fmt.Sprintf(
			"fto_http_requests_by_status{method=\"%s\",path=\"%s\",status=\"%d\"} %d\n",
			c.Method,
			c.Path,
			c.Status,
			c.Count,
		))
	}

	sb.WriteString("# HELP fto_http_latency_ms_avg Average latency per method/path in ms.\n")
	sb.WriteString("# TYPE fto_http_latency_ms_avg gauge\n")
	sb.WriteString("# HELP fto_http_latency_ms_p95 Approximate p95 latency per method/path in ms.\n")
	sb.WriteString("# TYPE fto_http_latency_ms_p95 gauge\n")
	for _, lat := range pathLatencies {
		avg := 0.0
		if lat.Count > 0 {
			avg = float64(lat.TotalLatency) / float64(lat.Count)
		}
		p95 := m.p95FromBuckets(lat.Buckets)
		sb.WriteString(fmt.Sprintf(
			"fto_http_latency_ms_avg{method=\"%s\",path=\"%s\"} %.2f\n",
			lat.Method,
			lat.Path,
			avg,
		))
		sb.WriteString(fmt.Sprintf(
			"fto_http_latency_ms_p95{method=\"%s\",path=\"%s\"} %d\n",
			lat.Method,
			lat.Path,
			p95,
		))
	}

	return sb.String()
}
