package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/jazware/voicetrain/version"
	"github.com/jazware/voicetrain/pkg/analysis"
	"github.com/jazware/voicetrain/pkg/backup"
	"github.com/jazware/voicetrain/pkg/server"
	"github.com/jazware/voicetrain/pkg/store"
	"github.com/urfave/cli/v2"
)

func main() {
	app := &cli.App{
		Name:    "voicetrain",
		Usage:   "Local webapp for practicing and tracking voice training",
		Version: version.String(),
		Flags: []cli.Flag{
			&cli.StringFlag{
				Name:    "listen-address",
				Usage:   "Address to listen on for HTTP requests",
				EnvVars: []string{"VOICETRAIN_LISTEN_ADDRESS"},
				Value:   ":8100",
			},
			&cli.StringFlag{
				Name:    "data-dir",
				Usage:   "Directory for the SQLite database and recordings",
				EnvVars: []string{"VOICETRAIN_DATA_DIR"},
				Value:   "",
			},
			&cli.StringFlag{
				Name:    "analysis-image",
				Usage:   "Docker image for the acoustic-analysis sidecar",
				EnvVars: []string{"VOICETRAIN_ANALYSIS_IMAGE"},
				Value:   "voicetrain-analysis",
			},
			&cli.StringFlag{
				Name:    "backup-dir",
				Usage:   "Directory to mirror recordings + DB snapshots into (empty = backups disabled)",
				EnvVars: []string{"VOICETRAIN_BACKUP_DIR"},
				Value:   "",
			},
			&cli.StringFlag{
				Name:    "backup-share",
				Usage:   "SMB share to mount (via Finder/keychain) when the backup dir is missing",
				EnvVars: []string{"VOICETRAIN_BACKUP_SHARE"},
				Value:   "",
			},
			&cli.BoolFlag{
				Name:    "debug",
				Usage:   "Enable debug logging",
				EnvVars: []string{"VOICETRAIN_DEBUG"},
			},
		},
		Action: run,
	}

	if err := app.Run(os.Args); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func run(cctx *cli.Context) error {
	level := slog.LevelInfo
	if cctx.Bool("debug") {
		level = slog.LevelDebug
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)

	dataDir := cctx.String("data-dir")
	if dataDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("resolving home directory: %w", err)
		}
		dataDir = filepath.Join(home, "voice-training")
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return fmt.Errorf("creating data dir: %w", err)
	}

	logger.Info("starting voicetrain",
		"version", version.Version,
		"commit", version.GitCommit,
		"listen_address", cctx.String("listen-address"),
		"data_dir", dataDir)

	db, err := store.Open(filepath.Join(dataDir, "app.db"))
	if err != nil {
		return err
	}
	defer db.Close()

	// Background workers run for the life of the process.
	bgCtx, cancelBg := context.WithCancel(context.Background())
	defer cancelBg()
	analyzer := analysis.NewRunner(bgCtx, logger, db, dataDir, cctx.String("analysis-image"))
	go analyzer.Backfill()

	backupRunner := backup.NewRunner(logger, db, dataDir,
		cctx.String("backup-dir"), cctx.String("backup-share"))
	go backupRunner.Start(bgCtx)

	e := server.New(logger, db, dataDir, analyzer)

	go func() {
		if err := e.Start(cctx.String("listen-address")); err != nil && err != http.ErrServerClosed {
			logger.Error("server error", "error", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	logger.Info("shutting down")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := e.Shutdown(ctx); err != nil {
		return fmt.Errorf("shutting down server: %w", err)
	}
	return nil
}
