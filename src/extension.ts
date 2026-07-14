import * as vscode from 'vscode';
import { DockerTreeDataProvider, ServerConfig } from './dockerTreeDataProvider';
import Docker from 'dockerode';

let provider: DockerTreeDataProvider;

export async function activate(context: vscode.ExtensionContext) {
  provider = new DockerTreeDataProvider();

  // ---- 自动检测本地 Docker ----
  const localDocker = createLocalDocker();
  const localResult = await testDockerConnection(localDocker);
  if (localResult.ok) {
    provider.addServer({ name: 'localhost' }, true);
  }

  // ---- 加载远程服务器配置 ----
  loadRemoteServers();

  // ---- 监听配置变更 ----
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('dockerManagerSimple.servers')) {
        loadRemoteServers();
      }
    })
  );

  // ---- 创建树视图 ----
  const treeView = vscode.window.createTreeView('dockerManagerView', {
    treeDataProvider: provider
  });

  context.subscriptions.push(
    treeView,
    treeView.onDidChangeVisibility(async e => {
      if (e.visible) {
        await provider.refresh();
      }
    }),

    // 刷新全部
    vscode.commands.registerCommand('dockermanagerSimple.refresh', async () => {
      await provider.refresh();
      vscode.window.showInformationMessage('Docker Manager: 刷新完成');
    }),

    // 添加远程服务器
    vscode.commands.registerCommand('dockermanagerSimple.addServer', async () => {
      await addServerInteractive();
    }),

    // 移除服务器
    vscode.commands.registerCommand('dockermanagerSimple.removeServer', async (item: any) => {
      if (!item?.serverId) {
        return vscode.window.showErrorMessage('请选择一个服务器再移除');
      }
      if (item.serverId === '__local__') {
        return vscode.window.showWarningMessage('不能移除本地 Docker 服务器');
      }
      await removeServer(item.serverId);
    }),

    // 启动/停止 compose 项目
    vscode.commands.registerCommand('dockermanagerSimple.startProject', async (item: any) => {
      if (!item?.serverId || !item?.resource?.id) {
        return vscode.window.showErrorMessage('请选择一个编排项目再操作');
      }
      try {
        await provider.startProject(item.serverId, item.resource.id);
        vscode.window.showInformationMessage(`项目 ${item.resource.id} 已启动`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`启动失败: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('dockermanagerSimple.stopProject', async (item: any) => {
      if (!item?.serverId || !item?.resource?.id) {
        return vscode.window.showErrorMessage('请选择一个编排项目再操作');
      }
      try {
        await provider.stopProject(item.serverId, item.resource.id);
        vscode.window.showInformationMessage(`项目 ${item.resource.id} 已停止`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`停止失败: ${err.message}`);
      }
    }),

    // 启动/停止单个容器
    vscode.commands.registerCommand('dockermanagerSimple.startContainer', async (item: any) => {
      const containerName = item?.resource?.name || item?.label;
      if (!containerName || !item?.serverId) {
        return vscode.window.showErrorMessage('请选择一个容器再操作');
      }
      try {
        await provider.startContainer(item.serverId, containerName);
        vscode.window.showInformationMessage(`容器 ${containerName} 已启动`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`启动失败: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('dockermanagerSimple.stopContainer', async (item: any) => {
      const containerName = item?.resource?.name || item?.label;
      if (!containerName || !item?.serverId) {
        return vscode.window.showErrorMessage('请选择一个容器再操作');
      }
      try {
        await provider.stopContainer(item.serverId, containerName);
        vscode.window.showInformationMessage(`容器 ${containerName} 已停止`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`停止失败: ${err.message}`);
      }
    })
  );
}

export function deactivate() {
}

// ---- 辅助函数 ----

function createLocalDocker(): Docker {
  const isWindows = process.platform === 'win32';
  return new Docker({
    socketPath: isWindows ? '//./pipe/docker_engine' : '/var/run/docker.sock'
  });
}

async function testDockerConnection(docker: Docker): Promise<{ ok: boolean; error?: string }> {
  try {
    await docker.ping();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

function loadRemoteServers(): void {
  const config = vscode.workspace.getConfiguration('dockerManagerSimple');
  const servers: ServerConfig[] = config.get<ServerConfig[]>('servers') || [];

  // 移除所有旧的远程服务器（保留本地）
  const connections = provider.getServerConnections();
  for (const [id, conn] of connections) {
    if (!conn.isLocal) {
      provider.removeServer(id);
    }
  }

  // 添加配置中的远程服务器
  for (const srv of servers) {
    if (srv.name && (srv.host || srv.socketPath)) {
      provider.addServer(srv, false);
    }
  }
}

// ---- SSH Config 解析 ----

interface SshConfigEntry {
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/** 解析 ~/.ssh/config，根据 Host 别名查 HostName/User/IdentityFile */
async function resolveSshConfig(hostAlias: string): Promise<SshConfigEntry> {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');

  const configPath = path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(configPath)) {
    return {};
  }

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
      // 支持 Host 后面多个别名（空格分隔）
      for (const h of value.split(/\s+/)) {
        if (h) { currentHost = h; }
      }
      if (currentHost && !hosts.has(currentHost)) {
        hosts.set(currentHost, {});
      }
    } else if (currentHost) {
      const entry = hosts.get(currentHost)!;
      switch (keyword) {
        case 'hostname':
          entry.hostname = value;
          break;
        case 'user':
          entry.user = value;
          break;
        case 'port':
          entry.port = parseInt(value, 10);
          break;
        case 'identityfile':
          // 去掉引号，处理 ~ 路径
          entry.identityFile = value.replace(/"/g, '').replace(/^~/, os.homedir());
          break;
      }
    }
  }

  // 找出所有匹配的 Host（精确 + 通配符），按文件顺序合并
  const merged: SshConfigEntry = {};
  for (const [pattern, entry] of hosts) {
    if (pattern.includes('*') || pattern.includes('?')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      if (regex.test(hostAlias)) {
        Object.assign(merged, entry);
      }
    } else if (pattern === hostAlias) {
      Object.assign(merged, entry);
    }
  }

  // 如果合并后没有 IdentityFile，扫描密钥
  if (!merged.identityFile) {
    merged.identityFile = await pickSshKey();
  }
  return merged;
}

/** 扫描 ~/.ssh/ 目录，返回所有私钥路径 */
function findAllSshKeys(): string[] {
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const sshDir = path.join(os.homedir(), '.ssh');
  if (!fs.existsSync(sshDir)) { return []; }
  const skip = ['config', 'known_hosts', 'known_hosts.old', 'authorized_keys'];
  const keys: string[] = [];
  for (const f of fs.readdirSync(sshDir)) {
    if (skip.includes(f) || f.endsWith('.pub')) { continue; }
    const fp = path.join(sshDir, f);
    try {
      const s = fs.statSync(fp);
      if (s.isFile() && s.size < 10000 && fs.readFileSync(fp, 'utf8').includes('PRIVATE KEY')) {
        keys.push(fp);
      }
    } catch { /* skip */ }
  }
  return keys;
}

/** 从多个密钥中让用户选择一个，只有一个时直接返回 */
async function pickSshKey(): Promise<string | undefined> {
  const keys = findAllSshKeys();
  if (keys.length === 0) { return undefined; }
  if (keys.length === 1) { return keys[0]; }
  const picked = await vscode.window.showQuickPick(
    keys.map(k => ({ label: k.replace(/.*[\\/]/, ''), description: k, value: k })),
    { placeHolder: '选择 SSH 私钥' }
  );
  return picked?.value;
}

async function addServerInteractive(): Promise<void> {
  // 第一步：选择连接方式
  const protocol = await vscode.window.showQuickPick(
    [
      { label: '$(key) SSH 连接', description: '通过 SSH 隧道访问远程 Docker（无需开放端口，更安全）', value: 'ssh' },
      { label: '$(folder) Unix Socket', description: '本地或远程 socket 路径', value: 'socket' }
    ],
    { placeHolder: '选择 Docker 连接方式' }
  );
  if (!protocol) { return; }
  const protoValue = protocol.value;

  let config: ServerConfig = { name: '' };

  if (protoValue === 'ssh') {
    // 1. 输入 host
    const hostInput = await vscode.window.showInputBox({
      prompt: 'SSH 主机地址或别名（自动读取 ~/.ssh/config）',
      placeHolder: '例如: 10.0.0.102',
      validateInput: v => v.trim() ? null : '地址不能为空'
    });
    if (!hostInput) { return; }

    // 2. 解析 SSH config
    const sshInfo = await resolveSshConfig(hostInput.trim());
    const resolvedHost = sshInfo.hostname || hostInput.trim();

    // 3. 输入 username
    const user = await vscode.window.showInputBox({
      prompt: 'SSH 用户名',
      value: sshInfo.user || 'root',
      validateInput: v => v.trim() ? null : '用户名不能为空'
    });
    if (!user) { return; }

    const baseConfig = {
      host: resolvedHost,
      protocol: 'ssh' as const,
      username: user.trim(),
      sshPort: sshInfo.port || 22,
    };

    // 4. 尝试密钥登录
    let connectResult = await trySshConnect(baseConfig, sshInfo.identityFile);
    if (connectResult.ok) {
      const name = await vscode.window.showInputBox({
        prompt: '✅ 连接成功！请输入服务器显示名称',
        value: hostInput.trim(),
        placeHolder: '例如: 生产服务器'
      });
      if (!name) { return; }
      config = { name, ...baseConfig, privateKey: sshInfo.identityFile };
    } else {
      // 5. 密钥失败 → 密码登录
      vscode.window.showInformationMessage(`密钥登录失败: ${connectResult.error}`);
      const password = await vscode.window.showInputBox({
        prompt: `请输入 SSH 密码（${user.trim()}@${resolvedHost}）`,
        password: true,
        validateInput: v => v ? null : '密码不能为空'
      });
      if (!password) { return; }

      connectResult = await trySshConnect(baseConfig, undefined, password);
      if (connectResult.ok) {
        const name = await vscode.window.showInputBox({
          prompt: '✅ 连接成功！请输入服务器显示名称',
          value: hostInput.trim(),
          placeHolder: '例如: 生产服务器'
        });
        if (!name) { return; }
        config = { name, ...baseConfig, password };
      } else {
        vscode.window.showErrorMessage(`密码登录也失败: ${connectResult.error}`);
        return;
      }
    }
  } else {
    // Socket 方式
    const path = await vscode.window.showInputBox({
      prompt: 'Socket 路径',
      placeHolder: '例如: /var/run/docker.sock',
      validateInput: v => v.trim() ? null : '路径不能为空'
    });
    if (!path) { return; }

    const name = await vscode.window.showInputBox({
      prompt: '服务器显示名称',
      value: path.trim(),
      placeHolder: '例如: 本地 Docker'
    });
    if (!name) { return; }

    config = { name, socketPath: path.trim() };

    // Socket 连接测试
    const docker = createDockerFromConfig(config);
    const connResult = await testDockerConnection(docker);
    if (!connResult.ok) {
      const result = await vscode.window.showWarningMessage(
        `无法连接: ${connResult.error}，是否仍然添加？`,
        '仍然添加', '取消'
      );
      if (result !== '仍然添加') { return; }
    } else {
      vscode.window.showInformationMessage(`已成功连接到 ${name}`);
    }
  }

  provider.addServer(config, false);
  saveServerToConfig(config);
}

/** 尝试 SSH 连接，返回结果 */
async function trySshConnect(
  base: { host: string; username: string; sshPort: number },
  keyPath?: string,
  password?: string
): Promise<{ ok: boolean; error?: string }> {
  const sshOpts: any = {
    protocol: 'ssh',
    host: base.host,
    port: base.sshPort,
    username: base.username,
  };
  if (keyPath) {
    sshOpts.sshOptions = { privateKey: require('fs').readFileSync(keyPath) };
  } else if (password) {
    sshOpts.sshOptions = { password };
  }
  const docker = new Docker(sshOpts);
  try {
    await docker.ping();
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message || String(err) };
  }
}

function createDockerFromConfig(config: ServerConfig): Docker {
  return new Docker({ socketPath: config.socketPath! });
}

async function removeServer(serverId: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('dockerManagerSimple');
  const servers: ServerConfig[] = config.get<ServerConfig[]>('servers') || [];

  const conn = provider.getConnection(serverId);
  const updated = servers.filter(s => {
    if (!conn) { return true; }
    if (s.host || s.socketPath) {
      const sid = `remote_${s.host || s.socketPath}_${s.sshPort || ''}`;
      return sid !== serverId;
    }
    return true;
  });

  await config.update('servers', updated, vscode.ConfigurationTarget.Global);
  provider.removeServer(serverId);
  vscode.window.showInformationMessage('服务器已移除');
}

async function saveServerToConfig(config: ServerConfig): Promise<void> {
  // 密码和从 SSH config 解析出的密钥不持久化，每次连接时实时读取
  const { password, privateKey, ...safe } = config;
  const wsConfig = vscode.workspace.getConfiguration('dockerManagerSimple');
  const servers: ServerConfig[] = wsConfig.get<ServerConfig[]>('servers') || [];
  servers.push(safe);
  await wsConfig.update('servers', servers, vscode.ConfigurationTarget.Global);
}
