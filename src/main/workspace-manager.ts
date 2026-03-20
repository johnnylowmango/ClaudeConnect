import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { v4 as uuid } from 'uuid';
import { WorkspaceConfig, ProjectEntry, DeviceProjectState } from '../shared/types';

const WORKSPACE_CONFIG = 'workspace.json';
const PROJECTS_DIR = 'Projects';

export class WorkspaceManager {
  private config: WorkspaceConfig;
  private configPath: string;

  constructor(root?: string) {
    const workspaceRoot = root || path.join(os.homedir(), 'ClaudeConnect');
    this.configPath = path.join(workspaceRoot, WORKSPACE_CONFIG);

    // Ensure workspace directories exist
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, PROJECTS_DIR), { recursive: true });

    // Load or create config
    if (fs.existsSync(this.configPath)) {
      try {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this.config.root = workspaceRoot; // Always use current root
      } catch {
        this.config = this.defaultConfig(workspaceRoot);
      }
    } else {
      this.config = this.defaultConfig(workspaceRoot);
      this.save();
    }
  }

  private defaultConfig(root: string): WorkspaceConfig {
    return { root, projects: [], activeProjectId: null };
  }

  private save() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  getRoot(): string {
    return this.config.root;
  }

  getProjectsDir(): string {
    return path.join(this.config.root, PROJECTS_DIR);
  }

  createProject(name: string, deviceName: string): ProjectEntry {
    // Sanitize name for filesystem
    const safeName = name.replace(/[<>:"/\\|?*]/g, '-').trim();
    if (!safeName) throw new Error('Invalid project name');

    // Check for duplicate
    const existing = this.config.projects.find(
      p => p.name.toLowerCase() === safeName.toLowerCase()
    );
    if (existing) return existing;

    const projectDir = path.join(this.getProjectsDir(), safeName);
    fs.mkdirSync(projectDir, { recursive: true });

    const entry: ProjectEntry = {
      id: uuid(),
      name: safeName,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
      devices: {
        [deviceName]: {
          localPath: projectDir,
          lastSynced: 0,
          status: 'unknown',
        },
      },
    };

    this.config.projects.push(entry);
    this.config.activeProjectId = entry.id;
    this.save();
    return entry;
  }

  /**
   * Register a project that was created on a remote device.
   * Creates the local folder and adds to config.
   */
  registerRemoteProject(entry: ProjectEntry, deviceName: string): ProjectEntry {
    const existing = this.config.projects.find(p => p.id === entry.id);
    if (existing) {
      // Update device info
      if (!existing.devices[deviceName]) {
        const projectDir = path.join(this.getProjectsDir(), existing.name);
        fs.mkdirSync(projectDir, { recursive: true });
        existing.devices[deviceName] = {
          localPath: projectDir,
          lastSynced: 0,
          status: 'unknown',
        };
        this.save();
      }
      return existing;
    }

    // Create local folder for this project
    const projectDir = path.join(this.getProjectsDir(), entry.name);
    fs.mkdirSync(projectDir, { recursive: true });

    const localEntry: ProjectEntry = {
      ...entry,
      devices: {
        ...entry.devices,
        [deviceName]: {
          localPath: projectDir,
          lastSynced: 0,
          status: 'unknown',
        },
      },
    };

    this.config.projects.push(localEntry);
    this.save();
    return localEntry;
  }

  listProjects(): ProjectEntry[] {
    return [...this.config.projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  getProject(id: string): ProjectEntry | null {
    return this.config.projects.find(p => p.id === id) || null;
  }

  getProjectByName(name: string): ProjectEntry | null {
    return this.config.projects.find(
      p => p.name.toLowerCase() === name.toLowerCase()
    ) || null;
  }

  getActiveProject(): ProjectEntry | null {
    if (!this.config.activeProjectId) return null;
    return this.getProject(this.config.activeProjectId);
  }

  getActiveProjectPath(deviceName: string): string | null {
    const project = this.getActiveProject();
    if (!project) return null;
    const deviceState = project.devices[deviceName];
    if (deviceState) return deviceState.localPath;
    // Fallback: construct path
    return path.join(this.getProjectsDir(), project.name);
  }

  switchProject(id: string): ProjectEntry | null {
    const project = this.config.projects.find(p => p.id === id);
    if (!project) return null;
    project.lastOpenedAt = Date.now();
    this.config.activeProjectId = id;
    this.save();
    return project;
  }

  deleteProject(id: string, removeFiles: boolean = false): boolean {
    const idx = this.config.projects.findIndex(p => p.id === id);
    if (idx < 0) return false;

    const project = this.config.projects[idx];
    if (removeFiles) {
      // Remove project directory for all local device paths
      for (const deviceState of Object.values(project.devices)) {
        if (fs.existsSync(deviceState.localPath)) {
          fs.rmSync(deviceState.localPath, { recursive: true, force: true });
        }
      }
    }

    this.config.projects.splice(idx, 1);
    if (this.config.activeProjectId === id) {
      this.config.activeProjectId = this.config.projects[0]?.id || null;
    }
    this.save();
    return true;
  }

  updateDeviceState(projectId: string, deviceName: string, updates: Partial<DeviceProjectState>) {
    const project = this.getProject(projectId);
    if (!project) return;
    if (!project.devices[deviceName]) {
      project.devices[deviceName] = {
        localPath: path.join(this.getProjectsDir(), project.name),
        lastSynced: 0,
        status: 'unknown',
      };
    }
    Object.assign(project.devices[deviceName], updates);
    this.save();
  }

  /**
   * Export workspace config for sharing with other devices via relay.
   */
  exportForRelay(): { projects: ProjectEntry[]; activeProjectId: string | null } {
    return {
      projects: this.config.projects,
      activeProjectId: this.config.activeProjectId,
    };
  }
}
