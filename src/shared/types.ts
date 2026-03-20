// Shared types for Claude Connect

export interface ConnectMessage {
  id: string;
  type: 'context' | 'task' | 'clipboard' | 'status' | 'chat' | 'work-update';
  from: string;
  to?: string;
  timestamp: number;
  payload: any;
}

export interface ContextUpdate {
  summary: string;
  activeFiles: string[];
  currentTask?: string;
  workingDirectory: string;
}

export interface TaskItem {
  id: string;
  title: string;
  status: 'pending' | 'in-progress' | 'done';
  assignedTo?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  notes?: string;
  projectId?: string;
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
  activeProjectId?: string;
  activeProjectName?: string;
}

export interface ServerState {
  devices: Map<string, DeviceInfo>;
  messages: ConnectMessage[];
  tasks: TaskItem[];
  clipboard: ClipboardEntry[];
}

// --- Project & Workspace types ---

export interface ProjectEntry {
  id: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
  devices: { [deviceName: string]: DeviceProjectState };
}

export interface DeviceProjectState {
  localPath: string;
  lastSynced: number;
  status: 'synced' | 'behind' | 'ahead' | 'unknown';
}

export interface WorkspaceConfig {
  root: string;
  projects: ProjectEntry[];
  activeProjectId: string | null;
}

// File sync types
export interface FileManifestEntry {
  path: string;
  size: number;
  quickHash: string;
  modifiedAt: number;
}

export interface FileChunk {
  syncId: string;
  filePath: string;
  chunkIndex: number;
  totalChunks: number;
  data: string;
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

// Command Center types
export interface TerminalBinding {
  terminalId: number;
  deviceName: string;
  boundAt: number;
}

export interface CommandPrompt {
  id: string;
  text: string;
  targets: string[];
  timestamp: number;
  from: 'user' | string;
}

export interface CommandResponse {
  id: string;
  promptId: string;
  deviceName: string;
  text: string;
  timestamp: number;
  streaming: boolean;
  collapsed: boolean;
}

export interface CommandEvent {
  id: string;
  type: 'info' | 'sync' | 'error';
  text: string;
  timestamp: number;
}

export type CommandEntry =
  | { kind: 'prompt'; data: CommandPrompt }
  | { kind: 'response'; data: CommandResponse }
  | { kind: 'event'; data: CommandEvent };

export const DEFAULT_PORT = 3377;
export const MAX_MESSAGES = 500;
export const MAX_CLIPBOARD = 50;
export const FILE_CHUNK_SIZE = 768 * 1024;
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

export const IGNORE_PATTERNS = [
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '.cache', '.parcel-cache', 'coverage', '.nyc_output',
  '__pycache__', '.pytest_cache', 'venv', '.venv', 'env',
  '.DS_Store', 'Thumbs.db', '.env', '.env.local',
  '.claude-connect-inbox',
  '*.log', '*.lock', '*.tgz', '*.map',
];
