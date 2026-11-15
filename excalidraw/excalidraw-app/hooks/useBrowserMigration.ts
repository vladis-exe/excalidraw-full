import { serializeAsJSON } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useState } from "react";

import { BackendStorageAdapter } from "../data/storageAdapters/BackendStorageAdapter";
import { IndexedDBStorageAdapter } from "../data/storageAdapters/IndexedDBStorageAdapter";
import { sanitizeFileName } from "../data/fileTransfer";

import type { ImportEntry } from "../data/fileTransfer";
import type { FolderMetadata, IStorageAdapter } from "../data/storage";

/** browser canvases already copied to the server, so they aren't offered again */
const MIGRATED_KEY = "excalidraw-migrated-canvas-ids";

const readMigrated = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(MIGRATED_KEY) || "[]"));
  } catch {
    return new Set();
  }
};

const folderPath = (
  folderId: string | null | undefined,
  byId: Map<string, FolderMetadata>,
) => {
  const path: string[] = [];
  for (
    let folder = folderId ? byId.get(folderId) : undefined;
    folder;
    folder = folder.parentId ? byId.get(folder.parentId) : undefined
  ) {
    path.unshift(folder.name);
  }
  return path;
};

/**
 * When saving to the server, offers to copy drawings that so far only exist in
 * this browser (IndexedDB). Copies are made through the regular import, so the
 * folder structure is kept; the browser copies are left untouched.
 */
export const useBrowserMigration = (
  storageAdapter: IStorageAdapter,
  importEntries: (
    entries: ImportEntry[],
    folderId: string | null,
  ) => Promise<boolean>,
) => {
  const [pendingCount, setPendingCount] = useState(0);
  const isServer = storageAdapter instanceof BackendStorageAdapter;

  const loadPending = useCallback(async () => {
    const local = new IndexedDBStorageAdapter();
    const migrated = readMigrated();
    const canvases = (await local.listCanvases()).filter(
      (canvas) => !migrated.has(canvas.id),
    );
    return { local, canvases };
  }, []);

  useEffect(() => {
    if (!isServer) {
      setPendingCount(0);
      return;
    }
    loadPending()
      .then(({ canvases }) => setPendingCount(canvases.length))
      .catch(() => setPendingCount(0));
  }, [isServer, loadPending]);

  const migrate = useCallback(async () => {
    const { local, canvases } = await loadPending();
    const byId = new Map(
      (await local.listFolders()).map((folder) => [folder.id, folder]),
    );
    const entries: ImportEntry[] = [];
    for (const canvas of canvases) {
      const data = await local.loadCanvas(canvas.id);
      if (!data) {
        continue;
      }
      entries.push({
        file: new File(
          [serializeAsJSON(data.elements, data.appState, data.files, "local")],
          `${sanitizeFileName(canvas.name)}.excalidraw`,
        ),
        folderPath: folderPath(canvas.folderId, byId),
      });
    }
    if (await importEntries(entries, null)) {
      const migrated = readMigrated();
      canvases.forEach((canvas) => migrated.add(canvas.id));
      try {
        localStorage.setItem(MIGRATED_KEY, JSON.stringify([...migrated]));
      } catch {
        // the banner just comes back next time
      }
      setPendingCount(0);
    }
  }, [loadPending, importEntries]);

  return isServer && pendingCount > 0
    ? { count: pendingCount, onMigrate: migrate }
    : null;
};
