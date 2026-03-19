// Shared types for Claude Connect

export interface ConnectMessage {
  id: string;
  type: 'context' | 'task' | 'clipboard' | 'status' | 'chat';
  from: string;       // device name
  to?: string;        // target device, or broadcast if undefined
  timestamp: number;
  payload: any;
}

export interface ContextUpdate {
  summary: string;         // what Claude just did
  activeFiles: string[];   // files being worked on
  currentTask?: string;    // what's in progress
  workingDirectory: string;
}

export interface TaskItem {
  id: string;
  title: string;
  status: 'pending' | 'in-progress' | 'done';
  assignedTo?: string;     // device name
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  notes?: string;
}

export interface ClipboardEntry {
  id: string;
  content: string;
  label?: string;
  createdBy: string;
  createdAt: number;
}

export interface DeviceInfo {
  name: string;
  platform: string;
  connectedAt: number;
  lastSeen: number;
  status: 'online' | 'away' | 'offline';
  projectPath?: string;
}

export interface ServerState {
  devices: Map<string, DeviceInfo>;
  messages: ConnectMessage[];
  tasks: TaskItem[];
  clipboard: ClipboardEntry[];
}

// File sync types
export interface FileManifestEntry {
  path: string;           // forward-slash normalized relative path
  size: number;
  quickHash: string;      // SHA-256 prefix of first 4KB + last 4KB + size
  modifiedAt: number;
}

export interface FileChunk {
  syncId: string;         // groups chunks for one sync operation
  filePath: string;       // relative path (forward slashes)
  chunkIndex: number;
  totalChunks: number;
  data: string;           // base64
  fileSize: number;
}

export type FileSyncPhase = 'idle' | 'scanning' | 'comparing' | 'transferring' | 'writing' | 'done' | 'error';

export interface FileSyncStatus {
  syncId: string;
  phase: FileSyncPhase;
  totalFiles: number;
  completedFiles: number;
  currentFile?: string;
  error?: string;
}

export interface ProjectConfig {
  projectPath: string;
  deviceName: string;
}

export interface BadgeCounts {
  messages: number;
  tasks: number;
  clipboard: number;
  files: number;
}

export const DEFAULT_PORT = 3377;
export const MAX_MESSAGES = 500;
export const MAX_CLIPBOARD = 50;
export const FILE_CHUNK_SIZE = 768 * 1024; // 768KB raw → ~1MB base64
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB per file limit

export const IGNORE_PATTERNS = [
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '.cache', '.parcel-cache', 'coverage', '.nyc_output',
  '__pycache__', '.pytest_cache', 'venv', '.venv', 'env',
  '.DS_Store', 'Thumbs.db', '.env', '.env.local',
  '*.log', '*.lock', '*.tgz', '*.map',
];
