/**
 * 生成 id 与哈希，**不依赖安全上下文**。
 *
 * 为什么需要这个文件：
 *   `crypto.randomUUID()` 与 `crypto.subtle` 只在「安全上下文」里存在
 *   （HTTPS，或 localhost / 127.0.0.1 这种被浏览器视为可信的来源）。
 *   用明文 HTTP + 公网 IP 访问时它们是 `undefined`，调用即抛
 *   `crypto.randomUUID is not a function` —— 现象就是「点了按钮没反应」。
 *
 *   而 `crypto.getRandomValues()` 在任何上下文里都有，所以这里用它兜底；
 *   哈希在拿不到 `crypto.subtle` 时退回到本文件里的纯 JS SHA-256，
 *   与 `node:crypto` 的 `sha256` 结果逐字节一致（有测试守着）。
 */

/** 十六进制字符表 */
const HEX = "0123456789abcdef";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
  return out;
}

/**
 * 32 位十六进制随机 id。
 *
 * 优先级：randomUUID（安全上下文）→ getRandomValues（所有上下文）→
 * 时间戳 + Math.random（最后的兜底，只用于本机展示用的临时 id）。
 */
export function randomId(source: Crypto | undefined = globalThis.crypto): string {
  if (source) {
    if (typeof source.randomUUID === "function") {
      try {
        return source.randomUUID();
      } catch {
        // 某些实现会抛（例如老 Safari 的 crypto 被替换过），继续往下走
      }
    }
    if (typeof source.getRandomValues === "function") {
      try {
        return toHex(source.getRandomValues(new Uint8Array(16)));
      } catch {
        // 同上
      }
    }
  }
  const time = Date.now().toString(16);
  const rand = Math.random().toString(16).slice(2, 10);
  return `${time}${rand}`.padEnd(16, "0").slice(0, 32);
}

// ---------------------------------------------------------------------------
// SHA-256
//
// 有 crypto.subtle 就用它（快、原生）；没有就用下面的纯 JS 实现。
// 服务端用 node:crypto 算同一个哈希，两边必须一致，否则前端会报
// 「分析上下文不匹配」——tests/core.test.ts 里对着已知向量做了校验。
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** 纯 JS SHA-256，返回十六进制小写串。 */
export function sha256HexSync(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  // 补位：0x80 + 若干 0 + 64 位长度
  const withPadding = new Uint8Array(
    (((bytes.length + 8) >> 6) + 1) << 6,
  );
  withPadding.set(bytes);
  withPadding[bytes.length] = 0x80;
  const view = new DataView(withPadding.buffer);
  // 长度高 32 位：JS 字符串不可能到 2^32 字节，这里固定写 0
  view.setUint32(withPadding.length - 4, bitLength >>> 0, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let i = 0; i < 16; i++)
      w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let out = "";
  // 逐字节按大端序输出，不依赖平台字节序
  for (const word of h)
    for (let shift = 24; shift >= 0; shift -= 8)
      out += ((word >>> shift) & 0xff).toString(16).padStart(2, "0");
  return out;
}

/**
 * SHA-256（十六进制小写）。优先用 `crypto.subtle`，拿不到就退回纯 JS 实现。
 *
 * `source` 可注入，便于测试两条路径都覆盖。
 */
export async function sha256Hex(
  text: string,
  source: Crypto | undefined = globalThis.crypto,
): Promise<string> {
  const subtle = source?.subtle;
  if (subtle && typeof subtle.digest === "function") {
    try {
      const digest = await subtle.digest(
        "SHA-256",
        new TextEncoder().encode(text),
      );
      return toHex(new Uint8Array(digest));
    } catch {
      // 某些环境下 subtle 存在却不可用（权限/策略），退回纯 JS
    }
  }
  return sha256HexSync(text);
}
