import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { RelayServer } from '../server/relay';
import { RelayClient } from '../server/client';
import { DEFAULT_PORT } from '../shared/types';
import * as os from 'os';

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

// Track active terminal processes
const terminals: Map<number, any> = new Map();
let nextTerminalId = 1;

// --- MCP auto-config ---

function getClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

function getMcpServerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app', 'dist', 'mcp', 'server.js');
  }
  return path.join(__dirname, '..', 'mcp', 'server.js');
}

function installMcpConfig(deviceName: string, role: string, host: string) {
  try {
    const configPath = getClaudeConfigPath();
    let config: any = {};

    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    config.mcpServers = config.mcpServers || {};
    config.mcpServers['claude-connect'] = {
      command: 'node',
      args: [getMcpServerPath()],
      env: {
        CLAUDE_CONNECT_DEVICE: deviceName || os.hostname(),
        CLAUDE_CONNECT_ROLE: role || '',
        CLAUDE_CONNECT_HOST: host || 'localhost',
        CLAUDE_CONNECT_PORT: String(DEFAULT_PORT),
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    mcpInstalled = true;
    console.log('MCP config installed');
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
  const shell = process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');

  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: cwd || os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color' },
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

// --- Connection IPC ---

ipcMain.handle('start-server', async (_, port?: number, deviceName?: string, role?: string) => {
  try {
    server = new RelayServer(port || DEFAULT_PORT);
    server.setEventHandler((event, data) => {
      mainWindow?.webContents.send('server-event', { event, data });
    });
    await server.start();

    client = new RelayClient(deviceName || os.hostname(), process.platform);
    client.setEventHandler((event, data) => {
      mainWindow?.webContents.send('client-event', { event, data });
    });
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
    client.setEventHandler((event, data) => {
      mainWindow?.webContents.send('client-event', { event, data });
    });
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
