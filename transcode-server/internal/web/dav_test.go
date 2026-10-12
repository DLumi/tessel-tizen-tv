package web

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/PatrickSt1991/tessel-tizen-tv/transcode-server/internal/config"
	"github.com/PatrickSt1991/tessel-tizen-tv/transcode-server/internal/webdav"
)

// A Basic-auth WebDAV server with one 100-byte file.
func davBox(t *testing.T) *httptest.Server {
	t.Helper()
	body := strings.Repeat("x", 50) + strings.Repeat("y", 50)
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("tv:secret")) {
			w.Header().Set("WWW-Authenticate", `Basic realm="dav"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/dav/Films/a.mkv" {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(w, r, "a.mkv", time.Time{}, strings.NewReader(body))
	}))
}

func register(t *testing.T, h http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/dav?token=tok", strings.NewReader(body))
	h.ServeHTTP(rec, req)
	return rec
}

func TestDavRegisterThenSourceAndRaw(t *testing.T) {
	box := davBox(t)
	defer box.Close()
	s := New(&config.Config{Token: "tok"}, nil, nil, 8200)
	h := s.Handler()

	// Unknown until registered.
	if _, err := s.sourceFor(httptest.NewRequest("GET", "/play?dav=nc1&path=Films/a.mkv", nil)); err == nil || !strings.Contains(err.Error(), "registers it") {
		t.Fatalf("err = %v", err)
	}
	if rec := register(t, h, `{"id":"nc1","url":"http://nas.example/dav","user":"tv","pass":"secret"}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("register: %d %s", rec.Code, rec.Body.String())
	}
	// The fake box listens on loopback, which the handler refuses (the TV
	// could never reach that address), so the bridge test registers it
	// directly.
	if err := s.dav.Put(webdav.Server{ID: "nc1", URL: box.URL + "/dav", User: "tv", Pass: "secret"}); err != nil {
		t.Fatal(err)
	}
	src, err := s.sourceFor(httptest.NewRequest("GET", "/play?dav=nc1&path=Films/a.mkv", nil))
	if err != nil || src.DAV != "nc1" || src.DAVPath != "Films/a.mkv" {
		t.Fatalf("%+v %v", src, err)
	}
	if _, err := s.sourceFor(httptest.NewRequest("GET", "/play?dav=nc1", nil)); err == nil {
		t.Fatal("no path accepted")
	}

	// /raw bridges the file with the Range handed on — from localhost only.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/raw?dav=nc1&path=Films/a.mkv", nil)
	req.RemoteAddr = "127.0.0.1:4444"
	req.Header.Set("Range", "bytes=50-59")
	h.ServeHTTP(rec, req)
	got, _ := io.ReadAll(rec.Body)
	if rec.Code != http.StatusPartialContent || string(got) != "yyyyyyyyyy" || rec.Header().Get("Content-Range") != "bytes 50-59/100" {
		t.Fatalf("raw: %d %q %q", rec.Code, got, rec.Header().Get("Content-Range"))
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/raw?dav=nc1&path=Films/a.mkv", nil)
	req.RemoteAddr = "192.168.1.9:4444"
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("raw from the LAN: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/raw?dav=nc1&path=Films/missing.mkv", nil)
	req.RemoteAddr = "127.0.0.1:4444"
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "404") {
		t.Fatalf("missing file: %d %s", rec.Code, rec.Body.String())
	}
}

func TestDavRegisterNeedsTheTokenAndAUsableURL(t *testing.T) {
	s := New(&config.Config{Token: "tok"}, nil, nil, 8200)
	h := s.Handler()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/dav", strings.NewReader(`{"id":"a","url":"http://nas/"}`)))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("no token: %d", rec.Code)
	}
	if rec := register(t, h, `{"id":"a","url":"http://127.0.0.1:8200/"}`); !strings.Contains(rec.Body.String(), `"ok":false`) {
		t.Fatalf("loopback: %s", rec.Body.String())
	}
	if rec := register(t, h, `not json`); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad json: %d", rec.Code)
	}
}
