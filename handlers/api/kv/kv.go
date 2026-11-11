package kv

import (
	"encoding/json"
	"excalidraw-complete/core"
	"excalidraw-complete/handlers/auth"
	"excalidraw-complete/middleware"
	"excalidraw-complete/stores"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/render"
	"github.com/sirupsen/logrus"
)

func HandleListCanvases(store stores.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := r.Context().Value(middleware.ClaimsContextKey).(*auth.AppClaims)
		if !ok {
			render.Status(r, http.StatusUnauthorized)
			render.JSON(w, r, map[string]string{"error": "User claims not found"})
			return
		}

		canvases, err := store.List(r.Context(), claims.Subject)
		if err != nil {
			logrus.WithFields(logrus.Fields{
				"error":  err,
				"userID": claims.Subject,
			}).Error("Failed to list canvases")
			render.Status(r, http.StatusInternalServerError)
			render.JSON(w, r, map[string]string{"error": "Failed to list canvases"})
			return
		}

		// If canvases is nil (e.g., user has no canvases), return an empty slice instead of null.
		if canvases == nil {
			canvases = []*core.Canvas{}
		}

		render.JSON(w, r, canvases)
	}
}

func HandleGetCanvas(store stores.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := r.Context().Value(middleware.ClaimsContextKey).(*auth.AppClaims)
		if !ok {
			render.Status(r, http.StatusUnauthorized)
			render.JSON(w, r, map[string]string{"error": "User claims not found"})
			return
		}

		key := chi.URLParam(r, "key")
		if key == "" {
			render.Status(r, http.StatusBadRequest)
			render.JSON(w, r, map[string]string{"error": "Canvas key is required"})
			return
		}

		canvas, err := store.Get(r.Context(), claims.Subject, key)
		if err != nil {
			logrus.WithFields(logrus.Fields{
				"error":  err,
				"userID": claims.Subject,
				"key":    key,
			}).Warn("Failed to get canvas")
			// This could be a not found error or a real server error.
			// For simplicity, we'll return 404, but in a real app, you might want to distinguish.
			render.Status(r, http.StatusNotFound)
			render.JSON(w, r, map[string]string{"error": "Canvas not found"})
			return
		}

		// The canvas data is returned as raw bytes.
		w.Header().Set("Content-Type", "application/json")
		w.Write(canvas.Data)
	}
}

func HandleSaveCanvas(store stores.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := r.Context().Value(middleware.ClaimsContextKey).(*auth.AppClaims)
		if !ok {
			render.Status(r, http.StatusUnauthorized)
			render.JSON(w, r, map[string]string{"error": "User claims not found"})
			return
		}

		key := chi.URLParam(r, "key")
		if key == "" {
			render.Status(r, http.StatusBadRequest)
			render.JSON(w, r, map[string]string{"error": "Canvas key is required"})
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			logrus.WithFields(logrus.Fields{
				"error": err,
				"key":   key,
			}).Error("Failed to read request body")
			render.Status(r, http.StatusInternalServerError)
			render.JSON(w, r, map[string]string{"error": "Failed to read request body"})
			return
		}
		defer r.Body.Close()

		// For simplicity, we use the key as the name. A more advanced implementation
		// might parse a name from the body or have a separate field.
		var canvasData struct {
			AppState struct {
				Name string `json:"name"`
			} `json:"appState"`
			Thumbnail string `json:"thumbnail"`
			// Only set by clients that place the canvas in a folder on
			// create; plain saves leave it out and keep the current folder.
			FolderID *string `json:"folderId"`
		}
		// We make a copy of the body because json.Unmarshal will consume the reader.
		bodyCopy := make([]byte, len(body))
		copy(bodyCopy, body)

		canvasName := key // Default to key
		var canvasThumbnail string
		if err := json.Unmarshal(bodyCopy, &canvasData); err == nil {
			if canvasData.AppState.Name != "" {
				canvasName = canvasData.AppState.Name
			}
			canvasThumbnail = canvasData.Thumbnail
		}

		canvas := &core.Canvas{
			ID:        key,
			UserID:    claims.Subject,
			Name:      canvasName,
			Thumbnail: canvasThumbnail,
			Data:      body,
		}
		if existing, err := store.Get(r.Context(), claims.Subject, key); err == nil {
			canvas.CreatedAt = existing.CreatedAt
			canvas.FolderID = existing.FolderID
		}
		if canvasData.FolderID != nil {
			canvas.FolderID = *canvasData.FolderID
		}

		if err := store.Save(r.Context(), canvas); err != nil {
			logrus.WithFields(logrus.Fields{
				"error":  err,
				"userID": claims.Subject,
				"key":    key,
			}).Error("Failed to save canvas")
			render.Status(r, http.StatusInternalServerError)
			render.JSON(w, r, map[string]string{"error": "Failed to save canvas"})
			return
		}

		render.Status(r, http.StatusOK)
	}
}

func HandleDeleteCanvas(store stores.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := r.Context().Value(middleware.ClaimsContextKey).(*auth.AppClaims)
		if !ok {
			render.Status(r, http.StatusUnauthorized)
			render.JSON(w, r, map[string]string{"error": "User claims not found"})
			return
		}

		key := chi.URLParam(r, "key")
		if key == "" {
			render.Status(r, http.StatusBadRequest)
			render.JSON(w, r, map[string]string{"error": "Canvas key is required"})
			return
		}

		if err := store.Delete(r.Context(), claims.Subject, key); err != nil {
			logrus.WithFields(logrus.Fields{
				"error":  err,
				"userID": claims.Subject,
				"key":    key,
			}).Error("Failed to delete canvas")
			render.Status(r, http.StatusInternalServerError)
			render.JSON(w, r, map[string]string{"error": "Failed to delete canvas"})
			return
		}

		render.Status(r, http.StatusOK)
	}
}

// HandleUpdateCanvasMeta changes a canvas's metadata (currently its folder)
// without the client re-uploading the canvas data.
func HandleUpdateCanvasMeta(store stores.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := r.Context().Value(middleware.ClaimsContextKey).(*auth.AppClaims)
		if !ok {
			render.Status(r, http.StatusUnauthorized)
			render.JSON(w, r, map[string]string{"error": "User claims not found"})
			return
		}

		key := chi.URLParam(r, "key")
		var patch struct {
			// nil leaves the folder unchanged, "" moves to the root.
			FolderID *string `json:"folderId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
			render.Status(r, http.StatusBadRequest)
			render.JSON(w, r, map[string]string{"error": "Invalid request body"})
			return
		}

		canvas, err := store.Get(r.Context(), claims.Subject, key)
		if err != nil {
			render.Status(r, http.StatusNotFound)
			render.JSON(w, r, map[string]string{"error": "Canvas not found"})
			return
		}
		canvas.UserID = claims.Subject
		if patch.FolderID != nil {
			canvas.FolderID = *patch.FolderID
		}

		if err := store.Save(r.Context(), canvas); err != nil {
			logrus.WithFields(logrus.Fields{
				"error":  err,
				"userID": claims.Subject,
				"key":    key,
			}).Error("Failed to update canvas metadata")
			render.Status(r, http.StatusInternalServerError)
			render.JSON(w, r, map[string]string{"error": "Failed to update canvas"})
			return
		}

		render.Status(r, http.StatusOK)
	}
}
