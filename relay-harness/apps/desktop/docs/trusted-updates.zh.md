# 可信桌面更新

[English](trusted-updates.md) | 中文

## Availability

自动安装要求已打包的 Windows x64 构建，并显式配置发布者签名信任来源。本 checkout 没有更新公钥或发行来源配置；更新器返回 `unavailable`，不下载或执行安装器。macOS、其他架构、开发态启动和预发布版本没有受支持的安装协议。项目 Releases 链接只是信息入口，不代表此构建能够自更新。

## Build authority

已安装桌面的 `package.json` 拥有可选 `desktopUpdate` 元数据：`schemaVersion: 1`、等于 `build.appId` 的 `productId`、发布者控制的 `owner/repository` 形式的 `repository`，以及 PEM 编码的 Ed25519 `publicKey`。`build.nsis.artifactName` 提供精确安装器命名模板，只替换版本、扩展名和架构。Renderer IPC 不接受信任配置、安装器 URL 或公钥。实际发布者公钥与发行流程由部署方配置；私钥绝不进入应用或仓库。

## Signed release protocol

配置仓库的最新稳定 GitHub release 包含 `relay-desktop-update.v1.json`、其独立 Base64 Ed25519 签名 `relay-desktop-update.v1.json.sig`，以及安装器。签名覆盖 manifest 的精确 UTF-8 字节，而不是解析或重新序列化的对象。更新器先验签，再解析 JSON。

Manifest 声明 `schemaVersion: 1`、绑定的 `productId`、严格稳定的 `major.minor.patch` 版本、精确 release `tag`、ISO 到期时间 `expiresAt` 与 `artifacts` 数组。必须恰好有一个 artifact 匹配 Windows `win32`、架构 `x64` 与安装器 `kind: "nsis"`；它包含 `name`、正整数 `size` 字节数和小写 64 字符 `sha256`。文件名必须匹配本产品的 NSIS 构建模板。已签名 manifest 证明发布者身份，其摘要把签名绑定到完整安装器字节。未签名的 GitHub release 正文或任意资产均不构成执行依据。

每个初始资产 URL 必须匹配此仓库、签名 tag 与精确资产名。重定向保持 HTTPS，不含嵌入式凭据或其他端口，仅使用固定 GitHub API/下载主机，最多五次。Release 元数据上限为 1 MiB，manifest 为 256 KiB，签名为 1 KiB，安装器为 512 MiB。元数据传输总时限为 30 秒；流式安装器传输总时限为十分钟，均包含重定向。

重定向会先退役并销毁当前响应和请求，再打开下一跳。超时会关闭准入：迟到的响应回调不能启动新请求，已退役跳转的错误不能取消后继请求。

## Installation commit

安装先重新执行签名检查，仅在 `available` 时继续。同版或旧版不下载安装器。私有唯一临时目录通过独占文件句柄接收非可执行扩展名的 `.part` 文件，流式限制大小、计算摘要并 fsync。只有精确匹配签名大小与摘要才通过。原子重命名为安装器文件名并启动进程之前，再次检查签名、到期时间、平台、已打包状态与当前版本。验证或启动失败会清除临时资产。并发安装请求共享一次操作，每个进程最多启动一次安装器。

设置 About 页面在 `unavailable`、`none` 与 `current` 状态禁用安装，即使仍存在过期 URL。安装时的验证失败会明确显示，不会永久停留在下载指示器。UI 检查只是补充，不能替代主进程验证。

## Verification boundary

离线测试生成临时测试密钥并使用假的安装器启动器，覆盖签名、产品/tag/平台/架构绑定、版本回退、下载前后到期、摘要和字节上限、清理、重定向策略、时限与重复安装。这些测试不等于已验证实际发布者配置、真实签名发行版本或操作系统安装过程。
