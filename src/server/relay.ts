import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import {
  ConnectMessage,
  DeviceInfo,
  TaskItem,
  ClipboardEntry,
  DEFAULT_PORT,
  MAX_MESSAGES,
  MAX_CLIPBOARD,
} from '../shared/types';

interface ConnectedClient {
  ws: WebSocket;
  device: DeviceInfo;
}

export class RelayServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ConnectedClient> = new Map();
  private messages: ConnectMessage[] = [];
  private tasks: TaskItem[] = [];
  private clipboard: ClipboardEntry[] = [];
  private onEvent?: (event: string, data: any) => void;

  constructor(private port: number = DEFAULT_PORT) {}

  setEventHandler(handler: (event: string, data: any) => void) {
    this.onEvent = handler;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ port: this.port });

        this.wss.on('listening', () => {
          console.log(`Claude Connect relay server running on port ${this.port}`);
          this.emit('server-started', { port: this.port });
          resolve();
        });

        this.wss.on('connection', (ws, req) => {
          this.handleConnection(ws, req);
        });

        this.wss.on('error', (err) => {
          this.emit('server-error', { error: err.message });
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  stop(): void {
    if (this.wss) {
      for (const [, client] of this.clients) {
        client.ws.close();
      }
      this.wss.close();
      this.wss = null;
      this.clients.clear();
      this.emit('server-stopped', {});
    }
  }

  private handleConnection(ws: WebSocket, req: any) {
    const clientId = uuid();

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(clientId, ws, msg);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', payload: 'Invalid message format' }));
      }
    });

    ws.on('close', () => {
      const client = this.clients.get(clientId);
      if (client) {
        client.device.status = 'offline';
        this.broadcast({ type: 'device-disconnected', device: client.device }, clientId);
        this.emit('device-disconnected', client.device);
        this.clients.delete(clientId);
      }
    });

    ws.on('pong', () => {
      const client = this.clients.get(clientId);
      if (client) {
        client.device.lastSeen = Date.now();
      }
    });
  }

  private handleMessage(clientId: string, ws: WebSocket, msg: any) {
    switch (msg.action) {
      case 'register': {
        const device: DeviceInfo = {
          name: msg.deviceName || `Device-${clientId.slice(0, 6)}`,
          platform: msg.platform || 'unknown',
          connectedAt: Date.now(),
          lastSeen: Date.now(),
          status: 'online',
        };
        this.clients.set(clientId, { ws, device });
        this.emit('device-connected', device);

        // Send current state to new client
        ws.send(JSON.stringify({
          type: 'welcome',
          device,
          devices: Array.from(this.clients.values()).map(c => c.device),
          recentMessages: this.messages.slice(-50),
          tasks: this.tasks,
          clipboard: this.clipboard,
        }));

        this.broadcast({ type: 'device-connected', device }, clientId);
        break;
      }

      case 'message': {
        const connectMsg: ConnectMessage = {
          id: uuid(),
          type: msg.msgType || 'chat',
          from: this.clients.get(clientId)?.device.name || 'unknown',
          to: msg.to,
          timestamp: Date.now(),
          payload: msg.payload,
        };
        this.messages.push(connectMsg);
        if (this.messages.length > MAX_MESSAGES) {
          this.messages = this.messages.slice(-MAX_MESSAGES);
        }

        if (msg.to) {
          // Direct message
          this.sendTo(msg.to, { type: 'message', message: connectMsg });
          // Also echo back to sender
          const sender = this.clients.get(clientId);
          if (sender && sender.ws.readyState === WebSocket.OPEN) {
            sender.ws.send(JSON.stringify({ type: 'message', message: connectMsg }));
          }
        } else {
          // Broadcast to ALL including sender
          this.broadcast({ type: 'message', message: connectMsg });
        }
        this.emit('message', connectMsg);
        break;
      }

      case 'task-create': {
        const task: TaskItem = {
          id: uuid(),
          title: msg.title,
          status: 'pending',
          assignedTo: msg.assignedTo,
          createdBy: this.clients.get(clientId)?.device.name || 'unknown',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          notes: msg.notes,
        };
        this.tasks.push(task);
        this.broadcast({ type: 'task-update', task }, undefined);
        this.emit('task-created', task);
        break;
      }

      case 'task-update': {
        const idx = this.tasks.findIndex(t => t.id === msg.taskId);
        if (idx >= 0) {
          this.tasks[idx] = { ...this.tasks[idx], ...msg.updates, updatedAt: Date.now() };
          this.broadcast({ type: 'task-update', task: this.tasks[idx] }, undefined);
          this.emit('task-updated', this.tasks[idx]);
        }
        break;
      }

      case 'clipboard-add': {
        const entry: ClipboardEntry = {
          id: uuid(),
          content: msg.content,
          label: msg.label,
          createdBy: this.clients.get(clientId)?.device.name || 'unknown',
          createdAt: Date.now(),
        };
        this.clipboard.unshift(entry);
        if (this.clipboard.length > MAX_CLIPBOARD) {
          this.clipboard = this.clipboard.slice(0, MAX_CLIPBOARD);
        }
        this.broadcast({ type: 'clipboard-update', entry }, undefined);
        this.emit('clipboard-added', entry);
        break;
      }

      case 'get-state': {
        ws.send(JSON.stringify({
          type: 'state',
          devices: Array.from(this.clients.values()).map(c => c.device),
          messages: this.messages.slice(-50),
          tasks: this.tasks,
          clipboard: this.clipboard,
        }));
        break;
      }
    }
  }

  private broadcast(data: any, excludeId?: string) {
    const msg = JSON.stringify(data);
    for (const [id, client] of this.clients) {
      if (id !== excludeId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  private sendTo(deviceName: string, data: any) {
    const msg = JSON.stringify(data);
    for (const [, client] of this.clients) {
      if (client.device.name === deviceName && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  private emit(event: string, data: any) {
    this.onEvent?.(event, data);
  }

  getDevices(): DeviceInfo[] {
    return Array.from(this.clients.values()).map(c => c.device);
  }

  getMessages(): ConnectMessage[] {
    return this.messages;
  }

  getTasks(): TaskItem[] {
    return this.tasks;
  }

  getClipboard(): ClipboardEntry[] {
    return this.clipboard;
  }

  isRunning(): boolean {
    return this.wss !== null;
  }
}
