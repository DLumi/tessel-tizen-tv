// Package webdav reads files off a WebDAV server for ffmpeg — a Nextcloud, a
// NAS's WebDAV server, a cloud drive — the way the smb package reads them off
// a share. The TV registers a server with its credentials before it plays
// (POST /api/dav); nothing here is written to disk, so the box never holds a
// WebDAV password longer than it runs.
//
// Auth is whatever the server asks for in its 401: Basic, or Digest (Apache's
// mod_dav and some NAS boxes). Nothing is sent until the server has asked, and
// what it asked for is remembered so a stream's many Range requests don't each
// cost a round trip. Insecure accepts a certificate the box can't verify — the
// self-signed one on a NAS at home.
package webdav

import (
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Server is what the TV registers: the root URL and how to log in.
type Server struct {
	ID       string `json:"id"`
	URL      string `json:"url"`
	User     string `json:"user"`
	Pass     string `json:"pass"`
	Insecure bool   `json:"insecure"`
}

// Validate normalises the root URL (one trailing slash) and refuses what can't
// be a WebDAV server.
func (s *Server) Validate() error {
	u, err := url.Parse(strings.TrimSpace(s.URL))
	if err != nil {
		return fmt.Errorf("bad url: %w", err)
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return errors.New("url must be http(s)://host/…")
	}
	if s.ID == "" {
		return errors.New("id required")
	}
	u.Fragment = ""
	s.URL = strings.TrimRight(u.String(), "/") + "/"
	return nil
}

// IsLoopback reports a URL that points at the box itself — which the TV, who
// has to reach the same server, could never have meant.
func (s Server) IsLoopback() bool {
	u, err := url.Parse(s.URL)
	if err != nil {
		return false
	}
	host := u.Hostname()
	ip := net.ParseIP(host)
	return (ip != nil && (ip.IsLoopback() || ip.IsUnspecified())) || strings.EqualFold(host, "localhost")
}

// Label is the server without its secrets, for logs.
func (s Server) Label() string { return s.ID + " " + s.URL }

// challenge is a parsed Digest offer.
type challenge struct {
	realm, nonce, qop, opaque, algorithm string
}

type authState struct {
	scheme string // "basic" | "digest"
	ch     challenge
	nc     uint32
}

// Client reads one registered server.
type Client struct {
	srv  Server
	http *http.Client

	mu   sync.Mutex
	auth *authState
}

// NewClient builds the client; the Server should have been validated.
func NewClient(s Server) *Client {
	tr := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		TLSClientConfig:     &tls.Config{InsecureSkipVerify: s.Insecure}, //nolint:gosec // the user asked for it, per server
		TLSHandshakeTimeout: 15 * time.Second,
		DialContext:         (&net.Dialer{Timeout: 15 * time.Second}).DialContext,
	}
	return &Client{srv: s, http: &http.Client{Transport: tr}}
}

// Server is what the client was built from.
func (c *Client) Server() Server { return c.srv }

// FileURL is where `path` below the root is, each segment percent-encoded.
func (c *Client) FileURL(path string) string {
	var b strings.Builder
	b.WriteString(c.srv.URL)
	first := true
	for _, seg := range strings.Split(path, "/") {
		if seg == "" {
			continue
		}
		if !first {
			b.WriteByte('/')
		}
		first = false
		b.WriteString(url.PathEscape(seg))
	}
	return b.String()
}

// Get fetches the file at `path`, with the Range header handed on. The
// caller closes the body. A 401 is answered once with what the server asked
// for; a second one means the credentials are wrong.
func (c *Client) Get(ctx context.Context, path, rangeHeader string) (*http.Response, error) {
	target := c.FileURL(path)
	for attempt := 0; attempt < 2; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "Tessel transcode")
		if rangeHeader != "" {
			req.Header.Set("Range", rangeHeader)
		}
		if a := c.authorization(http.MethodGet, req.URL.RequestURI()); a != "" {
			req.Header.Set("Authorization", a)
		}
		resp, err := c.http.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusUnauthorized || attempt == 1 || c.srv.User == "" {
			return resp, nil
		}
		offered := parseChallenge(resp.Header.Values("WWW-Authenticate"))
		resp.Body.Close()
		if !c.adopt(offered) {
			return nil, errors.New("the server accepts neither Basic nor Digest login")
		}
	}
	return nil, errors.New("unreachable")
}

// adopt picks the scheme a 401 offered; false when there is nothing new to
// try (the server offers only what already failed).
func (c *Client) adopt(o offered) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case o.digest != nil:
		c.auth = &authState{scheme: "digest", ch: *o.digest}
		return true
	case o.basic && (c.auth == nil || c.auth.scheme != "basic"):
		c.auth = &authState{scheme: "basic"}
		return true
	}
	return false
}

func (c *Client) authorization(method, uri string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.auth == nil || c.srv.User == "" {
		return ""
	}
	if c.auth.scheme == "basic" {
		return "Basic " + basicToken(c.srv.User, c.srv.Pass)
	}
	c.auth.nc++
	var rnd [8]byte
	rand.Read(rnd[:])
	return digestAuthorization(c.auth.ch, method, uri, c.srv.User, c.srv.Pass, c.auth.nc, hex.EncodeToString(rnd[:]))
}

func basicToken(user, pass string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
}

type offered struct {
	basic  bool
	digest *challenge
}

var digestParam = regexp.MustCompile(`([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))`)

// parseChallenge reads the schemes one or more WWW-Authenticate headers offer.
func parseChallenge(headers []string) offered {
	var o offered
	for _, h := range headers {
		for _, part := range splitSchemes(h) {
			lower := strings.ToLower(part)
			switch {
			case strings.HasPrefix(lower, "basic"):
				o.basic = true
			case strings.HasPrefix(lower, "digest"):
				ch := challenge{}
				for _, m := range digestParam.FindAllStringSubmatch(part[len("digest"):], -1) {
					v := m[3]
					if m[2] != "" || m[3] == "" {
						v = strings.ReplaceAll(m[2], `\"`, `"`)
					}
					switch strings.ToLower(m[1]) {
					case "realm":
						ch.realm = v
					case "nonce":
						ch.nonce = v
					case "qop":
						ch.qop = v
					case "opaque":
						ch.opaque = v
					case "algorithm":
						ch.algorithm = v
					}
				}
				if ch.nonce != "" {
					o.digest = &ch
				}
			}
		}
	}
	return o
}

var schemeStart = regexp.MustCompile(`(?i)(?:^|,)\s*(basic|digest)\b`)

// splitSchemes cuts `Basic realm="x", Digest realm="y", nonce="z"` into one
// string per scheme: a scheme is a bare name at the start or after a comma,
// where parameters are always key=value.
func splitSchemes(h string) []string {
	locs := schemeStart.FindAllStringSubmatchIndex(h, -1)
	out := make([]string, 0, len(locs))
	for i, loc := range locs {
		end := len(h)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		out = append(out, strings.TrimSpace(h[loc[2]:end]))
	}
	return out
}

func md5hex(s string) string {
	sum := md5.Sum([]byte(s)) //nolint:gosec // RFC 7616 MD5 is what servers offer
	return hex.EncodeToString(sum[:])
}

// digestAuthorization is the Authorization value for one request (RFC 7616,
// MD5 and MD5-sess, qop=auth when offered).
func digestAuthorization(ch challenge, method, uri, user, pass string, nc uint32, cnonce string) string {
	alg := strings.ToUpper(ch.algorithm)
	if alg == "" {
		alg = "MD5"
	}
	ha1 := md5hex(user + ":" + ch.realm + ":" + pass)
	if alg == "MD5-SESS" {
		ha1 = md5hex(ha1 + ":" + ch.nonce + ":" + cnonce)
	}
	ha2 := md5hex(method + ":" + uri)
	qop := ""
	for _, q := range strings.Split(ch.qop, ",") {
		if strings.TrimSpace(q) == "auth" {
			qop = "auth"
		}
	}
	ncHex := fmt.Sprintf("%08x", nc)
	var resp string
	if qop != "" {
		resp = md5hex(ha1 + ":" + ch.nonce + ":" + ncHex + ":" + cnonce + ":" + qop + ":" + ha2)
	} else {
		resp = md5hex(ha1 + ":" + ch.nonce + ":" + ha2)
	}
	var b strings.Builder
	fmt.Fprintf(&b, `Digest username="%s", realm="%s", nonce="%s", uri="%s", response="%s", algorithm=%s`,
		strings.ReplaceAll(user, `"`, `\"`), ch.realm, ch.nonce, uri, resp, alg)
	if qop != "" {
		fmt.Fprintf(&b, `, qop=%s, nc=%s, cnonce="%s"`, qop, ncHex, cnonce)
	}
	if ch.opaque != "" {
		fmt.Fprintf(&b, `, opaque="%s"`, ch.opaque)
	}
	return b.String()
}

// Registry is the servers the TVs have registered this run, by id.
type Registry struct {
	mu sync.Mutex
	m  map[string]*Client
}

func NewRegistry() *Registry { return &Registry{m: map[string]*Client{}} }

// Put registers or replaces a server. The client is rebuilt, so changed
// credentials take effect at once.
func (r *Registry) Put(s Server) error {
	if err := s.Validate(); err != nil {
		return err
	}
	r.mu.Lock()
	r.m[s.ID] = NewClient(s)
	r.mu.Unlock()
	return nil
}

// Get is the client for a registered id.
func (r *Registry) Get(id string) (*Client, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	c, ok := r.m[id]
	return c, ok
}
