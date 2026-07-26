package server

import (
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/labstack/echo/v4"
)

var dayRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

// handleHeatmap returns per-day practice aggregates for the calendar
// view. Defaults to the trailing year when from/to are omitted.
func (s *Server) handleHeatmap(c echo.Context) error {
	from := c.QueryParam("from")
	to := c.QueryParam("to")
	if to == "" {
		to = time.Now().Format("2006-01-02")
	}
	if from == "" {
		from = time.Now().AddDate(-1, 0, 0).Format("2006-01-02")
	}
	if !dayRe.MatchString(from) || !dayRe.MatchString(to) {
		return echo.NewHTTPError(http.StatusBadRequest, "from/to must be YYYY-MM-DD")
	}

	var scriptID *int64
	if v := c.QueryParam("script_id"); v != "" {
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid script_id")
		}
		scriptID = &id
	}

	days, err := s.store.Heatmap(from, to, scriptID)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, days)
}
