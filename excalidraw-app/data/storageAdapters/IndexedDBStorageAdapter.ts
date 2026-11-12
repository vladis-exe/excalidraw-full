import { createStore, set, get, del, entries } from "idb-keyval";

import { generateThumbnail } from "../thumbnail";
import { randomUUID } from "../random";

import type {
  CanvasData,
  CanvasMetadata,
  FolderMetadata,
  IStorageAdapter,
} from "../storage";

const metadataStore = createStore("excalidraw-canvases-metadata", "metadata");
const dataStore = createStore("excalidraw-canvases-data", "data");
const folderStore = createStore("excalidraw-canvases-folders", "folders");
const FOLDERS_KEY = "tree";

export class IndexedDBStorageAdapter implements IStorageAdapter {
  async listCanvases(): Promise<CanvasMetadata[]> {
    const allEntries = await entries<string, CanvasMetadata>(metadataStore);
    return allEntries.map(([, metadata]) => metadata);
  }

  async loadCanvas(id: string): Promise<CanvasData | null> {
    const data = await get<CanvasData>(id, dataStore);
    return data === undefined ? null : data;
  }

  async saveCanvas(id: string, data: CanvasData): Promise<void> {
    const existingMetadata = await get<CanvasMetadata>(id, metadataStore);
    if (!existingMetadata) {
      throw new Error("Canvas metadata not found. Cannot save.");
    }
    const thumbnail = await generateThumbnail(
      data.elements,
      data.appState,
      data.files,
    );

    const updatedMetadata: CanvasMetadata = {
      ...existingMetadata,
      name: data.appState.name || existingMetadata.name,
      updatedAt: new Date().toISOString(),
      thumbnail: data.elements.length > 0 ? thumbnail : undefined,
    };

    await set(id, updatedMetadata, metadataStore);
    await set(id, data, dataStore);
  }

  async createCanvas(
    data: CanvasData,
    folderId?: string | null,
  ): Promise<CanvasMetadata> {
    const newId = randomUUID();
    const now = new Date().toISOString();
    const thumbnail = await generateThumbnail(
      data.elements,
      data.appState,
      data.files,
    );

    const newMetadata: CanvasMetadata = {
      id: newId,
      name: data.appState.name || "Untitled Canvas",
      createdAt: now,
      updatedAt: now,
      thumbnail: data.elements.length > 0 ? thumbnail : undefined,
      folderId: folderId ?? null,
    };

    await set(newId, newMetadata, metadataStore);
    await set(newId, data, dataStore);

    return newMetadata;
  }

  async deleteCanvas(id: string): Promise<void> {
    await del(id, metadataStore);
    await del(id, dataStore);
  }

  async renameCanvas(id: string, newName: string): Promise<void> {
    // Update metadata
    const existingMetadata = await get<CanvasMetadata>(id, metadataStore);
    if (!existingMetadata) {
      throw new Error("Canvas metadata not found. Cannot rename.");
    }
    await set(id, { ...existingMetadata, name: newName }, metadataStore);

    // Update canvas data
    const existingData = await get<CanvasData>(id, dataStore);
    if (!existingData) {
      // This should not happen if metadata exists, but as a safeguard:
      throw new Error("Canvas data not found. Cannot rename.");
    }
    await set(
      id,
      {
        ...existingData,
        appState: { ...existingData.appState, name: newName },
      },
      dataStore,
    );
  }

  async moveCanvas(id: string, folderId: string | null): Promise<void> {
    const existingMetadata = await get<CanvasMetadata>(id, metadataStore);
    if (!existingMetadata) {
      throw new Error("Canvas metadata not found. Cannot move.");
    }
    await set(id, { ...existingMetadata, folderId }, metadataStore);
  }

  async listFolders(): Promise<FolderMetadata[]> {
    return (await get<FolderMetadata[]>(FOLDERS_KEY, folderStore)) ?? [];
  }

  async saveFolders(folders: FolderMetadata[]): Promise<void> {
    await set(FOLDERS_KEY, folders, folderStore);
  }
}
