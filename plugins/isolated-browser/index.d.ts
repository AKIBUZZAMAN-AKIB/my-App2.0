import type { Plugin, PluginListenerHandle } from '@capacitor/core';

export interface StageMetadata {
  appId: string;
  integrity: string;
  entry: string;
  fileCount: number;
  totalBytes: number;
}

export interface IsolatedBrowserEvent {
  sessionId: string;
  appId?: string;
  token?: string;
  origin?: string;
  request?: string;
  state?: string;
  reason?: string;
}

export interface NativeKitIsolatedBrowserPlugin extends Plugin {
  runtimeInfo(): Promise<{ supported: boolean; platform: string; apiLevel?: number; persistentPartitions: boolean; profilePartitions?: boolean; completeSiteDataDeletion?: boolean }>;
  isStaged(options: { appId: string; integrity: string }): Promise<{ staged: boolean }>;
  beginStage(options: StageMetadata): Promise<{ stageId: string }>;
  writeStageChunk(options: { stageId: string; path: string; offset: number; data: string; final: boolean }): Promise<{ bytesWritten: number }>;
  commitStage(options: { stageId: string }): Promise<{ origin: string }>;
  abortStage(options: { stageId: string }): Promise<void>;
  removeStagedApp(options: { appId: string }): Promise<void>;
  open(options: {
    sessionId: string;
    token: string;
    appId: string;
    title: string;
    integrity: string;
    entry: string;
    bootstrap: string;
    allowedHosts: string[];
    allowDirectNetwork: boolean;
    /** Per-app network mode: 'sandboxed' blocks all remote traffic, 'hosts' allows approved hosts, 'full' allows open HTTPS/WSS internet (owner-approved). */
    networkMode?: 'sandboxed' | 'hosts' | 'full';
    /** When true, media may autoplay without a user gesture in this isolated renderer. */
    mediaAutoplay?: boolean;
    /** Status/navigation bar icon contrast for the isolated window. Default 'dark' = dark bars with light icons. */
    colorScheme?: 'dark' | 'light';
    hangTerminationDelayMs: number;
  }): Promise<{ origin: string }>;
  openUrl(options: { sessionId: string; url: string; title?: string; allowedHosts: string[] }): Promise<{ sessionId: string }>;
  closeUrl(options: { sessionId: string }): Promise<void>;
  requestPermission(options: {
    sessionId: string;
    requestId: string;
    appName: string;
    capability: string;
    method: string;
    argumentSummary: string;
    timeoutMs: number;
  }): Promise<{ shown: true; action: 'allow_once' | 'allow_always' | 'block_once' | 'block_always' }>;
  dismissPermission(options: { sessionId: string; requestId: string }): Promise<void>;
  postMessage(options: { sessionId: string; message: string }): Promise<void>;
  close(options: { sessionId: string }): Promise<void>;
  addListener(eventName: 'isolatedBrowserRequest', listenerFunc: (event: IsolatedBrowserEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'isolatedBrowserStatus', listenerFunc: (event: IsolatedBrowserEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'remoteBrowserStatus', listenerFunc: (event: IsolatedBrowserEvent) => void): Promise<PluginListenerHandle>;
}

export declare const NativeKitIsolatedBrowser: NativeKitIsolatedBrowserPlugin;
