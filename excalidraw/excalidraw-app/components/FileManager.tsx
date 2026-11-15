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
import type {
  CanvasMetadata,
  CanvasVersion,
  FolderMetadata,
} from "../data/storage";
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
const VIEW_KEY = "excalidraw-file-manager-view";
const EXPANDED_KEY = "excalidraw-file-manager-expanded";
/** pseudo-folder listing the most recently edited drawings everywhere */
const RECENT_VIEW = "__recent__";
/** pseudo-folder listing drawings in the trash */
const TRASH_VIEW = "__trash__";
const RECENT_LIMIT = 24;

type SortMode = "updated" | "name" | "created";
type ViewMode = "grid" | "list";
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
  /** opens upwards from y when there's no room below */
  up: boolean;
} | null;

// tallest menu: an item menu with every action (~10 rows)
const MENU_MAX_HEIGHT = 380;

export type FileManagerProps = {
  canvases: readonly CanvasMetadata[];
  trashedCanvases: readonly CanvasMetadata[];
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
  /** moves drawings to the trash (folders: see handleFoldersDelete) */
  onDelete: (selection: Selection) => void;
  onRestore: (ids: readonly string[]) => void;
  onDeleteForever: (ids: readonly string[]) => void;
  supportsVersions: boolean;
  onListVersions: (id: string) => Promise<CanvasVersion[]>;
  /** resolves to whether the version was restored */
  onRestoreVersion: (id: string, version: CanvasVersion) => Promise<boolean>;
  onExport: (selection: Selection, format: ExportFormat) => void;
  onImport: (entries: ImportEntry[], folderId: string | null) => void;
  canMoveInto: (selection: Selection, folderId: string | null) => boolean;
  getFolderPath: (folderId: string | null | undefined) => string;
  onRefresh: () => void;
  /**
   * "sidebar" is the compact panel; "dashboard" is the full-screen overview
   * with a folder tree and large cards.
   */
  variant?: "sidebar" | "dashboard";
  /** sidebar only: opens the dashboard */
  onOpenDashboard?: () => void;
  /** dashboard only */
  onClose?: () => void;
};

const folderIconLarge = (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.2.6l1.04 1.4h8.38A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" />
  </svg>
);

const gridIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </svg>
);

const listIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path d="M9 6h11M9 12h11M9 18h11" strokeLinecap="round" />
    <circle cx="4.5" cy="6" r="1" fill="currentColor" />
    <circle cx="4.5" cy="12" r="1" fill="currentColor" />
    <circle cx="4.5" cy="18" r="1" fill="currentColor" />
  </svg>
);

const expandIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path
      d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const clockIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const restoreIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path
      d="M4 12a8 8 0 1 0 2.34-5.66M4 4v4h4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const homeIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
    <path
      d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"
      strokeLinejoin="round"
    />
  </svg>
);

export const FileManager: React.FC<FileManagerProps> = (props) => {
  const {
    canvases,
    folders,
    currentCanvasId,
    progress,
    onRefresh,
    getFolderPath,
  } = props;
  const isDashboard = props.variant === "dashboard";

  const folderById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder])),
    [folders],
  );
  const canvasById = useMemo(
    () =>
      new Map(
        [...canvases, ...props.trashedCanvases].map((canvas) => [
          canvas.id,
          canvas,
        ]),
      ),
    [canvases, props.trashedCanvases],
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
  const [versionsFor, setVersionsFor] = useState<string | null>(null);
  const [versions, setVersions] = useState<CanvasVersion[] | null>(null);
  const [view, setViewState] = useState<ViewMode>(
    () =>
      (readStorage(
        `${VIEW_KEY}-${props.variant ?? "sidebar"}`,
      ) as ViewMode | null) ?? (isDashboard ? "grid" : "list"),
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(readStorage(EXPANDED_KEY) || "[]"));
    } catch {
      return new Set();
    }
  });

  const rootRef = useRef<HTMLDivElement>(null);
  const versionsForRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    onRefresh();
  }, [onRefresh]);

  const isRecent = currentFolderId === RECENT_VIEW;
  const isTrash = currentFolderId === TRASH_VIEW;
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

  const setView = (mode: ViewMode) => {
    setViewState(mode);
    writeStorage(`${VIEW_KEY}-${props.variant ?? "sidebar"}`, mode);
  };

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      writeStorage(EXPANDED_KEY, JSON.stringify([...next]));
      return next;
    });

  const openCanvas = (id: string) => {
    props.onOpen(id);
    props.onClose?.();
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
            ? canvasById.has(key.slice(2))
            : folderById.has(key.slice(2)),
        ),
      );
      return next.size === prev.size ? prev : next;
    });
  }, [canvasById, folderById]);

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
            : !isRecent && !isTrash && (folder.parentId ?? null) === folderId,
        )
        // folders always sort by name; dates rarely matter for them
        .sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        ),
    [folders, folderId, isRecent, isTrash, isSearching, normalizedQuery],
  );

  const visibleCanvases = useMemo(() => {
    if (isTrash && !isSearching) {
      return [...props.trashedCanvases].sort(
        (a, b) =>
          new Date(b.deletedAt ?? 0).getTime() -
          new Date(a.deletedAt ?? 0).getTime(),
      );
    }
    if (isRecent && !isSearching) {
      return [...canvases]
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
        .slice(0, RECENT_LIMIT);
    }
    return canvases
      .filter((canvas) =>
        isSearching
          ? canvas.name.toLowerCase().includes(normalizedQuery)
          : (canvas.folderId && folderById.has(canvas.folderId)
              ? canvas.folderId
              : null) === folderId,
      )
      .sort(compare);
  }, [
    canvases,
    props.trashedCanvases,
    folderById,
    folderId,
    isRecent,
    isTrash,
    isSearching,
    normalizedQuery,
    compare,
  ]);

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
      const canvas = canvasById.get(id);
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
    // positioned relative to the file manager: inside a Dialog, a transformed
    // ancestor would offset `position: fixed`
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const root = rootRef.current?.getBoundingClientRect();
    const x = rect.right - (root?.left ?? 0);
    const up =
      !!root &&
      rect.bottom + MENU_MAX_HEIGHT > root.bottom &&
      rect.top - MENU_MAX_HEIGHT > root.top;
    const y = up ? rect.top - 4 - root.top : rect.bottom + 4 - (root?.top ?? 0);
    setMenu((current) => (current?.key === key ? null : { key, x, y, up }));
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
      items = canvasById.get(id)?.deletedAt
        ? [
            menuItem("Restore", LoadIcon, () => props.onRestore([id])),
            menuItem(
              "Delete forever",
              TrashIcon,
              () => props.onDeleteForever([id]),
              true,
            ),
          ]
        : key.startsWith("c:")
        ? [
            menuItem("Open", LoadIcon, () => openCanvas(id)),
            menuItem("Rename…", pencilIcon, () => promptRename(key)),
            menuItem("Move to…", moveIcon, () => setMoveTarget(single)),
            menuItem("Duplicate", DuplicateIcon, () =>
              props.onDuplicateCanvas(id),
            ),
            ...(props.supportsVersions
              ? [
                  menuItem("Version history…", clockIcon, () =>
                    openVersions(id),
                  ),
                ]
              : []),
            ...exportItems(single),
            menuItem(
              "Move to Trash",
              TrashIcon,
              () => props.onDelete(single),
              true,
            ),
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
        style={{
          top: menu.y,
          left: menu.x,
          transform: menu.up ? "translate(-100%, -100%)" : undefined,
        }}
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
    const canvas = isFolder ? undefined : canvasById.get(id);
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
        onClick={(event) => onItemClick(event, key)}
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
                : canvas?.deletedAt
                ? `Deleted ${timeAgo(canvas.deletedAt)}`
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

  const openVersions = (id: string) => {
    versionsForRef.current = id;
    setVersions(null);
    setVersionsFor(id);
    props.onListVersions(id).then((list) => {
      // ignore answers for a dialog that was closed or switched meanwhile
      if (versionsForRef.current === id) {
        setVersions(list);
      }
    });
  };

  const closeVersions = () => {
    versionsForRef.current = null;
    setVersionsFor(null);
  };

  const renderVersionsDialog = () => {
    if (!versionsFor) {
      return null;
    }
    const canvas = canvasById.get(versionsFor);
    return (
      <Dialog
        onCloseRequest={closeVersions}
        title={`Version history · ${canvas?.name ?? ""}`}
        size="small"
      >
        <div className="file-manager__versions">
          {versions === null ? (
            <p className="file-manager__versions-note">Loading…</p>
          ) : versions.length === 0 ? (
            <p className="file-manager__versions-note">
              No earlier versions yet. While you edit, a version is kept at most
              every 30 minutes (the last 50 per drawing).
            </p>
          ) : (
            versions.map((version) => (
              <div key={version.id} className="file-manager__version">
                <div className="file-manager__info">
                  <span className="file-manager__name">
                    {new Date(version.savedAt).toLocaleString()}
                  </span>
                  <span className="file-manager__meta">
                    {timeAgo(version.savedAt)}
                  </span>
                </div>
                <FilledButton
                  variant="outlined"
                  label="Restore"
                  onClick={async () => {
                    if (await props.onRestoreVersion(versionsFor, version)) {
                      closeVersions();
                    }
                  }}
                >
                  Restore
                </FilledButton>
              </div>
            ))
          )}
        </div>
      </Dialog>
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

  /** shared click behavior of rows, cards and folder tiles */
  const onItemClick = (event: React.MouseEvent, key: ItemKey) => {
    const id = key.slice(2);
    // drawings in the trash are restored, not opened
    if (event.metaKey || event.ctrlKey || selected.size > 0 || isTrash) {
      toggleSelected(key);
    } else if (key.startsWith("f:")) {
      setCurrentFolder(id);
    } else {
      openCanvas(id);
    }
  };

  const itemCheckbox = (key: ItemKey, name: string, className: string) => (
    <input
      type="checkbox"
      className={className}
      checked={selected.has(key)}
      aria-label={`Select ${name}`}
      onClick={(event) => event.stopPropagation()}
      onChange={() => toggleSelected(key)}
    />
  );

  const itemMenuButton = (key: ItemKey, name: string) => (
    <button
      type="button"
      className="file-manager__icon-button"
      aria-label={`Actions for ${name}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        openMenu(event, key);
      }}
    >
      {DotsHorizontalIcon}
    </button>
  );

  /** grid view: compact tile for folders, large card for drawings */
  const renderCard = (key: ItemKey) => {
    const id = key.slice(2);
    const isFolder = key.startsWith("f:");
    if (isFolder) {
      const folder = folderById.get(id);
      const itemCount = counts.get(id) ?? 0;
      return (
        <div
          key={key}
          className={clsx("file-manager__tile", {
            "file-manager__tile--selected": selected.has(key),
            "file-manager__tile--drop": dropTarget === id,
          })}
          draggable
          onDragStart={(event) => startDrag(event, key)}
          onClick={(event) => onItemClick(event, key)}
          title={folder?.name}
          {...dropTargetHandlers(id)}
        >
          {itemCheckbox(key, folder?.name ?? "", "file-manager__card-check")}
          <span className="file-manager__tile-icon">{folderIconLarge}</span>
          <div className="file-manager__info">
            <span className="file-manager__name">{folder?.name}</span>
            <span className="file-manager__meta">
              {isSearching
                ? getFolderPath(folder?.parentId) || "All drawings"
                : `${itemCount} item${itemCount === 1 ? "" : "s"}`}
            </span>
          </div>
          {itemMenuButton(key, folder?.name ?? "")}
        </div>
      );
    }

    const canvas = canvasById.get(id);
    if (!canvas) {
      return null;
    }
    const location =
      isSearching || isRecent
        ? getFolderPath(canvas.folderId) || "All drawings"
        : null;
    return (
      <div
        key={key}
        className={clsx("file-manager__card", {
          "file-manager__card--selected": selected.has(key),
          "file-manager__card--current": id === currentCanvasId,
        })}
        draggable
        onDragStart={(event) => startDrag(event, key)}
        onClick={(event) => onItemClick(event, key)}
        title={canvas.name}
      >
        <div className="file-manager__card-thumb">
          {canvas.thumbnail ? (
            <img src={canvas.thumbnail} alt="" />
          ) : (
            <span className="file-manager__empty-thumb">Empty drawing</span>
          )}
          {itemCheckbox(key, canvas.name, "file-manager__card-check")}
          {id === currentCanvasId && (
            <span className="file-manager__card-badge">Open</span>
          )}
        </div>
        <div className="file-manager__card-footer">
          <div className="file-manager__info">
            <span className="file-manager__name">{canvas.name}</span>
            <span className="file-manager__meta">
              {location ? `${location} · ` : ""}
              {canvas.deletedAt
                ? `Deleted ${timeAgo(canvas.deletedAt)}`
                : timeAgo(
                    sort === "created" ? canvas.createdAt : canvas.updatedAt,
                  )}
            </span>
          </div>
          {itemMenuButton(key, canvas.name)}
        </div>
      </div>
    );
  };

  /** dashboard navigation: All, Recent and the folder tree */
  const renderNavTree = (parentId: string | null, depth: number) =>
    folders
      .filter((folder) => (folder.parentId ?? null) === parentId)
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      )
      .map((folder) => {
        const hasChildren = folders.some((f) => f.parentId === folder.id);
        const isOpen = expanded.has(folder.id);
        return (
          <React.Fragment key={folder.id}>
            <div
              className={clsx("file-manager__nav-item", {
                "file-manager__nav-item--active":
                  !isSearching && folderId === folder.id,
                "file-manager__nav-item--drop": dropTarget === folder.id,
              })}
              style={{ paddingInlineStart: `${0.5 + depth * 0.9}rem` }}
              onClick={() => setCurrentFolder(folder.id)}
              title={folder.name}
              {...dropTargetHandlers(folder.id)}
            >
              <button
                type="button"
                className={clsx("file-manager__nav-toggle", {
                  "file-manager__nav-toggle--open": isOpen,
                  "file-manager__nav-toggle--hidden": !hasChildren,
                })}
                aria-label={isOpen ? "Collapse" : "Expand"}
                tabIndex={hasChildren ? 0 : -1}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleExpanded(folder.id);
                }}
              >
                {chevronRight}
              </button>
              {folderIcon}
              <span className="file-manager__nav-label">{folder.name}</span>
              <span className="file-manager__nav-count">
                {counts.get(folder.id) || ""}
              </span>
            </div>
            {hasChildren && isOpen && renderNavTree(folder.id, depth + 1)}
          </React.Fragment>
        );
      });

  // ---------------------------------------------------------------------------
  // layout pieces shared by the sidebar and the dashboard
  // ---------------------------------------------------------------------------

  const hiddenInputs = (
    <>
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
    </>
  );

  const actions = (
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
      {props.onOpenDashboard && (
        <button
          type="button"
          className="file-manager__tool file-manager__tool--icon"
          title="Open the full-screen dashboard"
          aria-label="Open the full-screen dashboard"
          onClick={props.onOpenDashboard}
        >
          {expandIcon}
        </button>
      )}
    </div>
  );

  const filters = (
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
      <div className="file-manager__view-toggle" role="group" aria-label="View">
        <button
          type="button"
          className={clsx({ active: view === "grid" })}
          title="Grid"
          aria-pressed={view === "grid"}
          onClick={() => setView("grid")}
        >
          {gridIcon}
        </button>
        <button
          type="button"
          className={clsx({ active: view === "list" })}
          title="List"
          aria-pressed={view === "list"}
          onClick={() => setView("list")}
        >
          {listIcon}
        </button>
      </div>
    </div>
  );

  const crumbs = isSearching ? (
    <div className="file-manager__crumbs">Results for “{query.trim()}”</div>
  ) : isRecent ? (
    <div className="file-manager__crumbs">Recently edited</div>
  ) : isTrash ? (
    <div className="file-manager__crumbs file-manager__crumbs--trash">
      <span>Kept for 30 days, then deleted for good</span>
      {props.trashedCanvases.length > 0 && (
        <button
          type="button"
          className="file-manager__text-button file-manager__text-button--danger"
          onClick={() =>
            props.onDeleteForever(props.trashedCanvases.map((c) => c.id))
          }
        >
          Empty trash
        </button>
      )}
    </div>
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
  );

  const banner = props.migration && props.migration.count > 0 && (
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
  );

  const progressBar = progress && (
    <div className="file-manager__progress" role="status">
      <span>
        {progress.label} {progress.done}/{progress.total}…
      </span>
      <div className="file-manager__progress-bar">
        <div
          style={{
            width: `${(progress.done / Math.max(progress.total, 1)) * 100}%`,
          }}
        />
      </div>
    </div>
  );

  const selectionBar =
    selected.size > 0 ? (
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
        {isTrash ? (
          <>
            <button
              type="button"
              className="file-manager__icon-button"
              title="Restore"
              onClick={() => {
                props.onRestore(selection.canvasIds);
                setSelected(new Set());
              }}
            >
              {restoreIcon}
            </button>
            <button
              type="button"
              className="file-manager__icon-button file-manager__icon-button--danger"
              title="Delete forever"
              onClick={() => props.onDeleteForever(selection.canvasIds)}
            >
              {TrashIcon}
            </button>
          </>
        ) : (
          <>
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
              title="Move to Trash"
              onClick={() => props.onDelete(selection)}
            >
              {TrashIcon}
            </button>
          </>
        )}
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
          {visibleKeys.length} item{visibleKeys.length === 1 ? "" : "s"} · drag
          onto a folder to move · drop files here to import
        </div>
      )
    );

  const emptyState = (
    <div className="file-manager__empty">
      {isSearching ? (
        <p>No drawings or folders match “{query.trim()}”.</p>
      ) : isRecent ? (
        <p>No drawings yet.</p>
      ) : isTrash ? (
        <>
          {TrashIcon}
          <p>Trash is empty.</p>
          <p>Deleted drawings stay here for 30 days.</p>
        </>
      ) : (
        <>
          {folderIcon}
          <p>This folder is empty.</p>
          <p>
            Create a drawing or folder, or drop .excalidraw files or a whole
            folder here.
          </p>
        </>
      )}
    </div>
  );

  const folderKeys = visibleKeys.filter((key) => key.startsWith("f:"));
  const canvasKeys = visibleKeys.filter((key) => key.startsWith("c:"));

  const content = (
    <div
      className={clsx("file-manager__list", {
        "file-manager__list--grid": view === "grid",
      })}
    >
      {visibleKeys.length === 0 ? (
        emptyState
      ) : view === "list" ? (
        visibleKeys.map(renderRow)
      ) : (
        <>
          {folderKeys.length > 0 && (
            <section className="file-manager__section">
              {isDashboard && (
                <h3 className="file-manager__section-title">Folders</h3>
              )}
              <div className="file-manager__tiles">
                {folderKeys.map(renderCard)}
              </div>
            </section>
          )}
          {canvasKeys.length > 0 && (
            <section className="file-manager__section">
              {isDashboard && (
                <h3 className="file-manager__section-title">Drawings</h3>
              )}
              <div className="file-manager__cards">
                {canvasKeys.map(renderCard)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );

  const overlays = (
    <>
      {isDraggingFiles && (
        <div className="file-manager__drop-overlay">
          Drop to import into{" "}
          {folderId ? folderById.get(folderId)?.name : "All drawings"}
        </div>
      )}

      {renderMenu()}
      {renderMoveDialog()}
      {renderVersionsDialog()}

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
    </>
  );

  if (!isDashboard) {
    return (
      <div
        ref={rootRef}
        className={clsx("file-manager", {
          "file-manager--dragging-files": isDraggingFiles,
        })}
        {...panelDropHandlers}
      >
        {hiddenInputs}
        {actions}
        {filters}
        {crumbs}
        {banner}
        {progressBar}
        {selectionBar}
        {content}
        <div className="file-manager__footer">
          <span>{props.storageLabel}</span>
          <button
            type="button"
            className="file-manager__text-button"
            onClick={() => setCurrentFolder(isTrash ? null : TRASH_VIEW)}
          >
            {isTrash
              ? "Back to drawings"
              : `Trash${
                  props.trashedCanvases.length
                    ? ` (${props.trashedCanvases.length})`
                    : ""
                }`}
          </button>
        </div>
        {overlays}
      </div>
    );
  }

  const title = isSearching
    ? "Search"
    : isRecent
    ? "Recent"
    : isTrash
    ? "Trash"
    : folderId
    ? folderById.get(folderId)?.name
    : "All drawings";

  return (
    <Dialog
      onCloseRequest={() => props.onClose?.()}
      title={false}
      size={1320}
      className="file-manager-dashboard-dialog"
    >
      <div
        ref={rootRef}
        className={clsx("file-manager file-manager--dashboard", {
          "file-manager--dragging-files": isDraggingFiles,
        })}
        {...panelDropHandlers}
      >
        {hiddenInputs}
        <aside className="file-manager__nav">
          <div className="file-manager__nav-heading">My drawings</div>
          <div
            className={clsx("file-manager__nav-item", {
              "file-manager__nav-item--active":
                !isSearching && !isRecent && !folderId,
              "file-manager__nav-item--drop": dropTarget === "root",
            })}
            onClick={() => setCurrentFolder(null)}
            {...dropTargetHandlers(null)}
          >
            <span className="file-manager__nav-toggle file-manager__nav-toggle--hidden" />
            {homeIcon}
            <span className="file-manager__nav-label">All drawings</span>
            <span className="file-manager__nav-count">{canvases.length}</span>
          </div>
          <div
            className={clsx("file-manager__nav-item", {
              "file-manager__nav-item--active": !isSearching && isRecent,
            })}
            onClick={() => setCurrentFolder(RECENT_VIEW)}
          >
            <span className="file-manager__nav-toggle file-manager__nav-toggle--hidden" />
            {clockIcon}
            <span className="file-manager__nav-label">Recent</span>
          </div>
          <div
            className={clsx("file-manager__nav-item", {
              "file-manager__nav-item--active": !isSearching && isTrash,
            })}
            onClick={() => setCurrentFolder(TRASH_VIEW)}
          >
            <span className="file-manager__nav-toggle file-manager__nav-toggle--hidden" />
            {TrashIcon}
            <span className="file-manager__nav-label">Trash</span>
            <span className="file-manager__nav-count">
              {props.trashedCanvases.length || ""}
            </span>
          </div>
          <div className="file-manager__nav-heading file-manager__nav-heading--small">
            <span>Folders</span>
            <button
              type="button"
              className="file-manager__icon-button"
              title="New folder"
              aria-label="New folder"
              onClick={promptNewFolder}
            >
              {PlusIcon}
            </button>
          </div>
          <div className="file-manager__nav-tree">
            {folders.length ? (
              renderNavTree(null, 0)
            ) : (
              <p className="file-manager__nav-empty">No folders yet</p>
            )}
          </div>
          <div className="file-manager__footer">{props.storageLabel}</div>
        </aside>

        <section className="file-manager__main">
          <header className="file-manager__header">
            <div className="file-manager__heading">
              <h2>{title}</h2>
              {!isRecent && !isSearching && (folderId || isTrash) && crumbs}
            </div>
            <button
              type="button"
              className="file-manager__icon-button"
              title="Close"
              aria-label="Close"
              onClick={() => props.onClose?.()}
            >
              {CloseIcon}
            </button>
          </header>
          <div className="file-manager__controls">
            {filters}
            {actions}
          </div>
          {banner}
          {progressBar}
          {selectionBar}
          {content}
        </section>
        {overlays}
      </div>
    </Dialog>
  );
};
