package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

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

	// recordings/YYYY/MM/<id>.wav, bucketed by the user's local day.
	relPath := filepath.Join("recordings", localDay[0:4], localDay[5:7], fmt.Sprintf("%d.wav", id))
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

	recording, err := s.store.GetRecording(id)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, recording)
}

// handleAnalyzeRecording queues a (re-)analysis of one take.
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
			"analysis unavailable — is docker running and the voicetrain-analysis image built?")
	}
	s.analyzer.Enqueue(id)
	return c.JSON(http.StatusAccepted, map[string]string{"status": "queued"})
}

func (s *Server) writeRecordingFile(absPath string, src io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return err
	}
	dst, err := os.Create(absPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		os.Remove(absPath)
		return err
	}
	return dst.Close()
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
