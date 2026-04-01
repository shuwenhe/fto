package main

import (
	"context"
	"log"
	"os"
	"strconv"
	"strings"
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

func getEnvBool(key string, fallback bool) bool {
	val := os.Getenv(key)
	if val == "" {
		return fallback
	}
	v := strings.ToLower(strings.TrimSpace(val))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}

func getEnvFloat(key string, fallback float64) float64 {
	val := os.Getenv(key)
	if val == "" {
		return fallback
	}
	n, err := strconv.ParseFloat(val, 64)
	if err != nil {
		return fallback
	}
	return n
}

func main() {
	redisAddr := getEnv("REDIS_ADDR", "127.0.0.1:6379")
	redisPassword := getEnv("REDIS_PASSWORD", "")
	patentDataPath := getEnv("PATENT_DATA_PATH", "/app/fto/data_sources/patents.jsonl")
	elasticsearchEnabled := getEnvBool("ELASTICSEARCH_ENABLED", false)
	elasticsearchURL := getEnv("ELASTICSEARCH_URL", "http://127.0.0.1:9200")
	elasticsearchIndex := getEnv("ELASTICSEARCH_INDEX", "fto_patents")
	elasticsearchCandidateMultiplier := getEnvInt("ELASTICSEARCH_CANDIDATE_MULTIPLIER", 6)
	rankingMode := getEnv("RANKING_MODE", "dual")
	dualRatio := getEnvInt("RANKING_DUAL_RATIO", 50)
	rankingModelPath := getEnv("RANKING_MODEL_PATH", "/app/fto/model_artifacts/fto_ranker_neurx_v1.json")
	encoderModelPath := getEnv("ENCODER_MODEL_PATH", "/app/fto/model_artifacts/fto_encoder_neurx_v1.json")
	deepRerankEnabled := getEnvBool("RANKING_DEEP_ENABLED", false)
	deepRerankTopN := getEnvInt("RANKING_DEEP_TOP_N", 8)
	deepRerankMixAlpha := getEnvFloat("RANKING_DEEP_MIX_ALPHA", 0.35)

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
	encoder, err := repository.LoadNeurxEncoder(encoderModelPath)
	if err != nil && !os.IsNotExist(err) {
		log.Fatalf("load encoder model failed: %v", err)
	}
	if err != nil && os.IsNotExist(err) {
		log.Printf("encoder model not found, encoder explain disabled: %s", encoderModelPath)
	}

	localPatentRepo, err := repository.NewLocalPatentRepositoryWithModel(patentDataPath, rankingMode, dualRatio, ranker, encoder)
	if err != nil {
		log.Fatalf("load patent data source failed: %v", err)
	}
	localPatentRepo.ConfigureDeepReranker(deepRerankEnabled, deepRerankTopN, deepRerankMixAlpha)

	var patentRepo repository.PatentDataRepository = localPatentRepo
	var rankingCtrl repository.RankingConfigController = localPatentRepo
	if elasticsearchEnabled {
		esRepo := repository.NewElasticsearchPatentRepository(
			localPatentRepo,
			elasticsearchURL,
			elasticsearchIndex,
			elasticsearchCandidateMultiplier,
		)
		patentRepo = esRepo
		rankingCtrl = esRepo
	}

	taskService := service.NewTaskService(repo, patentRepo, 5)

	metrics := observability.NewMetrics()

	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(observability.RequestIDMiddleware())
	r.Use(observability.AccessLogMiddleware(metrics))
	router.RegisterRoutes(r, taskService, metrics, rankingCtrl)

	log.Printf("backend config: redis_addr=%s patent_data_path=%s elasticsearch_enabled=%t elasticsearch_url=%s elasticsearch_index=%s elasticsearch_candidate_multiplier=%d ranking_mode=%s ranking_dual_ratio=%d ranking_model_path=%s ranking_model_loaded=%t encoder_model_path=%s encoder_model_loaded=%t ranking_deep_enabled=%t ranking_deep_top_n=%d ranking_deep_mix_alpha=%.3f", redisAddr, patentDataPath, elasticsearchEnabled, elasticsearchURL, elasticsearchIndex, elasticsearchCandidateMultiplier, rankingMode, dualRatio, rankingModelPath, ranker != nil, encoderModelPath, encoder != nil, deepRerankEnabled, deepRerankTopN, deepRerankMixAlpha)

	if err := r.Run(":8010"); err != nil {
		log.Fatalf("run server failed: %v", err)
	}
}
