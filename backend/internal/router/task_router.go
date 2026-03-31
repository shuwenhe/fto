package router

import (
	"errors"
	"net/http"

	"fto-backend/internal/model"
	"fto-backend/internal/repository"
	"fto-backend/internal/service"

	"github.com/gin-gonic/gin"
)

func RegisterRoutes(r *gin.Engine, taskService service.TaskService) {
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true, "service": "fto-backend-gin"})
	})

	r.POST("/tasks", func(c *gin.Context) {
		var req model.TaskCreateRequest
		if err := c.ShouldBindJSON(&req); err != nil || req.Query == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid query"})
			return
		}

		task, err := taskService.CreateTask(c.Request.Context(), req.Query)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "create task failed"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"task_id": task.TaskID, "status": task.Status})
	})

	r.GET("/tasks/:taskID", func(c *gin.Context) {
		taskID := c.Param("taskID")
		task, err := taskService.GetTask(c.Request.Context(), taskID)
		if err != nil {
			if errors.Is(err, repository.ErrTaskNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "query task failed"})
			return
		}
		c.JSON(http.StatusOK, task)
	})

	r.GET("/tasks/:taskID/result", func(c *gin.Context) {
		taskID := c.Param("taskID")
		result, status, err := taskService.GetTaskResult(c.Request.Context(), taskID)
		if err != nil {
			if errors.Is(err, repository.ErrTaskNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "query result failed"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"task_id": taskID, "status": status, "result": result})
	})
}
