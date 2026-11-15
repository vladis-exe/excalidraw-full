package core

import (
	"context"
	"time"
)

type (
	// Canvas represents the metadata and content of a user-saved drawing.
	Canvas struct {
		ID        string `json:"id"`
		UserID    string `json:"-"` // Not exposed in JSON responses, used internally.
		Name      string `json:"name"`
		Thumbnail string `json:"thumbnail,omitempty"`
		// FolderID is the folder the canvas lives in; empty means the root.
		FolderID string `json:"folderId,omitempty"`
		// DeletedAt is set while the canvas is in the trash.
		DeletedAt *time.Time `json:"deletedAt,omitempty"`
		// VersionedAt is when the last version snapshot was taken; used to
		// space snapshots out instead of keeping one per autosave.
		VersionedAt *time.Time `json:"versionedAt,omitempty"`
		Data        []byte     `json:"data,omitempty"` // The full canvas data, not included in list views.
		CreatedAt   time.Time  `json:"createdAt"`
		UpdatedAt   time.Time  `json:"updatedAt"`
	}

	// CanvasStore defines the persistence layer for user-owned canvases.
	// All operations are scoped to a specific user.
	CanvasStore interface {
		// List returns metadata for all canvases owned by a user.
		// The returned Canvas objects should not contain the `Data` field to keep the response light.
		List(ctx context.Context, userID string) ([]*Canvas, error)

		// Get returns a single canvas by its ID, ensuring it belongs to the user.
		Get(ctx context.Context, userID, id string) (*Canvas, error)

		// Save creates or updates a canvas for a user.
		Save(ctx context.Context, canvas *Canvas) error

		// Delete removes a canvas, ensuring it belongs to the user.
		Delete(ctx context.Context, userID, id string) error
	}

	// Folder is a node in a user's folder tree. Canvases point at folders via
	// Canvas.FolderID; folders point at their parent via ParentID (empty for
	// top-level folders).
	Folder struct {
		ID        string    `json:"id"`
		Name      string    `json:"name"`
		ParentID  string    `json:"parentId,omitempty"`
		CreatedAt time.Time `json:"createdAt"`
		UpdatedAt time.Time `json:"updatedAt"`
	}

	// CanvasVersion describes an earlier state of a canvas.
	CanvasVersion struct {
		ID      string    `json:"id"`
		SavedAt time.Time `json:"savedAt"`
	}

	// VersionStore keeps earlier states of canvases. It's optional: stores
	// without it simply have no version history.
	VersionStore interface {
		// SaveVersion stores the given canvas as a version, keeping at most
		// `keep` versions per canvas (oldest are removed).
		SaveVersion(ctx context.Context, canvas *Canvas, keep int) error

		// ListVersions returns a canvas's versions, newest first.
		ListVersions(ctx context.Context, userID, canvasID string) ([]*CanvasVersion, error)

		// GetVersion returns one version of a canvas, with its data.
		GetVersion(ctx context.Context, userID, canvasID, versionID string) (*Canvas, error)

		// DeleteVersions removes all versions of a canvas.
		DeleteVersions(ctx context.Context, userID, canvasID string) error
	}

	// FolderStore persists a user's whole folder tree as a single unit. The
	// tree is small and only edited by its owner, so it's read and replaced
	// as a whole instead of per folder.
	FolderStore interface {
		// GetFolders returns the user's folders, or an empty slice if none.
		GetFolders(ctx context.Context, userID string) ([]*Folder, error)

		// SaveFolders replaces the user's folders.
		SaveFolders(ctx context.Context, userID string, folders []*Folder) error
	}
)
