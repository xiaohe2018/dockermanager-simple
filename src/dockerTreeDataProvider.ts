import * as vscode from 'vscode';
import Docker from 'dockerode';

// ---- 类型定义 ----

export interface ServerConfig {
  name: string;
  host?: string;
  socketPath?: string;
  protocol?: 'ssh';
  username?: string;
  sshPort?: number;
  privateKey?: string;
  /** SSH 密码（与 privateKey 二选一，密码不会持久化到配置文件） */
  password?: string;
}

interface DockerInfo {
  compose: DockerResource[];
  native: DockerResource[];
}

interface DockerResource {
  id: string;
  name: string;
  status?: string;
  type?: string;
  configFile?: string;
  projectName?: string;
  containers?: DockerResource[];
  [key: string]: any;
}

// ---- 单个 Docker 服务器连接 ----

class DockerServerConnection {
  public readonly serverId: string;
  public readonly name: string;
  public readonly isLocal: boolean;
  public error: string | null = null;
  public data: DockerInfo = { compose: [], native: [] };

  private docker: Docker;
  private _connected = false;

  constructor(config: ServerConfig, isLocal: boolean) {
    this.serverId = isLocal ? '__local__' : `remote_${config.host || config.socketPath || 'ssh'}_${config.sshPort || ''}`;
    this.name = config.name;
    this.isLocal = isLocal;

    if (config.protocol === 'ssh' && config.host) {
      // 实时解析 SSH config，不依赖保存的路径
      const sshInfo = resolveSshConfig(config.host);
      const username = config.username || sshInfo.user || 'root';
      const keyFile = config.privateKey || sshInfo.identityFile;

      const sshOpts: any = {
        protocol: 'ssh',
        host: config.host,
        port: config.sshPort || 22,
        username,
      };
      if (keyFile) {
        sshOpts.sshOptions = { privateKey: require('fs').readFileSync(keyFile) };
      } else if (config.password) {
        sshOpts.sshOptions = { password: config.password };
      }
      this.docker = new Docker(sshOpts);
    } else if (config.socketPath) {
      this.docker = new Docker({ socketPath: config.socketPath });
    } else {
      const isWindows = process.platform === 'win32';
      this.docker = new Docker({
        socketPath: isWindows ? '//./pipe/docker_engine' : '/var/run/docker.sock'
      });
    }
  }

  /** 测试连接是否可用 */
  async testConnection(): Promise<boolean> {
    try {
      await this.docker.ping();
      this._connected = true;
      return true;
    } catch {
      this._connected = false;
      return false;
    }
  }

  get connected(): boolean {
    return this._connected;
  }

  /** 获取此服务器的 Docker 实例 */
  getDocker(): Docker {
    return this.docker;
  }

  /** 刷新容器数据 */
  async refresh(): Promise<void> {
    this.error = null;
    try {
      this.data = await this.fetchDockerInfo();
      this._connected = true;
    } catch (err) {
      this._connected = false;
      this.error = err instanceof Error ? err.message : String(err);
      this.data = { compose: [], native: [] };
    }
  }

  /** 查找容器（按名称） */
  async findContainer(containerName: string): Promise<Docker.ContainerInfo | undefined> {
    const all = await this.docker.listContainers({ all: true });
    return all.find(c => c.Names?.some(n => n.replace(/^\//, '') === containerName));
  }

  /** 按标签查找项目容器 */
  async findProjectContainers(projectName: string): Promise<Docker.ContainerInfo[]> {
    return this.docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${projectName}`] }
    });
  }

  // ---- 内部 ----

  private async fetchDockerInfo(): Promise<DockerInfo> {
    const allContainers = await this.docker.listContainers({ all: true });

    const composeMap = new Map<string, {
      projectName: string;
      configFile: string;
      containers: DockerResource[];
    }>();
    const nativeContainers: DockerResource[] = [];

    for (const ci of allContainers) {
      const labels = ci.Labels || {};
      const composeProject = labels['com.docker.compose.project'];
      const composeConfig = labels['com.docker.compose.config_files'];

      const resource: DockerResource = {
        id: ci.Id,
        name: ci.Names?.[0]?.replace(/^\//, '') || ci.Id.substring(0, 12),
        status: ci.State || ci.Status || 'unknown',
        type: composeProject ? 'compose' : 'native',
        image: ci.Image,
      };

      if (composeProject) {
        if (!composeMap.has(composeProject)) {
          composeMap.set(composeProject, {
            projectName: composeProject,
            configFile: composeConfig || '',
            containers: [],
          });
        }
        composeMap.get(composeProject)!.containers.push(resource);
      } else {
        nativeContainers.push(resource);
      }
    }

    const compose: DockerResource[] = [];
    for (const [, project] of composeMap) {
      const runningCount = project.containers.filter(c => c.status === 'running').length;
      const totalCount = project.containers.length;
      const status = runningCount === totalCount && totalCount > 0
        ? 'running'
        : runningCount === 0
          ? 'stopped'
          : 'partial';

      compose.push({
        id: project.projectName,
        name: project.projectName,
        status: `${status} (${runningCount}/${totalCount})`,
        type: 'compose',
        configFile: project.configFile,
        projectName: project.projectName,
        containers: project.containers,
      });
    }

    return { compose, native: nativeContainers };
  }
}

// ---- SSH Config 解析（供连接时实时读取） ----

interface SshConfigEntry {
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

function resolveSshConfig(hostAlias: string): SshConfigEntry {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(configPath)) { return {}; }

  const content = fs.readFileSync(configPath, 'utf8');
  const lines = content.split('\n');
  let currentHost: string | null = null;
  const hosts = new Map<string, SshConfigEntry>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) { continue; }
    const parts = line.split(/\s+/);
    const keyword = parts[0].toLowerCase();
    const value = parts.slice(1).join(' ');

    if (keyword === 'host') {
      for (const h of value.split(/\s+/)) { if (h) { currentHost = h; } }
      if (currentHost && !hosts.has(currentHost)) { hosts.set(currentHost, {}); }
    } else if (currentHost) {
      const entry = hosts.get(currentHost)!;
      switch (keyword) {
        case 'hostname': entry.hostname = value; break;
        case 'user': entry.user = value; break;
        case 'port': entry.port = parseInt(value, 10); break;
        case 'identityfile':
          entry.identityFile = value.replace(/"/g, '').replace(/^~/, os.homedir());
          break;
      }
    }
  }

  // 合并所有匹配的 Host
  const merged: SshConfigEntry = {};
  for (const [pattern, entry] of hosts) {
    if (pattern.includes('*') || pattern.includes('?')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      if (regex.test(hostAlias)) { Object.assign(merged, entry); }
    } else if (pattern === hostAlias) {
      Object.assign(merged, entry);
    }
  }
  return merged;
}

// ---- 树数据提供器 ----

export class DockerTreeDataProvider implements vscode.TreeDataProvider<DockerTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DockerTreeItem | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private servers = new Map<string, DockerServerConnection>();
  private serverOrder: string[] = [];

  /** 获取所有服务器连接 */
  getServerConnections(): ReadonlyMap<string, DockerServerConnection> {
    return this.servers;
  }

  /** 添加一个 Docker 服务器连接 */
  addServer(config: ServerConfig, isLocal = false): string {
    const conn = new DockerServerConnection(config, isLocal);
    this.servers.set(conn.serverId, conn);
    this.serverOrder.push(conn.serverId);
    void this.refresh();
    return conn.serverId;
  }

  /** 移除服务器 */
  removeServer(serverId: string): boolean {
    if (serverId === '__local__') {
      return false;
    }
    const removed = this.servers.delete(serverId);
    if (removed) {
      this.serverOrder = this.serverOrder.filter(id => id !== serverId);
      this._onDidChangeTreeData.fire(null);
    }
    return removed;
  }

  /** 获取连接 */
  getConnection(serverId: string): DockerServerConnection | undefined {
    return this.servers.get(serverId);
  }

  /** 刷新全部服务器 */
  async refresh(): Promise<void> {
    const promises = Array.from(this.servers.values()).map(s => s.refresh());
    await Promise.allSettled(promises);
    this._onDidChangeTreeData.fire(null);
  }

  /** 刷新单个服务器 */
  async refreshServer(serverId: string): Promise<void> {
    const conn = this.servers.get(serverId);
    if (conn) {
      await conn.refresh();
      this._onDidChangeTreeData.fire(null);
    }
  }

  // ---- TreeDataProvider 接口 ----

  getTreeItem(element: DockerTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DockerTreeItem): Promise<DockerTreeItem[]> {
    // 根级别：所有服务器
    if (!element) {
      if (this.servers.size === 0) {
        return [this.createStatusItem('没有可用的 Docker 服务器', '点击 + 按钮添加远程服务器')];
      }
      return this.serverOrder
        .map(id => this.servers.get(id)!)
        .filter(Boolean)
        .map(conn => this.createServerItem(conn));
    }

    // 服务器级别：分类（docker-compose / native）
    if (element.contextValue === 'server') {
      const conn = this.servers.get(element.serverId);
      if (!conn) { return []; }
      if (conn.error) {
        return [this.createStatusItem('连接失败', conn.error)];
      }
      const composeItem = new DockerTreeItem(
        'docker-compose', 'category',
        vscode.TreeItemCollapsibleState.Collapsed,
        element.serverId, undefined, undefined
      );
      composeItem.iconPath = new vscode.ThemeIcon('layers');
      composeItem.tooltip = 'Docker Compose 编排项目';

      const nativeItem = new DockerTreeItem(
        'native', 'category',
        vscode.TreeItemCollapsibleState.Collapsed,
        element.serverId, undefined, undefined
      );
      nativeItem.iconPath = new vscode.ThemeIcon('package');
      nativeItem.tooltip = '独立容器';

      return [composeItem, nativeItem];
    }

    // 分类级别：项目/容器列表
    if (element.contextValue === 'category') {
      const conn = this.servers.get(element.serverId);
      if (!conn) { return []; }
      const list = element.label === 'docker-compose' ? conn.data.compose : conn.data.native;
      if (list.length === 0) {
        return [this.createStatusItem('暂无资源', '')];
      }

      return list.map(item => {
        const label = item.name || item.id || '未命名资源';
        const description = item.status || undefined;
        const hasChildren = Array.isArray(item.containers) && item.containers.length > 0;
        const isCompose = element.label === 'docker-compose';
        const contextValue = isCompose ? 'composeProject' : 'container';
        const collapsibleState = isCompose && hasChildren
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;

        const treeItem = new DockerTreeItem(
          label, contextValue, collapsibleState,
          element.serverId, description, item
        );
        // 根据运行状态设置图标和颜色
        this.applyStatusIcon(treeItem, item.status, isCompose);
        return treeItem;
      });
    }

    // compose 项目级别：项目下的容器
    if (element.contextValue === 'composeProject' && element.resource) {
      const list = element.resource.containers ?? [];
      return list.map(item => {
        const label = item.name || item.id || '未命名容器';
        const description = item.status || undefined;
        const treeItem = new DockerTreeItem(
          label, 'container', vscode.TreeItemCollapsibleState.None,
          element.serverId, description, item
        );
        this.applyStatusIcon(treeItem, item.status, false);
        return treeItem;
      });
    }

    return [];
  }

  // ---- 操作 ----

  async startProject(serverId: string, projectName: string): Promise<void> {
    const conn = this.servers.get(serverId);
    if (!conn) { throw new Error('服务器不存在'); }
    const containers = await conn.findProjectContainers(projectName);
    const docker = conn.getDocker();
    await this.batchControl(docker, containers, 'start');
    await this.refreshServer(serverId);
  }

  async stopProject(serverId: string, projectName: string): Promise<void> {
    const conn = this.servers.get(serverId);
    if (!conn) { throw new Error('服务器不存在'); }
    const containers = await conn.findProjectContainers(projectName);
    const docker = conn.getDocker();
    await this.batchControl(docker, containers, 'stop');
    await this.refreshServer(serverId);
  }

  async startContainer(serverId: string, containerName: string): Promise<void> {
    const conn = this.servers.get(serverId);
    if (!conn) { throw new Error('服务器不存在'); }
    const target = await conn.findContainer(containerName);
    if (!target) { throw new Error(`未找到容器: ${containerName}`); }
    const container = conn.getDocker().getContainer(target.Id);
    await container.start();
    await this.refreshServer(serverId);
  }

  async stopContainer(serverId: string, containerName: string): Promise<void> {
    const conn = this.servers.get(serverId);
    if (!conn) { throw new Error('服务器不存在'); }
    const target = await conn.findContainer(containerName);
    if (!target) { throw new Error(`未找到容器: ${containerName}`); }
    const container = conn.getDocker().getContainer(target.Id);
    await container.stop();
    await this.refreshServer(serverId);
  }

  // ---- 内部辅助 ----

  private async batchControl(
    docker: Docker,
    containers: Docker.ContainerInfo[],
    action: 'start' | 'stop'
  ): Promise<void> {
    const results = await Promise.allSettled(
      containers.map(async (ci) => {
        const c = docker.getContainer(ci.Id);
        if (action === 'start') { await c.start(); } else { await c.stop(); }
      })
    );
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      const msgs = failures.map((r: PromiseRejectedResult) =>
        r.reason instanceof Error ? r.reason.message : String(r.reason)
      );
      vscode.window.showWarningMessage(`部分容器操作失败: ${msgs.join('; ')}`);
    }
  }

  private createServerItem(conn: DockerServerConnection): DockerTreeItem {
    const statusText = conn.connected
      ? '已连接'
      : (conn.error || '未连接');

    const item = new DockerTreeItem(
      conn.name, 'server',
      vscode.TreeItemCollapsibleState.Collapsed,
      conn.serverId, statusText, undefined
    );

    // 用 iconPath 正规设置图标
    item.iconPath = new vscode.ThemeIcon(
      conn.isLocal ? 'device-desktop' : 'remote',
      conn.connected ? undefined : new vscode.ThemeColor('problemsErrorIcon.foreground')
    );
    item.tooltip = conn.isLocal
      ? `本地 Docker (${conn.name})`
      : `${conn.name}${conn.error ? ' - 错误: ' + conn.error : ''}`;
    return item;
  }

  private createStatusItem(label: string, tooltip: string): DockerTreeItem {
    const item = new DockerTreeItem(
      label, 'status', vscode.TreeItemCollapsibleState.None,
      '__status__', undefined, undefined
    );
    item.tooltip = tooltip;
    return item;
  }

  /** 根据运行状态设置图标和颜色 */
  private applyStatusIcon(
    item: DockerTreeItem,
    status?: string,
    isProject?: boolean
  ): void {
    const s = status?.toLowerCase() || '';
    if (isProject) {
      // compose 项目状态
      if (s.startsWith('running') || s.includes('全部启动')) {
        item.iconPath = new vscode.ThemeIcon('folder-active', new vscode.ThemeColor('charts.green'));
      } else if (s.startsWith('stopped') || s.includes('全部停止')) {
        item.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.red'));
      } else {
        item.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.orange'));
      }
    } else {
      // 单个容器状态
      if (s === 'running' || s.startsWith('up ')) {
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
      } else if (s === 'exited' || s.startsWith('exited')) {
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.red'));
      } else {
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.orange'));
      }
    }
  }
}

// ---- 树节点 ----

export class DockerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly contextValue: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly serverId: string,
    public readonly description?: string,
    public readonly resource?: DockerResource
  ) {
    super(label, collapsibleState);
    this.contextValue = contextValue;
    this.description = description;
  }
}
