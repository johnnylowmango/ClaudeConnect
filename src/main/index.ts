import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { RelayServer } from '../server/relay';
import { RelayClient } from '../server/client';
import { DEFAULT_PORT } from '../shared/types';
import * as os from 'os';
import { buildManifest, readFileChunked, receiveChunk, diffManifests } from './file-sync';
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
let projectPath: string | null = null;
let lastMcpDevice: string = '';
let lastMcpRole: string = '';
let lastMcpHost: string = '';

// Track active terminal processes
const terminals: Map<number, any> = new Map();
let nextTerminalId = 1;

// --- MCP auto-config ---

function getClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

function getMcpServerPath(): string {
  if (app.isPackaged) {
    // MCP server is unpacked from asar so plain `node` can run it
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'mcp', 'server.js');
  }
  return path.join(__dirname, '..', 'mcp', 'server.js');
}

function getNodePath(): string {
  // Find the full path to node so MCP works regardless of shell PATH
  const candidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
    // Windows
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ];

  // Check PATH-resolved node first
  const { execSync } = require('child_process');
  try {
    const resolved = execSync(process.platform === 'win32' ? 'where node' : 'which node', { encoding: 'utf8' }).trim().split('\n')[0];
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {}

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'node'; // fallback
}

function installMcpConfig(deviceName: string, role: string, host: string) {
  // Remember params so we can re-install when project folder changes
  lastMcpDevice = deviceName || os.hostname();
  lastMcpRole = role || '';
  lastMcpHost = host || 'localhost';

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
      console.log('MCP config removed');
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
      mainWindow?.webContents.send('updater-event', {
        event: 'update-available',
        version: info.version,
      });
    });

    autoUpdater.on('update-not-available', () => {
      mainWindow?.webContents.send('updater-event', {
        event: 'update-not-available',
      });
    });

    autoUpdater.on('download-progress', (progress: any) => {
      mainWindow?.webContents.send('updater-event', {
        event: 'download-progress',
        percent: Math.round(progress.percent),
      });
    });

    autoUpdater.on('update-downloaded', () => {
      mainWindow?.webContents.send('updater-event', {
        event: 'update-downloaded',
      });
    });

    autoUpdater.on('error', (err: any) => {
      mainWindow?.webContents.send('updater-event', {
        event: 'error',
        error: err.message,
      });
    });

    // Check for updates after a short delay
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 5000);

    // IPC handlers for updates
    ipcMain.handle('check-for-updates', async () => {
      try {
        const result = await autoUpdater.checkForUpdates();
        return { success: true, version: result?.updateInfo?.version };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('download-update', async () => {
      try {
        await autoUpdater.downloadUpdate();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
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
    width: 1100,
    height: 750,
    minWidth: 700,
    minHeight: 500,
    title: 'Claude Connect',
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  // Kill all terminal processes
  for (const [, term] of terminals) {
    try { term.kill(); } catch {}
  }
  terminals.clear();

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
  uninstallMcpConfig();
});

// --- Terminal IPC ---

ipcMain.handle('terminal-create', async (_, cwd?: string) => {
  if (!pty) {
    return { success: false, error: 'Terminal not available' };
  }

  const id = nextTerminalId++;
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');

  // Build env with proper PATH for both platforms
  const env: Record<string, string> = { ...process.env } as any;
  if (isWin) {
    // Windows: ensure common paths for node/claude are available
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
  });

  term.onExit(({ exitCode }: { exitCode: number }) => {
    mainWindow?.webContents.send('terminal-exit', { id, exitCode });
    terminals.delete(id);
  });

  return { success: true, id };
});

ipcMain.handle('terminal-write', async (_, id: number, data: string) => {
  const term = terminals.get(id);
  if (term) {
    term.write(data);
    return { success: true };
  }
  return { success: false, error: 'Terminal not found' };
});

ipcMain.handle('terminal-resize', async (_, id: number, cols: number, rows: number) => {
  const term = terminals.get(id);
  if (term) {
    term.resize(cols, rows);
    return { success: true };
  }
  return { success: false, error: 'Terminal not found' };
});

ipcMain.handle('terminal-kill', async (_, id: number) => {
  const term = terminals.get(id);
  if (term) {
    term.kill();
    terminals.delete(id);
    return { success: true };
  }
  return { success: false, error: 'Terminal not found' };
});

// --- File sync event handling ---

function handleFileSyncEvent(event: string, data: any) {
  if (!projectPath || !client) return;

  switch (event) {
    case 'file-sync-request': {
      // Another device wants to sync with us
      if (data.direction === 'push' && data.filePaths) {
        // They will push files to us — nothing to do, chunks will arrive
        mainWindow?.webContents.send('file-sync-progress', {
          syncId: data.syncId, phase: 'transferring',
          totalFiles: data.filePaths?.length || 0, completedFiles: 0,
        });
      } else if (data.direction === 'pull') {
        // They want our files — compare manifests and send diffs
        const localManifest = buildManifest(projectPath);
        const remoteManifest = data.manifest || [];
        const { toPush } = diffManifests(localManifest, remoteManifest);

        let completed = 0;
        for (const filePath of toPush) {
          const chunks = readFileChunked(projectPath, filePath, data.syncId);
          for (const chunk of chunks) {
            client.sendFileChunk(data.from, chunk);
          }
          completed++;
        }
        client.reportFileSyncStatus(data.from, {
          syncId: data.syncId, phase: 'done',
          totalFiles: toPush.length, completedFiles: toPush.length,
        });
      } else if (data.direction === 'push' && !data.filePaths) {
        // They sent their manifest for comparison — send ours back
        const localManifest = buildManifest(projectPath);
        client.sendManifestResponse(data.from, data.syncId, localManifest);
      }
      break;
    }

    case 'file-chunk': {
      // Incoming file chunk — reassemble
      const done = receiveChunk(projectPath, data.chunk);
      if (done) {
        mainWindow?.webContents.send('file-sync-progress', {
          syncId: data.chunk.syncId,
          phase: 'writing',
          currentFile: data.chunk.filePath,
          completedFiles: 1,
          totalFiles: 1,
        });
      }
      break;
    }

    case 'file-sync-status': {
      mainWindow?.webContents.send('file-sync-progress', data.status);
      break;
    }

    case 'file-manifest-response': {
      // Got remote manifest — compute diff and report
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
      // MCP server asked us to do a sync — we have the filesystem access
      if (data.direction === 'push') {
        const manifest = buildManifest(projectPath);
        if (data.filePaths && data.filePaths.length > 0) {
          // Push specific files
          let completed = 0;
          for (const filePath of data.filePaths) {
            const chunks = readFileChunked(projectPath, filePath, data.syncId);
            for (const chunk of chunks) {
              client!.sendFileChunk(data.target, chunk);
            }
            completed++;
          }
          mainWindow?.webContents.send('file-sync-progress', {
            syncId: data.syncId, phase: 'done',
            totalFiles: data.filePaths.length, completedFiles: data.filePaths.length,
          });
        } else {
          // Push all changed files — request remote manifest first
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
  // Write a visible notification to the active terminal so the user sees incoming messages
  // Find the most recently created terminal
  const termIds = Array.from(terminals.keys());
  if (termIds.length === 0) return;
  const latestId = termIds[termIds.length - 1];
  const term = terminals.get(latestId);
  if (!term) return;

  // ANSI: save cursor, move to new line, print notification, restore
  const truncated = content.length > 120 ? content.slice(0, 117) + '...' : content;
  const notification = `\r\n\x1b[38;2;124;138;255m[Claude Connect]\x1b[0m \x1b[38;2;74;158;107m${from}\x1b[0m (${type}): ${truncated}\r\n`;
  mainWindow?.webContents.send('terminal-data', { id: latestId, data: notification });
}

function setupClientEventHandler(c: RelayClient) {
  c.setEventHandler((event, data) => {
    mainWindow?.webContents.send('client-event', { event, data });
    handleFileSyncEvent(event, data);

    // Terminal notification for incoming messages from other devices
    if (event === 'message' && data.from !== lastMcpDevice) {
      const content = data.payload?.text || data.payload?.summary || '';
      if (content) {
        notifyTerminal(data.from, data.type, content);
      }
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
    await server.start();

    client = new RelayClient(deviceName || os.hostname(), process.platform);
    setupClientEventHandler(client);
    await client.connect('localhost', port || DEFAULT_PORT);

    installMcpConfig(deviceName || os.hostname(), role || 'host', 'localhost');

    return { success: true, port: port || DEFAULT_PORT };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-server', async () => {
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

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('disconnect', async () => {
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

// --- Project Folder IPC ---

function writeProjectClaudeMd(folder: string) {
  const claudeMdPath = path.join(folder, 'CLAUDE.md');
  // Don't overwrite if user has customized it (check for our marker)
  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, 'utf8');
    if (!existing.includes('<!-- claude-connect-auto -->')) return;
  }

  const content = `<!-- claude-connect-auto -->
# Claude Connect — Cross-Machine Collaboration

You are connected to other machines via Claude Connect. Follow these rules automatically:

## On Every Conversation Start
- Call \`cc_sync\` immediately (before doing anything else) to check for messages, tasks, and context from other machines.
- If there are pending tasks assigned to you, start working on them.
- If there are unread messages, acknowledge and act on them.

## After Making File Changes
- Call \`cc_push_files\` to push your changes to connected devices so they stay in sync.
- Call \`cc_work_update\` with a summary of what you did.

## When You Need Files From Another Machine
- Call \`cc_pull_files\` to get the latest from the other device.

## Communication
- When you finish a task or have a question, use \`cc_send_message\` to tell the other machine.
- When delegating work, use \`cc_delegate\` — it creates a task AND notifies the target.
- You do NOT need to be told to sync or communicate. Do it proactively as part of your normal workflow.

## Key Principle
Act as one unified brain across machines. Sync automatically, push changes after edits, pull when you need context. The user should never have to tell you to sync — just do it.
`;

  fs.writeFileSync(claudeMdPath, content);
  console.log('CLAUDE.md written to project folder');
}

function applyProjectPath(newPath: string) {
  projectPath = newPath;
  // Tell relay so other devices see our project path
  client?.setProject(projectPath);
  // Re-write MCP config so new Claude sessions get the project env var
  if (mcpInstalled) {
    installMcpConfig(lastMcpDevice, lastMcpRole, lastMcpHost);
  }
  // Write CLAUDE.md with auto-sync instructions
  writeProjectClaudeMd(newPath);
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
  applyProjectPath(result.filePaths[0]);
  return { success: true, path: projectPath };
});

ipcMain.handle('get-project-folder', async () => {
  return { path: projectPath };
});

ipcMain.handle('set-project-folder', async (_, folderPath: string) => {
  applyProjectPath(folderPath);
  return { success: true, path: projectPath };
});

// --- File Sync IPC ---

ipcMain.handle('get-file-manifest', async () => {
  if (!projectPath) return { success: false, error: 'No project folder selected' };
  try {
    const manifest = buildManifest(projectPath);
    return { success: true, manifest };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('push-files', async (_, target: string, filePaths?: string[]) => {
  if (!projectPath || !client) return { success: false, error: 'Not ready' };
  try {
    const syncId = uuid();
    const manifest = buildManifest(projectPath);

    // Send sync request with our manifest
    client.requestFileSync(target, syncId, manifest, 'push', filePaths);

    // If specific files requested, send them now
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
  if (!projectPath || !client) return { success: false, error: 'Not ready' };
  try {
    const syncId = uuid();
    const manifest = buildManifest(projectPath);
    // Request remote manifest for comparison
    client.requestFileSync(target, syncId, manifest, 'push');
    return { success: true, syncId, localManifest: manifest };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
