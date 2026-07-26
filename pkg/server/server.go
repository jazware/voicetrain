package server

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/jazware/voicetrain/pkg/analysis"
	"github.com/jazware/voicetrain/pkg/store"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// Server holds handler dependencies.
type Server struct {
	logger   *slog.Logger
	store    *store.Store
	dataDir  string
	analyzer *analysis.Runner // nil when analysis is disabled
}

// New builds the Echo app with all routes registered.
func New(logger *slog.Logger, st *store.Store, dataDir string, analyzer *analysis.Runner) *echo.Echo {
	s := &Server{logger: logger, store: st, dataDir: dataDir, analyzer: analyzer}

	e := echo.New()
	e.HideBanner = true
	e.HidePort = true

	e.Use(middleware.Recover())
	e.Use(slogRequestLogger(logger))
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		// Vite dev server origin; the embedded UI is same-origin.
		AllowOrigins: []string{"http://localhost:3002"},
		AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete},
	}))
	e.Use(middleware.BodyLimit("256M"))

	e.GET("/healthz", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
	})

	s.registerRoutes(e)

	return e
}

// registerRoutes wires the /api endpoints. Handlers live in their
// resource-specific files (scripts.go, recordings.go, ...).
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
