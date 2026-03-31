package main

import (
	"context"
	"log"
	"os"
	"strconv"
	"time"

	"fto-backend/internal/observability"
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

func getEnvInt(key string, fallback int) int {
	val := os.Getenv(key)
	if val == "" {
		return fallback
	}
	n, err := strconv.Atoi(val)
	if err != nil {
		return fallback
	}
	return n
}

func main() {
	redisAddr := getEnv("REDIS_ADDR", "127.0.0.1:6379")
	redisPassword := getEnv("REDIS_PASSWORD", "")
	patentDataPath := getEnv("PATENT_DATA_PATH", "/app/fto/data_sources/patents.jsonl")
	rankingMode := getEnv("RANKING_MODE", "dual")
	dualRatio := getEnvInt("RANKING_DUAL_RATIO", 50)
	rankingModelPath := getEnv("RANKING_MODEL_PATH", "/app/fto/model_artifacts/fto_ranker_neurx_v1.json")

	rdb := redis.NewClient(&redis.Options{
		Addr:     redisAddr,
		Password: redisPassword,
		DB:       0,
	})
	repo := repository.NewRedisTaskRepository(rdb, 24*time.Hour)
	if err := repo.Ping(context.Background()); err != nil {
		log.Fatalf("redis not available: %v", err)
	}

	ranker, err := repository.LoadNeurxRanker(rankingModelPath)
	if err != nil && !os.IsNotExist(err) {
		log.Fatalf("load ranking model failed: %v", err)
	}
	if err != nil && os.IsNotExist(err) {
		log.Printf("ranking model not found, fallback to heuristic dual ranking: %s", rankingModelPath)
	}

	patentRepo, err := repository.NewLocalPatentRepositoryWithModel(patentDataPath, rankingMode, dualRatio, ranker)
	if err != nil {
		log.Fatalf("load patent data source failed: %v", err)
	}

	taskService := service.NewTaskService(repo, patentRepo, 5)

	metrics := observability.NewMetrics()

	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(observability.RequestIDMiddleware())
	r.Use(observability.AccessLogMiddleware(metrics))
	router.RegisterRoutes(r, taskService, metrics, patentRepo)

	log.Printf("backend config: redis_addr=%s patent_data_path=%s ranking_mode=%s ranking_dual_ratio=%d ranking_model_path=%s ranking_model_loaded=%t", redisAddr, patentDataPath, rankingMode, dualRatio, rankingModelPath, ranker != nil)

	if err := r.Run(":8010"); err != nil {
		log.Fatalf("run server failed: %v", err)
	}
}
