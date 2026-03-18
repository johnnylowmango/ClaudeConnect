#!/usr/bin/env node

/**
 * Claude Connect MCP Server
 *
 * This MCP server provides tools that Claude Code can use to
 * communicate with other Claude Code sessions via the relay server.
 */

import WebSocket from 'ws';
import { DEFAULT_PORT } from '../shared/types';

const RELAY_HOST = process.env.CLAUDE_CONNECT_HOST || 'localhost';
const RELAY_PORT = parseInt(process.env.CLAUDE_CONNECT_PORT || String(DEFAULT_PORT));
const DEVICE_NAME = process.env.CLAUDE_CONNECT_DEVICE || `claude-${process.platform}-${process.pid}`;

let ws: WebSocket | null = null;
let connected = false;
let pendingMessages: any[] = [];
let devices: any[] = [];
let recentMessages: any[] = [];
let tasks: any[] = [];
let clipboard: any[] = [];

function connectToRelay(): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://${RELAY_HOST}:${RELAY_PORT}`);

    ws.on('open', () => {
      connected = true;
      ws!.send(JSON.stringify({
        action: 'register',
        deviceName: DEVICE_NAME,
        platform: process.platform,
      }));
      resolve();
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'welcome':
          devices = msg.devices || [];
          recentMessages = msg.recentMessages || [];
          tasks = msg.tasks || [];
          clipboard = msg.clipboard || [];
          break;
        case 'message':
          recentMessages.push(msg.message);
          if (recentMessages.length > 100) recentMessages.shift();
          break;
        case 'device-connected':
          devices.push(msg.device);
          break;
        case 'device-disconnected':
          devices = devices.filter((d: any) => d.name !== msg.device.name);
          break;
        case 'task-update':
          const idx = tasks.findIndex((t: any) => t.id === msg.task.id);
          if (idx >= 0) tasks[idx] = msg.task;
          else tasks.push(msg.task);
          break;
        case 'clipboard-update':
          clipboard.unshift(msg.entry);
          if (clipboard.length > 50) clipboard.pop();
          break;
        case 'state':
          devices = msg.devices || [];
          recentMessages = msg.messages || [];
          tasks = msg.tasks || [];
          clipboard = msg.clipboard || [];
          break;
      }
    });

    ws.on('close', () => {
      connected = false;
      setTimeout(() => connectToRelay().catch(() => {}), 3000);
    });

    ws.on('error', (err) => {
      reject(err);
    });
  });
}

function send(data: any) {
  if (ws && connected) {
    ws.send(JSON.stringify(data));
  }
}

// MCP Protocol implementation via stdio
const tools = [
  {
    name: 'cc_send_message',
    description: 'Send a message to other connected Claude sessions. Use this to share context, updates, or coordinate work.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to send' },
        to: { type: 'string', description: 'Target device name (omit to broadcast to all)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'cc_send_context',
    description: 'Share your current working context with other sessions. Includes what you just did, files you are working on, and current task.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Summary of what you just did or are doing' },
        activeFiles: { type: 'array', items: { type: 'string' }, description: 'Files currently being worked on' },
        currentTask: { type: 'string', description: 'Current task description' },
        workingDirectory: { type: 'string', description: 'Current working directory' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'cc_get_messages',
    description: 'Get recent messages from other connected Claude sessions. Use this to see what other sessions have been doing.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of recent messages to retrieve (default 20)' },
        from: { type: 'string', description: 'Filter by sender device name' },
      },
    },
  },
  {
    name: 'cc_get_devices',
    description: 'List all devices currently connected to Claude Connect.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cc_create_task',
    description: 'Create a shared task that any connected session can pick up or track.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title' },
        assignedTo: { type: 'string', description: 'Device name to assign to' },
        notes: { type: 'string', description: 'Additional notes' },
      },
      required: ['title'],
    },
  },
  {
    name: 'cc_update_task',
    description: 'Update a shared task status.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID' },
        status: { type: 'string', enum: ['pending', 'in-progress', 'done'], description: 'New status' },
        notes: { type: 'string', description: 'Updated notes' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'cc_get_tasks',
    description: 'List all shared tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'in-progress', 'done'], description: 'Filter by status' },
      },
    },
  },
  {
    name: 'cc_clipboard_add',
    description: 'Add content to the shared clipboard so other sessions can access it.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to share' },
        label: { type: 'string', description: 'Optional label for the content' },
      },
      required: ['content'],
    },
  },
  {
    name: 'cc_clipboard_get',
    description: 'Get items from the shared clipboard.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of items to retrieve (default 10)' },
      },
    },
  },
];

function handleToolCall(name: string, args: any): any {
  switch (name) {
    case 'cc_send_message':
      send({ action: 'message', msgType: 'chat', payload: { text: args.message }, to: args.to });
      return { success: true, message: `Message sent${args.to ? ` to ${args.to}` : ' to all devices'}` };

    case 'cc_send_context':
      send({
        action: 'message',
        msgType: 'context',
        payload: {
          summary: args.summary,
          activeFiles: args.activeFiles || [],
          currentTask: args.currentTask,
          workingDirectory: args.workingDirectory || process.cwd(),
        },
      });
      return { success: true, message: 'Context shared with connected sessions' };

    case 'cc_get_messages': {
      let msgs = [...recentMessages];
      if (args.from) msgs = msgs.filter((m: any) => m.from === args.from);
      const count = args.count || 20;
      return { messages: msgs.slice(-count) };
    }

    case 'cc_get_devices':
      return { devices, thisDevice: DEVICE_NAME };

    case 'cc_create_task':
      send({ action: 'task-create', title: args.title, assignedTo: args.assignedTo, notes: args.notes });
      return { success: true, message: `Task "${args.title}" created` };

    case 'cc_update_task':
      send({ action: 'task-update', taskId: args.taskId, updates: { status: args.status, notes: args.notes } });
      return { success: true, message: `Task ${args.taskId} updated` };

    case 'cc_get_tasks': {
      let t = [...tasks];
      if (args.status) t = t.filter((task: any) => task.status === args.status);
      return { tasks: t };
    }

    case 'cc_clipboard_add':
      send({ action: 'clipboard-add', content: args.content, label: args.label });
      return { success: true, message: 'Content added to shared clipboard' };

    case 'cc_clipboard_get': {
      const count = args.count || 10;
      return { clipboard: clipboard.slice(0, count) };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// MCP stdio protocol
process.stdin.setEncoding('utf8');

let inputBuffer = '';

process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;

  while (true) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = inputBuffer.slice(0, headerEnd);
    const contentLengthMatch = header.match(/Content-Length: (\d+)/);
    if (!contentLengthMatch) {
      inputBuffer = inputBuffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(contentLengthMatch[1]);
    const bodyStart = headerEnd + 4;

    if (inputBuffer.length < bodyStart + contentLength) break;

    const body = inputBuffer.slice(bodyStart, bodyStart + contentLength);
    inputBuffer = inputBuffer.slice(bodyStart + contentLength);

    try {
      const request = JSON.parse(body);
      handleRequest(request);
    } catch (err) {
      // ignore parse errors
    }
  }
});

function sendResponse(response: any) {
  const body = JSON.stringify(response);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  process.stdout.write(header + body);
}

function handleRequest(request: any) {
  const { id, method, params } = request;

  switch (method) {
    case 'initialize':
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: 'claude-connect',
            version: '1.0.0',
          },
        },
      });
      // Connect to relay after initialization
      connectToRelay().catch((err) => {
        console.error('Failed to connect to relay:', err.message);
      });
      break;

    case 'notifications/initialized':
      // No response needed for notifications
      break;

    case 'tools/list':
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: { tools },
      });
      break;

    case 'tools/call': {
      const result = handleToolCall(params.name, params.arguments || {});
      sendResponse({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        },
      });
      break;
    }

    default:
      sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}

// Keep process alive
process.on('SIGINT', () => {
  if (ws) ws.close();
  process.exit(0);
});
