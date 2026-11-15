package kv

import (
	"context"
	"encoding/json"
	"excalidraw-complete/handlers/auth"
	"excalidraw-complete/middleware"
	"excalidraw-complete/stores/memory"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
)

func call(t *testing.T, h http.HandlerFunc, method, target, body string, params map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	claims := &auth.AppClaims{RegisteredClaims: jwt.RegisteredClaims{Subject: "tester"}}
	ctx = context.WithValue(ctx, middleware.ClaimsContextKey, claims)
	rec := httptest.NewRecorder()
	h(rec, req.WithContext(ctx))
	return rec
}

func TestTrashAndVersions(t *testing.T) {
	store := memory.NewStore()
	key := map[string]string{"key": "c1"}
	save := func(name, query string) {
		rec := call(t, HandleSaveCanvas(store), http.MethodPut, "/api/v2/kv/c1"+query,
			`{"elements":[],"appState":{"name":"`+name+`"},"files":{}}`, key)
		if rec.Code != http.StatusOK {
			t.Fatalf("save %s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
	versions := func() []map[string]any {
		rec := call(t, HandleListVersions(store), http.MethodGet, "/", "", key)
		var list []map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &list)
		return list
	}

	save("v1", "")
	if n := len(versions()); n != 0 {
		t.Fatalf("a new canvas has no earlier versions, got %d", n)
	}
	save("v2", "") // first save after creation snapshots v1
	save("v3", "") // within the interval: no new snapshot
	if n := len(versions()); n != 1 {
		t.Fatalf("expected 1 version after rapid saves, got %d", n)
	}
	save("v4", "?snapshot=1") // forced: snapshots v3
	list := versions()
	if len(list) != 2 {
		t.Fatalf("expected 2 versions, got %d", len(list))
	}
	rec := call(t, HandleGetVersion(store), http.MethodGet, "/", "", map[string]string{"key": "c1", "version": list[0]["id"].(string)})
	if !strings.Contains(rec.Body.String(), `"v3"`) {
		t.Fatalf("newest version should hold v3, got %s", rec.Body.String())
	}

	trash := func(trashed bool) {
		body := `{"trashed":false}`
		if trashed {
			body = `{"trashed":true}`
		}
		if rec := call(t, HandleUpdateCanvasMeta(store), http.MethodPatch, "/", body, key); rec.Code != http.StatusOK {
			t.Fatalf("patch: %d %s", rec.Code, rec.Body.String())
		}
	}
	deletedAt := func() any {
		rec := call(t, HandleListCanvases(store), http.MethodGet, "/", "", nil)
		var canvases []map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &canvases)
		return canvases[0]["deletedAt"]
	}
	trash(true)
	if deletedAt() == nil {
		t.Fatal("trashed canvas should have deletedAt")
	}
	save("v5", "") // autosave of a trashed canvas keeps it in the trash
	if deletedAt() == nil {
		t.Fatal("saving must not take a canvas out of the trash")
	}
	trash(false)
	if deletedAt() != nil {
		t.Fatal("restored canvas should have no deletedAt")
	}

	if rec := call(t, HandleDeleteCanvas(store), http.MethodDelete, "/", "", key); rec.Code != http.StatusOK {
		t.Fatalf("delete: %d", rec.Code)
	}
	if n := len(versions()); n != 0 {
		t.Fatalf("deleting a canvas forever should remove its versions, got %d", n)
	}
}
