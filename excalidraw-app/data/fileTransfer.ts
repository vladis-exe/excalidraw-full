import {
  exportScene,
  getNonDeletedElements,
  loadFromBlob,
  MIME_TYPES,
  restoreAppState,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import { getExportConfigFromAppState } from "@excalidraw/excalidraw/scene/export";
import { unzipSync, zip } from "fflate";

import type { AppState } from "@excalidraw/excalidraw/types";

import type { CanvasData } from "./storage";

export type ExportFormat = "excalidraw" | "png" | "svg" | "pdf";

export const EXPORT_FORMATS: readonly {
  format: ExportFormat;
  label: string;
  extension: string;
}[] = [
  { format: "png", label: "PNG image", extension: "png" },
  { format: "svg", label: "SVG image", extension: "svg" },
  { format: "pdf", label: "PDF document", extension: "pdf" },
  { format: "excalidraw", label: "Excalidraw file", extension: "excalidraw" },
];

const IMPORTABLE_EXTENSIONS = ["excalidraw", "json", "png", "svg"];

/** extensions accepted by the import file picker */
export const IMPORT_ACCEPT = [...IMPORTABLE_EXTENSIONS, "zip"]
  .map((ext) => `.${ext}`)
  .join(",");

// PDF pages are sized in points (1/72 in) from CSS pixels (1/96 in)
const PX_TO_PT = 72 / 96;
const PDF_RENDER_SCALE = 2;

export const sanitizeFileName = (name: string) =>
  // eslint-disable-next-line no-control-regex
  name.replace(/[/\\?%*:|"<>\x00-\x1f]/g, "-").trim() || "Untitled";

const getExtension = (fileName: string) => {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
};

export const stripExtension = (fileName: string) => {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
};

// -----------------------------------------------------------------------------
// export
// -----------------------------------------------------------------------------

export const canvasToBlob = async (
  data: CanvasData,
  format: ExportFormat,
): Promise<Blob> => {
  // stored canvases may predate appState fields the exporters rely on
  const appState = restoreAppState(data.appState, null);
  const files = data.files || {};

  if (format === "excalidraw") {
    return new Blob(
      [serializeAsJSON(data.elements, appState, files, "local")],
      { type: MIME_TYPES.excalidraw },
    );
  }

  const elements = getNonDeletedElements(data.elements);
  if (!elements.length) {
    throw new Error("The canvas is empty, there is nothing to export.");
  }
  const exportData = { elements, appState, files };
  const config = getExportConfigFromAppState(appState);

  if (format === "png") {
    return exportScene({
      type: "png",
      data: exportData,
      config: { ...config, embedScene: true },
    });
  }
  if (format === "svg") {
    const svg = await exportScene({
      type: "svg",
      data: exportData,
      config: { ...config, embedScene: true },
    });
    return new Blob([new XMLSerializer().serializeToString(svg)], {
      type: MIME_TYPES.svg,
    });
  }

  const jpeg = await exportScene({
    type: "jpeg",
    data: exportData,
    config: { ...config, scale: PDF_RENDER_SCALE },
  });
  const bitmap = await createImageBitmap(jpeg);
  const { width, height } = bitmap;
  bitmap.close();
  return jpegToPdf(new Uint8Array(await jpeg.arrayBuffer()), width, height);
};

/**
 * Wraps a JPEG into a single-page PDF sized to the image. PDF readers decode
 * JPEG natively (DCTDecode), so no re-encoding or PDF library is needed.
 */
export const jpegToPdf = (
  jpeg: Uint8Array,
  pixelWidth: number,
  pixelHeight: number,
): Blob => {
  const pageWidth = ((pixelWidth / PDF_RENDER_SCALE) * PX_TO_PT).toFixed(2);
  const pageHeight = ((pixelHeight / PDF_RENDER_SCALE) * PX_TO_PT).toFixed(2);
  const content = `q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`;

  const encoder = new TextEncoder();
  const chunks: BlobPart[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes as BlobPart);
    length += bytes.length;
  };
  const object = (body: string) => {
    offsets.push(length);
    push(`${offsets.length} 0 obj\n${body}\nendobj\n`);
  };

  push("%PDF-1.4\n");
  object("<< /Type /Catalog /Pages 2 0 R >>");
  object("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
  );
  offsets.push(length);
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pixelWidth} ` +
      `/Height ${pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 ` +
      `/Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  push(jpeg);
  push("\nendstream\nendobj\n");
  object(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);

  const xrefOffset = length;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`);
  for (const offset of offsets) {
    push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  }
  push(
    `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );

  return new Blob(chunks, { type: "application/pdf" });
};

export const downloadBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // give the browser time to start the download before revoking
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

/** Bundles files into a zip; paths may contain "/" for folders. */
export const zipFiles = async (
  files: { path: string; blob: Blob }[],
): Promise<Blob> => {
  const entries: Record<string, Uint8Array> = {};
  for (const { path, blob } of files) {
    let unique = path;
    for (let n = 2; unique in entries; n++) {
      const ext = getExtension(path);
      unique = ext ? `${stripExtension(path)} (${n}).${ext}` : `${path} (${n})`;
    }
    entries[unique] = new Uint8Array(await blob.arrayBuffer());
  }
  const zipped = await new Promise<Uint8Array>((resolve, reject) =>
    // images and PDFs are already compressed; JSON benefits from deflate
    zip(entries, { level: 6 }, (error, data) =>
      error ? reject(error) : resolve(data),
    ),
  );
  return new Blob([zipped as BlobPart], { type: "application/zip" });
};

// -----------------------------------------------------------------------------
// import
// -----------------------------------------------------------------------------

/** A file to import and the folder path (relative to the target) it goes in. */
export type ImportEntry = { file: File; folderPath: string[] };

export const isImportable = (fileName: string) =>
  IMPORTABLE_EXTENSIONS.includes(getExtension(fileName));

/**
 * Splits a relative path such as "Work/Client/plan.excalidraw" into its folder
 * segments.
 */
const toEntry = (file: File, relativePath: string): ImportEntry => {
  const segments = relativePath.split("/").filter(Boolean);
  return { file, folderPath: segments.slice(0, -1) };
};

const expandZip = async (file: File, folderPath: string[]) => {
  const entries: ImportEntry[] = [];
  const unzipped = unzipSync(new Uint8Array(await file.arrayBuffer()));
  for (const [path, bytes] of Object.entries(unzipped)) {
    const name = path.split("/").pop() || "";
    // skip directories and macOS resource forks
    if (!name || path.startsWith("__MACOSX/") || !isImportable(name)) {
      continue;
    }
    const entry = toEntry(new File([bytes as BlobPart], name), path);
    entries.push({
      ...entry,
      folderPath: [...folderPath, ...entry.folderPath],
    });
  }
  return entries;
};

const expandZips = async (entries: ImportEntry[]) => {
  const expanded: ImportEntry[] = [];
  for (const entry of entries) {
    if (getExtension(entry.file.name) === "zip") {
      expanded.push(
        ...(await expandZip(entry.file, [
          ...entry.folderPath,
          stripExtension(entry.file.name),
        ])),
      );
    } else {
      expanded.push(entry);
    }
  }
  return expanded;
};

/** From an <input type="file"> (with or without `webkitdirectory`). */
export const entriesFromFileList = (files: FileList | File[]) =>
  expandZips(
    Array.from(files).map((file) =>
      toEntry(file, file.webkitRelativePath || file.name),
    ),
  );

const readDirectoryEntries = (directory: FileSystemDirectoryEntry) =>
  new Promise<FileSystemEntry[]>((resolve, reject) => {
    const reader = directory.createReader();
    const all: FileSystemEntry[] = [];
    // readEntries returns results in batches until it returns an empty one
    const readBatch = () =>
      reader.readEntries((batch) => {
        if (!batch.length) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    readBatch();
  });

const walkEntry = async (
  entry: FileSystemEntry,
  folderPath: string[],
): Promise<ImportEntry[]> => {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    return [{ file, folderPath }];
  }
  if (entry.isDirectory) {
    const children = await readDirectoryEntries(
      entry as FileSystemDirectoryEntry,
    );
    const nested = await Promise.all(
      children.map((child) => walkEntry(child, [...folderPath, entry.name])),
    );
    return nested.flat();
  }
  return [];
};

/** From a drag & drop of files and/or folders from the OS. */
export const entriesFromDataTransfer = async (dataTransfer: DataTransfer) => {
  // entries must be grabbed synchronously, before the event handler returns
  const roots = Array.from(dataTransfer.items)
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry);
  if (!roots.length) {
    return entriesFromFileList(dataTransfer.files);
  }
  const nested = await Promise.all(roots.map((root) => walkEntry(root, [])));
  return expandZips(nested.flat());
};

/**
 * Reads a scene from a .excalidraw/.json file or a PNG/SVG with an embedded
 * scene. Returns null for anything that isn't an Excalidraw scene.
 */
export const parseImportFile = async (
  file: File,
): Promise<CanvasData | null> => {
  if (!isImportable(file.name)) {
    return null;
  }
  try {
    const scene = await loadFromBlob(file, null, null);
    return {
      elements: scene.elements,
      // the viewport fields (width, height, offsets) are left for the editor
      // to fill in from the window the canvas is opened in
      appState: {
        ...restoreAppState(scene.appState, null),
        name: stripExtension(file.name),
      } as AppState,
      files: scene.files,
    };
  } catch (error) {
    console.warn(`Skipping ${file.name}: not an Excalidraw scene`, error);
    return null;
  }
};
