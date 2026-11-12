import { useState, useCallback, useEffect, useMemo } from "react";

import { CaptureUpdateAction } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { AuthError } from "../data/storageAdapters/BackendStorageAdapter";
import {
  canvasToBlob,
  downloadBlob,
  EXPORT_FORMATS,
  parseImportFile,
  sanitizeFileName,
  zipFiles,
} from "../data/fileTransfer";
import { randomUUID } from "../data/random";

import { useAtom, currentCanvasIdAtom } from "../app-jotai";

import type { ExportFormat, ImportEntry } from "../data/fileTransfer";
import type {
  IStorageAdapter,
  CanvasMetadata,
  CanvasData,
  FolderMetadata,
} from "../data/storage";

/** Items picked in the file manager. */
export type Selection = { canvasIds: string[]; folderIds: string[] };

/** Progress of a long-running import or export. */
export type BulkProgress = { label: string; done: number; total: number };

/** A pending "are you sure?" question, answered via `resolve`. */
export type ConfirmRequest = {
  title: string;
  description: string;
  actionLabel: string;
  resolve: (confirmed: boolean) => void;
};

const describeError = (error: unknown, action: string) =>
  error instanceof AuthError
    ? `You need to be logged in to ${action}.`
    : `Could not ${action}.`;

/** folder id → its ancestors' ids, nearest first */
const getAncestorIds = (
  folderId: string | null | undefined,
  byId: Map<string, FolderMetadata>,
) => {
  const ancestors: string[] = [];
  for (
    let current = folderId ? byId.get(folderId) : undefined;
    current?.parentId;
    current = byId.get(current.parentId)
  ) {
    ancestors.push(current.parentId);
  }
  return ancestors;
};

export const useCanvasManagement = ({
  storageAdapter,
  excalidrawAPI,
  setErrorMessage,
  resetSaveStatus,
}: {
  storageAdapter: IStorageAdapter;
  excalidrawAPI: ExcalidrawImperativeAPI | null | undefined;
  setErrorMessage: (msg: string) => void;
  resetSaveStatus: () => void;
}) => {
  const [canvases, setCanvases] = useState<CanvasMetadata[]>([]);
  const [folders, setFolders] = useState<FolderMetadata[]>([]);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(
    null,
  );
  const [currentCanvasId, setCurrentCanvasId] = useAtom(currentCanvasIdAtom);

  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );

  const refreshCanvases = useCallback(async () => {
    try {
      const [canvases, folders] = await Promise.all([
        storageAdapter.listCanvases(),
        storageAdapter.listFolders(),
      ]);
      setCanvases(canvases);
      setFolders(folders);
    } catch (error) {
      console.error(error);
      setErrorMessage("Could not list your creations.");
    }
  }, [storageAdapter, setErrorMessage]);

  useEffect(() => {
    refreshCanvases();
  }, [refreshCanvases]);

  /** Asks the user through the file manager's own confirmation dialog. */
  const confirm = useCallback(
    (request: Omit<ConfirmRequest, "resolve">) =>
      new Promise<boolean>((resolve) =>
        setConfirmRequest({
          ...request,
          resolve: (confirmed) => {
            setConfirmRequest(null);
            resolve(confirmed);
          },
        }),
      ),
    [],
  );

  const toast = useCallback(
    (message: string) => excalidrawAPI?.setToast({ message, duration: 4000 }),
    [excalidrawAPI],
  );

  const commitFolders = useCallback(
    async (next: FolderMetadata[]) => {
      await storageAdapter.saveFolders(next);
      setFolders(next);
    },
    [storageAdapter],
  );

  /** the folder and all folders nested in it */
  const getSubtreeIds = useCallback(
    (folderId: string) => {
      const ids = new Set([folderId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const folder of folders) {
          if (
            folder.parentId &&
            ids.has(folder.parentId) &&
            !ids.has(folder.id)
          ) {
            ids.add(folder.id);
            grew = true;
          }
        }
      }
      return ids;
    },
    [folders],
  );

  /** "Work/Client" for a folder id, "" for the root */
  const getFolderPath = useCallback(
    (folderId: string | null | undefined) => {
      if (!folderId || !folderById.has(folderId)) {
        return "";
      }
      return [...getAncestorIds(folderId, folderById).reverse(), folderId]
        .map((id) => folderById.get(id)?.name ?? "")
        .join("/");
    },
    [folderById],
  );

  // ---------------------------------------------------------------------------
  // canvases
  // ---------------------------------------------------------------------------

  const handleCanvasSelect = useCallback(
    async (id: string) => {
      if (!excalidrawAPI) {
        return;
      }
      try {
        const canvasData = await storageAdapter.loadCanvas(id);
        if (canvasData) {
          excalidrawAPI.updateScene({ appState: { openSidebar: null } });
          excalidrawAPI.addFiles(Object.values(canvasData.files));
          excalidrawAPI.updateScene({
            elements: canvasData.elements,
            // the theme is an app-wide preference, not part of a drawing
            appState: {
              ...canvasData.appState,
              theme: excalidrawAPI.getAppState().theme,
            },
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          setCurrentCanvasId(id);
          resetSaveStatus();
        }
      } catch (error) {
        setErrorMessage("Could not load the canvas.");
      }
    },
    [
      storageAdapter,
      excalidrawAPI,
      setErrorMessage,
      setCurrentCanvasId,
      resetSaveStatus,
    ],
  );

  const deleteCanvasesUnconfirmed = useCallback(
    async (ids: readonly string[]) => {
      for (const id of ids) {
        await storageAdapter.deleteCanvas(id);
      }
      if (currentCanvasId && ids.includes(currentCanvasId)) {
        setCurrentCanvasId(null);
        excalidrawAPI?.resetScene();
        resetSaveStatus();
      }
    },
    [
      storageAdapter,
      currentCanvasId,
      setCurrentCanvasId,
      excalidrawAPI,
      resetSaveStatus,
    ],
  );

  const handleCanvasDelete = useCallback(
    async (id: string) => {
      const name = canvases.find((canvas) => canvas.id === id)?.name;
      const confirmed = await confirm({
        title: "Delete drawing",
        description: `"${name ?? "This drawing"}" will be deleted permanently.`,
        actionLabel: "Delete",
      });
      if (!confirmed) {
        return;
      }
      try {
        await deleteCanvasesUnconfirmed([id]);
      } catch (error) {
        setErrorMessage(describeError(error, "delete the canvas"));
      }
      await refreshCanvases();
    },
    [
      canvases,
      confirm,
      deleteCanvasesUnconfirmed,
      refreshCanvases,
      setErrorMessage,
    ],
  );

  const handleCanvasCreate = useCallback(
    async (newName: string, folderId: string | null = null) => {
      if (!excalidrawAPI) {
        return;
      }
      try {
        const appState = { ...excalidrawAPI.getAppState(), name: newName };
        const newCanvasData = {
          elements: [],
          appState,
          files: {},
        };
        const createdCanvas = await storageAdapter.createCanvas(
          newCanvasData as CanvasData,
          folderId,
        );
        await refreshCanvases();
        excalidrawAPI.resetScene();
        excalidrawAPI.updateScene({ appState: { name: newName } });
        setCurrentCanvasId(createdCanvas.id);
      } catch (error) {
        setErrorMessage(describeError(error, "create a new canvas"));
      }
    },
    [
      excalidrawAPI,
      storageAdapter,
      refreshCanvases,
      setErrorMessage,
      setCurrentCanvasId,
    ],
  );

  const handleCanvasRename = useCallback(
    async (id: string, newName: string) => {
      try {
        await storageAdapter.renameCanvas(id, newName);
        await refreshCanvases();
        if (excalidrawAPI && currentCanvasId === id) {
          excalidrawAPI.updateScene({ appState: { name: newName } });
        }
      } catch (error) {
        setErrorMessage(describeError(error, "rename the canvas"));
      }
    },
    [
      storageAdapter,
      refreshCanvases,
      setErrorMessage,
      excalidrawAPI,
      currentCanvasId,
    ],
  );

  const handleCanvasSaveAs = useCallback(
    async (newName: string) => {
      if (!excalidrawAPI) {
        return;
      }
      try {
        const appState = { ...excalidrawAPI.getAppState(), name: newName };
        const elements = excalidrawAPI.getSceneElements();
        const files = excalidrawAPI.getFiles();

        const newCanvasData = {
          elements,
          appState,
          files,
        };
        // keep the copy next to the original
        const folderId =
          canvases.find((canvas) => canvas.id === currentCanvasId)?.folderId ??
          null;
        const createdCanvas = await storageAdapter.createCanvas(
          newCanvasData as CanvasData,
          folderId,
        );
        await refreshCanvases();
        // After saving as, we should switch to the new canvas
        setCurrentCanvasId(createdCanvas.id);
      } catch (error) {
        setErrorMessage(describeError(error, "save as a new canvas"));
      }
    },
    [
      excalidrawAPI,
      storageAdapter,
      refreshCanvases,
      setErrorMessage,
      setCurrentCanvasId,
      canvases,
      currentCanvasId,
    ],
  );

  /** the open canvas reflects unsaved edits, so read it from the editor */
  const loadCanvasData = useCallback(
    async (id: string): Promise<CanvasData | null> => {
      if (excalidrawAPI && id === currentCanvasId) {
        return {
          elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
          appState: excalidrawAPI.getAppState(),
          files: excalidrawAPI.getFiles(),
        };
      }
      return storageAdapter.loadCanvas(id);
    },
    [excalidrawAPI, currentCanvasId, storageAdapter],
  );

  const handleCanvasDuplicate = useCallback(
    async (id: string) => {
      const original = canvases.find((canvas) => canvas.id === id);
      try {
        const data = await loadCanvasData(id);
        if (!data || !original) {
          throw new Error("canvas not found");
        }
        await storageAdapter.createCanvas(
          {
            ...data,
            appState: { ...data.appState, name: `${original.name} (copy)` },
            thumbnail: undefined,
          },
          original.folderId ?? null,
        );
        await refreshCanvases();
        toast(`Duplicated "${original.name}"`);
      } catch (error) {
        setErrorMessage(describeError(error, "duplicate the canvas"));
      }
    },
    [
      canvases,
      loadCanvasData,
      storageAdapter,
      refreshCanvases,
      toast,
      setErrorMessage,
    ],
  );

  // ---------------------------------------------------------------------------
  // folders
  // ---------------------------------------------------------------------------

  const handleFolderCreate = useCallback(
    async (name: string, parentId: string | null) => {
      const now = new Date().toISOString();
      const folder: FolderMetadata = {
        id: randomUUID(),
        name: name.trim(),
        parentId,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await commitFolders([...folders, folder]);
        return folder;
      } catch (error) {
        setErrorMessage(describeError(error, "create the folder"));
        return null;
      }
    },
    [folders, commitFolders, setErrorMessage],
  );

  const handleFolderRename = useCallback(
    async (id: string, name: string) => {
      const now = new Date().toISOString();
      try {
        await commitFolders(
          folders.map((folder) =>
            folder.id === id
              ? { ...folder, name: name.trim(), updatedAt: now }
              : folder,
          ),
        );
      } catch (error) {
        setErrorMessage(describeError(error, "rename the folder"));
      }
    },
    [folders, commitFolders, setErrorMessage],
  );

  /**
   * Deletes folders without losing work: their contents (drawings and
   * subfolders) move up into the deleted folder's parent.
   */
  const handleFoldersDelete = useCallback(
    async (ids: readonly string[]) => {
      const deleted = new Set(ids);
      const names = ids.map((id) => folderById.get(id)?.name).filter(Boolean);
      const survivingParent = (folderId: string | null | undefined) => {
        let parent = folderId ?? null;
        while (parent && deleted.has(parent)) {
          parent = folderById.get(parent)?.parentId ?? null;
        }
        return parent;
      };
      const affectedCanvases = canvases.filter(
        (canvas) => canvas.folderId && deleted.has(canvas.folderId),
      );
      const affectedFolders = folders.filter(
        (folder) =>
          !deleted.has(folder.id) &&
          folder.parentId &&
          deleted.has(folder.parentId),
      );
      const contents = [
        affectedCanvases.length &&
          `${affectedCanvases.length} drawing${
            affectedCanvases.length === 1 ? "" : "s"
          }`,
        affectedFolders.length &&
          `${affectedFolders.length} folder${
            affectedFolders.length === 1 ? "" : "s"
          }`,
      ]
        .filter(Boolean)
        .join(" and ");

      const confirmed = await confirm({
        title: ids.length === 1 ? "Delete folder" : "Delete folders",
        description: `${names
          .map((name) => `"${name}"`)
          .join(", ")} will be removed.${
          contents
            ? ` Nothing inside is deleted: its ${contents} move up one level.`
            : ""
        }`,
        actionLabel: "Delete",
      });
      if (!confirmed) {
        return;
      }

      try {
        for (const canvas of affectedCanvases) {
          await storageAdapter.moveCanvas(
            canvas.id,
            survivingParent(canvas.folderId),
          );
        }
        await commitFolders(
          folders
            .filter((folder) => !deleted.has(folder.id))
            .map((folder) =>
              folder.parentId && deleted.has(folder.parentId)
                ? { ...folder, parentId: survivingParent(folder.parentId) }
                : folder,
            ),
        );
      } catch (error) {
        setErrorMessage(describeError(error, "delete the folder"));
      }
      await refreshCanvases();
    },
    [
      confirm,
      folderById,
      canvases,
      folders,
      storageAdapter,
      commitFolders,
      refreshCanvases,
      setErrorMessage,
    ],
  );

  // ---------------------------------------------------------------------------
  // bulk operations
  // ---------------------------------------------------------------------------

  /** Whether `selection` can be moved into `targetFolderId`. */
  const canMoveInto = useCallback(
    (selection: Selection, targetFolderId: string | null) =>
      !targetFolderId ||
      !selection.folderIds.some((id) => getSubtreeIds(id).has(targetFolderId)),
    [getSubtreeIds],
  );

  const handleMove = useCallback(
    async (selection: Selection, targetFolderId: string | null) => {
      if (!canMoveInto(selection, targetFolderId)) {
        setErrorMessage("A folder can't be moved into itself.");
        return;
      }
      try {
        for (const id of selection.canvasIds) {
          const canvas = canvases.find((c) => c.id === id);
          if ((canvas?.folderId ?? null) !== targetFolderId) {
            await storageAdapter.moveCanvas(id, targetFolderId);
          }
        }
        if (selection.folderIds.length) {
          const moving = new Set(selection.folderIds);
          await commitFolders(
            folders.map((folder) =>
              moving.has(folder.id)
                ? { ...folder, parentId: targetFolderId }
                : folder,
            ),
          );
        }
        const count = selection.canvasIds.length + selection.folderIds.length;
        toast(
          `Moved ${count} item${count === 1 ? "" : "s"} to ${
            getFolderPath(targetFolderId) || "All drawings"
          }`,
        );
      } catch (error) {
        setErrorMessage(describeError(error, "move the items"));
      }
      await refreshCanvases();
    },
    [
      canMoveInto,
      canvases,
      folders,
      storageAdapter,
      commitFolders,
      refreshCanvases,
      getFolderPath,
      toast,
      setErrorMessage,
    ],
  );

  /** Deletes drawings, and folders the same way handleFoldersDelete does. */
  const handleBulkDelete = useCallback(
    async (selection: Selection) => {
      if (selection.folderIds.length) {
        // folder deletion has its own confirmation and keeps contents
        await handleFoldersDelete(selection.folderIds);
      }
      if (!selection.canvasIds.length) {
        return;
      }
      const confirmed = await confirm({
        title: "Delete drawings",
        description: `${selection.canvasIds.length} drawing(s) will be deleted permanently.`,
        actionLabel: "Delete",
      });
      if (!confirmed) {
        return;
      }
      try {
        await deleteCanvasesUnconfirmed(selection.canvasIds);
      } catch (error) {
        setErrorMessage(describeError(error, "delete the drawings"));
      }
      await refreshCanvases();
    },
    [
      confirm,
      handleFoldersDelete,
      deleteCanvasesUnconfirmed,
      refreshCanvases,
      setErrorMessage,
    ],
  );

  /**
   * A single drawing downloads as one file; anything more (several drawings or
   * folders) downloads as a zip that keeps the folder structure.
   */
  const handleExport = useCallback(
    async (selection: Selection, format: ExportFormat) => {
      const { extension } = EXPORT_FORMATS.find((f) => f.format === format)!;

      // canvas id → path inside the zip, relative to the selected folders
      const paths = new Map<string, string>();
      for (const id of selection.canvasIds) {
        paths.set(id, "");
      }
      for (const folderId of selection.folderIds) {
        const base = getFolderPath(folderId);
        const prefixLength =
          base.length - (folderById.get(folderId)?.name.length ?? 0);
        const subtree = getSubtreeIds(folderId);
        for (const canvas of canvases) {
          if (canvas.folderId && subtree.has(canvas.folderId)) {
            paths.set(
              canvas.id,
              getFolderPath(canvas.folderId).slice(prefixLength),
            );
          }
        }
      }
      if (!paths.size) {
        setErrorMessage("There are no drawings to export.");
        return;
      }

      const files: { path: string; blob: Blob }[] = [];
      const failed: string[] = [];
      setProgress({ label: "Exporting", done: 0, total: paths.size });
      for (const [id, folderPath] of paths) {
        const canvas = canvases.find((c) => c.id === id);
        const name = sanitizeFileName(canvas?.name ?? "Untitled");
        try {
          const data = await loadCanvasData(id);
          if (!data) {
            throw new Error("canvas not found");
          }
          const blob = await canvasToBlob(data, format);
          const fileName = `${name}.${extension}`;
          files.push({
            path: folderPath
              ? `${folderPath
                  .split("/")
                  .map(sanitizeFileName)
                  .join("/")}/${fileName}`
              : fileName,
            blob,
          });
        } catch (error) {
          console.error(error);
          failed.push(canvas?.name ?? id);
        }
        setProgress((p) => p && { ...p, done: p.done + 1 });
      }

      try {
        if (files.length === 1 && !selection.folderIds.length) {
          downloadBlob(files[0].blob, files[0].path);
        } else if (files.length) {
          const zipName =
            selection.folderIds.length === 1 && !selection.canvasIds.length
              ? folderById.get(selection.folderIds[0])?.name ?? "drawings"
              : "drawings";
          downloadBlob(
            await zipFiles(files),
            `${sanitizeFileName(zipName)}.zip`,
          );
        }
      } finally {
        setProgress(null);
      }

      if (failed.length) {
        setErrorMessage(
          `Could not export ${failed.length} drawing(s): ${failed.join(
            ", ",
          )}. Empty drawings can only be exported as Excalidraw files.`,
        );
      } else {
        toast(
          `Exported ${files.length} drawing${files.length === 1 ? "" : "s"}`,
        );
      }
    },
    [
      canvases,
      folderById,
      getFolderPath,
      getSubtreeIds,
      loadCanvasData,
      setErrorMessage,
      toast,
    ],
  );

  /**
   * Imports files into `targetFolderId`, recreating their folder structure.
   * Folders with the same name in the same place are reused, not duplicated.
   *
   * @returns whether every file was imported
   */
  const handleImport = useCallback(
    async (entries: ImportEntry[], targetFolderId: string | null) => {
      if (!entries.length) {
        return true;
      }
      const now = new Date().toISOString();
      const nextFolders = [...folders];
      let createdFolders = 0;
      const resolveFolder = (path: string[]) => {
        let parentId = targetFolderId;
        for (const name of path) {
          const currentParentId = parentId;
          const existing = nextFolders.find(
            (folder) =>
              (folder.parentId ?? null) === currentParentId &&
              folder.name === name,
          );
          if (existing) {
            parentId = existing.id;
            continue;
          }
          const folder: FolderMetadata = {
            id: randomUUID(),
            name,
            parentId,
            createdAt: now,
            updatedAt: now,
          };
          nextFolders.push(folder);
          createdFolders++;
          parentId = folder.id;
        }
        return parentId;
      };

      setProgress({ label: "Importing", done: 0, total: entries.length });
      let imported = 0;
      const skipped: string[] = [];
      try {
        const parsed: { data: CanvasData; folderPath: string[] }[] = [];
        for (const entry of entries) {
          const data = await parseImportFile(entry.file);
          if (data) {
            parsed.push({ data, folderPath: entry.folderPath });
          } else {
            skipped.push(entry.file.name);
            setProgress((p) => p && { ...p, done: p.done + 1 });
          }
        }
        // resolve folders up front so the tree is saved once, before any
        // canvas points into it
        const targets = parsed.map(({ folderPath }) =>
          resolveFolder(folderPath),
        );
        if (createdFolders) {
          await commitFolders(nextFolders);
        }
        for (let i = 0; i < parsed.length; i++) {
          try {
            await storageAdapter.createCanvas(parsed[i].data, targets[i]);
            imported++;
          } catch (error) {
            console.error(error);
            skipped.push(parsed[i].data.appState.name || "Untitled");
          }
          setProgress((p) => p && { ...p, done: p.done + 1 });
        }
      } catch (error) {
        setErrorMessage(describeError(error, "import the files"));
        setProgress(null);
        await refreshCanvases();
        return false;
      }
      setProgress(null);
      await refreshCanvases();

      const summary = `Imported ${imported} drawing${
        imported === 1 ? "" : "s"
      }${
        createdFolders
          ? ` and ${createdFolders} folder${createdFolders === 1 ? "" : "s"}`
          : ""
      }`;
      if (skipped.length) {
        excalidrawAPI?.setToast({
          message: `${summary}. Skipped ${skipped.length} file${
            skipped.length === 1 ? "" : "s"
          } that ${
            skipped.length === 1 ? "isn't an" : "aren't"
          } Excalidraw drawing${skipped.length === 1 ? "" : "s"}: ${skipped
            .slice(0, 10)
            .join(", ")}${skipped.length > 10 ? ", …" : ""}`,
          closable: true,
          duration: Infinity,
        });
      } else {
        toast(summary);
      }
      return skipped.length === 0;
    },
    [
      excalidrawAPI,
      folders,
      commitFolders,
      storageAdapter,
      refreshCanvases,
      setErrorMessage,
      toast,
    ],
  );

  return {
    canvases,
    folders,
    progress,
    confirmRequest,
    currentCanvasId,
    handleCanvasSelect,
    handleCanvasDelete,
    handleCanvasCreate,
    handleCanvasRename,
    handleCanvasSaveAs,
    handleCanvasDuplicate,
    handleFolderCreate,
    handleFolderRename,
    handleFoldersDelete,
    handleMove,
    handleBulkDelete,
    handleExport,
    handleImport,
    canMoveInto,
    getFolderPath,
    refreshCanvases,
  };
};
