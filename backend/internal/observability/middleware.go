package observability

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/gin-gonic/gin"
)

const RequestIDHeader = "X-Request-ID"

func RequestIDMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		rid := c.GetHeader(RequestIDHeader)
		if rid == "" {
			rid = randomID()
		}
		c.Set("request_id", rid)
		c.Writer.Header().Set(RequestIDHeader, rid)
		c.Next()
	}
}

func AccessLogMiddleware(metrics *Metrics) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()

		latencyMS := uint64(time.Since(start).Milliseconds())
		path := c.FullPath()
		if path == "" {
			path = c.Request.URL.Path
		}

		if metrics != nil {
			metrics.ObserveHTTP(c.Request.Method, path, c.Writer.Status(), latencyMS)
		}

		entry := map[string]interface{}{
			"ts":         time.Now().UTC().Format(time.RFC3339),
			"event":      "http_access",
			"request_id": getRequestID(c),
			"method":     c.Request.Method,
			"path":       path,
			"status":     c.Writer.Status(),
			"latency_ms": latencyMS,
			"client_ip":  c.ClientIP(),
			"size":       c.Writer.Size(),
		}
		if len(c.Errors) > 0 {
			entry["errors"] = c.Errors.String()
		}
		logJSON(entry)
	}
}

func LogTaskEvent(c *gin.Context, event string, fields map[string]interface{}) {
	entry := map[string]interface{}{
		"ts":         time.Now().UTC().Format(time.RFC3339),
		"event":      event,
		"request_id": getRequestID(c),
	}
	for k, v := range fields {
		entry[k] = v
	}
	logJSON(entry)
}

func getRequestID(c *gin.Context) string {
	if v, ok := c.Get("request_id"); ok {
		if s, ok2 := v.(string); ok2 {
			return s
		}
	}
	return ""
}

func logJSON(entry map[string]interface{}) {
	b, err := json.Marshal(entry)
	if err != nil {
		log.Printf("{\"event\":\"log_marshal_error\",\"error\":%q}", err.Error())
		return
	}
	log.Println(string(b))
}

func randomID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("rid-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
