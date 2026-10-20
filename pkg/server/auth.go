package server

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strings"

	"github.com/labstack/echo/v4"
)

// LoginHeader is what monitoring's Caddy sets after tailscale_auth,
// believed only from a trusted proxy's address.
const LoginHeader = "Tailscale-User-Login"

// Auth guards voicetrain when it's served beyond localhost (voice.example.com,
// deploy/yeet/stacks/voicetrain): flick's and mediaferry's model.
//
// The container is published on the host's LAN address, so only Caddy's
// address is believed at all, and only for an operator's login. Caddy
// vouches for Jaz's tailnet identity on every request from her devices,
// whatever page made it, so a site open in her browser could try to use
// it: a web Origin other than voicetrain's own is refused, as is
// Sec-Fetch-Site cross-site, and no CORS headers are sent.
//
// A zero Auth (no proxies) is the laptop mode: the server listens on
// loopback, and only loopback hosts and origins get through (localRefusal).
type Auth struct {
	// Proxies are the TCP peers believed at all: monitoring's LAN address.
	Proxies []netip.Prefix
	// Operators are the Tailscale logins allowed.
	Operators []string
	// Origin is voicetrain's own origin (https://voice.example.com).
	Origin string
}

func (a Auth) Enabled() bool { return len(a.Proxies) > 0 }

func ParsePrefixes(list []string) ([]netip.Prefix, error) {
	var out []netip.Prefix
	for _, s := range list {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if strings.Contains(s, "/") {
			p, err := netip.ParsePrefix(s)
			if err != nil {
				return nil, err
			}
			out = append(out, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(s)
		if err != nil {
			return nil, err
		}
		out = append(out, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
	}
	return out, nil
}

func (a Auth) trustedPeer(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	p, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	p = p.Unmap()
	for _, pre := range a.Proxies {
		if pre.Contains(p) {
			return true
		}
	}
	return false
}

// NewAuth builds the checks from flags. With no proxies it's the laptop
// mode; with proxies, operators and the site's origin are required, or
// every request would be refused.
func NewAuth(proxies, operators []string, origin string) (Auth, error) {
	prefixes, err := ParsePrefixes(proxies)
	if err != nil {
		return Auth{}, fmt.Errorf("parsing trusted proxies: %w", err)
	}
	if len(prefixes) == 0 {
		return Auth{}, nil
	}
	var ops []string
	for _, o := range operators {
		if o = strings.TrimSpace(o); o != "" {
			ops = append(ops, o)
		}
	}
	if len(ops) == 0 || origin == "" {
		return Auth{}, fmt.Errorf("trusted proxies need operators and a site origin, or every request is refused")
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.Path != "" {
		return Auth{}, fmt.Errorf("site origin must look like https://voice.example.com, got %q", origin)
	}
	return Auth{Proxies: prefixes, Operators: ops, Origin: origin}, nil
}

// originAllowed refuses a request another site made: a foreign (or more
// than one) Origin, or a fetch the browser marks same-site or
// cross-site (another *.jaz.sh page is same-site). A top-level
// navigation to a page, not the API, is fine from anywhere: it's a link
// being followed, and the page it loads makes its API calls same-origin.
// Only top-level: a navigation into an <iframe> is how clickjacking
// starts, so it's refused (and every response forbids framing anyway).
func originAllowed(r *http.Request, sameOrigin func(string) bool) bool {
	switch origins := r.Header.Values("Origin"); len(origins) {
	case 0:
	case 1:
		if !sameOrigin(origins[0]) {
			return false
		}
	default:
		return false
	}
	if r.Method == http.MethodGet && r.Header.Get("Sec-Fetch-Mode") == "navigate" &&
		r.Header.Get("Sec-Fetch-Dest") == "document" && !strings.HasPrefix(r.URL.Path, "/api/") {
		return true
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "same-origin", "none":
		return true
	}
	return false
}

// refusal is why a request was turned away, or "" to let it through.
func (a Auth) refusal(r *http.Request) (code int, reason string) {
	if !a.Enabled() {
		return localRefusal(r)
	}
	if !a.trustedPeer(r) {
		return http.StatusForbidden, "peer"
	}
	if !originAllowed(r, func(o string) bool { return o == a.Origin }) {
		return http.StatusForbidden, "origin"
	}
	if r.Method == http.MethodOptions {
		return http.StatusMethodNotAllowed, "method"
	}
	logins := r.Header.Values(LoginHeader)
	if len(logins) != 1 || !slices.Contains(a.Operators, logins[0]) {
		return http.StatusUnauthorized, "login"
	}
	return 0, ""
}

// localRefusal is the laptop mode's guard. The server listens on
// loopback, but a web page can still reach it from Jaz's browser: by
// DNS rebinding (a name of its own that resolves to 127.0.0.1, so the
// Host isn't localhost) or by a cross-site form post. So the Host must be
// a loopback name and any Origin a loopback page's.
func localRefusal(r *http.Request) (int, string) {
	if !loopbackHost(r.Host) {
		return http.StatusForbidden, "host"
	}
	if !originAllowed(r, func(o string) bool {
		u, err := url.Parse(o)
		return err == nil && u.Scheme == "http" && loopbackHost(u.Host)
	}) {
		return http.StatusForbidden, "origin"
	}
	return 0, ""
}

func loopbackHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	switch strings.ToLower(strings.Trim(host, "[]")) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}

// middleware applies the checks to every route but /healthz, which
// yeetd's gates call from the host itself.
func (a Auth) middleware(onRefuse func(reason string)) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if c.Path() == "/healthz" {
				return next(c)
			}
			if code, reason := a.refusal(c.Request()); reason != "" {
				onRefuse(reason)
				return c.JSON(code, map[string]string{"message": http.StatusText(code)})
			}
			return next(c)
		}
	}
}
