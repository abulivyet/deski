# Deski

**Deski** 是一个用 [Tauri 2](https://v2.tauri.app/) + [React 19](https://react.dev/) 做的小型**桌面宠物**：无边框透明窗口、置顶、不进任务栏，在桌面上显示一只可互动的雪碧图宠物。

## 功能概览

- **内置宠物**：默认从 `public/pets/<id>/` 加载 `pet.json` 与雪碧图（示例：`dropout-bear`）。
- **更换宠物**：右键打开原生菜单，选择磁盘上的 `pet.json`；雪碧图路径在 manifest 里解析（支持相对 `pet.json` 目录或绝对路径），读盘后经 `blob:` URL 显示。
- **动画与状态**：使用 [`codex-pets-react`](https://www.npmjs.com/package/codex-pets-react) 的 `PetWidget`、`codexPetAtlas`（8×9 图集）与 `usePetController`（idle / 跑 / 挥手 / 跳跃等）。
- **拖动窗口**：在宠物区域按下并移动超过阈值后调用 `startDragging()`，与跑步动画联动。
- **原生右键菜单**：Rust 侧 `popup_menu_at`，通过 `menu-action` 事件驱动前端逻辑。

## 技术栈

| 部分 | 技术 |
|------|------|
| 桌面壳 | Tauri 2、Rust 2021 |
| 前端 | React 19、TypeScript、Vite 7 |
| 宠物 UI | `codex-pets-react` |
| 系统能力 | `@tauri-apps/plugin-fs`（读 manifest / 雪碧图）、`plugin-dialog`（选文件）、`plugin-opener` |
| 权限 | `src-tauri/capabilities/default.json`（`fs` scope、`dialog` 等） |

## 环境要求

- [Node.js](https://nodejs.org/)（建议当前 LTS）
- [Rust](https://www.rust-lang.org/tools/install) 与 Tauri 2 桌面依赖（macOS 上需 Xcode Command Line Tools 等）

## 开发与构建

```bash
# 安装依赖
npm install

# 开发（Vite + Tauri，热更新前端）
npm run tauri dev

# 仅前端
npm run dev

# 生产构建（前端 tsc + vite build，再打包 Tauri）
npm run tauri build
```

调试构建下会在 `setup` 中为主窗口打开 **WebView 开发者工具**（`#[cfg(debug_assertions)]`）。

## 自定义宠物（PetDex 风格 manifest）

在任意目录放置 `pet.json`，例如：

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "可选说明",
  "spritesheetPath": "spritesheet.webp"
}
```

- **`spritesheetPath`**：相对于 `pet.json` 所在目录的文件名，或本机绝对路径。
- 雪碧图需与 [`codex-pets-react`](https://www.npmjs.com/package/codex-pets-react) 内置 atlas 一致（8 列 × 9 行格子布局）。

内置资源放在 **`public/pets/<petId>/`**，开发时通过 HTTP 路径 `/pets/<petId>/...` 访问。

## 应用图标

从根目录源图重新生成 `src-tauri/icons/` 下全套图标（含 `.icns` / `.ico` / 各尺寸 PNG）：

```bash
npx tauri icon app-icon.png
```

`src-tauri/tauri.conf.json` 里 `bundle.icon` 已指向 `icons/` 下对应文件。

## 目录结构（简要）

```
desktop-pet/
├── src/                 # React 应用（App、loadPetManifest、动画常量等）
├── public/pets/         # 内置宠物资源
├── src-tauri/           # Rust + Tauri 配置
│   ├── src/lib.rs       # 入口、菜单、IPC、事件 emit
│   ├── capabilities/    # ACL 权限
│   └── icons/           # 打包用图标（由 tauri icon 生成）
├── app-icon.png         # 图标源图（可选）
└── package.json
```

## 名称与包标识

- 用户可见名称：**Deski**（`tauri.conf.json` 的 `productName`、窗口 `title` 等）。
- npm 包名：`deski`。
- Tauri **`identifier`** 仍为 `com.abulivyet.desktop-pet`（如需上架或独立安装身份，可自行改为新 bundle id）。
