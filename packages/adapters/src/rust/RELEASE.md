# Native 平台包发布说明

## 首次冷启动（npm 上还没有平台包）

在以下平台各执行一次（可不同机器）：

- macOS x64
- macOS arm64
- Linux x64 (glibc)
- Linux arm64 (glibc)
- Windows x64 (msvc)

命令：

```bash
pnpm run adapters:publish-native:current-platform
```

该命令会自动完成：

1. 构建当前平台 `.node`
2. 生成 `npm/<platform>` 子包
3. 将 `.node` 复制到对应子包
4. 发布当前平台子包到 npm

说明：本地手动发布默认不使用 provenance，避免 `Automatic provenance generation not supported for provider: null` 错误；在 GitHub Actions 环境会自动启用 provenance。

## 主包发布前本地验证

```bash
pnpm run adapters:verify-native-install
```

校验点：

1. `@hls-downloader/adapters` 安装产物中不包含 `.node`
2. 仅通过 optionalDependencies 安装当前平台 native 包
3. `@hls-downloader/adapters/rust` 可以正常 import
4. 通过聚合包 `@logosw/hls-downloader` 安装后，`@logosw/hls-downloader/adapters/rust` 也可正常 import

## 正式发布

完成“首次冷启动”后，再触发 GitHub Actions 的 `Publish to npm` workflow。
