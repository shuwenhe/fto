package router

import (
	"errors"
	"net/http"
	"os"
	"strings"

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

func RegisterRoutes(r *gin.Engine, taskService service.TaskService, metrics *observability.Metrics, rankingCtrl repository.RankingConfigController) {
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
		resp, err := provider.ExplainQuery(c.Request.Context(), req.Query, req.Limit)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		observability.LogTaskEvent(c, "ranking_explain_queried", map[string]interface{}{"query": req.Query, "limit": req.Limit, "results": len(resp.Results), "model_loaded": resp.ModelLoaded})
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
		resp, err := provider.ExplainEncoder(c.Request.Context(), req.Query, req.Limit)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		observability.LogTaskEvent(c, "encoder_explain_queried", map[string]interface{}{"query": req.Query, "limit": req.Limit, "results": len(resp.Results), "model_loaded": resp.ModelLoaded})
		c.JSON(http.StatusOK, resp)
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
		observability.LogTaskEvent(c, "task_created", map[string]interface{}{"task_id": task.TaskID, "query": req.Query})
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
