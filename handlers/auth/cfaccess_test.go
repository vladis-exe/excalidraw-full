package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// fakeAccess serves a JWKS like <team>.cloudflareaccess.com/cdn-cgi/access/certs
func fakeAccess(t *testing.T, key *rsa.PrivateKey) *httptest.Server {
	t.Helper()
	jwks := map[string]any{"keys": []map[string]string{{
		"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "test-key",
		"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
	}}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/cdn-cgi/access/certs" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(jwks)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func sign(t *testing.T, key *rsa.PrivateKey, claims jwt.MapClaims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = "test-key"
	s, err := token.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestLocalLogin(t *testing.T) {
	jwtSecret = []byte("test-secret")
	localLoginEmail = "me@example.com"
	t.Cleanup(func() { localLoginEmail = "" })

	rec := httptest.NewRecorder()
	HandleAccessLogin(rec, httptest.NewRequest(http.MethodGet, "/auth/access", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	var body struct{ Token string }
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	claims, err := ParseJWT(body.Token)
	if err != nil || claims.Subject != "me@example.com" {
		t.Fatalf("claims = %+v, err = %v", claims, err)
	}
}

func TestHandleAccessLogin(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	otherKey, _ := rsa.GenerateKey(rand.Reader, 2048)
	srv := fakeAccess(t, key)

	const aud = "test-aud"
	jwtSecret = []byte("test-secret")
	cfAccessVerifier = newCloudflareAccessVerifier(srv.URL, aud)
	t.Cleanup(func() { cfAccessVerifier = nil })

	valid := jwt.MapClaims{
		"iss": srv.URL, "aud": aud, "email": "Someone@Example.com",
		"sub": "123", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(),
	}
	with := func(changes jwt.MapClaims) jwt.MapClaims {
		c := jwt.MapClaims{}
		for k, v := range valid {
			c[k] = v
		}
		for k, v := range changes {
			c[k] = v
		}
		return c
	}

	tests := []struct {
		name      string
		assertion string
		wantCode  int
	}{
		{"valid", sign(t, key, valid), http.StatusOK},
		{"missing header", "", http.StatusUnauthorized},
		{"wrong audience", sign(t, key, with(jwt.MapClaims{"aud": "other-app"})), http.StatusUnauthorized},
		{"wrong issuer", sign(t, key, with(jwt.MapClaims{"iss": "https://evil.example"})), http.StatusUnauthorized},
		{"expired", sign(t, key, with(jwt.MapClaims{"exp": time.Now().Add(-time.Hour).Unix()})), http.StatusUnauthorized},
		{"signed by another key", sign(t, otherKey, valid), http.StatusUnauthorized},
		{"no email", sign(t, key, with(jwt.MapClaims{"email": ""})), http.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/auth/access", nil)
			if tt.assertion != "" {
				req.Header.Set(cfAccessHeader, tt.assertion)
			}
			rec := httptest.NewRecorder()
			HandleAccessLogin(rec, req)
			if rec.Code != tt.wantCode {
				t.Fatalf("status = %d, want %d (%s)", rec.Code, tt.wantCode, rec.Body.String())
			}
			if tt.wantCode != http.StatusOK {
				return
			}
			var body struct{ Token string }
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.Token == "" {
				t.Fatalf("no token in response: %s", rec.Body.String())
			}
			// the Login button flow hands over the same session via redirect
			redirectRec := httptest.NewRecorder()
			HandleAccessRedirectLogin(redirectRec, req)
			if redirectRec.Code != http.StatusFound ||
				!strings.HasPrefix(redirectRec.Header().Get("Location"), "/?token=") {
				t.Fatalf("login redirect = %d %q", redirectRec.Code, redirectRec.Header().Get("Location"))
			}

			claims, err := ParseJWT(body.Token)
			if err != nil {
				t.Fatalf("issued token doesn't parse: %v", err)
			}
			if claims.Subject != "someone@example.com" || claims.Name != "someone" {
				t.Fatalf("unexpected claims: subject=%q name=%q", claims.Subject, claims.Name)
			}
		})
	}
}
