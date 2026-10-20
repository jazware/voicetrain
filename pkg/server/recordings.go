package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/jazware/voicetrain/pkg/metrics"
	"github.com/jazware/voicetrain/pkg/store"
	"github.com/jazware/voicetrain/pkg/wav"
	"github.com/labstack/echo/v4"
)

// handleUploadRecording accepts a multipart WAV upload plus metadata,
// validates the WAV header server-side, and stores row + file.
func (s *Server) handleUploadRecording(c echo.Context) error {
	scriptID, err := strconv.ParseInt(c.FormValue("script_id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid script_id")
	}
	recordedAt, err := strconv.ParseInt(c.FormValue("recorded_at"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid recorded_at")
	}
	localDay := c.FormValue("local_day")

	fileHeader, err := c.FormFile("file")
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "missing file")
	}
	file, err := fileHeader.Open()
	if err != nil {
		return err
	}
	defer file.Close()

	info, err := wav.Parse(file)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, fmt.Sprintf("invalid WAV: %v", err))
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}

	id, err := s.store.CreateRecording(store.NewRecording{
		ScriptID:   scriptID,
		DurationMs: info.DurationMs,
		SampleRate: info.SampleRate,
		Channels:   info.Channels,
		SizeBytes:  fileHeader.Size,
		PitchStats: json.RawMessage(c.FormValue("pitch_stats")),
		RecordedAt: recordedAt,
		LocalDay:   localDay,
	})
	if err != nil {
		return mapStoreErr(err)
	}

	// recordings/YYYY/MM/<id>-<random>.wav, bucketed by the user's local
	// day. SQLite reuses the highest id after a delete, so the id alone
	// isn't unique over time: a backup holding the deleted take's
	// <id>.wav would pair it with the new row on a restore.
	suffix, err := randomHex(4)
	if err != nil {
		return err
	}
	relPath := filepath.Join("recordings", localDay[0:4], localDay[5:7], fmt.Sprintf("%d-%s.wav", id, suffix))
	absPath := filepath.Join(s.dataDir, relPath)
	if err := s.writeRecordingFile(absPath, file); err != nil {
		if delErr := s.store.DeleteRecording(id); delErr != nil {
			s.logger.Error("cleaning up recording row after write failure", "id", id, "error", delErr)
		}
		return fmt.Errorf("writing recording file: %w", err)
	}
	if err := s.store.SetRecordingFilePath(id, relPath); err != nil {
		return err
	}
	s.analyzer.Enqueue(id)
	metrics.TakesSaved.Inc()
	metrics.TakeSeconds.Observe(float64(info.DurationMs) / 1000)

	recording, err := s.store.GetRecording(id)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, recording)
}

func (s *Server) handleAnalyzeRecording(c echo.Context) error {
	id, err := pathID(c)
	if err != nil {
		return err
	}
	recording, err := s.store.GetRecording(id)
	if err != nil {
		return mapStoreErr(err)
	}
	if recording.FilePath == "" {
		return echo.NewHTTPError(http.StatusConflict, "recording has no audio file")
	}
	if s.analyzer == nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable,
			"analysis is off: the server found no analyzer when it started")
	}
	s.analyzer.Enqueue(id)
	return c.JSON(http.StatusAccepted, map[string]string{"status": "queued"})
}

// writeRecordingFile writes the take under a temporary name, syncs it and
// renames it into place, so nothing (the backup above all) ever sees a
// half-written WAV under the take's real name.
func (s *Server) writeRecordingFile(absPath string, src io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return err
	}
	tmp := absPath + ".partial"
	dst, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(dst, src)
	if err == nil {
		err = dst.Sync()
	}
	if cerr := dst.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, absPath)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (s *Server) handleListRecordings(c echo.Context) error {
	filter := store.RecordingFilter{}
	if v := c.QueryParam("script_id"); v != "" {
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid script_id")
		}
		filter.ScriptID = &id
	}
	if v := c.QueryParam("day"); v != "" {
		filter.LocalDay = &v
	}
	if v := c.QueryParam("limit"); v != "" {
		filter.Limit, _ = strconv.Atoi(v)
	}
	if v := c.QueryParam("offset"); v != "" {
		filter.Offset, _ = strconv.Atoi(v)
	}
	recordings, err := s.store.ListRecordings(filter)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, recordings)
}

func (s *Server) handleGetRecording(c echo.Context) error {
	id, err := pathID(c)
	if err != nil {
		return err
	}
	recording, err := s.store.GetRecording(id)
	if err != nil {
		return mapStoreErr(err)
	}
	return c.JSON(http.StatusOK, recording)
}

// handleStreamRecording serves the WAV; echo's c.File uses
// http.ServeContent underneath, which handles Range requests.
func (s *Server) handleStreamRecording(c echo.Context) error {
	id, err := pathID(c)
	if err != nil {
		return err
	}
	recording, err := s.store.GetRecording(id)
	if err != nil {
		return mapStoreErr(err)
	}
	if recording.FilePath == "" {
		return echo.NewHTTPError(http.StatusNotFound, "recording file missing")
	}
	c.Response().Header().Set("Content-Type", "audio/wav")
	return c.File(filepath.Join(s.dataDir, recording.FilePath))
}

func (s *Server) handleUpdateRecording(c echo.Context) error {
	id, err := pathID(c)
	if err != nil {
		return err
	}

	var body map[string]json.RawMessage
	if err := json.NewDecoder(c.Request().Body).Decode(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid JSON body")
	}

	var rating *int64
	ratingSet := false
	if raw, ok := body["rating"]; ok {
		ratingSet = true
		if string(raw) != "null" {
			var v int64
			if err := json.Unmarshal(raw, &v); err != nil {
				return echo.NewHTTPError(http.StatusBadRequest, "rating must be a number or null")
			}
			rating = &v
		}
	}
	var notes *string
	if raw, ok := body["notes"]; ok {
		var v string
		if err := json.Unmarshal(raw, &v); err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "notes must be a string")
		}
		notes = &v
	}

	recording, err := s.store.UpdateRecording(id, rating, ratingSet, notes)
	if err != nil {
		return mapStoreErr(err)
	}
	return c.JSON(http.StatusOK, recording)
}

func (s *Server) handleDeleteRecording(c echo.Context) error {
	id, err := pathID(c)
	if err != nil {
		return err
	}
	recording, err := s.store.GetRecording(id)
	if err != nil {
		return mapStoreErr(err)
	}
	if err := s.store.DeleteRecording(id); err != nil {
		return mapStoreErr(err)
	}
	if recording.FilePath != "" {
		if err := os.Remove(filepath.Join(s.dataDir, recording.FilePath)); err != nil && !os.IsNotExist(err) {
			s.logger.Error("removing recording file", "id", id, "path", recording.FilePath, "error", err)
		}
	}
	return c.NoContent(http.StatusNoContent)
}

func (s *Server) handleListAnnotations(c echo.Context) error {
	id, err := pathID(c)
	if err != nil {
		return err
	}
	if _, err := s.store.GetRecording(id); err != nil {
		return mapStoreErr(err)
	}
	annotations, err := s.store.ListAnnotations(id)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, annotations)
}

func (s *Server) handleAnalysisStatus(c echo.Context) error {
	return c.JSON(http.StatusOK, s.analyzer.Status())
}

func (s *Server) handleListAnalysisHistory(c echo.Context) error {
	id, err := pathID(c)
	if err != nil {
		return err
	}
	if _, err := s.store.GetRecording(id); err != nil {
		return mapStoreErr(err)
	}
	history, err := s.store.ListAnalysisHistory(id)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, history)
}

func (s *Server) handleRetryFailedAnalyses(c echo.Context) error {
	if s.analyzer == nil {
		return echo.NewHTTPError(http.StatusServiceUnavailable,
			"analysis is off: the server found no analyzer when it started")
	}
	ids, err := s.store.ListRecordingIDsWithAnalysisErrors()
	if err != nil {
		return err
	}
	for _, id := range ids {
		s.analyzer.Enqueue(id)
	}
	return c.JSON(http.StatusAccepted, map[string]int{"queued": len(ids)})
}
