# Docker Manager Simple

一个轻量级的 VS Code 插件，直接通过 Docker Engine API 管理本地和远程 Docker 容器与 Compose 项目，无需额外中间层服务。

## 功能

- 🔍 **自动检测本地 Docker** — 启动即显示，无需配置
- 🌐 **多服务器管理** — 同时管理本地 + 多个远程 Docker 服务器
- 📦 **Compose 项目分组** — 自动识别 `docker-compose` 项目并归类
- ▶️ **一键启停** — 容器和 Compose 项目均可直接启动/停止
- 🟢 **状态可视化** — 运行中/已停止/部分运行一目了然

## 效果预览

```
🌐 Docker 管理器
 ├── 🖥️ localhost                    已连接
 │   ├── 📦 docker-compose
 │   │   ├── 🟢 dify              running (3/3)
 │   │   │   ├── 🟢 dify-web-1    running
 │   │   │   ├── 🟢 dify-api-1    running
 │   │   │   └── 🟢 dify-db-1     running
 │   │   └── 🔴 puppeteer         stopped (0/1)
 │   └── 📦 native
 │       ├── 🟢 nginx              running
 │       └── 🔴 redis              exited
 └── 🖥️ 10.0.0.102                 已连接
     └── ...
```

## 安装

从 VSIX 安装或从源码编译：

```bash
# 编译
npm install
npm run compile

# 打包为 .vsix
npm install -g @vscode/vsce
vsce package
```

然后在 VS Code 中：`扩展` → `...` → `从 VSIX 安装`

## 快速开始

### 场景一：本地有 Docker

无需任何配置，打开插件即可自动识别并显示本地容器。

### 场景二：连接远程 Docker 服务器

**1. 在远程服务器上开启 Docker TCP 端口**

在远程服务器上执行：

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/override.conf << 'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker
```

**2. 在插件中添加服务器**

点击 Docker 管理器面板标题栏的 **`+`** 按钮：

- 输入地址：`10.0.0.102:2375`
- 输入名称：`生产服务器`（会自动建议主机名）
- 插件自动测试连接，通过后即可使用

添加的服务器会自动保存到 VS Code 设置中，重启后保留。

## 配置

| 设置项                          | 类型      | 说明                             |
| ------------------------------- | --------- | -------------------------------- |
| `dockerManagerSimple.servers` | `array` | 手动添加的远程 Docker 服务器列表 |

每个服务器配置：

| 字段           | 类型       | 说明                                            |
| -------------- | ---------- | ----------------------------------------------- |
| `name`       | `string` | 显示名称                                        |
| `host`       | `string` | Docker 主机 IP 或域名                           |
| `port`       | `number` | Docker API 端口，默认`2375`                   |
| `socketPath` | `string` | 自定义 socket 路径（选填，用于 SSH 隧道等场景） |

示例（`settings.json`）：

```json
{
  "dockerManagerSimple.servers": [
    {"name": "生产环境", "host": "10.0.0.102", "port": 2375},
    {"name": "测试环境", "host": "192.168.1.50", "port": 2375}
  ]
}
```

## 操作指南

| 操作                   | 方式                            |
| ---------------------- | ------------------------------- |
| 刷新全部               | 点击标题栏 🔄 按钮              |
| 添加服务器             | 点击标题栏 ➕ 按钮              |
| 移除服务器             | 点击服务器节点右侧 ✕ 按钮      |
| 启动/停止 Compose 项目 | 点击项目节点右侧 ▶️/⏹️ 按钮 |
| 启动/停止容器          | 点击容器节点右侧 ▶️/⏹️ 按钮 |

## 要求

- VS Code `^1.128.0+`
- Docker Engine API v1.40+
- 远程连接需 Docker 开启 TCP 端口（2375），仅建议内网使用

## 开发调试

```bash
npm install
npm run compile
# 按 F5 启动 Extension Development Host
```

## 架构

```
VS Code 插件 ──dockerode──▶ Docker Engine API (:2375 或 unix socket)
```

无需额外中间层服务，直接通过 Docker 官方 API 通信。

## License

MIT
