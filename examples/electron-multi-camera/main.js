// Electron 主进程：一个 Python 进程写 5 个命名段，本进程用 5 个 reader 一次循环扫完。
//
// 与单路 showcase 的关键差别（这个示例要证明的事）：
//   1. 库没有进程级可变全局状态，5 个 ShmRingReader 实例各读各的段、各持独立游标；
//   2. 只用一个 2ms 定时器遍历全部 reader（而不是 5 个定时器），
//      每轮把 5 路的帧打包成一次 webContents.send()，减少 IPC 调度次数；
//   3. 帧率 / 帧龄 / 跳帧 / 在线状态全部按路分开统计，一路挂掉不拖累其余四路。
//
// 协议布局、seqlock、环形覆盖、批量双检、Win32/POSIX 差异全部由 shmring 负责，
// 本文件不含任何 FFI / struct / DataView 代码。

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');

function loadShmring() {
  const candidates = ['shmring', '../../', '../shmring'];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    '未找到 shmring 库：请在 shmring 仓库根执行 npm install（安装 koffi），' +
    `或执行 npm install shmring。最后一次错误：${lastError && lastError.message}`
  );
}

let shmring = null;
let shmringLoadError = null;
try {
  shmring = loadShmring();
} catch (error) {
  shmringLoadError = error;
}

const CAM_COUNT = Math.max(1, Number(process.env.DEMO_CAMS || 5));
const TARGET_FPS = Number(process.env.DEMO_FPS || 30);
const BUFFER_KB = Number(process.env.DEMO_BUFFER_KB || 512);
let scanIntervalMs = 2;
const STALE_MS = 2000;   // 某路超过 2s 没有新帧就判定离线
const ATTACH_TIMEOUT_MS = 15000;
// 无人值守冒烟用：设置后到点自动 app.quit()，走 before-quit 正常关 reader / Python。
const AUTO_QUIT_MS = Number(process.env.DEMO_AUTO_QUIT_MS || 0);

// 随机前缀避免与上次崩溃残留的段撞名；5 个名字互不相同。
const SHM_PREFIX = 'shmring_multi_' + crypto.randomBytes(3).toString('hex');
const SHM_NAMES = Array.from({ length: CAM_COUNT }, (_, i) => `${SHM_PREFIX}_${i + 1}`);
const SERIES_NAME = `${SHM_PREFIX}_series`;

const PY_ARGS = [
  path.join(__dirname, 'python', 'server.py'),
  '--names', SHM_NAMES.join(','),
  '--cam-count', String(CAM_COUNT),
  '--fps', String(TARGET_FPS),
  '--buffer-kb', String(BUFFER_KB),
  '--series-name', SERIES_NAME,
];
if (process.env.DEMO_REAL_CAMERA !== '0') PY_ARGS.push('--real-camera');

let mainWindow = null;
let pythonProcess = null;
let scanTimer = null;
let running = false;
let paused = false;
let readers = [];
let seriesReader = null;
const seriesState = { packets: 0, dropped: 0, lastSeq: -1, online: false };
let attachedAt = 0;
let lastLogAt = 0;
let pythonSource = 'synthetic';

// 每路独立状态：帧率滑动窗口、帧龄、跳帧、meta 缓存、在线状态。
const perCam = SHM_NAMES.map((name, i) => ({
  camId: i + 1,
  name,
  arrivals: [],
  ages: [],
  dropped: 0,
  lastStamp: 0,
  lastFrameId: -1,
  online: false,
  meta: { cam: i + 1, mime: 'image/png', src: 'synthetic', w: 0, h: 0 },
  metaRaw: null,
}));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendStatus(text, level = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', { text, level });
  }
}

function camFps(cam) {
  if (cam.arrivals.length < 2) return 0;
  const span = cam.arrivals[cam.arrivals.length - 1] - cam.arrivals[0];
  if (span <= 0) return 0;
  return Math.round(((cam.arrivals.length - 1) * 1000) / span * 10) / 10;
}

function parseMeta(cam, buf) {
  if (!buf || !buf.length) return cam.meta;
  const raw = buf.toString('utf8');
  if (raw === cam.metaRaw) return cam.meta;
  cam.metaRaw = raw;
  try {
    const parsed = JSON.parse(raw);
    cam.meta = {
      cam: Number(parsed.cam) || cam.camId,
      mime: parsed.mime || 'image/png',
      src: parsed.src || 'synthetic',
      w: Number(parsed.w) || 0,
      h: Number(parsed.h) || 0,
    };
  } catch (_) {
    // meta 损坏时沿用上一帧，不影响画面
  }
  return cam.meta;
}

// ---------- 共享内存 attach（5 路各自重试，已成功的保留） ----------

async function attachAll(timeoutMs = ATTACH_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  const attached = new Array(CAM_COUNT).fill(null);
  const errors = new Array(CAM_COUNT).fill(null);
  while (Date.now() < deadline) {
    let pending = 0;
    for (let i = 0; i < CAM_COUNT; i++) {
      if (attached[i]) continue;
      try {
        attached[i] = new shmring.ShmRingReaderV2(SHM_NAMES[i], {
          join: 'tip',
          role: 'observer',
        });
        errors[i] = null;
      } catch (error) {
        // 段还没创建，或已创建但全局头未写完（magic 校验失败）→ 继续等
        errors[i] = error;
        pending++;
      }
    }
    if (!pending) return attached;
    if (pythonProcess && pythonProcess.exitCode !== null) break;
    await delay(100);
  }
  // 失败时关掉已 attach 的映射，避免句柄泄漏
  for (const r of attached) {
    if (r) { try { r.close(); } catch (_) { /* 忽略 */ } }
  }
  const failed = errors
    .map((e, i) => (e ? `${SHM_NAMES[i]}: ${e.message}` : null))
    .filter(Boolean);
  console.error('[electron] attach 失败:', failed.join(' | ') || 'python 已退出');
  return null;
}

function closeReaders() {
  for (const r of readers) {
    if (r) { try { r.close(); } catch (_) { /* 忽略 */ } }
  }
  readers = [];
  if (seriesReader) {
    try { seriesReader.close(); } catch (_) { /* 忽略 */ }
    seriesReader = null;
  }
}

// ---------- 单个扫描循环：一次遍历 5 路，一次批量 IPC ----------

function processCam(i, out) {
  const cam = perCam[i];
  const reader = readers[i];
  if (!reader) return;
  let batch;
  try {
    batch = reader.readBatch();
    const now = Date.now();
    for (const f of batch.frames) {
      reader.commit(f.seq);
      const meta = parseMeta(cam, f.meta);
      cam.lastStamp = f.stamp;
      cam.online = true;
      cam.arrivals.push(now);
      if (cam.arrivals.length > 80) cam.arrivals.shift();
      const age = now - f.stamp;
      if (age >= 0 && age < 1000) {
        cam.ages.push(age);
        if (cam.ages.length > 80) cam.ages.shift();
      }
      if (!paused) {
        out.push({
          camId: cam.camId,
          metaCam: meta.cam,
          buffer: f.payload,
          mime: meta.mime,
          width: meta.w,
          height: meta.h,
          id: f.seq,
        });
      }
    }
    if (batch.gap && batch.gap.nextSeq > reader.readPos) {
      cam.dropped += batch.gap.dropped;
      reader.skipTo(batch.gap.nextSeq);
    }
    cam.lastFrameId = reader.readPos;
  } catch (error) {
    cam.online = false;
  }
}

function processSeries() {
  if (!seriesReader) return;
  let batch;
  try {
    batch = seriesReader.readBatch();
    const packets = [];
    for (const frame of batch.frames) {
      seriesReader.commit(frame.seq);
      let meta = {};
      try { meta = JSON.parse(frame.meta.toString('utf8')); } catch (_) { /* 坏 meta 跳过计数 */ }
      const channels = Number(meta.ch) || 1;
      const count = Number(meta.n) || Math.floor(frame.payload.length / (4 * channels));
      packets.push({
        seq: frame.seq,
        i0: Number(meta.i0) || 0,
        hz: Number(meta.hz) || 512,
        channels,
        n: count,
        payload: frame.payload,
      });
      seriesState.packets += 1;
      seriesState.lastSeq = frame.seq;
      seriesState.online = true;
    }
    if (batch.gap && batch.gap.nextSeq > seriesReader.readPos) {
      seriesState.dropped += batch.gap.dropped;
      seriesReader.skipTo(batch.gap.nextSeq);
    }
    if (packets.length && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('series', {
        packets,
        dropped: seriesState.dropped,
        packetsSeen: seriesState.packets,
      });
    }
  } catch (error) {
    seriesState.online = false;
  }
}

function scanSharedMemory() {
  if (!running || !readers.length) return;
  const out = [];
  for (let i = 0; i < CAM_COUNT; i++) processCam(i, out);
  processSeries();

  const now = Date.now();
  for (const cam of perCam) {
    if (cam.lastStamp && now - cam.lastStamp > STALE_MS) cam.online = false;
  }
  if (out.length && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('frames', out);
  }

  if (now - lastLogAt >= 2000) {
    lastLogAt = now;
    const fps = perCam.map(camFps);
    const total = Math.round(fps.reduce((a, b) => a + b, 0) * 10) / 10;
    const ages = perCam.flatMap((c) => c.ages);
    const avgAge = ages.length
      ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;
    const dropped = perCam.reduce((a, c) => a + c.dropped, 0);
    const offline = perCam.filter((c) => !c.online).length;
    console.log(
      `[shmring] cams=${CAM_COUNT} fps=[${fps.join(',')}] total=${total} · ` +
      `帧龄 avg ${avgAge}ms · 累计跳帧 ${dropped} · 离线 ${offline}`
    );
  }
  scanTimer = setTimeout(scanSharedMemory, scanIntervalMs);
}

// ---------- Python 子进程 ----------

async function startPython() {
  const specified = process.env.PYTHON;
  const candidates = specified
    ? [[specified, PY_ARGS]]
    : [['python', PY_ARGS], ['py', ['-3', ...PY_ARGS]]];

  for (const [command, args] of candidates) {
    const child = spawn(command, args, {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      windowsHide: true,
    });
    const spawned = await new Promise((resolve) => {
      const onSpawn = () => { cleanup(); resolve(true); };
      const onError = (err) => {
        cleanup();
        if (err.code !== 'ENOENT') console.error('[electron] python spawn error:', err);
        resolve(false);
      };
      const cleanup = () => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    if (!spawned) continue;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString().trimEnd();
      console.log(text);
      if (/real-camera=yes/.test(text)) pythonSource = 'camera';
      else if (/real-camera=no/.test(text)) pythonSource = 'synthetic';
    });
    child.stderr.on('data', (chunk) => console.error(chunk.toString().trimEnd()));
    child.on('exit', (code) => {
      if (running) sendStatus(`Python 写端已退出（code=${code}）`, 'error');
    });
    return child;
  }
  throw new Error('未找到可用的 Python 解释器，请安装 Python 或设置环境变量 PYTHON。');
}

// ---------- 窗口与 IPC ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 1000,
    minWidth: 1100,
    minHeight: 680,
    title: 'shmring · 视频与时序',
    backgroundColor: '#f5f7fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('get-stats', () => {
  if (!readers.length) return null;
  const fps = perCam.map(camFps);
  const ages = perCam.flatMap((c) => c.ages);
  return {
    total_fps: Math.round(fps.reduce((a, b) => a + b, 0) * 10) / 10,
    total_dropped: perCam.reduce((a, c) => a + c.dropped, 0),
    avg_age_ms: ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0,
    uptime_seconds: attachedAt ? Math.round((Date.now() - attachedAt) / 100) / 10 : 0,
    source: pythonSource,
    transport: 'shmring',
    protocol_version: shmring.PROTOCOL_VERSION_V2,
    source_label: pythonSource === 'camera' ? '1 路摄像头 + 4 路合成' : '5 路合成',
    scan_interval_ms: scanIntervalMs,
    cams: perCam.map((c, i) => ({
      cam_id: c.camId,
      shm_name: c.name,
      fps: fps[i],
      frame_id: c.lastFrameId,
      dropped: c.dropped,
      online: c.online,
      width: c.meta.w,
      height: c.meta.h,
      mime: c.meta.mime,
      src: c.meta.src || 'synthetic',
      buffer_bytes: readers[i] ? readers[i].info.capacity : 0,
      slot_count: readers[i] ? readers[i].info.slotCount : 4,
    })),
  };
});

ipcMain.handle('get-server-info', () => ({
  camCount: CAM_COUNT,
  names: SHM_NAMES,
  seriesName: SERIES_NAME,
  seriesHz: 512,
  seriesChannels: 160,
  targetFps: TARGET_FPS,
  bufferKb: BUFFER_KB,
  protocolVersion: shmring ? shmring.PROTOCOL_VERSION_V2 : 2,
  pythonPid: pythonProcess ? pythonProcess.pid : null,
  scanIntervalMs,
}));

ipcMain.on('set-scan-interval', (_event, value) => {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next)) return;
  scanIntervalMs = Math.min(5000, Math.max(1, next));
  console.log(`[electron] scan interval ${scanIntervalMs}ms`);
});

ipcMain.on('set-paused', (_event, value) => {
  paused = Boolean(value);
  sendStatus(paused ? '画面已暂停（Python 仍在发布）' : '实时画面已恢复', 'info');
});

// 渲染端首帧自检：确认 5 个 Canvas 都真的画出了非黑像素，而不只是 IPC 送达。
ipcMain.on('render-check', (_event, rows) => {
  const ok = rows.filter((r) => r.nonBlack).length;
  console.log(
    `[renderer] ${rows.length} 个 Canvas 首帧绘制完成 · 中心像素非黑 ${ok}/${rows.length}`
  );
});

function stopAll() {
  running = false;
  if (scanTimer) clearTimeout(scanTimer);
  closeReaders();
  if (pythonProcess && !pythonProcess.killed) pythonProcess.kill();
}

app.whenReady().then(async () => {
  if (shmringLoadError) {
    dialog.showErrorBox('缺少依赖', shmringLoadError.message);
    app.quit();
    return;
  }

  createWindow();
  sendStatus(`正在启动 Python 写端（v2，${CAM_COUNT} 路）…`, 'warn');
  try {
    pythonProcess = await startPython();
  } catch (error) {
    dialog.showErrorBox('启动失败', error.message);
    sendStatus(error.message, 'error');
    return;
  }

  sendStatus(`正在映射 ${CAM_COUNT} 个共享内存段…`, 'warn');
  const attached = await attachAll();
  if (!attached) {
    dialog.showErrorBox('连接失败', `无法打开 ${CAM_COUNT} 个 shmring 段，请查看控制台日志。`);
    sendStatus('共享内存映射失败', 'error');
    return;
  }
  readers = attached;
  try {
    seriesReader = new shmring.ShmRingReaderV2(SERIES_NAME, { join: 'tip', role: 'observer' });
  } catch (error) {
    console.error('[electron] series attach failed:', error.message);
  }
  attachedAt = Date.now();
  running = true;

  const info = readers[0].info;
  sendStatus(
    `已连接：shmring v${shmring.PROTOCOL_VERSION_V2} · ${CAM_COUNT} 段 × ${info.slotCount} 槽`,
    'ok'
  );
  console.log(
    `[electron] attached ${CAM_COUNT} segments (${(info.capacity / 1024).toFixed(0)} KB each, ` +
    `${info.slotCount} slots, protocol v${shmring.PROTOCOL_VERSION_V2}), ` +
    `one ${scanIntervalMs}ms loop scanning all readers`
  );
  scanSharedMemory();

  if (AUTO_QUIT_MS > 0) {
    setTimeout(() => {
      console.log(`[electron] auto quit after ${AUTO_QUIT_MS}ms`);
      app.quit();
    }, AUTO_QUIT_MS);
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopAll);
