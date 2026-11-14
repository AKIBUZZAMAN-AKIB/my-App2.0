import type { Plugin, PluginListenerHandle } from '@capacitor/core';

export interface NativeKitCustomPlugin extends Plugin {
  checkAlarmCapabilities(): Promise<Record<string, any>>;
  requestExactAlarmAccess(): Promise<void>;
  requestFullScreenIntentAccess(): Promise<void>;
  scheduleAlarm(options: Record<string, any>): Promise<Record<string, any>>;
  cancelAlarm(options: { id: string }): Promise<void>;
  listAlarms(): Promise<{ alarms: any[] }>;
  stopRinging(options: { id?: string }): Promise<void>;
  startSSE(options: Record<string, any> & { streamId: string; url: string }): Promise<void>;
  stopSSE(options: { streamId: string }): Promise<void>;
  secureSet(options: { key: string; value: string }): Promise<void>;
  secureGet(options: { key: string }): Promise<{ value: string | null }>;
  secureRemove(options: { key: string }): Promise<void>;
  secureClear(): Promise<void>;
  startBackgroundLocation(options: Record<string, any>): Promise<Record<string, any>>;
  stopBackgroundLocation(): Promise<void>;
  getBackgroundLocationStatus(): Promise<Record<string, any>>;
  getBufferedLocations(): Promise<Record<string, any>>;
  clearBufferedLocations(): Promise<void>;
  openAppSettings(): Promise<void>;
  /** Opens a validated https: URL with the system browser/app; rejects when nothing can open it. */
  openUrl(options: { url: string }): Promise<void>;
  ttsSpeak(options: { text: string; language?: string; pitch?: number; rate?: number }): Promise<{ queued?: boolean; languageSupported?: boolean }>;
  /** Verifies the device owner with fingerprint/face; rejects (fails closed) when unavailable. */
  verifyBiometric(options?: { reason?: string }): Promise<{ verified: boolean }>;
  ttsStop(): Promise<void>;
  listenSpeech(options: { language?: string; timeoutMs?: number }): Promise<{ text: string; confidence?: number }>;
  scanQrCode(): Promise<{ text: string; format?: string }>;
  dialPhone(options: { number: string }): Promise<void>;
  composeSms(options: { number: string; body?: string }): Promise<void>;
  setTorch(options: { on: boolean }): Promise<void>;
  batteryStatus(): Promise<{ percent?: number; charging?: boolean; plugged?: boolean }>;
  pickDocument(): Promise<{ path: string; bytes?: number }>;
  /**
   * Shared folders (Android: Storage Access Framework tree grants; iOS: folder
   * bookmarks). Paths are relative to the granted folder; errors reject with a
   * code (REVOKED, READ_ONLY, NOT_FOUND, EXISTS, BAD_PATH, TOO_LARGE, ...).
   */
  folderAdd(options?: { mode?: 'read' | 'readwrite' }): Promise<{ folder: SharedFolder }>;
  folderList(): Promise<{ folders: SharedFolder[] }>;
  folderSetMode(options: { id: string; mode: 'read' | 'readwrite' }): Promise<{ mode: 'read' | 'readwrite' }>;
  folderRemove(options: { id: string }): Promise<{ removed: boolean }>;
  folderListDir(options: { id: string; path: string; limit?: number }): Promise<{ entries: SharedFolderEntry[]; truncated?: boolean }>;
  folderStat(options: { id: string; path: string }): Promise<SharedFolderEntry & { exists: boolean }>;
  folderRead(options: { id: string; path: string; offset: number; length: number }): Promise<{ data: string; size: number; bytesRead: number; eof: boolean }>;
  folderWrite(options: { id: string; path: string; data: string; overwrite: boolean }): Promise<{ size: number; created: boolean }>;
  folderMkdir(options: { id: string; path: string }): Promise<{ created: boolean }>;
  folderDelete(options: { id: string; path: string; recursive: boolean }): Promise<{ deleted: boolean }>;
  folderMove(options: { id: string; path: string; to: string; overwrite: boolean }): Promise<{ path: string }>;
  folderCopyToWorkspace(options: { id: string; path: string; dest: string; overwrite: boolean; maxBytes: number }): Promise<{ bytes: number }>;
  folderCopyFromWorkspace(options: { id: string; src: string; path: string; overwrite: boolean; maxBytes: number }): Promise<{ bytes: number }>;
  folderFind(options: { id: string; path: string; query: string; limit: number; maxDepth: number }): Promise<{ matches: SharedFolderEntry[]; scanned: number; truncated: boolean }>;
  clipboardSetText(options: { text: string }): Promise<void>;
  clipboardGetText(): Promise<{ text: string }>;
  addListener(eventName: 'nativeSSEData' | 'nativeSSEEnd' | 'nativeSSEError' | 'nativeLocation' | 'nativeAlarmFired', listenerFunc: (event: any) => void): Promise<PluginListenerHandle>;
}

export interface SharedFolder { id: string; name: string; mode: 'read' | 'readwrite'; canWrite?: boolean; available?: boolean; reason?: string; location?: string; addedAt?: number }
export interface SharedFolderEntry { name: string; path?: string; type: 'file' | 'directory'; size?: number; modified?: number; mime?: string }

export declare const NativeKitCustom: NativeKitCustomPlugin;
