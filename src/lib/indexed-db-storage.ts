// Copyright (c) 2025 hotflow2024
// Licensed under AGPL-3.0-or-later. See LICENSE for details.
// Commercial licensing available. See COMMERCIAL_LICENSE.md.
/**
 * File Storage Adapter for Zustand
 * Uses Electron's file system for unlimited storage
 * Falls back to localStorage in browser
 */

import type { StateStorage } from 'zustand/middleware';

// Type declarations for the fileStorage API exposed by preload
declare global {
  interface Window {
    fileStorage?: {
      getItem: (key: string) => Promise<string | null>;
      setItem: (key: string, value: string) => Promise<boolean>;
      removeItem: (key: string) => Promise<boolean>;
      exists: (key: string) => Promise<boolean>;
      listKeys: (prefix: string) => Promise<string[]>;
      listDirs: (prefix: string) => Promise<string[]>;
      removeDir: (prefix: string) => Promise<boolean>;
    };
  }
}

const isElectron = (): boolean => {
  return typeof window !== 'undefined' && !!window.fileStorage;
};

// Check if data has meaningful content (not just empty state)
const hasRichData = (jsonStr: string | null): boolean => {
  if (!jsonStr) return false;
  try {
    const data = JSON.parse(jsonStr);
    const state = data.state || data;
    
    // Check common store patterns for meaningful data
    if (state.projects && Array.isArray(state.projects) && state.projects.length > 1) return true;
    if (state.splitScenes && Array.isArray(state.splitScenes) && state.splitScenes.length > 0) return true;
    if (state.scenes && Array.isArray(state.scenes) && state.scenes.length > 0) return true;
    if (state.episodes && Array.isArray(state.episodes) && state.episodes.length > 0) return true;
    if (state.characters && Array.isArray(state.characters) && state.characters.length > 0) return true;
    if (state.media && Array.isArray(state.media) && state.media.length > 0) return true;
    
    // For director store, check nested project data
    if (state.projects && typeof state.projects === 'object') {
      for (const projectId of Object.keys(state.projects)) {
        const proj = state.projects[projectId];
        if (proj.splitScenes && proj.splitScenes.length > 0) return true;
        if (proj.screenplay) return true;
      }
    }
    
    // Check data size as fallback (more than 1KB likely has real data)
    return jsonStr.length > 1000;
  } catch {
    return jsonStr.length > 1000;
  }
};

const pendingWrites = new Map<string, Promise<void>>();
const writeErrors = new Map<string, unknown>();

/** Resolve only after queued writes have actually finished; surface failed saves. */
export async function flushFileStorage(name?: string): Promise<void> {
  while (true) {
    const writes = name ? [pendingWrites.get(name)].filter(Boolean) : [...pendingWrites.values()];
    if (!writes.length) break;
    await Promise.all(writes);
  }
  if (name) {
    if (writeErrors.has(name)) throw writeErrors.get(name);
  } else if (writeErrors.size) {
    throw writeErrors.values().next().value;
  }
}

export const fileStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    await flushFileStorage(name);
    console.log(`[Storage] getItem: ${name}, isElectron: ${isElectron()}`);
    if (isElectron()) {
      try {
        // Get data from all sources
        const fileData = await window.fileStorage!.getItem(name);
        const localData = localStorage.getItem(name);
        let idbData: string | null = null;
        try {
          idbData = await getFromIndexedDB(name);
        } catch (e) {
          // IndexedDB not available
        }
        
        console.log(`[Storage] Data sizes for ${name}: file=${fileData?.length || 0}, local=${localData?.length || 0}, idb=${idbData?.length || 0}`);
        
        // Determine which data source has the richest data
        const fileHasData = hasRichData(fileData);
        const localHasData = hasRichData(localData);
        const idbHasData = hasRichData(idbData);
        
        console.log(`[Storage] Rich data check for ${name}: file=${fileHasData}, local=${localHasData}, idb=${idbHasData}`);
        
        // Priority: localStorage > IndexedDB > file (for migration)
        // If localStorage or IndexedDB has richer data, migrate it
        if (localHasData && !fileHasData) {
          console.log(`[Storage] Migrating ${name} from localStorage to file storage (richer data)...`);
          await window.fileStorage!.setItem(name, localData!);
          localStorage.removeItem(name);
          console.log(`[Storage] Migration complete for ${name}`);
          return localData;
        }
        
        if (idbHasData && !fileHasData && !localHasData) {
          console.log(`[Storage] Migrating ${name} from IndexedDB to file storage (richer data)...`);
          await window.fileStorage!.setItem(name, idbData!);
          await removeFromIndexedDB(name);
          console.log(`[Storage] Migration complete for ${name}`);
          return idbData;
        }
        
        // Clean up old data if file storage has the data
        if (fileHasData) {
          if (localData) {
            console.log(`[Storage] Cleaning up localStorage for ${name}`);
            localStorage.removeItem(name);
          }
          if (idbData) {
            console.log(`[Storage] Cleaning up IndexedDB for ${name}`);
            await removeFromIndexedDB(name);
          }
          return fileData;
        }
        
        // Return whatever we have
        return fileData || localData || idbData || null;
      } catch (error) {
        console.error('File storage getItem error:', error);
      }
    }
    // Fallback to localStorage (browser mode)
    return localStorage.getItem(name);
  },

  setItem: (name: string, value: string): Promise<void> => {
    const previous = pendingWrites.get(name) || Promise.resolve();
    const write = previous.then(async () => {
      if (isElectron()) {
        const saved = await window.fileStorage!.setItem(name, value);
        if (!saved) throw new Error(`项目保存失败: ${name}`);
      } else {
        localStorage.setItem(name, value);
      }
      writeErrors.delete(name);
    }).catch((error) => {
      // Zustand does not await persistence. Keep the error for an explicit flush.
      writeErrors.set(name, error);
      console.error('[Storage] Save failed:', name, error);
    }).finally(() => {
      if (pendingWrites.get(name) === write) pendingWrites.delete(name);
    });
    pendingWrites.set(name, write);
    return write;
  },

  removeItem: async (name: string): Promise<void> => {
    if (isElectron()) {
      try {
        await window.fileStorage!.removeItem(name);
        return;
      } catch (error) {
        console.error('File storage removeItem error:', error);
      }
    }
    localStorage.removeItem(name);
  },
};

// Helper to get data from IndexedDB (for migration)
const getFromIndexedDB = (name: string): Promise<string | null> => {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open('moyin-creator-db', 1);
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('zustand-storage')) {
          resolve(null);
          return;
        }
        const transaction = db.transaction('zustand-storage', 'readonly');
        const store = transaction.objectStore('zustand-storage');
        const getRequest = store.get(name);
        getRequest.onerror = () => resolve(null);
        getRequest.onsuccess = () => resolve(getRequest.result ?? null);
      };
    } catch {
      resolve(null);
    }
  });
};

const removeFromIndexedDB = (name: string): Promise<void> => {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open('moyin-creator-db', 1);
      request.onerror = () => resolve();
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('zustand-storage')) {
          resolve();
          return;
        }
        const transaction = db.transaction('zustand-storage', 'readwrite');
        const store = transaction.objectStore('zustand-storage');
        store.delete(name);
        resolve();
      };
    } catch {
      resolve();
    }
  });
};

// Migration helper (kept for backward compatibility, but migration now happens in getItem)
export const migrateFromLocalStorage = async (_key: string): Promise<void> => {
  // Migration now happens automatically in fileStorage.getItem
};

// For backward compatibility
export const indexedDBStorage = fileStorage;
