package sqlite

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"excalidraw-complete/core"
	"fmt"
	"log"
	"time"

	"github.com/oklog/ulid/v2"
	"github.com/sirupsen/logrus"
	_ "modernc.org/sqlite"
)

type sqliteStore struct {
	db *sql.DB
}

// NewStore creates a new SQLite-based store.
func NewStore(dataSourceName string) *sqliteStore {
	db, err := sql.Open("sqlite", dataSourceName)
	if err != nil {
		log.Fatalf("failed to open sqlite database: %v", err)
	}

	// Initialize table for anonymous documents
	docTableStmt := `CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, data BLOB);`
	if _, err = db.Exec(docTableStmt); err != nil {
		log.Fatalf("failed to create documents table: %v", err)
	}

	// Initialize table for user-owned canvases
	canvasTableStmt := `
	CREATE TABLE IF NOT EXISTS canvases (
		id TEXT NOT NULL,
		user_id TEXT NOT NULL,
		name TEXT,
		thumbnail TEXT,
		data BLOB,
		created_at DATETIME,
		updated_at DATETIME,
		PRIMARY KEY (user_id, id)
	);`
	if _, err = db.Exec(canvasTableStmt); err != nil {
		log.Fatalf("failed to create canvases table: %v", err)
	}

	// Databases created before folders existed lack the column.
	if !hasColumn(db, "canvases", "folder_id") {
		if _, err = db.Exec(`ALTER TABLE canvases ADD COLUMN folder_id TEXT NOT NULL DEFAULT ''`); err != nil {
			log.Fatalf("failed to add folder_id column: %v", err)
		}
	}

	folderTableStmt := `CREATE TABLE IF NOT EXISTS folders (user_id TEXT PRIMARY KEY, data BLOB);`
	if _, err = db.Exec(folderTableStmt); err != nil {
		log.Fatalf("failed to create folders table: %v", err)
	}

	return &sqliteStore{db}
}

// DocumentStore implementation
func (s *sqliteStore) FindID(ctx context.Context, id string) (*core.Document, error) {
	log := logrus.WithField("document_id", id)
	log.Debug("Retrieving document by ID")
	var data []byte
	err := s.db.QueryRowContext(ctx, "SELECT data FROM documents WHERE id = ?", id).Scan(&data)
	if err != nil {
		if err == sql.ErrNoRows {
			log.WithField("error", "document not found").Warn("Document with specified ID not found")
			return nil, fmt.Errorf("document with id %s not found", id)
		}
		log.WithError(err).Error("Failed to retrieve document")
		return nil, err
	}
	document := core.Document{
		Data: *bytes.NewBuffer(data),
	}
	log.Info("Document retrieved successfully")
	return &document, nil
}

func (s *sqliteStore) Create(ctx context.Context, document *core.Document) (string, error) {
	id := ulid.Make().String()
	data := document.Data.Bytes()
	log := logrus.WithFields(logrus.Fields{
		"document_id": id,
		"data_length": len(data),
	})

	_, err := s.db.ExecContext(ctx, "INSERT INTO documents (id, data) VALUES (?, ?)", id, data)
	if err != nil {
		log.WithError(err).Error("Failed to create document")
		return "", err
	}
	log.Info("Document created successfully")
	return id, nil
}

// CanvasStore implementation
func (s *sqliteStore) List(ctx context.Context, userID string) ([]*core.Canvas, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id, name, created_at, updated_at, thumbnail, folder_id FROM canvases WHERE user_id = ?", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var canvases []*core.Canvas
	for rows.Next() {
		var canvas core.Canvas
		canvas.UserID = userID
		if err := rows.Scan(&canvas.ID, &canvas.Name, &canvas.CreatedAt, &canvas.UpdatedAt, &canvas.Thumbnail, &canvas.FolderID); err != nil {
			return nil, err
		}
		canvases = append(canvases, &canvas)
	}
	return canvases, nil
}

func (s *sqliteStore) Get(ctx context.Context, userID, id string) (*core.Canvas, error) {
	var canvas core.Canvas
	canvas.UserID = userID
	canvas.ID = id
	err := s.db.QueryRowContext(ctx, "SELECT name, data, created_at, updated_at, thumbnail, folder_id FROM canvases WHERE user_id = ? AND id = ?", userID, id).Scan(&canvas.Name, &canvas.Data, &canvas.CreatedAt, &canvas.UpdatedAt, &canvas.Thumbnail, &canvas.FolderID)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("canvas not found")
		}
		return nil, err
	}
	return &canvas, nil
}

func (s *sqliteStore) Save(ctx context.Context, canvas *core.Canvas) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // Rollback on any error

	var exists bool
	err = tx.QueryRowContext(ctx, "SELECT 1 FROM canvases WHERE user_id = ? AND id = ?", canvas.UserID, canvas.ID).Scan(&exists)

	now := time.Now()
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	updatedAt := now
	if !canvas.UpdatedAt.IsZero() {
		updatedAt = canvas.UpdatedAt
	}

	if exists {
		// Update
		_, err = tx.ExecContext(ctx, "UPDATE canvases SET name = ?, data = ?, updated_at = ?, thumbnail = ?, folder_id = ? WHERE user_id = ? AND id = ?", canvas.Name, canvas.Data, updatedAt, canvas.Thumbnail, canvas.FolderID, canvas.UserID, canvas.ID)
	} else {
		// Insert
		_, err = tx.ExecContext(ctx, "INSERT INTO canvases (id, user_id, name, data, created_at, updated_at, thumbnail, folder_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", canvas.ID, canvas.UserID, canvas.Name, canvas.Data, now, now, canvas.Thumbnail, canvas.FolderID)
	}

	if err != nil {
		return err
	}

	return tx.Commit()
}

func (s *sqliteStore) Delete(ctx context.Context, userID, id string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM canvases WHERE user_id = ? AND id = ?", userID, id)
	return err
}

func hasColumn(db *sql.DB, table, column string) bool {
	rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		log.Fatalf("failed to inspect table %s: %v", table, err)
	}
	defer rows.Close()
	for rows.Next() {
		var (
			cid, notNull, pk int
			name, colType    string
			defaultValue     sql.NullString
		)
		if err := rows.Scan(&cid, &name, &colType, &notNull, &defaultValue, &pk); err != nil {
			log.Fatalf("failed to scan table info for %s: %v", table, err)
		}
		if name == column {
			return true
		}
	}
	return false
}

// FolderStore implementation
func (s *sqliteStore) GetFolders(ctx context.Context, userID string) ([]*core.Folder, error) {
	var data []byte
	err := s.db.QueryRowContext(ctx, "SELECT data FROM folders WHERE user_id = ?", userID).Scan(&data)
	if err == sql.ErrNoRows {
		return []*core.Folder{}, nil
	}
	if err != nil {
		return nil, err
	}
	folders := []*core.Folder{}
	if err := json.Unmarshal(data, &folders); err != nil {
		return nil, fmt.Errorf("failed to unmarshal folders: %v", err)
	}
	return folders, nil
}

func (s *sqliteStore) SaveFolders(ctx context.Context, userID string, folders []*core.Folder) error {
	data, err := json.Marshal(folders)
	if err != nil {
		return fmt.Errorf("failed to marshal folders: %v", err)
	}
	_, err = s.db.ExecContext(ctx, "INSERT INTO folders (user_id, data) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data", userID, data)
	return err
}
