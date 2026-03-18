import React, { useState, useEffect, useRef, useCallback } from 'react';
import './styles.css';

const { ipcRenderer } = (window as any).require('electron');

// Dynamic imports for xterm (loaded when terminal tab opens)
let Terminal: any = null;
let FitAddon: any = null;
let WebLinksAddon: any = null;

type Tab = 'connect' | 'messages' | 'tasks' | 'clipboard' | 'terminal';
type Mode = 'idle' | 'hosting' | 'connected';

interface Message {
  id: string;
  type: string;
  from: string;
  timestamp: number;
  payload: any;
}

interface Device {
  name: string;
  platform: string;
  status: string;
}

interface Task {
  id: string;
  title: string;
  status: string;
  assignedTo?: string;
  createdBy: string;
  notes?: string;
}

interface ClipboardItem {
  id: string;
  content: string;
  label?: string;
  createdBy: string;
  createdAt: number;
}

interface UpdateInfo {
  available: boolean;
  version?: string;
  downloading: boolean;
  progress: number;
  ready: boolean;
}

export default function App() {
  const [tab, setTab] = useState<Tab>('connect');
  const [mode, setMode] = useState<Mode>('idle');
  const [devices, setDevices] = useState<Device[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [clipboard, setClipboard] = useState<ClipboardItem[]>([]);
  const [hostInput, setHostInput] = useState('');
  const [portInput, setPortInput] = useState('3377');
  const [deviceName, setDeviceName] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [taskInput, setTaskInput] = useState('');
  const [clipboardInput, setClipboardInput] = useState('');
  const [clipboardLabel, setClipboardLabel] = useState('');
  const [status, setStatus] = useState('Disconnected');
  const [connectionInfo, setConnectionInfo] = useState<any>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({
    available: false, downloading: false, progress: 0, ready: false,
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Terminal state
  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const termIdRef = useRef<number | null>(null);
  const [termReady, setTermReady] = useState(false);

  useEffect(() => {
    ipcRenderer.invoke('get-connection-info').then(setConnectionInfo);

    ipcRenderer.on('client-event', (_: any, { event, data }: any) => {
      switch (event) {
        case 'welcome':
          setDevices(data.devices || []);
          setMessages(data.recentMessages || []);
          setTasks(data.tasks || []);
          setClipboard(data.clipboard || []);
          break;
        case 'message':
          setMessages(prev => [...prev, data]);
          break;
        case 'device-connected':
          setDevices(prev => [...prev.filter(d => d.name !== data.name), data]);
          break;
        case 'device-disconnected':
          setDevices(prev => prev.filter(d => d.name !== data.name));
          break;
        case 'task-update':
          setTasks(prev => {
            const idx = prev.findIndex(t => t.id === data.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = data;
              return next;
            }
            return [...prev, data];
          });
          break;
        case 'clipboard-update':
          setClipboard(prev => [data, ...prev].slice(0, 50));
          break;
        case 'connected':
          setStatus('Connected');
          break;
        case 'disconnected':
          setStatus('Reconnecting...');
          break;
      }
    });

    ipcRenderer.on('updater-event', (_: any, data: any) => {
      switch (data.event) {
        case 'update-available':
          setUpdateInfo(prev => ({ ...prev, available: true, version: data.version }));
          break;
        case 'download-progress':
          setUpdateInfo(prev => ({ ...prev, downloading: true, progress: data.percent }));
          break;
        case 'update-downloaded':
          setUpdateInfo(prev => ({ ...prev, downloading: false, ready: true }));
          break;
      }
    });

    // Listen for terminal data
    ipcRenderer.on('terminal-data', (_: any, { id, data }: any) => {
      if (termInstanceRef.current && id === termIdRef.current) {
        termInstanceRef.current.write(data);
      }
    });

    ipcRenderer.on('terminal-exit', (_: any, { id }: any) => {
      if (id === termIdRef.current) {
        termInstanceRef.current?.write('\r\n\x1b[90m[Terminal exited. Click "Launch Claude" to start a new session.]\x1b[0m\r\n');
        termIdRef.current = null;
      }
    });

    return () => {
      ipcRenderer.removeAllListeners('client-event');
      ipcRenderer.removeAllListeners('server-event');
      ipcRenderer.removeAllListeners('updater-event');
      ipcRenderer.removeAllListeners('terminal-data');
      ipcRenderer.removeAllListeners('terminal-exit');
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Initialize terminal when tab is shown
  const initTerminal = useCallback(async () => {
    if (termInstanceRef.current || !terminalRef.current) return;

    try {
      // Load xterm modules
      if (!Terminal) {
        const xtermMod = require('@xterm/xterm');
        const fitMod = require('@xterm/addon-fit');
        const linksMod = require('@xterm/addon-web-links');
        Terminal = xtermMod.Terminal;
        FitAddon = fitMod.FitAddon;
        WebLinksAddon = linksMod.WebLinksAddon;

        // Load xterm CSS
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = require.resolve('@xterm/xterm/css/xterm.css');
        document.head.appendChild(link);
      }

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;

      const term = new Terminal({
        fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontSize: 13,
        lineHeight: 1.4,
        cursorBlink: true,
        cursorStyle: 'bar',
        theme: {
          background: '#08090c',
          foreground: '#e8e9ed',
          cursor: '#7c8aff',
          cursorAccent: '#08090c',
          selectionBackground: 'rgba(124, 138, 255, 0.3)',
          black: '#1a1b26',
          red: '#e05c5c',
          green: '#4a9e6b',
          yellow: '#e0a55c',
          blue: '#5b7cc5',
          magenta: '#a78bfa',
          cyan: '#6ee7b7',
          white: '#e8e9ed',
          brightBlack: '#444b6a',
          brightRed: '#ff7a93',
          brightGreen: '#6ee7b7',
          brightYellow: '#ffd580',
          brightBlue: '#7c8aff',
          brightMagenta: '#c3a6ff',
          brightCyan: '#7ee5c2',
          brightWhite: '#ffffff',
        },
      });

      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(terminalRef.current);
      fitAddon.fit();

      termInstanceRef.current = term;
      setTermReady(true);

      // Handle resize
      const resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon.fit();
          if (termIdRef.current !== null) {
            ipcRenderer.invoke('terminal-resize', termIdRef.current, term.cols, term.rows);
          }
        } catch {}
      });
      resizeObserver.observe(terminalRef.current);

      // Handle input
      term.onData((data: string) => {
        if (termIdRef.current !== null) {
          ipcRenderer.invoke('terminal-write', termIdRef.current, data);
        }
      });

      term.write('\x1b[38;2;124;138;255m');
      term.write('  ╔══════════════════════════════════════╗\r\n');
      term.write('  ║         Claude Connect Terminal       ║\r\n');
      term.write('  ╚══════════════════════════════════════╝\r\n');
      term.write('\x1b[0m\r\n');
      term.write('\x1b[90mClick "Launch Claude" to start a Claude Code session\r\n');
      term.write('with cross-machine sync tools pre-configured.\x1b[0m\r\n\r\n');
    } catch (err) {
      console.error('Failed to init terminal:', err);
    }
  }, []);

  useEffect(() => {
    if (tab === 'terminal') {
      setTimeout(() => initTerminal(), 50);
    }
    if (tab === 'terminal' && fitAddonRef.current) {
      setTimeout(() => {
        try { fitAddonRef.current.fit(); } catch {}
      }, 100);
    }
  }, [tab, initTerminal]);

  const launchClaude = async () => {
    // Kill existing terminal if any
    if (termIdRef.current !== null) {
      await ipcRenderer.invoke('terminal-kill', termIdRef.current);
      termIdRef.current = null;
    }

    const result = await ipcRenderer.invoke('terminal-create');
    if (result.success) {
      termIdRef.current = result.id;
      // Send 'claude' command to start Claude Code
      await ipcRenderer.invoke('terminal-write', result.id, 'claude\n');
    }
  };

  const launchShell = async () => {
    if (termIdRef.current !== null) {
      await ipcRenderer.invoke('terminal-kill', termIdRef.current);
      termIdRef.current = null;
    }

    const result = await ipcRenderer.invoke('terminal-create');
    if (result.success) {
      termIdRef.current = result.id;
    }
  };

  const handleHost = async () => {
    const port = parseInt(portInput) || 3377;
    const result = await ipcRenderer.invoke('start-server', port, deviceName || undefined);
    if (result.success) {
      setMode('hosting');
      setStatus(`Hosting on port ${port}`);
      setTab('messages');
    } else {
      setStatus(`Error: ${result.error}`);
    }
  };

  const handleConnect = async () => {
    if (!hostInput) return;
    const port = parseInt(portInput) || 3377;
    const result = await ipcRenderer.invoke('connect-to-server', hostInput, port, deviceName || undefined);
    if (result.success) {
      setMode('connected');
      setStatus(`Connected to ${hostInput}:${port}`);
      setTab('messages');
    } else {
      setStatus(`Error: ${result.error}`);
    }
  };

  const handleDisconnect = async () => {
    if (mode === 'hosting') {
      await ipcRenderer.invoke('stop-server');
    } else {
      await ipcRenderer.invoke('disconnect');
    }
    setMode('idle');
    setStatus('Disconnected');
    setDevices([]);
    setMessages([]);
  };

  const handleSendMessage = async () => {
    if (!messageInput.trim()) return;
    await ipcRenderer.invoke('send-message', messageInput);
    setMessageInput('');
  };

  const handleCreateTask = async () => {
    if (!taskInput.trim()) return;
    await ipcRenderer.invoke('create-task', taskInput);
    setTaskInput('');
  };

  const handleAddClipboard = async () => {
    if (!clipboardInput.trim()) return;
    await ipcRenderer.invoke('add-clipboard', clipboardInput, clipboardLabel || undefined);
    setClipboardInput('');
    setClipboardLabel('');
  };

  const handleDownloadUpdate = async () => {
    await ipcRenderer.invoke('download-update');
  };

  const handleInstallUpdate = async () => {
    await ipcRenderer.invoke('install-update');
  };

  const formatTime = (ts: number) => {
    return new Date(ts).toLocaleTimeString();
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Claude Connect</h1>
        <div className="status-bar">
          {updateInfo.available && !updateInfo.ready && !updateInfo.downloading && (
            <button className="btn btn-small btn-update" onClick={handleDownloadUpdate}>
              Update v{updateInfo.version}
            </button>
          )}
          {updateInfo.downloading && (
            <span className="update-progress">Downloading... {updateInfo.progress}%</span>
          )}
          {updateInfo.ready && (
            <button className="btn btn-small btn-update" onClick={handleInstallUpdate}>
              Restart to Update
            </button>
          )}
          <span className={`status-dot ${mode !== 'idle' ? 'online' : 'offline'}`} />
          <span>{status}</span>
          {mode !== 'idle' && (
            <button className="btn btn-small btn-danger" onClick={handleDisconnect}>
              Disconnect
            </button>
          )}
        </div>
      </header>

      <nav className="tabs">
        {(['connect', 'messages', 'tasks', 'clipboard', 'terminal'] as Tab[]).map(t => (
          <button
            key={t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      <main className={`content ${tab === 'terminal' ? 'content-terminal' : ''}`}>
        {tab === 'connect' && (
          <div className="panel">
            {mode === 'idle' ? (
              <>
                <div className="section">
                  <h2>Name This Machine</h2>
                  <p className="hint">Give this machine a name so the other side knows who you are.</p>
                  <div className="input-row">
                    <input
                      placeholder={`e.g. "Johnny's MacBook", "Work PC"`}
                      value={deviceName}
                      onChange={e => setDeviceName(e.target.value)}
                    />
                  </div>
                </div>

                <div className="section">
                  <h2>Host a Session</h2>
                  <p className="hint">Start a relay server on this machine. Share the IP below with the other machine so it can connect to you.</p>
                  {connectionInfo && (
                    <p className="hint">
                      Your IP: <strong style={{ color: 'var(--accent)' }}>{connectionInfo.addresses?.join(', ') || 'unknown'}</strong>
                    </p>
                  )}
                  <div className="input-row">
                    <input
                      type="number"
                      placeholder="Port (default 3377)"
                      value={portInput}
                      onChange={e => setPortInput(e.target.value)}
                    />
                    <button className="btn btn-primary" onClick={handleHost}>
                      Start Hosting
                    </button>
                  </div>
                </div>

                <div className="divider">— or —</div>

                <div className="section">
                  <h2>Connect to a Host</h2>
                  <p className="hint">Enter the IP address shown on the hosting machine.</p>
                  <div className="input-row">
                    <input
                      placeholder="Host's IP address"
                      value={hostInput}
                      onChange={e => setHostInput(e.target.value)}
                    />
                    <input
                      type="number"
                      placeholder="Port"
                      value={portInput}
                      onChange={e => setPortInput(e.target.value)}
                      style={{ width: 100 }}
                    />
                    <button className="btn btn-primary" onClick={handleConnect}>
                      Connect
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="section">
                <h2>Connected Devices</h2>
                {devices.length === 0 ? (
                  <p className="hint">No other devices connected yet.</p>
                ) : (
                  <ul className="device-list">
                    {devices.map((d, i) => (
                      <li key={i} className="device-item">
                        <span className={`status-dot ${d.status === 'online' ? 'online' : 'offline'}`} />
                        <span className="device-name">{d.name}</span>
                        <span className="device-platform">{d.platform}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {mode === 'hosting' && connectionInfo && (
                  <div className="connection-details">
                    <h3>Connection Details</h3>
                    <p>Share this with other machines:</p>
                    <code>{connectionInfo.addresses?.[0] || 'localhost'}:{portInput}</code>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {tab === 'messages' && (
          <div className="panel messages-panel">
            <div className="messages-list">
              {messages.length === 0 ? (
                <p className="hint center">No messages yet. Send one or wait for other sessions.</p>
              ) : (
                messages.map((msg, i) => (
                  <div key={i} className={`message ${msg.type}`}>
                    <div className="message-header">
                      <span className="message-from">{msg.from}</span>
                      <span className="message-type">{msg.type}</span>
                      <span className="message-time">{formatTime(msg.timestamp)}</span>
                    </div>
                    <div className="message-body">
                      {msg.type === 'context' || msg.type === 'work-update' ? (
                        <div className="context-update">
                          <p>{msg.payload.summary}</p>
                          {msg.payload.filesChanged?.length > 0 && (
                            <p className="files">Files: {msg.payload.filesChanged.join(', ')}</p>
                          )}
                          {msg.payload.activeFiles?.length > 0 && (
                            <p className="files">Files: {msg.payload.activeFiles.join(', ')}</p>
                          )}
                          {msg.payload.currentTask && (
                            <p className="task">Task: {msg.payload.currentTask}</p>
                          )}
                          {msg.payload.nextSteps && (
                            <p className="next-steps">Next: {msg.payload.nextSteps}</p>
                          )}
                        </div>
                      ) : (
                        <p>{msg.payload?.text || JSON.stringify(msg.payload)}</p>
                      )}
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
            <div className="message-input">
              <input
                placeholder="Send a message..."
                value={messageInput}
                onChange={e => setMessageInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
              />
              <button className="btn btn-primary" onClick={handleSendMessage}>
                Send
              </button>
            </div>
          </div>
        )}

        {tab === 'tasks' && (
          <div className="panel">
            <div className="section">
              <div className="input-row">
                <input
                  placeholder="New task..."
                  value={taskInput}
                  onChange={e => setTaskInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleCreateTask()}
                />
                <button className="btn btn-primary" onClick={handleCreateTask}>
                  Add Task
                </button>
              </div>
            </div>
            <div className="task-list">
              {tasks.length === 0 ? (
                <p className="hint center">No shared tasks yet.</p>
              ) : (
                tasks.map((task, i) => (
                  <div key={i} className={`task-item task-${task.status}`}>
                    <div className="task-header">
                      <span className={`task-status ${task.status}`}>{task.status}</span>
                      <span className="task-title">{task.title}</span>
                    </div>
                    {task.assignedTo && <span className="task-assigned">Assigned to: {task.assignedTo}</span>}
                    {task.notes && <p className="task-notes">{task.notes}</p>}
                    <span className="task-creator">Created by: {task.createdBy}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {tab === 'clipboard' && (
          <div className="panel">
            <div className="section">
              <div className="input-row">
                <input
                  placeholder="Label (optional)"
                  value={clipboardLabel}
                  onChange={e => setClipboardLabel(e.target.value)}
                  style={{ width: 150 }}
                />
                <input
                  placeholder="Content to share..."
                  value={clipboardInput}
                  onChange={e => setClipboardInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddClipboard()}
                />
                <button className="btn btn-primary" onClick={handleAddClipboard}>
                  Share
                </button>
              </div>
            </div>
            <div className="clipboard-list">
              {clipboard.length === 0 ? (
                <p className="hint center">Shared clipboard is empty.</p>
              ) : (
                clipboard.map((item, i) => (
                  <div key={i} className="clipboard-item">
                    <div className="clipboard-header">
                      {item.label && <span className="clipboard-label">{item.label}</span>}
                      <span className="clipboard-from">{item.createdBy}</span>
                      <span className="clipboard-time">{formatTime(item.createdAt)}</span>
                    </div>
                    <pre className="clipboard-content">{item.content}</pre>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {tab === 'terminal' && (
          <div className="terminal-panel">
            <div className="terminal-toolbar">
              <button className="btn btn-primary" onClick={launchClaude}>
                Launch Claude
              </button>
              <button className="btn btn-secondary" onClick={launchShell}>
                Shell Only
              </button>
              {mode !== 'idle' && (
                <span className="terminal-hint">
                  Claude Code will have cross-machine sync tools ready
                </span>
              )}
            </div>
            <div className="terminal-container" ref={terminalRef} />
          </div>
        )}
      </main>
    </div>
  );
}
