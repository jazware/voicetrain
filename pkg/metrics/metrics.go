// Package metrics holds voicetrain's Prometheus metrics, served by the
// ops listener (packages/telemetry/ops) when --ops-listen is set.
package metrics

import "github.com/prometheus/client_golang/prometheus"

var (
	TakesSaved = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "voicetrain_takes_saved_total",
		Help: "Takes uploaded and stored.",
	})
	TakeSeconds = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "voicetrain_take_seconds",
		Help:    "Length of stored takes.",
		Buckets: []float64{5, 15, 30, 60, 90, 120, 180, 300, 600},
	})
	AnalysisTakes = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "voicetrain_analysis_takes_total",
		Help: "Takes the analyzer finished, by result (ok, failed).",
	}, []string{"result"})
	AnalysisBatchSeconds = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "voicetrain_analysis_batch_seconds",
		Help:    "Wall time of one analyzer process (a batch of takes).",
		Buckets: prometheus.ExponentialBuckets(1, 2, 10),
	})
	AnalysisSecondsPerTake = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "voicetrain_analysis_seconds_per_take",
		Help:    "A batch's wall time divided by its takes.",
		Buckets: prometheus.ExponentialBuckets(0.25, 2, 10),
	})
	BackupRuns = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "voicetrain_backup_runs_total",
		Help: "Backup runs by result (ok, failed). A failed run wrote nothing it shouldn't: an unmounted share fails it.",
	}, []string{"result"})
	BackupLastSuccess = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "voicetrain_backup_last_success_timestamp_seconds",
		Help: "When the last backup run finished without error (0: none since start).",
	})
	BackupBadTakes = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "voicetrain_backup_bad_takes",
		Help: "Takes the last backup run skipped because their files don't match their rows (missing or the wrong size).",
	})
	BackupFilesCopied = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "voicetrain_backup_recordings_copied_total",
		Help: "Takes copied to the backup destination.",
	})
	Refused = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "voicetrain_refused_total",
		Help: "Requests refused by the auth checks, by reason (peer, origin, method, login; host on a laptop).",
	}, []string{"reason"})
)

// Register adds every metric to reg, plus gauges read on scrape.
func Register(reg prometheus.Registerer, queued, running func() float64) {
	reg.MustRegister(TakesSaved, TakeSeconds, AnalysisTakes, AnalysisBatchSeconds, AnalysisSecondsPerTake, Refused,
		BackupRuns, BackupLastSuccess, BackupFilesCopied, BackupBadTakes,
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "voicetrain_analysis_queued",
			Help: "Takes waiting for the analyzer.",
		}, queued),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Name: "voicetrain_analysis_running",
			Help: "Takes in analyzer processes now.",
		}, running),
	)
	// Prometheus's increase() returns 0 for a series' first sample, so the
	// alert on a failed run would miss the first failure if it created the series.
	for _, r := range []string{"ok", "failed"} {
		BackupRuns.WithLabelValues(r)
		AnalysisTakes.WithLabelValues(r)
	}
}
