package router

import (
	"errors"
	"net/http"

	"fto-backend/internal/model"
	"fto-backend/internal/observability"
	"fto-backend/internal/repository"
	"fto-backend/internal/service"

	"github.com/gin-gonic/gin"
)

func RegisterRoutes(r *gin.Engine, taskService service.TaskService, metrics *observability.Metrics) {
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true, "service": "fto-backend-gin"})
	})

	r.GET("/metrics", func(c *gin.Context) {
		if metrics == nil {
			c.String(http.StatusOK, "")
			return
		}
		c.Data(http.StatusOK, "text/plain; version=0.0.4", []byte(metrics.RenderPrometheus()))
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
