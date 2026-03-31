package service

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	"fto-backend/internal/model"
	"fto-backend/internal/repository"
)

type TaskService interface {
	CreateTask(ctx context.Context, query string) (*model.TaskState, error)
	GetTask(ctx context.Context, taskID string) (*model.TaskState, error)
	GetTaskResult(ctx context.Context, taskID string) ([]model.TaskResultItem, string, error)
}

type taskService struct {
	repo repository.TaskRepository
	seq  uint64
}

func NewTaskService(repo repository.TaskRepository) TaskService {
	return &taskService{repo: repo}
}

func nowUTC() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func (s *taskService) CreateTask(ctx context.Context, query string) (*model.TaskState, error) {
	taskID := fmt.Sprintf("task-%d-%d", time.Now().UnixNano(), atomic.AddUint64(&s.seq, 1))
	now := nowUTC()
	task := &model.TaskState{
		TaskID:    taskID,
		Query:     query,
		Status:    "queued",
		Progress:  0,
		CreatedAt: now,
		UpdatedAt: now,
		Result:    []model.TaskResultItem{},
	}
	if err := s.repo.CreateTask(ctx, task); err != nil {
		return nil, err
	}

	go s.simulateTask(taskID)
	return task, nil
}

func (s *taskService) GetTask(ctx context.Context, taskID string) (*model.TaskState, error) {
	return s.repo.GetTask(ctx, taskID)
}

func (s *taskService) GetTaskResult(ctx context.Context, taskID string) ([]model.TaskResultItem, string, error) {
	task, err := s.repo.GetTask(ctx, taskID)
	if err != nil {
		return nil, "", err
	}
	if task.Status != "succeeded" {
		return []model.TaskResultItem{}, task.Status, nil
	}
	return task.Result, task.Status, nil
}

func (s *taskService) simulateTask(taskID string) {
	ctx := context.Background()
	steps := []int{20, 45, 70, 100}
	for _, p := range steps {
		time.Sleep(1200 * time.Millisecond)
		task, err := s.repo.GetTask(ctx, taskID)
		if err != nil {
			return
		}
		task.Progress = p
		task.UpdatedAt = nowUTC()
		if p < 100 {
			task.Status = "running"
		} else {
			task.Status = "succeeded"
			task.Result = []model.TaskResultItem{
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
		if err := s.repo.UpdateTask(ctx, task); err != nil {
			return
		}
	}
}
