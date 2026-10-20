package store

import (
	"embed"
	"fmt"
	"strings"
	"time"
)

//go:embed seeds/*.txt
var seedsFS embed.FS

type seedScript struct {
	slug        string
	title       string
	attribution string
	focusPoints string // JSON array of focus-point ids (see ui/src/lib/focusPoints.ts)
	kind        string // "" (a passage) or an exercise kind
}

var seedScripts = []seedScript{
	{
		slug:        "rainbow-passage",
		title:       "The Rainbow Passage",
		attribution: "Fairbanks, G. (1960). Voice and Articulation Drillbook.",
		focusPoints: `["pitch","resonance","intonation","breath"]`,
	},
	{
		slug:        "north-wind-and-the-sun",
		title:       "The North Wind and the Sun",
		attribution: "Aesop, as used by the International Phonetic Association.",
		focusPoints: `["pitch","resonance","weight","articulation"]`,
	},
	{
		slug:        "siren",
		title:       "Sirens",
		attribution: "A warm-up: slow glides across your range.",
		focusPoints: `["pitch","resonance"]`,
		kind:        KindSiren,
	},
	{
		slug:        "sustained-vowel",
		title:       "Sustained “ah”",
		attribution: "One steady note, held on one easy breath.",
		focusPoints: `["pitch","weight"]`,
		kind:        KindSustain,
	},
	{
		slug:        "hold-the-band",
		title:       "Hold the band",
		attribution: "A minute of talking, inside your home band.",
		focusPoints: `["pitch","intonation"]`,
		kind:        KindHold,
	},
}

// seed inserts the standard passages, keyed on seed_slug so it is
// idempotent: user edits and deletes stick across restarts.
func (s *Store) seed() error {
	now := time.Now().UnixMilli()
	for _, sc := range seedScripts {
		body, err := seedsFS.ReadFile("seeds/" + sc.slug + ".txt")
		if err != nil {
			return fmt.Errorf("reading seed %s: %w", sc.slug, err)
		}
		kind := sc.kind
		if kind == "" {
			kind = KindPassage
		}
		_, err = s.db.Exec(`
			INSERT INTO scripts (title, body, attribution, focus_points, is_seeded, seed_slug, kind, created_at, updated_at)
			VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
			ON CONFLICT(seed_slug) DO NOTHING`,
			sc.title, strings.TrimSpace(string(body)), sc.attribution, sc.focusPoints, sc.slug, kind, now, now,
		)
		if err != nil {
			return fmt.Errorf("seeding %s: %w", sc.slug, err)
		}
	}
	return nil
}
