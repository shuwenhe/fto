package main

import (
	"fmt"
	"net/http"
	"sync/atomic"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type TaskCreateRequest struct {
	Query string `json:"query" binding:"required"`
}

type TaskResultItem struct {
	PatentID  string `json:"patent_id"`
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

var (
	tasks = map[string]*TaskState{}
	mu    sync.RWMutex
	seq   uint64
)

func nowUTC() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func simulateTask(taskID string) {
	steps := []int{20, 45, 70, 100}
	for _, p := range steps {
		time.Sleep(1200 * time.Millisecond)
		mu.Lock()
		task, ok := tasks[taskID]
		if !ok {
			mu.Unlock()
			return
		}
		task.Progress = p
		task.UpdatedAt = nowUTC()
		if p < 100 {
			task.Status = "running"
		} else {
			task.Status = "succeeded"
			task.Result = []TaskResultItem{
				{
					PatentID:  "CN202410001A",
					Title:     "一种用于无线充电的温控结构",
					RiskLevel: "medium",
					Reason:    "核心结构相似，建议调整散热层叠设计。",
				},
				{
					PatentID:  "US20240123456A1",
					Title:     "Wireless charging coil arrangement",
					RiskLevel: "low",
					Reason:    "技术路线相近但关键参数不同，侵权风险较低。",
				},
			}
		}
		mu.Unlock()
	}
}

func main() {
	r := gin.Default()

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true, "service": "fto-backend-gin"})
	})

	r.POST("/tasks", func(c *gin.Context) {
		var req TaskCreateRequest
		if err := c.ShouldBindJSON(&req); err != nil || req.Query == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid query"})
			return
		}

		taskID := fmt.Sprintf("task-%d-%d", time.Now().UnixNano(), atomic.AddUint64(&seq, 1))
		now := nowUTC()
		task := &TaskState{
			TaskID:    taskID,
			Query:     req.Query,
			Status:    "queued",
			Progress:  0,
			CreatedAt: now,
			UpdatedAt: now,
			Result:    []TaskResultItem{},
		}

		mu.Lock()
		tasks[taskID] = task
		mu.Unlock()

		go simulateTask(taskID)
		c.JSON(http.StatusOK, gin.H{"task_id": taskID, "status": task.Status})
	})

	r.GET("/tasks/:taskID", func(c *gin.Context) {
		taskID := c.Param("taskID")
		mu.RLock()
		task, ok := tasks[taskID]
		mu.RUnlock()
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
			return
		}
		c.JSON(http.StatusOK, task)
	})

	r.GET("/tasks/:taskID/result", func(c *gin.Context) {
		taskID := c.Param("taskID")
		mu.RLock()
		task, ok := tasks[taskID]
		mu.RUnlock()
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "task not found"})
			return
		}
		if task.Status != "succeeded" {
			c.JSON(http.StatusOK, gin.H{"task_id": taskID, "status": task.Status, "result": []TaskResultItem{}})
			return
		}
		c.JSON(http.StatusOK, gin.H{"task_id": taskID, "status": task.Status, "result": task.Result})
	})

	_ = r.Run(":8010")
}
