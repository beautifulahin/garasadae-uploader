// ffprobe 없이 영상의 길이·가로세로·회전을 읽는다 — MP4/MOV(ISO-BMFF)와 WebM/MKV(EBML).
//
// 왜 필요한가
//   현재 업로더(파이썬)는 ffprobe 로 쇼츠/롱폼을 판정한다. 이 앱은 단일 실행 파일로 남의 컴퓨터에
//   깔리므로 ffprobe 가 없을 수 있다. 판정에 필요한 값은 파일 머리의 상자(box)에 다 들어 있다.
//     · 길이     moov/mvhd 의 timescale·duration
//     · 크기     moov/trak/tkhd 의 폭·높이, 샘플 항목(stsd)의 코딩 크기
//     · 회전     tkhd 의 변환 행렬 (90°/270° 이면 가로세로가 바뀐다)
//     · 화소비   stsd 안 pasp 상자, 없으면 tkhd 크기와 코딩 크기의 비
//   파일을 통째로 읽지 않는다. 상자 머리만 건너뛰며 읽으므로 수 GB 파일도 몇 KB 만 읽는다.
//
// 돌려주는 값은 ffprobe 경로(shorts.ts)와 같은 꼴이다:
//   { w, h, sar:[a,b], rotation, sec, bytes, codec }
export interface RawMedia {
  w: number; h: number; sar: [number, number]; rotation: number; sec: number; bytes: number; codec: string;
}

class Reader {
  constructor(private f: Deno.FsFile, public size: number) {}
  async at(off: number, len: number): Promise<Uint8Array> {
    if (off < 0 || off >= this.size || len <= 0) return new Uint8Array(0);
    const n = Math.min(len, this.size - off);
    const buf = new Uint8Array(n);
    await this.f.seek(off, Deno.SeekMode.Start);
    let got = 0;
    while (got < n) {
      const k = await this.f.read(buf.subarray(got));
      if (k === null) break;
      got += k;
    }
    return got === n ? buf : buf.subarray(0, got);
  }
}

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const i32 = (b: Uint8Array, o: number) => (u32(b, o) | 0);
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 4294967296 + u32(b, o + 4);
const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

interface Box { type: string; start: number; hdr: number; size: number }

/** off 부터 end 까지의 상자들을 머리만 읽으며 돈다 */
async function* boxes(r: Reader, off: number, end: number): AsyncGenerator<Box> {
  let pos = off;
  while (pos + 8 <= end) {
    const h = await r.at(pos, 16);
    if (h.length < 8) return;
    let size = u32(h, 0);
    const type = fourcc(h, 4);
    let hdr = 8;
    if (size === 1) {
      if (h.length < 16) return;
      size = u64(h, 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - pos; // 파일 끝까지
    }
    if (size < hdr) return; // 깨진 상자
    yield { type, start: pos, hdr, size };
    pos += size;
  }
}

async function find(r: Reader, parent: Box | null, type: string): Promise<Box | null> {
  const [s, e] = parent ? [parent.start + parent.hdr, parent.start + parent.size] : [0, r.size];
  for await (const b of boxes(r, s, e)) if (b.type === type) return b;
  return null;
}

async function payload(r: Reader, b: Box, max = 1 << 16): Promise<Uint8Array> {
  return await r.at(b.start + b.hdr, Math.min(b.size - b.hdr, max));
}

/** tkhd 의 변환 행렬 → 회전 각도(도) */
function rotationFromMatrix(t: Uint8Array, version: number): number {
  const base = version === 1 ? 52 : 40; // 버전·플래그 칸을 포함한 위치 — matrix(36바이트)가 나온다
  if (t.length < base + 36) return 0;
  const a = i32(t, base) / 65536, b = i32(t, base + 4) / 65536;
  if (!a && !b) return 0;
  return Math.round((Math.atan2(b, a) * 180) / Math.PI);
}

/**
 * 조각난(fragmented) MP4 의 길이 — mehd 가 없으면 모든 moof 의 샘플 길이를 더한다.
 * (tfhd 의 기본 길이 → trex 의 기본 길이 순으로 빈 칸을 채운다)
 */
async function fragmentSeconds(r: Reader, moov: Box, trackId: number, timescale: number): Promise<number> {
  let trexDur = 0;
  const mvex = await find(r, moov, "mvex");
  if (mvex) {
    for await (const b of boxes(r, mvex.start + mvex.hdr, mvex.start + mvex.size)) {
      if (b.type !== "trex") continue;
      const p = await payload(r, b, 32);
      if (u32(p, 4) === trackId) trexDur = u32(p, 12);
    }
  }
  let ticks = 0;
  for await (const top of boxes(r, 0, r.size)) {
    if (top.type !== "moof") continue;
    for await (const traf of boxes(r, top.start + top.hdr, top.start + top.size)) {
      if (traf.type !== "traf") continue;
      let defDur = trexDur;
      let mine = false;
      for await (const c of boxes(r, traf.start + traf.hdr, traf.start + traf.size)) {
        if (c.type === "tfhd") {
          const p = await payload(r, c, 64);
          const flags = u32(p, 0) & 0xffffff;
          mine = u32(p, 4) === trackId;
          let o = 8;
          if (flags & 0x1) o += 8;
          if (flags & 0x2) o += 4;
          if (flags & 0x8) defDur = u32(p, o);
        } else if (c.type === "trun" && mine) {
          const p = await payload(r, c, 1 << 20);
          const flags = u32(p, 0) & 0xffffff;
          const count = u32(p, 4);
          let o = 8;
          if (flags & 0x1) o += 4;
          if (flags & 0x4) o += 4;
          const entry = ((flags & 0x100) ? 4 : 0) + ((flags & 0x200) ? 4 : 0) + ((flags & 0x400) ? 4 : 0) + ((flags & 0x800) ? 4 : 0);
          if (flags & 0x100) {
            for (let i = 0; i < count && o + entry <= p.length; i++, o += entry) ticks += u32(p, o);
          } else {
            ticks += defDur * count;
          }
        }
      }
    }
  }
  return ticks / timescale;
}

async function readMp4(r: Reader): Promise<RawMedia> {
  const moov = await find(r, null, "moov");
  if (!moov) throw new Error("moov atom not found");
  const mvhd = await find(r, moov, "mvhd");
  if (!mvhd) throw new Error("mvhd 가 없습니다");
  const mv = await payload(r, mvhd, 128);
  const ver = mv[0];
  const timescale = ver === 1 ? u32(mv, 20) : u32(mv, 12);
  let dur = ver === 1 ? u64(mv, 24) : u32(mv, 16);
  // 조각난(fragmented) MP4 — 길이가 비어 있으면 mehd 를 본다
  let fragmented = false;
  const unknown = ver === 1 ? dur >= 2 ** 53 : dur === 0xffffffff || dur === 0;
  if (unknown) {
    const mvex = await find(r, moov, "mvex");
    const mehd = mvex ? await find(r, mvex, "mehd") : null;
    if (mehd) {
      const m = await payload(r, mehd, 32);
      dur = m[0] === 1 ? u64(m, 4) : u32(m, 4);
    } else if (mvex) {
      fragmented = true; // 길이는 조각(moof)들의 샘플 길이를 더해 구한다
    }
  }
  let sec = timescale ? dur / timescale : 0;

  // 영상 트랙 찾기
  let w = 0, h = 0, codec = "?", rotation = 0, videoTrackId = 0, videoTimescale = 0;
  let sar: [number, number] = [1, 1];
  let trackSec = 0;
  let found = false;
  for await (const trak of boxes(r, moov.start + moov.hdr, moov.start + moov.size)) {
    if (trak.type !== "trak") continue;
    const mdia = await find(r, trak, "mdia");
    if (!mdia) continue;
    const hdlr = await find(r, mdia, "hdlr");
    if (!hdlr) continue;
    const hd = await payload(r, hdlr, 32);
    if (fourcc(hd, 8) !== "vide") continue;
    const tkhd = await find(r, trak, "tkhd");
    if (!tkhd) continue;
    const t = await payload(r, tkhd, 120);
    const tv = t[0];
    videoTrackId = tv === 1 ? u32(t, 20) : u32(t, 12);
    const tw = (tv === 1 ? u32(t, 88) : u32(t, 76)) / 65536;
    const th = (tv === 1 ? u32(t, 92) : u32(t, 80)) / 65536;
    rotation = rotationFromMatrix(t, tv);
    const mdhd = await find(r, mdia, "mdhd");
    if (mdhd) {
      const m = await payload(r, mdhd, 64);
      const ts = m[0] === 1 ? u32(m, 20) : u32(m, 12);
      const d = m[0] === 1 ? u64(m, 24) : u32(m, 16);
      videoTimescale = ts;
      if (ts && d && d < 0xffffffff) trackSec = d / ts;
    }
    // 샘플 항목: 코딩 크기·코덱·화소비
    const minf = await find(r, mdia, "minf");
    const stbl = minf ? await find(r, minf, "stbl") : null;
    const stsd = stbl ? await find(r, stbl, "stsd") : null;
    let cw = 0, ch = 0;
    if (stsd) {
      const sd = await payload(r, stsd, 4096);
      // stsd: version/flags(4) + entry_count(4) 뒤에 첫 항목
      if (sd.length >= 8 + 86) {
        const e = 8;
        codec = fourcc(sd, e + 4);
        cw = u16(sd, e + 32);
        ch = u16(sd, e + 34);
        // 자식 상자(avcC·pasp …)는 항목 머리 86바이트 뒤부터
        const entrySize = u32(sd, e);
        let p = e + 86;
        const end = Math.min(sd.length, e + entrySize);
        while (p + 8 <= end) {
          const sz = u32(sd, p);
          const ty = fourcc(sd, p + 4);
          if (sz < 8) break;
          if (ty === "pasp" && p + 16 <= sd.length) {
            const hs = u32(sd, p + 8), vs = u32(sd, p + 12);
            if (hs > 0 && vs > 0) sar = [hs, vs];
          }
          p += sz;
        }
      }
    }
    if (cw && ch) {
      w = cw; h = ch;
      // pasp 가 없는데 트랙 표시 크기와 코딩 크기가 다르면 그 비로 화소비를 정한다 (ffmpeg 와 같은 규칙)
      if (sar[0] === 1 && sar[1] === 1 && tw && th && (Math.abs(tw - cw) > 0.5 || Math.abs(th - ch) > 0.5)) {
        const a = Math.round((tw / th) * ch * 1000), b = Math.round(cw * 1000);
        if (a > 0 && b > 0) sar = [a, b];
      }
    } else {
      w = Math.round(tw); h = Math.round(th);
    }
    found = true;
    break;
  }
  if (!found) throw new Error("영상 트랙이 없습니다");
  if ((!sec || !Number.isFinite(sec)) && fragmented && videoTimescale) {
    sec = await fragmentSeconds(r, moov, videoTrackId, videoTimescale);
  }
  if (!sec || !Number.isFinite(sec)) sec = trackSec;
  if (!sec) throw new Error("영상 길이를 읽지 못했습니다");
  return { w, h, sar, rotation, sec, bytes: r.size, codec };
}

/* ───────────── WebM / MKV (EBML) ───────────── */

interface Vint { value: number; len: number; unknown: boolean }

function readVint(b: Uint8Array, o: number, keepMarker: boolean): Vint | null {
  if (o >= b.length) return null;
  const first = b[o];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8 || o + len > b.length) return null;
  let v = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[o + i];
    if (b[o + i] !== 0xff) allOnes = false;
  }
  return { value: v, len, unknown: !keepMarker && allOnes };
}

const ID = {
  Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, TrackEntry: 0xae, TrackType: 0x83, Video: 0xe0, PixelWidth: 0xb0, PixelHeight: 0xba,
  DisplayWidth: 0x54b0, DisplayHeight: 0x54ba, CodecID: 0x86, Projection: 0x7670, PoseRoll: 0x7675,
  Cluster: 0x1f43b675,
};

async function readMkv(r: Reader): Promise<RawMedia> {
  // 앞쪽 2MB 안에 Info·Tracks 가 있다 (Cluster 보다 앞)
  const head = await r.at(0, Math.min(r.size, 2 * 1024 * 1024));
  const st = { scale: 1_000_000, dur: 0, w: 0, h: 0, dw: 0, dh: 0, codec: "?", roll: 0 };

  /** 한 트랙 항목 안: 영상 칸이 있으면 그 값을 확정한다 (오디오 트랙은 Video 칸이 없다) */
  const track = (from: number, to: number) => {
    const t = { w: 0, h: 0, dw: 0, dh: 0, codec: "?", roll: 0, video: false };
    each(from, to, (id, body, end) => {
      if (id === ID.CodecID) t.codec = new TextDecoder().decode(head.subarray(body, end));
      else if (id === ID.Video) {
        t.video = true;
        each(body, end, (vid, vb, ve) => {
          if (vid === ID.PixelWidth) t.w = readUInt(head, vb, ve - vb);
          else if (vid === ID.PixelHeight) t.h = readUInt(head, vb, ve - vb);
          else if (vid === ID.DisplayWidth) t.dw = readUInt(head, vb, ve - vb);
          else if (vid === ID.DisplayHeight) t.dh = readUInt(head, vb, ve - vb);
          else if (vid === ID.Projection) {
            each(vb, ve, (pid, pb, pe) => { if (pid === ID.PoseRoll) t.roll = readFloat(head, pb, pe - pb); });
          }
        });
      }
    });
    if (t.video && !st.w) Object.assign(st, { w: t.w, h: t.h, dw: t.dw, dh: t.dh, codec: t.codec, roll: t.roll });
  };

  /** from~to 사이의 요소들을 돌며 (id, 본문 시작, 본문 끝)을 알려 준다 */
  function each(from: number, to: number, fn: (id: number, body: number, end: number) => void) {
    let p = from;
    while (p < to) {
      const id = readVint(head, p, true);
      if (!id) return;
      const sz = readVint(head, p + id.len, false);
      if (!sz) return;
      const body = p + id.len + sz.len;
      const end = sz.unknown ? to : Math.min(to, body + sz.value);
      if (id.value === ID.Cluster) return; // 여기부터는 영상 데이터
      fn(id.value, body, end);
      if (end <= p) return;
      p = end;
    }
  }

  const first = readVint(head, 0, true);
  if (!first || first.value !== 0x1a45dfa3) throw new Error("WebM/MKV 파일이 아닙니다");
  each(0, head.length, (id, body, end) => {
    if (id !== ID.Segment) return;
    each(body, end, (sid, sb, se) => {
      if (sid === ID.Info) {
        each(sb, se, (iid, ib, ie) => {
          if (iid === ID.TimecodeScale) st.scale = readUInt(head, ib, ie - ib);
          else if (iid === ID.Duration) st.dur = readFloat(head, ib, ie - ib);
        });
      } else if (sid === ID.Tracks) {
        each(sb, se, (tid, tb, te) => { if (tid === ID.TrackEntry) track(tb, te); });
      }
    });
  });
  if (!st.w || !st.h) throw new Error("영상 트랙이 없습니다");
  if (!st.dur) throw new Error("영상 길이를 읽지 못했습니다");
  // 표시 크기가 코딩 크기와 다르면 그 비로 화소비를 정한다
  let sar: [number, number] = [1, 1];
  if (st.dw && st.dh && (st.dw !== st.w || st.dh !== st.h)) sar = [st.dw * st.h, st.dh * st.w];
  return { w: st.w, h: st.h, sar, rotation: Math.round(st.roll), sec: (st.dur * st.scale) / 1e9, bytes: r.size, codec: st.codec };
}

function readUInt(b: Uint8Array, o: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[o + i];
  return v;
}
function readFloat(b: Uint8Array, o: number, len: number): number {
  const dv = new DataView(b.buffer, b.byteOffset + o, len);
  return len === 4 ? dv.getFloat32(0) : len === 8 ? dv.getFloat64(0) : 0;
}

/** 컨테이너를 보고 알맞은 읽기로 보낸다. 못 읽으면 Error. */
export async function probeNative(path: string): Promise<RawMedia> {
  const st = await Deno.stat(path);
  const f = await Deno.open(path, { read: true });
  try {
    const r = new Reader(f, st.size);
    const head = await r.at(0, 16);
    if (head.length < 8) throw new Error("파일이 너무 작습니다");
    if (u32(head, 0) === 0x1a45dfa3) return await readMkv(r);
    // ISO-BMFF: 첫 상자 종류가 ftyp / moov / mdat / free / wide / skip …
    const t = fourcc(head, 4);
    if (["ftyp", "moov", "mdat", "free", "wide", "skip", "pnot", "junk"].includes(t)) return await readMp4(r);
    throw new Error(`이 컴퓨터에는 ffprobe 가 없어 이 형식(${t.replace(/[^\x20-\x7e]/g, "?")})은 읽지 못합니다`);
  } finally {
    try { f.close(); } catch { /* 무시 */ }
  }
}
