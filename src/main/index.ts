import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { RelayServer } from '../server/relay';
import { RelayClient } from '../server/client';
import { DEFAULT_PORT } from '../shared/types';
import * as os from 'os';

let mainWindow: BrowserWindow | null = null;
let server: RelayServer | null = null;
let client: RelayClient | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  server?.stop();
  client?.disconnect();
  app.quit();
});

// IPC handlers
ipcMain.handle('start-server', async (_, port?: number) => {
  try {
    server = new RelayServer(port || DEFAULT_PORT);
    server.setEventHandler((event, data) => {
      mainWindow?.webContents.send('server-event', { event, data });
    });
    await server.start();

    // Also connect as a client to our own server
    client = new RelayClient(os.hostname(), process.platform);
    client.setEventHandler((event, data) => {
      mainWindow?.webContents.send('client-event', { event, data });
    });
    await client.connect('localhost', port || DEFAULT_PORT);

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
  return { success: true };
});

ipcMain.handle('connect-to-server', async (_, host: string, port: number, deviceName?: string) => {
  try {
    client = new RelayClient(deviceName || os.hostname(), process.platform);
    client.setEventHandler((event, data) => {
      mainWindow?.webContents.send('client-event', { event, data });
    });
    await client.connect(host, port);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('disconnect', async () => {
  client?.disconnect();
  client = null;
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
  };
});
