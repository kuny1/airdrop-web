/**
 * 网络与操作系统那一侧的四件小事：局域网地址、端口探测、私网判定、打开文件管理器。
 *
 * 单独成文的理由：这四件里有三件是**平台相关**的，其余代码不该被 `process.platform`
 * 的分支污染。收件箱与路由都只跟这里的纯函数打交道。
 */
import { createServer } from 'node:http';
import { networkInterfaces, platform } from 'node:os';
import { execFile } from 'node:child_process';

/**
 * 局域网 IPv4 地址 —— 手机要访问的就是这个。
 *
 * 先按 en0/en1/en2 找（macOS 上 Wi-Fi 与有线的常见名字），再退回第一个非回环 IPv4。
 * 顺序是承载性的：一台机器上常有 Docker / VPN 的虚拟网卡，它们的地址手机连不上，
 * 而 `networkInterfaces()` 不保证顺序，所以不能直接拿第一个。
 */
export function lanAddress() {
  const ifs = networkInterfaces();
  for (const name of ['en0', 'en1', 'en2', 'wlan0', 'eth0']) {
    for (const a of ifs[name] ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  for (const list of Object.values(ifs)) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

/** 端口是否已被占用。只做 listen 试探，不做协议握手。 */
function taken(port, host) {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', e => resolve(e.code === 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, host);
  });
}

/**
 * 从 `from` 开始找第一个空闲端口。
 *
 * CLI 不能因为 5199 被占就死掉 —— 但也不能静默漂移到一个用户不知道的端口，
 * 所以返回值由调用方打印出来。显式指定了端口（`--port`）时不该走这里：
 * 那种情况下占用是个要报出来的事实，不是要绕开的障碍。
 */
export async function freePortFrom(from, host, span = 20) {
  for (let p = from; p < from + span; p++) if (!(await taken(p, host))) return p;
  throw new Error(`${from}–${from + span - 1} 之间没有空闲端口`);
}

/**
 * 请求来源是否在私有网段内（RFC1918 + 链路本地 + 回环）。
 *
 * 这不是鉴权，是**收缩暴露面**：服务必须绑 0.0.0.0 手机才连得上，而绑了 0.0.0.0
 * 之后，如果这台机器恰好有公网地址或被端口转发，收件箱就对整个互联网开着。
 * 拦掉非私网来源几乎零成本，且不影响任何正常用法。
 * 同一个局域网里的其他人仍然能访问 —— 那需要口令，本工具没做，见 README。
 */
export function fromPrivateNetwork(remote) {
  if (!remote) return false;
  const ip = remote.replace(/^::ffff:/, '');
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254);
}

/**
 * 请求是否来自本机（回环）。
 *
 * 这是读写分权的那把尺子：PC 页永远走 127.0.0.1，而手机走局域网地址。
 * 所以「读收件箱」这件事可以只对回环开放，正常使用一点不受影响 ——
 * 手机页只用 upload / text / info 三个接口（grep 过 phone.html）。
 */
export function fromLoopback(remote) {
  if (!remote) return false;
  const ip = remote.replace(/^::ffff:/, '');
  return ip === '::1' || ip === '127.0.0.1' || ip.startsWith('127.');
}

/**
 * 交给系统去打开一个目录或 URL。失败不抛 —— 这是个便利动作，不是流程的一环。
 * 一个动作打不开，用户手里还有那条打印出来的地址。
 */
export function openExternal(target) {
  const [cmd, args] = { darwin: ['open', [target]], win32: ['explorer', [target]] }[platform()]
                   ?? ['xdg-open', [target]];
  execFile(cmd, args, () => {});
}

/** 在系统文件管理器里打开"保存到电脑"的目录。 */
export const revealDir = openExternal;

/** 本机是否能用 sips 生成缩略图（macOS 自带）。别的平台直接发原图。 */
export const canThumbnail = platform() === 'darwin';
