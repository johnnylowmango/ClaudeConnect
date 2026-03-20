import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { RelayServer } from '../server/relay';
import { RelayClient } from '../server/client';
import { DEFAULT_PORT, ProjectEntry } from '../shared/types';
import * as os from 'os';
import { buildManifest, readFileChunked, receiveChunk, diffManifests } from './file-sync';
import { WorkspaceManager } from './workspace-manager';
import { v4 as uuid } from 'uuid';

// node-pty is a native module — require it dynamically
let pty: any;
try {
  pty = require('node-pty');
} catch (err) {
  console.error('node-pty not available:', err);
}

let mainWindow: BrowserWindow | null = null;
let server: RelayServer | null = null;
let client: RelayClient | null = null;
let mcpInstalled = false;
let lastMcpDevice: string = '';
let lastMcpRole: string = '';
let lastMcpHost: string = '';

// Workspace manager
let workspace: WorkspaceManager | null = null;

// Convenience: get current project path from workspace
function getProjectPath(): string | null {
  if (!workspace) return null;
  return workspace.getActiveProjectPath(lastMcpDevice || os.hostname());
}

// Track active terminal processes
const terminals: Map<number, any> = new Map();
let nextTerminalId = 1;

// Command Center: terminal binding + injection queue
const deviceToTerminal: Map<string, number> = new Map();
const terminalIdleTimers: Map<number, NodeJS.Timeout> = new Map();
const terminalIdle: Map<number, boolean> = new Map();
const injectionQueue: Map<number, Array<{ text: string; promptId: string }>> = new Map();
const terminalOutputBuffers: Map<number, string> = new Map();
const IDLE_TIMEOUT_MS = 2000;

// File watcher for auto-sync
let fileWatcher: fs.FSWatcher | null = null;
let fileWatchDebounce: NodeJS.Timeout | null = null;

function markTerminalBusy(termId: number) {
  terminalIdle.set(termId, false);
  const existing = terminalIdleTimers.get(termId);
  if (existing) clearTimeout(existing);
  terminalIdleTimers.set(termId, setTimeout(() => {
    terminalIdle.set(termId, true);
    processInjectionQueue(termId);
  }, IDLE_TIMEOUT_MS));
}

function processInjectionQueue(termId: number) {
  if (!terminalIdle.get(termId)) return;
  const queue = injectionQueue.get(termId);
  if (!queue || queue.length === 0) return;

  const next = queue.shift()!;
  const term = terminals.get(termId);
  if (!term) return;

  terminalIdle.set(termId, false);
  term.write(next.text + '\n');

  mainWindow?.webContents.send('command-injected', {
    termId, promptId: next.promptId, text: next.text,
  });
}

function injectIntoTerminal(termId: number, text: string, promptId: string) {
  const idle = terminalIdle.get(termId);
  if (idle) {
    const term = terminals.get(termId);
    if (!term) return;
    terminalIdle.set(termId, false);
    term.write(text + '\n');
    mainWindow?.webContents.send('command-injected', {
      termId, promptId, text,
    });
  } else {
    if (!injectionQueue.has(termId)) injectionQueue.set(termId, []);
    injectionQueue.get(termId)!.push({ text, promptId });
  }
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/\r/g, '')
    .replace(/^[─━═╔╗╚╝║╠╣╬┌┐└┘├┤┬┴┼│─\s]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- MCP auto-config ---

function getClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

function getMcpServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'mcp', 'server.js');
  }
  return path.join(__dirname, '..', 'mcp', 'server.js');
}

function getNodePath(): string {
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ];

  const { execSync } = require('child_process');
  try {
    const resolved = execSync(process.platform === 'win32' ? 'where node' : 'which node', { encoding: 'utf8' }).trim().split('\n')[0];
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {}

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'node';
}

function installMcpConfig(deviceName: string, role: string, host: string) {
  lastMcpDevice = deviceName || os.hostname();
  lastMcpRole = role || '';
  lastMcpHost = host || 'localhost';

  const projectPath = getProjectPath();

  try {
    const configPath = getClaudeConfigPath();
    let config: any = {};

    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    config.mcpServers = config.mcpServers || {};
    config.mcpServers['claude-connect'] = {
      command: getNodePath(),
      args: [getMcpServerPath()],
      env: {
        CLAUDE_CONNECT_DEVICE: lastMcpDevice,
        CLAUDE_CONNECT_ROLE: lastMcpRole,
        CLAUDE_CONNECT_HOST: lastMcpHost,
        CLAUDE_CONNECT_PORT: String(DEFAULT_PORT),
        ...(projectPath ? { CLAUDE_CONNECT_PROJECT: projectPath } : {}),
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    mcpInstalled = true;
    console.log('MCP config installed' + (projectPath ? ` (project: ${projectPath})` : ''));
  } catch (err) {
    console.error('Failed to install MCP config:', err);
  }
}

function uninstallMcpConfig() {
  if (!mcpInstalled) return;
  try {
    const configPath = getClaudeConfigPath();
    if (!fs.existsSync(configPath)) return;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.mcpServers && config.mcpServers['claude-connect']) {
      delete config.mcpServers['claude-connect'];
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
    mcpInstalled = false;
  } catch (err) {
    console.error('Failed to remove MCP config:', err);
  }
}

// --- Auto-updater ---

function setupAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info: any) => {
      mainWindow?.webContents.send('updater-event', { event: 'update-available', version: info.version });
    });

    autoUpdater.on('update-not-available', () => {
      mainWindow?.webContents.send('updater-event', { event: 'update-not-available' });
    });

    autoUpdater.on('download-progress', (progress: any) => {
      mainWindow?.webContents.send('updater-event', { event: 'download-progress', percent: Math.round(progress.percent) });
    });

    autoUpdater.on('update-downloaded', () => {
      mainWindow?.webContents.send('updater-event', { event: 'update-downloaded' });
    });

    autoUpdater.on('error', (err: any) => {
      mainWindow?.webContents.send('updater-event', { event: 'error', error: err.message });
    });

    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 5000);

    ipcMain.handle('check-for-updates', async () => {
      try {
        const result = await autoUpdater.checkForUpdates();
        return { success: true, version: result?.updateInfo?.version };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('download-update', async () => {
      try { await autoUpdater.downloadUpdate(); return { success: true }; }
      catch (err: any) { return { success: false, error: err.message }; }
    });

    ipcMain.handle('install-update', async () => {
      autoUpdater.quitAndInstall();
      return { success: true };
    });
  } catch (err) {
    console.log('Auto-updater not available (dev mode)');
  }
}

// --- Window ---

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Claude Connect',
    frame: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:9000');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  // Initialize workspace
  workspace = new WorkspaceManager();
  createWindow();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  for (const [, term] of terminals) {
    try { term.kill(); } catch {}
  }
  terminals.clear();
  stopFileWatcher();
  server?.stop();
  client?.disconnect();
  uninstallMcpConfig();
  app.quit();
});

app.on('before-quit', () => {
  for (const [, term] of terminals) {
    try { term.kill(); } catch {}
  }
  terminals.clear();
  stopFileWatcher();
  uninstallMcpConfig();
});

// --- File Watcher for auto-sync ---

function startFileWatcher() {
  stopFileWatcher();
  const projectPath = getProjectPath();
  if (!projectPath || !client) return;

  try {
    fileWatcher = fs.watch(projectPath, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      // Skip ignored patterns
      const parts = filename.split(path.sep);
      const IGNORE = ['node_modules', '.git', 'dist', 'build', '.DS_Store', '.claude-connect-inbox'];
      if (parts.some(p => IGNORE.includes(p))) return;
      if (filename.endsWith('.log') || filename.endsWith('.lock') || filename.endsWith('.map')) return;

      // Debounce
      if (fileWatchDebounce) clearTimeout(fileWatchDebounce);
      fileWatchDebounce = setTimeout(() => {
        autoSyncChangedFiles();
      }, 1000);
    });
  } catch (err) {
    console.error('File watcher failed:', err);
  }
}

function stopFileWatcher() {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
  if (fileWatchDebounce) {
    clearTimeout(fileWatchDebounce);
    fileWatchDebounce = null;
  }
}

function autoSyncChangedFiles() {
  const projectPath = getProjectPath();
  if (!projectPath || !client) return;

  // Push to all connected devices
  const syncId = uuid();
  const manifest = buildManifest(projectPath);
  // Find all online devices that are not us
  // We broadcast a sync request; the relay will route it
  client.requestFileSync('__all__', syncId, manifest, 'push');

  mainWindow?.webContents.send('command-event', {
    id: `evt-${Date.now()}`,
    type: 'sync',
    text: 'Auto-syncing file changes to connected devices...',
    timestamp: Date.now(),
  });
}

// --- Terminal IPC ---

ipcMain.handle('terminal-create', async (_, cwd?: string) => {
  if (!pty) {
    return { success: false, error: 'Terminal not available' };
  }

  const id = nextTerminalId++;
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');

  const env: Record<string, string> = { ...process.env } as any;
  if (isWin) {
    const extraPaths = [
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
      path.join(os.homedir(), '.local', 'bin'),
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'nodejs'),
    ];
    env.PATH = [...extraPaths, env.PATH || ''].filter(Boolean).join(';');
  } else {
    const extraPaths = [
      path.join(os.homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ];
    env.PATH = [...extraPaths, ...(env.PATH || '').split(':')].filter(Boolean).join(':');
    env.TERM = 'xterm-256color';
  }

  const projectPath = getProjectPath();
  const term = pty.spawn(shell, isWin ? ['-NoLogo'] : ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: cwd || projectPath || os.homedir(),
    env,
  });

  terminals.set(id, term);

  term.onData((data: string) => {
    mainWindow?.webContents.send('terminal-data', { id, data });
    markTerminalBusy(id);
    const existing = terminalOutputBuffers.get(id) || '';
    terminalOutputBuffers.set(id, existing + data);
    const stripped = stripAnsi(data);
    if (stripped.trim() && stripped.length > 1) {
      mainWindow?.webContents.send('command-terminal-output', { termId: id, text: stripped });
      if (client && deviceToTerminal.has(lastMcpDevice)) {
        const boundId = deviceToTerminal.get(lastMcpDevice);
        if (boundId === id) {
          client.sendTerminalOutput(stripped);
        }
      }
    }
  });

  term.onExit(({ exitCode }: { exitCode: number }) => {
    mainWindow?.webContents.send('terminal-exit', { id, exitCode });
    terminals.delete(id);
    terminalIdle.delete(id);
    terminalOutputBuffers.delete(id);
    injectionQueue.delete(id);
    const timer = terminalIdleTimers.get(id);
    if (timer) clearTimeout(timer);
    terminalIdleTimers.delete(id);
    for (const [dev, tid] of deviceToTerminal) {
      if (tid === id) { deviceToTerminal.delete(dev); break; }
    }
  });

  return { success: true, id };
});

ipcMain.handle('terminal-write', async (_, id: number, data: string) => {
  const term = terminals.get(id);
  if (term) { term.write(data); return { success: true }; }
  return { success: false, error: 'Terminal not found' };
});

ipcMain.handle('terminal-resize', async (_, id: number, cols: number, rows: number) => {
  const term = terminals.get(id);
  if (term) { term.resize(cols, rows); return { success: true }; }
  return { success: false, error: 'Terminal not found' };
});

ipcMain.handle('terminal-kill', async (_, id: number) => {
  const term = terminals.get(id);
  if (term) { term.kill(); terminals.delete(id); return { success: true }; }
  return { success: false, error: 'Terminal not found' };
});

// --- Command Center IPC ---

ipcMain.handle('bind-terminal-device', async (_, terminalId: number, devName: string) => {
  deviceToTerminal.set(devName, terminalId);
  terminalIdle.set(terminalId, true);
  return { success: true };
});

ipcMain.handle('inject-prompt', async (_, terminalId: number, text: string, promptId: string) => {
  const term = terminals.get(terminalId);
  if (!term) return { success: false, error: 'Terminal not found' };
  injectIntoTerminal(terminalId, text, promptId);
  return { success: true };
});

ipcMain.handle('inject-prompt-to-device', async (_, deviceName: string, text: string, promptId: string) => {
  const termId = deviceToTerminal.get(deviceName);
  if (termId === undefined) return { success: false, error: `No terminal bound to device: ${deviceName}` };
  const term = terminals.get(termId);
  if (!term) return { success: false, error: 'Terminal not found' };
  injectIntoTerminal(termId, text, promptId);
  return { success: true };
});

ipcMain.handle('send-prompt-inject', async (_, target: string, text: string, promptId: string) => {
  if (!client) return { success: false, error: 'Not connected' };
  client.sendPromptInject(target, text, promptId);
  return { success: true };
});

ipcMain.handle('get-bound-terminals', async () => {
  const bindings: Array<{ deviceName: string; terminalId: number }> = [];
  for (const [dev, tid] of deviceToTerminal) {
    bindings.push({ deviceName: dev, terminalId: tid });
  }
  return bindings;
});

// --- File sync event handling ---

function handleFileSyncEvent(event: string, data: any) {
  const projectPath = getProjectPath();
  if (!projectPath || !client) return;

  switch (event) {
    case 'file-sync-request': {
      if (data.direction === 'push' && data.filePaths) {
        mainWindow?.webContents.send('file-sync-progress', {
          syncId: data.syncId, phase: 'transferring',
          totalFiles: data.filePaths?.length || 0, completedFiles: 0,
        });
      } else if (data.direction === 'pull') {
        const localManifest = buildManifest(projectPath);
        const remoteManifest = data.manifest || [];
        const { toPush } = diffManifests(localManifest, remoteManifest);

        for (const filePath of toPush) {
          const chunks = readFileChunked(projectPath, filePath, data.syncId);
          for (const chunk of chunks) {
            client.sendFileChunk(data.from, chunk);
          }
        }
        client.reportFileSyncStatus(data.from, {
          syncId: data.syncId, phase: 'done',
          totalFiles: toPush.length, completedFiles: toPush.length,
        });
      } else if (data.direction === 'push' && !data.filePaths) {
        const localManifest = buildManifest(projectPath);
        client.sendManifestResponse(data.from, data.syncId, localManifest);
      }
      break;
    }

    case 'file-chunk': {
      const done = receiveChunk(projectPath, data.chunk);
      if (done) {
        mainWindow?.webContents.send('file-sync-progress', {
          syncId: data.chunk.syncId,
          phase: 'writing',
          currentFile: data.chunk.filePath,
          completedFiles: 1,
          totalFiles: 1,
        });
        // Update sync state
        if (workspace) {
          const activeProject = workspace.getActiveProject();
          if (activeProject) {
            workspace.updateDeviceState(activeProject.id, lastMcpDevice, {
              lastSynced: Date.now(),
              status: 'synced',
            });
          }
        }
      }
      break;
    }

    case 'file-sync-status': {
      mainWindow?.webContents.send('file-sync-progress', data.status);
      break;
    }

    case 'file-manifest-response': {
      const localManifest = buildManifest(projectPath);
      const diff = diffManifests(localManifest, data.manifest || []);
      mainWindow?.webContents.send('file-manifest-diff', {
        syncId: data.syncId,
        from: data.from,
        toPush: diff.toPush,
        toPull: diff.toPull,
      });
      break;
    }

    case 'mcp-trigger-sync': {
      if (data.direction === 'push') {
        const manifest = buildManifest(projectPath);
        if (data.filePaths && data.filePaths.length > 0) {
          for (const filePath of data.filePaths) {
            const chunks = readFileChunked(projectPath, filePath, data.syncId);
            for (const chunk of chunks) {
              client!.sendFileChunk(data.target, chunk);
            }
          }
          mainWindow?.webContents.send('file-sync-progress', {
            syncId: data.syncId, phase: 'done',
            totalFiles: data.filePaths.length, completedFiles: data.filePaths.length,
          });
        } else {
          client!.requestFileSync(data.target, data.syncId, manifest, 'push');
        }
      } else if (data.direction === 'pull') {
        const manifest = buildManifest(projectPath);
        client!.requestFileSync(data.target, data.syncId, manifest, 'pull');
      }
      mainWindow?.webContents.send('file-sync-progress', {
        syncId: data.syncId, phase: data.direction === 'push' ? 'transferring' : 'scanning',
        totalFiles: 0, completedFiles: 0,
      });
      break;
    }
  }
}

function notifyTerminal(from: string, type: string, content: string) {
  const termIds = Array.from(terminals.keys());
  if (termIds.length === 0) return;
  const latestId = termIds[termIds.length - 1];
  const term = terminals.get(latestId);
  if (!term) return;

  const truncated = content.length > 120 ? content.slice(0, 117) + '...' : content;
  const notification = `\r\n\x1b[38;2;124;138;255m[Claude Connect]\x1b[0m \x1b[38;2;74;158;107m${from}\x1b[0m (${type}): ${truncated}\r\n`;
  mainWindow?.webContents.send('terminal-data', { id: latestId, data: notification });
}

// --- Inbox file ---

function writeToInbox(entry: { from: string; type: string; time: string; content: string }) {
  const projectPath = getProjectPath();
  if (!projectPath) return;
  const inboxPath = path.join(projectPath, '.claude-connect-inbox');

  let existing = '';
  try { existing = fs.readFileSync(inboxPath, 'utf8'); } catch {}

  const line = `[${entry.time}] ${entry.from} (${entry.type}): ${entry.content}`;
  const updated = existing ? existing.trimEnd() + '\n' + line + '\n' : line + '\n';
  try { fs.writeFileSync(inboxPath, updated); } catch {}
}

function clearInbox() {
  const projectPath = getProjectPath();
  if (!projectPath) return;
  const inboxPath = path.join(projectPath, '.claude-connect-inbox');
  try { fs.writeFileSync(inboxPath, ''); } catch {}
}

function setupClientEventHandler(c: RelayClient) {
  c.setEventHandler((event, data) => {
    mainWindow?.webContents.send('client-event', { event, data });
    handleFileSyncEvent(event, data);

    // Incoming message → inbox + terminal notification
    if (event === 'message' && data.from !== lastMcpDevice) {
      const content = data.payload?.text || data.payload?.summary || '';
      if (content) {
        notifyTerminal(data.from, data.type, content);
        writeToInbox({
          from: data.from,
          type: data.type,
          time: new Date(data.timestamp).toLocaleTimeString(),
          content,
        });
      }
    }

    // Incoming task → inbox
    if (event === 'task-update' && data.createdBy !== lastMcpDevice && data.status === 'pending') {
      writeToInbox({
        from: data.createdBy,
        type: 'task',
        time: new Date(data.createdAt).toLocaleTimeString(),
        content: `NEW TASK: "${data.title}"${data.assignedTo ? ` (assigned to ${data.assignedTo})` : ''}${data.notes ? ` — ${data.notes}` : ''}`,
      });
    }

    // Auto-inject incoming messages into Claude terminal
    if (event === 'message' && data.from !== lastMcpDevice) {
      const content = data.payload?.text || data.payload?.summary || '';
      if (content) {
        const localTermId = deviceToTerminal.get(lastMcpDevice);
        if (localTermId !== undefined && terminals.has(localTermId)) {
          const injectionText = `[${data.from} says]: ${content}`;
          injectIntoTerminal(localTermId, injectionText, `auto-${data.id || Date.now()}`);
          mainWindow?.webContents.send('command-event', {
            id: `evt-${Date.now()}`,
            type: 'info',
            text: `Auto-injected message from ${data.from}`,
            timestamp: Date.now(),
          });
        }
      }
    }

    // Auto-pull files when work-update arrives
    if (event === 'message' && data.type === 'work-update' && data.from !== lastMcpDevice) {
      const filesChanged = data.payload?.filesChanged;
      const projectPath = getProjectPath();
      if (filesChanged && filesChanged.length > 0 && projectPath && client) {
        const syncId = uuid();
        const manifest = buildManifest(projectPath);
        client.requestFileSync(data.from, syncId, manifest, 'pull');
        mainWindow?.webContents.send('command-event', {
          id: `evt-${Date.now()}`,
          type: 'sync',
          text: `Auto-syncing ${filesChanged.length} file(s) from ${data.from}`,
          timestamp: Date.now(),
        });
      }
    }

    // Remote terminal output → Command Center
    if (event === 'terminal-output' && data.from !== lastMcpDevice) {
      mainWindow?.webContents.send('command-remote-output', {
        deviceName: data.from,
        text: data.text,
      });
    }

    // Prompt injection from remote device
    if (event === 'prompt-inject') {
      const localTermId = deviceToTerminal.get(lastMcpDevice);
      if (localTermId !== undefined && terminals.has(localTermId)) {
        injectIntoTerminal(localTermId, data.text, data.promptId || `remote-${Date.now()}`);
        mainWindow?.webContents.send('command-event', {
          id: `evt-${Date.now()}`,
          type: 'info',
          text: `Prompt from ${data.from}`,
          timestamp: Date.now(),
        });
      }
    }

    // Project created on remote device — auto-create locally
    if (event === 'project-created' && workspace) {
      const project: ProjectEntry = data;
      workspace.registerRemoteProject(project, lastMcpDevice || os.hostname());
      mainWindow?.webContents.send('workspace-event', { event: 'project-created', project });
      mainWindow?.webContents.send('command-event', {
        id: `evt-${Date.now()}`,
        type: 'info',
        text: `Project "${project.name}" created — synced locally`,
        timestamp: Date.now(),
      });
    }

    // Project list from relay
    if (event === 'project-list' && workspace) {
      const projects: ProjectEntry[] = data;
      for (const p of projects) {
        workspace.registerRemoteProject(p, lastMcpDevice || os.hostname());
      }
      mainWindow?.webContents.send('workspace-event', { event: 'project-list', projects: workspace.listProjects() });
    }

    // Welcome — sync projects from host
    if (event === 'welcome' && workspace && data.projects) {
      for (const p of data.projects) {
        workspace.registerRemoteProject(p, lastMcpDevice || os.hostname());
      }
      mainWindow?.webContents.send('workspace-event', { event: 'project-list', projects: workspace.listProjects() });
    }
  });
}

// --- Connection IPC ---

ipcMain.handle('start-server', async (_, port?: number, deviceName?: string, role?: string) => {
  try {
    server = new RelayServer(port || DEFAULT_PORT);
    server.setEventHandler((event, data) => {
      mainWindow?.webContents.send('server-event', { event, data });
    });

    // Share workspace projects with relay
    if (workspace) {
      server.setProjects(workspace.listProjects());
    }

    await server.start();

    client = new RelayClient(deviceName || os.hostname(), process.platform);
    setupClientEventHandler(client);
    await client.connect('localhost', port || DEFAULT_PORT);

    installMcpConfig(deviceName || os.hostname(), role || 'host', 'localhost');

    // Sync project list to relay
    if (workspace && client) {
      client.syncProjectList(workspace.listProjects());
    }

    // Start file watcher
    startFileWatcher();

    return { success: true, port: port || DEFAULT_PORT };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-server', async () => {
  stopFileWatcher();
  client?.disconnect();
  client = null;
  server?.stop();
  server = null;
  uninstallMcpConfig();
  return { success: true };
});

ipcMain.handle('connect-to-server', async (_, host: string, port: number, deviceName?: string, role?: string) => {
  try {
    client = new RelayClient(deviceName || os.hostname(), process.platform);
    setupClientEventHandler(client);
    await client.connect(host, port);

    installMcpConfig(deviceName || os.hostname(), role || 'client', host);

    // Sync project list
    if (workspace && client) {
      client.syncProjectList(workspace.listProjects());
    }

    // Start file watcher
    startFileWatcher();

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('disconnect', async () => {
  stopFileWatcher();
  client?.disconnect();
  client = null;
  uninstallMcpConfig();
  return { success: true };
});

ipcMain.handle('send-message', async (_, text: string, to?: string) => {
  client?.sendMessage('chat', { text }, to);
  return { success: true };
});

ipcMain.handle('send-context', async (_, summary: string, activeFiles: string[], currentTask?: string) => {
  client?.sendContext(summary, activeFiles, currentTask);
  return { success: true };
});

ipcMain.handle('create-task', async (_, title: string, assignedTo?: string, notes?: string) => {
  client?.createTask(title, assignedTo, notes);
  return { success: true };
});

ipcMain.handle('update-task', async (_, taskId: string, updates: any) => {
  client?.updateTask(taskId, updates);
  return { success: true };
});

ipcMain.handle('add-clipboard', async (_, content: string, label?: string) => {
  client?.addClipboard(content, label);
  return { success: true };
});

ipcMain.handle('get-connection-info', async () => {
  const networkInterfaces = os.networkInterfaces();
  const addresses: string[] = [];
  for (const [, nets] of Object.entries(networkInterfaces)) {
    if (nets) {
      for (const net of nets) {
        if (net.family === 'IPv4' && !net.internal) {
          addresses.push(net.address);
        }
      }
    }
  }
  return {
    hostname: os.hostname(),
    addresses,
    port: DEFAULT_PORT,
    isHosting: server?.isRunning() || false,
    isConnected: client?.isConnected() || false,
    mcpInstalled,
  };
});

// --- Workspace IPC ---

ipcMain.handle('workspace-get', async () => {
  if (!workspace) return { root: null, projects: [], activeProjectId: null };
  return {
    root: workspace.getRoot(),
    projects: workspace.listProjects(),
    activeProjectId: workspace.getActiveProject()?.id || null,
  };
});

ipcMain.handle('workspace-create-project', async (_, name: string) => {
  if (!workspace) return { success: false, error: 'Workspace not initialized' };
  try {
    const deviceName = lastMcpDevice || os.hostname();
    const project = workspace.createProject(name, deviceName);

    // Broadcast to connected devices
    if (client) {
      client.broadcastProjectCreate(project);
    }

    // Write CLAUDE.md
    const projectPath = workspace.getActiveProjectPath(deviceName);
    if (projectPath) {
      writeProjectClaudeMd(projectPath);
    }

    // Update MCP config with new project path
    if (mcpInstalled) {
      installMcpConfig(lastMcpDevice, lastMcpRole, lastMcpHost);
    }

    // Restart file watcher
    startFileWatcher();

    // Notify relay of project change
    if (client && projectPath) {
      client.setProject(projectPath, project.id, project.name);
    }

    return { success: true, project };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('workspace-switch-project', async (_, projectId: string) => {
  if (!workspace) return { success: false, error: 'Workspace not initialized' };

  const project = workspace.switchProject(projectId);
  if (!project) return { success: false, error: 'Project not found' };

  const deviceName = lastMcpDevice || os.hostname();
  const projectPath = workspace.getActiveProjectPath(deviceName);

  // Update MCP config
  if (mcpInstalled && projectPath) {
    installMcpConfig(lastMcpDevice, lastMcpRole, lastMcpHost);
  }

  // Write CLAUDE.md if needed
  if (projectPath) {
    writeProjectClaudeMd(projectPath);
  }

  // Restart file watcher for new project
  startFileWatcher();

  // Notify relay
  if (client && projectPath) {
    client.switchProject(project.id, project.name, projectPath);
  }

  return { success: true, project, projectPath };
});

ipcMain.handle('workspace-delete-project', async (_, projectId: string, removeFiles: boolean) => {
  if (!workspace) return { success: false, error: 'Workspace not initialized' };
  const result = workspace.deleteProject(projectId, removeFiles);
  if (result) {
    startFileWatcher(); // restart on new active project
  }
  return { success: result };
});

ipcMain.handle('workspace-set-root', async (_, newRoot: string) => {
  workspace = new WorkspaceManager(newRoot);
  return { success: true, root: workspace.getRoot() };
});

// --- Legacy Project Folder IPC (kept for compatibility) ---

function writeProjectClaudeMd(folder: string) {
  const claudeMdPath = path.join(folder, 'CLAUDE.md');
  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, 'utf8');
    if (!existing.includes('<!-- claude-connect-auto -->')) return;
  }

  const content = `<!-- claude-connect-auto -->
# Claude Connect — Cross-Machine Collaboration

This project is shared across machines via Claude Connect. You MUST follow these rules.

## CRITICAL: Check Inbox FIRST
Before responding to ANY user message, read the file \`.claude-connect-inbox\` in this directory.
It contains real-time messages, tasks, and instructions from other connected machines.
If it has content, act on it immediately. This is how the other machine talks to you.
After reading and acting on inbox messages, the file will be cleared automatically.

## Automatic Behavior (do ALL of this without being asked)
1. **Start of conversation**: Call \`cc_sync\` once to get full state, then check \`.claude-connect-inbox\`
2. **After writing/editing any file**: Call \`cc_push_files\` to sync changes to connected devices
3. **After completing work**: Call \`cc_work_update\` with summary + files changed
4. **After finishing a task**: Call \`cc_complete_task\` and \`cc_send_message\` to notify the other machine
5. **When you need remote files**: Call \`cc_pull_files\` to get them

## Communication
- Use \`cc_send_message\` to tell other machines about progress or ask questions
- Use \`cc_delegate\` to assign work to another machine (creates task + notifies)
- NEVER wait to be told to communicate — just do it as part of your workflow

## Auto-Injected Messages
Messages from other machines may appear in your input as:
\`[DeviceName says]: message content\`
These are real-time messages from other connected Claude instances. Treat them as instructions or questions from a collaborator and act on them immediately. Respond using \`cc_send_message\` so the other machine gets your reply.

## Key Principle
You are one brain across multiple machines. The user should NEVER have to type sync, push, pull, or any coordination command. Handle it all silently and automatically.
`;

  fs.writeFileSync(claudeMdPath, content);
  console.log('CLAUDE.md written to project folder');
}

ipcMain.handle('select-project-folder', async () => {
  if (!mainWindow) return { success: false, error: 'No window' };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Project Folder',
  });
  if (result.canceled || !result.filePaths[0]) {
    return { success: false };
  }
  const folderPath = result.filePaths[0];
  writeProjectClaudeMd(folderPath);
  return { success: true, path: folderPath };
});

ipcMain.handle('get-project-folder', async () => {
  const projectPath = getProjectPath();
  return { path: projectPath };
});

ipcMain.handle('clear-inbox', async () => {
  clearInbox();
  return { success: true };
});

ipcMain.handle('set-project-folder', async (_, folderPath: string) => {
  writeProjectClaudeMd(folderPath);
  if (client) {
    client.setProject(folderPath);
  }
  if (mcpInstalled) {
    installMcpConfig(lastMcpDevice, lastMcpRole, lastMcpHost);
  }
  return { success: true, path: folderPath };
});

// --- File Sync IPC ---

ipcMain.handle('get-file-manifest', async () => {
  const projectPath = getProjectPath();
  if (!projectPath) return { success: false, error: 'No project folder selected' };
  try {
    const manifest = buildManifest(projectPath);
    return { success: true, manifest };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('push-files', async (_, target: string, filePaths?: string[]) => {
  const projectPath = getProjectPath();
  if (!projectPath || !client) return { success: false, error: 'Not ready' };
  try {
    const syncId = uuid();
    const manifest = buildManifest(projectPath);
    client.requestFileSync(target, syncId, manifest, 'push', filePaths);

    if (filePaths && filePaths.length > 0) {
      let completed = 0;
      for (const filePath of filePaths) {
        const chunks = readFileChunked(projectPath, filePath, syncId);
        for (const chunk of chunks) {
          client.sendFileChunk(target, chunk);
        }
        completed++;
        mainWindow?.webContents.send('file-sync-progress', {
          syncId, phase: 'transferring',
          totalFiles: filePaths.length, completedFiles: completed,
          currentFile: filePath,
        });
      }
      mainWindow?.webContents.send('file-sync-progress', {
        syncId, phase: 'done',
        totalFiles: filePaths.length, completedFiles: filePaths.length,
      });
    }
    return { success: true, syncId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('pull-files', async (_, target: string) => {
  const projectPath = getProjectPath();
  if (!projectPath || !client) return { success: false, error: 'Not ready' };
  try {
    const syncId = uuid();
    const manifest = buildManifest(projectPath);
    client.requestFileSync(target, syncId, manifest, 'pull');
    return { success: true, syncId };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('compare-manifests', async (_, target: string) => {
  const projectPath = getProjectPath();
  if (!projectPath || !client) return { success: false, error: 'Not ready' };
  try {
    const syncId = uuid();
    const manifest = buildManifest(projectPath);
    client.requestFileSync(target, syncId, manifest, 'push');
    return { success: true, syncId, localManifest: manifest };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
