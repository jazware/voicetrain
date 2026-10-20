package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/jazware/voicetrain/pkg/analysis"
	"github.com/jazware/voicetrain/pkg/backup"
	"github.com/jazware/voicetrain/pkg/metrics"
	"github.com/jazware/voicetrain/pkg/store"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// Options are the deployment-specific parts of the server.
type Options struct {
	// Auth guards every route but /healthz; zero means none (localhost).
	Auth Auth
	// Backup is the backup runner, for its status (nil: backups off).
	Backup *backup.Runner
}

type Server struct {
	logger   *slog.Logger
	store    *store.Store
	dataDir  string
	analyzer *analysis.Runner // nil when analysis is disabled
	backup   *backup.Runner   // nil when backups are off
}

func New(logger *slog.Logger, st *store.Store, dataDir string, analyzer *analysis.Runner, opts Options) *echo.Echo {
	s := &Server{logger: logger, store: st, dataDir: dataDir, analyzer: analyzer, backup: opts.Backup}

	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	e.Use(middleware.Recover())
	e.Use(slogRequestLogger(logger))
	// No page may frame voicetrain: a framed page under a decoy is how a
	// click on "Delete this take" gets tricked out of Jaz.
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			h := c.Response().Header()
			h.Set("Content-Security-Policy", "frame-ancestors 'none'")
			h.Set("X-Frame-Options", "DENY")
			return next(c)
		}
	})
	e.Use(opts.Auth.middleware(
		func(reason string) { metrics.Refused.WithLabelValues(reason).Inc() },
	))
	if !opts.Auth.Enabled() {
		e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
			// Vite dev server origin; the embedded UI is same-origin.
			AllowOrigins: []string{"http://localhost:3002"},
			AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete},
		}))
	}
	e.Use(middleware.BodyLimit("256M"))

	e.GET("/healthz", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
	})

	s.registerRoutes(e)

	return e
}

func (s *Server) registerRoutes(e *echo.Echo) {
	api := e.Group("/api")

	api.GET("/scripts", s.handleListScripts)
	api.POST("/scripts", s.handleCreateScript)
	api.GET("/scripts/:id", s.handleGetScript)
	api.PATCH("/scripts/:id", s.handleUpdateScript)
	api.DELETE("/scripts/:id", s.handleDeleteScript)

	api.POST("/recordings", s.handleUploadRecording)
	api.GET("/recordings", s.handleListRecordings)
	api.GET("/recordings/:id", s.handleGetRecording)
	api.GET("/recordings/:id/audio", s.handleStreamRecording)
	api.GET("/recordings/:id/annotations", s.handleListAnnotations)
	api.POST("/recordings/:id/analyze", s.handleAnalyzeRecording)
	api.PATCH("/recordings/:id", s.handleUpdateRecording)
	api.DELETE("/recordings/:id", s.handleDeleteRecording)

	api.GET("/history/heatmap", s.handleHeatmap)
	api.GET("/history/trends", s.handleTrends)

	api.GET("/analysis/status", s.handleAnalysisStatus)
	api.POST("/analysis/retry-failed", s.handleRetryFailedAnalyses)
	api.GET("/recordings/:id/analyses", s.handleListAnalysisHistory)

	api.GET("/backup/status", func(c echo.Context) error { return c.JSON(http.StatusOK, s.backup.Status()) })

	api.GET("/settings", s.handleGetSettings)
	api.PUT("/settings", s.handlePutSettings)

	// Everything else is the embedded frontend (registered last so
	// /api and /healthz win).
	spa := newSPAHandler()
	e.GET("/*", spa.handle)
}

func slogRequestLogger(logger *slog.Logger) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			start := time.Now()
			err := next(c)
			if err != nil {
				c.Error(err)
			}
			logger.Debug("request",
				"method", c.Request().Method,
				"path", c.Request().URL.Path,
				"status", c.Response().Status,
				"duration_ms", time.Since(start).Milliseconds())
			return err
		}
	}
}
