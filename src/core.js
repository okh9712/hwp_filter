/*
 * HWP(5.x 바이너리) 문항 필터 - 핵심 로직
 * 브라우저와 Node 양쪽에서 동작 (전역 CFB 필요)
 *
 * 동작 요약
 *  1) OLE 컨테이너를 읽고 BodyText/SectionN 을 압축 해제
 *  2) 최상위 문단을 "[25년 10월 19번]" 또는 "┃9월 18번┃" 같은 태그 기준으로 문항 블록으로 묶음
 *     - 태그 없는 후속 문항("윗글의 ...")은 직전 블록에 귀속
 *  3) 선택되지 않은 블록의 레코드를 통째로 제거하고 다시 압축/저장
 */
(function (root) {
  'use strict';

  const TAG_PARA_HEADER = 66;
  const TAG_PARA_TEXT = 67;
  const TAG_DOC_PROPERTIES = 16;

  /* ---------- 압축 ---------- */
  // 이 파일의 압축 스트림은 raw deflate 뒤에 CRC32(4)+원본크기(4) 8바이트가 붙어 있다.
  // (한글이 그대로 읽는 형식이므로 저장 시에도 동일하게 재현한다.)
  let CRC_TABLE = null;
  function crc32(u8) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function inflateRaw(u8) {
    const out = fflate.inflateSync(u8); // 스트림 끝 이후의 잔여 바이트는 무시
    const hasTrailer = u8.length >= 8 && new DataView(u8.buffer, u8.byteOffset, u8.length).getUint32(u8.length - 4, true) === out.length;
    return { out, hasTrailer };
  }
  function deflateRaw(u8, trailer) {
    const z = fflate.deflateSync(u8, { level: 9 });
    if (!trailer) return z;
    const r = new Uint8Array(z.length + 8);
    r.set(z, 0);
    const dv = new DataView(r.buffer);
    dv.setUint32(z.length, crc32(u8), true);
    dv.setUint32(z.length + 4, u8.length, true);
    return r;
  }

  /* ---------- 레코드 ---------- */
  function scanRecords(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const recs = [];
    let pos = 0;
    while (pos < buf.length) {
      const start = pos;
      if (pos + 4 > buf.length) throw new Error('레코드 헤더가 잘렸습니다.');
      const h = dv.getUint32(pos, true);
      pos += 4;
      const tag = h & 0x3ff;
      const level = (h >>> 10) & 0x3ff;
      let size = h >>> 20;
      if (size === 0xfff) {
        size = dv.getUint32(pos, true);
        pos += 4;
      }
      if (pos + size > buf.length) throw new Error('레코드 크기가 범위를 벗어났습니다.');
      recs.push({ tag, level, start, dataStart: pos, end: pos + size });
      pos += size;
    }
    return recs;
  }

  /* ---------- 문단 텍스트 ---------- */
  function parseParaText(buf, ds, de) {
    const out = [];
    let has17 = false;
    let hasSecd = false;
    let hasObj = false;
    let i = ds;
    while (i + 1 < de) {
      const c = buf[i] | (buf[i + 1] << 8);
      if (c >= 32) {
        out.push(String.fromCharCode(c));
        i += 2;
      } else if (c === 0 || c === 10 || c === 13 || (c >= 24 && c <= 31)) {
        if (c === 10) out.push('\n');
        i += 2;
      } else {
        // 인라인/확장 컨트롤: 16바이트
        if (c === 17) {
          has17 = true;
          out.push('\u0011');
        } else if (c === 9) {
          out.push(' ');
        }
        if (c === 11) hasObj = true; // 그림/표/도형 등
        if (c === 2) {
          const id = String.fromCharCode(buf[i + 5], buf[i + 4], buf[i + 3], buf[i + 2]);
          if (id === 'secd') hasSecd = true;
        }
        i += 16;
      }
    }
    return { plain: out.join(''), has17, hasSecd, hasObj };
  }

  /* ---------- 태그 해석 ---------- */
  // 지원 형식
  //  1) 문단 맨 끝의 대괄호 태그: "[25년 10월 41번~42번]", "[25년 10월 23번 변형]", "[학교프린트]" ...
  //  2) 문단 맨 끝의 세로선 태그: "┃9월 18번┃" (┃ │ | ｜ 허용, 번호가 있을 때만 태그로 인정)
  //  3) 글상자/표 같은 개체 안에 들어 있는 세로선 태그(문항 앞에 박스로 붙은 "┃9월 18번┃")
  const BAR = '┃│|｜';
  const TAIL_RE = new RegExp('(?:\\[([^\\[\\]]*)\\]|[' + BAR + ']([^' + BAR + ']*)[' + BAR + '])$');
  const TAIL_STRIP_RE = new RegExp('(?:\\[[^\\[\\]]*\\]|[' + BAR + '][^' + BAR + ']*[' + BAR + '])\\s*$');
  const BOX_RE = new RegExp('^[' + BAR + ']([^' + BAR + ']*)[' + BAR + ']$');

  // 태그 안쪽 문자열("9월 18번", "25년 10월 41번~42번", "학교프린트")을 해석
  function interpretTag(inner, isBar) {
    const s = inner.replace(/\d+\s*년/g, ' ').replace(/\d+\s*월/g, ' ');
    const variant = /변형/.test(s);
    const nums = new Set();
    let rest = s.replace(/(\d+)\s*번?\s*[~\-–∼]\s*(\d+)\s*번/g, (_, a, b) => {
      a = +a;
      b = +b;
      if (a <= b && b - a < 100) for (let n = a; n <= b; n++) nums.add(n);
      return ' ';
    });
    rest.replace(/(\d+)\s*번/g, (_, a) => {
      nums.add(+a);
      return ' ';
    });
    if (nums.size) return { nums: [...nums].sort((a, b) => a - b), variant, label: null, raw: inner };
    if (isBar) return null; // 세로선 태그는 번호가 있을 때만 인정 (본문 속 | 오인식 방지)
    const label = inner.trim();
    if (!label || /^\d+\s*점$/.test(label)) return null;
    return { nums: [], variant: false, label, raw: inner };
  }

  function parseTrailingTag(plain) {
    const t = plain.replace(/[\s\u0011]+$/, '');
    const m = TAIL_RE.exec(t);
    if (!m) return null;
    const isBar = m[1] === undefined;
    return interpretTag(isBar ? m[2] : m[1], isBar);
  }

  // 개체 안의 문단 텍스트가 "┃9월 18번┃" 전체와 일치할 때만 태그로 인정
  function parseBoxTag(text) {
    const t = text.replace(/[\s\u0011]+/g, ' ').trim();
    const m = BOX_RE.exec(t);
    return m ? interpretTag(m[1], true) : null;
  }

  /* ---------- 파싱 ---------- */
  async function parseHwp(input) {
    const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    let cfb;
    try {
      cfb = CFB.read(u8, { type: 'array' });
    } catch (e) {
      throw new Error('HWP 파일(OLE 컨테이너)로 읽을 수 없습니다. 올바른 .hwp 파일인지 확인해 주세요.');
    }
    const fh = CFB.find(cfb, '/FileHeader');
    if (!fh) throw new Error('HWP 5.x 형식이 아닙니다. (FileHeader 없음) .hwpx 나 구버전 HWP 는 지원하지 않습니다.');
    const fhc = Uint8Array.from(fh.content);
    const sig = String.fromCharCode(...fhc.slice(0, 17));
    if (!sig.startsWith('HWP Document File')) throw new Error('HWP 문서 서명이 올바르지 않습니다.');
    const flags = new DataView(fhc.buffer).getUint32(36, true);
    const compressed = !!(flags & 1);
    if (flags & 2) throw new Error('암호가 설정된 문서는 처리할 수 없습니다. 한글에서 암호를 해제한 뒤 다시 시도해 주세요.');
    if (flags & 4) throw new Error('배포용 문서는 본문이 보호되어 있어 처리할 수 없습니다.');
    if (flags & 16) throw new Error('DRM 보호 문서는 처리할 수 없습니다.');

    const secPaths = cfb.FullPaths.map((p, i) => ({ p, i }))
      .filter((x) => /\/BodyText\/Section\d+$/.test(x.p))
      .sort((a, b) => parseInt(a.p.match(/(\d+)$/)[1]) - parseInt(b.p.match(/(\d+)$/)[1]))
      .map((x) => x.p.replace(/^Root Entry/, ''));
    if (!secPaths.length) throw new Error('본문(BodyText) 섹션을 찾지 못했습니다.');

    const sections = [];
    for (const path of secPaths) {
      const entry = CFB.find(cfb, path);
      let data = Uint8Array.from(entry.content);
      let trailer = false;
      if (compressed) {
        const r = inflateRaw(data);
        data = r.out;
        trailer = r.hasTrailer;
      }
      const recs = scanRecords(data);
      const paras = [];
      for (let k = 0; k < recs.length; k++) {
        const r = recs[k];
        if (r.tag === TAG_PARA_HEADER && r.level === 0) {
          if (paras.length) paras[paras.length - 1].endRec = k;
          paras.push({ startRec: k, endRec: recs.length, plain: '', has17: false, hasSecd: false, block: null });
        }
      }
      for (const p of paras) {
        const next = recs[p.startRec + 1];
        if (next && next.tag === TAG_PARA_TEXT && next.level === 1) {
          Object.assign(p, parseParaText(data, next.dataStart, next.end));
        }
        // 본문이 비어 있고 개체(글상자) 안에 "┃9월 18번┃" 만 들어 있는 문단 → 문항 시작 태그
        p.boxTag = null;
        if (!p.plain.trim() && !p.has17) {
          for (let k = p.startRec + 1; k < p.endRec; k++) {
            const r = recs[k];
            if (r.tag !== TAG_PARA_TEXT || r.level < 2) continue;
            const bt = parseBoxTag(parseParaText(data, r.dataStart, r.end).plain);
            if (bt) {
              p.boxTag = bt;
              p.boxTagRec = k;
              break;
            }
          }
        }
        // 발문 끝 미주(en) 안의 정답 텍스트
        p.answer = '';
        if (p.has17) {
          const lines = [];
          for (let k = p.startRec; k < p.endRec; k++) {
            const r = recs[k];
            if (r.tag === TAG_PARA_TEXT && r.level >= 3) lines.push(parseParaText(data, r.dataStart, r.end).plain.replace(/\u0011/g, '').trim());
          }
          p.answer = lines.filter(Boolean).join(' / ');
        }
      }
      sections.push({ path, data, recs, paras, trailer });
    }

    // 1차: 발문(has17)에 쓰인 라벨 수집  (예: [학교프린트])
    const labelSet = new Set();
    for (const s of sections)
      for (const p of s.paras) {
        if (!p.has17) continue;
        const t = parseTrailingTag(p.plain);
        if (t && t.label) labelSet.add(t.label);
      }

    // 2차: 블록 분할
    const blocks = [];
    let cur = null;
    let paraSeq = 0;
    for (let si = 0; si < sections.length; si++) {
      const s = sections[si];
      for (let pi = 0; pi < s.paras.length; pi++) {
        const p = s.paras[pi];
        // 문서 맨 끝의 "정답" 제목 문단(미주 목록 머리말)은 어느 문항에도 속하지 않고 항상 유지
        if (si === sections.length - 1 && pi === s.paras.length - 1 && /^정답\s*$/.test(p.plain)) {
          p.block = null;
          p.isAnswerHeading = true;
          paraSeq++;
          continue;
        }
        const t = parseTrailingTag(p.plain) || p.boxTag;
        const isStart = t && (t.nums.length || labelSet.has(t.label));
        if (isStart) {
          cur = { id: blocks.length, nums: t.nums, variant: t.variant, label: t.label, raw: t.raw, items: 0, paras: 0, firstPara: paraSeq, title: '' };
          blocks.push(cur);
          cur.title = p.plain.replace(/\u0011/g, '').replace(TAIL_STRIP_RE, '').trim().slice(0, 60);
        } else if (!cur && p.has17) {
          cur = { id: blocks.length, nums: [], variant: false, label: '태그 없음', raw: '', items: 0, paras: 0, firstPara: paraSeq, title: p.plain.replace(/\u0011/g, '').trim().slice(0, 60) };
          blocks.push(cur);
        }
        // 제목: 태그가 글상자라 제목이 비어 있으면 블록의 첫 본문 문단으로 채움
        if (cur && !cur.title && p.plain.trim()) cur.title = p.plain.replace(/\u0011/g, '').trim().slice(0, 60);
        p.block = cur;
        if (cur) {
          cur.paras++;
          if (p.has17) cur.items++;
        }
        paraSeq++;
      }
    }

    // 선택 가능한 키 집계
    const numMap = new Map();
    const labelMap = new Map();
    for (const b of blocks) {
      for (const n of b.nums) {
        if (!numMap.has(n)) numMap.set(n, { num: n, items: 0, variantItems: 0, blocks: 0 });
        const e = numMap.get(n);
        e.blocks++;
        if (b.variant) e.variantItems += b.items;
        else e.items += b.items;
      }
      if (b.label) {
        if (!labelMap.has(b.label)) labelMap.set(b.label, { label: b.label, items: 0, blocks: 0 });
        const e = labelMap.get(b.label);
        e.blocks++;
        e.items += b.items;
      }
    }
    const totalItems = blocks.reduce((a, b) => a + b.items, 0);
    return {
      cfb,
      compressed,
      sections,
      blocks,
      totalItems,
      numbers: [...numMap.values()].sort((a, b) => a.num - b.num),
      labels: [...labelMap.values()],
    };
  }

  /* ---------- 선택 판정 ---------- */
  // sel: { nums:Set<number>, labels:Set<string>, includeVariant:boolean }
  function blockKept(b, sel) {
    if (b.label) return sel.labels.has(b.label);
    if (b.variant && !sel.includeVariant) return false;
    return b.nums.some((n) => sel.nums.has(n));
  }

  function countKept(parsed, sel) {
    let items = 0;
    let blocks = 0;
    for (const b of parsed.blocks)
      if (blockKept(b, sel)) {
        items += b.items;
        blocks++;
      }
    return { items, blocks };
  }

  /* ---------- 출력 ---------- */
  function concat(chunks) {
    let n = 0;
    for (const c of chunks) n += c.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  function mkRec(tag, level, body) {
    const big = body.length >= 0xfff;
    const r = new Uint8Array((big ? 8 : 4) + body.length);
    const dv = new DataView(r.buffer);
    dv.setUint32(0, (tag & 0x3ff) | ((level & 0x3ff) << 10) | ((big ? 0xfff : body.length) << 20), true);
    if (big) dv.setUint32(4, body.length, true);
    r.set(body, big ? 8 : 4);
    return r;
  }
  const ctrlId = (data, r) => String.fromCharCode(data[r.dataStart + 3], data[r.dataStart + 2], data[r.dataStart + 1], data[r.dataStart]);

  // 발문 문단 재작성: 앞에 "n. " 삽입(위치 정보 보정) + 미주/자동번호 캐시를 n 으로 설정
  function rewriteStem(data, recs, p, n, label) {
    const textRec = recs[p.startRec + 1];
    const ins = label.length;
    // 삽입 위치(WCHAR 단위): 문단 앞쪽 확장 컨트롤(쪽번호 위치 등) 뒤
    let p0 = 0;
    if (ins) {
      for (let i = textRec.dataStart; i + 1 < textRec.end; ) {
        const c = data[i] | (data[i + 1] << 8);
        if (c >= 1 && c <= 23 && c !== 9 && c !== 10 && c !== 13) {
          p0 += 8;
          i += 16;
        } else break;
      }
    }
    const parts = [];
    for (let k = p.startRec; k < p.endRec; k++) {
      const r = recs[k];
      const body = data.subarray(r.dataStart, r.end);
      let nb = null;
      if (k === p.startRec) {
        nb = Uint8Array.from(body);
        const dv = new DataView(nb.buffer);
        const v = dv.getUint32(0, true);
        dv.setUint32(0, ((v & 0x80000000) | (((v & 0x7fffffff) + ins) >>> 0)) >>> 0, true);
      } else if (k === p.startRec + 1 && ins) {
        const lab = new Uint8Array(ins * 2);
        for (let i = 0; i < ins; i++) {
          lab[i * 2] = label.charCodeAt(i) & 0xff;
          lab[i * 2 + 1] = label.charCodeAt(i) >> 8;
        }
        nb = concat([body.subarray(0, p0 * 2), lab, body.subarray(p0 * 2)]);
      } else if (r.level === 1 && ins && (r.tag === 68 || r.tag === 69 || r.tag === 70)) {
        // 68: (pos,shapeId) 8B, 69: 줄 세그먼트 36B(첫 u32=시작위치), 70: (start,end,tag) 12B
        const stride = r.tag === 68 ? 8 : r.tag === 69 ? 36 : 12;
        nb = Uint8Array.from(body);
        const dv = new DataView(nb.buffer);
        for (let o = 0; o + stride <= nb.length; o += stride) {
          const a = dv.getUint32(o, true);
          if (a > p0) dv.setUint32(o, a + ins, true);
          if (r.tag === 70) {
            const b = dv.getUint32(o + 4, true);
            if (b > p0) dv.setUint32(o + 4, b + ins, true);
          }
        }
      } else if (r.tag === 71 && r.level === 1 && ctrlId(data, r) === 'en  ') {
        nb = Uint8Array.from(body);
        new DataView(nb.buffer).setUint32(4, n, true);
      } else if (r.tag === 71 && r.level >= 3 && ctrlId(data, r) === 'atno') {
        nb = Uint8Array.from(body);
        new DataView(nb.buffer).setUint16(8, n, true);
      }
      parts.push(nb ? mkRec(r.tag, r.level, nb) : data.subarray(r.start, r.end));
    }
    return concat(parts);
  }

  // 구역 정의(secd)를 품은 문단은 삭제할 수 없어 남지만, 그 안의 "┃9월 21번┃" 같은 태그 글자는
  // 삭제된 문항의 흔적이므로 같은 길이의 공백으로 바꿔 지운다. (레코드 크기/위치 정보는 그대로 유지)
  function blankBoxTag(data, recs, p, chunk, chunkStart) {
    const r = recs[p.boxTagRec];
    const out = Uint8Array.from(chunk);
    const base = r.dataStart - chunkStart;
    let i = 0;
    const len = r.end - r.dataStart;
    while (i + 1 < len) {
      const c = out[base + i] | (out[base + i + 1] << 8);
      if (c >= 32) {
        out[base + i] = 0x20;
        out[base + i + 1] = 0;
        i += 2;
      } else if (c === 0 || c === 10 || c === 13 || (c >= 24 && c <= 31)) i += 2;
      else i += 16;
    }
    return out;
  }

  async function buildSection(section, sel, compressed, ctx) {
    const { data, recs, paras } = section;
    const keep = paras.map((p) => !p.block || p.hasSecd || blockKept(p.block, sel));
    const chunks = [];
    const firstStart = paras.length ? recs[paras[0].startRec].start : data.length;
    chunks.push(data.subarray(0, firstStart));
    let outPos = firstStart;
    let lastHeaderOut = -1; // 마지막으로 남은 문단의 PARA_HEADER 데이터 위치
    const keptHeaderOffsets = [];
    paras.forEach((p, idx) => {
      if (!keep[idx]) return;
      const s = recs[p.startRec].start;
      const e = p.endRec < recs.length ? recs[p.endRec].start : data.length;
      let chunk = data.subarray(s, e);
      if (p.boxTag && p.block && !blockKept(p.block, sel)) chunk = blankBoxTag(data, recs, p, chunk, s);
      if (p.has17) {
        ctx.n++;
        chunk = rewriteStem(data, recs, p, ctx.n, sel.renumber ? ctx.n + '. ' : '');
      }
      if (p.isAnswerHeading) {
        // 정답 제목 문단은 항상 새 쪽에서 시작 (문단 헤더의 나누기 종류 bit2 = 쪽 나누기)
        chunk = Uint8Array.from(chunk);
        chunk[recs[p.startRec].dataStart - s + 11] |= 0x04;
      }
      chunks.push(chunk);
      keptHeaderOffsets.push(outPos + (recs[p.startRec].dataStart - s));
      outPos += chunk.length;
    });
    const out = concat(chunks);
    // 문단 헤더 nchars 최상위 비트: 리스트의 마지막 문단 표시 → 새 마지막 문단으로 이동
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    keptHeaderOffsets.forEach((off, i) => {
      let v = dv.getUint32(off, true) & 0x7fffffff;
      if (i === keptHeaderOffsets.length - 1) v = (v | 0x80000000) >>> 0;
      dv.setUint32(off, v, true);
    });
    return { bytes: compressed ? deflateRaw(out, section.trailer) : out, keptParas: keep.filter(Boolean).length, totalParas: paras.length };
  }

  async function patchDocInfo(cfb, compressed) {
    const entry = CFB.find(cfb, '/DocInfo');
    if (!entry) return;
    let data = Uint8Array.from(entry.content);
    let trailer = false;
    if (compressed) {
      const r = inflateRaw(data);
      data = r.out;
      trailer = r.hasTrailer;
    }
    const recs = scanRecords(data);
    const r = recs.find((x) => x.tag === TAG_DOC_PROPERTIES);
    if (r && r.end - r.dataStart >= 26) {
      // 캐럿 위치(리스트/문단/글자 위치)를 문서 처음으로 초기화 (삭제된 문단을 가리키지 않도록)
      data.fill(0, r.dataStart + 14, r.dataStart + 26);
    }
    entry.content = compressed ? deflateRaw(data, trailer) : data;
    entry.size = entry.content.length;
  }

  async function buildHwp(parsed, sel) {
    const cfb = parsed.cfb;
    let keptParas = 0;
    let totalParas = 0;
    const ctx = { n: 0 };
    for (const s of parsed.sections) {
      const r = await buildSection(s, sel, parsed.compressed, ctx);
      const entry = CFB.find(cfb, s.path);
      entry.content = r.bytes;
      entry.size = r.bytes.length;
      keptParas += r.keptParas;
      totalParas += r.totalParas;
    }
    await patchDocInfo(cfb, parsed.compressed);
    // cfb 라이브러리가 끼워 넣는 자체 표식 스트림은 HWP 에 불필요하므로 제거
    for (let i = cfb.FullPaths.length - 1; i > 0; i--) {
      if (cfb.FileIndex[i].name === '\u0001Sh33tJ5') {
        cfb.FileIndex.splice(i, 1);
        cfb.FullPaths.splice(i, 1);
      }
    }
    const out = CFB.write(cfb, { type: 'array' });
    return { bytes: Uint8Array.from(out), keptParas, totalParas, stats: countKept(parsed, sel) };
  }

  // PDF 출력용: 남기는 문단의 텍스트 목록 (그림/표는 자리표시만)
  function extractText(parsed, sel) {
    const out = [];
    let n = 0;
    for (const s of parsed.sections)
      for (const p of s.paras) {
        if (p.block && !blockKept(p.block, sel)) continue;
        if (!p.block && !p.plain.trim() && !p.hasObj) continue;
        const no = p.has17 ? ++n : 0;
        out.push({
          text: p.boxTag ? '┃' + p.boxTag.raw.trim() + '┃' : (no && sel.renumber ? no + '. ' : '') + p.plain.replace(/\u0011/g, '').replace(/\s+$/, ''),
          no,
          answer: p.answer,
          heading: !!p.isAnswerHeading,
          stem: p.has17,
          start: !!(p.block && (p.boxTag || parseTrailingTag(p.plain))),
          obj: p.hasObj && !p.boxTag,
        });
      }
    return out;
  }

  root.HwpFilter = { parseHwp, buildHwp, blockKept, countKept, parseTrailingTag, extractText };
})(typeof window !== 'undefined' ? window : globalThis);
