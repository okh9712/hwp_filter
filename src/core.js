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
  const TAG_ID_MAPPINGS = 17;
  const TAG_PARA_SHAPE = 25;
  const KEEP_NEXT = 1 << 17; // 문단 모양: 다음 문단과 함께
  const KEEP_LINES = 1 << 18; // 문단 모양: 문단 보호(쪽/단 사이에서 쪼개지지 않음)
  const BRK_PAGE_COL = 0x0c; // 문단 헤더 나누기 종류: 0x04 쪽 나누기, 0x08 단 나누기

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

    // DocInfo 원본 보관 (저장을 여러 번 해도 항상 원본에서 시작하도록)
    const diEntry = CFB.find(cfb, '/DocInfo');
    const docInfoRaw = diEntry ? Uint8Array.from(diEntry.content) : null;

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
      const sdv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (const p of paras) {
        p.psId = sdv.getUint16(recs[p.startRec].dataStart + 8, true); // 문단 모양 id
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
          p.isBlockStart = true;
          cur.title = p.plain.replace(/\u0011/g, '').replace(TAIL_STRIP_RE, '').trim().slice(0, 60);
        } else if (!cur && p.has17) {
          cur = { id: blocks.length, nums: [], variant: false, label: '태그 없음', raw: '', items: 0, paras: 0, firstPara: paraSeq, title: p.plain.replace(/\u0011/g, '').trim().slice(0, 60) };
          blocks.push(cur);
          p.isBlockStart = true;
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
      docInfoRaw,
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

  /* ---------- 쪽/단 정리 ---------- */
  // 문항을 지우면 (1) 문항마다 걸려 있던 "쪽 나누기/단 나누기"가 그대로 남아 빈 쪽·반쪽이 생기고
  // (2) 문제와 선지가 쪽 경계에서 갈라질 수 있다. 그래서
  //  - 남는 문항 블록의 문단에서 쪽 나누기/단 나누기를 제거(구역 시작 문단은 유지)하고
  //  - 문항 단위(발문+선지, 첫 단위는 지문 포함)의 문단에 "다음 문단과 함께/문단 보호"를 걸어 붙여 둔다.
  //    (원본 문서가 이미 보호 설정을 가진 단위는 손대지 않는다)
  function makeParaShapeCloner(data, recs) {
    const list = recs.filter((r) => r.tag === TAG_PARA_SHAPE);
    const idm = recs.find((r) => r.tag === TAG_ID_MAPPINGS);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // 안전장치: ID 매핑 표의 문단 모양 개수와 실제 레코드 수가 같을 때만 복제를 허용
    const ok = !!idm && idm.end - idm.dataStart >= 14 * 4 && dv.getUint32(idm.dataStart + 13 * 4, true) === list.length && list.length > 0;
    const clones = [];
    const map = new Map();
    return {
      ok,
      list,
      idm,
      clones,
      attr: (id) => (ok && id < list.length ? dv.getUint32(list[id].dataStart, true) : 0),
      get(id, add) {
        if (!ok || id >= list.length) return id;
        const attr = dv.getUint32(list[id].dataStart, true);
        const na = (attr | add) >>> 0;
        if (na === attr) return id;
        const key = id + ':' + add;
        if (map.has(key)) return map.get(key);
        const nid = list.length + clones.length;
        if (nid > 0xffff) return id;
        const body = Uint8Array.from(data.subarray(list[id].dataStart, list[id].end));
        new DataView(body.buffer).setUint32(0, na, true);
        clones.push(body);
        map.set(key, nid);
        return nid;
      },
    };
  }

  /* ----- 줄 배치 정보(원본 한글이 계산해 둔 LINE_SEG)로 쪽 넘침을 미리 계산 ----- */
  const TAG_PAGE_DEF = 73;
  const LABEL_MARGIN = 400; // 시뮬레이션 여유(약 한 줄 간격)
  // 글자 폭 추정(단위: 글자 크기). 발문 앞에 번호를 붙였을 때 줄이 늘어나는지 가늠하는 용도
  function charUnit(c) {
    if (c >= 0x2460 && c <= 0x24ff) return 1;
    if (c >= 0x1100) return 1;
    if (c === 32) return 0.35;
    if (c >= 48 && c <= 57) return 0.55;
    if (c >= 65 && c <= 90) return 0.62;
    if (c >= 97 && c <= 122) return 0.5;
    return 0.4;
  }

  function ensureGeometry(parsed) {
    if (parsed.geoDone) return;
    parsed.geoDone = true;
    const bucket = new Map();
    for (const sec of parsed.sections) {
      const dv = new DataView(sec.data.buffer, sec.data.byteOffset, sec.data.byteLength);
      let maxYh = 0;
      for (const p of sec.paras) {
        p.L = [];
        for (let k = p.startRec + 1; k < p.endRec; k++) {
          const r = sec.recs[k];
          if (r.tag === 69 && r.level === 1) {
            for (let o = r.dataStart; o + 36 <= r.end; o += 36) p.L.push({ chpos: dv.getUint32(o, true), y: dv.getInt32(o + 4, true), h: dv.getInt32(o + 8, true), ls: dv.getInt32(o + 20, true), w: dv.getInt32(o + 28, true) });
            break;
          }
        }
        for (const l of p.L) maxYh = Math.max(maxYh, l.y + l.h);
        // 줄별 글자 폭 합(단위폭): 두 줄 이상이거나 발문인 문단만
        p.U = null;
        const tr = sec.recs[p.startRec + 1];
        if (p.L.length && tr && tr.tag === TAG_PARA_TEXT && tr.level === 1 && (p.L.length >= 2 || p.has17)) {
          const arr = [];
          let i = tr.dataStart;
          let pos = 0;
          while (i + 1 < tr.end) {
            const c = sec.data[i] | (sec.data[i + 1] << 8);
            if (c >= 32) arr[pos++] = charUnit(c), (i += 2);
            else if (c === 0 || c === 10 || c === 13 || (c >= 24 && c <= 31)) arr[pos++] = 0, (i += 2);
            else {
              for (let q = 0; q < 8; q++) arr[pos++] = 0;
              i += 16;
            }
          }
          p.U = p.L.map((l, j) => {
            const e = j + 1 < p.L.length ? p.L[j + 1].chpos : pos;
            let u = 0;
            for (let q = l.chpos; q < e; q++) u += arr[q] || 0;
            return u;
          });
          p.L.forEach((l, j) => {
            if (j < p.L.length - 1 && p.U[j] > 8) {
              if (!bucket.has(l.w)) bucket.set(l.w, []);
              bucket.get(l.w).push(p.U[j]);
            }
          });
        }
      }
      // 문단별 세로 진행량(advance): 같은 단 안에서 다음 줄/문단과의 y 차이
      sec.paras.forEach((p, i) => {
        p.adv = [];
        for (let j = 0; j < p.L.length; j++) {
          const l = p.L[j];
          let d = -1;
          if (j < p.L.length - 1) d = p.L[j + 1].y - l.y;
          else {
            const nx = sec.paras[i + 1];
            const nl = nx && nx.L && nx.L[0];
            if (nl) d = nl.y - l.y;
            if (d > l.h + l.ls + 6000) d = -1;
          }
          p.adv.push(d > 0 ? d : l.h + l.ls);
        }
      });
      // 구역의 쪽/단 정보
      sec.geo = null;
      let cold = 0;
      let ncols = 1;
      for (let k = 0; k < sec.recs.length; k++) {
        const r = sec.recs[k];
        if (r.tag === 71 && ctrlId(sec.data, r) === 'cold') {
          if (!cold++) ncols = (dv.getUint16(r.dataStart + 4, true) >> 2) & 0xff || 1;
        }
      }
      const pd = sec.recs.find((r) => r.tag === TAG_PAGE_DEF);
      if (pd && cold === 1 && pd.end - pd.dataStart >= 40) {
        const o = pd.dataStart;
        const attr = dv.getUint32(o + 36, true);
        const ph = dv.getUint32(o + (attr & 1 ? 0 : 4), true);
        const body = ph - dv.getUint32(o + 16, true) - dv.getUint32(o + 20, true) - dv.getUint32(o + 24, true) - dv.getUint32(o + 28, true);
        const C = Math.max(body, maxYh);
        if (body > 10000 && ncols >= 1 && ncols <= 4) sec.geo = { C, ncols };
      }
    }
    parsed.capByW = new Map();
    for (const [w, a] of bucket)
      if (a.length >= 30) {
        a.sort((x, y) => x - y);
        parsed.capByW.set(w, a[a.length >> 1]);
      }
  }

  // 번호("38. ")를 앞에 붙이면 발문이 몇 줄 늘어나는지(0/1) 추정. 애매하면 늘어난다고 본다(보수적).
  function labelExtraLines(parsed, p, n) {
    if (!p.U || !p.L.length) return 0;
    const last = p.L[p.L.length - 1];
    const cap = parsed.capByW.get(last.w);
    if (!cap) return 0;
    const lu = 0.55 * String(n).length + 0.75;
    return (p.U[p.U.length - 1] + lu) / cap >= 1.0 ? 1 : 0;
  }

  // 한 블록 안의 "붙여 둘 묶음": [시작 문단+짧은 머리말] / [발문+선지]. 지문 본문과 빈 줄은 묶지 않는다.
  function chainGroups(paras, startsBlock) {
    const gs = [];
    let i = 0;
    const n = paras.length;
    const nonEmpty = (q) => !!q.plain.trim() || q.hasObj;
    if (startsBlock) {
      const st = [paras[0]];
      i = 1;
      while (i < n && st.length < 3 && nonEmpty(paras[i]) && !paras[i].has17 && paras[i].L.length <= 2) st.push(paras[i++]);
      gs.push({ ps: st, tie: true });
    }
    while (i < n) {
      const q = paras[i];
      if (q.has17) {
        const u = [q];
        i++;
        while (i < n && nonEmpty(paras[i]) && !paras[i].has17) u.push(paras[i++]);
        gs.push({ ps: u, tie: false });
      } else {
        gs.push({ ps: [q], single: true });
        i++;
      }
    }
    return gs;
  }

  function planLayout(parsed, sel, cloner) {
    ensureGeometry(parsed);
    const stats = { pageBreaks: 0, trimmed: 0 };
    let n = 0; // 남는 발문 수(번호 매기기용)
    for (const sec of parsed.sections) {
      for (const p of sec.paras) p.mod = { clear: false, add: 0, page: false, drop: false };
      // 1) 남는 문단을 "블록 묶음"과 "일반 문단"으로 나눔
      const items = [];
      let curB = null;
      for (const p of sec.paras) {
        const kept = !p.block || p.hasSecd || blockKept(p.block, sel);
        if (!kept) continue;
        if (p.has17) p.stemNo = ++n;
        if (!p.block || p.hasSecd || p.isAnswerHeading) {
          items.push({ type: 'p', p });
          curB = null;
          continue;
        }
        if (p.isBlockStart || !curB || curB.block !== p.block) {
          curB = { type: 'b', block: p.block, paras: [], startsBlock: !!p.isBlockStart };
          items.push(curB);
        }
        curB.paras.push(p);
        p.mod.clear = true; // 남는 문항 블록 안의 쪽/단 나누기는 일단 제거
      }
      // 2) 붙여 둘 묶음에 "다음 문단과 함께/문단 보호" 설정
      if (cloner && cloner.ok)
        for (const it of items) {
          if (it.type !== 'b') continue;
          for (const g of chainGroups(it.paras, it.startsBlock)) {
            if (g.single) continue;
            if (g.ps.some((q) => cloner.attr(q.psId) & KEEP_NEXT)) continue; // 원본이 이미 보호 설정을 가진 묶음
            g.ps.forEach((q, i) => (q.mod.add |= i < g.ps.length - 1 || g.tie ? KEEP_NEXT | KEEP_LINES : KEEP_LINES));
          }
        }
      // 3) 한 지문(여러 문제) 블록이 한 쪽에 들어가도록 쪽 나누기/빈 줄 조정
      if (!sec.geo) continue;
      const trimmed = new Set();
      const extraOf = (q) => (sel.renumber && q.has17 && q.stemNo ? labelExtraLines(parsed, q, q.stemNo) : 0);
      const NC = sec.geo.ncols;
      const page = (c) => Math.floor(c / NC);
      const st = { col: 0, y: 0 };
      // 모든 항목을 차례로 배치하면서, 여러 문제가 든 블록은 한 쪽에 맞는지 검사
      const place = (its, force) => runItems(sec, its, extraOf, trimmed, st, force);
      for (const it of items) {
        if (it.type === 'p') {
          place([it], false);
          continue;
        }
        const multi = it.block.items >= 2; // 문제가 여러 개 딸린 지문은 한 쪽 안에 들어오게 한다 (문제 1개짜리는 빈 반쪽을 채우도록 그대로 이어 붙임)
        const snap = { col: st.col, y: st.y };
        let r = place([it], false);
        if (sel.debug) stats.trace = (stats.trace || []).concat([{ sec: parsed.sections.indexOf(sec), items: it.block.items, paras: it.paras.length, start: [r.startCol, r.startY], end: [r.endCol, r.endY] }]);
        if (multi && page(r.endCol) !== page(r.startCol)) {
          // 현재 쪽에 다 못 들어가면 새 쪽에서 시작
          st.col = snap.col;
          st.y = snap.y;
          r = place([it], true);
          it.paras[0].mod.page = it.startsBlock && !it.paras[0].hasSecd && r.forced;
          if (page(r.endCol) !== page(r.startCol)) {
            // 새 쪽에서도 넘치면 빈 줄을 줄여 본다(가장 긴 연속 빈 줄부터, 최소 1줄은 남김)
            const mine = [];
            const mark = new Set();
            for (let guard = 0; guard < 60 && page(r.endCol) !== page(r.startCol); guard++) {
              const runs = [];
              let cur = null;
              for (const q of it.paras) {
                const trimmable = !q.plain.trim() && !q.hasObj && !q.has17 && !q.hasSecd && q.endRec - q.startRec <= 4 && !mark.has(q);
                if (trimmable) {
                  if (cur) cur.push(q);
                  else runs.push((cur = [q]));
                } else cur = null;
              }
              const cand = runs.filter((x) => x.length >= 2).sort((a, b) => b.length - a.length)[0];
              if (!cand) break;
              const q = cand[cand.length - 1];
              mark.add(q);
              mine.push(q);
              trimmed.add(q);
              st.col = snap.col;
              st.y = snap.y;
              r = place([it], true);
            }
            if (page(r.endCol) !== page(r.startCol)) {
              // 줄여도 안 들어가면(지문 자체가 한 쪽보다 큼) 원래대로 둔다
              for (const q of mine) trimmed.delete(q);
              st.col = snap.col;
              st.y = snap.y;
              r = place([it], true);
            } else for (const q of mine) q.mod.drop = true;
          }
          if (it.paras[0].mod.page) stats.pageBreaks++;
        }
      }
      stats.trimmed += trimmed.size;
    }
    return stats;
  }

  // 항목(들)을 현재 상태 st 에서 배치하고 시작/끝 위치를 돌려줌
  function runItems(sec, its, extraOf, trimmed, st, force) {
    const C = sec.geo.C - LABEL_MARGIN;
    const NC = sec.geo.ncols;
    const putLine = (h, adv) => {
      if (st.y > 0 && st.y + h > C) {
        st.col++;
        st.y = 0;
      }
      st.y += adv;
    };
    const lines = (q) => {
      if (trimmed.has(q)) return;
      const ex = extraOf(q);
      const n = q.L.length;
      for (let j = 0; j < n + ex; j++) {
        const jj = Math.min(j, n - 1);
        putLine(q.L[jj].h, q.adv[jj]);
      }
    };
    const need = (g, nextPara) => {
      let H = 0;
      let lastH = 0;
      let lastAdv = 0;
      for (const q of g.ps) {
        if (trimmed.has(q)) continue;
        const ex = extraOf(q);
        const n = q.L.length;
        for (let j = 0; j < n + ex; j++) {
          const jj = Math.min(j, n - 1);
          H += q.adv[jj];
          lastH = q.L[jj].h;
          lastAdv = q.adv[jj];
        }
      }
      let nd = H - (lastAdv - lastH);
      if (g.tie && nextPara && nextPara.L.length) nd += nextPara.adv[0];
      return nd;
    };
    let startCol = st.col;
    let startY = st.y;
    let forced = false;
    for (const it of its) {
      if (it.type === 'p') {
        lines(it.p);
        continue;
      }
      if (force && (st.y > 0 || st.col % NC !== 0)) {
        st.col = (Math.floor(st.col / NC) + 1) * NC;
        st.y = 0;
        forced = true;
      }
      startCol = st.col;
      startY = st.y;
      const paras = it.paras.filter((q) => !trimmed.has(q));
      const gs = chainGroups(paras, it.startsBlock);
      for (let gi = 0; gi < gs.length; gi++) {
        const g = gs[gi];
        if (g.single) {
          lines(g.ps[0]);
          continue;
        }
        const nd = need(g, gs[gi + 1] && gs[gi + 1].ps[0]);
        if (st.y > 0 && st.y + nd > C) {
          st.col++;
          st.y = 0;
        }
        for (const q of g.ps) lines(q);
      }
    }
    return { startCol, startY, endCol: st.col, endY: st.y, forced };
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

  async function buildSection(section, sel, compressed, ctx, cloner) {
    const { data, recs, paras } = section;
    const keep = paras.map((p) => (!p.block || p.hasSecd || blockKept(p.block, sel)) && !(p.mod && p.mod.drop));
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
      if (p.mod && (p.mod.clear || p.mod.add || p.mod.page)) {
        chunk = Uint8Array.from(chunk);
        const ho = recs[p.startRec].dataStart - s;
        if (p.mod.clear) chunk[ho + 11] &= ~BRK_PAGE_COL;
        if (p.mod.page) chunk[ho + 11] |= 0x04; // 지문 블록은 새 쪽에서 시작
        if (p.mod.add && cloner) {
          const cdv = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          cdv.setUint16(ho + 8, cloner.get(cdv.getUint16(ho + 8, true), p.mod.add), true);
        }
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

  function readDocInfo(parsed) {
    if (!parsed.docInfoRaw) return null;
    let data = Uint8Array.from(parsed.docInfoRaw);
    let trailer = false;
    if (parsed.compressed) {
      const r = inflateRaw(data);
      data = r.out;
      trailer = r.hasTrailer;
    }
    return { data, trailer, recs: scanRecords(data) };
  }

  async function patchDocInfo(cfb, compressed, di, cloner) {
    if (!di) return;
    let { data } = di;
    const { trailer, recs } = di;
    const r = recs.find((x) => x.tag === TAG_DOC_PROPERTIES);
    if (r && r.end - r.dataStart >= 26) {
      // 캐럿 위치(리스트/문단/글자 위치)를 문서 처음으로 초기화 (삭제된 문단을 가리키지 않도록)
      data.fill(0, r.dataStart + 14, r.dataStart + 26);
    }
    if (cloner && cloner.ok && cloner.clones.length) {
      // 문단 모양 복제본을 기존 문단 모양 목록 바로 뒤에 추가하고 ID 매핑의 개수를 갱신
      const last = cloner.list[cloner.list.length - 1];
      const lastRec = recs.find((x) => x.dataStart === last.dataStart);
      new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(cloner.idm.dataStart + 13 * 4, cloner.list.length + cloner.clones.length, true);
      data = concat([data.subarray(0, lastRec.end), ...cloner.clones.map((b) => mkRec(TAG_PARA_SHAPE, lastRec.level, b)), data.subarray(lastRec.end)]);
    }
    const entry = CFB.find(cfb, '/DocInfo');
    entry.content = compressed ? deflateRaw(data, trailer) : data;
    entry.size = entry.content.length;
  }

  async function buildHwp(parsed, sel) {
    const cfb = parsed.cfb;
    let keptParas = 0;
    let totalParas = 0;
    const ctx = { n: 0 };
    const di = readDocInfo(parsed);
    const cloner = sel.reflow !== false && di ? makeParaShapeCloner(di.data, di.recs) : null;
    let layout = null;
    if (sel.reflow !== false) layout = planLayout(parsed, sel, cloner);
    else for (const sec of parsed.sections) for (const p of sec.paras) p.mod = null;
    for (const s of parsed.sections) {
      const r = await buildSection(s, sel, parsed.compressed, ctx, cloner);
      const entry = CFB.find(cfb, s.path);
      entry.content = r.bytes;
      entry.size = r.bytes.length;
      keptParas += r.keptParas;
      totalParas += r.totalParas;
    }
    await patchDocInfo(cfb, parsed.compressed, di, cloner);
    // cfb 라이브러리가 끼워 넣는 자체 표식 스트림은 HWP 에 불필요하므로 제거
    for (let i = cfb.FullPaths.length - 1; i > 0; i--) {
      if (cfb.FileIndex[i].name === '\u0001Sh33tJ5') {
        cfb.FileIndex.splice(i, 1);
        cfb.FullPaths.splice(i, 1);
      }
    }
    const out = CFB.write(cfb, { type: 'array' });
    return { bytes: Uint8Array.from(out), keptParas, totalParas, stats: countKept(parsed, sel), clones: cloner ? cloner.clones.length : 0, layout };
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
