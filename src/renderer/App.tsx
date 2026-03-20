import React, { useState, useEffect, useRef, useCallback } from 'react';
import './styles.css';

const { ipcRenderer } = (window as any).require('electron');

let Terminal: any = null;
let FitAddon: any = null;
let WebLinksAddon: any = null;

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
  activeProjectId?: string;
  activeProjectName?: string;
}

interface ProjectEntry {
  id: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
  devices: { [deviceName: string]: any };
}

interface UpdateInfo {
  available: boolean;
  version?: string;
  downloading: boolean;
  progress: number;
  ready: boolean;
}

export default function App() {
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

  // Workspace state
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [showNewProject, setShowNewProject] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

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
  const [terminalVisible, setTerminalVisible] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const termIdRef = useRef<number | null>(null);

  // Load workspace on mount
  useEffect(() => {
    ipcRenderer.invoke('workspace-get').then((ws: any) => {
      if (ws.projects) setProjects(ws.projects);
      if (ws.activeProjectId) setActiveProjectId(ws.activeProjectId);
    });
    ipcRenderer.invoke('get-connection-info').then(setConnectionInfo);
  }, []);

  useEffect(() => {
    ipcRenderer.on('client-event', (_: any, { event, data }: any) => {
      switch (event) {
        case 'welcome':
          setDevices(data.devices || []);
          break;
        case 'device-connected':
          setDevices(prev => [...prev.filter(d => d.name !== data.name), data]);
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

    ipcRenderer.on('workspace-event', (_: any, data: any) => {
      if (data.event === 'project-created' || data.event === 'project-list') {
        ipcRenderer.invoke('workspace-get').then((ws: any) => {
          if (ws.projects) setProjects(ws.projects);
          if (ws.activeProjectId) setActiveProjectId(ws.activeProjectId);
        });
      }
    });

    // Command Center events
    ipcRenderer.on('command-terminal-output', (_: any, { termId, text }: any) => {
      let devName = '';
      for (const [name, tid] of boundTerminals.current) {
        if (tid === termId) { devName = name; break; }
      }
      if (!devName) return;

      setDeviceStatuses(prev => { const next = new Map(prev); next.set(devName, 'active'); return next; });
      setTimeout(() => {
        setDeviceStatuses(prev => {
          if (prev.get(devName) === 'active') { const next = new Map(prev); next.set(devName, 'idle'); return next; }
          return prev;
        });
      }, 2000);

      setCommandEntries(prev => {
        const lastResponse = [...prev].reverse().find(
          e => e.kind === 'response' && e.deviceName === devName && e.streaming
        );
        if (lastResponse) {
          return prev.map(e => e.id === lastResponse.id ? { ...e, text: e.text + text, timestamp: Date.now() } : e);
        }
        return [...prev, {
          kind: 'response' as const, id: `resp-${Date.now()}-${devName}`,
          promptId: 'auto', deviceName: devName, text, timestamp: Date.now(),
          streaming: true, collapsed: false,
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
        const updated = prev.map(e =>
          e.kind === 'response' && e.deviceName === devName && e.streaming
            ? { ...e, streaming: false } : e
        );
        return [...updated, {
          kind: 'response' as const, id: `resp-${Date.now()}-${devName}`,
          promptId, deviceName: devName, text: '', timestamp: Date.now(),
          streaming: true, collapsed: false,
        }];
      });
    });

    ipcRenderer.on('command-remote-output', (_: any, { deviceName: devName, text }: any) => {
      setDeviceStatuses(prev => { const next = new Map(prev); next.set(devName, 'active'); return next; });
      setTimeout(() => {
        setDeviceStatuses(prev => {
          if (prev.get(devName) === 'active') { const next = new Map(prev); next.set(devName, 'idle'); return next; }
          return prev;
        });
      }, 2000);

      setCommandEntries(prev => {
        const lastResponse = [...prev].reverse().find(
          e => e.kind === 'response' && e.deviceName === devName && e.streaming
        );
        if (lastResponse) {
          return prev.map(e => e.id === lastResponse.id ? { ...e, text: e.text + text, timestamp: Date.now() } : e);
        }
        return [...prev, {
          kind: 'response' as const, id: `resp-${Date.now()}-${devName}`,
          promptId: 'remote', deviceName: devName, text, timestamp: Date.now(),
          streaming: true, collapsed: false,
        }];
      });
    });

    ipcRenderer.on('command-event', (_: any, evt: any) => {
      setCommandEntries(prev => [...prev, {
        kind: 'event' as const, id: evt.id, text: evt.text, timestamp: evt.timestamp, type: evt.type,
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
      ['client-event', 'updater-event', 'workspace-event', 'terminal-data', 'terminal-exit',
       'command-terminal-output', 'command-remote-output', 'command-injected', 'command-event']
        .forEach(e => ipcRenderer.removeAllListeners(e));
    };
  }, []);

  useEffect(() => {
    commandEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [commandEntries]);

  // Initialize terminal
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
    if (terminalVisible) {
      setTimeout(() => initTerminal(), 50);
    }
    if (terminalVisible && fitAddonRef.current) {
      setTimeout(() => { try { fitAddonRef.current.fit(); } catch {} }, 100);
    }
  }, [terminalVisible, initTerminal]);

  // --- Actions ---

  const [setupError, setSetupError] = useState('');

  const handleHost = async () => {
    setSetupError('');
    const port = parseInt(portInput) || 3377;
    try {
      const result = await ipcRenderer.invoke('start-server', port, deviceName || undefined);
      if (result.success) {
        setMode('hosting');
        setStatus(`Hosting on port ${port}`);
      } else {
        setSetupError(result.error || 'Failed to start server');
      }
    } catch (err: any) {
      setSetupError(err.message || 'Failed to start server');
    }
  };

  const handleConnect = async () => {
    if (!hostInput) return;
    setSetupError('');
    const port = parseInt(portInput) || 3377;
    try {
      const result = await ipcRenderer.invoke('connect-to-server', hostInput, port, deviceName || undefined);
      if (result.success) {
        setMode('connected');
        setStatus(`Connected to ${hostInput}:${port}`);
      } else {
        setSetupError(result.error || 'Failed to connect');
      }
    } catch (err: any) {
      setSetupError(err.message || 'Failed to connect');
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

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return;
    const result = await ipcRenderer.invoke('workspace-create-project', newProjectName.trim());
    if (result.success) {
      setProjects(prev => [result.project, ...prev.filter(p => p.id !== result.project.id)]);
      setActiveProjectId(result.project.id);
      setNewProjectName('');
      setShowNewProject(false);
    }
  };

  const handleSwitchProject = async (projectId: string) => {
    const result = await ipcRenderer.invoke('workspace-switch-project', projectId);
    if (result.success) {
      setActiveProjectId(projectId);
    }
  };

  const handleLaunchClaude = async () => {
    // Kill existing terminal if any
    if (termIdRef.current !== null) {
      await ipcRenderer.invoke('terminal-kill', termIdRef.current);
      termIdRef.current = null;
      setClaudeLaunched(false);
    }

    const projectInfo = await ipcRenderer.invoke('get-project-folder');
    const result = await ipcRenderer.invoke('terminal-create', projectInfo?.path || undefined);
    if (!result.success) {
      setCommandEntries(prev => [...prev, {
        kind: 'event' as const, id: `evt-${Date.now()}`,
        text: `Failed to launch terminal: ${result.error}`, timestamp: Date.now(), type: 'error',
      }]);
      return;
    }

    termIdRef.current = result.id;
    const myName = deviceName || connectionInfo?.hostname || 'local';
    localDeviceName.current = myName;

    // Bind terminal to our device name AND all name variants
    boundTerminals.current.set(myName, result.id);
    if (connectionInfo?.hostname && connectionInfo.hostname !== myName) {
      boundTerminals.current.set(connectionInfo.hostname, result.id);
    }
    // Also bind to all online device names that match our platform
    for (const d of devices) {
      if (d.platform === (navigator.platform.startsWith('Win') ? 'win32' : 'darwin')) {
        boundTerminals.current.set(d.name, result.id);
      }
    }
    await ipcRenderer.invoke('bind-terminal-device', result.id, myName);

    // Show terminal so user can see what's happening
    setTerminalVisible(true);

    // Wait for shell to fully initialize (login shell sources profile)
    await new Promise(r => setTimeout(r, 1500));

    // cd to project folder and launch claude
    if (projectInfo?.path) {
      await ipcRenderer.invoke('terminal-write', result.id, `cd "${projectInfo.path}"\n`);
      await new Promise(r => setTimeout(r, 500));
    }
    await ipcRenderer.invoke('terminal-write', result.id, 'claude\n');
    setClaudeLaunched(true);

    // Select all online devices as targets
    const allOnline = devices.filter(d => d.status === 'online').map(d => d.name);
    if (!allOnline.includes(myName)) allOnline.push(myName);
    setSelectedTargets(allOnline);
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
    if (!commandInput.trim() || !canSend) return;
    const text = commandInput.trim();
    const promptId = `prompt-${Date.now()}`;
    setCommandInput('');

    setCommandEntries(prev => [...prev, {
      kind: 'prompt' as const, id: promptId, text, timestamp: Date.now(),
      targets: [...selectedTargets],
    }]);

    for (const target of selectedTargets) {
      // Check if this target has a local terminal bound
      let termId = boundTerminals.current.get(target);

      // If not found by exact name, check if it's our local device under any name
      if (termId === undefined && termIdRef.current !== null) {
        const isLocal = target === localDeviceName.current
          || target === connectionInfo?.hostname
          || target === deviceName;
        if (isLocal) {
          termId = termIdRef.current;
        }
      }

      if (termId !== undefined) {
        // Inject directly into local Claude terminal
        await ipcRenderer.invoke('inject-prompt', termId, text, promptId);
      } else {
        // Send to remote device via relay
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
  const activeProject = projects.find(p => p.id === activeProjectId);
  // Can send if: local Claude is running OR there are remote targets selected
  const hasLocalClaude = claudeLaunched;
  const hasRemoteTargets = selectedTargets.some(t => t !== localDeviceName.current);
  const canSend = (hasLocalClaude || hasRemoteTargets) && selectedTargets.length > 0;

  // ===================== SETUP SCREEN =====================
  if (mode === 'idle') {
    return (
      <div className="app">
        <div className="setup-screen">
          <div className="setup-logo">
            <h1 className="logo-text">Claude Connect</h1>
            <p className="setup-tagline">Link your machines. Build together.</p>
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

            {/* Project selector */}
            <div className="setup-field">
              <label>Project</label>
              {projects.length > 0 && (
                <div className="setup-project-list">
                  {projects.slice(0, 5).map(p => (
                    <button
                      key={p.id}
                      className={`setup-project-btn ${p.id === activeProjectId ? 'active' : ''}`}
                      onClick={() => handleSwitchProject(p.id)}
                    >
                      <span className="setup-project-name">{p.name}</span>
                      <span className="setup-project-meta">
                        {Object.keys(p.devices).length} device{Object.keys(p.devices).length !== 1 ? 's' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {showNewProject ? (
                <div className="input-row" style={{ marginTop: 8 }}>
                  <input
                    placeholder="Project name..."
                    value={newProjectName}
                    onChange={e => setNewProjectName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCreateProject()}
                    autoFocus
                  />
                  <button className="btn btn-primary" onClick={handleCreateProject}>Create</button>
                  <button className="btn btn-secondary" onClick={() => { setShowNewProject(false); setNewProjectName(''); }}>Cancel</button>
                </div>
              ) : (
                <button
                  className="btn btn-secondary"
                  style={{ marginTop: 8, width: '100%' }}
                  onClick={() => setShowNewProject(true)}
                >
                  + New Project
                </button>
              )}
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

          {setupError && (
            <div className="setup-error">{setupError}</div>
          )}

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
    <div className="app connected-layout">
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <button className="sidebar-toggle" onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle projects">
            {sidebarOpen ? '\u25C0' : '\u25B6'}
          </button>
          <h1>Claude Connect</h1>
        </div>
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
          {activeProject && (
            <span className="header-project">
              {activeProject.name}
            </span>
          )}
          <button className="btn btn-small btn-danger" onClick={handleDisconnect}>
            Disconnect
          </button>
        </div>
      </header>

      <div className="main-content">
        {/* Project Sidebar */}
        {sidebarOpen && (
          <aside className="sidebar">
            <div className="sidebar-header">
              <h2>Projects</h2>
              <button className="btn btn-small btn-primary" onClick={() => setShowNewProject(true)}>+</button>
            </div>

            {showNewProject && (
              <div className="sidebar-new-project">
                <input
                  placeholder="Project name..."
                  value={newProjectName}
                  onChange={e => setNewProjectName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleCreateProject();
                    if (e.key === 'Escape') { setShowNewProject(false); setNewProjectName(''); }
                  }}
                  autoFocus
                />
                <div className="sidebar-new-actions">
                  <button className="btn btn-small btn-primary" onClick={handleCreateProject}>Create</button>
                  <button className="btn btn-small btn-secondary" onClick={() => { setShowNewProject(false); setNewProjectName(''); }}>Cancel</button>
                </div>
              </div>
            )}

            <div className="sidebar-projects">
              {projects.map(p => (
                <button
                  key={p.id}
                  className={`sidebar-project ${p.id === activeProjectId ? 'active' : ''}`}
                  onClick={() => handleSwitchProject(p.id)}
                >
                  <div className="sidebar-project-name">{p.name}</div>
                  <div className="sidebar-project-meta">
                    {Object.keys(p.devices).length} device{Object.keys(p.devices).length !== 1 ? 's' : ''}
                  </div>
                </button>
              ))}

              {projects.length === 0 && (
                <div className="sidebar-empty">
                  No projects yet. Create one to get started.
                </div>
              )}
            </div>
          </aside>
        )}

        {/* Main area: Command Center + Terminal */}
        <div className="workspace">
          {/* Command Center */}
          <div className={`command-panel ${terminalVisible ? 'with-terminal' : ''}`}>
            {/* Device target bar */}
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
              <div className="command-bar-actions">
                <button className="btn btn-primary btn-small" onClick={handleLaunchClaude}>
                  {claudeLaunched ? 'Relaunch Claude' : 'Launch Claude'}
                </button>
                <button
                  className={`btn btn-small ${terminalVisible ? 'btn-secondary' : 'btn-secondary'}`}
                  onClick={() => setTerminalVisible(!terminalVisible)}
                >
                  {terminalVisible ? 'Hide Terminal' : 'Show Terminal'}
                </button>
              </div>
            </div>

            {/* Conversation stream */}
            <div className="command-stream">
              {commandEntries.length === 0 ? (
                <div className="command-empty">
                  <div className="empty-state">
                    <div className="empty-icon">{'{ }'}</div>
                    <h2>{claudeLaunched ? 'Claude is running' : 'Ready to go'}</h2>
                    {activeProject && !claudeLaunched && (
                      <p>Project <strong>{activeProject.name}</strong> is active.</p>
                    )}
                    {!claudeLaunched && (
                      <>
                        <p>Launch Claude on this machine to start working, or select a remote device to send prompts there.</p>
                        <button className="btn btn-primary" onClick={handleLaunchClaude}>Launch Claude</button>
                      </>
                    )}
                    {claudeLaunched && (
                      <p>Select target device(s) above and type a prompt below.</p>
                    )}
                  </div>
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
                        <span className="event-icon">{entry.type === 'sync' ? '\u21BB' : entry.type === 'error' ? '\u2717' : '\u2192'}</span>
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
                  selectedTargets.length === 0 ? 'Select target device(s) above...'
                    : !canSend ? 'Launch Claude on at least one machine...'
                    : `Send to ${selectedTargets.join(', ')}...`
                }
                value={commandInput}
                onChange={e => setCommandInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCommandSend()}
                disabled={!canSend}
              />
              <button
                className="btn btn-primary"
                onClick={handleCommandSend}
                disabled={!canSend || !commandInput.trim()}
              >
                Send
              </button>
            </div>
          </div>

          {/* Collapsible Terminal */}
          {terminalVisible && (
            <div className="terminal-panel-inline">
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
                  Raw terminal — Claude Code with MCP tools
                </span>
                <button className="btn btn-small btn-secondary" onClick={() => setTerminalVisible(false)} style={{ marginLeft: 'auto' }}>
                  Close
                </button>
              </div>
              <div className="terminal-container" ref={terminalRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
