package main

import (
	"context"
	"log"
	"os"
	"time"

	"fto-backend/internal/repository"
	"fto-backend/internal/router"
	"fto-backend/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/go-redis/redis/v8"
)

func getEnv(key string, fallback string) string {
	val := os.Getenv(key)
	if val == "" {
		return fallback
	}
	return val
}

func main() {
	redisAddr := getEnv("REDIS_ADDR", "127.0.0.1:6379")
	redisPassword := getEnv("REDIS_PASSWORD", "")
	patentDataPath := getEnv("PATENT_DATA_PATH", "/app/fto/data_sources/patents.jsonl")

	rdb := redis.NewClient(&redis.Options{
		Addr:     redisAddr,
		Password: redisPassword,
		DB:       0,
	})
	repo := repository.NewRedisTaskRepository(rdb, 24*time.Hour)
	if err := repo.Ping(context.Background()); err != nil {
		log.Fatalf("redis not available: %v", err)
	}

	patentRepo, err := repository.NewLocalPatentRepository(patentDataPath)
	if err != nil {
		log.Fatalf("load patent data source failed: %v", err)
	}

	taskService := service.NewTaskService(repo, patentRepo, 5)

	r := gin.Default()
	router.RegisterRoutes(r, taskService)

	_ = r.Run(":8010")
}
