package webdav

import (
	"context"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

func md5s(s string) string { h := md5.Sum([]byte(s)); return hex.EncodeToString(h[:]) }

func TestValidateNormalisesTheRootAndRefusesTheBoxItself(t *testing.T) {
	s := Server{ID: "nc1", URL: " https://cloud.example.com/remote.php/dav/files/pat "}
	if err := s.Validate(); err != nil || s.URL != "https://cloud.example.com/remote.php/dav/files/pat/" {
		t.Fatalf("got %q, %v", s.URL, err)
	}
	for _, bad := range []string{"ftp://x/", "nas.local/dav", ""} {
		if err := (&Server{ID: "x", URL: bad}).Validate(); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if err := (&Server{URL: "http://nas/"}).Validate(); err == nil {
		t.Error("no id accepted")
	}
	for _, u := range []string{"http://127.0.0.1:8200/", "http://localhost/", "http://[::1]/"} {
		if !(Server{URL: u}).IsLoopback() {
			t.Errorf("%s not seen as the box itself", u)
		}
	}
	if (Server{URL: "http://192.168.1.5:5005/"}).IsLoopback() {
		t.Error("a LAN address seen as loopback")
	}
}

func TestFileURLEscapesEachSegment(t *testing.T) {
	c := NewClient(Server{ID: "a", URL: "http://nas.local:5005/media/"})
	if u := c.FileURL("/Films/Sci Fi/Träume & Co.mkv"); u != "http://nas.local:5005/media/Films/Sci%20Fi/Tr%C3%A4ume%20&%20Co.mkv" {
		t.Fatalf("%s", u)
	}
}

func TestChallengeParsingAndDigestResponse(t *testing.T) {
	o := parseChallenge([]string{`Basic realm="dav", Digest realm="WebDAV", nonce="abc123", qop="auth", opaque="xyz", algorithm=MD5`})
	if !o.basic || o.digest == nil || o.digest.realm != "WebDAV" || o.digest.nonce != "abc123" || o.digest.qop != "auth" || o.digest.opaque != "xyz" {
		t.Fatalf("%+v %+v", o, o.digest)
	}
	if o := parseChallenge([]string{`Basic realm="x"`}); !o.basic || o.digest != nil {
		t.Fatalf("%+v", o)
	}
	if o := parseChallenge([]string{`Bearer realm="x"`}); o.basic || o.digest != nil {
		t.Fatalf("%+v", o)
	}
	h := digestAuthorization(*o.digest, "GET", "/dav/a.mkv", "tv", "pw", 1, "cn0nce")
	want := md5s(md5s("tv:WebDAV:pw") + ":abc123:00000001:cn0nce:auth:" + md5s("GET:/dav/a.mkv"))
	if !strings.HasPrefix(h, `Digest username="tv", realm="WebDAV", nonce="abc123", uri="/dav/a.mkv", response="`+want+`"`) ||
		!strings.Contains(h, `qop=auth, nc=00000001, cnonce="cn0nce", opaque="xyz"`) {
		t.Fatalf("%s", h)
	}
	// RFC 2069 style: no qop.
	h2 := digestAuthorization(challenge{realm: "r", nonce: "n"}, "GET", "/f", "u", "p", 1, "c")
	if !strings.Contains(h2, `response="`+md5s(md5s("u:r:p")+":n:"+md5s("GET:/f"))+`"`) || strings.Contains(h2, "qop=") {
		t.Fatalf("%s", h2)
	}
}

// A fake WebDAV server: Basic or Digest, with a 3000-byte file that honours
// Range.
func fakeDav(t *testing.T, mode string) (*httptest.Server, *int) {
	t.Helper()
	body := make([]byte, 3000)
	for i := range body {
		body[i] = byte(i)
	}
	calls := 0
	rsp := regexp.MustCompile(`response="([0-9a-f]+)"`)
	cn := regexp.MustCompile(`cnonce="([^"]+)"`)
	ncRe := regexp.MustCompile(`nc=([0-9a-f]{8})`)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		a := r.Header.Get("Authorization")
		ok := false
		switch mode {
		case "basic":
			ok = a == "Basic "+base64.StdEncoding.EncodeToString([]byte("tv:secret"))
		case "digest":
			if strings.HasPrefix(a, "Digest ") {
				m, c, n := rsp.FindStringSubmatch(a), cn.FindStringSubmatch(a), ncRe.FindStringSubmatch(a)
				if m != nil && c != nil && n != nil {
					ok = m[1] == md5s(md5s("tv:WebDAV:secret")+":n1:"+n[1]+":"+c[1]+":auth:"+md5s("GET:"+r.URL.RequestURI()))
				}
			}
		case "none":
			ok = true
		}
		if !ok {
			if mode == "digest" {
				w.Header().Set("WWW-Authenticate", `Digest realm="WebDAV", nonce="n1", qop="auth"`)
			} else {
				w.Header().Set("WWW-Authenticate", `Basic realm="dav"`)
			}
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path != "/media/Films/a%20b.mkv" && r.URL.Path != "/media/Films/a b.mkv" {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(w, r, "a b.mkv", time.Time{}, strings.NewReader(string(body)))
	})
	return httptest.NewServer(h), &calls
}

func TestGetAnswersTheChallengeOnceAndRemembersIt(t *testing.T) {
	for _, mode := range []string{"basic", "digest", "none"} {
		srv, calls := fakeDav(t, mode)
		c := NewClient(Server{ID: "x", URL: srv.URL + "/media/", User: "tv", Pass: "secret"})
		resp, err := c.Get(context.Background(), "/Films/a b.mkv", "bytes=1000-1999")
		if err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
		got, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusPartialContent || len(got) != 1000 || got[0] != byte(1000%256) || resp.Header.Get("Content-Range") != "bytes 1000-1999/3000" {
			t.Fatalf("%s: status %d, %d bytes, range %q", mode, resp.StatusCode, len(got), resp.Header.Get("Content-Range"))
		}
		want := 2
		if mode == "none" {
			want = 1
		}
		if *calls != want {
			t.Fatalf("%s: %d requests, want %d", mode, *calls, want)
		}
		// The next request carries the scheme straight away.
		resp, err = c.Get(context.Background(), "/Films/a b.mkv", "")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || *calls != want+1 {
			t.Fatalf("%s: second get status %d after %d requests", mode, resp.StatusCode, *calls)
		}
		srv.Close()
	}
}

func TestWrongPasswordIsA401AfterOneRetry(t *testing.T) {
	srv, calls := fakeDav(t, "digest")
	defer srv.Close()
	c := NewClient(Server{ID: "x", URL: srv.URL + "/media/", User: "tv", Pass: "nope"})
	resp, err := c.Get(context.Background(), "/Films/a b.mkv", "")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized || *calls != 2 {
		t.Fatalf("status %d after %d requests", resp.StatusCode, *calls)
	}
}

func TestRegistryReplacesAServerUnderItsId(t *testing.T) {
	r := NewRegistry()
	if err := r.Put(Server{ID: "a", URL: "http://nas/", User: "u", Pass: "p1"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Put(Server{ID: "a", URL: "http://nas/", User: "u", Pass: "p2"}); err != nil {
		t.Fatal(err)
	}
	c, ok := r.Get("a")
	if !ok || c.Server().Pass != "p2" {
		t.Fatalf("%v %+v", ok, c)
	}
	if _, ok := r.Get("b"); ok {
		t.Fatal("unknown id found")
	}
	if err := r.Put(Server{ID: "c", URL: "ftp://nas/"}); err == nil {
		t.Fatal("ftp accepted")
	}
	_ = fmt.Sprint()
}
