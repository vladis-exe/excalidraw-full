import { nanoid } from "nanoid";

import { dehydrateCanvasData, hydrateCanvasData } from "../storage";

import { generateThumbnail } from "../thumbnail";

import type {
  CanvasData,
  CanvasMetadata,
  FolderMetadata,
  IStorageAdapter,
} from "../storage";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const API_BASE_URL = "/api/v2/kv";
const FOLDERS_URL = "/api/v2/folders";

const getAuthHeaders = () => {
  const token = localStorage.getItem("token");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

export class BackendStorageAdapter implements IStorageAdapter {
  async listCanvases(): Promise<CanvasMetadata[]> {
    const response = await fetch(API_BASE_URL, {
      method: "GET",
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        // For list, we can just return an empty array as if the user has no canvases.
        // This prevents an error popup when a logged-out user opens the app.
        return [];
      }
      throw new Error(`Failed to list canvases: ${response.statusText}`);
    }
    // Backend doesn't send userId, so we enrich the data here.
    const canvases: Omit<CanvasMetadata, "userId">[] = await response.json();
    const token = localStorage.getItem("token");
    if (!token) {
      return [];
    }

    return canvases;
  }

  async loadCanvas(id: string): Promise<CanvasData | null> {
    const response = await fetch(`${API_BASE_URL}/${id}`, {
      method: "GET",
      headers: getAuthHeaders(),
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AuthError("User is not authenticated");
      }
      throw new Error(`Failed to load canvas: ${response.statusText}`);
    }
    const rawData = await response.json();
    return hydrateCanvasData(rawData);
  }

  async saveCanvas(id: string, data: CanvasData): Promise<void> {
    return this.putCanvas(id, data);
  }

  /**
   * @param folderId only sent when placing a new canvas; plain saves leave it
   * out so the server keeps the canvas where it is.
   */
  private async putCanvas(
    id: string,
    data: CanvasData,
    folderId?: string | null,
  ): Promise<void> {
    let dataForUpload: CanvasData;
    if (data.thumbnail) {
      dataForUpload = data;
    } else {
      const thumbnail = await generateThumbnail(
        data.elements,
        data.appState,
        data.files,
      );
      dataForUpload = {
        ...data,
        thumbnail: data.elements.length > 0 ? thumbnail : undefined,
      };
    }
    const saveData =
      folderId === undefined
        ? dehydrateCanvasData(dataForUpload)
        : { ...dehydrateCanvasData(dataForUpload), folderId: folderId ?? "" };

    const response = await fetch(`${API_BASE_URL}/${id}`, {
      method: "PUT",
      headers: getAuthHeaders(),
      body: JSON.stringify(saveData),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AuthError("User is not authenticated");
      }
      throw new Error(`Failed to save canvas:  ${response.statusText}`);
    }
  }

  async createCanvas(
    data: CanvasData,
    folderId?: string | null,
  ): Promise<CanvasMetadata> {
    const newId = nanoid();
    const token = localStorage.getItem("token");
    if (!token) {
      throw new Error("Authentication token not found.");
    }
    const thumbnail = await generateThumbnail(
      data.elements,
      data.appState,
      data.files,
    );
    const dataWithThumbnail: CanvasData = {
      ...data,
      thumbnail: data.elements.length > 0 ? thumbnail : undefined,
    };

    await this.putCanvas(newId, dataWithThumbnail, folderId ?? null);
    return {
      id: newId,
      name: data.appState?.name || "Untitled",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      thumbnail: dataWithThumbnail.thumbnail,
      folderId: folderId ?? null,
    };
  }

  async deleteCanvas(id: string): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/${id}`, {
      method: "DELETE",
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AuthError("User is not authenticated");
      }
      throw new Error(`Failed to delete canvas: ${response.statusText}`);
    }
  }

  async renameCanvas(id: string, newName: string): Promise<void> {
    const canvasData = await this.loadCanvas(id);
    if (!canvasData) {
      throw new Error("Canvas not found, cannot rename.");
    }

    const updatedData: CanvasData = {
      ...canvasData,
      appState: {
        ...canvasData.appState,
        name: newName,
      },
    };

    await this.saveCanvas(id, updatedData);
  }

  async moveCanvas(id: string, folderId: string | null): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/${id}`, {
      method: "PATCH",
      headers: getAuthHeaders(),
      body: JSON.stringify({ folderId: folderId ?? "" }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AuthError("User is not authenticated");
      }
      throw new Error(`Failed to move canvas: ${response.statusText}`);
    }
  }

  async listFolders(): Promise<FolderMetadata[]> {
    if (!localStorage.getItem("token")) {
      return [];
    }
    const response = await fetch(FOLDERS_URL, {
      method: "GET",
      headers: getAuthHeaders(),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return [];
      }
      throw new Error(`Failed to list folders: ${response.statusText}`);
    }
    return response.json();
  }

  async saveFolders(folders: FolderMetadata[]): Promise<void> {
    const response = await fetch(FOLDERS_URL, {
      method: "PUT",
      headers: getAuthHeaders(),
      body: JSON.stringify(folders),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new AuthError("User is not authenticated");
      }
      const { error } = await response
        .json()
        .catch(() => ({ error: response.statusText }));
      throw new Error(`Failed to save folders: ${error}`);
    }
  }
}
