# Kimi Code Desktop

一个极简的跨平台桌面壳（Electron，支持 macOS / Windows / Linux）：自动运行 `kimi web`，并把 Kimi Code 的 Web UI 内嵌到原生窗口中。

> 需要已安装并配置 [Kimi Code CLI](https://www.kimi.com/code/docs/en/)。

## 功能

- 启动时自动探测本机 `kimi web` 服务（默认端口 58627 起），没有则自动拉起 `kimi web --no-open`，退出时自动回收子进程
- 自动读取 `~/.kimi-code/server.token` 并通过 `#token=` 完成登录
- macOS：隐藏标题栏，红绿灯按钮内嵌进页面，顶栏可拖拽移动窗口；Windows/Linux：原生标题栏
- 侧栏展开/收起两种布局均适配红绿灯位置（macOS）
- 菜单栏（Tray）图标：显示正在运行的会话、打开主窗口、退出
- 关闭窗口 = 隐藏到托盘，`Cmd+Q`（macOS）/ 托盘菜单「退出」才真正退出
- 站内链接窗口内打开，站外链接转交系统默认浏览器
- 文件选择弹原生对话框，粘贴（文本/图片/文件）由 Chromium 原生支持

## 环境要求

- macOS / Windows / Linux
- Node.js ≥ 18
- 已安装 `kimi` CLI 并至少登录过一次（web UI 的 token 来自 `~/.kimi-code/server.token`，先在 CLI 中执行过 `/web` 或 `kimi web` 即可）

## 使用

```bash
npm install
npm start        # 开发模式运行
npm run dist     # 打包当前平台安装包（macOS: universal DMG+zip / Windows: NSIS+zip / Linux: AppImage）
npm run dist:all # 一次打包全平台：macOS universal（Intel+Apple Silicon 二合一）、Win/Linux x64+arm64
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `KIMI_WEB_PORT` | `58627` | 探测/启动 kimi web 的起始端口 |
| `KIMI_BIN` | 自动查找 | kimi CLI 路径（PATH 找不到时指定） |

## 说明

- macOS 版未做代码签名；从其他机器首次打开需要右键 →「打开」，或执行 `xattr -cr "/Applications/Kimi Code.app"`
- Windows/Linux 安装包同样未签名
- 应用仅绑定本机回环地址，与 `kimi web` 自身的安全模型一致
- 跨平台安装包可在 macOS 上直接交叉构建：`npx electron-builder --win --linux --x64`（x64 为主流用户架构）
