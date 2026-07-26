package server

import (
	"io/fs"
	"net/http"

	"github.com/jazware/voicetrain/ui"
	"github.com/labstack/echo/v4"
)

// spaHandler serves the embedded frontend with an index.html fallback
// for client-side routes (mirrors atproto's dashboard handler).
type spaHandler struct {
	distFS     fs.FS
	fileServer http.Handler
}

func newSPAHandler() *spaHandler {
	distFS, err := fs.Sub(ui.DistFS, "dist")
	if err != nil {
		panic("ui dist missing from embedded FS: " + err.Error())
	}
	return &spaHandler{
		distFS:     distFS,
		fileServer: http.FileServer(http.FS(distFS)),
	}
}

func (h *spaHandler) handle(c echo.Context) error {
	reqPath := c.Param("*")
	if reqPath == "" {
		reqPath = "index.html"
	}

	if f, err := h.distFS.Open(reqPath); err == nil {
		f.Close()
		h.fileServer.ServeHTTP(c.Response(), c.Request())
		return nil
	}

	// Unknown path: an SPA route like /practice/3 — serve the app shell.
	indexData, err := fs.ReadFile(h.distFS, "index.html")
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound,
			"frontend not built — run `just ui-build` and restart")
	}
	return c.HTMLBlob(http.StatusOK, indexData)
}
