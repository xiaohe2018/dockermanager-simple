import * as vscode from 'vscode';
import { DockerTreeDataProvider, ServerConfig } from './dockerTreeDataProvider';
import Docker from 'dockerode';

let provider: DockerTreeDataProvider;

export async function activate(context: vscode.ExtensionContext) {
  provider = new DockerTreeDataProvider();

  // ---- 自动检测本地 Docker ----
  const localDocker = createLocalDocker();
  const localAvailable = await testDockerConnection(localDocker);
  if (localAvailable) {
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

async function testDockerConnection(docker: Docker): Promise<boolean> {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
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

async function addServerInteractive(): Promise<void> {
  // 第一步：输入地址
  const address = await vscode.window.showInputBox({
    prompt: '请输入 Docker 服务器地址',
    placeHolder: '例如: 10.0.0.102:2375 或 /var/run/docker.sock',
    validateInput: (value) => {
      if (!value.trim()) {
        return '地址不能为空';
      }
      return null;
    }
  });
  if (!address) { return; }

  // 第二步：输入名称（自动建议一个友好名称）
  let defaultName = address.trim();
  if (!defaultName.startsWith('/') && !defaultName.startsWith('\\')) {
    // TCP 地址：取主机名部分作为默认名
    const hostPart = defaultName.split(':')[0];
    defaultName = hostPart;
  }
  const name = await vscode.window.showInputBox({
    prompt: '请输入服务器显示名称',
    placeHolder: '例如: 生产服务器',
    value: defaultName,
    validateInput: (value) => {
      if (!value.trim()) {
        return '名称不能为空';
      }
      return null;
    }
  });
  if (!name) { return; }

  // 解析地址
  let config: ServerConfig;
  const trimmed = address.trim();

  if (trimmed.startsWith('/') || trimmed.startsWith('\\\\.\\') || trimmed.startsWith('//./')) {
    config = { name, socketPath: trimmed };
  } else {
    const parts = trimmed.split(':');
    const host = parts[0];
    const port = parts.length > 1 ? parseInt(parts[1], 10) : 2375;
    config = { name, host, port };
  }

  // 测试连接
  const docker = config.socketPath
    ? new Docker({ socketPath: config.socketPath })
    : new Docker({ host: config.host!, port: config.port! });

  const connectingMsg = vscode.window.setStatusBarMessage(`$(sync~spin) 正在连接 ${name}...`);
  const reachable = await testDockerConnection(docker);
  connectingMsg.dispose();

  if (!reachable) {
    const result = await vscode.window.showWarningMessage(
      `无法连接到 ${name}，是否仍然添加？`,
      '仍然添加',
      '取消'
    );
    if (result !== '仍然添加') { return; }
  } else {
    vscode.window.showInformationMessage(`已成功连接到 ${name}`);
  }

  // 添加到运行时和配置文件
  provider.addServer(config, false);
  saveServerToConfig(config);
}

async function removeServer(serverId: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('dockerManagerSimple');
  const servers: ServerConfig[] = config.get<ServerConfig[]>('servers') || [];

  const conn = provider.getConnection(serverId);
  const updated = servers.filter(s => {
    if (!conn) { return true; }
    if (s.host || s.port) {
      const sid = `remote_${s.host || s.socketPath}_${s.port || ''}`;
      return sid !== serverId;
    }
    return true;
  });

  await config.update('servers', updated, vscode.ConfigurationTarget.Global);
  provider.removeServer(serverId);
  vscode.window.showInformationMessage('服务器已移除');
}

async function saveServerToConfig(config: ServerConfig): Promise<void> {
  const wsConfig = vscode.workspace.getConfiguration('dockerManagerSimple');
  const servers: ServerConfig[] = wsConfig.get<ServerConfig[]>('servers') || [];
  servers.push(config);
  await wsConfig.update('servers', servers, vscode.ConfigurationTarget.Global);
}
