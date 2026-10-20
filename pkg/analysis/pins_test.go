package analysis

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// The image's Python packages are pinned in build/Dockerfile (base stages
// get no build context to copy a lockfile from). They must be wheels and
// hashes analysis/uv.lock pins, so the image runs what the tests ran.
func TestBasePinsMatchLock(t *testing.T) {
	dockerfile, err := os.ReadFile("../../build/Dockerfile")
	if err != nil {
		t.Fatal(err)
	}
	lock, err := os.ReadFile("../../analysis/uv.lock")
	if err != nil {
		t.Fatal(err)
	}
	pins := regexp.MustCompile(`'([a-z-]+) @ (\S+\.whl) --hash=sha256:([0-9a-f]{64})'`).FindAllStringSubmatch(string(dockerfile), -1)
	if len(pins) != 2 {
		t.Fatalf("expected the numpy and parselmouth pins in build/Dockerfile, found %d", len(pins))
	}
	for _, p := range pins {
		entry := `{ url = "` + p[2] + `", hash = "sha256:` + p[3] + `"`
		if !strings.Contains(string(lock), entry) {
			t.Errorf("%s: %s with that hash isn't in analysis/uv.lock; copy the cp312 manylinux x86_64 wheel's url and hash from it", p[1], p[2])
		}
	}
	if !strings.Contains(string(dockerfile), "FROM python:3.12-") {
		t.Error("the base's Python must be 3.12, as analysis/pyproject.toml requires")
	}
}
