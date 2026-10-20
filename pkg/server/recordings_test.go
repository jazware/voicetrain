package server

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	"github.com/jazware/voicetrain/pkg/store"
)

func tinyWAV(samples int) []byte {
	var b bytes.Buffer
	data := samples * 2
	b.WriteString("RIFF")
	binary.Write(&b, binary.LittleEndian, uint32(36+data))
	b.WriteString("WAVEfmt ")
	for _, v := range []any{uint32(16), uint16(1), uint16(1), uint32(48000), uint32(96000), uint16(2), uint16(16)} {
		binary.Write(&b, binary.LittleEndian, v)
	}
	b.WriteString("data")
	binary.Write(&b, binary.LittleEndian, uint32(data))
	b.Write(make([]byte, data))
	return b.Bytes()
}

func upload(t *testing.T, h http.Handler, scriptID int64) store.Recording {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	w.WriteField("script_id", jsonNum(scriptID))
	w.WriteField("recorded_at", "1760000000000")
	w.WriteField("local_day", "2026-10-13")
	fw, _ := w.CreateFormFile("file", "take.wav")
	fw.Write(tinyWAV(4800))
	w.Close()
	r := httptest.NewRequest("POST", "/api/recordings", &body)
	r.Host = "localhost:8100"
	r.Header.Set("Content-Type", w.FormDataContentType())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body)
	}
	var out store.Recording
	json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}

func jsonNum(n int64) string { b, _ := json.Marshal(n); return string(b) }

// A deleted newest take's id comes back (SQLite's INTEGER PRIMARY KEY),
// so file names carry a random part: the new take must not share the old
// one's name, or a backup would pair it with the wrong audio.
func TestUploadsGetUniqueNamesEvenForReusedIDs(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	h := New(slog.New(slog.NewTextHandler(io.Discard, nil)), st, dir, nil, Options{})
	scripts, _ := st.ListScripts()

	first := upload(t, h, scripts[0].ID)
	if !regexp.MustCompile(`^recordings/2026/10/\d+-[0-9a-f]{8}\.wav$`).MatchString(first.FilePath) {
		t.Fatalf("unexpected file path %q", first.FilePath)
	}
	if info, err := os.Stat(filepath.Join(dir, first.FilePath)); err != nil || info.Size() != first.SizeBytes {
		t.Fatalf("file not written at its row's size: %v", err)
	}
	if partials, _ := filepath.Glob(filepath.Join(dir, "recordings", "2026", "10", "*.partial")); len(partials) != 0 {
		t.Fatalf("temporary files left: %v", partials)
	}

	del := httptest.NewRequest("DELETE", "/api/recordings/"+jsonNum(first.ID), nil)
	del.Host = "localhost:8100"
	h.ServeHTTP(httptest.NewRecorder(), del)
	second := upload(t, h, scripts[0].ID)
	if second.ID != first.ID {
		t.Logf("id not reused (%d then %d)", first.ID, second.ID)
	}
	if second.FilePath == first.FilePath {
		t.Fatalf("a reused id got the same file name: %s", second.FilePath)
	}
}
