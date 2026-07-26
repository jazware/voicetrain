package server

import (
	"net/http"

	"github.com/jazware/voicetrain/pkg/store"
	"github.com/labstack/echo/v4"
)

func (s *Server) handleGetSettings(c echo.Context) error {
	settings, err := s.store.GetSettings()
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, settings)
}

func (s *Server) handlePutSettings(c echo.Context) error {
	var settings store.Settings
	if err := c.Bind(&settings); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid JSON body")
	}
	if err := s.store.PutSettings(settings); err != nil {
		return mapStoreErr(err)
	}
	return c.JSON(http.StatusOK, settings)
}
