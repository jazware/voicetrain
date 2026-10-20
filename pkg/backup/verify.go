package backup

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Problem is a take whose audio isn't where its row says, at its size.
type Problem struct {
	ID       int64
	FilePath string
	Want     int64
	// Got is the file's size, or -1 when it's missing.
	Got int64
	// Candidate is a backup file of the right size for it, if one exists.
	Candidate string
}

// Report is what Verify found.
type Report struct {
	Takes    int
	OK       int
	Fixed    int
	Problems []Problem
	// Orphans are WAVs under recordings/ that no row names. They're never
	// deleted: a newer database might.
	Orphans []string
	// MovedAside are wrong-sized files --fix renamed to
	// <name>.replaced-<time> before copying the backup's in.
	MovedAside []string
}

// now is time.Now, swappable in tests.
var now = time.Now

// Verify checks that every take in the database at dbPath has its file
// under dataDir at the size its row records. With backupDir it also looks
// there for each broken take's file (its name, or a <name>.<sha12>.wav
// alternate of the right size), and with fix it copies that file in.
func Verify(dbPath, dataDir, backupDir string, fix bool) (Report, error) {
	takes, err := ListTakes(dbPath)
	if err != nil {
		return Report{}, err
	}
	rep := Report{Takes: len(takes)}
	named := map[string]bool{}
	for _, t := range takes {
		named[filepath.Clean(t.FilePath)] = true
		path := filepath.Join(dataDir, t.FilePath)
		got := int64(-1)
		if info, err := os.Stat(path); err == nil {
			got = info.Size()
		}
		if got == t.Size {
			rep.OK++
			continue
		}
		p := Problem{ID: t.ID, FilePath: t.FilePath, Want: t.Size, Got: got}
		if backupDir != "" {
			p.Candidate = findInBackup(backupDir, t)
		}
		if fix && p.Candidate != "" {
			if got >= 0 {
				// Keep the wrong-sized file: rename it out of the way.
				aside := fmt.Sprintf("%s.replaced-%s", path, now().UTC().Format(snapshotLayout))
				if err := os.Rename(path, aside); err != nil {
					return rep, fmt.Errorf("moving take %d's file aside: %w", t.ID, err)
				}
				rep.MovedAside = append(rep.MovedAside, aside)
			}
			if err := copyFile(p.Candidate, path); err != nil {
				return rep, fmt.Errorf("restoring take %d: %w", t.ID, err)
			}
			if info, err := os.Stat(path); err == nil && info.Size() == t.Size {
				rep.Fixed++
				rep.OK++
				continue
			}
		}
		rep.Problems = append(rep.Problems, p)
	}
	root := filepath.Join(dataDir, "recordings")
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(d.Name(), ".wav") || strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		rel, _ := filepath.Rel(dataDir, path)
		if !named[filepath.Clean(rel)] {
			rep.Orphans = append(rep.Orphans, rel)
		}
		return nil
	})
	sort.Strings(rep.Orphans)
	return rep, nil
}

// findInBackup returns the backup's file for a take: its own name if
// that's the right size, else an alternate of the right size.
func findInBackup(backupDir string, t Take) string {
	exact := filepath.Join(backupDir, t.FilePath)
	if info, err := os.Stat(exact); err == nil && info.Size() == t.Size {
		return exact
	}
	alts, _ := filepath.Glob(strings.TrimSuffix(exact, ".wav") + ".*.wav")
	sort.Strings(alts)
	for _, a := range alts {
		if info, err := os.Stat(a); err == nil && info.Size() == t.Size {
			return a
		}
	}
	return ""
}

// Print writes the report for people.
func (r Report) Print(w io.Writer) {
	fmt.Fprintf(w, "%d takes: %d ok", r.Takes, r.OK)
	if r.Fixed > 0 {
		fmt.Fprintf(w, " (%d restored from the backup)", r.Fixed)
	}
	fmt.Fprintf(w, ", %d with problems, %d orphan files\n", len(r.Problems), len(r.Orphans))
	for _, p := range r.Problems {
		state := "missing"
		if p.Got >= 0 {
			state = fmt.Sprintf("%d bytes, want %d", p.Got, p.Want)
		}
		fmt.Fprintf(w, "  take %d: %s: %s", p.ID, p.FilePath, state)
		if p.Candidate != "" {
			fmt.Fprintf(w, " (the backup has it: %s; --fix copies it)", p.Candidate)
		}
		fmt.Fprintln(w)
	}
	for _, o := range r.Orphans {
		fmt.Fprintf(w, "  orphan: %s (no take names it; left alone)\n", o)
	}
	for _, m := range r.MovedAside {
		fmt.Fprintf(w, "  kept the replaced file as %s\n", m)
	}
}
