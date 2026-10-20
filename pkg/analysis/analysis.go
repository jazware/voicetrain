// Package analysis runs the acoustic analyzer (analysis/ at the package
// root) against recordings and stores the results: the full JSON
// document on the recording row, its time-anchored events as
// source='auto' annotations.
//
// The analyzer runs either in its docker image (a laptop) or as a
// local command (inside voicetrain's own image, where the analyzer is
// installed next to the server). Takes go through in batches, one
// process per batch, so interpreter, Praat and container start-up are
// paid once per batch rather than once per take.
package analysis

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jazware/voicetrain/pkg/metrics"
	"github.com/jazware/voicetrain/pkg/store"
)

// Version must match ANALYSIS_VERSION in analysis/analyze.py; bumping
// it there and here makes the startup backfill re-analyze every take.
const Version = 2

// perTakeTimeout bounds one take's share of a batch's run time.
const perTakeTimeout = 3 * time.Minute

type Config struct {
	// Command runs the analyzer directly (e.g. "python3 /app/analyze.py").
	// Takes precedence over Image.
	Command string
	// Image is the docker image to run when Command is empty.
	Image string
	// Workers is how many analyzer processes may run at once.
	Workers int
	// BatchSize is the most takes one process analyzes.
	BatchSize int
}

// backend runs the analyzer on WAVs given relative to the data dir and
// returns its JSONL output.
type backend interface {
	run(ctx context.Context, relPaths []string, minHz, maxHz float64) ([]byte, error)
	version(ctx context.Context) int
	String() string
}

type dockerBackend struct {
	image   string
	dataDir string
}

func (d dockerBackend) run(ctx context.Context, relPaths []string, minHz, maxHz float64) ([]byte, error) {
	args := []string{"run", "--rm", "--network", "none", "-v", d.dataDir + ":/data:ro", d.image}
	args = append(args, analyzerArgs(minHz, maxHz)...)
	for _, p := range relPaths {
		args = append(args, "/data/"+filepath.ToSlash(p))
	}
	return output(exec.CommandContext(ctx, "docker", args...))
}

func (d dockerBackend) version(ctx context.Context) int {
	return parseVersion(exec.CommandContext(ctx, "docker", "run", "--rm", "--network", "none", d.image, "--version").Output())
}

func (d dockerBackend) String() string { return "docker image " + d.image }

type commandBackend struct {
	argv    []string
	dataDir string
}

func (c commandBackend) run(ctx context.Context, relPaths []string, minHz, maxHz float64) ([]byte, error) {
	args := append(append([]string{}, c.argv[1:]...), analyzerArgs(minHz, maxHz)...)
	for _, p := range relPaths {
		args = append(args, filepath.Join(c.dataDir, p))
	}
	return output(exec.CommandContext(ctx, c.argv[0], args...))
}

func (c commandBackend) version(ctx context.Context) int {
	args := append(append([]string{}, c.argv[1:]...), "--version")
	return parseVersion(exec.CommandContext(ctx, c.argv[0], args...).Output())
}

func (c commandBackend) String() string { return "command " + strings.Join(c.argv, " ") }

func analyzerArgs(minHz, maxHz float64) []string {
	return []string{
		"--jsonl",
		"--target-min-hz", strconv.FormatFloat(minHz, 'f', -1, 64),
		"--target-max-hz", strconv.FormatFloat(maxHz, 'f', -1, 64),
	}
}

func output(cmd *exec.Cmd) ([]byte, error) {
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		// Lines already printed are still good results.
		return stdout.Bytes(), fmt.Errorf("analyzer failed: %w: %s", err, truncate(stderr.String(), 2000))
	}
	return stdout.Bytes(), nil
}

func parseVersion(out []byte, err error) int {
	if err != nil {
		return 0
	}
	v, err := strconv.Atoi(string(bytes.TrimSpace(out)))
	if err != nil {
		return 0
	}
	return v
}

// line is one JSONL result: a document tagged with its file, or an error.
type line struct {
	File    string `json:"file"`
	Error   string `json:"error"`
	Version int    `json:"version"`
	Events  []struct {
		StartMs int64           `json:"start_ms"`
		EndMs   *int64          `json:"end_ms"`
		Kind    string          `json:"kind"`
		Payload json.RawMessage `json:"payload"`
	} `json:"events"`
}

// Status is what the UI shows about analysis.
type Status struct {
	Enabled      bool   `json:"enabled"`
	Backend      string `json:"backend,omitempty"`
	Version      int    `json:"version"`
	ImageVersion int    `json:"image_version"`
	Workers      int    `json:"workers"`
	Queued       int    `json:"queued"`
	Running      int    `json:"running"`
	Analyzed     int64  `json:"analyzed"`
	// FailedTakes is how many takes' last analysis failed (from the
	// database, so it drops when a retry succeeds).
	FailedTakes   int    `json:"failed_takes"`
	LastError     string `json:"last_error,omitempty"`
	BackfillTotal int    `json:"backfill_total"`
}

// Runner feeds recordings through the analyzer. A nil *Runner is valid
// and does nothing, so callers never need to guard.
type Runner struct {
	logger       *slog.Logger
	store        *store.Store
	backend      backend
	workers      int
	batchSize    int
	imageVersion int

	mu       sync.Mutex
	wake     chan struct{}
	urgent   []int64 // new takes and re-listens: next
	backfill []int64 // version upgrades: newest first, after urgent
	queued   map[int64]bool
	running  map[int64]bool // in an analyzer process now
	analyzed int64
	lastErr  string
	total    int
	wg       sync.WaitGroup
}

// NewRunner returns a started runner, or nil (analysis disabled, with a
// logged reason) when no analyzer is available.
func NewRunner(ctx context.Context, logger *slog.Logger, st *store.Store, dataDir string, cfg Config) *Runner {
	absDataDir, err := filepath.Abs(dataDir)
	if err != nil {
		logger.Warn("analysis disabled: resolving data dir", "error", err)
		return nil
	}
	var b backend
	switch {
	case cfg.Command != "":
		argv := strings.Fields(cfg.Command)
		if _, err := exec.LookPath(argv[0]); err != nil {
			logger.Warn("analysis disabled: analyzer command not found", "command", cfg.Command)
			return nil
		}
		b = commandBackend{argv: argv, dataDir: absDataDir}
	case cfg.Image != "":
		if _, err := exec.LookPath("docker"); err != nil {
			logger.Warn("analysis disabled: docker not found in PATH")
			return nil
		}
		if err := exec.CommandContext(ctx, "docker", "image", "inspect", cfg.Image).Run(); err != nil {
			logger.Warn("analysis disabled: analyzer image missing; build it with `just analysis-build`",
				"image", cfg.Image)
			return nil
		}
		b = dockerBackend{image: cfg.Image, dataDir: absDataDir}
	default:
		logger.Warn("analysis disabled: no analyzer configured")
		return nil
	}

	r := &Runner{
		logger:    logger,
		store:     st,
		backend:   b,
		workers:   max(1, cfg.Workers),
		batchSize: max(1, cfg.BatchSize),
		wake:      make(chan struct{}, 1),
		queued:    map[int64]bool{},
		running:   map[int64]bool{},
	}
	r.imageVersion = b.version(ctx)
	if r.imageVersion < Version {
		logger.Warn("analyzer is older than this server; new takes still get analyzed, "+
			"but old takes won't be re-analyzed until it's rebuilt (`just analysis-build`)",
			"analyzer_version", r.imageVersion, "want", Version)
	}
	logger.Info("analysis enabled", "backend", b.String(), "workers", r.workers, "batch", r.batchSize)
	for i := 0; i < r.workers; i++ {
		r.wg.Add(1)
		go func() {
			defer r.wg.Done()
			r.work(ctx)
		}()
	}
	return r
}

// Wait returns once every worker has stopped (after the runner's context
// ends), so the store can close without an analysis in flight. Safe on a
// nil runner.
func (r *Runner) Wait() {
	if r != nil {
		r.wg.Wait()
	}
}

// Enqueue schedules a take after the other new takes and re-listens and
// ahead of any backfill; a take already waiting moves there. A take
// that's being analyzed right now runs again once that run ends, never
// in two processes at once. Never blocks.
func (r *Runner) Enqueue(id int64) {
	if r == nil {
		return
	}
	r.mu.Lock()
	if r.queued[id] {
		r.backfill = remove(r.backfill, id)
		r.urgent = remove(r.urgent, id)
	} else {
		r.total++
	}
	r.urgent = append(r.urgent, id)
	r.queued[id] = true
	r.mu.Unlock()
	r.signal()
}

// Backfill queues every take whose analysis is missing or from an older
// analyzer version, newest first, so the takes you look at update first.
func (r *Runner) Backfill() {
	if r == nil {
		return
	}
	// Re-running old takes through an analyzer older than Version
	// would redo the same stale analysis on every start.
	ids, err := r.store.ListRecordingIDsNeedingAnalysis(min(Version, r.imageVersion))
	if err != nil {
		r.logger.Error("listing recordings needing analysis", "error", err)
		return
	}
	if len(ids) == 0 {
		return
	}
	r.mu.Lock()
	added := 0
	for i := len(ids) - 1; i >= 0; i-- {
		if !r.queued[ids[i]] {
			r.backfill = append(r.backfill, ids[i])
			r.queued[ids[i]] = true
			added++
		}
	}
	r.total += added
	r.mu.Unlock()
	r.logger.Info("backfilling analysis", "count", added)
	r.signal()
}

func (r *Runner) Status() Status {
	if r == nil {
		return Status{Version: Version}
	}
	failed, err := r.store.CountAnalysisErrors()
	if err != nil {
		r.logger.Error("counting analysis errors", "error", err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	st := Status{
		Enabled:       true,
		Backend:       r.backend.String(),
		Version:       Version,
		ImageVersion:  r.imageVersion,
		Workers:       r.workers,
		Queued:        len(r.urgent) + len(r.backfill),
		Running:       len(r.running),
		Analyzed:      r.analyzed,
		FailedTakes:   failed,
		BackfillTotal: r.total,
	}
	if failed > 0 {
		st.LastError = r.lastErr
	}
	return st
}

func (r *Runner) signal() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// next takes up to batchSize ids, urgent ones first, skipping any take
// another worker is analyzing (it stays queued for after).
func (r *Runner) next() []int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	var batch []int64
	take := func(queue []int64) []int64 {
		rest := queue[:0]
		for _, id := range queue {
			if len(batch) < r.batchSize && !r.running[id] {
				batch = append(batch, id)
			} else {
				rest = append(rest, id)
			}
		}
		return rest
	}
	r.urgent = take(r.urgent)
	r.backfill = take(r.backfill)
	for _, id := range batch {
		delete(r.queued, id)
		r.running[id] = true
	}
	if len(batch) > 0 && len(r.urgent)+len(r.backfill) > 0 {
		// More waiting: let another idle worker pick it up.
		select {
		case r.wake <- struct{}{}:
		default:
		}
	}
	return batch
}

func (r *Runner) work(ctx context.Context) {
	for {
		batch := r.next()
		if len(batch) == 0 {
			select {
			case <-ctx.Done():
				return
			case <-r.wake:
				continue
			}
		}
		start := time.Now()
		done, failed := r.analyzeBatch(ctx, batch)
		r.mu.Lock()
		for _, id := range batch {
			delete(r.running, id)
		}
		r.analyzed += int64(done)
		waiting := len(r.urgent) + len(r.backfill)
		if len(r.running) == 0 && waiting == 0 {
			r.total = 0
		}
		r.mu.Unlock()
		elapsed := time.Since(start)
		metrics.AnalysisTakes.WithLabelValues("ok").Add(float64(done))
		metrics.AnalysisTakes.WithLabelValues("failed").Add(float64(failed))
		metrics.AnalysisBatchSeconds.Observe(elapsed.Seconds())
		metrics.AnalysisSecondsPerTake.Observe(elapsed.Seconds() / float64(len(batch)))
		r.logger.Info("analyzed batch", "takes", len(batch), "ok", done, "failed", failed,
			"duration_ms", elapsed.Milliseconds())
		if waiting > 0 {
			// A take held back while this batch ran may be free now.
			r.signal()
		}
		if ctx.Err() != nil {
			return
		}
	}
}

// analyzeBatch runs one analyzer process over the batch and stores each
// result. Takes are grouped by nothing but the current settings: every
// take is measured against today's band.
func (r *Runner) analyzeBatch(ctx context.Context, ids []int64) (done, failed int) {
	settings, err := r.store.GetSettings()
	if err != nil {
		r.fail(ids, fmt.Errorf("loading settings: %w", err))
		return 0, len(ids)
	}
	byPath := map[string]int64{}
	var paths []string
	for _, id := range ids {
		rec, err := r.store.GetRecording(id)
		if err != nil {
			r.logger.Error("loading recording for analysis", "recording_id", id, "error", err)
			failed++
			continue
		}
		if rec.FilePath == "" {
			r.fail([]int64{id}, fmt.Errorf("recording has no audio file"))
			failed++
			continue
		}
		paths = append(paths, rec.FilePath)
		byPath[rec.FilePath] = id
	}
	if len(paths) == 0 {
		return 0, failed
	}

	runCtx, cancel := context.WithTimeout(ctx, perTakeTimeout*time.Duration(len(paths)))
	defer cancel()
	out, runErr := r.backend.run(runCtx, paths, settings.TargetMinHz, settings.TargetMaxHz)

	seen := map[int64]bool{}
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 1<<20), 64<<20)
	for sc.Scan() {
		raw := bytes.TrimSpace(sc.Bytes())
		if len(raw) == 0 {
			continue
		}
		var l line
		if err := json.Unmarshal(raw, &l); err != nil {
			r.logger.Error("parsing analyzer output", "error", err, "line", truncate(string(raw), 300))
			continue
		}
		id, ok := r.idFor(byPath, l.File)
		if !ok {
			r.logger.Error("analyzer returned an unknown file", "file", l.File)
			continue
		}
		seen[id] = true
		if l.Error != "" {
			r.fail([]int64{id}, fmt.Errorf("%s", l.Error))
			failed++
			continue
		}
		if err := r.store.SetRecordingAnalysis(id, documentOf(raw), eventsOf(l)); err != nil {
			r.fail([]int64{id}, fmt.Errorf("storing analysis: %w", err))
			failed++
			continue
		}
		done++
	}

	if ctx.Err() != nil {
		// Shutting down: the analyzer was killed, not the takes' fault.
		// Results it printed before are stored; the rest are analyzed
		// again at the next start.
		return done, failed
	}

	var missing []int64
	for _, id := range byPath {
		if !seen[id] {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		if runErr == nil {
			runErr = fmt.Errorf("analyzer returned no result")
		}
		r.fail(missing, runErr)
		failed += len(missing)
	}
	return done, failed
}

// idFor maps the analyzer's file path back to a recording, whichever
// way the backend spelled it (/data/rel under docker, absolute locally).
func (r *Runner) idFor(byPath map[string]int64, file string) (int64, bool) {
	for rel, id := range byPath {
		if file == rel || strings.HasSuffix(filepath.ToSlash(file), "/"+filepath.ToSlash(rel)) {
			return id, true
		}
	}
	return 0, false
}

func (r *Runner) fail(ids []int64, err error) {
	msg := truncate(err.Error(), 500)
	r.mu.Lock()
	r.lastErr = msg
	r.mu.Unlock()
	for _, id := range ids {
		r.logger.Error("analyzing recording", "recording_id", id, "error", msg)
		if serr := r.store.SetRecordingAnalysisError(id, msg); serr != nil {
			r.logger.Error("recording analysis error", "recording_id", id, "error", serr)
		}
	}
}

// documentOf drops the batch-only "file" key so stored documents look
// the same whichever way they were produced.
func documentOf(raw []byte) json.RawMessage {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		return raw
	}
	delete(doc, "file")
	out, err := json.Marshal(doc)
	if err != nil {
		return raw
	}
	return out
}

func eventsOf(l line) []store.NewAnnotation {
	events := make([]store.NewAnnotation, 0, len(l.Events))
	for _, e := range l.Events {
		events = append(events, store.NewAnnotation{
			StartMs: e.StartMs,
			EndMs:   e.EndMs,
			Kind:    e.Kind,
			Payload: e.Payload,
		})
	}
	return events
}

func remove(ids []int64, id int64) []int64 {
	out := ids[:0]
	for _, v := range ids {
		if v != id {
			out = append(out, v)
		}
	}
	return out
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
