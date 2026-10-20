package metrics

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

func TestBackupRunsExistAtZeroAfterRegister(t *testing.T) {
	reg := prometheus.NewRegistry()
	Register(reg, func() float64 { return 0 }, func() float64 { return 0 })
	fams, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	seen := map[string]float64{}
	for _, f := range fams {
		if f.GetName() != "voicetrain_backup_runs_total" {
			continue
		}
		for _, m := range f.GetMetric() {
			seen[m.GetLabel()[0].GetValue()] = m.GetCounter().GetValue()
		}
	}
	for _, r := range []string{"ok", "failed"} {
		v, ok := seen[r]
		if !ok || v != 0 {
			t.Fatalf("result=%s: present=%v value=%v", r, ok, v)
		}
	}
}
