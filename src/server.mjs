/**
 * HTTP 路由与 SSE 推送。除 `src/ui/` 的静态文件外，这里不碰磁盘 —— 都过 `Inbox`。
 *
 * 只有一套显示机制：两个页面（`/` 给 PC，`/m` 给手机）由同一个服务、同一个端口提供，
 * 手机 UA 打开 `/` 会被页面自己跳到 `/m`。所以"给手机的地址"和"给 PC 的地址"是同一个，
 * 二维码里写 `/m` 只是省掉那一跳。
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { Inbox } from './inbox.mjs';
import { lanAddress, fromPrivateNetwork, fromLoopback, revealDir } from './lan.mjs';

// 不带尾斜杠：下面的越界检查用 `UI + sep` 比较，带了尾斜杠会拼出双斜杠、把所有静态资源判成越界
const UI = fileURLToPath(new URL('./ui', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
};

/**
 * 只对本机开放的路径：读收件箱 + 管理动作 + PC 页自身（含它要的 vendor 脚本）。
 * 反过来说，局域网能碰的只有 `/m`、`/api/info`、`/api/upload`、`/api/text`。
 */
const LOCAL_ONLY = p =>
  p === '/' || p === '/index.html' ||
  p === '/api/files' || p === '/api/incoming' || p === '/api/events' ||
  p === '/api/save' || p === '/api/delete' || p === '/api/reveal' ||
  p.startsWith('/file/') || p.startsWith('/thumb/') || p.startsWith('/vendor/');

const json = (res, code, body) => {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
};

const readJson = req => new Promise((ok, fail) => {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    // 这些端点收的是 id 列表和短文本，不是文件。1MB 之后就是有人在灌了。
    if (size > 1 << 20) { req.destroy(); return fail(new Error('请求体过大')); }
    chunks.push(c);
  });
  req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { fail(e); } });
  req.on('error', fail);
});

/**
 * 发一个文件，支持 Range。
 *
 * Range 是承载性的，不是优化：`<video>` 拖进度条靠它，Safari 上不支持 206 的话
 * 视频根本不播。`disposition='attachment'` 走"用浏览器下载"那条路。
 */
function sendFile(req, res, abs, mime, disposition, filename) {
  let stat;
  try { stat = statSync(abs); } catch { res.writeHead(404); return res.end('not found'); }
  const bodyless = req.method === 'HEAD';

  const headers = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  if (disposition) {
    headers['Content-Disposition'] =
      `${disposition}; filename*=UTF-8''${encodeURIComponent(filename ?? 'file')}`;
  }

  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    if (start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    const end = Math.min(range[2] ? Number(range[2]) : stat.size - 1, stat.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                         'Content-Length': end - start + 1 });
    return bodyless ? res.end() : createReadStream(abs, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (bodyless) return res.end();
  createReadStream(abs).pipe(res);
}

/**
 * 起一个收件台。
 *
 * @param {object} o
 * @param {number} o.port
 * @param {string} o.host    默认 0.0.0.0 —— 绑回环手机就连不上，这不是可选的
 * @param {string} o.dir     收件箱目录
 * @param {string} o.saveDir "保存到电脑"的落点
 * @param {boolean} [o.privateOnly=true] 只接受私网来源的请求（见 lan.mjs）
 * @param {boolean} [o.lanRead=false] 允许局域网设备读收件箱。默认关：读与管理只对本机开放
 * @returns {Promise<{server, inbox, port, host, url, lanUrl, phoneUrl, stop}>}
 */
export async function createAirdropServer({ port, host = '0.0.0.0', dir, saveDir,
                                            privateOnly = true, lanRead = false }) {
  const inbox = new Inbox(dir, saveDir);

  /** 连着的 PC 页面。SSE 是单向的：浏览器不往回发事件，回传都走普通 POST。 */
  const clients = new Set();
  const emit = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) { try { res.write(payload); } catch {} }
  };

  const server = createServer(async (req, res) => {
    if (privateOnly && !fromPrivateNetwork(req.socket.remoteAddress)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('airdrop 只接受局域网内的访问');
    }

    const url = new URL(req.url, 'http://local');
    const p = decodeURIComponent(url.pathname);
    // 能读的方法：文件与页面接受 HEAD（有客户端会先探一下大小），SSE 只认真正的 GET
    const GET = req.method === 'GET' || req.method === 'HEAD';
    const POST = req.method === 'POST';
    const local = fromLoopback(req.socket.remoteAddress);

    // 读写分权：局域网只能**往这里传**，收件箱的读取与管理只对本机开放。
    // 手机页一个都不需要下面这些（phone.html 里只有 /api/info、/api/upload、/api/text），
    // 所以这道闸对正常使用是零成本的；`--lan-read` 可以放开，用于从另一台电脑看收件箱。
    if (!local && !lanRead && LOCAL_ONLY(p)) {
      // 手机上手输了根地址不该吃闭门羹 —— 直接送去手机页。
      // 这也顺带把 pc.html 整份应用代码挡在局域网之外（原来只靠页面里的 UA 判断跳转）。
      if (p === '/' || p === '/index.html') {
        res.writeHead(302, { Location: '/m' });
        return res.end();
      }
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('这个接口只对运行 airdrop 的那台机器开放');
    }

    try {
      if (GET && (p === '/' || p === '/index.html')) return sendFile(req, res, join(UI, 'pc.html'), MIME['.html']);
      if (GET && (p === '/m' || p === '/m/'))        return sendFile(req, res, join(UI, 'phone.html'), MIME['.html']);

      if (GET && p === '/api/info') {
        const name = hostname().replace(/\.local$/, '');
        // 手机页只用 host（显示"已连接到 XXX"）。本地路径与端口没有理由发到局域网上去。
        // 但 --lan-read 意味着"让局域网设备读收件箱"，而读的方式就是从另一台电脑开 PC 页，
        // 那个页面要 ip / port 拼手机地址与二维码、要 saveDir 显示落点 —— 所以要跟着放开，
        // 否则那条逃生口给出的是一个地址栏和二维码都坏掉的页面。
        if (!local && !lanRead) return json(res, 200, { host: name });
        return json(res, 200, { ip: lanAddress(), port, host: name,
                                saveDir: inbox.saveDir, inboxDir: inbox.dir });
      }
      if (GET && p === '/api/files')    return json(res, 200, inbox.files);
      if (GET && p === '/api/incoming') return json(res, 200, [...inbox.active.values()]);

      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
                             Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(': ok\n\n');
        clients.add(res);
        // 心跳：中间任何一层代理或系统休眠都可能悄悄掐掉一条静默的长连接
        const beat = setInterval(() => { try { res.write(': beat\n\n'); } catch {} }, 20_000);
        req.on('close', () => { clearInterval(beat); clients.delete(res); });
        return;
      }

      if (POST && p === '/api/upload') {
        const rec = await inbox.receive(req, emit);
        return json(res, 200, rec);
      }
      if (POST && p === '/api/text') {
        const { text } = await readJson(req);
        if (typeof text !== 'string' || !text.trim()) return json(res, 400, { error: '空文本' });
        return json(res, 200, inbox.addText(text, emit));
      }

      if (GET && (p.startsWith('/file/') || p.startsWith('/thumb/'))) {
        const thumb = p.startsWith('/thumb/');
        const rec = inbox.find(p.slice(thumb ? 7 : 6));
        if (!rec) { res.writeHead(404); return res.end('not found'); }
        if (thumb) {
          const abs = rec.thumb ? join(inbox.dir, rec.thumb) : inbox.path(rec);
          return sendFile(req, res, abs, rec.thumb ? 'image/jpeg' : rec.mime);
        }
        const dl = url.searchParams.has('dl');
        return sendFile(req, res, inbox.path(rec), rec.mime, dl ? 'attachment' : 'inline', rec.name);
      }

      if (POST && p === '/api/save') {
        const { ids } = await readJson(req);
        if (!Array.isArray(ids)) return json(res, 400, { error: 'ids 必须是数组' });
        const out = inbox.saveToDisk(ids);
        emit('saved', { ids });
        return json(res, 200, out);
      }
      if (POST && p === '/api/delete') {
        const { ids } = await readJson(req);
        if (!Array.isArray(ids)) return json(res, 400, { error: 'ids 必须是数组' });
        inbox.remove(ids);
        emit('removed', { ids });
        return json(res, 200, { ok: true });
      }
      if (POST && p === '/api/reveal') {
        revealDir(inbox.saveDir);
        return json(res, 200, { ok: true });
      }

      // 静态资源（目前只有 vendor/qrcode.js）。两道闸：解析后必须仍在 ui/ 内，
      // 且扩展名必须在 MIME 表里 —— 没登记的类型不发，这样以后往 ui/ 下放东西
      // （说明、许可、那个只写 type 的 package.json）不会顺带被公开出去。
      if (GET) {
        const abs = resolve(UI, `.${p}`);
        const mime = MIME[extname(abs).toLowerCase()];
        if (mime && abs.startsWith(UI + sep) && existsSync(abs) && statSync(abs).isFile()) {
          return sendFile(req, res, abs, mime);
        }
      }

      res.writeHead(404); res.end('not found');
    } catch (e) {
      if (res.headersSent) return res.destroy();
      json(res, 500, { error: e.message });
    }
  });

  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, ok);
  });

  const ip = lanAddress();
  return {
    server, inbox, port, host,
    url: `http://127.0.0.1:${port}`,
    lanUrl: `http://${ip}:${port}`,
    phoneUrl: `http://${ip}:${port}/m`,
    /** 关掉之前先把 SSE 连接断开 —— 否则 `server.close()` 会一直等它们，Ctrl-C 像卡住。 */
    async stop() {
      for (const res of clients) { try { res.end(); } catch {} }
      clients.clear();
      await new Promise(ok => server.close(ok));
    },
  };
}
