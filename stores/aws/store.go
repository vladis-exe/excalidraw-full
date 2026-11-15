package aws

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"excalidraw-complete/core"
	"fmt"
	"io"
	"io/ioutil"
	"log"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/oklog/ulid/v2"
)

type s3Store struct {
	s3Client *s3.Client
	bucket   string
}

// NewStore creates a new S3-based store.
func NewStore(bucketName string) *s3Store {
	cfg, err := config.LoadDefaultConfig(context.TODO())
	if err != nil {
		log.Fatalf("unable to load SDK config, %v", err)
	}

	// R2 and AWS take virtual-hosted URLs; S3-compatible servers like MinIO
	// usually need path-style ones.
	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.UsePathStyle = os.Getenv("S3_FORCE_PATH_STYLE") == "true"
	})

	return &s3Store{
		s3Client: s3Client,
		bucket:   bucketName,
	}
}

// DocumentStore implementation for anonymous sharing
func (s *s3Store) FindID(ctx context.Context, id string) (*core.Document, error) {
	resp, err := s.s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(id),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to get document with id %s: %v", id, err)
	}
	defer resp.Body.Close()

	data, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read document data: %v", err)
	}

	document := core.Document{
		Data: *bytes.NewBuffer(data),
	}

	return &document, nil
}

func (s *s3Store) Create(ctx context.Context, document *core.Document) (string, error) {
	id := ulid.Make().String()

	_, err := s.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(id),
		Body:   bytes.NewReader(document.Data.Bytes()),
	})
	if err != nil {
		return "", fmt.Errorf("failed to upload document: %v", err)
	}

	return id, nil
}

// CanvasStore implementation for user-owned canvases
func (s *s3Store) getCanvasKey(userID, canvasID string) (string, error) {
	// Sanitize canvasID to prevent path traversal attacks.
	// It should be a simple name, not a path.
	if path.Base(canvasID) != canvasID {
		return "", fmt.Errorf("invalid canvas id: must not be a path")
	}
	if canvasID == "" || canvasID == "." || canvasID == ".." {
		return "", fmt.Errorf("invalid canvas id: must not be empty or a dot directory")
	}
	return path.Join(userID, canvasID), nil
}

func (s *s3Store) List(ctx context.Context, userID string) ([]*core.Canvas, error) {
	prefix := userID + "/"
	var objects []s3types.Object
	paginator := s3.NewListObjectsV2Paginator(s.s3Client, &s3.ListObjectsV2Input{
		Bucket: aws.String(s.bucket),
		Prefix: aws.String(prefix),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("failed to list canvases for user %s: %v", userID, err)
		}
		objects = append(objects, page.Contents...)
	}

	canvases := make([]*core.Canvas, 0, len(objects))
	for _, object := range objects {
		resp, err := s.s3Client.GetObject(ctx, &s3.GetObjectInput{
			Bucket: aws.String(s.bucket),
			Key:    object.Key,
		})
		if err != nil {
			log.Printf("warn: failed to get object %s: %v", *object.Key, err)
			continue
		}
		data, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			log.Printf("warn: failed to read object body %s: %v", *object.Key, err)
			continue
		}

		var canvas core.Canvas
		if err := json.Unmarshal(data, &canvas); err != nil {
			log.Printf("warn: failed to unmarshal canvas %s: %v", *object.Key, err)
			continue
		}

		// For list view, we don't need the full data blob.
		canvas.Data = nil
		canvases = append(canvases, &canvas)
	}

	return canvases, nil
}

func (s *s3Store) Get(ctx context.Context, userID, id string) (*core.Canvas, error) {
	key, err := s.getCanvasKey(userID, id)
	if err != nil {
		return nil, err
	}
	resp, err := s.s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		// A specific check for NoSuchKey can be useful here.
		var nsk *s3types.NoSuchKey
		if errors.As(err, &nsk) {
			return nil, fmt.Errorf("canvas not found")
		}
		return nil, fmt.Errorf("failed to get canvas %s: %v", id, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read canvas data: %v", err)
	}

	var canvas core.Canvas
	if err := json.Unmarshal(data, &canvas); err != nil {
		return nil, fmt.Errorf("failed to unmarshal canvas data: %v", err)
	}

	return &canvas, nil
}

func (s *s3Store) Save(ctx context.Context, canvas *core.Canvas) error {
	key, err := s.getCanvasKey(canvas.UserID, canvas.ID)
	if err != nil {
		return err
	}

	// Preserve CreatedAt on update
	if canvas.CreatedAt.IsZero() {
		existing, err := s.Get(ctx, canvas.UserID, canvas.ID)
		if err == nil && existing != nil {
			canvas.CreatedAt = existing.CreatedAt
		} else {
			canvas.CreatedAt = time.Now()
		}
	}
	if canvas.UpdatedAt.IsZero() {
		canvas.UpdatedAt = time.Now()
	}

	data, err := json.Marshal(canvas)
	if err != nil {
		return fmt.Errorf("failed to marshal canvas: %v", err)
	}

	_, err = s.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
		Body:   bytes.NewReader(data),
	})
	if err != nil {
		return fmt.Errorf("failed to save canvas %s: %v", canvas.ID, err)
	}
	return nil
}

func (s *s3Store) Delete(ctx context.Context, userID, id string) error {
	key, err := s.getCanvasKey(userID, id)
	if err != nil {
		return err
	}
	_, err = s.s3Client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("failed to delete canvas %s: %v", id, err)
	}
	return nil
}

// FolderStore implementation. The tree lives outside the user's canvas
// prefix so List never mistakes it for a canvas.
func (s *s3Store) getFoldersKey(userID string) string {
	return path.Join("_folders", userID+".json")
}

func (s *s3Store) GetFolders(ctx context.Context, userID string) ([]*core.Folder, error) {
	resp, err := s.s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(s.getFoldersKey(userID)),
	})
	if err != nil {
		var nsk *s3types.NoSuchKey
		if errors.As(err, &nsk) {
			return []*core.Folder{}, nil
		}
		return nil, fmt.Errorf("failed to get folders for user %s: %v", userID, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read folders: %v", err)
	}
	folders := []*core.Folder{}
	if err := json.Unmarshal(data, &folders); err != nil {
		return nil, fmt.Errorf("failed to unmarshal folders: %v", err)
	}
	return folders, nil
}

func (s *s3Store) SaveFolders(ctx context.Context, userID string, folders []*core.Folder) error {
	data, err := json.Marshal(folders)
	if err != nil {
		return fmt.Errorf("failed to marshal folders: %v", err)
	}
	_, err = s.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(s.getFoldersKey(userID)),
		Body:   bytes.NewReader(data),
	})
	if err != nil {
		return fmt.Errorf("failed to save folders for user %s: %v", userID, err)
	}
	return nil
}

// VersionStore implementation. Versions live outside the canvas prefix so
// List never reads them as canvases; each is the full canvas JSON, keyed by
// the time it was saved (unix ms) so keys sort chronologically.
var versionIDPattern = regexp.MustCompile(`^[0-9]{1,16}$`)

func (s *s3Store) versionPrefix(userID, canvasID string) (string, error) {
	if userID == "" {
		return "", fmt.Errorf("versions need a user id")
	}
	if _, err := s.getCanvasKey(userID, canvasID); err != nil {
		return "", err
	}
	return path.Join("_versions", userID, canvasID) + "/", nil
}

func (s *s3Store) listVersionKeys(ctx context.Context, prefix string) ([]string, error) {
	var keys []string
	paginator := s3.NewListObjectsV2Paginator(s.s3Client, &s3.ListObjectsV2Input{
		Bucket: aws.String(s.bucket),
		Prefix: aws.String(prefix),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, object := range page.Contents {
			keys = append(keys, *object.Key)
		}
	}
	// same-length unix-ms names sort chronologically as strings
	sort.Strings(keys)
	return keys, nil
}

func (s *s3Store) SaveVersion(ctx context.Context, canvas *core.Canvas, keep int) error {
	prefix, err := s.versionPrefix(canvas.UserID, canvas.ID)
	if err != nil {
		return err
	}
	savedAt := canvas.UpdatedAt
	if savedAt.IsZero() {
		savedAt = time.Now()
	}
	data, err := json.Marshal(canvas)
	if err != nil {
		return fmt.Errorf("failed to marshal version: %v", err)
	}
	_, err = s.s3Client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(fmt.Sprintf("%s%013d.json", prefix, savedAt.UnixMilli())),
		Body:   bytes.NewReader(data),
	})
	if err != nil {
		return fmt.Errorf("failed to save version of %s: %v", canvas.ID, err)
	}

	keys, err := s.listVersionKeys(ctx, prefix)
	if err != nil {
		return fmt.Errorf("failed to list versions of %s: %v", canvas.ID, err)
	}
	for i := 0; i < len(keys)-keep; i++ {
		if _, err := s.s3Client.DeleteObject(ctx, &s3.DeleteObjectInput{
			Bucket: aws.String(s.bucket),
			Key:    aws.String(keys[i]),
		}); err != nil {
			log.Printf("warn: failed to prune version %s: %v", keys[i], err)
		}
	}
	return nil
}

func (s *s3Store) ListVersions(ctx context.Context, userID, canvasID string) ([]*core.CanvasVersion, error) {
	prefix, err := s.versionPrefix(userID, canvasID)
	if err != nil {
		return nil, err
	}
	keys, err := s.listVersionKeys(ctx, prefix)
	if err != nil {
		return nil, fmt.Errorf("failed to list versions of %s: %v", canvasID, err)
	}
	versions := make([]*core.CanvasVersion, 0, len(keys))
	for i := len(keys) - 1; i >= 0; i-- {
		id := strings.TrimSuffix(strings.TrimPrefix(keys[i], prefix), ".json")
		ms, err := strconv.ParseInt(id, 10, 64)
		if err != nil {
			continue
		}
		versions = append(versions, &core.CanvasVersion{ID: id, SavedAt: time.UnixMilli(ms).UTC()})
	}
	return versions, nil
}

func (s *s3Store) GetVersion(ctx context.Context, userID, canvasID, versionID string) (*core.Canvas, error) {
	prefix, err := s.versionPrefix(userID, canvasID)
	if err != nil {
		return nil, err
	}
	if !versionIDPattern.MatchString(versionID) {
		return nil, fmt.Errorf("invalid version id")
	}
	resp, err := s.s3Client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(prefix + versionID + ".json"),
	})
	if err != nil {
		return nil, fmt.Errorf("version not found")
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read version: %v", err)
	}
	var canvas core.Canvas
	if err := json.Unmarshal(data, &canvas); err != nil {
		return nil, fmt.Errorf("failed to unmarshal version: %v", err)
	}
	return &canvas, nil
}

func (s *s3Store) DeleteVersions(ctx context.Context, userID, canvasID string) error {
	prefix, err := s.versionPrefix(userID, canvasID)
	if err != nil {
		return err
	}
	keys, err := s.listVersionKeys(ctx, prefix)
	if err != nil {
		return err
	}
	for _, key := range keys {
		if _, err := s.s3Client.DeleteObject(ctx, &s3.DeleteObjectInput{
			Bucket: aws.String(s.bucket),
			Key:    aws.String(key),
		}); err != nil {
			return fmt.Errorf("failed to delete version %s: %v", key, err)
		}
	}
	return nil
}
