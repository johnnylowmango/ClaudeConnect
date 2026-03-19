import React, { useState, useEffect, useRef, useCallback } from 'react';
import './styles.css';

const { ipcRenderer } = (window as any).require('electron');

// Dynamic imports for xterm
let Terminal: any = null;
let FitAddon: any = null;
let WebLinksAddon: any = null;

type View = 'command' | 'terminal';
type Mode = 'idle' | 'hosting' | 'connected';

interface CommandEntry {
  kind: 'prompt' | 'response' | 'event';
  id: string;
  promptId?: string;
  deviceName?: string;
  text: string;
  timestamp: number;
  targets?: string[];
  streaming?: boolean;
  collapsed?: boolean;
  type?: string;
}

interface Device {
  name: string;
  platform: string;
  status: string;
  projectPath?: string;
}

interface UpdateInfo {
  available: boolean;
  version?: string;
  downloading: boolean;
  progress: number;
  ready: boolean;
}

export default function App() {
  const [view, setView] = useState<View>('command');
  const [mode, setMode] = useState<Mode>('idle');
  const [devices, setDevices] = useState<Device[]>([]);
  const [hostInput, setHostInput] = useState('');
  const [portInput, setPortInput] = useState('3377');
  const [deviceName, setDeviceName] = useState('');
  const [status, setStatus] = useState('Disconnected');
  const [connectionInfo, setConnectionInfo] = useState<any>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({
    available: false, downloading: false, progress: 0, ready: false,
  });
  const [projectFolder, setProjectFolder] = useState<string | null>(null);

  // Command Center state
  const [commandEntries, setCommandEntries] = useState<CommandEntry[]>([]);
  const [commandInput, setCommandInput] = useState('');
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [deviceStatuses, setDeviceStatuses] = useState<Map<string, 'active' | 'idle' | 'disconnected'>>(new Map());
  const [claudeLaunched, setClaudeLaunched] = useState(false);
  const commandEndRef = useRef<HTMLDivElement>(null);
  const localDeviceName = useRef<string>('');
  const boundTerminals = useRef<Map<string, number>>(new Map());

  // Terminal state
  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const termIdRef = useRef<number | null>(null);

  // Load project folder on mount
  useEffect(() => {
    ipcRenderer.invoke('get-project-folder').then((r: any) => {
      if (r.path) setProjectFolder(r.path);
    });
  }, []);

  useEffect(() => {
    ipcRenderer.invoke('get-connection-info').then(setConnectionInfo);

    ipcRenderer.on('client-event', (_: any, { event, data }: any) => {
      switch (event) {
        case 'welcome':
          setDevices(data.devices || []);
          break;
        case 'device-connected':
          setDevices(prev => [...prev.filter(d => d.name !== data.name), data]);
          // Auto-select newly connected devices as targets
          setSelectedTargets(prev => prev.includes(data.name) ? prev : [...prev, data.name]);
          break;
        case 'device-disconnected':
          setDevices(prev => prev.filter(d => d.name !== data.name));
          break;
        case 'device-updated':
          setDevices(prev => prev.map(d => d.name === data.name ? { ...d, ...data } : d));
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

    // Command Center events — terminal output streaming
    ipcRenderer.on('command-terminal-output', (_: any, { termId, text }: any) => {
      let devName = '';
      for (const [name, tid] of boundTerminals.current) {
        if (tid === termId) { devName = name; break; }
      }
      if (!devName) return;

      setDeviceStatuses(prev => {
        const next = new Map(prev);
        next.set(devName, 'active');
        return next;
      });
      setTimeout(() => {
        setDeviceStatuses(prev => {
          if (prev.get(devName) === 'active') {
            const next = new Map(prev);
            next.set(devName, 'idle');
            return next;
          }
          return prev;
        });
      }, 2000);

      setCommandEntries(prev => {
        const lastResponse = [...prev].reverse().find(
          e => e.kind === 'response' && e.deviceName === devName && e.streaming
        );
        if (lastResponse) {
          // Append to existing streaming response
          return prev.map(e =>
            e.id === lastResponse.id
              ? { ...e, text: e.text + text, timestamp: Date.now() }
              : e
          );
        }
        // No streaming response exists — create one automatically
        // This captures Claude's output even before/between prompts
        return [...prev, {
          kind: 'response' as const,
          id: `resp-${Date.now()}-${devName}`,
          promptId: 'auto',
          deviceName: devName,
          text: text,
          timestamp: Date.now(),
          streaming: true,
          collapsed: false,
        }];
      });
    });

    ipcRenderer.on('command-injected', (_: any, { termId, promptId }: any) => {
      let devName = '';
      for (const [name, tid] of boundTerminals.current) {
        if (tid === termId) { devName = name; break; }
      }
      if (!devName) return;

      setCommandEntries(prev => {
        // Close previous streaming response for this device
        const updated = prev.map(e =>
          e.kind === 'response' && e.deviceName === devName && e.streaming
            ? { ...e, streaming: false }
            : e
        );
        // Create new streaming response for this prompt
        return [...updated, {
          kind: 'response' as const,
          id: `resp-${Date.now()}-${devName}`,
          promptId,
          deviceName: devName,
          text: '',
          timestamp: Date.now(),
          streaming: true,
          collapsed: false,
        }];
      });
    });

    // Remote device terminal output (via relay)
    ipcRenderer.on('command-remote-output', (_: any, { deviceName: devName, text }: any) => {
      setDeviceStatuses(prev => {
        const next = new Map(prev);
        next.set(devName, 'active');
        return next;
      });
      setTimeout(() => {
        setDeviceStatuses(prev => {
          if (prev.get(devName) === 'active') {
            const next = new Map(prev);
            next.set(devName, 'idle');
            return next;
          }
          return prev;
        });
      }, 2000);

      setCommandEntries(prev => {
        const lastResponse = [...prev].reverse().find(
          e => e.kind === 'response' && e.deviceName === devName && e.streaming
        );
        if (lastResponse) {
          return prev.map(e =>
            e.id === lastResponse.id
              ? { ...e, text: e.text + text, timestamp: Date.now() }
              : e
          );
        }
        return [...prev, {
          kind: 'response' as const,
          id: `resp-${Date.now()}-${devName}`,
          promptId: 'remote',
          deviceName: devName,
          text: text,
          timestamp: Date.now(),
          streaming: true,
          collapsed: false,
        }];
      });
    });

    ipcRenderer.on('command-event', (_: any, evt: any) => {
      setCommandEntries(prev => [...prev, {
        kind: 'event' as const,
        id: evt.id,
        text: evt.text,
        timestamp: evt.timestamp,
        type: evt.type,
      }]);
    });

    ipcRenderer.on('terminal-data', (_: any, { id, data }: any) => {
      if (termInstanceRef.current && id === termIdRef.current) {
        termInstanceRef.current.write(data);
      }
    });

    ipcRenderer.on('terminal-exit', (_: any, { id }: any) => {
      if (id === termIdRef.current) {
        termInstanceRef.current?.write('\r\n\x1b[90m[Terminal exited]\x1b[0m\r\n');
        termIdRef.current = null;
      }
    });

    return () => {
      ipcRenderer.removeAllListeners('client-event');
      ipcRenderer.removeAllListeners('updater-event');
      ipcRenderer.removeAllListeners('terminal-data');
      ipcRenderer.removeAllListeners('terminal-exit');
      ipcRenderer.removeAllListeners('command-terminal-output');
      ipcRenderer.removeAllListeners('command-remote-output');
      ipcRenderer.removeAllListeners('command-injected');
      ipcRenderer.removeAllListeners('command-event');
    };
  }, []);

  useEffect(() => {
    commandEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [commandEntries]);

  // Initialize terminal when view switches to terminal
  const initTerminal = useCallback(async () => {
    if (termInstanceRef.current || !terminalRef.current) return;
    try {
      if (!Terminal) {
        const xtermMod = require('@xterm/xterm');
        const fitMod = require('@xterm/addon-fit');
        const linksMod = require('@xterm/addon-web-links');
        Terminal = xtermMod.Terminal;
        FitAddon = fitMod.FitAddon;
        WebLinksAddon = linksMod.WebLinksAddon;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = require.resolve('@xterm/xterm/css/xterm.css');
        document.head.appendChild(link);
      }

      const fitAddon = new FitAddon();
      fitAddonRef.current = fitAddon;
      const isWin = navigator.platform.startsWith('Win');
      const term = new Terminal({
        fontFamily: isWin
          ? "'Cascadia Code', 'Consolas', 'Courier New', monospace"
          : "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
        fontSize: isWin ? 14 : 13,
        lineHeight: isWin ? 1.3 : 1.4,
        cursorBlink: true, cursorStyle: 'bar',
        scrollback: 5000, allowTransparency: false, windowsMode: isWin,
        theme: {
          background: '#08090c', foreground: '#e8e9ed',
          cursor: '#7c8aff', cursorAccent: '#08090c',
          selectionBackground: 'rgba(124, 138, 255, 0.15)', selectionForeground: '#ffffff',
          black: '#1a1b26', red: '#e05c5c', green: '#4a9e6b', yellow: '#e0a55c',
          blue: '#5b7cc5', magenta: '#a78bfa', cyan: '#6ee7b7', white: '#e8e9ed',
          brightBlack: '#444b6a', brightRed: '#ff7a93', brightGreen: '#6ee7b7',
          brightYellow: '#ffd580', brightBlue: '#7c8aff', brightMagenta: '#c3a6ff',
          brightCyan: '#7ee5c2', brightWhite: '#ffffff',
        },
      });

      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(terminalRef.current);
      fitAddon.fit();
      termInstanceRef.current = term;

      const resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon.fit();
          if (termIdRef.current !== null) {
            ipcRenderer.invoke('terminal-resize', termIdRef.current, term.cols, term.rows);
          }
        } catch {}
      });
      resizeObserver.observe(terminalRef.current);

      term.onData((data: string) => {
        if (termIdRef.current !== null) {
          ipcRenderer.invoke('terminal-write', termIdRef.current, data);
        }
      });

      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && e.key === 'c' && term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection());
          return false;
        }
        if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && e.key === 'v') {
          navigator.clipboard.readText().then(text => {
            if (termIdRef.current !== null) {
              ipcRenderer.invoke('terminal-write', termIdRef.current, text);
            }
          });
          return false;
        }
        return true;
      });
    } catch (err) {
      console.error('Failed to init terminal:', err);
    }
  }, []);

  useEffect(() => {
    if (view === 'terminal') {
      setTimeout(() => initTerminal(), 50);
    }
    if (view === 'terminal' && fitAddonRef.current) {
      setTimeout(() => { try { fitAddonRef.current.fit(); } catch {} }, 100);
    }
  }, [view, initTerminal]);

  // --- Actions ---

  const handleHost = async () => {
    const port = parseInt(portInput) || 3377;
    const result = await ipcRenderer.invoke('start-server', port, deviceName || undefined);
    if (result.success) {
      setMode('hosting');
      setStatus(`Hosting on port ${port}`);
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
    setClaudeLaunched(false);
    boundTerminals.current.clear();
    setSelectedTargets([]);
    setCommandEntries([]);
  };

  const handleSelectFolder = async () => {
    const result = await ipcRenderer.invoke('select-project-folder');
    if (result.success) {
      setProjectFolder(result.path);
    }
  };

  const handleLaunchClaude = async () => {
    if (termIdRef.current !== null) {
      await ipcRenderer.invoke('terminal-kill', termIdRef.current);
      termIdRef.current = null;
    }

    const result = await ipcRenderer.invoke('terminal-create');
    if (result.success) {
      termIdRef.current = result.id;
      const myName = deviceName || connectionInfo?.hostname || 'local';
      localDeviceName.current = myName;
      boundTerminals.current.set(myName, result.id);
      await ipcRenderer.invoke('bind-terminal-device', result.id, myName);
      await ipcRenderer.invoke('terminal-write', result.id, 'claude\n');
      setClaudeLaunched(true);

      // Auto-select all online devices (including self for broadcast)
      const allOnline = devices.filter(d => d.status === 'online').map(d => d.name);
      if (!allOnline.includes(myName)) allOnline.push(myName);
      setSelectedTargets(allOnline);
    }
  };

  const toggleTarget = (name: string) => {
    setSelectedTargets(prev =>
      prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
    );
  };

  const selectAllTargets = () => {
    const onlineDevices = devices.filter(d => d.status === 'online').map(d => d.name);
    setSelectedTargets(prev =>
      prev.length === onlineDevices.length ? [] : onlineDevices
    );
  };

  const handleCommandSend = async () => {
    if (!commandInput.trim() || selectedTargets.length === 0) return;
    const text = commandInput.trim();
    const promptId = `prompt-${Date.now()}`;
    setCommandInput('');

    setCommandEntries(prev => [...prev, {
      kind: 'prompt' as const,
      id: promptId,
      text,
      timestamp: Date.now(),
      targets: [...selectedTargets],
    }]);

    for (const target of selectedTargets) {
      const termId = boundTerminals.current.get(target);
      if (termId !== undefined) {
        await ipcRenderer.invoke('inject-prompt', termId, text, promptId);
      } else {
        await ipcRenderer.invoke('send-prompt-inject', target, text, promptId);
      }
    }
  };

  const toggleCollapse = (entryId: string) => {
    setCommandEntries(prev =>
      prev.map(e => e.id === entryId ? { ...e, collapsed: !e.collapsed } : e)
    );
  };

  const handleDownloadUpdate = () => ipcRenderer.invoke('download-update');
  const handleInstallUpdate = () => ipcRenderer.invoke('install-update');

  const formatTime = (ts: number) => new Date(ts).toLocaleTimeString();

  const onlineDevices = devices.filter(d => d.status === 'online');

  // ===================== SETUP SCREEN (idle) =====================
  if (mode === 'idle') {
    return (
      <div className="app">
        <div className="setup-screen">
          <div className="setup-logo">
            <h1 className="logo-text">Claude Connect</h1>
            <p className="setup-tagline">Link your machines. Let the Claudes collaborate.</p>
          </div>

          <div className="setup-card">
            <div className="setup-field">
              <label>Machine Name</label>
              <input
                placeholder={connectionInfo?.hostname || 'e.g. MacBook, Work PC'}
                value={deviceName}
                onChange={e => setDeviceName(e.target.value)}
              />
            </div>

            <div className="setup-field">
              <label>Project Folder</label>
              <div className="input-row">
                <input
                  readOnly
                  value={projectFolder || 'No folder selected'}
                  style={{ cursor: 'pointer', opacity: projectFolder ? 1 : 0.5 }}
                  onClick={handleSelectFolder}
                />
                <button className="btn btn-secondary" onClick={handleSelectFolder}>Browse</button>
              </div>
            </div>

            <div className="setup-divider" />

            <div className="setup-actions">
              <div className="setup-action-group">
                <h3>Host a Session</h3>
                <p className="hint">
                  Your IP: <strong style={{ color: 'var(--accent)' }}>
                    {connectionInfo?.addresses?.join(', ') || 'loading...'}
                  </strong>
                </p>
                <div className="input-row">
                  <input
                    type="number"
                    placeholder="Port (3377)"
                    value={portInput}
                    onChange={e => setPortInput(e.target.value)}
                    style={{ width: 120 }}
                  />
                  <button className="btn btn-primary" onClick={handleHost}>Host</button>
                </div>
              </div>

              <div className="setup-or">or</div>

              <div className="setup-action-group">
                <h3>Join a Session</h3>
                <p className="hint">Enter the host machine's IP address</p>
                <div className="input-row">
                  <input
                    placeholder="Host IP"
                    value={hostInput}
                    onChange={e => setHostInput(e.target.value)}
                  />
                  <input
                    type="number"
                    placeholder="Port"
                    value={portInput}
                    onChange={e => setPortInput(e.target.value)}
                    style={{ width: 90 }}
                  />
                  <button className="btn btn-primary" onClick={handleConnect}>Join</button>
                </div>
              </div>
            </div>
          </div>

          {updateInfo.available && !updateInfo.ready && !updateInfo.downloading && (
            <button className="btn btn-small btn-update setup-update" onClick={handleDownloadUpdate}>
              Update v{updateInfo.version}
            </button>
          )}
          {updateInfo.downloading && <span className="update-progress">Downloading... {updateInfo.progress}%</span>}
          {updateInfo.ready && (
            <button className="btn btn-small btn-update setup-update" onClick={handleInstallUpdate}>
              Restart to Update
            </button>
          )}
        </div>
      </div>
    );
  }

  // ===================== CONNECTED VIEW =====================
  return (
    <div className="app">
      <header className="header">
        <h1>Claude Connect</h1>
        <div className="header-devices">
          {onlineDevices.map(d => (
            <span key={d.name} className={`header-device platform-${d.platform}`}>
              <span className={`chip-status ${deviceStatuses.get(d.name) || 'idle'}`} />
              {d.name}
            </span>
          ))}
        </div>
        <div className="status-bar">
          {updateInfo.available && !updateInfo.ready && !updateInfo.downloading && (
            <button className="btn btn-small btn-update" onClick={handleDownloadUpdate}>
              Update v{updateInfo.version}
            </button>
          )}
          {updateInfo.ready && (
            <button className="btn btn-small btn-update" onClick={handleInstallUpdate}>
              Restart to Update
            </button>
          )}
          <span className="status-dot online" />
          <span className="status-text">{status}</span>
          {mode === 'hosting' && connectionInfo?.addresses?.[0] && (
            <span className="header-ip" title="Share this with other machines">
              {connectionInfo.addresses[0]}:{portInput}
            </span>
          )}
          {projectFolder && (
            <span className="header-project" onClick={handleSelectFolder} title="Click to change">
              {projectFolder.split('/').pop() || projectFolder}
            </span>
          )}
          <button className="btn btn-small btn-danger" onClick={handleDisconnect}>
            Disconnect
          </button>
        </div>
      </header>

      {/* Minimal view switcher */}
      <nav className="tabs">
        <button className={`tab ${view === 'command' ? 'active' : ''}`} onClick={() => setView('command')}>
          Command Center
        </button>
        <button className={`tab ${view === 'terminal' ? 'active' : ''}`} onClick={() => setView('terminal')}>
          Terminal
        </button>
      </nav>

      <main className={`content ${view === 'terminal' ? 'content-terminal' : 'content-command'}`}>
        {view === 'command' && (
          <div className="panel command-panel">
            {/* Device target chips */}
            <div className="command-device-bar">
              <span className="command-label">Send to:</span>
              {onlineDevices.length > 1 && (
                <button
                  className={`device-chip ${selectedTargets.length === onlineDevices.length && selectedTargets.length > 0 ? 'selected' : ''}`}
                  onClick={selectAllTargets}
                >
                  All
                </button>
              )}
              {onlineDevices.map(d => (
                <button
                  key={d.name}
                  className={`device-chip ${selectedTargets.includes(d.name) ? 'selected' : ''} platform-${d.platform}`}
                  onClick={() => toggleTarget(d.name)}
                >
                  <span className={`chip-status ${deviceStatuses.get(d.name) || 'idle'}`} />
                  {d.name}
                </button>
              ))}
              {!claudeLaunched && (
                <button className="btn btn-primary btn-small launch-btn" onClick={handleLaunchClaude}>
                  Launch Claude
                </button>
              )}
            </div>

            {/* Conversation stream */}
            <div className="command-stream">
              {commandEntries.length === 0 ? (
                <div className="command-empty">
                  {!claudeLaunched ? (
                    <div className="empty-state">
                      <div className="empty-icon">{'{ }'}</div>
                      <h2>Ready to go</h2>
                      <p>Click <strong>Launch Claude</strong> to start a Claude Code session on this machine.</p>
                      <p className="hint">Once both machines have Claude running, type a prompt and pick your targets.</p>
                      <button className="btn btn-primary" onClick={handleLaunchClaude}>Launch Claude</button>
                    </div>
                  ) : (
                    <div className="empty-state">
                      <div className="empty-icon">~</div>
                      <h2>Claude is running</h2>
                      <p>Select target device(s) above and type a prompt below.</p>
                      <p className="hint">Your prompt will be injected directly into Claude's terminal.</p>
                    </div>
                  )}
                </div>
              ) : (
                commandEntries.map(entry => {
                  if (entry.kind === 'prompt') {
                    return (
                      <div key={entry.id} className="command-entry command-prompt-entry">
                        <div className="command-entry-header">
                          <span className="command-from">You</span>
                          <span className="command-targets">
                            {entry.targets?.map(t => (
                              <span key={t} className="target-chip">{t}</span>
                            ))}
                          </span>
                          <span className="command-time">{formatTime(entry.timestamp)}</span>
                        </div>
                        <div className="command-text">{entry.text}</div>
                      </div>
                    );
                  }
                  if (entry.kind === 'response') {
                    const lines = (entry.text || '').split('\n');
                    const isLong = lines.length > 20;
                    const displayText = entry.collapsed ? lines.slice(0, 8).join('\n') + '\n...' : entry.text;
                    return (
                      <div key={entry.id} className="command-entry command-response-entry">
                        <div className="command-entry-header">
                          <span className={`chip-status ${entry.streaming ? 'active' : 'idle'}`} />
                          <span className="command-device">{entry.deviceName}</span>
                          {entry.streaming && <span className="streaming-indicator">streaming</span>}
                          <span className="command-time">{formatTime(entry.timestamp)}</span>
                          {isLong && (
                            <button className="btn btn-small btn-secondary" onClick={() => toggleCollapse(entry.id)}>
                              {entry.collapsed ? 'Expand' : 'Collapse'}
                            </button>
                          )}
                        </div>
                        <pre className="command-output">{displayText || <span className="text-muted">Waiting for output...</span>}</pre>
                      </div>
                    );
                  }
                  if (entry.kind === 'event') {
                    return (
                      <div key={entry.id} className={`command-entry command-event-entry event-${entry.type}`}>
                        <span className="event-icon">{entry.type === 'sync' ? '\u21bb' : entry.type === 'error' ? '\u2717' : '\u2192'}</span>
                        <span className="event-text">{entry.text}</span>
                        <span className="command-time">{formatTime(entry.timestamp)}</span>
                      </div>
                    );
                  }
                  return null;
                })
              )}
              <div ref={commandEndRef} />
            </div>

            {/* Input */}
            <div className="command-input-bar">
              <input
                className="command-input"
                placeholder={
                  !claudeLaunched ? 'Launch Claude first...'
                    : selectedTargets.length > 0 ? `Send to ${selectedTargets.join(', ')}...`
                    : 'Select target device(s) above...'
                }
                value={commandInput}
                onChange={e => setCommandInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCommandSend()}
                disabled={!claudeLaunched || selectedTargets.length === 0}
              />
              <button
                className="btn btn-primary"
                onClick={handleCommandSend}
                disabled={!claudeLaunched || selectedTargets.length === 0 || !commandInput.trim()}
              >
                Send
              </button>
            </div>
          </div>
        )}

        {/* Terminal view — always rendered but hidden when not active */}
        <div className="terminal-panel" style={{ display: view === 'terminal' ? 'flex' : 'none' }}>
          <div className="terminal-toolbar">
            <button className="btn btn-primary btn-small" onClick={handleLaunchClaude}>
              Launch Claude
            </button>
            <button className="btn btn-secondary btn-small" onClick={async () => {
              if (termIdRef.current !== null) {
                await ipcRenderer.invoke('terminal-kill', termIdRef.current);
                termIdRef.current = null;
              }
              const result = await ipcRenderer.invoke('terminal-create');
              if (result.success) termIdRef.current = result.id;
            }}>
              Shell
            </button>
            <span className="terminal-hint">
              Raw terminal access — Claude Code runs here with MCP tools pre-configured
            </span>
          </div>
          <div className="terminal-container" ref={terminalRef} />
        </div>
      </main>
    </div>
  );
}
