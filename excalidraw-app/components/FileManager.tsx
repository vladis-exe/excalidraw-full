import clsx from "clsx";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import ConfirmDialog from "@excalidraw/excalidraw/components/ConfirmDialog";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  chevronRight,
  CloseIcon,
  DotsHorizontalIcon,
  DuplicateIcon,
  ExportIcon,
  LoadIcon,
  pencilIcon,
  PlusIcon,
  searchIcon,
  TrashIcon,
} from "@excalidraw/excalidraw/components/icons";

import {
  entriesFromDataTransfer,
  entriesFromFileList,
  EXPORT_FORMATS,
  IMPORT_ACCEPT,
} from "../data/fileTransfer";
import { timeAgo } from "../utils/time";

import "./FileManager.scss";

import type { ExportFormat, ImportEntry } from "../data/fileTransfer";
import type { CanvasMetadata, FolderMetadata } from "../data/storage";
import type {
  BulkProgress,
  ConfirmRequest,
  Selection,
} from "../hooks/useCanvasManagement";

const folderIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path
      d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.2.6l1.04 1.4h8.38A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"
      strokeLinejoin="round"
    />
  </svg>
);

const moveIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path
      d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.2.6l1.04 1.4h8.38A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"
      strokeLinejoin="round"
    />
    <path
      d="M10 13h5m-2-2 2 2-2 2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** drag payload type for moving items within the file manager */
const DRAG_MIME = "application/x-excalidraw-file-manager";
const CURRENT_FOLDER_KEY = "excalidraw-file-manager-folder";
const SORT_KEY = "excalidraw-file-manager-sort";

type SortMode = "updated" | "name" | "created";
type ItemKey = `c:${string}` | `f:${string}`;

const SORT_LABELS: Record<SortMode, string> = {
  updated: "Last edited",
  name: "Name",
  created: "Date created",
};

const readStorage = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStorage = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {
    // storage unavailable (private mode etc.) — preferences just don't persist
  }
};

const toSelection = (keys: Iterable<ItemKey>): Selection => {
  const selection: Selection = { canvasIds: [], folderIds: [] };
  for (const key of keys) {
    if (key.startsWith("c:")) {
      selection.canvasIds.push(key.slice(2));
    } else {
      selection.folderIds.push(key.slice(2));
    }
  }
  return selection;
};

type PromptState = {
  title: string;
  label: string;
  initialValue: string;
  actionLabel: string;
  onSubmit: (value: string) => void;
} | null;

type MenuState = {
  key: ItemKey | "import" | "bulk-export";
  x: number;
  y: number;
} | null;

export type FileManagerProps = {
  canvases: readonly CanvasMetadata[];
  folders: readonly FolderMetadata[];
  currentCanvasId: string | null;
  progress: BulkProgress | null;
  confirmRequest: ConfirmRequest | null;
  /** where drawings are saved, shown in the footer */
  storageLabel: string;
  /** offered when drawings exist only in this browser */
  migration?: { count: number; onMigrate: () => void } | null;
  onOpen: (id: string) => void;
  onCreateCanvas: (name: string, folderId: string | null) => void;
  onRenameCanvas: (id: string, name: string) => void;
  onDuplicateCanvas: (id: string) => void;
  onCreateFolder: (name: string, parentId: string | null) => void;
  onRenameFolder: (id: string, name: string) => void;
  onMove: (selection: Selection, folderId: string | null) => void;
  onDelete: (selection: Selection) => void;
  onExport: (selection: Selection, format: ExportFormat) => void;
  onImport: (entries: ImportEntry[], folderId: string | null) => void;
  canMoveInto: (selection: Selection, folderId: string | null) => boolean;
  getFolderPath: (folderId: string | null | undefined) => string;
  onRefresh: () => void;
};

export const FileManager: React.FC<FileManagerProps> = (props) => {
  const {
    canvases,
    folders,
    currentCanvasId,
    progress,
    onRefresh,
    getFolderPath,
  } = props;

  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );

  const [currentFolderId, setCurrentFolderIdState] = useState<string | null>(
    () => readStorage(CURRENT_FOLDER_KEY),
  );
  const [query, setQuery] = useState("");
  const [sort, setSortState] = useState<SortMode>(
    () => (readStorage(SORT_KEY) as SortMode | null) ?? "updated",
  );
  const [selected, setSelected] = useState<Set<ItemKey>>(new Set());
  const [prompt, setPrompt] = useState<PromptState>(null);
  const [promptValue, setPromptValue] = useState("");
  const [moveTarget, setMoveTarget] = useState<Selection | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  // a remembered folder may have been deleted meanwhile
  const folderId =
    currentFolderId && folderById.has(currentFolderId) ? currentFolderId : null;

  const setCurrentFolder = useCallback((id: string | null) => {
    setCurrentFolderIdState(id);
    writeStorage(CURRENT_FOLDER_KEY, id);
    setSelected(new Set());
    setQuery("");
  }, []);

  const setSort = (mode: SortMode) => {
    setSortState(mode);
    writeStorage(SORT_KEY, mode);
  };

  useEffect(() => {
    if (!menu) {
      return;
    }
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
    };
  }, [menu]);

  // drop selected keys that no longer exist (after delete/refresh)
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set(
        [...prev].filter((key) =>
          key.startsWith("c:")
            ? canvases.some((c) => c.id === key.slice(2))
            : folderById.has(key.slice(2)),
        ),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [canvases, folderById]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const canvas of canvases) {
      if (canvas.folderId) {
        map.set(canvas.folderId, (map.get(canvas.folderId) ?? 0) + 1);
      }
    }
    for (const folder of folders) {
      if (folder.parentId) {
        map.set(folder.parentId, (map.get(folder.parentId) ?? 0) + 1);
      }
    }
    return map;
  }, [canvases, folders]);

  const compare = useCallback(
    <T extends { name: string; createdAt?: string; updatedAt?: string }>(
      a: T,
      b: T,
    ) => {
      if (sort === "name") {
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      }
      const field = sort === "created" ? "createdAt" : "updatedAt";
      return (
        new Date(b[field] ?? 0).getTime() - new Date(a[field] ?? 0).getTime()
      );
    },
    [sort],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;

  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) =>
          isSearching
            ? folder.name.toLowerCase().includes(normalizedQuery)
            : (folder.parentId ?? null) === folderId,
        )
        // folders always sort by name; dates rarely matter for them
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        ),
    [folders, folderId, isSearching, normalizedQuery],
  );

  const visibleCanvases = useMemo(
    () =>
      canvases
        .filter((canvas) =>
          isSearching
            ? canvas.name.toLowerCase().includes(normalizedQuery)
            : (canvas.folderId && folderById.has(canvas.folderId)
                ? canvas.folderId
                : null) === folderId,
        )
        .sort(compare),
    [canvases, folderById, folderId, isSearching, normalizedQuery, compare],
  );

  const breadcrumbs = useMemo(() => {
    const trail: FolderMetadata[] = [];
    for (
      let current = folderId ? folderById.get(folderId) : undefined;
      current;
      current = current.parentId ? folderById.get(current.parentId) : undefined
    ) {
      trail.unshift(current);
    }
    return trail;
  }, [folderId, folderById]);

  const visibleKeys = useMemo<ItemKey[]>(
    () => [
      ...visibleFolders.map((f) => `f:${f.id}` as const),
      ...visibleCanvases.map((c) => `c:${c.id}` as const),
    ],
    [visibleFolders, visibleCanvases],
  );

  const selection = useMemo(() => toSelection(selected), [selected]);
  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((key) => selected.has(key));

  const toggleSelected = (key: ItemKey) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  // ---------------------------------------------------------------------------
  // dialogs
  // ---------------------------------------------------------------------------

  const openPrompt = (state: NonNullable<PromptState>) => {
    setPromptValue(state.initialValue);
    setPrompt(state);
  };

  const submitPrompt = () => {
    const value = promptValue.trim();
    if (prompt && value) {
      prompt.onSubmit(value);
      setPrompt(null);
    }
  };

  const promptNewCanvas = () =>
    openPrompt({
      title: "New drawing",
      label: "Name",
      initialValue: "Untitled drawing",
      actionLabel: "Create",
      onSubmit: (name) => props.onCreateCanvas(name, folderId),
    });

  const promptNewFolder = () =>
    openPrompt({
      title: "New folder",
      label: "Name",
      initialValue: "New folder",
      actionLabel: "Create",
      onSubmit: (name) => props.onCreateFolder(name, folderId),
    });

  const promptRename = (key: ItemKey) => {
    const id = key.slice(2);
    if (key.startsWith("c:")) {
      const canvas = canvases.find((c) => c.id === id);
      openPrompt({
        title: "Rename drawing",
        label: "Name",
        initialValue: canvas?.name ?? "",
        actionLabel: "Rename",
        onSubmit: (name) => props.onRenameCanvas(id, name),
      });
    } else {
      openPrompt({
        title: "Rename folder",
        label: "Name",
        initialValue: folderById.get(id)?.name ?? "",
        actionLabel: "Rename",
        onSubmit: (name) => props.onRenameFolder(id, name),
      });
    }
  };

  // ---------------------------------------------------------------------------
  // drag & drop
  // ---------------------------------------------------------------------------

  const startDrag = (event: React.DragEvent, key: ItemKey) => {
    // dragging a selected item drags the whole selection
    const keys = selected.has(key) ? [...selected] : [key];
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify(toSelection(keys)));
    event.dataTransfer.effectAllowed = "move";
  };

  const isInternalDrag = (event: React.DragEvent) =>
    event.dataTransfer.types.includes(DRAG_MIME);
  const isFileDrag = (event: React.DragEvent) =>
    event.dataTransfer.types.includes("Files");

  const dropTargetHandlers = (targetFolderId: string | null) => {
    const id = targetFolderId ?? "root";
    return {
      onDragOver: (event: React.DragEvent) => {
        if (isInternalDrag(event) || isFileDrag(event)) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = isFileDrag(event) ? "copy" : "move";
          setDropTarget(id);
        }
      },
      onDragLeave: () =>
        setDropTarget((current) => (current === id ? null : current)),
      onDrop: async (event: React.DragEvent) => {
        setDropTarget(null);
        if (isInternalDrag(event)) {
          event.preventDefault();
          event.stopPropagation();
          const dragged: Selection = JSON.parse(
            event.dataTransfer.getData(DRAG_MIME),
          );
          if (!props.canMoveInto(dragged, targetFolderId)) {
            return;
          }
          props.onMove(dragged, targetFolderId);
          setSelected(new Set());
        } else if (isFileDrag(event)) {
          event.preventDefault();
          event.stopPropagation();
          dragDepth.current = 0;
          setIsDraggingFiles(false);
          props.onImport(
            await entriesFromDataTransfer(event.dataTransfer),
            targetFolderId,
          );
        }
      },
    };
  };

  // files dropped anywhere else in the panel go into the open folder
  const panelDropHandlers = {
    onDragEnter: (event: React.DragEvent) => {
      if (isFileDrag(event)) {
        dragDepth.current++;
        setIsDraggingFiles(true);
      }
    },
    onDragLeave: (event: React.DragEvent) => {
      if (isFileDrag(event) && --dragDepth.current <= 0) {
        dragDepth.current = 0;
        setIsDraggingFiles(false);
      }
    },
    onDragOver: (event: React.DragEvent) => {
      if (isFileDrag(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onDrop: async (event: React.DragEvent) => {
      if (!isFileDrag(event)) {
        return;
      }
      // keep the editor from also trying to open the files as a scene
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current = 0;
      setIsDraggingFiles(false);
      props.onImport(
        await entriesFromDataTransfer(event.dataTransfer),
        folderId,
      );
    },
  };

  const handleFileInput = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const { files } = event.target;
    if (files?.length) {
      props.onImport(await entriesFromFileList(files), folderId);
    }
    // allow picking the same files again
    event.target.value = "";
  };

  // ---------------------------------------------------------------------------
  // menus
  // ---------------------------------------------------------------------------

  const openMenu = (
    event: React.MouseEvent,
    key: NonNullable<MenuState>["key"],
  ) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu((current) =>
      current?.key === key ? null : { key, x: rect.right, y: rect.bottom + 4 },
    );
  };

  const menuItem = (
    label: string,
    icon: React.ReactNode,
    onSelect: () => void,
    danger = false,
  ) => (
    <button
      key={label}
      type="button"
      className={clsx("file-manager__menu-item", {
        "file-manager__menu-item--danger": danger,
      })}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => {
        setMenu(null);
        onSelect();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );

  const exportItems = (target: Selection) =>
    EXPORT_FORMATS.map(({ format, label }) =>
      menuItem(`Export as ${label}`, ExportIcon, () =>
        props.onExport(target, format),
      ),
    );

  const renderMenu = () => {
    if (!menu) {
      return null;
    }
    let items: React.ReactNode[] = [];
    if (menu.key === "import") {
      items = [
        menuItem("Import files…", LoadIcon, () =>
          fileInputRef.current?.click(),
        ),
        menuItem("Import a folder…", folderIcon, () =>
          folderInputRef.current?.click(),
        ),
      ];
    } else if (menu.key === "bulk-export") {
      items = exportItems(selection);
    } else {
      const key = menu.key;
      const id = key.slice(2);
      const single = toSelection([key]);
      items = key.startsWith("c:")
        ? [
            menuItem("Open", LoadIcon, () => props.onOpen(id)),
            menuItem("Rename…", pencilIcon, () => promptRename(key)),
            menuItem("Move to…", moveIcon, () => setMoveTarget(single)),
            menuItem("Duplicate", DuplicateIcon, () =>
              props.onDuplicateCanvas(id),
            ),
            ...exportItems(single),
            menuItem("Delete", TrashIcon, () => props.onDelete(single), true),
          ]
        : [
            menuItem("Open", folderIcon, () => setCurrentFolder(id)),
            menuItem("Rename…", pencilIcon, () => promptRename(key)),
            menuItem("Move to…", moveIcon, () => setMoveTarget(single)),
            ...exportItems(single),
            menuItem("Delete", TrashIcon, () => props.onDelete(single), true),
          ];
    }
    return (
      <div
        className="file-manager__menu"
        style={{ top: menu.y, left: menu.x }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {items}
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // rendering
  // ---------------------------------------------------------------------------

  const renderRow = (key: ItemKey) => {
    const id = key.slice(2);
    const isFolder = key.startsWith("f:");
    const folder = isFolder ? folderById.get(id) : undefined;
    const canvas = isFolder ? undefined : canvases.find((c) => c.id === id);
    const name = folder?.name ?? canvas?.name ?? "";
    const location = isSearching
      ? getFolderPath(isFolder ? folder?.parentId : canvas?.folderId) ||
        "All drawings"
      : null;
    const itemCount = counts.get(id) ?? 0;

    return (
      <div
        key={key}
        className={clsx("file-manager__row", {
          "file-manager__row--selected": selected.has(key),
          "file-manager__row--current": !isFolder && id === currentCanvasId,
          "file-manager__row--drop": isFolder && dropTarget === id,
        })}
        draggable
        onDragStart={(event) => startDrag(event, key)}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || selected.size > 0) {
            toggleSelected(key);
          } else if (isFolder) {
            setCurrentFolder(id);
          } else {
            props.onOpen(id);
          }
        }}
        title={name}
        {...(isFolder ? dropTargetHandlers(id) : {})}
      >
        <input
          type="checkbox"
          className="file-manager__check"
          checked={selected.has(key)}
          aria-label={`Select ${name}`}
          onClick={(event) => event.stopPropagation()}
          onChange={() => toggleSelected(key)}
        />
        <div className="file-manager__thumb">
          {isFolder ? (
            <span className="file-manager__folder-icon">{folderIcon}</span>
          ) : canvas?.thumbnail ? (
            <img src={canvas.thumbnail} alt="" />
          ) : (
            <span className="file-manager__empty-thumb">Empty</span>
          )}
        </div>
        <div className="file-manager__info">
          <span className="file-manager__name">{name}</span>
          <span className="file-manager__meta">
            {location ??
              (isFolder
                ? `${itemCount} item${itemCount === 1 ? "" : "s"}`
                : timeAgo(
                    sort === "created" ? canvas!.createdAt : canvas!.updatedAt,
                  ))}
          </span>
        </div>
        <button
          type="button"
          className="file-manager__icon-button"
          aria-label={`Actions for ${name}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => openMenu(event, key)}
        >
          {DotsHorizontalIcon}
        </button>
      </div>
    );
  };

  const renderMoveDialog = () => {
    if (!moveTarget) {
      return null;
    }
    const tree: { folder: FolderMetadata; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      folders
        .filter((folder) => (folder.parentId ?? null) === parentId)
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        )
        .forEach((folder) => {
          tree.push({ folder, depth });
          walk(folder.id, depth + 1);
        });
    };
    walk(null, 0);

    const move = (target: string | null) => {
      props.onMove(moveTarget, target);
      setMoveTarget(null);
      setSelected(new Set());
    };
    const count = moveTarget.canvasIds.length + moveTarget.folderIds.length;

    return (
      <Dialog
        onCloseRequest={() => setMoveTarget(null)}
        title={`Move ${count} item${count === 1 ? "" : "s"} to…`}
        size="small"
      >
        <div className="file-manager__tree">
          <button
            type="button"
            className="file-manager__tree-item"
            onClick={() => move(null)}
          >
            {folderIcon}
            <span>All drawings</span>
          </button>
          {tree.map(({ folder, depth }) => {
            const allowed = props.canMoveInto(moveTarget, folder.id);
            return (
              <button
                key={folder.id}
                type="button"
                className="file-manager__tree-item"
                style={{ paddingInlineStart: `${0.75 + (depth + 1) * 1.1}rem` }}
                disabled={!allowed}
                title={allowed ? undefined : "A folder can't go inside itself"}
                onClick={() => move(folder.id)}
              >
                {folderIcon}
                <span>{folder.name}</span>
              </button>
            );
          })}
        </div>
      </Dialog>
    );
  };

  return (
    <div
      className={clsx("file-manager", {
        "file-manager--dragging-files": isDraggingFiles,
      })}
      {...panelDropHandlers}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={IMPORT_ACCEPT}
        hidden
        onChange={handleFileInput}
      />
      <input
        ref={folderInputRef}
        type="file"
        hidden
        onChange={handleFileInput}
        // not in React's typings, but supported by every current browser
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
      />

      <div className="file-manager__toolbar">
        <FilledButton
          label="New drawing"
          icon={PlusIcon}
          onClick={promptNewCanvas}
        >
          New drawing
        </FilledButton>
        <button
          type="button"
          className="file-manager__tool"
          title="New folder"
          onClick={promptNewFolder}
        >
          {folderIcon}
          <span>Folder</span>
        </button>
        <button
          type="button"
          className="file-manager__tool"
          title="Import .excalidraw files, images with embedded drawings, zips or folders"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => openMenu(event, "import")}
        >
          {LoadIcon}
          <span>Import</span>
        </button>
      </div>

      <div className="file-manager__filters">
        <label className="file-manager__search">
          {searchIcon}
          <input
            type="search"
            placeholder="Search all drawings"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(new Set());
            }}
          />
        </label>
        <select
          className="file-manager__sort"
          value={sort}
          aria-label="Sort by"
          onChange={(event) => setSort(event.target.value as SortMode)}
        >
          {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {SORT_LABELS[mode]}
            </option>
          ))}
        </select>
      </div>

      {isSearching ? (
        <div className="file-manager__crumbs">Results for “{query.trim()}”</div>
      ) : (
        <nav className="file-manager__crumbs" aria-label="Folder path">
          <button
            type="button"
            className={clsx("file-manager__crumb", {
              "file-manager__crumb--drop": dropTarget === "root",
            })}
            onClick={() => setCurrentFolder(null)}
            {...dropTargetHandlers(null)}
          >
            All drawings
          </button>
          {breadcrumbs.map((folder) => (
            <React.Fragment key={folder.id}>
              <span className="file-manager__crumb-sep">{chevronRight}</span>
              <button
                type="button"
                className={clsx("file-manager__crumb", {
                  "file-manager__crumb--drop": dropTarget === folder.id,
                })}
                onClick={() => setCurrentFolder(folder.id)}
                {...dropTargetHandlers(folder.id)}
              >
                {folder.name}
              </button>
            </React.Fragment>
          ))}
        </nav>
      )}

      {props.migration && props.migration.count > 0 && (
        <div className="file-manager__banner">
          <span>
            {props.migration.count} drawing
            {props.migration.count === 1 ? " is" : "s are"} only saved in this
            browser.
          </span>
          <button type="button" onClick={props.migration.onMigrate}>
            Copy to the cloud
          </button>
        </div>
      )}

      {progress && (
        <div className="file-manager__progress" role="status">
          <span>
            {progress.label} {progress.done}/{progress.total}…
          </span>
          <div className="file-manager__progress-bar">
            <div
              style={{
                width: `${
                  (progress.done / Math.max(progress.total, 1)) * 100
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {selected.size > 0 ? (
        <div className="file-manager__selection">
          <input
            type="checkbox"
            className="file-manager__check"
            checked={allVisibleSelected}
            aria-label="Select all"
            onChange={() =>
              setSelected(allVisibleSelected ? new Set() : new Set(visibleKeys))
            }
          />
          <span className="file-manager__selection-count">
            {selected.size} selected
          </span>
          <button
            type="button"
            className="file-manager__icon-button"
            title="Move to…"
            onClick={() => setMoveTarget(selection)}
          >
            {moveIcon}
          </button>
          <button
            type="button"
            className="file-manager__icon-button"
            title="Export"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => openMenu(event, "bulk-export")}
          >
            {ExportIcon}
          </button>
          <button
            type="button"
            className="file-manager__icon-button file-manager__icon-button--danger"
            title="Delete"
            onClick={() => props.onDelete(selection)}
          >
            {TrashIcon}
          </button>
          <button
            type="button"
            className="file-manager__icon-button"
            title="Clear selection"
            onClick={() => setSelected(new Set())}
          >
            {CloseIcon}
          </button>
        </div>
      ) : (
        visibleKeys.length > 0 && (
          <div className="file-manager__hint">
            {visibleKeys.length} item{visibleKeys.length === 1 ? "" : "s"} ·
            drag onto a folder to move · drop files here to import
          </div>
        )
      )}

      <div className="file-manager__list">
        {visibleKeys.length === 0 ? (
          <div className="file-manager__empty">
            {isSearching ? (
              <p>No drawings or folders match “{query.trim()}”.</p>
            ) : (
              <>
                {folderIcon}
                <p>This folder is empty.</p>
                <p>
                  Create a drawing or folder, or drop .excalidraw files or a
                  whole folder here.
                </p>
              </>
            )}
          </div>
        ) : (
          visibleKeys.map(renderRow)
        )}
      </div>

      <div className="file-manager__footer">{props.storageLabel}</div>

      {isDraggingFiles && (
        <div className="file-manager__drop-overlay">
          Drop to import into{" "}
          {folderId ? folderById.get(folderId)?.name : "All drawings"}
        </div>
      )}

      {renderMenu()}
      {renderMoveDialog()}

      {props.confirmRequest && (
        <ConfirmDialog
          title={props.confirmRequest.title}
          confirmText={props.confirmRequest.actionLabel}
          onConfirm={() => props.confirmRequest?.resolve(true)}
          onCancel={() => props.confirmRequest?.resolve(false)}
        >
          <p>{props.confirmRequest.description}</p>
        </ConfirmDialog>
      )}

      {prompt && (
        <Dialog
          onCloseRequest={() => setPrompt(null)}
          title={prompt.title}
          size="small"
          // Dialog would focus its second focusable element (the action
          // button); the text field focuses and selects itself instead
          autofocus={false}
        >
          <div className="file-manager__prompt">
            <TextField
              label={prompt.label}
              value={promptValue}
              onChange={setPromptValue}
              onKeyDown={(event) => event.key === "Enter" && submitPrompt()}
              selectOnRender
            />
            <div className="file-manager__prompt-actions">
              <FilledButton
                color="primary"
                label={prompt.actionLabel}
                onClick={submitPrompt}
              />
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
};
