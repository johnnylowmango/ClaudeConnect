#!/usr/bin/env node

/**
 * Claude Connect MCP Server
 *
 * Gives Claude Code tools to communicate with other Claude Code sessions
 * via the relay server. Enables cross-machine collaboration.
 */

import WebSocket from 'ws';
import { DEFAULT_PORT } from '../shared/types';

const RELAY_HOST = process.env.CLAUDE_CONNECT_HOST || 'localhost';
const RELAY_PORT = parseInt(process.env.CLAUDE_CONNECT_PORT || String(DEFAULT_PORT));
const DEVICE_NAME = process.env.CLAUDE_CONNECT_DEVICE || `claude-${process.platform}-${process.pid}`;
const DEVICE_ROLE = process.env.CLAUDE_CONNECT_ROLE || ''; // e.g. "iOS builder", "Android builder"

let ws: WebSocket | null = null;
let connected = false;
let devices: any[] = [];
let recentMessages: any[] = [];
let tasks: any[] = [];
let clipboard: any[] = [];
let conversationLog: any[] = []; // full cross-session conversation history

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
          // Build conversation log from existing messages
          conversationLog = (msg.recentMessages || []).filter(
            (m: any) => m.type === 'context' || m.type === 'chat' || m.type === 'work-update'
          );
          break;
        case 'message':
          recentMessages.push(msg.message);
          if (recentMessages.length > 200) recentMessages.shift();
          if (['context', 'chat', 'work-update'].includes(msg.message.type)) {
            conversationLog.push(msg.message);
            if (conversationLog.length > 200) conversationLog.shift();
          }
          break;
        case 'device-connected':
          devices.push(msg.device);
          break;
        case 'device-disconnected':
          devices = devices.filter((d: any) => d.name !== msg.device.name);
          break;
        case 'task-update': {
          const idx = tasks.findIndex((t: any) => t.id === msg.task.id);
          if (idx >= 0) tasks[idx] = msg.task;
          else tasks.push(msg.task);
          break;
        }
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

const tools = [
  {
    name: 'cc_sync',
    description: `Check in with the other Claude session(s). Call this FIRST at the start of any conversation to see what the other side has been doing, what tasks are pending for you, and what context you need. This is your primary way to stay in sync. You are "${DEVICE_NAME}"${DEVICE_ROLE ? ` (role: ${DEVICE_ROLE})` : ''}.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'cc_work_update',
    description: 'Post an update about work you just completed. Call this after finishing any significant piece of work (file edits, builds, deployments, bug fixes) so the other session knows what changed. Be specific about what files changed and what was done.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What you just did — be specific. e.g. "Fixed login validation in lib/auth/login.dart, added email format check, all tests passing"' },
        filesChanged: { type: 'array', items: { type: 'string' }, description: 'List of files that were modified' },
        currentTask: { type: 'string', description: 'What task this was part of' },
        nextSteps: { type: 'string', description: 'What should happen next, especially if the other side needs to do something' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'cc_delegate',
    description: 'Delegate a task to the other machine. Use this when work needs to happen on the other side — e.g. "run the iOS build", "deploy to Android", "test on Windows". The task will appear on their end with instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What needs to be done' },
        target: { type: 'string', description: 'Which device should do this (device name)' },
        details: { type: 'string', description: 'Detailed instructions or context' },
        priority: { type: 'string', enum: ['low', 'normal', 'urgent'], description: 'How urgent is this' },
      },
      required: ['task'],
    },
  },
  {
    name: 'cc_ask',
    description: 'Ask the other Claude session a question. Use this when you need information from the other side — e.g. "what iOS version are we targeting?", "did the Android build pass?", "what error are you seeing?"',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask' },
        to: { type: 'string', description: 'Target device name (omit to ask all)' },
      },
      required: ['question'],
    },
  },
  {
    name: 'cc_send_message',
    description: 'Send a general message to other connected Claude sessions.',
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
    name: 'cc_get_conversation',
    description: 'Get the full cross-session conversation history. Shows everything both sides have communicated — work updates, questions, delegated tasks, and messages. Use this to understand the full picture of what has happened across all sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of recent entries (default 50)' },
        from: { type: 'string', description: 'Filter by sender device name' },
      },
    },
  },
  {
    name: 'cc_get_tasks',
    description: 'List all shared tasks. Check for tasks assigned to you or pending tasks that need attention.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'in-progress', 'done'], description: 'Filter by status' },
        assignedTo: { type: 'string', description: 'Filter by assigned device' },
      },
    },
  },
  {
    name: 'cc_complete_task',
    description: 'Mark a task as done and report the result.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to complete' },
        result: { type: 'string', description: 'What was the outcome? Include any relevant output, errors, or status.' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'cc_start_task',
    description: 'Mark a task as in-progress so the other side knows you are working on it.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to start' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'cc_clipboard_share',
    description: 'Share a code snippet, config, error log, or any text with the other session. Use this to pass specific content that the other side needs — API keys, build output, code blocks, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to share' },
        label: { type: 'string', description: 'What this is — e.g. "API response", "build error", "config update"' },
      },
      required: ['content'],
    },
  },
  {
    name: 'cc_clipboard_get',
    description: 'Get shared content from the clipboard. Check for code snippets, configs, or other content the other session shared with you.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Number of items to retrieve (default 10)' },
      },
    },
  },
  {
    name: 'cc_get_devices',
    description: 'See which machines are currently connected.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

function handleToolCall(name: string, args: any): any {
  switch (name) {
    case 'cc_sync': {
      // Get everything the other side has been doing
      const otherMessages = conversationLog.filter((m: any) => m.from !== DEVICE_NAME).slice(-30);
      const myPendingTasks = tasks.filter((t: any) =>
        (t.assignedTo === DEVICE_NAME || !t.assignedTo) && t.status !== 'done'
      );
      const recentClipboard = clipboard.slice(0, 5);

      return {
        thisDevice: DEVICE_NAME,
        role: DEVICE_ROLE || 'not set',
        connectedDevices: devices,
        recentActivityFromOthers: otherMessages.length > 0
          ? otherMessages.map((m: any) => ({
              from: m.from,
              time: new Date(m.timestamp).toLocaleTimeString(),
              type: m.type,
              content: m.type === 'context' || m.type === 'work-update'
                ? m.payload
                : m.payload?.text || m.payload,
            }))
          : 'No activity from other sessions yet.',
        tasksForYou: myPendingTasks.length > 0
          ? myPendingTasks
          : 'No pending tasks assigned to you.',
        sharedClipboard: recentClipboard.length > 0
          ? recentClipboard
          : 'Clipboard is empty.',
        instructions: `You are ${DEVICE_NAME}. ${DEVICE_ROLE ? `Your role: ${DEVICE_ROLE}. ` : ''}Check the activity above to understand what the other session(s) have been doing. Pick up any tasks assigned to you. Post work updates after completing significant work so the other side stays informed.`,
      };
    }

    case 'cc_work_update': {
      const payload = {
        summary: args.summary,
        filesChanged: args.filesChanged || [],
        currentTask: args.currentTask,
        nextSteps: args.nextSteps,
        workingDirectory: process.cwd(),
      };
      send({ action: 'message', msgType: 'work-update', payload });
      return { success: true, message: 'Work update posted. Other sessions will see this.' };
    }

    case 'cc_delegate': {
      // Create task AND send a message about it
      send({
        action: 'task-create',
        title: args.task,
        assignedTo: args.target,
        notes: `${args.details || ''}\n\nPriority: ${args.priority || 'normal'}\nDelegated by: ${DEVICE_NAME}`,
      });
      send({
        action: 'message',
        msgType: 'chat',
        payload: { text: `📋 Delegated task to ${args.target || 'any'}: ${args.task}` },
        to: args.target,
      });
      return { success: true, message: `Task delegated${args.target ? ` to ${args.target}` : ''}. They'll see it when they sync.` };
    }

    case 'cc_ask': {
      send({
        action: 'message',
        msgType: 'chat',
        payload: { text: `❓ ${args.question}` },
        to: args.to,
      });
      return { success: true, message: `Question sent. Check back with cc_sync or cc_get_conversation to see the reply.` };
    }

    case 'cc_send_message':
      send({ action: 'message', msgType: 'chat', payload: { text: args.message }, to: args.to });
      return { success: true, message: `Message sent${args.to ? ` to ${args.to}` : ' to all'}` };

    case 'cc_get_conversation': {
      const count = args.count || 50;
      let log = [...conversationLog];
      if (args.from) log = log.filter((m: any) => m.from === args.from);
      return {
        conversation: log.slice(-count).map((m: any) => ({
          from: m.from,
          time: new Date(m.timestamp).toLocaleTimeString(),
          type: m.type,
          content: m.payload?.text || m.payload?.summary || m.payload,
        })),
      };
    }

    case 'cc_get_tasks': {
      let t = [...tasks];
      if (args.status) t = t.filter((task: any) => task.status === args.status);
      if (args.assignedTo) t = t.filter((task: any) => task.assignedTo === args.assignedTo);
      return { tasks: t, thisDevice: DEVICE_NAME };
    }

    case 'cc_complete_task': {
      send({
        action: 'task-update',
        taskId: args.taskId,
        updates: { status: 'done', notes: args.result },
      });
      send({
        action: 'message',
        msgType: 'work-update',
        payload: { summary: `Completed task ${args.taskId}: ${args.result}` },
      });
      return { success: true, message: 'Task marked as done. Result shared with other sessions.' };
    }

    case 'cc_start_task': {
      send({
        action: 'task-update',
        taskId: args.taskId,
        updates: { status: 'in-progress' },
      });
      return { success: true, message: 'Task marked as in-progress.' };
    }

    case 'cc_clipboard_share':
      send({ action: 'clipboard-add', content: args.content, label: args.label });
      return { success: true, message: 'Content shared to clipboard. Other sessions can access it.' };

    case 'cc_clipboard_get': {
      const count = args.count || 10;
      return { clipboard: clipboard.slice(0, count) };
    }

    case 'cc_get_devices':
      return { devices, thisDevice: DEVICE_NAME, role: DEVICE_ROLE || 'not set' };

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
      connectToRelay().catch((err) => {
        console.error('Failed to connect to relay:', err.message);
      });
      break;

    case 'notifications/initialized':
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

process.on('SIGINT', () => {
  if (ws) ws.close();
  process.exit(0);
});
