package memory

import (
	"context"
	"excalidraw-complete/core"
	"fmt"
	"sync"
	"time"

	"github.com/oklog/ulid/v2"
	"github.com/sirupsen/logrus"
)

var (
	savedDocuments = make(map[string]core.Document)
	// savedCanvases is a map where the key is userID, and the value is another map
	// where the key is canvasID and the value is the canvas itself.
	savedCanvases = make(map[string]map[string]*core.Canvas)
	savedFolders  = make(map[string][]*core.Folder)
	// userID -> canvasID -> versions, oldest first
	savedVersions = make(map[string]map[string][]*core.Canvas)
	mu            sync.RWMutex
)

// memStore implements both DocumentStore and CanvasStore for in-memory storage.
type memStore struct{}

// NewStore creates a new in-memory store.
func NewStore() *memStore {
	return &memStore{}
}

// FindID retrieves a document by its ID. Part of the DocumentStore interface.
func (s *memStore) FindID(ctx context.Context, id string) (*core.Document, error) {
	mu.RLock()
	defer mu.RUnlock()

	log := logrus.WithField("document_id", id)
	if val, ok := savedDocuments[id]; ok {
		log.Info("Document retrieved successfully")
		return &val, nil
	}
	log.WithField("error", "document not found").Warn("Document with specified ID not found")
	return nil, fmt.Errorf("document with id %s not found", id)
}

// Create stores a new document. Part of the DocumentStore interface.
func (s *memStore) Create(ctx context.Context, document *core.Document) (string, error) {
	mu.Lock()
	defer mu.Unlock()

	id := ulid.Make().String()
	savedDocuments[id] = *document
	log := logrus.WithFields(logrus.Fields{
		"document_id": id,
		"data_length": len(document.Data.Bytes()),
	})
	log.Info("Document created successfully")

	return id, nil
}

// List returns metadata for all canvases owned by a user. Part of the CanvasStore interface.
func (s *memStore) List(ctx context.Context, userID string) ([]*core.Canvas, error) {
	mu.RLock()
	defer mu.RUnlock()

	userCanvases, ok := savedCanvases[userID]
	if !ok {
		return []*core.Canvas{}, nil // No canvases for this user, return empty slice
	}

	canvases := make([]*core.Canvas, 0, len(userCanvases))
	for _, canvas := range userCanvases {
		// Important: create a copy without the large `Data` field for the list view
		listCanvas := &core.Canvas{
			ID:        canvas.ID,
			UserID:    canvas.UserID,
			Name:      canvas.Name,
			Thumbnail: canvas.Thumbnail,
			FolderID:  canvas.FolderID,
			DeletedAt: canvas.DeletedAt,
			CreatedAt: canvas.CreatedAt,
			UpdatedAt: canvas.UpdatedAt,
		}
		canvases = append(canvases, listCanvas)
	}

	logrus.WithField("user_id", userID).Infof("Listed %d canvases", len(canvases))
	return canvases, nil
}

// Get returns a single canvas by its ID, ensuring it belongs to the user. Part of the CanvasStore interface.
func (s *memStore) Get(ctx context.Context, userID, id string) (*core.Canvas, error) {
	mu.RLock()
	defer mu.RUnlock()

	log := logrus.WithFields(logrus.Fields{"user_id": userID, "canvas_id": id})

	userCanvases, ok := savedCanvases[userID]
	if !ok {
		log.Warn("User has no canvases")
		return nil, fmt.Errorf("canvas with id %s not found for user %s", id, userID)
	}

	canvas, ok := userCanvases[id]
	if !ok {
		log.Warn("Canvas not found for user")
		return nil, fmt.Errorf("canvas with id %s not found for user %s", id, userID)
	}

	log.Info("Canvas retrieved successfully")
	// a copy without the owner, like stores that persist JSON (UserID is
	// json:"-"), so callers can't rely on it
	copied := *canvas
	copied.UserID = ""
	return &copied, nil
}

// Save creates or updates a canvas for a user. Part of the CanvasStore interface.
func (s *memStore) Save(ctx context.Context, canvas *core.Canvas) error {
	mu.Lock()
	defer mu.Unlock()

	log := logrus.WithFields(logrus.Fields{"user_id": canvas.UserID, "canvas_id": canvas.ID})

	if canvas.UserID == "" {
		return fmt.Errorf("UserID cannot be empty")
	}

	userCanvases, ok := savedCanvases[canvas.UserID]
	if !ok {
		userCanvases = make(map[string]*core.Canvas)
		savedCanvases[canvas.UserID] = userCanvases
	}

	if canvas.ID == "" {
		return fmt.Errorf("Canvas ID cannot be empty for save operation")
	}

	now := time.Now()
	if existingCanvas, exists := userCanvases[canvas.ID]; exists {
		canvas.CreatedAt = existingCanvas.CreatedAt
		if canvas.UpdatedAt.IsZero() {
			canvas.UpdatedAt = now
		}
	} else {
		canvas.CreatedAt = now
		canvas.UpdatedAt = now
	}

	userCanvases[canvas.ID] = canvas
	log.Info("Canvas saved successfully")
	return nil
}

// Delete removes a canvas, ensuring it belongs to the user. Part of the CanvasStore interface.
func (s *memStore) Delete(ctx context.Context, userID, id string) error {
	mu.Lock()
	defer mu.Unlock()

	log := logrus.WithFields(logrus.Fields{"user_id": userID, "canvas_id": id})

	userCanvases, ok := savedCanvases[userID]
	if !ok {
		log.Warn("User has no canvases to delete from")
		return fmt.Errorf("user %s has no canvases", userID)
	}

	if _, ok := userCanvases[id]; !ok {
		log.Warn("Canvas not found for deletion")
		return fmt.Errorf("canvas with id %s not found for user %s", id, userID)
	}

	delete(userCanvases, id)
	log.Info("Canvas deleted successfully")
	return nil
}

// GetFolders returns the user's folder tree. Part of the FolderStore interface.
func (s *memStore) GetFolders(ctx context.Context, userID string) ([]*core.Folder, error) {
	mu.RLock()
	defer mu.RUnlock()
	folders, ok := savedFolders[userID]
	if !ok {
		return []*core.Folder{}, nil
	}
	return folders, nil
}

// SaveFolders replaces the user's folder tree. Part of the FolderStore interface.
func (s *memStore) SaveFolders(ctx context.Context, userID string, folders []*core.Folder) error {
	mu.Lock()
	defer mu.Unlock()
	savedFolders[userID] = folders
	return nil
}

// SaveVersion stores a copy of the canvas. Part of the VersionStore interface.
func (s *memStore) SaveVersion(ctx context.Context, canvas *core.Canvas, keep int) error {
	mu.Lock()
	defer mu.Unlock()
	if savedVersions[canvas.UserID] == nil {
		savedVersions[canvas.UserID] = make(map[string][]*core.Canvas)
	}
	version := *canvas
	versions := append(savedVersions[canvas.UserID][canvas.ID], &version)
	if len(versions) > keep {
		versions = versions[len(versions)-keep:]
	}
	savedVersions[canvas.UserID][canvas.ID] = versions
	return nil
}

// ListVersions lists a canvas's versions, newest first.
func (s *memStore) ListVersions(ctx context.Context, userID, canvasID string) ([]*core.CanvasVersion, error) {
	mu.RLock()
	defer mu.RUnlock()
	versions := savedVersions[userID][canvasID]
	list := make([]*core.CanvasVersion, 0, len(versions))
	for i := len(versions) - 1; i >= 0; i-- {
		list = append(list, &core.CanvasVersion{ID: versionID(versions[i]), SavedAt: versions[i].UpdatedAt})
	}
	return list, nil
}

// GetVersion returns one version of a canvas.
func (s *memStore) GetVersion(ctx context.Context, userID, canvasID, id string) (*core.Canvas, error) {
	mu.RLock()
	defer mu.RUnlock()
	// newest first: versions saved within the same millisecond share an id
	versions := savedVersions[userID][canvasID]
	for i := len(versions) - 1; i >= 0; i-- {
		if versionID(versions[i]) == id {
			return versions[i], nil
		}
	}
	return nil, fmt.Errorf("version not found")
}

// DeleteVersions removes all versions of a canvas.
func (s *memStore) DeleteVersions(ctx context.Context, userID, canvasID string) error {
	mu.Lock()
	defer mu.Unlock()
	delete(savedVersions[userID], canvasID)
	return nil
}

func versionID(canvas *core.Canvas) string {
	return fmt.Sprintf("%013d", canvas.UpdatedAt.UnixMilli())
}
