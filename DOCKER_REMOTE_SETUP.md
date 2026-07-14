# Docker 远程 TCP 连接配置指南

适用于 Debian/Ubuntu 系统，让 Docker 守护进程同时监听 Unix Socket 和 TCP 端口。

## 操作步骤

在 Docker 服务器上以 root 身份执行：

### 1. 创建 systemd override 配置

```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/override.conf << 'EOF'
[Service]
ExecStart=
ExecStart=/usr/bin/dockerd -H fd:// -H tcp://0.0.0.0:2375
EOF
```

> **说明：**
> - `ExecStart=` 先清空原有的 ExecStart 指令
> - `-H fd://` 保留 systemd socket activation（本地通信）
> - `-H tcp://0.0.0.0:2375` 新增 TCP 监听，允许远程访问

### 2. 重载并重启 Docker

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
```

### 3. 验证

```bash
# 检查端口是否监听
sudo netstat -tlnp | grep 2375

# 测试 API 是否响应
curl http://localhost:2375/version
```

### 4. 防火墙放行（可选，内网通常不需要）

```bash
# firewalld
sudo firewall-cmd --add-port=2375/tcp --permanent
sudo firewall-cmd --reload

# ufw
sudo ufw allow 2375/tcp
```

## 故障排查

| 问题 | 解决方法 |
|------|---------|
| `Unit docker.service not found` | 检查 `systemctl list-unit-files \| grep docker` 确认服务名 |
| `Failed to start docker.service` | 不要同时在 `daemon.json` 和 systemd override 里配置 hosts，二选一 |
| 连接被拒绝 | 检查防火墙、确认 Docker 已重启 |
| JSON 解析失败 | `cat /etc/docker/daemon.json \| python3 -m json.tool` 检查语法 |

## 安全提醒

⚠️ **端口 2375 是无加密明文通信**，仅适合内网环境使用。

公网环境请配置 TLS 加密（端口 2376），参考 [Docker 官方文档](https://docs.docker.com/engine/security/protect-access/)。

## 撤销配置

如需恢复，删除 override 文件并重启：

```bash
sudo rm /etc/systemd/system/docker.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart docker
```
