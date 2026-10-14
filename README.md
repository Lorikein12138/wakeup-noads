# wakeup-noads

WakeUp 课程表的非官方精简版：去除广告，只保留课表相关功能。

## 简介

本项目基于官方 WakeUp 课程表 APK 打补丁，去掉广告、账号、云同步等与课表无关的功能，保留本地课表管理、高校教务导入、提醒和桌面小组件。

每个版本的具体改动见 [Releases](https://github.com/Lorikein12138/wakeup-noads/releases) 中的「更新内容」。

本项目由社区独立维护，与 WakeUp 原应用开发者及运营方没有隶属或合作关系。

## 下载与安装

1. 在 [Releases](https://github.com/Lorikein12138/wakeup-noads/releases) 下载最新正式版 APK。
2. 核对 APK 的 SHA-256 与 Release 中「版本信息」一致。
3. 安装前请先备份课表等重要数据。

- 系统要求：Android 7.0 及以上。
- 包名为 `io.github.wakeupnoads`，可与官方 App 同时安装，两者数据互不共享。

## 问题反馈

请通过 [Issues](https://github.com/Lorikein12138/wakeup-noads/issues) 反馈，并写明：

- 机型、Android 版本、应用版本；
- 操作步骤、实际表现和期望表现；
- 应用崩溃或异常退出时，请附上「我的 → 本地日志」中导出的日志。

请勿在 Issue、截图或日志中提交密码、Cookie、Token、验证码或个人教务信息。

## 源码构建

### 仓库结构

| 目录 | 内容 |
|---|---|
| `patches/` | 补丁规格、包名配置及工具链锁定文件 |
| `runtime/` | 注入应用的 Java 运行时代码（如本地日志） |
| `scripts/` | 构建、测试和签名脚本 |
| `tests/` | 补丁与运行时测试 |

### 环境

- Windows、PowerShell 7
- JDK 与 Node.js（已用 JDK 25、Node.js 24 验证）

### 准备输入文件

以下文件不在仓库中，需要自行准备，放到对应路径。构建脚本会按 `patches/slim-v1/toolchain-lock.json` 校验每个文件的 SHA-256，不一致时停止。

| 文件 | 路径 |
|---|---|
| 官方 WakeUp 课程表 6.5.4 APK | `baseline/wakeup-v6.5.4.apk` |
| Apktool 3.0.3 | `tools/apktool-3.0.3/apktool_3.0.3.jar` |
| Apktool 框架文件 | `tools/_cache/apktool/1.apk` |

框架文件由 Apktool 首次解包时自动生成：

```powershell
java -jar tools/apktool-3.0.3/apktool_3.0.3.jar d -s -p tools/_cache/apktool -o <临时目录> baseline/wakeup-v6.5.4.apk
```

Android Build Tools 35.0.0 会在首次构建时由脚本从 Google 官方地址下载到 `tools/` 下，并按锁定的 SHA-256 校验。

### 构建

```powershell
pwsh scripts/build.ps1 -Mode Unsigned -NodePath <node.exe 路径> -JavaHome <JDK 目录>
```

产物为未签名 APK，位于 `tools/_cache/slim-v1-build/unsigned/versionCode-<N>/`，需要用自己的密钥签名后才能安装。用不同密钥签名的 APK 无法覆盖安装本项目发布的正式版。

### 测试

```powershell
pwsh scripts/test.ps1 -Suite <套件名> -NodePath <node.exe 路径> -JavaHome <JDK 目录>
```

可用的套件名见 `scripts/test.ps1` 的 `-Suite` 参数。

## 免责声明

本项目不是 WakeUp 课程表的官方发行物，不代表原应用开发者、运营方、高校或其他第三方的立场。原应用的名称、商标、代码、界面、素材及第三方组件的相关权利归各自权利人所有，本仓库不授予任何额外的使用或再分发权利。

本项目按现状提供，不对可用性、兼容性、数据完整性、隐私或安全性作任何保证。请自行判断是否适合使用，并在安装或升级前备份数据。

高校课表导入需要访问所选学校的教务系统，账号、验证码和课表数据的处理取决于高校系统，本项目无法控制。请谨慎输入账号凭据，并遵守相关服务条款和规定。
