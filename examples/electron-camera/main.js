// Electron 主进程：拉起 Python 采集端，通过 shmring 库直接读共享内存帧。
//
// 数据链路（零 HTTP、零轮询请求）：
//   ffmpeg/合成画面 -> Python 端 ShmRingWriter 写入命名共享内存（4 槽环形缓冲）
//     -> 本进程 ShmRingReader.readBatch() 一次扫描批量取走新帧
//       -> IPC（结构化克隆）-> 渲染进程 Canvas
//
// 协议布局、seqlock 奇偶校验、环形覆盖、批量双检、Win32/POSIX 平台差异
// 全部由 shmring 库负责，本文件不再包含任何 FFI / struct / DataView 代码。
// 库内部统一用 koffi.address() + memcpy，规避 Electron 内置 Node 下
// koffi.view() 触发的 napi_is_detached_arraybuffer FATAL ERROR。

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');

// 优先用已安装的 npm 包；否则回退到仓库源码，保证「clone 即跑」以及
// 独立 demo 目录（与 shmring 仓库平级）两种布局都能工作。
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

const TARGET_FPS = Number(process.env.DEMO_FPS || 20);
const BUFFER_MB = Number(process.env.DEMO_BUFFER_MB || 8);
const SCAN_INTERVAL_MS = 2;   // 帧号扫描间隔（纯内存读，CPU 占用约 0.09% 单核）

// 逻辑段名由 Electron 指定，库内部负责 Windows/POSIX 的名字归一化。
const SHM_NAME = 'shmring_' + crypto.randomBytes(4).toString('hex');

const PY_ARGS = [
  path.join(__dirname, 'python', 'server.py'),
  '--fps', String(TARGET_FPS),
  '--name', SHM_NAME,
  '--buffer-size-mb', String(BUFFER_MB),
  '--no-http',
];
if (process.env.DEMO_FORCE_SYNTHETIC === '1') PY_ARGS.push('--force-synthetic');

let mainWindow = null;
let pythonProcess = null;
let scanTimer = null;
let running = false;
let paused = false;
let pythonSource = 'unknown';

// shmring 读端与本地统计
let reader = null;
let attachedAt = 0;
let totalSkipped = 0;
const frameArrivals = []; // 最近若干帧的到达时刻，用于本地估算 fps
const frameAges = [];     // 最近若干帧的「发布 -> 读走」耗时（ms）
let lastLogAt = 0;
let lastStamp = 0;
let lastMetaRaw = null;
let lastMeta = { mime: 'image/jpeg', w: 0, h: 0 };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendStatus(text, level = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', { text, level });
  }
}

function currentFps() {
  if (frameArrivals.length < 2) return 0;
  const span = frameArrivals[frameArrivals.length - 1] - frameArrivals[0];
  if (span <= 0) return 0;
  return Math.round(((frameArrivals.length - 1) * 1000) / span * 10) / 10;
}

// 每帧 meta 是 Python 端写入的紧凑 JSON；尺寸/MIME 通常不变，缓存解析结果。
function parseMeta(buf) {
  if (!buf || !buf.length) return lastMeta;
  const raw = buf.toString('utf8');
  if (raw === lastMetaRaw) return lastMeta;
  lastMetaRaw = raw;
  try {
    const parsed = JSON.parse(raw);
    lastMeta = {
      mime: parsed.mime || 'image/jpeg',
      w: Number(parsed.w) || 0,
      h: Number(parsed.h) || 0,
    };
  } catch (_) {
    // meta 损坏时沿用上一帧的解析结果，不影响画面
  }
  return lastMeta;
}

// ---------- 共享内存 attach ----------

async function attachSharedMemory(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (pythonProcess && pythonProcess.exitCode !== null) return false; // Python 已退出
    try {
      reader = new shmring.ShmRingReader(SHM_NAME);
      attachedAt = Date.now();
      return true;
    } catch (error) {
      // 段尚未创建，或已创建但全局头还没写完（magic 校验失败）→ 继续等
      lastError = error;
      await delay(100);
    }
  }
  console.error(`[electron] attach "${SHM_NAME}" 失败:`, lastError && lastError.message);
  return false;
}

function closeReader() {
  if (reader) {
    try { reader.close(); } catch (_) { /* 忽略 */ }
    reader = null;
  }
}

// ---------- 帧扫描 ----------

function processBatch() {
  // readBatch() 内部完成：全局 seq 双检、一次扫描批量读取 lastFrameId+1..newest、
  // 槽头 frame_id 校验、载荷 memcpy 到独立 Buffer、dropped 计数、游标推进。
  const batch = reader.readBatch();
  if (batch.dropped > 0) totalSkipped += batch.dropped;
  if (!batch.frames.length) return;

  for (const f of batch.frames) {
    const meta = parseMeta(f.meta);
    lastStamp = f.stamp;
    const now = Date.now();
    frameArrivals.push(now);
    if (frameArrivals.length > 80) frameArrivals.shift();
    // 钳制异常帧龄：撕裂 / 时钟回拨产生的垃圾值不污染滑动窗口
    const age = now - f.stamp;
    if (age >= 0 && age < 1000) {
      frameAges.push(age);
      if (frameAges.length > 80) frameAges.shift();
    }
    if (!paused && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('frame-data', {
        buffer: f.payload,
        mime: meta.mime,
        width: meta.w,
        height: meta.h,
        id: f.frameId,
      });
    }
  }

  const now = Date.now();
  if (now - lastLogAt >= 2000) {
    lastLogAt = now;
    const avgAge = frameAges.length
      ? Math.round(frameAges.reduce((a, b) => a + b, 0) / frameAges.length) : 0;
    const maxAge = frameAges.length ? Math.max(...frameAges) : 0;
    console.log(
      `[shmring] frame #${reader.lastFrameId} · 实际 ${currentFps()} fps · ` +
      `帧龄 avg ${avgAge}ms / max ${maxAge}ms · 累计跳帧 ${totalSkipped}`
    );
  }
}

function scanSharedMemory() {
  if (!running || !reader) return;
  try {
    processBatch();
  } catch (error) {
    sendStatus(`共享内存读取失败：${error.message}`, 'warn');
  }
  scanTimer = setTimeout(scanSharedMemory, SCAN_INTERVAL_MS);
}

// ---------- Python 子进程 ----------

async function startPython() {
  const specified = process.env.PYTHON;
  const candidates = specified
    ? [[specified, PY_ARGS]]
    : [
        ['python', PY_ARGS],
        ['py', ['-3', ...PY_ARGS]],
      ];

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
      const match = text.match(/source=(\S+)/);
      if (match) pythonSource = match[1];
    });
    child.stderr.on('data', (chunk) => console.error(chunk.toString().trimEnd()));
    child.on('exit', (code) => {
      if (running) sendStatus(`Python 服务端已退出（code=${code}）`, 'error');
    });
    return child;
  }
  throw new Error('未找到可用的 Python 解释器，请安装 Python 或设置环境变量 PYTHON。');
}

// ---------- 窗口与 IPC ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 840,
    minHeight: 600,
    title: 'shmring · Python ⇄ Electron 摄像头示例',
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
  if (!reader) return null;
  let info;
  try {
    info = reader.info;
  } catch (_) {
    return null;
  }
  return {
    shared_memory_name: SHM_NAME,
    buffer_bytes: info.capacity,
    frame_id: reader.lastFrameId,
    fps: currentFps(),
    width: lastMeta.w,
    height: lastMeta.h,
    mime: reader.lastFrameId >= 0 ? lastMeta.mime : '-',
    timestamp_ms: lastStamp,
    uptime_seconds: attachedAt ? Math.round((Date.now() - attachedAt) / 100) / 10 : 0,
    source: pythonSource,
    transport: 'shmring',
    protocol_version: info.protocolVersion,
    slot_count: info.slotCount,
    slot_size: info.slotSize,
  };
});

ipcMain.handle('get-server-info', () => ({
  mode: 'shared-memory',
  shmName: SHM_NAME,
  targetFps: TARGET_FPS,
  slotCount: reader ? reader.info.slotCount : 4,
  protocolVersion: shmring ? shmring.PROTOCOL_VERSION : 1,
  pythonPid: pythonProcess ? pythonProcess.pid : null,
}));

ipcMain.on('set-paused', (_event, value) => {
  paused = Boolean(value);
  sendStatus(paused ? '画面已暂停（Python 仍在采集）' : '实时画面已恢复', 'info');
});

function stopAll() {
  running = false;
  if (scanTimer) clearTimeout(scanTimer);
  closeReader();
  if (pythonProcess && !pythonProcess.killed) pythonProcess.kill();
}

app.whenReady().then(async () => {
  if (shmringLoadError) {
    dialog.showErrorBox('缺少依赖', shmringLoadError.message);
    app.quit();
    return;
  }

  createWindow();
  sendStatus('正在启动 Python 服务端…', 'warn');
  try {
    pythonProcess = await startPython();
  } catch (error) {
    dialog.showErrorBox('启动失败', error.message);
    sendStatus(error.message, 'error');
    return;
  }

  sendStatus('正在映射共享内存…', 'warn');
  const ok = await attachSharedMemory();
  if (!ok) {
    dialog.showErrorBox('连接失败', `无法打开 shmring 段 ${SHM_NAME}，请查看控制台日志。`);
    sendStatus('共享内存映射失败', 'error');
    return;
  }

  running = true;
  const info = reader.info;
  sendStatus(
    `已连接：shmring v${shmring.PROTOCOL_VERSION} · ${info.slotCount} 槽环形缓冲 + seqlock`,
    'ok'
  );
  console.log(
    `[electron] attached ${SHM_NAME} (${(info.capacity / 1048576).toFixed(0)} MB, ` +
    `${info.slotCount} slots, protocol v${shmring.PROTOCOL_VERSION}), ` +
    `scanning every ${SCAN_INTERVAL_MS} ms`
  );
  scanSharedMemory();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', stopAll);
