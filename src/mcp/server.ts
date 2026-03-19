#!/usr/bin/env node

/**
 * Claude Connect MCP Server
 * Newline-delimited JSON-RPC over stdio (matches MCP SDK transport)
 */

// Zero external dependencies — uses Node's built-in WebSocket (Node 21+)

const RELAY_HOST = process.env.CLAUDE_CONNECT_HOST || 'localhost';
const RELAY_PORT = parseInt(process.env.CLAUDE_CONNECT_PORT || '3377');
const DEVICE_NAME = process.env.CLAUDE_CONNECT_DEVICE || `claude-${process.platform}-${process.pid}`;
const DEVICE_ROLE = process.env.CLAUDE_CONNECT_ROLE || '';
let projectPath = process.env.CLAUDE_CONNECT_PROJECT || '';

let ws: WebSocket | null = null;
let connected = false;
let devices: any[] = [];
let recentMessages: any[] = [];
let tasks: any[] = [];
let clipboard: any[] = [];
let conversationLog: any[] = [];

// Suppress unhandled errors but keep stderr functional
process.on('uncaughtException', () => {});
process.on('unhandledRejection', () => {});

function connectToRelay() {
  try {
    ws = new WebSocket(`ws://${RELAY_HOST}:${RELAY_PORT}`);
    ws.addEventListener('open', () => {
      connected = true;
      ws!.send(JSON.stringify({ action: 'register', deviceName: DEVICE_NAME, platform: process.platform }));
    });
    ws.addEventListener('message', (event: any) => {
      try { handleRelayMessage(JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())); } catch {}
    });
    ws.addEventListener('close', () => { connected = false; ws = null; setTimeout(connectToRelay, 3000); });
    ws.addEventListener('error', () => { connected = false; ws = null; });
  } catch {
    setTimeout(connectToRelay, 3000);
  }
}

function updateProjectPathFromDevices() {
  // Pick up our own project path from the device list (set by Electron app via relay)
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
  }
}

function relaySend(data: any) {
  if (ws && connected) { try { ws.send(JSON.stringify(data)); } catch {} }
}

// --- Tool definitions ---
const TOOLS = [
  { name: 'cc_sync', description: `Check in with other Claude sessions. Call FIRST to see what the other side did. You are "${DEVICE_NAME}"${DEVICE_ROLE ? ` (role: ${DEVICE_ROLE})` : ''}.`, inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'cc_work_update', description: 'Post what you just did so the other session knows.', inputSchema: { type: 'object' as const, properties: { summary: { type: 'string' }, filesChanged: { type: 'array', items: { type: 'string' } }, nextSteps: { type: 'string' } }, required: ['summary'] } },
  { name: 'cc_delegate', description: 'Send a task to the other machine.', inputSchema: { type: 'object' as const, properties: { task: { type: 'string' }, target: { type: 'string' }, details: { type: 'string' } }, required: ['task'] } },
  { name: 'cc_ask', description: 'Ask the other Claude a question.', inputSchema: { type: 'object' as const, properties: { question: { type: 'string' } }, required: ['question'] } },
  { name: 'cc_send_message', description: 'Send a message to other sessions.', inputSchema: { type: 'object' as const, properties: { message: { type: 'string' }, to: { type: 'string' } }, required: ['message'] } },
  { name: 'cc_get_conversation', description: 'Get cross-session conversation history.', inputSchema: { type: 'object' as const, properties: { count: { type: 'number' } } } },
  { name: 'cc_get_tasks', description: 'List shared tasks.', inputSchema: { type: 'object' as const, properties: { status: { type: 'string', enum: ['pending', 'in-progress', 'done'] } } } },
  { name: 'cc_complete_task', description: 'Mark a task as done.', inputSchema: { type: 'object' as const, properties: { taskId: { type: 'string' }, result: { type: 'string' } }, required: ['taskId'] } },
  { name: 'cc_clipboard_share', description: 'Share content with the other session.', inputSchema: { type: 'object' as const, properties: { content: { type: 'string' }, label: { type: 'string' } }, required: ['content'] } },
  { name: 'cc_clipboard_get', description: 'Get shared content.', inputSchema: { type: 'object' as const, properties: { count: { type: 'number' } } } },
  { name: 'cc_get_devices', description: 'See connected machines.', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'cc_push_files', description: 'Push changed files to a target device. Sends local project files that differ from the remote.', inputSchema: { type: 'object' as const, properties: { target: { type: 'string', description: 'Target device name' }, files: { type: 'array', items: { type: 'string' }, description: 'Optional specific file paths to push' } }, required: ['target'] } },
  { name: 'cc_pull_files', description: 'Pull changed files from a target device. Requests files that differ from local.', inputSchema: { type: 'object' as const, properties: { target: { type: 'string', description: 'Target device name' } }, required: ['target'] } },
  { name: 'cc_project_status', description: 'Compare project file manifests between this machine and a target device.', inputSchema: { type: 'object' as const, properties: { target: { type: 'string', description: 'Target device name to compare with' } }, required: ['target'] } },
];

function handleTool(name: string, args: any): any {
  switch (name) {
    case 'cc_sync': return {
      thisDevice: DEVICE_NAME, role: DEVICE_ROLE || 'not set', connected,
      projectPath: projectPath || 'not set — select a project folder in the Claude Connect app',
      connectedDevices: devices,
      recentActivityFromOthers: conversationLog.filter((m: any) => m.from !== DEVICE_NAME).slice(-30)
        .map((m: any) => ({ from: m.from, time: new Date(m.timestamp).toLocaleTimeString(), type: m.type, content: m.payload?.summary || m.payload?.text || m.payload })),
      tasksForYou: tasks.filter((t: any) => (t.assignedTo === DEVICE_NAME || !t.assignedTo) && t.status !== 'done'),
      sharedClipboard: clipboard.slice(0, 5),
    };
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
      // Tell the local Electron app to initiate push (it has the file I/O)
      relaySend({ action: 'mcp-trigger-sync', direction: 'push', target: args.target, syncId, filePaths: args.files });
      return { success: true, syncId, message: `Push to ${args.target} triggered. The Claude Connect app is handling the file transfer.` };
    }
    case 'cc_pull_files': {
      if (!projectPath) return { error: 'No project folder configured. Select a project folder in the Claude Connect app first.' };
      const syncId = `mcp-pull-${Date.now()}`;
      // Tell the local Electron app to initiate pull
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
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// --- Stdio MCP Protocol (newline-delimited JSON) ---

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
    try { handleMessage(JSON.parse(line)); } catch {}
  }
});

function handleMessage(req: any) {
  const { id, method, params } = req;

  // Notifications (no id) — just acknowledge
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      sendJsonRpc({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-connect', version: '1.0.0' },
      }});
      connectToRelay();
      break;

    case 'tools/list':
      sendJsonRpc({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      break;

    case 'tools/call': {
      const result = handleTool(params.name, params.arguments || {});
      sendJsonRpc({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }});
      break;
    }

    default:
      sendJsonRpc({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  }
}

process.on('SIGINT', () => { if (ws) { try { ws.close(); } catch {} } process.exit(0); });
