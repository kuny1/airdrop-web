/**
 * 收件箱：文件落在哪、元数据长什么样、缩略图怎么来、"保存到电脑"怎么算完成。
 *
 * 只有这一个模块碰磁盘。路由层拿到的是 `Inbox` 实例上的方法，
 * 所以"文件存哪"这个决定改起来只动一处（`--dir` 就是靠这个成立的）。
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync,
         copyFileSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { canThumbnail } from './lan.mjs';

/** 文件名里不能留路径分隔符与 NUL；开头的点也去掉，避免写出隐藏文件。 */
const safeName = n => (n || 'file').replace(/[/\\\0]/g, '_').replace(/^\.+/, '_').slice(0, 180);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/**
 * 按 MIME 与扩展名归一到五类。
 *
 * 归类是**给界面用的**，不是给系统用的：PC 端靠它决定卡片长什么样、预览走哪条路径。
 * 所以 MIME 不可信时（很多安卓浏览器发 `application/octet-stream`）扩展名要能兜住。
 */
export function kindOf(mime = '', name = '') {
  const ext = extname(name).toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/') || ['.mp4', '.mov', '.m4v', '.webm'].includes(ext)) return 'video';
  if (mime.startsWith('audio/') || ['.mp3', '.m4a', '.aac', '.wav', '.aiff'].includes(ext)) return 'audio';
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (mime.startsWith('text/') || ['.txt', '.md', '.json', '.csv', '.log'].includes(ext)) return 'text';
  return 'file';
}

export class Inbox {
  /**
   * @param {string} dir     收件箱目录（文件实体 + files.json 都在这）
   * @param {string} saveDir "保存到电脑"的落点
   */
  constructor(dir, saveDir) {
    this.dir = dir;
    this.saveDir = saveDir;
    this.metaPath = join(dir, 'files.json');
    mkdirSync(dir, { recursive: true });
    /** 已到达的文件，最新在前。 */
    this.files = this.#load();
    /**
     * 正在接收中的上传。
     *
     * 单独一张表的理由：传输过程中打开或刷新 PC 页面的人，错过了 SSE 的开始事件。
     * 只靠事件流的话他们会看到一片空白直到文件落地 —— 一个 24MB 的视频那是半分钟。
     */
    this.active = new Map();
  }

  #load() {
    try { return JSON.parse(readFileSync(this.metaPath, 'utf8')); } catch { return []; }
  }

  #persist() {
    writeFileSync(this.metaPath, JSON.stringify(this.files, null, 2));
  }

  path(rec) { return join(this.dir, rec.stored); }
  find(id) { return this.files.find(f => f.id === id); }

  /**
   * 接收一个上传流。
   *
   * 边收边写盘（不缓存整个文件在内存里），字节数由**服务端**计数后广播 ——
   * 而不是让手机端上报进度：服务端的计数是"已落盘多少"，手机端的是"已发出多少"，
   * PC 上要看的是前者。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {(event: string, data: object) => void} emit
   */
  receive(req, emit) {
    const name = safeName(decodeURIComponent(req.headers['x-filename'] ?? 'file'));
    const mime = String(req.headers['x-mime'] ?? 'application/octet-stream');
    const id = newId();
    const stored = `${id}__${name}`;
    const abs = join(this.dir, stored);
    const total = Number(req.headers['content-length'] ?? 0);

    const live = { id, name, mime, size: total, received: 0, kind: kindOf(mime, name) };
    this.active.set(id, live);
    emit('incoming', live);

    return new Promise((resolve, reject) => {
      const ws = createWriteStream(abs);
      let bytes = 0, lastTick = 0;

      req.on('data', c => {
        bytes += c.length;
        live.received = bytes;
        const now = Date.now();
        // 120ms 一次：再密就是白花带宽，再疏进度条会一跳一跳
        if (now - lastTick > 120) { lastTick = now; emit('progress', { ...live }); }
      });
      req.on('aborted', () => {
        this.active.delete(id);
        try { unlinkSync(abs); } catch {}
        emit('failed', { id });
        reject(new Error('上传中断'));
      });
      ws.on('error', err => {
        this.active.delete(id);
        try { unlinkSync(abs); } catch {}
        emit('failed', { id });
        reject(err);
      });
      ws.on('finish', () => {
        this.active.delete(id);
        const rec = { id, name, mime, size: bytes, stored, at: Date.now(),
                      thumb: null, saved: false, kind: kindOf(mime, name) };
        this.files.unshift(rec);
        this.#persist();
        emit('added', rec);
        this.#thumbnail(rec, emit);
        resolve(rec);
      });
      req.pipe(ws);
    });
  }

  /** 手机端直发的一段文字 / 链接，落成 .txt。 */
  addText(text, emit) {
    const id = newId();
    const name = safeName(`${text.trim().slice(0, 24).replace(/\s+/g, ' ') || '文本'}.txt`);
    const stored = `${id}__${name}`;
    writeFileSync(join(this.dir, stored), text, 'utf8');
    const rec = { id, name, mime: 'text/plain; charset=utf-8', size: Buffer.byteLength(text),
                  stored, at: Date.now(), thumb: null, saved: false, kind: 'text' };
    this.files.unshift(rec);
    this.#persist();
    emit('added', rec);
    return rec;
  }

  /**
   * 用 macOS 自带的 sips 压一张缩略图。
   *
   * 不做这一步网格也能看（发原图，CSS 缩放），但手机直出的照片动辄 4MB，
   * 二十张就是 80MB 走一遍浏览器解码 —— 网格会卡在那儿，而卡顿会被读成"这个方向不好"。
   * 别的平台没有 sips，直接发原图；`thumb` 留 null，路由层据此选源。
   */
  #thumbnail(rec, emit) {
    if (!canThumbnail || rec.kind !== 'image' || rec.mime === 'image/svg+xml') return;
    const out = join(this.dir, `${rec.id}.thumb.jpg`);
    execFile('sips', ['-Z', '600', '-s', 'format', 'jpeg', this.path(rec), '--out', out],
      { timeout: 20_000 }, err => {
        if (err || !existsSync(out)) return;
        rec.thumb = basename(out);
        this.#persist();
        emit('update', rec);
      });
  }

  /**
   * 把选中的文件复制到"保存到电脑"目录，同名自动加序号。
   *
   * 复制而不是移动：收件箱是收件箱，存一次不等于取走了 —— 用户可能还要再存一份到别处。
   * `saved` 只是个标记，让 PC 网格能显示"这个已经落过盘了"。
   */
  saveToDisk(ids) {
    mkdirSync(this.saveDir, { recursive: true });
    const done = [];
    for (const id of ids) {
      const rec = this.find(id);
      if (!rec) continue;
      const ext = extname(rec.name);
      const base = rec.name.slice(0, rec.name.length - ext.length);
      let target = join(this.saveDir, rec.name);
      for (let i = 1; existsSync(target); i++) target = join(this.saveDir, `${base} (${i})${ext}`);
      copyFileSync(this.path(rec), target);
      rec.saved = true;
      done.push(basename(target));
    }
    this.#persist();
    return { dir: this.saveDir, files: done };
  }

  remove(ids) {
    for (const id of ids) {
      const i = this.files.findIndex(f => f.id === id);
      if (i < 0) continue;
      const rec = this.files[i];
      for (const f of [rec.stored, rec.thumb]) {
        if (f) { try { unlinkSync(join(this.dir, f)); } catch {} }
      }
      this.files.splice(i, 1);
    }
    this.#persist();
  }
}
