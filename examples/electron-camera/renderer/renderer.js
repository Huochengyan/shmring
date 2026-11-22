// 渲染进程：接收主进程送来的二进制帧，用 Canvas 解码绘制，不依赖任何图片文件。
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const placeholder = document.getElementById('placeholder');
const statusText = document.getElementById('statusText');
const liveDot = document.getElementById('liveDot');
const frameLabel = document.getElementById('frameLabel');
const sourceLabel = document.getElementById('sourceLabel');
const sizeLabel = document.getElementById('sizeLabel');
const toggleBtn = document.getElementById('toggleBtn');
const refreshBtn = document.getElementById('refreshBtn');
const serverInfo = document.getElementById('serverInfo');
const latencyToggle = document.getElementById('latencyToggle');

const els = {
  shmName: document.getElementById('shmName'),
  bufferSize: document.getElementById('bufferSize'),
  fpsValue: document.getElementById('fpsValue'),
  frameId: document.getElementById('frameId'),
  mimeValue: document.getElementById('mimeValue'),
};

let lastDrawnId = -1;
let drawChain = Promise.resolve();
let paused = false;
let framesReceived = 0;
let lastUiUpdate = 0;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 取零拷贝视图：IPC 收到的 buffer 通常是 Uint8Array，直接 new Uint8Array(view)
// 会再复制一份；用底层 ArrayBuffer + byteOffset/byteLength 建视图才不拷贝。
function frameBytes(payload) {
  const src = payload.buffer;
  if (ArrayBuffer.isView(src)) {
    return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  }
  return new Uint8Array(src);
}

// WebCodecs ImageDecoder 直接解码 Uint8Array，省掉 new Blob([...]) 的整帧复制。
// 不可用时回退到 createImageBitmap(Blob)，再不行用 Image + object URL。
async function decodeImage(bytes, mime) {
  if (typeof ImageDecoder !== 'undefined') {
    let decoder = null;
    try {
      decoder = new ImageDecoder({ data: bytes, type: mime });
      const { image } = await decoder.decode();
      return { bitmap: image, decoder };
    } catch (error) {
      if (decoder) decoder.close();
    }
  }
  const blob = new Blob([bytes], { type: mime });
  try {
    return { bitmap: await createImageBitmap(blob), decoder: null };
  } catch (error) {
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

async function drawFrame(payload) {
  const bytes = frameBytes(payload);
  let bitmap;
  let decoder = null;
  try {
    ({ bitmap, decoder } = await decodeImage(bytes, payload.mime));
  } catch (error) {
    return;
  }
  // 主进程一次扫描可能连推多帧；按帧号单调递增绘制，过期帧直接丢弃
  if (payload.id <= lastDrawnId) {
    if (bitmap.close) bitmap.close();
    if (decoder) decoder.close();
    return;
  }
  lastDrawnId = payload.id;

  if (payload.width && payload.height) {
    if (canvas.width !== payload.width) canvas.width = payload.width;
    if (canvas.height !== payload.height) canvas.height = payload.height;
  }
  try {
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally {
    if (bitmap.close) bitmap.close();
    if (decoder) decoder.close();
  }

  // 延迟自检：在画面上叠加毫秒级秒表。摄像头拍屏幕后，照片中
  // "画面里的秒表值"与"左上角秒表值"之差即端到端延迟。
  if (latencyToggle.checked) {
    const now = new Date();
    const text = `${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
    ctx.save();
    ctx.font = 'bold 14px Consolas, monospace';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(8, 8, w + 14, 24);
    ctx.fillStyle = '#3cff6a';
    ctx.fillText(text, 15, 25);
    ctx.restore();
  }

  framesReceived += 1;
  placeholder.classList.add('hidden');
  frameLabel.textContent = `frame #${payload.id}`;
  sizeLabel.textContent = `尺寸：${canvas.width} × ${canvas.height}`;

  const now = performance.now();
  if (now - lastUiUpdate > 300) {
    lastUiUpdate = now;
    refreshStats();
  }
}

async function refreshStats() {
  const stats = await window.api.getStats();
  if (!stats) return;
  els.shmName.textContent = stats.shared_memory_name || '-';
  els.bufferSize.textContent = formatBytes(stats.buffer_bytes);
  els.fpsValue.textContent = stats.fps ? `${stats.fps} fps` : '-';
  els.frameId.textContent = String(stats.frame_id ?? '-');
  els.mimeValue.textContent = stats.mime || '-';
  sourceLabel.textContent = `来源：${stats.source || '-'}`;
}

// 严格按到达顺序串行绘制：一次扫描推送的多帧都会上屏，不会互相覆盖或乱序
window.api.onFrame((payload) => {
  drawChain = drawChain.then(() => drawFrame(payload)).catch(() => {});
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
  serverInfo.textContent = `传输：shmring v${info.protocolVersion || 1}（${info.shmName || '-'}）· ${info.slotCount || 4} 槽环形缓冲 + seqlock · 目标帧率：${info.targetFps} fps`;
  await refreshStats();
})();
