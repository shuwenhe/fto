package router

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"fto-backend/internal/model"
	"fto-backend/internal/observability"
	"fto-backend/internal/repository"
	"fto-backend/internal/service"

	"github.com/gin-gonic/gin"
)

type rankingConfigRequest struct {
	Mode      string `json:"mode"`
	DualRatio int    `json:"dual_ratio"`
}

func RegisterRoutes(r *gin.Engine, taskService service.TaskService, metrics *observability.Metrics, rankingCtrl repository.RankingConfigController, queryRewriter service.QueryRewriter) {
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true, "service": "fto-backend-gin"})
	})

	r.GET("/frontend-build-id", func(c *gin.Context) {
		buildID, err := os.ReadFile("/app/fto/frontend/.next/BUILD_ID")
		if err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "frontend build id not available"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"build_id": strings.TrimSpace(string(buildID))})
	})

	r.GET("/metrics", func(c *gin.Context) {
		if metrics == nil {
			c.String(http.StatusOK, "")
			return
		}
		c.Data(http.StatusOK, "text/plain; version=0.0.4", []byte(metrics.RenderPrometheus()))
	})

	r.GET("/ops/ranking-config", func(c *gin.Context) {
		if rankingCtrl == nil {
			c.JSON(http.StatusNotImplemented, gin.H{"error": "ranking config controller not available"})
			return
		}
		mode, ratio := rankingCtrl.GetRankingConfig()
		c.JSON(http.StatusOK, gin.H{"mode": mode, "dual_ratio": ratio})
	})

	r.GET("/ops/ranking-model", func(c *gin.Context) {
		provider, ok := rankingCtrl.(repository.RankingModelStatusProvider)
		if !ok || provider == nil {
			c.JSON(http.StatusNotImplemented, gin.H{"error": "ranking model status not available"})
			return
		}
		c.JSON(http.StatusOK, provider.GetRankingModelStatus())
	})

	r.POST("/ops/ranking-config", func(c *gin.Context) {
		if rankingCtrl == nil {
			c.JSON(http.StatusNotImplemented, gin.H{"error": "ranking config controller not available"})
			return
		}
		var req rankingConfigRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
			return
		}
		rankingCtrl.UpdateRankingConfig(req.Mode, req.DualRatio)
		mode, ratio := rankingCtrl.GetRankingConfig()
		observability.LogTaskEvent(c, "ranking_config_updated", map[string]interface{}{"mode": mode, "dual_ratio": ratio})
		c.JSON(http.StatusOK, gin.H{"mode": mode, "dual_ratio": ratio})
	})

	r.POST("/ops/ranking-explain", func(c *gin.Context) {
		provider, ok := rankingCtrl.(repository.RankingExplainProvider)
		if !ok || provider == nil {
			c.JSON(http.StatusNotImplemented, gin.H{"error": "ranking explain not available"})
			return
		}
		var req model.RankingExplainRequest
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Query) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid query"})
			return
		}
		if req.Limit <= 0 {
			req.Limit = 5
		}
		originalQuery := strings.TrimSpace(req.Query)
		searchQuery := originalQuery
		rewriteApplied := false
		if queryRewriter != nil {
			if rewritten, applied := queryRewriter.Rewrite(originalQuery); applied {
				searchQuery = rewritten
				rewriteApplied = true
			}
		}
		resp, err := provider.ExplainQuery(c.Request.Context(), searchQuery, req.Limit)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		resp.OriginalQuery = originalQuery
		resp.RewrittenQuery = searchQuery
		resp.RewriteApplied = rewriteApplied
		observability.LogTaskEvent(c, "ranking_explain_queried", map[string]interface{}{"query": originalQuery, "rewritten_query": searchQuery, "rewrite_applied": rewriteApplied, "limit": req.Limit, "results": len(resp.Results), "model_loaded": resp.ModelLoaded})
		c.JSON(http.StatusOK, resp)
	})

	r.POST("/ops/encoder-explain", func(c *gin.Context) {
		provider, ok := rankingCtrl.(repository.EncoderExplainProvider)
		if !ok || provider == nil {
			c.JSON(http.StatusNotImplemented, gin.H{"error": "encoder explain not available"})
			return
		}
		var req model.RankingExplainRequest
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Query) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid query"})
			return
		}
		if req.Limit <= 0 {
			req.Limit = 5
		}
		originalQuery := strings.TrimSpace(req.Query)
		searchQuery := originalQuery
		rewriteApplied := false
		if queryRewriter != nil {
			if rewritten, applied := queryRewriter.Rewrite(originalQuery); applied {
				searchQuery = rewritten
				rewriteApplied = true
			}
		}
		resp, err := provider.ExplainEncoder(c.Request.Context(), searchQuery, req.Limit)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		resp.OriginalQuery = originalQuery
		resp.RewrittenQuery = searchQuery
		resp.RewriteApplied = rewriteApplied
		observability.LogTaskEvent(c, "encoder_explain_queried", map[string]interface{}{"query": originalQuery, "rewritten_query": searchQuery, "rewrite_applied": rewriteApplied, "limit": req.Limit, "results": len(resp.Results), "model_loaded": resp.ModelLoaded})
		c.JSON(http.StatusOK, resp)
	})

	r.POST("/ops/fto-report", func(c *gin.Context) {
		provider, ok := rankingCtrl.(repository.RankingExplainProvider)
		if !ok || provider == nil {
			c.JSON(http.StatusNotImplemented, gin.H{"error": "ranking explain not available"})
			return
		}

		var req model.FTOReportRequest
		if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Query) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid query"})
			return
		}
		if req.Limit <= 0 {
			req.Limit = 8
		}
		if req.TopN <= 0 {
			req.TopN = 5
		}

		originalQuery := strings.TrimSpace(req.Query)
		searchQuery := originalQuery
		rewriteApplied := false
		if queryRewriter != nil {
			if rewritten, applied := queryRewriter.Rewrite(originalQuery); applied {
				searchQuery = rewritten
				rewriteApplied = true
			}
		}

		rankingResp, err := provider.ExplainQuery(c.Request.Context(), searchQuery, req.Limit)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}

		encoderScoreByPatent := map[string]float64{}
		if req.IncludeEncoder {
			if encProvider, ok := rankingCtrl.(repository.EncoderExplainProvider); ok && encProvider != nil {
				if encResp, err := encProvider.ExplainEncoder(c.Request.Context(), searchQuery, req.Limit); err == nil {
					for _, item := range encResp.Results {
						encoderScoreByPatent[item.PatentID] = item.EncoderScore
					}
				}
			}
		}

		evidenceLimit := req.TopN
		if evidenceLimit > len(rankingResp.Results) {
			evidenceLimit = len(rankingResp.Results)
		}

		riskDistribution := map[string]int{"low": 0, "medium": 0, "high": 0}
		for _, item := range rankingResp.Results {
			level := strings.ToLower(strings.TrimSpace(item.RiskLevel))
			if level == "low" || level == "medium" || level == "high" {
				riskDistribution[level]++
			}
		}

		evidence := make([]model.FTOReportEvidenceItem, 0, evidenceLimit)
		topRisk := "low"
		for i := 0; i < evidenceLimit; i++ {
			item := rankingResp.Results[i]
			entry := model.FTOReportEvidenceItem{
				Rank:       item.Rank,
				PatentID:   item.PatentID,
				PatentURL:  item.PatentURL,
				Title:      item.Title,
				RiskLevel:  item.RiskLevel,
				FinalScore: item.FinalScore,
				ModelScore: item.ModelScore,
				DeepScore:  item.DeepScore,
				Matched:    append([]string(nil), item.Matched...),
				Reason:     item.Reason,
				SourceType: "patent",
				SourceID:   item.PatentID,
				SourceURL:  item.PatentURL,
			}
			if score, ok := encoderScoreByPatent[item.PatentID]; ok {
				s := score
				entry.EncoderScore = &s
			}
			evidence = append(evidence, entry)

			level := strings.ToLower(strings.TrimSpace(item.RiskLevel))
			if level == "high" {
				topRisk = "high"
			} else if level == "medium" && topRisk != "high" {
				topRisk = "medium"
			}
		}

		findings := []string{}
		if len(evidence) > 0 {
			first := evidence[0]
			findings = append(findings, fmt.Sprintf("Top1 候选专利为 %s（%s），风险等级 %s，综合分 %.4f。", first.PatentID, first.Title, first.RiskLevel, first.FinalScore))
		}
		findings = append(findings, fmt.Sprintf("候选集风险分布：high=%d，medium=%d，low=%d。", riskDistribution["high"], riskDistribution["medium"], riskDistribution["low"]))
		if rewriteApplied {
			findings = append(findings, fmt.Sprintf("查询已改写："+"%s -> %s", originalQuery, searchQuery))
		}

		recommendations := []string{
			"优先对 high 风险专利进行权利要求逐条比对，输出可规避的结构差异清单。",
			"对 medium 风险候选开展技术特征映射，评估侵权边界和可替代方案。",
			"将本次证据链接纳入评审记录，形成可追溯审计链路。",
		}

		report := model.FTOReportResponse{
			ReportID:       fmt.Sprintf("fto-report-%d", time.Now().UnixNano()),
			GeneratedAt:    time.Now().UTC().Format(time.RFC3339),
			Query:          searchQuery,
			OriginalQuery:  originalQuery,
			RewrittenQuery: searchQuery,
			RewriteApplied: rewriteApplied,
			CandidateCount: rankingResp.CandidateCount,
			RiskDistribution: riskDistribution,
			ExecutiveSummary: fmt.Sprintf("本次 FTO 防侵权分析在候选集中识别到 %d 条 high 风险、%d 条 medium 风险专利，整体最高风险等级为 %s。", riskDistribution["high"], riskDistribution["medium"], topRisk),
			CoreFindings: findings,
			Recommendations: recommendations,
			Evidence: evidence,
		}

		observability.LogTaskEvent(c, "fto_report_generated", map[string]interface{}{"query": originalQuery, "rewritten_query": searchQuery, "rewrite_applied": rewriteApplied, "candidate_count": report.CandidateCount, "evidence_count": len(report.Evidence)})
		c.JSON(http.StatusOK, report)
	})

	r.POST("/tasks", func(c *gin.Context) {
		if metrics != nil {
			metrics.IncTaskCreate()
		}
		var req model.TaskCreateRequest
		if err := c.ShouldBindJSON(&req); err != nil || req.Query == "" {
			observability.LogTaskEvent(c, "task_create_invalid", map[string]interface{}{"error": "invalid query"})
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid query"})
			return
		}

		task, err := taskService.CreateTask(c.Request.Context(), req.Query)
		if err != nil {
			observability.LogTaskEvent(c, "task_create_failed", map[string]interface{}{"query": req.Query, "error": err.Error()})
			c.JSON(http.StatusInternalServerError, gin.H{"error": "create task failed"})
			return
		}
		observability.LogTaskEvent(c, "task_created", map[string]interface{}{"task_id": task.TaskID, "query": req.Query, "rewritten_query": task.RewrittenQuery})
		c.JSON(http.StatusOK, gin.H{"task_id": task.TaskID, "status": task.Status})
	})

	r.GET("/tasks/:taskID", func(c *gin.Context) {
		if metrics != nil {
			metrics.IncTaskQuery()
		}
		taskID := c.Param("taskID")
		task, err := taskService.GetTask(c.Request.Context(), taskID)
		if err != nil {
			observability.LogTaskEvent(c, "task_get_failed", map[string]interface{}{"task_id": taskID, "error": err.Error()})
			if errors.Is(err, repository.ErrTaskNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "query task failed"})
			return
		}
		observability.LogTaskEvent(c, "task_queried", map[string]interface{}{"task_id": taskID, "status": task.Status, "progress": task.Progress})
		c.JSON(http.StatusOK, task)
	})

	r.GET("/tasks/:taskID/result", func(c *gin.Context) {
		if metrics != nil {
			metrics.IncTaskQuery()
		}
		taskID := c.Param("taskID")
		result, status, err := taskService.GetTaskResult(c.Request.Context(), taskID)
		if err != nil {
			observability.LogTaskEvent(c, "task_result_failed", map[string]interface{}{"task_id": taskID, "error": err.Error()})
			if errors.Is(err, repository.ErrTaskNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "query result failed"})
			return
		}
		observability.LogTaskEvent(c, "task_result_queried", map[string]interface{}{"task_id": taskID, "status": status, "result_count": len(result)})
		c.JSON(http.StatusOK, gin.H{"task_id": taskID, "status": status, "result": result})
	})
}
