package server

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/jazware/voicetrain/pkg/store"
	"github.com/labstack/echo/v4"
)

func (s *Server) handleListScripts(c echo.Context) error {
	scripts, err := s.store.ListScripts()
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, scripts)
}

func (s *Server) handleGetScript(c echo.Context) error {
	id, err := pathID(c)
	if err != nil {
		return err
	}
	script, err := s.store.GetScript(id)
	if err != nil {
		return mapStoreErr(err)
	}
	return c.JSON(http.StatusOK, script)
}

func (s *Server) handleCreateScript(c echo.Context) error {
	var params store.ScriptParams
	if err := c.Bind(&params); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid JSON body")
	}
	script, err := s.store.CreateScript(params)
	if err != nil {
		return mapStoreErr(err)
	}
	return c.JSON(http.StatusCreated, script)
}

func (s *Server) handleUpdateScript(c echo.Context) error {
	id, err := pathID(c)
	if err != nil {
		return err
	}
	var params store.ScriptParams
	if err := c.Bind(&params); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid JSON body")
	}
	script, err := s.store.UpdateScript(id, params)
	if err != nil {
		return mapStoreErr(err)
	}
	return c.JSON(http.StatusOK, script)
}

func (s *Server) handleDeleteScript(c echo.Context) error {
	id, err := pathID(c)
	if err != nil {
		return err
	}
	if err := s.store.DeleteScript(id); err != nil {
		return mapStoreErr(err)
	}
	return c.NoContent(http.StatusNoContent)
}

func pathID(c echo.Context) (int64, error) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return 0, echo.NewHTTPError(http.StatusBadRequest, "invalid id")
	}
	return id, nil
}

func mapStoreErr(err error) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	case errors.Is(err, store.ErrInvalid):
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	default:
		return err
	}
}
