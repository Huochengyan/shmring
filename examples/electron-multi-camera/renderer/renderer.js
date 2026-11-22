// 渲染进程：一次批量 IPC 收到 5 路帧，按 camId 分发到各自的 Canvas。
//
// 每路一个串行绘制链（帧号单调保护），全局再加一个解码信号量：
// 5 路最多同时 3 个 ImageDecoder 在跑，避免 5×30fps 的 PNG 解码把 CPU 打满。

const grid = document.getElementById('grid');
const statusText = document.getElementById('statusText');
const liveDot = document.getElementById('liveDot');
const framesLabel = document.getElementById('framesLabel');
const scanLabel = document.getElementById('scanLabel');
const toggleBtn = document.getElementById('toggleBtn');
const refreshBtn = document.getElementById('refreshBtn');
const serverInfo = document.getElementById('serverInfo');
const camRows = document.getElementById('camRows');

const els = {
  totalFps: document.getElementById('totalFps'),
  avgAge: document.getElementById('avgAge'),
  totalDropped: document.getElementById('totalDropped'),
  camCount: document.getElementById('camCount'),
  transport: document.getElementById('transport'),
  uptime: document.getElementById('uptime'),
};

const tiles = [];
const rows = [];
let paused = false;
let framesReceived = 0;

// ---- 全局解码并发限制 ----
const MAX_DECODE = 3;
let decodeActive = 0;
const decodeWaiters = [];

function acquireDecode() {
  return new Promise((resolve) => {
    if (decodeActive < MAX_DECODE) {
      decodeActive++;
      resolve();
    } else {
      decodeWaiters.push(resolve);
    }
  });
}

function releaseDecode() {
  const next = decodeWaiters.shift();
  if (next) next();            // 名额直接交接给下一个等待者
  else decodeActive--;
}

// IPC 收到的 buffer 通常是 Uint8Array；用底层 ArrayBuffer + byteOffset
// 建视图，避免 new Uint8Array(view) 再复制一份。
function frameBytes(payload) {
  const src = payload.buffer;
  if (ArrayBuffer.isView(src)) {
    return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  }
  return new Uint8Array(src);
}

async function decodeImage(bytes, mime) {
  if (typeof ImageDecoder !== 'undefined') {
    let decoder = null;
    try {
      decoder = new ImageDecoder({ data: bytes, type: mime });
      const { image } = await decoder.decode();
      return { bitmap: image, decoder };
    } catch (_) {
      if (decoder) decoder.close();
    }
  }
  const blob = new Blob([bytes], { type: mime });
  try {
    return { bitmap: await createImageBitmap(blob), decoder: null };
  } catch (_) {
    const url = URL.createObjectURL(blob);
    const bitmap = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = reject;
      image.src = url;
    });
    return { bitmap, decoder: null };
  }
}

const firstDraws = [];
let renderCheckSent = false;

function reportFirstDraw(tile, camId) {
  if (tile.reported) return;
  tile.reported = true;
  let nonBlack = false;
  try {
    const px = tile.ctx.getImageData(
      Math.floor(tile.canvas.width / 2),
      Math.floor(tile.canvas.height / 2),
      1,
      1
    ).data;
    nonBlack = px[0] + px[1] + px[2] > 30;
  } catch (_) {
    // 取像素失败不影响绘制
  }
  firstDraws.push({ camId, nonBlack });
  if (!renderCheckSent && firstDraws.length === tiles.length) {
    renderCheckSent = true;
    window.api.reportRenderCheck(firstDraws);
  }
}

async function drawFrame(tile, payload) {
  await acquireDecode();
  let bitmap = null;
  let decoder = null;
  try {
    const bytes = frameBytes(payload);
    ({ bitmap, decoder } = await decodeImage(bytes, payload.mime));
    if (payload.id <= tile.lastDrawnId) return;   // 过期帧直接丢弃
    tile.lastDrawnId = payload.id;
    if (payload.width && payload.height) {
      if (tile.canvas.width !== payload.width) tile.canvas.width = payload.width;
      if (tile.canvas.height !== payload.height) tile.canvas.height = payload.height;
    }
    tile.ctx.drawImage(bitmap, 0, 0, tile.canvas.width, tile.canvas.height);
    tile.placeholder.classList.add('hidden');
    tile.idEl.textContent = `#${payload.id}`;
    reportFirstDraw(tile, payload.camId);
  } catch (_) {
    // 单帧解码失败不影响后续帧
  } finally {
    if (bitmap && bitmap.close) bitmap.close();
    if (decoder) decoder.close();
    releaseDecode();
  }
}

function createTile(camId, name) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML =
    '<div class="tile-head">' +
      '<span class="dot" data-dot></span>' +
      `<strong>CAM ${camId}</strong>` +
      '<span class="tile-fps" data-fps>-</span>' +
      '<span class="tile-id" data-id>#-</span>' +
    '</div>' +
    '<div class="tile-canvas">' +
      '<canvas width="640" height="360"></canvas>' +
      '<div class="tile-placeholder">等待帧…</div>' +
    '</div>' +
    `<div class="tile-foot">${name}</div>`;
  grid.appendChild(el);
  tiles.push({
    canvas: el.querySelector('canvas'),
    ctx: el.querySelector('canvas').getContext('2d'),
    dot: el.querySelector('[data-dot]'),
    fpsEl: el.querySelector('[data-fps]'),
    idEl: el.querySelector('[data-id]'),
    placeholder: el.querySelector('.tile-placeholder'),
    chain: Promise.resolve(),
    lastDrawnId: -1,
  });

  const tr = document.createElement('tr');
  tr.innerHTML = `<td>CAM ${camId}</td><td data-fps>-</td><td data-id>-</td><td data-drop>0</td><td data-state>离线</td>`;
  camRows.appendChild(tr);
  rows.push({
    fps: tr.querySelector('[data-fps]'),
    id: tr.querySelector('[data-id]'),
    drop: tr.querySelector('[data-drop]'),
    state: tr.querySelector('[data-state]'),
  });
}

async function refreshStats() {
  const stats = await window.api.getStats();
  if (!stats) return;
  els.totalFps.textContent = `${stats.total_fps} fps`;
  els.avgAge.textContent = `${stats.avg_age_ms} ms`;
  els.totalDropped.textContent = String(stats.total_dropped);
  els.camCount.textContent = `${stats.cams.length} 段`;
  els.transport.textContent = `${stats.transport} v${stats.protocol_version}`;
  els.uptime.textContent = `${stats.uptime_seconds} s`;

  for (const c of stats.cams) {
    const i = c.cam_id - 1;
    if (!rows[i] || !tiles[i]) continue;
    rows[i].fps.textContent = `${c.fps} fps`;
    rows[i].id.textContent = `#${c.frame_id}`;
    rows[i].drop.textContent = String(c.dropped);
    rows[i].state.textContent = c.online ? '在线' : '离线';
    rows[i].state.className = c.online ? 'online' : 'offline';
    tiles[i].fpsEl.textContent = `${c.fps} fps`;
    tiles[i].dot.className = `dot ${c.online ? 'ok' : 'error'}`;
  }
}

// 一次批量 IPC：按 camId 分发，每路各自串行绘制，全局解码并发受信号量约束。
window.api.onFrames((frames) => {
  for (const f of frames) {
    const tile = tiles[f.camId - 1];
    if (!tile) continue;
    tile.chain = tile.chain.then(() => drawFrame(tile, f)).catch(() => {});
  }
  framesReceived += frames.length;
  framesLabel.textContent = `已收 ${framesReceived} 帧`;
});

window.api.onStatus(({ text, level }) => {
  statusText.textContent = text;
  liveDot.className = `dot ${level || ''}`;
});

toggleBtn.addEventListener('click', () => {
  paused = !paused;
  window.api.setPaused(paused);
  toggleBtn.textContent = paused ? '继续画面' : '暂停画面';
});

refreshBtn.addEventListener('click', refreshStats);

(async () => {
  const info = await window.api.getServerInfo();
  for (let i = 0; i < info.camCount; i++) createTile(i + 1, info.names[i]);
  serverInfo.textContent =
    `shmring v${info.protocolVersion} · ${info.camCount} 段 · ` +
    `目标 ${info.targetFps} fps/路 · 每段 ${info.bufferKb} KB · Python pid ${info.pythonPid}`;
  scanLabel.textContent = `单循环 ${info.scanIntervalMs}ms 扫全部 reader`;
  await refreshStats();
  setInterval(refreshStats, 400);
})();
