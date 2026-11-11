package folders

import (
	"excalidraw-complete/core"
	"testing"
)

func TestValidateTree(t *testing.T) {
	tests := []struct {
		name    string
		folders []*core.Folder
		wantErr bool
	}{
		{"empty", nil, false},
		{"nested", []*core.Folder{
			{ID: "a", Name: "Work"},
			{ID: "b", Name: "Client", ParentID: "a"},
			{ID: "c", Name: "Diagrams", ParentID: "b"},
		}, false},
		{"missing id", []*core.Folder{{Name: "x"}}, true},
		{"blank name", []*core.Folder{{ID: "a", Name: "  "}}, true},
		{"duplicate id", []*core.Folder{{ID: "a", Name: "x"}, {ID: "a", Name: "y"}}, true},
		{"unknown parent", []*core.Folder{{ID: "a", Name: "x", ParentID: "zzz"}}, true},
		{"self parent", []*core.Folder{{ID: "a", Name: "x", ParentID: "a"}}, true},
		{"cycle", []*core.Folder{
			{ID: "a", Name: "x", ParentID: "b"},
			{ID: "b", Name: "y", ParentID: "a"},
		}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateTree(tt.folders)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateTree() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
