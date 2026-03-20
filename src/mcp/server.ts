#!/usr/bin/env node

/**
 * Claude Connect MCP Server
 * Newline-delimited JSON-RPC over stdio (MCP protocol compliant)
 */

const fs = require('fs');
const nodePath = require('path');

// WebSocket: use ws package for reliability across all Node versions
let WS: any;
try {
  WS = require('ws');
} catch {
  // Fallback to Node built-in WebSocket (Node 21+)
  WS = (globalThis as any).WebSocket;
}

const RELAY_HOST = process.env.CLAUDE_CONNECT_HOST || 'localhost';
const RELAY_PORT = parseInt(process.env.CLAUDE_CONNECT_PORT || '3377');
const DEVICE_NAME = process.env.CLAUDE_CONNECT_DEVICE || `claude-${process.platform}-${process.pid}`;
const DEVICE_ROLE = process.env.CLAUDE_CONNECT_ROLE || '';
let projectPath = process.env.CLAUDE_CONNECT_PROJECT || '';

let ws: any = null;
let connected = false;
let devices: any[] = [];
let recentMessages: any[] = [];
let tasks: any[] = [];
let clipboard: any[] = [];
let conversationLog: any[] = [];
let lastDeliveredIndex = 0;
let relayConnectPending = false;

// Log to stderr (never stdout — that's for MCP JSON-RPC)
function log(msg: string) {
  process.stderr.write(`[claude-connect-mcp] ${msg}\n`);
}

function connectToRelay() {
  if (!WS) {
    log('No WebSocket implementation available — relay features disabled');
    return;
  }
  if (relayConnectPending || connected) return;
  relayConnectPending = true;

  try {
    ws = new WS(`ws://${RELAY_HOST}:${RELAY_PORT}`);

    const onOpen = () => {
      connected = true;
      relayConnectPending = false;
      log(`Connected to relay at ${RELAY_HOST}:${RELAY_PORT}`);
      ws.send(JSON.stringify({ action: 'register', deviceName: DEVICE_NAME, platform: process.platform }));
    };

    const onMessage = (event: any) => {
      try {
        const data = typeof event === 'string' ? event
          : typeof event.data === 'string' ? event.data
          : event.data?.toString?.() || event.toString();
        handleRelayMessage(JSON.parse(data));
      } catch {}
    };

    const onClose = () => {
      connected = false;
      relayConnectPending = false;
      ws = null;
      setTimeout(connectToRelay, 3000);
    };

    const onError = (err: any) => {
      log(`Relay connection error: ${err?.message || 'unknown'}`);
      connected = false;
      relayConnectPending = false;
      ws = null;
    };

    // Support both EventEmitter (ws package) and EventTarget (browser WebSocket) APIs
    if (typeof ws.on === 'function') {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);
    } else {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', onClose);
      ws.addEventListener('error', onError);
    }
  } catch (err: any) {
    log(`Failed to create WebSocket: ${err?.message || 'unknown'}`);
    relayConnectPending = false;
    setTimeout(connectToRelay, 3000);
  }
}

function updateProjectPathFromDevices() {
  const self = devices.find((d: any) => d.name === DEVICE_NAME);
  if (self?.projectPath) {
    projectPath = self.projectPath;
  }
}

function handleRelayMessage(msg: any) {
  switch (msg.type) {
    case 'welcome':
      devices = msg.devices || [];
      recentMessages = msg.recentMessages || [];
      tasks = msg.tasks || [];
      clipboard = msg.clipboard || [];
      conversationLog = (msg.recentMessages || []).filter(
        (m: any) => ['context', 'chat', 'work-update'].includes(m.type)
      );
      updateProjectPathFromDevices();
      break;
    case 'message':
      recentMessages.push(msg.message);
      if (recentMessages.length > 200) recentMessages.shift();
      if (['context', 'chat', 'work-update'].includes(msg.message.type)) {
        conversationLog.push(msg.message);
        if (conversationLog.length > 200) conversationLog.shift();
      }
      break;
    case 'device-connected': devices.push(msg.device); break;
    case 'device-disconnected': devices = devices.filter((d: any) => d.name !== msg.device.name); break;
    case 'device-updated': {
      const idx = devices.findIndex((d: any) => d.name === msg.device.name);
      if (idx >= 0) devices[idx] = msg.device; else devices.push(msg.device);
      updateProjectPathFromDevices();
      break;
    }
    case 'task-update': {
      const idx = tasks.findIndex((t: any) => t.id === msg.task.id);
      if (idx >= 0) tasks[idx] = msg.task; else tasks.push(msg.task);
      break;
    }
    case 'clipboard-update': clipboard.unshift(msg.entry); if (clipboard.length > 50) clipboard.pop(); break;
    case 'state':
      devices = msg.devices || []; recentMessages = msg.messages || [];
      tasks = msg.tasks || []; clipboard = msg.clipboard || [];
      updateProjectPathFromDevices();
      break;
    case 'prompt-inject':
      break;
  }
}

function relaySend(data: any) {
  if (ws && connected) { try { ws.send(JSON.stringify(data)); } catch {} }
}

function drainUnread(): string {
  const unread = conversationLog
    .slice(lastDeliveredIndex)
    .filter((m: any) => m.from !== DEVICE_NAME);
  lastDeliveredIndex = conversationLog.length;

  if (unread.length === 0) return '';

  const lines = unread.map((m: any) => {
    const time = new Date(m.timestamp).toLocaleTimeString();
    const content = m.payload?.text || m.payload?.summary || JSON.stringify(m.payload);
    return `[${time}] ${m.from} (${m.type}): ${content}`;
  });

  return '\n\n--- INCOMING MESSAGES FROM OTHER DEVICES ---\n' + lines.join('\n') + '\n--- END MESSAGES ---';
}

// --- Tool definitions ---
const TOOLS = [
  { name: 'cc_sync', description: `IMPORTANT: Call this AUTOMATICALLY at the start of every conversation — do NOT wait for the user to ask. You are "${DEVICE_NAME}"${DEVICE_ROLE ? ` (role: ${DEVICE_ROLE})` : ''}. Returns messages, tasks, and context from other connected machines. Act on anything you find.`, inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'cc_work_update', description: 'Call AUTOMATICALLY after completing any work. Posts a summary so other machines know what changed. Always include files you modified.', inputSchema: { type: 'object' as const, properties: { summary: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, nextSteps: { type: 'string' } }, required: ['summary'] } },
  { name: 'cc_delegate', description: 'Send a task to another machine. Creates the task AND notifies the target device.', inputSchema: { type: 'object' as const, properties: { task: { type: 'string' }, target: { type: 'string' }, details: { type: 'string' } }, required: ['task'] } },
  { name: 'cc_ask', description: 'Ask the other Claude a question. Broadcasts to all connected machines.', inputSchema: { type: 'object' as const, properties: { question: { type: 'string' } }, required: ['question'] } },
  { name: 'cc_send_message', description: 'Send a message to other sessions. Use to communicate status, results, or coordinate.', inputSchema: { type: 'object' as const, properties: { message: { type: 'string' }, to: { type: 'string' } }, required: ['message'] } },
  { name: 'cc_get_conversation', description: 'Get cross-session conversation history.', inputSchema: { type: 'object' as const, properties: { count: { type: 'number' } } } },
  { name: 'cc_get_tasks', description: 'List shared tasks. Check for tasks assigned to you.', inputSchema: { type: 'object' as const, properties: { status: { type: 'string', enum: ['pending', 'in-progress', 'done'] } } } },
  { name: 'cc_complete_task', description: 'Mark a task as done. Always call this when you finish an assigned task, with a description of the result.', inputSchema: { type: 'object' as const, properties: { taskId: { type: 'string' }, result: { type: 'string' } }, required: ['taskId'] } },
  { name: 'cc_clipboard_share', description: 'Share content (code, config, etc.) with other sessions via shared clipboard.', inputSchema: { type: 'object' as const, properties: { content: { type: 'string' }, label: { type: 'string' } }, required: ['content'] } },
  { name: 'cc_clipboard_get', description: 'Get shared clipboard content from other sessions.', inputSchema: { type: 'object' as const, properties: { count: { type: 'number' } } } },
  { name: 'cc_get_devices', description: 'See connected machines and their project paths.', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'cc_push_files', description: 'CALL AUTOMATICALLY after creating or modifying files to push them to connected devices. Keeps project folders in sync.', inputSchema: { type: 'object' as const, properties: { target: { type: 'string', description: 'Target device name' }, files: { type: 'array', items: { type: 'string' }, description: 'Specific file paths to push (relative to project). Omit to push all changed files.' } }, required: ['target'] } },
  { name: 'cc_pull_files', description: 'Pull files from a target device. Call when the other machine has made changes you need.', inputSchema: { type: 'object' as const, properties: { target: { type: 'string', description: 'Target device name' } }, required: ['target'] } },
  { name: 'cc_project_status', description: 'Compare file manifests between machines to see what differs.', inputSchema: { type: 'object' as const, properties: { target: { type: 'string', description: 'Target device name to compare with' } }, required: ['target'] } },
  { name: 'cc_check_inbox', description: 'Read and clear the message inbox. Contains real-time messages and tasks from other machines. Call this to see what other devices have sent you.', inputSchema: { type: 'object' as const, properties: {} } },
];

function handleTool(name: string, args: any): any {
  switch (name) {
    case 'cc_sync': {
      let inbox = '';
      if (projectPath) {
        const inboxPath = nodePath.join(projectPath, '.claude-connect-inbox');
        try { inbox = fs.readFileSync(inboxPath, 'utf8').trim(); } catch {}
        if (inbox) { try { fs.writeFileSync(inboxPath, ''); } catch {} }
      }
      return {
        thisDevice: DEVICE_NAME, role: DEVICE_ROLE || 'not set', connected,
        projectPath: projectPath || 'not set — select a project folder in the Claude Connect app',
        connectedDevices: devices,
        ...(inbox ? { inbox } : {}),
        recentActivityFromOthers: conversationLog.filter((m: any) => m.from !== DEVICE_NAME).slice(-30)
          .map((m: any) => ({ from: m.from, time: new Date(m.timestamp).toLocaleTimeString(), type: m.type, content: m.payload?.summary || m.payload?.text || m.payload })),
        tasksForYou: tasks.filter((t: any) => (t.assignedTo === DEVICE_NAME || !t.assignedTo) && t.status !== 'done'),
        sharedClipboard: clipboard.slice(0, 5),
      };
    }
    case 'cc_work_update':
      relaySend({ action: 'message', msgType: 'work-update', payload: { summary: args.summary, filesChanged: args.filesChanged || [], nextSteps: args.nextSteps } });
      return { success: true };
    case 'cc_delegate':
      relaySend({ action: 'task-create', title: args.task, assignedTo: args.target, notes: args.details || '' });
      relaySend({ action: 'message', msgType: 'chat', payload: { text: `Delegated: ${args.task}` }, to: args.target });
      return { success: true };
    case 'cc_ask':
      relaySend({ action: 'message', msgType: 'chat', payload: { text: `? ${args.question}` } });
      return { success: true };
    case 'cc_send_message':
      relaySend({ action: 'message', msgType: 'chat', payload: { text: args.message }, to: args.to });
      return { success: true };
    case 'cc_get_conversation':
      return { conversation: conversationLog.slice(-(args.count || 50)).map((m: any) => ({ from: m.from, time: new Date(m.timestamp).toLocaleTimeString(), type: m.type, content: m.payload?.text || m.payload?.summary || m.payload })) };
    case 'cc_get_tasks':
      return { tasks: args.status ? tasks.filter((t: any) => t.status === args.status) : tasks };
    case 'cc_complete_task':
      relaySend({ action: 'task-update', taskId: args.taskId, updates: { status: 'done', notes: args.result } });
      return { success: true };
    case 'cc_clipboard_share':
      relaySend({ action: 'clipboard-add', content: args.content, label: args.label });
      return { success: true };
    case 'cc_clipboard_get':
      return { clipboard: clipboard.slice(0, args.count || 10) };
    case 'cc_get_devices':
      return { devices, thisDevice: DEVICE_NAME, connected };
    case 'cc_push_files': {
      if (!projectPath) return { error: 'No project folder configured. Select a project folder in the Claude Connect app first.' };
      const syncId = `mcp-push-${Date.now()}`;
      relaySend({ action: 'mcp-trigger-sync', direction: 'push', target: args.target, syncId, filePaths: args.files });
      return { success: true, syncId, message: `Push to ${args.target} triggered. The Claude Connect app is handling the file transfer.` };
    }
    case 'cc_pull_files': {
      if (!projectPath) return { error: 'No project folder configured. Select a project folder in the Claude Connect app first.' };
      const syncId = `mcp-pull-${Date.now()}`;
      relaySend({ action: 'mcp-trigger-sync', direction: 'pull', target: args.target, syncId });
      return { success: true, syncId, message: `Pull from ${args.target} triggered. The Claude Connect app is handling the file transfer.` };
    }
    case 'cc_project_status': {
      if (!projectPath) return { error: 'No project folder configured. Select a project folder in the Claude Connect app first.' };
      const targetDevice = devices.find((d: any) => d.name === args.target);
      return {
        thisDevice: DEVICE_NAME,
        projectPath,
        target: args.target,
        targetProjectPath: targetDevice?.projectPath || 'unknown',
        targetOnline: !!targetDevice && targetDevice.status === 'online',
        message: 'Use cc_push_files or cc_pull_files to sync. The Electron app handles manifest comparison and file transfer.',
      };
    }
    case 'cc_check_inbox': {
      if (!projectPath) return { inbox: '', message: 'No project folder set.' };
      const inboxPath = nodePath.join(projectPath, '.claude-connect-inbox');
      let content = '';
      try { content = fs.readFileSync(inboxPath, 'utf8').trim(); } catch {}
      if (content) {
        try { fs.writeFileSync(inboxPath, ''); } catch {}
        return { inbox: content };
      }
      return { inbox: '', message: 'No new messages.' };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// --- Stdio MCP Protocol (newline-delimited JSON-RPC) ---

function sendJsonRpc(obj: any) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let newlineIdx: number;
  while ((newlineIdx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, newlineIdx).replace(/\r$/, '');
    buf = buf.slice(newlineIdx + 1);
    if (!line) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch (err: any) {
      log(`Failed to parse message: ${err?.message}`);
    }
  }
});

function handleMessage(req: any) {
  const { id, method, params } = req;

  // Notifications (no id) — acknowledge silently
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      log('Client initialized notification received');
    }
    return;
  }

  switch (method) {
    case 'initialize':
      sendJsonRpc({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: {
          tools: { listChanged: false },
          resources: {},
          prompts: {},
        },
        serverInfo: { name: 'claude-connect', version: '1.4.0' },
      }});
      // Defer relay connection — don't block the health check handshake
      setTimeout(() => connectToRelay(), 100);
      break;

    case 'ping':
      sendJsonRpc({ jsonrpc: '2.0', id, result: {} });
      break;

    case 'tools/list':
      sendJsonRpc({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      break;

    case 'tools/call': {
      const result = handleTool(params.name, params.arguments || {});
      const unread = drainUnread();
      const text = JSON.stringify(result, null, 2) + unread;
      sendJsonRpc({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text }],
      }});
      break;
    }

    case 'resources/list':
      sendJsonRpc({ jsonrpc: '2.0', id, result: { resources: [] } });
      break;

    case 'prompts/list':
      sendJsonRpc({ jsonrpc: '2.0', id, result: { prompts: [] } });
      break;

    default:
      sendJsonRpc({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  if (ws) { try { ws.close(); } catch {} }
  process.exit(0);
});

process.on('SIGTERM', () => {
  if (ws) { try { ws.close(); } catch {} }
  process.exit(0);
});

// Only log real crashes, don't swallow silently
process.on('uncaughtException', (err: any) => {
  log(`Uncaught exception: ${err?.message || err}`);
});

process.on('unhandledRejection', (err: any) => {
  log(`Unhandled rejection: ${err?.message || err}`);
});

log('MCP server starting...');
