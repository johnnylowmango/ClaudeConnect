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
}

export interface ServerState {
  devices: Map<string, DeviceInfo>;
  messages: ConnectMessage[];
  tasks: TaskItem[];
  clipboard: ClipboardEntry[];
}

export const DEFAULT_PORT = 3377;
export const MAX_MESSAGES = 500;
export const MAX_CLIPBOARD = 50;
