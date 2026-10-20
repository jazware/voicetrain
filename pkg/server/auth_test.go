package server

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jazware/voicetrain/pkg/store"
)

func testServer(t *testing.T, auth Auth) http.Handler {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return New(slog.New(slog.NewTextHandler(io.Discard, nil)), st, dir, nil, Options{Auth: auth})
}

type req struct {
	method, path, from, host string
	hdr                      [][2]string
}

func (q req) do(h http.Handler) int {
	r := httptest.NewRequest(q.method, q.path, nil)
	r.RemoteAddr = q.from
	if q.host != "" {
		r.Host = q.host
	}
	for _, kv := range q.hdr {
		r.Header.Add(kv[0], kv[1])
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	return rec.Code
}

func TestAuthBehindCaddy(t *testing.T) {
	auth, err := NewAuth([]string{"192.0.2.50"}, []string{"user@github"}, "https://voice.example.com")
	if err != nil {
		t.Fatal(err)
	}
	h := testServer(t, auth)
	caddy, host, lan := "192.0.2.50:41234", "192.0.2.46:41234", "192.0.2.20:41234"
	jaz := [2]string{LoginHeader, "user@github"}
	own := [2]string{"Origin", "https://voice.example.com"}

	cases := []struct {
		name string
		req  req
		want int
	}{
		{"health from host", req{"GET", "/healthz", host, "", nil}, 200},
		{"health with a query", req{"GET", "/healthz?x=1", host, "", nil}, 200},
		{"api from host itself", req{"GET", "/api/scripts", host, "", [][2]string{jaz}}, 403},
		{"the page from the LAN", req{"GET", "/", lan, "", nil}, 403},
		{"a path that only looks like health", req{"GET", "/healthz/../api/scripts", host, "", nil}, 403},
		{"proxy, no login", req{"GET", "/api/scripts", caddy, "", nil}, 401},
		{"proxy, someone else", req{"GET", "/api/scripts", caddy, "", [][2]string{{LoginHeader, "mallory@github"}}}, 401},
		{"proxy, two logins", req{"GET", "/api/scripts", caddy, "", [][2]string{jaz, {LoginHeader, "mallory@github"}}}, 401},
		{"proxy, operator", req{"GET", "/api/scripts", caddy, "", [][2]string{jaz}}, 200},
		{"IPv4-mapped proxy address", req{"GET", "/api/scripts", "[::ffff:192.0.2.50]:41234", "", [][2]string{jaz}}, 200},
		{"operator, the page", req{"GET", "/", caddy, "", [][2]string{jaz}}, 200},
		{"operator via a foreign page", req{"DELETE", "/api/recordings/1", caddy, "", [][2]string{jaz, {"Origin", "https://evil.example"}}}, 403},
		{"two Origins", req{"PUT", "/api/settings", caddy, "", [][2]string{jaz, own, {"Origin", "https://evil.example"}}}, 403},
		{"cross-site fetch", req{"GET", "/api/recordings/1/audio", caddy, "", [][2]string{jaz, {"Sec-Fetch-Site", "cross-site"}}}, 403},
		{"same-site fetch (another *.jaz.sh page)", req{"GET", "/api/recordings", caddy, "", [][2]string{jaz, {"Sec-Fetch-Site", "same-site"}}}, 403},
		{"same-site navigation to the app", req{"GET", "/history", caddy, "", [][2]string{jaz, {"Sec-Fetch-Site", "same-site"}, {"Sec-Fetch-Mode", "navigate"}, {"Sec-Fetch-Dest", "document"}}}, 200},
		{"cross-site navigation to the app", req{"GET", "/", caddy, "", [][2]string{jaz, {"Sec-Fetch-Site", "cross-site"}, {"Sec-Fetch-Mode", "navigate"}, {"Sec-Fetch-Dest", "document"}}}, 200},
		{"a cross-site iframe (clickjacking)", req{"GET", "/recordings/1", caddy, "", [][2]string{jaz, {"Sec-Fetch-Site", "cross-site"}, {"Sec-Fetch-Mode", "navigate"}, {"Sec-Fetch-Dest", "iframe"}}}, 403},
		{"a same-site iframe", req{"GET", "/", caddy, "", [][2]string{jaz, {"Sec-Fetch-Site", "same-site"}, {"Sec-Fetch-Mode", "navigate"}, {"Sec-Fetch-Dest", "iframe"}}}, 403},
		{"navigation straight to the API", req{"GET", "/api/recordings", caddy, "", [][2]string{jaz, {"Sec-Fetch-Site", "same-site"}, {"Sec-Fetch-Mode", "navigate"}, {"Sec-Fetch-Dest", "document"}}}, 403},
		{"a navigating POST", req{"POST", "/api/recordings", caddy, "", [][2]string{jaz, {"Sec-Fetch-Site", "cross-site"}, {"Sec-Fetch-Mode", "navigate"}, {"Sec-Fetch-Dest", "document"}}}, 403},
		{"operator, own origin", req{"PUT", "/api/settings", caddy, "", [][2]string{jaz, own, {"Content-Type", "application/json"}}}, 400},
		{"preflight", req{"OPTIONS", "/api/settings", caddy, "", [][2]string{jaz}}, 405},
	}
	for _, c := range cases {
		if got := c.req.do(h); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestEveryResponseForbidsFraming(t *testing.T) {
	auth, _ := NewAuth([]string{"192.0.2.50"}, []string{"user@github"}, "https://voice.example.com")
	for _, h := range []http.Handler{testServer(t, auth), testServer(t, Auth{})} {
		for _, path := range []string{"/", "/api/scripts", "/healthz", "/nope"} {
			r := httptest.NewRequest("GET", path, nil)
			r.RemoteAddr = "192.0.2.50:1"
			r.Host = "localhost:8100"
			r.Header.Set(LoginHeader, "user@github")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, r)
			if rec.Header().Get("X-Frame-Options") != "DENY" ||
				rec.Header().Get("Content-Security-Policy") != "frame-ancestors 'none'" {
				t.Errorf("%s (%d): framing not forbidden: %v", path, rec.Code, rec.Header())
			}
		}
	}
	// A refusal too.
	h := testServer(t, auth)
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "192.0.2.20:1"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, r)
	if rec.Code != 403 || rec.Header().Get("X-Frame-Options") != "DENY" {
		t.Errorf("refusal: %d %v", rec.Code, rec.Header())
	}
}

func TestLaptopModeOnlyLoopback(t *testing.T) {
	h := testServer(t, Auth{})
	local := "127.0.0.1:50000"
	cases := []struct {
		name string
		req  req
		want int
	}{
		{"localhost", req{"GET", "/api/scripts", local, "localhost:8100", nil}, 200},
		{"127.0.0.1", req{"GET", "/api/scripts", local, "127.0.0.1:8100", nil}, 200},
		{"[::1]", req{"GET", "/api/scripts", local, "[::1]:8100", nil}, 200},
		{"the Vite dev server", req{"POST", "/api/scripts", local, "localhost:3002", [][2]string{{"Origin", "http://localhost:3002"}}}, 400},
		{"DNS rebinding", req{"GET", "/api/recordings", local, "evil.example:8100", nil}, 403},
		{"a cross-site form post", req{"POST", "/api/recordings", local, "localhost:8100", [][2]string{{"Origin", "https://evil.example"}}}, 403},
		{"a cross-site fetch", req{"DELETE", "/api/recordings/1", local, "localhost:8100", [][2]string{{"Sec-Fetch-Site", "cross-site"}}}, 403},
		{"health always", req{"GET", "/healthz", local, "evil.example", nil}, 200},
	}
	for _, c := range cases {
		if got := c.req.do(h); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestNewAuthRefusesHalfAConfig(t *testing.T) {
	if a, err := NewAuth(nil, nil, ""); err != nil || a.Enabled() {
		t.Fatalf("no proxies is laptop mode: %+v %v", a, err)
	}
	for _, c := range []struct {
		ops    []string
		origin string
		want   string
	}{
		{nil, "https://voice.example.com", "operators"},
		{[]string{" "}, "https://voice.example.com", "operators"},
		{[]string{"user@github"}, "", "origin"},
		{[]string{"user@github"}, "http://voice.example.com", "https://"},
		{[]string{"user@github"}, "https://voice.example.com/app", "https://"},
	} {
		_, err := NewAuth([]string{"192.0.2.50"}, c.ops, c.origin)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("ops=%v origin=%q: got %v, want an error mentioning %q", c.ops, c.origin, err, c.want)
		}
	}
	if _, err := NewAuth([]string{"not-an-address"}, []string{"user@github"}, "https://voice.example.com"); err == nil {
		t.Error("a bad proxy address should be refused")
	}
}
