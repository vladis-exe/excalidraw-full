package firebase

import (
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/render"
)

type (
	BatchGetRequest struct {
		Documents []string `json:"documents"`
	}
	BatchGetEmptyResponse struct {
		Missing  string `json:"missing"`
		ReadTime string `json:"readTime"`
	}

	FoundInfoResponse struct {
		Name       string      `json:"name"`
		Fields     interface{} `json:"fields"`
		CreateTime string      `json:"createTime"`
		UpdateTime string      `json:"updateTime"`
	}
	BatchGetExistsResponse struct {
		Found    FoundInfoResponse `json:"found"`
		ReadTime string            `json:"readTime"`
	}

	UpdateRequest struct {
		Name   string      `json:"name"`
		Fields interface{} `json:"fields"`
	}
	WriteRequest struct {
		Update UpdateRequest `json:"update"`
	}
	BatchCommitRequest struct {
		Writes []WriteRequest `json:"writes"`
	}

	WriteResult struct {
		UpdateTime string `json:"updateTime"`
	}
	BatchCommitResponse struct {
		WriteResults []WriteResult `json:"writeResults"`
		CommitTime   string        `json:"commitTime"`
	}
)

var (
	savedItems = make(map[string]interface{})
	// handlers run concurrently; unsynchronized map writes crash the process
	savedItemsMu sync.RWMutex
)

func (body *BatchGetRequest) Bind(r *http.Request) (err error) {
	return nil
}
func (body *BatchCommitRequest) Bind(r *http.Request) (err error) {
	return nil
}
func HandleBatchCommit() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		projectId := chi.URLParam(r, "project_id")
		databaseId := chi.URLParam(r, "database_id")
		_ = projectId
		_ = databaseId

		data := &BatchCommitRequest{}
		// Seems like requests is text/plain but content is json ...
		if err := render.DecodeJSON(r.Body, data); err != nil {
			fmt.Println(err)
			render.Status(r, http.StatusBadRequest)
			return
		}

		// read-only transactions (used to load a room) commit without writes
		writeResults := []WriteResult{}
		if len(data.Writes) > 0 {
			savedItemsMu.Lock()
			savedItems[data.Writes[0].Update.Name] = data.Writes[0].Update.Fields
			savedItemsMu.Unlock()
			writeResults = append(writeResults, WriteResult{UpdateTime: time.Now().Format(time.RFC3339)})
		}

		render.JSON(w, r, BatchCommitResponse{
			CommitTime:   time.Now().Format(time.RFC3339),
			WriteResults: writeResults,
		})
		render.Status(r, http.StatusOK)
		return

	}
}

func HandleBatchGet() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {

		projectId := chi.URLParam(r, "project_id")
		databaseId := chi.URLParam(r, "database_id")
		fmt.Printf("Got %v and %v\n", projectId, databaseId)
		data := &BatchGetRequest{}

		// Seems like requests is text/plain but content is json ...
		if err := render.DecodeJSON(r.Body, data); err != nil {
			fmt.Println(err)
			render.Status(r, http.StatusBadRequest)
			return
		}
		if len(data.Documents) == 0 {
			render.Status(r, http.StatusBadRequest)
			return
		}
		key := data.Documents[0]
		fmt.Printf("Got key %v \n", key)

		savedItemsMu.RLock()
		fields, ok := savedItems[key]
		savedItemsMu.RUnlock()

		if !ok {
			fmt.Println("missing key")
			render.JSON(w, r, []BatchGetEmptyResponse{BatchGetEmptyResponse{
				Missing:  key,
				ReadTime: time.Now().Format(time.RFC3339),
			}})
			render.Status(r, http.StatusOK)
			return
		}
		fmt.Println("existing key")
		render.JSON(w, r, []BatchGetExistsResponse{BatchGetExistsResponse{
			Found: FoundInfoResponse{
				Name:       key,
				Fields:     fields,
				CreateTime: time.Now().Format(time.RFC3339),
				UpdateTime: time.Now().Format(time.RFC3339),
			},
			ReadTime: time.Now().Format(time.RFC3339),
		}})
		render.Status(r, http.StatusOK)
		return

	}
}
