import WebSocket from 'ws';
import { ConnectMessage, DeviceInfo, TaskItem, ClipboardEntry } from '../shared/types';

export class RelayClient {
  private ws: WebSocket | null = null;
  private deviceName: string;
  private platform: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private onEvent?: (event: string, data: any) => void;

  constructor(deviceName: string, platform: string) {
    this.deviceName = deviceName;
    this.platform = platform;
  }

  setEventHandler(handler: (event: string, data: any) => void) {
    this.onEvent = handler;
  }

  connect(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(`ws://${host}:${port}`);

        this.ws.on('open', () => {
          this.ws!.send(JSON.stringify({
            action: 'register',
            deviceName: this.deviceName,
            platform: this.platform,
          }));
          this.emit('connected', { host, port });
          resolve();
        });

        this.ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            this.handleMessage(msg);
          } catch (err) {
            // ignore malformed
          }
        });

        this.ws.on('close', () => {
          this.emit('disconnected', {});
          this.scheduleReconnect(host, port);
        });

        this.ws.on('error', (err) => {
          this.emit('error', { error: err.message });
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(host: string, port: number) {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(host, port).catch(() => {
        // will retry on close
      });
    }, 3000);
  }

  private handleMessage(msg: any) {
    switch (msg.type) {
      case 'welcome':
        this.emit('welcome', msg);
        break;
      case 'message':
        this.emit('message', msg.message);
        break;
      case 'device-connected':
        this.emit('device-connected', msg.device);
        break;
      case 'device-disconnected':
        this.emit('device-disconnected', msg.device);
        break;
      case 'task-update':
        this.emit('task-update', msg.task);
        break;
      case 'clipboard-update':
        this.emit('clipboard-update', msg.entry);
        break;
      case 'state':
        this.emit('state', msg);
        break;
    }
  }

  sendMessage(msgType: string, payload: any, to?: string) {
    this.send({ action: 'message', msgType, payload, to });
  }

  sendContext(summary: string, activeFiles: string[], currentTask?: string, workingDirectory: string = '') {
    this.sendMessage('context', { summary, activeFiles, currentTask, workingDirectory });
  }

  createTask(title: string, assignedTo?: string, notes?: string) {
    this.send({ action: 'task-create', title, assignedTo, notes });
  }

  updateTask(taskId: string, updates: Partial<TaskItem>) {
    this.send({ action: 'task-update', taskId, updates });
  }

  addClipboard(content: string, label?: string) {
    this.send({ action: 'clipboard-add', content, label });
  }

  requestState() {
    this.send({ action: 'get-state' });
  }

  private send(data: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private emit(event: string, data: any) {
    this.onEvent?.(event, data);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
