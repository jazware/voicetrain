// Package analysis runs the dockerized acoustic-analysis sidecar
// (analysis/ at the package root) against recordings and stores the
// results: the full JSON document on the recording row, its
// time-anchored events as source='auto' annotations.
package analysis

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"github.com/jazware/voicetrain/pkg/store"
)

// Version must match ANALYSIS_VERSION in analysis/analyze.py; bumping
// it there and here makes the startup backfill re-analyze every take.
const Version = 1

const runTimeout = 10 * time.Minute

// result is the slice of the sidecar's output the server acts on; the
// rest of the document is stored verbatim for the UI.
type result struct {
	Version int `json:"version"`
	Events  []struct {
		StartMs int64           `json:"start_ms"`
		EndMs   *int64          `json:"end_ms"`
		Kind    string          `json:"kind"`
		Payload json.RawMessage `json:"payload"`
	} `json:"events"`
}

// Runner feeds recordings through the sidecar one at a time. A nil
// *Runner is valid and does nothing, so callers never need to guard.
type Runner struct {
	logger  *slog.Logger
	store   *store.Store
	dataDir string
	image   string
	queue   chan int64
}

// NewRunner returns a started runner, or nil (analysis disabled, with
// a logged reason) when docker or the sidecar image is unavailable.
func NewRunner(ctx context.Context, logger *slog.Logger, st *store.Store, dataDir, image string) *Runner {
	if _, err := exec.LookPath("docker"); err != nil {
		logger.Warn("analysis disabled: docker not found in PATH")
		return nil
	}
	if err := exec.CommandContext(ctx, "docker", "image", "inspect", image).Run(); err != nil {
		logger.Warn("analysis disabled: sidecar image missing — build it with `just analysis-build`",
			"image", image)
		return nil
	}

	r := &Runner{
		logger:  logger,
		store:   st,
		dataDir: dataDir,
		image:   image,
		queue:   make(chan int64, 512),
	}
	go r.work(ctx)
	return r
}

// Enqueue schedules a recording for analysis. Non-blocking; if the
// queue is full the take is skipped and caught by the next backfill.
func (r *Runner) Enqueue(id int64) {
	if r == nil {
		return
	}
	select {
	case r.queue <- id:
	default:
		r.logger.Warn("analysis queue full, skipping", "recording_id", id)
	}
}

// Backfill enqueues every take whose analysis is missing or from an
// older analyzer version.
func (r *Runner) Backfill() {
	if r == nil {
		return
	}
	ids, err := r.store.ListRecordingIDsNeedingAnalysis(Version)
	if err != nil {
		r.logger.Error("listing recordings needing analysis", "error", err)
		return
	}
	if len(ids) == 0 {
		return
	}
	r.logger.Info("backfilling analysis", "count", len(ids))
	for _, id := range ids {
		r.Enqueue(id)
	}
}

func (r *Runner) work(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case id := <-r.queue:
			start := time.Now()
			if err := r.analyze(ctx, id); err != nil {
				r.logger.Error("analyzing recording", "recording_id", id, "error", err)
				continue
			}
			r.logger.Info("analyzed recording", "recording_id", id,
				"duration_ms", time.Since(start).Milliseconds())
		}
	}
}

func (r *Runner) analyze(ctx context.Context, id int64) error {
	rec, err := r.store.GetRecording(id)
	if err != nil {
		return fmt.Errorf("loading recording: %w", err)
	}
	if rec.FilePath == "" {
		return fmt.Errorf("recording has no file")
	}
	settings, err := r.store.GetSettings()
	if err != nil {
		return fmt.Errorf("loading settings: %w", err)
	}

	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()

	absDataDir, err := filepath.Abs(r.dataDir)
	if err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "docker", "run", "--rm",
		"-v", absDataDir+":/data:ro",
		r.image,
		"/data/"+filepath.ToSlash(rec.FilePath),
		"--target-min-hz", strconv.FormatFloat(settings.TargetMinHz, 'f', -1, 64),
		"--target-max-hz", strconv.FormatFloat(settings.TargetMaxHz, 'f', -1, 64),
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("sidecar failed: %w: %s", err, truncate(stderr.String(), 2000))
	}

	raw := bytes.TrimSpace(stdout.Bytes())
	var res result
	if err := json.Unmarshal(raw, &res); err != nil {
		return fmt.Errorf("parsing sidecar output: %w: %s", err, truncate(string(raw), 500))
	}

	events := make([]store.NewAnnotation, 0, len(res.Events))
	for _, e := range res.Events {
		events = append(events, store.NewAnnotation{
			StartMs: e.StartMs,
			EndMs:   e.EndMs,
			Kind:    e.Kind,
			Payload: e.Payload,
		})
	}
	return r.store.SetRecordingAnalysis(id, raw, events)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
