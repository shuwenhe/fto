package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"fto-backend/internal/model"

	"github.com/redis/go-redis/v9"
)

var ErrTaskNotFound = errors.New("task not found")

type TaskRepository interface {
	CreateTask(ctx context.Context, task *model.TaskState) error
	UpdateTask(ctx context.Context, task *model.TaskState) error
	GetTask(ctx context.Context, taskID string) (*model.TaskState, error)
	Ping(ctx context.Context) error
}

type RedisTaskRepository struct {
	client *redis.Client
	ttl    time.Duration
}

func NewRedisTaskRepository(client *redis.Client, ttl time.Duration) *RedisTaskRepository {
	return &RedisTaskRepository{client: client, ttl: ttl}
}

func (r *RedisTaskRepository) key(taskID string) string {
	return fmt.Sprintf("fto:task:%s", taskID)
}

func (r *RedisTaskRepository) CreateTask(ctx context.Context, task *model.TaskState) error {
	b, err := json.Marshal(task)
	if err != nil {
		return err
	}
	return r.client.Set(ctx, r.key(task.TaskID), b, r.ttl).Err()
}

func (r *RedisTaskRepository) UpdateTask(ctx context.Context, task *model.TaskState) error {
	b, err := json.Marshal(task)
	if err != nil {
		return err
	}
	return r.client.Set(ctx, r.key(task.TaskID), b, r.ttl).Err()
}

func (r *RedisTaskRepository) GetTask(ctx context.Context, taskID string) (*model.TaskState, error) {
	val, err := r.client.Get(ctx, r.key(taskID)).Result()
	if err == redis.Nil {
		return nil, ErrTaskNotFound
	}
	if err != nil {
		return nil, err
	}
	var task model.TaskState
	if err := json.Unmarshal([]byte(val), &task); err != nil {
		return nil, err
	}
	return &task, nil
}

func (r *RedisTaskRepository) Ping(ctx context.Context) error {
	return r.client.Ping(ctx).Err()
}
