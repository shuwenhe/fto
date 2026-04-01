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
	repo       repository.TaskRepository
	patentRepo repository.PatentDataRepository
	queryRewriter QueryRewriter
	topK       int
	seq        uint64
}

func NewTaskService(repo repository.TaskRepository, patentRepo repository.PatentDataRepository, queryRewriter QueryRewriter, topK int) TaskService {
	if topK <= 0 {
		topK = 5
	}
	return &taskService{repo: repo, patentRepo: patentRepo, queryRewriter: queryRewriter, topK: topK}
}

func nowUTC() string {
	return time.Now().UTC().Format(time.RFC3339)
}

func (s *taskService) CreateTask(ctx context.Context, query string) (*model.TaskState, error) {
	query = strings.TrimSpace(query)
	taskID := fmt.Sprintf("task-%d-%d", time.Now().UnixNano(), atomic.AddUint64(&s.seq, 1))
	now := nowUTC()
	rewrittenQuery := ""
	if s.queryRewriter != nil {
		rewritten, applied := s.queryRewriter.Rewrite(query)
		if applied {
			rewrittenQuery = rewritten
		}
	}
	task := &model.TaskState{
		TaskID:    taskID,
		Query:     query,
		RewrittenQuery: rewrittenQuery,
		Status:    "queued",
		Progress:  0,
		CreatedAt: now,
		UpdatedAt: now,
		Result:    []model.TaskResultItem{},
	}
	if err := s.repo.CreateTask(ctx, task); err != nil {
		return nil, err
	}

	go s.runTask(*task)
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

func (s *taskService) runTask(task model.TaskState) {
	ctx := context.Background()
	task.Status = "running"
	task.Progress = 30
	task.UpdatedAt = nowUTC()
	if err := s.repo.UpdateTask(ctx, &task); err != nil {
		return
	}

	searchQuery := task.Query
	if strings.TrimSpace(task.RewrittenQuery) != "" {
		searchQuery = task.RewrittenQuery
	}
	results, err := s.patentRepo.Search(ctx, searchQuery, s.topK)
	task.Progress = 100
	task.UpdatedAt = nowUTC()
	if err != nil {
		task.Status = "failed"
		task.Result = []model.TaskResultItem{}
	} else {
		task.Status = "succeeded"
		task.Result = results
	}
	_ = s.repo.UpdateTask(ctx, &task)
}
