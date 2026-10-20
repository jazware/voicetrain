package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/jazware/voicetrain/telemetry/ops"
	"github.com/jazware/voicetrain/version"
	"github.com/jazware/voicetrain/pkg/analysis"
	"github.com/jazware/voicetrain/pkg/backup"
	"github.com/jazware/voicetrain/pkg/metrics"
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
				Usage:   "Address to listen on for HTTP requests (loopback by default: without --trusted-proxies nothing is checked)",
				EnvVars: []string{"VOICETRAIN_LISTEN_ADDRESS"},
				Value:   "127.0.0.1:8100",
			},
			&cli.StringFlag{
				Name:    "data-dir",
				Usage:   "Directory for the SQLite database and recordings",
				EnvVars: []string{"VOICETRAIN_DATA_DIR"},
				Value:   "",
			},
			&cli.StringFlag{
				Name:    "analysis-image",
				Usage:   "Docker image for the acoustic analyzer (used when --analysis-command is empty)",
				EnvVars: []string{"VOICETRAIN_ANALYSIS_IMAGE"},
				Value:   "voicetrain-analysis",
			},
			&cli.StringFlag{
				Name:    "analysis-command",
				Usage:   "Run the analyzer directly instead of in docker, e.g. \"python3 /app/analysis/analyze.py\"",
				EnvVars: []string{"VOICETRAIN_ANALYSIS_COMMAND"},
			},
			&cli.IntFlag{
				Name:    "analysis-workers",
				Usage:   "Analyzer processes to run at once (0 = half the CPUs, at most 4)",
				EnvVars: []string{"VOICETRAIN_ANALYSIS_WORKERS"},
			},
			&cli.IntFlag{
				Name:    "analysis-batch",
				Usage:   "Most takes one analyzer process handles",
				EnvVars: []string{"VOICETRAIN_ANALYSIS_BATCH"},
				Value:   8,
			},
			&cli.StringFlag{
				Name:    "backup-dir",
				Usage:   "Directory to mirror recordings + DB snapshots into (empty = backups disabled)",
				EnvVars: []string{"VOICETRAIN_BACKUP_DIR"},
				Value:   "",
			},
			&cli.StringFlag{
				Name:    "backup-label",
				Usage:   "How Settings names the backup folder (default: --backup-dir)",
				EnvVars: []string{"VOICETRAIN_BACKUP_LABEL"},
			},
			&cli.BoolFlag{
				Name:    "backup-require-marker",
				Usage:   "Refuse a backup dir without a " + backup.Marker + " file in it (a NAS mounted with nofail)",
				EnvVars: []string{"VOICETRAIN_BACKUP_REQUIRE_MARKER"},
			},
			&cli.DurationFlag{
				Name:    "backup-interval",
				Usage:   "How often to back up",
				EnvVars: []string{"VOICETRAIN_BACKUP_INTERVAL"},
				Value:   time.Hour,
			},
			&cli.StringFlag{
				Name:    "backup-share",
				Usage:   "SMB share to mount (via Finder/keychain) when the backup dir is missing",
				EnvVars: []string{"VOICETRAIN_BACKUP_SHARE"},
				Value:   "",
			},
			&cli.StringFlag{
				Name:    "ops-listen",
				Usage:   "Address for /metrics and pprof (empty = off); keep it on loopback",
				EnvVars: []string{"VOICETRAIN_OPS_LISTEN"},
			},
			&cli.StringSliceFlag{
				Name: "trusted-proxies",
				Usage: "Addresses or CIDRs of the reverse proxy whose " + server.LoginHeader +
					" header is believed; set, every request but /healthz must come through it from an operator",
				EnvVars: []string{"VOICETRAIN_TRUSTED_PROXIES"},
			},
			&cli.StringSliceFlag{
				Name:    "operators",
				Usage:   "Tailscale logins allowed in (with --trusted-proxies)",
				EnvVars: []string{"VOICETRAIN_OPERATORS"},
			},
			&cli.StringFlag{
				Name:    "site-origin",
				Usage:   "voicetrain's own origin, the one web Origin accepted (with --trusted-proxies)",
				EnvVars: []string{"VOICETRAIN_SITE_ORIGIN"},
			},
			&cli.BoolFlag{
				Name:    "debug",
				Usage:   "Enable debug logging",
				EnvVars: []string{"VOICETRAIN_DEBUG"},
			},
		},
		Action: run,
		Commands: []*cli.Command{
			{
				Name:  "verify",
				Usage: "Check every take's audio file against its row (after a restore); exits 1 on problems",
				Flags: []cli.Flag{
					&cli.StringFlag{Name: "data-dir", Usage: "The data dir to check (app.db and recordings/)", Required: true},
					&cli.StringFlag{Name: "db", Usage: "The database to read rows from (default: <data-dir>/app.db)"},
					&cli.StringFlag{Name: "backup", Usage: "A backup dir to look for missing or wrong-sized takes in"},
					&cli.BoolFlag{Name: "fix", Usage: "Copy each broken take's file in from --backup"},
				},
				Action: func(cctx *cli.Context) error {
					dbPath := cctx.String("db")
					if dbPath == "" {
						dbPath = filepath.Join(cctx.String("data-dir"), "app.db")
					}
					rep, err := backup.Verify(dbPath, cctx.String("data-dir"), cctx.String("backup"), cctx.Bool("fix"))
					if err != nil {
						return err
					}
					rep.Print(os.Stdout)
					if len(rep.Problems) > 0 {
						return cli.Exit("", 1)
					}
					return nil
				},
			},
		},
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
	// Upload spill files go to TMPDIR; a deployment can point it at a dir on the data
	// volume, which a fresh volume doesn't have yet.
	if err := os.MkdirAll(os.TempDir(), 0o700); err != nil {
		return fmt.Errorf("creating temp dir: %w", err)
	}
	for _, f := range server.SweepStale(dataDir, os.TempDir(), time.Hour, time.Now()) {
		logger.Info("removed a stale leftover", "path", f)
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

	bgCtx, cancelBg := context.WithCancel(context.Background())
	defer cancelBg()
	workers := cctx.Int("analysis-workers")
	if workers <= 0 {
		workers = min(4, max(1, runtime.NumCPU()/2))
	}
	analyzer := analysis.NewRunner(bgCtx, logger, db, dataDir, analysis.Config{
		Command:   cctx.String("analysis-command"),
		Image:     cctx.String("analysis-image"),
		Workers:   workers,
		BatchSize: cctx.Int("analysis-batch"),
	})
	go analyzer.Backfill()

	backupRunner := backup.NewRunner(logger, db, dataDir, backup.Config{
		Dir:           cctx.String("backup-dir"),
		ShareURL:      cctx.String("backup-share"),
		Label:         cctx.String("backup-label"),
		RequireMarker: cctx.Bool("backup-require-marker"),
		Interval:      cctx.Duration("backup-interval"),
	})
	go backupRunner.Start(bgCtx)

	auth, err := server.NewAuth(cctx.StringSlice("trusted-proxies"), cctx.StringSlice("operators"), cctx.String("site-origin"))
	if err != nil {
		return err
	}

	reg := ops.NewRegistry()
	metrics.Register(reg,
		func() float64 { return float64(analyzer.Status().Queued) },
		func() float64 { return float64(analyzer.Status().Running) })
	if addr := cctx.String("ops-listen"); addr != "" {
		opsAddr, err := ops.Serve(bgCtx, addr, reg, func(err error) { logger.Error("ops server", "error", err) })
		if err != nil {
			return fmt.Errorf("starting ops listener: %w", err)
		}
		logger.Info("ops listening", "addr", opsAddr.String())
	}

	if auth.Enabled() {
		logger.Info("requests checked", "trusted_proxies", cctx.StringSlice("trusted-proxies"), "site_origin", auth.Origin)
	} else {
		logger.Info("no request checks (laptop mode); keep the listen address on loopback")
	}
	e := server.New(logger, db, dataDir, analyzer, server.Options{Auth: auth, Backup: backupRunner})

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
	// Stop the analyzer before the deferred db.Close: a batch cut off
	// here is analyzed again at the next start, not marked failed.
	cancelBg()
	analyzer.Wait()
	return nil
}
