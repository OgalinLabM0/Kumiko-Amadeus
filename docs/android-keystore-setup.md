# Android 发布签名 keystore 配置指南

> 一次性配置。配完之后 GitHub Actions 自动用同一个 keystore 签所有未来的 Android APK，
> 用户安装新版本不用先卸载旧版，沙箱数据（IndexedDB / Capacitor Filesystem / LocalStorage）全部保留。
>
> 适用版本：v2.14.4 起。

---

## 为什么要做这件事

v2.14.3 及之前，Android workflow 跑的是 `assembleDebug`，签名用的是 AGP 自动生成的 `~/.android/debug.keystore`。
这个 debug keystore **每次 CI 跑都不一样**，所以你新打的 APK 和旧的不是同一个签名证书。
Android 拒绝在不同签名证书之间做 in-place 升级（错误码 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，
界面上显示「应用已存在 / 包冲突」），强制你卸载旧版才能装新版。
卸载会清空整个沙箱：聊天记录、图片、语音、设置全没了——除非你手动导出过 ZIP。

修完之后：

- 你本机生成一个**永久不变**的 release keystore（`kumiko-release.keystore`）。
- keystore 的二进制 + 三个密码以**加密 GitHub Secret** 的形式存在仓库里。
- CI 跑的时候自动解码、签名、产出 `Kumiko-Amadeus-2.14.x-universal.apk`（无 `-debug` 后缀）。
- 用户从 v2.14.4 起，每次升级都是 in-place upgrade，沙箱从此再也不丢。

代价：v2.14.3 → v2.14.4 是**最后一次必须卸载重装**（因为 v2.14.3 是 debug 签名，v2.14.4 是 release 签名，
两边不可能匹配）。从 v2.14.4 → v2.14.5 → … 全部 in-place。

---

## 第 0 步：你需要什么

- 一台能运行 `keytool` 的电脑（任何安装了 JDK 17+ 的环境都行，包括你打 APK 的那台 Windows 机）。
  - 验证：在 PowerShell 里跑 `keytool -h`。如果命令找不到，先确认 JDK 已装、`JAVA_HOME` 指向 JDK 目录、`%JAVA_HOME%\bin` 在 PATH 里。
- 这个 GitHub 仓库的 **管理员**权限（添加 Secrets 需要）。
- 一个**永久离线**的备份位置（U 盘、家里 NAS、密码管理器附件、加密云盘随便选），用来保管 keystore 原件。
  > **极端重要**：这个 keystore 是你这个 Android 应用的**唯一身份证**。
  > 一旦丢失，下一个版本就再也无法被现有用户 in-place 升级——所有人都要卸载重装、重新设置、丢数据。
  > Google Play 也不允许换 keystore（除非你提前注册了 Play App Signing；侧加载分发就更没救了）。
  > 把它当传家宝放好，比备份代码重要得多。

---

## 第 1 步：生成 keystore

在 PowerShell（或 cmd / bash 都可以）里跑下面这条命令，**只跑一次，永远不再生成第二次**：

```powershell
keytool -genkeypair `
  -v `
  -keystore kumiko-release.keystore `
  -alias kumiko `
  -keyalg RSA `
  -keysize 4096 `
  -validity 36500 `
  -storetype PKCS12
```

参数解释：

| 参数 | 含义 | 备注 |
| --- | --- | --- |
| `-keystore kumiko-release.keystore` | keystore 文件名 | 文件会生成到当前目录 |
| `-alias kumiko` | 密钥别名 | 必须和 `build.gradle` 里 `KEY_ALIAS` 默认值一致；改了的话 Secret 也要同步改 |
| `-keyalg RSA -keysize 4096` | 加密算法 + 长度 | 4096 位是 2026 年的稳健选择 |
| `-validity 36500` | 有效期（天） | 100 年 = 你彻底不用考虑续期 |
| `-storetype PKCS12` | 容器格式 | JDK 9+ 默认值，跨平台、可在 Linux runner 直接读 |

跑到一半 `keytool` 会问你五个问题：

```
Enter keystore password:                     ← 输入一个强密码（建议 16+ 字符），按回车，再次输入确认
Re-enter new password:                       ← 同上
What is your first and last name? [Unknown]:    ← 比如 Kumiko Maintainer
What is the name of your organizational unit?:  ← 留空回车（或 Personal）
What is the name of your organization?:         ← Personal
What is the name of your City or Locality?:     ← 你所在城市的拼音/英文（北京 → Beijing）
What is the name of your State or Province?:    ← 你所在省份
What is the two-letter country code for this unit? [Unknown]: CN     ← 中国 CN，美国 US，日本 JP，依此类推
Is CN=Kumiko Maintainer, OU=, O=Personal, L=Beijing, ST=Beijing, C=CN correct? [no]: yes
```

最后会问 key password：

```
Enter key password for <kumiko>
        (RETURN if same as keystore password):
```

**直接按回车**让两个密码相同（最简单的情形——`build.gradle` 也默认 `KEY_PASSWORD` fallback 到 `KEYSTORE_PASSWORD`）。
如果你坚持两个密码分开，记好两个，后面 Secret 设置也要分别填。

跑完之后当前目录会多一个 `kumiko-release.keystore` 文件（大小通常 3-5 KB）。

> **马上备份这个文件**：复制到至少两个不同物理位置（U 盘 + 加密云盘 / 密码管理器附件 / 离线 NAS）。
> 文件本身已经被 keystore 密码加密，但**密码绝对不要**和文件存同一个位置——分开存才有意义。

### 验证你的 keystore 没问题

```powershell
keytool -list -v -keystore kumiko-release.keystore
```

输入密码后应该看到：

```
Alias name: kumiko
Creation date: ...
Entry type: PrivateKeyEntry
Certificate chain length: 1
Certificate[1]:
Owner: CN=...
Issuer: CN=...
...
Signature algorithm name: SHA384withRSA
Subject Public Key Algorithm: 4096-bit RSA key
Version: 3
```

`Entry type: PrivateKeyEntry` 是关键——说明它能签名而不是只能读。
`SHA256withRSA` / `SHA384withRSA` 都正常，`MD5withRSA` 不正常（如果是后者请重新生成）。

---

## 第 2 步：把 keystore 编码成 base64

GitHub Secret 只能存文本，所以要把二进制 keystore 编成 base64。

在 PowerShell 里：

```powershell
$bytes = [System.IO.File]::ReadAllBytes("kumiko-release.keystore")
[System.Convert]::ToBase64String($bytes) | Set-Clipboard
Write-Host "Base64 已复制到剪贴板，长度=$([System.Convert]::ToBase64String($bytes).Length) 字符"
```

或者写到文件：

```powershell
$bytes = [System.IO.File]::ReadAllBytes("kumiko-release.keystore")
[System.Convert]::ToBase64String($bytes) | Set-Content -Path keystore.b64 -NoNewline
```

> **`-NoNewline` 千万别忘**：尾部带换行的 base64 在某些 base64 解码器里不会报错，
> 但会让解码后的二进制末尾多 1 字节，被 keytool 拒绝。

### Linux / macOS 等价命令

```bash
base64 -w0 kumiko-release.keystore > keystore.b64
# macOS 的 base64 没有 -w0，用：
base64 -i kumiko-release.keystore -o keystore.b64
```

---

## 第 3 步：在 GitHub 仓库添加 4 个 Secret

打开仓库的 **Settings → Secrets and variables → Actions → New repository secret**，
依次添加下面这 4 个（名字必须**一字不差**）：

| Secret Name | 值 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 第 2 步剪贴板里的 base64 字符串（一坨长长的字母数字+/=） |
| `ANDROID_KEYSTORE_PASSWORD` | 第 1 步设的 keystore 密码 |
| `ANDROID_KEY_ALIAS` | `kumiko`（如果第 1 步改了 alias 这里写改后的） |
| `ANDROID_KEY_PASSWORD` | 第 1 步设的 key 密码（如果你按回车让两边相同，这里和 `ANDROID_KEYSTORE_PASSWORD` 一样） |

**校验小技巧**：

- `ANDROID_KEYSTORE_BASE64` 的长度通常是几千字符。如果只有 100 多字符，肯定弄错了（可能复制了文件路径而不是文件内容）。
- 4 个 Secret 都加完后，仓库的 Secrets 列表里应该看到这 4 个名字（GitHub 不会显示值，只显示名字）。

---

## 第 4 步：跑一次 workflow 验证

打开仓库的 **Actions → Android APK Release build → Run workflow**，
`publish` 选 `false`（先不发布到 Release，只生成 artifact 验证），点 Run。

跑完之后看 workflow log：

- **第 5 步「Detect release-keystore secret + decode」** 应该输出 `Decoding release keystore from secret… signed=true`。
  - 如果输出 `signed=false`，说明 Secret 没读到——回去检查 Secret 名字拼写。
- **第 6 步「Build universal APK」** 应该说 `Running assembleRelease (signed with stable release keystore).`
- **第 7 步「Verify APK exists + show size」** 应该找到 `app-release.apk`。
- **第 8 步「Rename APK」** 应该输出 `Kumiko-Amadeus-2.14.x-universal.apk`（**没有 `-debug` 后缀**）。
- 最后下载 artifact 里的 APK，装到一台没装过 v2.14.4 的设备上验证可以正常启动。

下次发版时，`publish` 选 `true`，APK 会自动挂到 GitHub Release 上。

---

## 第 5 步：本机文件该放哪

|文件|放哪|是否同步到 GitHub|
| --- | --- | --- |
|`kumiko-release.keystore`|**至少两个**离线/加密备份位置（U 盘、密码管理器附件、加密 NAS）|**绝对不能**|
|`keystore.b64`|本机临时文件，复制到 Secret 后**立刻删除**|绝对不能|
|keystore 密码 + key 密码|密码管理器（1Password / Bitwarden / KeePass 等）|绝对不能|

`.gitignore` 已经把 `*.keystore` / `*.jks` / `keystore.b64` 都拦住了（v2.14.4 H.4），但你**自己也要小心**：
不要把 keystore 拖进项目目录，不要在公开聊天/截图里贴密码，不要让 AI agent 直接看 keystore（agent 给你打 APK 不需要 keystore，CI 才需要）。

> **AI agent 隔离原则**：本仓库的代码 agent（Cursor / Claude / Codex 等）**永远不需要、也不应该接触 keystore 二进制和密码**。
> Agent 帮你写 build.gradle 和 workflow，CI 在 GitHub 服务器上读 Secret 签名，agent 端的本机环境完全不需要 keystore。
> 任何让 agent 「也帮你保管一份 keystore」的提议都应该拒绝——
> 越少地方存敏感凭据，泄漏的概率越低。

---

## 第 6 步：换电脑/换 CI 平台时怎么办

只要 Secret 还在 GitHub 仓库里，CI 就能继续签新 APK，**和你本机有没有 keystore 完全无关**。

但你本地：

- 想用 Android Studio 的 `Build → Generate Signed Bundle / APK` 出一个本地签名的 release APK？需要本机有 keystore + 知道密码。
- 平时在 Android Studio 里点 Run（debug 调试）？不需要 keystore（用 AGP 自动生成的 debug.keystore）。

所以**本机保不保留 keystore 副本，看你需不需要本地出可发布的 release 包**。多数情况下 CI 出包就够了，本机不必常驻 keystore——
有需要时从离线备份里拷过来用一次，用完删掉。

---

## 常见问题排查

### Q1: workflow 里 `signed=true`，但 gradle 报 `Keystore was tampered with, or password was incorrect`

→ `ANDROID_KEYSTORE_PASSWORD` Secret 写错了。重新打开仓库 Settings → Secrets，删掉重建。

### Q2: gradle 报 `Failed to read key kumiko from store: Get Key failed`

→ `ANDROID_KEY_ALIAS` 或 `ANDROID_KEY_PASSWORD` 不对。
确认 alias 是 `kumiko`（小写），key password 和你第 1 步生成时输入的一致。

### Q3: workflow 里 `Decoded keystore is empty`

→ 你存到 Secret 的 base64 字符串末尾有换行/空格，导致解码失败。重做第 2 步，确认 `-NoNewline`，重新粘贴 Secret。

### Q4: 装 v2.14.4 APK，Android 还是报「应用已存在」

→ 设备上残留的 v2.14.3 是 debug 签名，无法 in-place 升级。
**先备份 ZIP**（设置 → 备份 & 恢复 → 导出 ZIP），卸载旧版，装新版，再导入 ZIP。
这是最后一次必须卸载，之后所有 v2.14.4 → v2.14.5 → … 都不再需要卸载。

### Q5: 我把 keystore 弄丢了 / 密码忘了

→ 没救。下一版必须用一个**新的 keystore**重新发布，而所有现有用户都需要卸载 + 重装 + 丢数据。
再次强调：**这个 keystore 是 Android 应用身份证**，备份原件 + 离线密码，认真保管。

---

## 附：build.gradle 和 workflow 的对接关系

```
┌────────────────────────────┐         ┌─────────────────────────────────┐
│ GitHub Repo Secrets        │         │ android-apk-release.yml         │
│ ─────────────────────────  │  decode │ ─────────────────────────────── │
│ ANDROID_KEYSTORE_BASE64    │ ───────►│ release.keystore (binary)       │
│ ANDROID_KEYSTORE_PASSWORD  │ ───────►│ env.KEYSTORE_PASSWORD           │
│ ANDROID_KEY_ALIAS          │ ───────►│ env.KEY_ALIAS                   │
│ ANDROID_KEY_PASSWORD       │ ───────►│ env.KEY_PASSWORD                │
└────────────────────────────┘         └────────────┬────────────────────┘
                                                    │ ./gradlew assembleRelease
                                                    ▼
                                       ┌─────────────────────────────────┐
                                       │ android/app/build.gradle        │
                                       │ ─────────────────────────────── │
                                       │ signingConfigs.release {        │
                                       │   storeFile env(KEYSTORE_FILE)  │
                                       │   storePassword env(...)        │
                                       │   keyAlias env(KEY_ALIAS)       │
                                       │   keyPassword env(KEY_PASSWORD) │
                                       │ }                               │
                                       │ buildTypes.release {            │
                                       │   signingConfig signingConfigs  │
                                       │     .release                    │
                                       │ }                               │
                                       └─────────────────────────────────┘
```
