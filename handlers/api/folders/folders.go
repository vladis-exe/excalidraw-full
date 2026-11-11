package folders

import (
	"encoding/json"
	"excalidraw-complete/core"
	"excalidraw-complete/handlers/auth"
	"excalidraw-complete/middleware"
	"excalidraw-complete/stores"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/render"
	"github.com/sirupsen/logrus"
)

const (
	maxFolders       = 10000
	maxFolderNameLen = 200
)

func HandleGetFolders(store stores.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := r.Context().Value(middleware.ClaimsContextKey).(*auth.AppClaims)
		if !ok {
			render.Status(r, http.StatusUnauthorized)
			render.JSON(w, r, map[string]string{"error": "User claims not found"})
			return
		}

		folders, err := store.GetFolders(r.Context(), claims.Subject)
		if err != nil {
			logrus.WithFields(logrus.Fields{
				"error":  err,
				"userID": claims.Subject,
			}).Error("Failed to get folders")
			render.Status(r, http.StatusInternalServerError)
			render.JSON(w, r, map[string]string{"error": "Failed to get folders"})
			return
		}
		render.JSON(w, r, folders)
	}
}

// HandleSaveFolders replaces the user's whole folder tree after checking it
// is a valid tree.
func HandleSaveFolders(store stores.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := r.Context().Value(middleware.ClaimsContextKey).(*auth.AppClaims)
		if !ok {
			render.Status(r, http.StatusUnauthorized)
			render.JSON(w, r, map[string]string{"error": "User claims not found"})
			return
		}

		var folders []*core.Folder
		if err := json.NewDecoder(r.Body).Decode(&folders); err != nil {
			render.Status(r, http.StatusBadRequest)
			render.JSON(w, r, map[string]string{"error": "Invalid request body"})
			return
		}
		if err := validateTree(folders); err != nil {
			render.Status(r, http.StatusBadRequest)
			render.JSON(w, r, map[string]string{"error": err.Error()})
			return
		}

		now := time.Now()
		for _, f := range folders {
			if f.CreatedAt.IsZero() {
				f.CreatedAt = now
			}
			if f.UpdatedAt.IsZero() {
				f.UpdatedAt = now
			}
		}

		if err := store.SaveFolders(r.Context(), claims.Subject, folders); err != nil {
			logrus.WithFields(logrus.Fields{
				"error":  err,
				"userID": claims.Subject,
			}).Error("Failed to save folders")
			render.Status(r, http.StatusInternalServerError)
			render.JSON(w, r, map[string]string{"error": "Failed to save folders"})
			return
		}
		render.JSON(w, r, folders)
	}
}

func validateTree(folders []*core.Folder) error {
	if len(folders) > maxFolders {
		return fmt.Errorf("too many folders (max %d)", maxFolders)
	}
	byID := make(map[string]*core.Folder, len(folders))
	for _, f := range folders {
		if f == nil || f.ID == "" {
			return fmt.Errorf("every folder needs an id")
		}
		if _, dup := byID[f.ID]; dup {
			return fmt.Errorf("duplicate folder id %q", f.ID)
		}
		f.Name = strings.TrimSpace(f.Name)
		if f.Name == "" || len(f.Name) > maxFolderNameLen {
			return fmt.Errorf("folder %q needs a name of 1-%d characters", f.ID, maxFolderNameLen)
		}
		byID[f.ID] = f
	}
	for _, f := range folders {
		seen := map[string]bool{f.ID: true}
		for parent := f.ParentID; parent != ""; {
			p, ok := byID[parent]
			if !ok {
				return fmt.Errorf("folder %q has unknown parent %q", f.ID, parent)
			}
			if seen[parent] {
				return fmt.Errorf("folder %q is inside itself", f.ID)
			}
			seen[parent] = true
			parent = p.ParentID
		}
	}
	return nil
}
