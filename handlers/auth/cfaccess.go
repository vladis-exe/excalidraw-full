package auth

import (
	"context"
	"excalidraw-complete/core"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-chi/render"
	"github.com/sirupsen/logrus"
)

// Cloudflare Access sits in front of the app and attaches a signed JWT to
// every request it lets through (Cf-Access-Jwt-Assertion). Verifying it lets
// users who already passed Access log in without a second sign-in.
//
// Enabled when both are set:
//   - CF_ACCESS_TEAM_DOMAIN: https://<team>.cloudflareaccess.com
//   - CF_ACCESS_AUD: the Application Audience (AUD) tag of the Access app
var cfAccessVerifier *oidc.IDTokenVerifier

const cfAccessHeader = "Cf-Access-Jwt-Assertion"

type cfAccessClaims struct {
	Email string `json:"email"`
}

func cloudflareAccessConfigured() bool {
	return os.Getenv("CF_ACCESS_TEAM_DOMAIN") != "" && os.Getenv("CF_ACCESS_AUD") != ""
}

func initCloudflareAccess() {
	teamDomain := strings.TrimRight(os.Getenv("CF_ACCESS_TEAM_DOMAIN"), "/")
	aud := os.Getenv("CF_ACCESS_AUD")
	if teamDomain == "" || aud == "" {
		return
	}
	logrus.Info("Cloudflare Access login enabled.")
	cfAccessVerifier = newCloudflareAccessVerifier(teamDomain, aud)
}

func newCloudflareAccessVerifier(teamDomain, aud string) *oidc.IDTokenVerifier {
	keySet := oidc.NewRemoteKeySet(context.Background(), teamDomain+"/cdn-cgi/access/certs")
	return oidc.NewVerifier(teamDomain, keySet, &oidc.Config{ClientID: aud})
}

// sessionFromAccess turns the request's Cloudflare Access assertion into an
// app session token.
func sessionFromAccess(r *http.Request) (string, int, string) {
	assertion := r.Header.Get(cfAccessHeader)
	if cfAccessVerifier == nil || assertion == "" || len(jwtSecret) == 0 {
		return "", http.StatusUnauthorized, "Cloudflare Access login not available"
	}

	idToken, err := cfAccessVerifier.Verify(r.Context(), assertion)
	if err != nil {
		logrus.WithError(err).Warn("Rejected Cloudflare Access assertion")
		return "", http.StatusUnauthorized, "Invalid Cloudflare Access assertion"
	}

	var claims cfAccessClaims
	if err := idToken.Claims(&claims); err != nil || claims.Email == "" {
		return "", http.StatusUnauthorized, "Cloudflare Access assertion has no email"
	}

	email := strings.ToLower(claims.Email)
	name := email
	if at := strings.IndexByte(email, '@'); at > 0 {
		name = email[:at]
	}
	// the email is the stable identity: Access may issue a different `sub`
	// per identity provider
	token, err := createJWT(&core.User{
		Subject: email,
		Login:   email,
		Email:   email,
		Name:    name,
	})
	if err != nil {
		return "", http.StatusInternalServerError, "Failed to create session"
	}
	return token, http.StatusOK, ""
}

// HandleAccessLogin exchanges a valid Cloudflare Access assertion for an app
// session token. Without Access configured, or without a valid assertion, it
// answers 401 and the client stays logged out.
func HandleAccessLogin(w http.ResponseWriter, r *http.Request) {
	token, status, message := sessionFromAccess(r)
	if token == "" {
		render.Status(r, status)
		render.JSON(w, r, map[string]string{"error": message})
		return
	}
	render.JSON(w, r, map[string]string{"token": token})
}

// HandleAccessRedirectLogin backs the app's Login button. Access guards
// /auth, so by the time a browser gets here the user has signed in through
// Cloudflare; hand the session to the app the same way the OAuth providers do.
func HandleAccessRedirectLogin(w http.ResponseWriter, r *http.Request) {
	token, status, message := sessionFromAccess(r)
	if token == "" {
		http.Error(w, message, status)
		return
	}
	http.Redirect(w, r, "/?token="+url.QueryEscape(token), http.StatusFound)
}
