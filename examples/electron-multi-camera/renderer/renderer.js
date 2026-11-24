// 渲染进程：一次批量 IPC 收到 5 路帧，按 camId 分发到各自的 Canvas。
//
// 每路一个串行绘制链（帧号单调保护），全局再加一个解码信号量：
// 5 路最多同时 3 个 ImageDecoder 在跑，避免 5×30fps 的 PNG 解码把 CPU 打满。

const grid = document.getElementById('grid');
const statusText = document.getElementById('statusText');
const liveDot = document.getElementById('liveDot');
const framesLabel = document.getElementById('framesLabel');
const scanLabel = document.getElementById('scanLabel');
const scanInput = document.getElementById('scanInput');

function applyScanInterval() {
  const next = Math.round(Number(scanInput.value));
  if (!Number.isFinite(next)) return;
  const ms = Math.min(5000, Math.max(1, next));
  scanInput.value = String(ms);
  window.api.setScanInterval(ms);
  scanLabel.textContent = `单循环 ${ms}ms 扫全部 reader`;
}

scanInput.addEventListener('change', applyScanInterval);
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
    title: el.querySelector('strong'),
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
    tiles[i].title.textContent = c.src === 'camera' ? `CAM ${c.cam_id} · 摄像头` : `CAM ${c.cam_id}`;
    tiles[i].dot.className = `dot ${c.online ? 'ok' : 'error'}`;
  }
  const badge = document.getElementById('badge');
  if (badge) {
    badge.textContent = stats.source === 'camera'
      ? `shmring v${stats.protocol_version} · 1 路摄像头`
      : `shmring v${stats.protocol_version} · 合成帧`;
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

const seriesView = document.getElementById('view-series');
const videoView = document.getElementById('view-video');
const seriesCanvas = document.getElementById('seriesChart');
const seriesStatus = document.getElementById('seriesStatus');
const seriesDot = document.getElementById('seriesDot');
const seriesLabel = document.getElementById('seriesLabel');
const seriesSeqEl = document.getElementById('seriesSeq');
const seriesIndexEl = document.getElementById('seriesIndex');
const seriesDroppedEl = document.getElementById('seriesDropped');
const seriesPpsEl = document.getElementById('seriesPps');
const seriesPacketEl = document.getElementById('seriesPacket');
const seriesHzEl = document.getElementById('seriesHz');
const seriesChannelsEl = document.getElementById('seriesChannels');
const seriesRateEl = document.getElementById('seriesRate');
const seriesDrawEl = document.getElementById('seriesDraw');
const seriesWindowLabel = document.getElementById('seriesWindow');
const SERIES_MAX_SECONDS = 20;
let seriesHz = 512;
let seriesChannels = 160;
let seriesSeconds = 10;
let seriesCapacity = SERIES_MAX_SECONDS * seriesHz;
let seriesPlanes = [];
let seriesIndex = new Int32Array(seriesCapacity);
seriesIndex.fill(-1);
let seriesLatest = -1;
let seriesSamples = 0;
let seriesPacketMarks = [];
let seriesByteMarks = [];
let seriesDrawMs = 0;

document.querySelectorAll('.menu-item').forEach((button) => {
  button.addEventListener('click', () => {
    const view = button.dataset.view;
    document.querySelectorAll('.menu-item').forEach((item) => {
      item.classList.toggle('active', item === button);
    });
    videoView.hidden = view !== 'video';
    seriesView.hidden = view !== 'series';
    if (view === 'series') drawSeries();
  });
});

document.getElementById('windowPicks').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-seconds]');
  if (!button) return;
  seriesSeconds = Number(button.dataset.seconds);
  document.querySelectorAll('#windowPicks button').forEach((item) => {
    item.classList.toggle('active', item === button);
  });
  seriesWindowLabel.textContent = `窗口 ${seriesSeconds} 秒`;
  drawSeries();
});

function ensureSeriesBuffers(hz, channels) {
  const rate = hz > 0 ? hz : seriesHz;
  const count = channels > 0 ? channels : seriesChannels;
  const need = SERIES_MAX_SECONDS * rate;
  if (seriesPlanes.length === count && seriesCapacity === need && seriesHz === rate) return;
  seriesHz = rate;
  seriesChannels = count;
  seriesCapacity = need;
  seriesPlanes = Array.from({ length: count }, () => new Float32Array(need));
  seriesIndex = new Int32Array(need);
  seriesIndex.fill(-1);
  seriesLatest = -1;
}

function packetFloats(payload) {
  const bytes = payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload;
  if (!bytes || bytes.byteLength < 4) return new Float32Array(0);
  if ((bytes.byteOffset % 4) !== 0) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Float32Array(copy.buffer);
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

function pushSeries(packet) {
  const channels = Number(packet.channels) || 1;
  const hz = Number(packet.hz) || seriesHz;
  ensureSeriesBuffers(hz, channels);
  const values = packetFloats(packet.payload);
  const count = Number(packet.n) || Math.floor(values.length / channels);
  const originValue = Number(packet.i0);
  const origin = Number.isFinite(originValue) ? originValue : 0;
  for (let s = 0; s < count; s++) {
    const index = origin + s;
    const slot = index % seriesCapacity;
    seriesIndex[slot] = index;
    const base = s * channels;
    for (let c = 0; c < channels; c++) seriesPlanes[c][slot] = values[base + c];
    seriesLatest = index;
  }
  seriesSamples += count;
  const now = Date.now();
  const size = packet.payload && packet.payload.byteLength ? packet.payload.byteLength : values.byteLength;
  seriesPacketMarks.push(now);
  seriesByteMarks.push({ t: now, n: size });
  if (seriesPacketMarks.length > 80) seriesPacketMarks.shift();
  if (seriesByteMarks.length > 80) seriesByteMarks.shift();
}

function seriesPps() {
  if (seriesPacketMarks.length < 2) return 0;
  const span = seriesPacketMarks[seriesPacketMarks.length - 1] - seriesPacketMarks[0];
  if (span <= 0) return 0;
  return Math.round(((seriesPacketMarks.length - 1) * 1000) / span);
}

function seriesMegabytesPerSec() {
  if (seriesByteMarks.length < 2) return 0;
  const span = seriesByteMarks[seriesByteMarks.length - 1].t - seriesByteMarks[0].t;
  if (span <= 0) return 0;
  let bytes = 0;
  for (let i = 1; i < seriesByteMarks.length; i++) bytes += seriesByteMarks[i].n;
  return bytes / span / 1000;
}

function drawSeries() {
  const started = performance.now();
  const canvas = seriesCanvas;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width < 2 || height < 2) return;
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  const pad = { l: 36, r: 12, t: 8, b: 22 };
  const plotW = Math.max(1, width - pad.l - pad.r);
  const plotH = Math.max(1, height - pad.t - pad.b);
  const channels = seriesPlanes.length;
  if (seriesLatest < 0 || channels === 0) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px "Segoe UI", sans-serif';
    ctx.fillText('等待 160 导数据…', pad.l, pad.t + 24);
    return;
  }

  const visible = Math.max(1, seriesSeconds * seriesHz);
  const start = Math.max(0, seriesLatest - visible + 1);
  const columns = Math.max(1, Math.floor(plotW));
  const band = plotH / channels;
  const amp = 1.6;
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#38bdf8';
  ctx.fillStyle = '#64748b';
  ctx.font = '10px "Segoe UI", sans-serif';
  for (let c = 0; c < channels; c++) {
    const top = pad.t + c * band;
    const mid = top + band * 0.5;
    const half = Math.max(0.6, band * 0.42);
    const plane = seriesPlanes[c];
    ctx.beginPath();
    let drawing = false;
    for (let col = 0; col < columns; col++) {
      const i0 = start + Math.floor((col * visible) / columns);
      const i1 = start + Math.floor(((col + 1) * visible) / columns);
      let min = Infinity;
      let max = -Infinity;
      for (let index = i0; index < i1; index++) {
        const slot = index % seriesCapacity;
        if (seriesIndex[slot] !== index) continue;
        const value = plane[slot];
        if (value < min) min = value;
        if (value > max) max = value;
      }
      if (!Number.isFinite(min)) {
        drawing = false;
        continue;
      }
      const x = pad.l + col;
      const y1 = mid - (max / amp) * half;
      const y2 = mid - (min / amp) * half;
      if (!drawing) {
        ctx.moveTo(x, y1);
        drawing = true;
      }
      ctx.lineTo(x, y1);
      if (y2 !== y1) ctx.lineTo(x, y2);
    }
    ctx.stroke();
    if (c % 20 === 0) ctx.fillText(String(c + 1), 4, mid + 3);
  }
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px "Segoe UI", sans-serif';
  ctx.fillText(`${seriesSeconds} s`, pad.l, height - 6);
  ctx.fillText('现在', pad.l + plotW - 24, height - 6);
  seriesDrawMs = performance.now() - started;
}

window.api.onSeries((message) => {
  for (const packet of message.packets || []) pushSeries(packet);
  seriesStatus.textContent = '时序数据已连接';
  seriesDot.className = 'dot ok';
  seriesLabel.textContent = `已收 ${seriesSamples} 个采样点 × ${seriesChannels} 导`;
  seriesHzEl.textContent = `${seriesHz} Hz`;
  seriesChannelsEl.textContent = String(seriesChannels);
  const last = message.packets && message.packets.length
    ? message.packets[message.packets.length - 1]
    : null;
  if (last) {
    const count = Number(last.n) || 0;
    const hz = Number(last.hz) || seriesHz;
    const ms = hz > 0 ? Math.round((count / hz) * 1000) : 0;
    const kb = last.payload && last.payload.byteLength ? (last.payload.byteLength / 1024).toFixed(1) : '-';
    seriesSeqEl.textContent = `#${last.seq}`;
    seriesIndexEl.textContent = String((Number(last.i0) || 0) + count - 1);
    seriesPacketEl.textContent = `${ms} ms / ${count} 点 / ${kb} KB`;
  }
  seriesDroppedEl.textContent = String(message.dropped || 0);
  seriesPpsEl.textContent = `${seriesPps()} 包/s`;
  seriesRateEl.textContent = `${seriesMegabytesPerSec().toFixed(2)} MB/s`;
  seriesDrawEl.textContent = `${seriesDrawMs.toFixed(1)} ms`;
});

function paintSeries() {
  if (!seriesView.hidden) drawSeries();
  requestAnimationFrame(paintSeries);
}
requestAnimationFrame(paintSeries);

(async () => {
  const info = await window.api.getServerInfo();
  for (let i = 0; i < info.camCount; i++) createTile(i + 1, info.names[i]);
  serverInfo.textContent =
    `shmring v${info.protocolVersion} · ${info.camCount} 段 · ` +
    `目标 ${info.targetFps} fps/路 · 每段 ${info.bufferKb} KB · Python pid ${info.pythonPid}`;
  scanLabel.textContent = `单循环 ${info.scanIntervalMs}ms 扫全部 reader`;
  scanInput.value = String(info.scanIntervalMs);
  await refreshStats();
  setInterval(refreshStats, 400);
})();
