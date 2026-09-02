/**
 * `airdrop` 的编程入口与命令行入口。
 *
 * 两个导出，对应两种被调用的方式：
 *
 *   - `startAirdrop(opts)` —— 起服务、把地址交回来，**不接管进程**。
 *     宿主（比如 aqua dev）要在自己的生命周期里带着它跑时用这个。
 *   - `runAirdrop({ argv })` —— 解析命令行、打横幅、守着 Ctrl-C，直到服务停下才 resolve。
 *     `aqua airdrop` 与 `npx airdrop` 都走这个。
 *
 * 端口策略是两条不同的路，不是一条带兜底的路：**没指定**端口意味着"给我个能用的"，
 * 被占就往后找；**指定了**端口意味着"就要这个"，被占是要报出来的事实，不是要绕开的障碍。
 */
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createAirdropServer } from './server.mjs';
import { freePortFrom, openExternal } from './lan.mjs';

export const DEFAULT_PORT = 5199;

/**
 * 收件箱的默认位置：各平台的缓存目录。
 *
 * 不放 `~/Downloads`：那是"保存到电脑"的落点，收件箱混进去就分不清"传过来的"和"我留下的"。
 * 也不放 `os.tmpdir()`：重启就没了，而收件台的用法本来就是"先传过来，回头再挑"。
 */
export function defaultInboxDir() {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Caches', 'airdrop-web');
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA ?? tmpdir(), 'airdrop-web');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'airdrop-web');
}

export const defaultSaveDir = () => join(homedir(), 'Downloads', 'AirDropWeb');

export const USAGE = `
airdrop —— 局域网收件台。手机扫码传文件到这台电脑。

  airdrop [选项]

  -p, --port <n>      端口，默认 ${DEFAULT_PORT}。不指定时被占用会自动往后找；
                      显式指定时被占用直接报错。
      --host <addr>   监听地址，默认 0.0.0.0（绑回环手机就连不上）
      --dir <path>    收件箱目录，默认各平台缓存目录下的 airdrop-web/
      --save-dir <p>  "保存到电脑"的落点，默认 ~/Downloads/AirDropWeb
      --open          起好之后在浏览器里打开 PC 页
      --no-qr         不在终端打印二维码
      --lan-read      允许局域网设备读收件箱。默认只有本机能读，局域网只能往这里传
      --allow-public  取消"只接受局域网来源"的限制（默认开着，见 README 安全一节）
  -h, --help          这段话
`.trim();

/** 命令行参数 → 选项。认不出的参数要报错：静默忽略一个打错的 flag 比报错更难查。 */
export function parseArgs(argv = []) {
  const o = { qr: true, open: false, privateOnly: true };
  const need = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) throw new Error(`${name} 后面要跟一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-p': case '--port': {
        const n = Number(need(i++, a));
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`端口不合法：${argv[i]}`);
        o.port = n; break;
      }
      case '--host':      o.host = need(i++, a); break;
      case '--dir':       o.dir = need(i++, a); break;
      case '--save-dir':  o.saveDir = need(i++, a); break;
      case '--open':      o.open = true; break;
      case '--no-qr':     o.qr = false; break;
      case '--lan-read':  o.lanRead = true; break;
      case '--allow-public': o.privateOnly = false; break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`不认识的参数：${a}`);
    }
  }
  return o;
}

/**
 * 起服务并把地址交回来。不打印、不注册信号处理 —— 那些是 `runAirdrop` 的事。
 * @returns {Promise<Awaited<ReturnType<typeof createAirdropServer>>>}
 */
export async function startAirdrop(opts = {}) {
  const host = opts.host ?? '0.0.0.0';
  // `port` 给了就照给的来（占用是要报出来的事实）；没给就从默认端口往后找一个空闲的
  const port = opts.port ?? await freePortFrom(DEFAULT_PORT, host);
  return createAirdropServer({
    port, host,
    dir: opts.dir ?? defaultInboxDir(),
    saveDir: opts.saveDir ?? defaultSaveDir(),
    privateOnly: opts.privateOnly ?? true,
    lanRead: opts.lanRead ?? false,
  });
}

/**
 * 终端里的二维码。
 *
 * 值得这几行的理由：这是个"拿手机扫一下"的工具，而 CLI 的用户此刻正看着终端 ——
 * 让他先去浏览器里找二维码，等于把最短的那条路绕开了。
 *
 * 画不出来时返回 `{ error }`，**不静默返回 null**。二维码是这个工具最短的那条路，
 * 悄悄少一块没人会发现 —— vendor 文件被改坏过一次就是这么溜过去的（见
 * src/ui/vendor/README.md 的三处补丁）。让失败在每次启动时都露出来。
 */
function terminalQR(text) {
  try {
    // qrcodejs 的 `QRCode` 构造器要 DOM；终端只要模块矩阵，所以用 vendor 补丁暴露出来的
    // 编码器本体（见 src/ui/vendor/README.md）。它也没有 ASCII 输出，下面自己画。
    const QRCode = createRequire(import.meta.url)('./ui/vendor/qrcode.js');
    const level = QRCode.CorrectLevel.M;
    const qr = new QRCode.Model(QRCode.typeNumberFor(text, level), level);
    qr.addData(text);
    qr.make();

    const n = qr.getModuleCount();
    const QUIET = 2;                                  // 静区。纸面规范是 4 格，屏幕上 2 格够扫
    const size = n + QUIET * 2;
    const dark = (r, c) => r >= QUIET && r < QUIET + n && c >= QUIET && c < QUIET + n
                        && qr.isDark(r - QUIET, c - QUIET);

    /**
     * 半格块：一行字符承载两行模块，二维码才不会被拉成两倍高。
     * 键是「上模块+下模块」，1 = 暗。**亮模块画成实块** —— 深色终端下实块看起来才是白格，
     * 反过来画出来的码扫不出。越界（最后一行的下半格）当亮处理，那本来就是静区外。
     */
    const GLYPH = { '00': '\u2588', '10': '\u2584', '01': '\u2580', '11': ' ' };
    const rows = [];
    for (let r = 0; r < size; r += 2) {
      let line = '';
      for (let c = 0; c < size; c++) {
        line += GLYPH[`${dark(r, c) ? 1 : 0}${dark(r + 1, c) ? 1 : 0}`];
      }
      rows.push('  ' + line);
    }
    return { art: rows.join('\n') };
  } catch (e) { return { error: e.message.split('\n')[0] }; }   // Node 的 require 错误自带多行栈
}

const tilde = p => p.startsWith(homedir()) ? p.replace(homedir(), '~') : p;

/** 起好之后打给用户看的那一屏。 */
export function banner(h, { qr = true, lanRead = false } = {}) {
  const lines = [
    '',
    '[airdrop] 收件台已启动',
    '',
    `  PC      ${h.url}`,
    `  手机    ${h.phoneUrl}`,
    '',
  ];
  if (qr) {
    const { art, error } = terminalQR(h.phoneUrl);
    lines.push(art ?? `  ⚠ 二维码画不出来：${error}\n    用上面那个地址在手机浏览器里打开。`, '');
  }
  lines.push(
    `  收件箱  ${tilde(h.inbox.dir)}`,
    `  存到    ${tilde(h.inbox.saveDir)}`,
    '',
  );
  // 这段话必须跟实际的闸一致。分权开着时局域网只能推文件，读不到收件箱；
  // --lan-read 把闸放开之后，暴露面就回到"网内任何人都能读"，措辞要跟着变。
  lines.push(lanRead
    ? '  ⚠ --lan-read 已开：局域网内任何人都能读、下载、删除收件箱里的东西，且没有口令。'
    : '  局域网只能往这里传文件；收件箱的读取与保存只有本机（127.0.0.1）可以。');
  lines.push(
    '  ⚠ 没有口令 —— 网内任何人都能往你这儿推文件。别在公共 Wi-Fi 上开着。',
    '  Ctrl-C 停止',
    '',
  );
  return lines.join('\n');
}

/**
 * 命令行主流程。宿主（aqua）也可以直接调它并把 `rest` 传进来。
 * @param {{argv?: string[], log?: (s: string) => void}} [io]
 */
export async function runAirdrop({ argv = [], log = console.log } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) { log(USAGE); return; }

  let h;
  try {
    h = await startAirdrop(opts);
  } catch (e) {
    if (e.code === 'EADDRINUSE' && opts.port !== undefined) {
      throw new Error(`端口 ${opts.port} 已被占用。换一个 --port，或者不带 --port 让它自己找。`);
    }
    throw e;
  }

  log(banner(h, { qr: opts.qr, lanRead: opts.lanRead ?? false }));
  if (opts.open) openExternal(h.url);

  // Ctrl-C / kill 都要走同一条收尾：断开 SSE 再 close，否则进程像卡住（见 server.mjs stop()）
  await new Promise(done => {
    let closing = false;
    const bye = async () => {
      if (closing) return;
      closing = true;
      log('\n[airdrop] 正在停止…');
      await h.stop();
      done();
    };
    process.once('SIGINT', bye);
    process.once('SIGTERM', bye);
    h.server.once('close', () => { if (!closing) done(); });
  });
}
