# Docker Manager Simple

一个轻量级的 VS Code 插件，直接通过 Docker Engine API 管理本地和远程 Docker 容器与 Compose 项目，无需额外中间层服务。

## 功能

- � **SSH 直连** — 通过 SSH 隧道访问远程 Docker，无需开放端口
- 📋 **SSH Config 集成** — 自动读取 `~/.ssh/config`，支持别名和通配符
- 🔍 **自动检测本地 Docker** — 有则显示，无需配置
- 🌐 **多服务器管理** — 同时管理本地 + 多个远程服务器
- 📦 **Compose 项目分组** — 自动识别并归类
- ▶️ **一键启停** — 容器和项目均可直接操作
- 🟢 **状态可视化** — 图标颜色区分运行/停止/部分运行

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

### 本地 Docker

无需任何配置，打开插件即自动显示。

### 远程 Docker（SSH 直连，推荐）

**零服务端配置**，只需能 SSH 登录：

1. 点击标题栏 **`+`** → 选择 **🔑 SSH 连接**
2. 输入主机地址：`10.0.0.102`（或 `~/.ssh/config` 中的 Host 别名）
3. 输入用户名（自动从 SSH config 读取）
4. 插件自动解析 `~/.ssh/config` → 尝试密钥连接
5. ✅ 成功后输入显示名称

**密钥认证流程：**

| 优先级 | 来源                                                 |
| ------ | ---------------------------------------------------- |
| 1      | `~/.ssh/config` 中匹配 Host 的 `IdentityFile`    |
| 2      | `~/.ssh/` 目录下自动扫描私钥（多密钥时弹出选择框） |
| 3      | 弹出密码框手动输入                                   |

### 远程 Docker（Unix Socket）

选 **📁 Unix Socket**，输入路径如 `/var/run/docker.sock`。

### SSH Config 兼容

完全兼容 OpenSSH config，支持 Host 别名、通配符、多 Host 合并：

```
Host myserver
    HostName 10.0.0.102
    User root
    IdentityFile ~/.ssh/my_key

Host 10.0.0.*
    User root
    IdentityFile ~/.ssh/linux_sshkey
```

## 配置

| 设置项                          | 类型      | 说明                   |
| ------------------------------- | --------- | ---------------------- |
| `dockerManagerSimple.servers` | `array` | 远程 Docker 服务器列表 |

服务器配置字段：

| 字段           | 类型       | 说明                  |
| -------------- | ---------- | --------------------- |
| `name`       | `string` | 显示名称              |
| `host`       | `string` | 主机 IP/域名/SSH 别名 |
| `protocol`   | `"ssh"`  | 连接协议              |
| `username`   | `string` | SSH 用户名            |
| `sshPort`    | `number` | SSH 端口，默认 22     |
| `socketPath` | `string` | Unix socket 路径      |

> ⚠️ 密钥路径和密码**不保存**，每次连接实时从 `~/.ssh/config` 读取。

## 操作指南

| 操作                   | 方式                            |
| ---------------------- | ------------------------------- |
| 刷新全部               | 点击标题栏 🔄 按钮              |
| 添加服务器             | 点击标题栏 ➕ 按钮              |
| 移除服务器             | 点击服务器节点右侧 ✕ 按钮      |
| 启动/停止 Compose 项目 | 点击项目节点右侧 ▶️/⏹️ 按钮 |
| 启动/停止容器          | 点击容器节点右侧 ▶️/⏹️ 按钮 |

## 要求

- VS Code `^1.128.0`
- Docker Engine API v1.40+
- 远程连接：SSH 密钥或密码

## 架构

```
VS Code 插件 ──dockerode──▶ SSH 隧道 ──▶ 远程 Docker socket
                 └────────▶ 本地 Docker socket
```

无需中间层服务，不依赖 Docker TCP 端口。

## License

MIT
