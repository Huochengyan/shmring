// 独立验证脚本：不启动 Electron，直接用 shmring 读 Python 写的段并保存一帧。
// 协议布局、seqlock、平台 FFI 全部由库负责；这里只解析每帧 meta 里的图像语义。
//
// 用法: node node-shm-reader.js [段名] [输出图片路径]
//   python python/server.py --no-http --name shmring_demo
//   node node-shm-reader.js shmring_demo out.jpg

const fs = require('fs');

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
    '未找到 shmring 库：请在 shmring 仓库根执行 npm install，' +
    `或 npm install shmring。最后一次错误：${lastError && lastError.message}`
  );
}

const { ShmRingReader } = loadShmring();

const NAME = process.argv[2] || 'shmring_demo';
const OUT = process.argv[3] || 'node-shm-frame.jpg';

const reader = new ShmRingReader(NAME);
try {
  const frame = reader.read();
  if (!frame) throw new Error(`段 ${NAME} 中还没有完整帧（或一直在撕裂重试）`);

  let meta = {};
  try {
    meta = JSON.parse(frame.meta.toString('utf8') || '{}');
  } catch (_) {
    // meta 损坏不影响保存图像字节
  }
  const mime = meta.mime || 'image/jpeg';
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  const out = ext === 'png' && OUT.endsWith('.jpg') ? OUT.replace(/\.jpg$/, '.png') : OUT;
  fs.writeFileSync(out, frame.payload);

  const info = reader.info;
  console.log(JSON.stringify({
    attached_to: NAME,
    frame_id: frame.frameId,
    seq_even: frame.seq % 2 === 0,
    protocol_version: info.protocolVersion,
    slot_count: info.slotCount,
    slot_size: info.slotSize,
    width: meta.w || 0,
    height: meta.h || 0,
    mime,
    payload_bytes: frame.payload.length,
    payload_head_hex: frame.payload.subarray(0, 4).toString('hex'),
    frame_age_ms: Date.now() - frame.stamp,
    saved_to: out,
  }, null, 2));
} finally {
  reader.close();
}
