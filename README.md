# airdrop-web

局域网收件台。手机浏览器扫码，把照片、视频、文件、一段文字传到这台电脑；
电脑上以相册式网格看到它们，能直接预览，也能一键落盘。

零运行时依赖，一个 Node 进程，两个页面同一个端口。

```bash
node bin/airdrop.mjs
# 或 npm i -g . 之后
airdrop
```

起好之后终端会打出 PC 地址、手机地址和一个可以直接扫的二维码。

## 命令面

```
airdrop [选项]

  -p, --port <n>      端口，默认 5199。不指定时被占用会自动往后找；
                      显式指定时被占用直接报错。
      --host <addr>   监听地址，默认 0.0.0.0（绑回环手机就连不上）
      --dir <path>    收件箱目录，默认各平台缓存目录下的 airdrop-web/
      --save-dir <p>  “保存到电脑”的落点，默认 ~/Downloads/AirDropWeb
      --open          起好之后在浏览器里打开 PC 页
      --no-qr         不在终端打印二维码
      --lan-read      允许局域网设备读收件箱。默认只有本机能读，局域网只能往这里传
      --allow-public  取消“只接受局域网来源”的限制（见下方安全一节）
  -h, --help          用法
```

端口是两条不同的路，不是一条带兜底的路：**没指定**端口意味着「给我个能用的」，被占就往后找；
**指定了**端口意味着「就要这个」，被占是要报出来的事实。

## 接入 aqua

`aqua` 的命令面是 `bin/aqua.mjs` 里一个手写的 `switch`，没有插件自动发现，
所以接入就是加一个 `case` 和一条动态 `import` —— 与 `build` / `deploy` 同一个形状：

```js
// packages/cli/bin/aqua.mjs
case 'airdrop': {
  const { runAirdrop } = await import('airdrop-web');
  await run(() => runAirdrop({ argv: rest }), null);
  break;
}
```

`usage()` 里加一行：

```
  aqua airdrop            起局域网收件台，手机扫码传文件到本机
```

以及 `packages/cli/package.json` 的 `dependencies` 加 `"airdrop-web": "workspace:*"`
（或 `file:` / 发布后的版本号）。

### 为什么不需要 workspace 解析

`aqua dev` / `build` / `deploy` 都要先 `resolveWorkspace()` 定位物料树（R18）。
`airdrop` **不落在那条路上**：它跟物料、环境、存储都没关系，只跟「我这台机器的局域网地址」有关。
所以它不该走 `where()`，也不该因为用户没站在物料目录里就拒绝启动。

### 两个导出，对应两种用法

```js
import { runAirdrop, startAirdrop } from 'airdrop-web';

// 1) 接管进程：解析 argv、打横幅、守着 Ctrl-C，直到服务停下才 resolve
await runAirdrop({ argv: ['--port', '5199'] });

// 2) 不接管进程：起服务、把地址交回来，宿主自己管生命周期
const h = await startAirdrop({ port: 5199 });
console.log(h.phoneUrl);   // http://10.10.50.115:5199/m
await h.stop();
```

想跟 `aqua dev` 并行跑（一边开发物料、一边从手机丢素材进来）就用 `startAirdrop`，
把 `h.stop()` 挂到 dev 的收尾里。

## 安全

服务绑 `0.0.0.0` —— 这不是可选的，绑回环手机就连不上。所以暴露面靠**分权**收缩，不靠口令。

### 读写分权（默认开着）

局域网只能**往这里传**；收件箱的读取与管理只对本机（`127.0.0.1`）开放。

| 局域网可达 | 只对本机开放 |
|---|---|
| `GET /m` 手机页 | `GET /` PC 页（局域网访问会 302 到 `/m`） |
| `GET /api/info`（只回 `host`） | `/api/files`、`/api/incoming`、`/api/events` |
| `POST /api/upload` | `/file/:id`、`/thumb/:id` |
| `POST /api/text` | `/api/save`、`/api/delete`、`/api/reveal`、`/vendor/*` |

这道闸对正常使用是**零成本**的：手机页只用左列那三个接口（从 `phone.html` 里 grep 得到，
不是推测），而 PC 页永远走 `127.0.0.1`。顺带的好处是 `pc.html` 整份应用代码也不再发给局域网。

**`--lan-read` 可以放开**，用于从局域网里另一台电脑看收件箱 —— 那会把暴露面退回“网内任何人
都能读、下载、删除”，横幅的措辞会跟着变。

### 仍然存在的缺口

**没有口令。局域网内任何人都能往你这儿推文件**（`/api/upload`、`/api/text` 必须对局域网开放，
否则手机传不了）。这是骚扰，不是泄露 —— 但在公共 Wi-Fi、会议室网络、或任何你不认识网内
其他机器的地方，别开着。要堵这一层需要真的口令校验（二维码里带 token + 首次落 cookie），
目前没做。

### 自己复核暴露面

```bash
IP=$(curl -s 127.0.0.1:5199/api/info | python3 -c 'import json,sys;print(json.load(sys.stdin)["ip"])')

curl -s -o /dev/null -w '%{http_code}\n' "http://$IP:5199/api/files"   # 期望 403
curl -s -o /dev/null -w '%{http_code}\n' "http://$IP:5199/"            # 期望 302 → /m
curl -s "http://$IP:5199/api/info"                                      # 期望只有 {"host":…}
curl -s -o /dev/null -w '%{http_code}\n' "http://$IP:5199/m"           # 期望 200（手机页要能开）
```

拿到 200 而不是 403，说明分权没生效（或者开了 `--lan-read`）。

### 其它

- 默认只接受**私有网段**来源的请求（10/8、172.16/12、192.168/16、169.254/16、回环、
  IPv6 链路本地与 ULA）。这不是鉴权，是收缩暴露面：万一这台机器有公网地址或被端口转发，
  收件箱不会对整个互联网开着。`--allow-public` 可以关掉。
- 静态资源只从 `src/ui/` 下发，两道闸：路径解析后必须仍在 `ui/` 内，且扩展名必须在 MIME 表里
  （没登记的类型不发，所以 vendor 下的说明与许可文件不会被公开）。
- 文件名落盘前去掉路径分隔符与开头的点；`/file/:id` 只按元数据表里的 id 查，不接受路径。

## 目录

```
bin/airdrop.mjs      独立入口：argv → runAirdrop，用户能自己修的错误打一行消息
src/index.mjs        编程入口、参数解析、终端横幅与二维码
src/server.mjs       HTTP 路由与 SSE 推送
src/inbox.mjs        收件箱：落盘、元数据、缩略图、保存到电脑
src/lan.mjs          局域网地址、端口探测、私网判定、打开文件管理器
src/ui/pc.html       PC 网格收件台
src/ui/phone.html    手机上传页
src/ui/vendor/       第三方（qrcodejs，MIT）+ 三处补丁说明，见其中的 README
```

## HTTP 面

| 方法 | 路径 | 局域网 | 说明 |
|---|---|---|---|
| GET | `/` | 302→`/m` | PC 网格页 |
| GET | `/m` | ✓ | 手机上传页 |
| GET | `/api/info` | 只回 `host` | 主机名、局域网地址、端口、收件箱与落点目录 |
| GET | `/api/files` | ✗ | 已到达的文件，最新在前 |
| GET | `/api/incoming` | ✗ | 正在接收中的上传（给传输过程中刷新页面的人补齐） |
| GET | `/api/events` | ✗ | SSE：`incoming` `progress` `added` `update` `saved` `removed` `failed` |
| POST | `/api/upload` | ✓ | 裸 body 上传，文件名与类型走 `X-Filename`（URL 编码）、`X-Mime` |
| POST | `/api/text` | ✓ | `{ text }`，落成 .txt |
| GET/HEAD | `/file/:id` | ✗ | 原文件，支持 Range；`?dl=1` 走附件下载 |
| GET/HEAD | `/thumb/:id` | ✗ | 缩略图，没有则回原图 |
| POST | `/api/save` | ✗ | `{ ids }` 复制到落点目录，同名自动加序号 |
| POST | `/api/delete` | ✗ | `{ ids }` 从收件箱移除并删盘 |
| POST | `/api/reveal` | ✗ | 在系统文件管理器里打开落点目录 |

「局域网」一列是默认配置；`--lan-read` 会把所有 ✗ 变成可达。

进度由**服务端**字节计数广播，不是手机端上报：PC 上要看的是「已落盘多少」，
而不是「手机已发出多少」。

## 已知限制

- 缩略图用 macOS 自带的 `sips`。别的平台不生成，直接发原图 —— 网格照样能看，只是费带宽。
- 只有手机 → PC 一个方向。
- 没有口令，局域网内任何人都能往你这儿推文件（见上方安全一节）。
- 没有设备身份概念：两台手机同时传，PC 上看不出哪个文件来自谁。
- 收件箱会一直留着文件，需要自己在 PC 页上删，或清空 `--dir` 指的目录。
