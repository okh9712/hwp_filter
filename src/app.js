(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { parsed: null, fileName: '', selNums: new Set(), selLabels: new Set(), includeVariant: true, renumber: true };

  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB');

  /* ---------- 파일 불러오기 ---------- */
  const drop = $('drop');
  const fileInput = $('file');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('over');
    })
  );
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
    fileInput.value = '';
  });

  async function loadFile(file) {
    const err = $('loaderr');
    err.classList.add('hidden');
    $('work').classList.add('hidden');
    $('status').classList.add('hidden');
    const info = $('fileinfo');
    info.classList.remove('hidden');
    info.textContent = '읽는 중… ' + file.name;
    try {
      if (!/\.hwp$/i.test(file.name)) throw new Error('.hwp 파일만 지원합니다. (.hwpx 는 지원하지 않습니다)');
      const buf = new Uint8Array(await file.arrayBuffer());
      await new Promise((r) => setTimeout(r, 20)); // 화면 갱신
      const parsed = await HwpFilter.parseHwp(buf);
      if (!parsed.blocks.length) throw new Error('문항 태그(예: [25년 10월 19번] 또는 ┃9월 18번┃)를 찾지 못했습니다. 이 파일은 번호로 문항을 구분할 수 없습니다.');
      state.parsed = parsed;
      state.fileName = file.name;
      state.selNums = new Set();
      state.selLabels = new Set();
      info.innerHTML = '<b>' + esc(file.name) + '</b> · ' + fmtSize(file.size) + ' · 총 <b>' + parsed.totalItems + '</b>문항 · 번호 ' + parsed.numbers.length + '종' + (parsed.labels.length ? ' · 기타 구분 ' + parsed.labels.length + '종' : '');
      renderChips();
      renderRows();
      refresh();
      $('work').classList.remove('hidden');
    } catch (e) {
      state.parsed = null;
      info.classList.add('hidden');
      err.textContent = e.message || String(e);
      err.classList.remove('hidden');
    }
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ---------- 칩 ---------- */
  function chip(text, small, pressed, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    b.innerHTML = esc(text) + (small ? ' <small>' + esc(small) + '</small>' : '');
    b.addEventListener('click', onClick);
    return b;
  }

  function renderChips() {
    const p = state.parsed;
    const nc = $('numChips');
    nc.textContent = '';
    for (const n of p.numbers) {
      const cnt = n.items + n.variantItems;
      const small = '(' + cnt + (n.variantItems ? ', 변형 ' + n.variantItems : '') + ')';
      nc.appendChild(
        chip(n.num + '번', small, state.selNums.has(n.num), () => {
          toggle(state.selNums, n.num);
          renderChips();
          refresh();
        })
      );
    }
    $('labelWrap').classList.toggle('hidden', !p.labels.length);
    const lc = $('labelChips');
    lc.textContent = '';
    for (const l of p.labels) {
      lc.appendChild(
        chip(l.label, '(' + l.items + ')', state.selLabels.has(l.label), () => {
          toggle(state.selLabels, l.label);
          renderChips();
          refresh();
        })
      );
    }
  }
  function toggle(set, v) {
    set.has(v) ? set.delete(v) : set.add(v);
  }

  /* ---------- 범위 입력 ---------- */
  $('applyRange').addEventListener('click', applyRange);
  $('range').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyRange();
  });
  function applyRange() {
    const p = state.parsed;
    if (!p) return;
    const text = $('range').value;
    const nums = new Set();
    const labels = new Set();
    const wanted = new Set();
    for (const tok of text.split(/[,\s]+/).filter(Boolean)) {
      const m = /^(\d+)\s*(?:번)?\s*[~\-–∼]\s*(\d+)\s*(?:번)?$/.exec(tok);
      const s = /^(\d+)\s*(?:번)?$/.exec(tok);
      if (m) {
        const a = +m[1];
        const b = +m[2];
        for (let n = Math.min(a, b); n <= Math.max(a, b) && n < 1000; n++) wanted.add(n);
      } else if (s) wanted.add(+s[1]);
      else if (p.labels.some((l) => l.label === tok)) labels.add(tok);
      else labels.add('\u0000' + tok); // 알 수 없는 토큰
    }
    const have = new Set(p.numbers.map((n) => n.num));
    const missing = [];
    for (const n of [...wanted].sort((a, b) => a - b)) (have.has(n) ? nums : { add: (x) => missing.push(x) }).add(n);
    const unknown = [...labels].filter((x) => x[0] === '\u0000').map((x) => x.slice(1));
    state.selNums = nums;
    state.selLabels = new Set([...labels].filter((x) => x[0] !== '\u0000'));
    const notes = [];
    if (missing.length) notes.push('파일에 없는 번호: ' + compress(missing));
    if (unknown.length) notes.push('인식하지 못한 입력: ' + unknown.join(', '));
    const nt = $('rangeNotice');
    nt.textContent = notes.join(' / ');
    nt.classList.toggle('hidden', !notes.length);
    renderChips();
    refresh();
  }
  function compress(arr) {
    const out = [];
    for (let i = 0; i < arr.length; ) {
      let j = i;
      while (j + 1 < arr.length && arr[j + 1] === arr[j] + 1) j++;
      out.push(j > i ? arr[i] + '~' + arr[j] : String(arr[i]));
      i = j + 1;
    }
    return out.join(', ');
  }

  $('selAll').addEventListener('click', () => {
    state.selNums = new Set(state.parsed.numbers.map((n) => n.num));
    state.selLabels = new Set(state.parsed.labels.map((l) => l.label));
    renderChips();
    refresh();
  });
  $('selNone').addEventListener('click', () => {
    state.selNums = new Set();
    state.selLabels = new Set();
    renderChips();
    refresh();
  });
  $('selInv').addEventListener('click', () => {
    state.selNums = new Set(state.parsed.numbers.map((n) => n.num).filter((n) => !state.selNums.has(n)));
    state.selLabels = new Set(state.parsed.labels.map((l) => l.label).filter((l) => !state.selLabels.has(l)));
    renderChips();
    refresh();
  });
  $('optVariant').addEventListener('change', (e) => {
    state.includeVariant = e.target.checked;
    refresh();
  });

  /* ---------- 요약/목록 ---------- */
  const sel = () => ({ nums: state.selNums, labels: state.selLabels, includeVariant: state.includeVariant, renumber: state.renumber });
  $('optRenum').addEventListener('change', (e) => {
    state.renumber = e.target.checked;
    refresh();
  });

  function refresh() {
    const p = state.parsed;
    if (!p) return;
    const k = HwpFilter.countKept(p, sel());
    $('sumText').innerHTML = '남김 ' + k.items + '문항 <span>/ 전체 ' + p.totalItems + ' · 삭제 ' + (p.totalItems - k.items) + '</span>';
    $('run').disabled = k.items === 0;
    $('runPdf').disabled = k.items === 0;
    updateRows();
    schedulePreview(k.items);
  }

  let prevTimer = null;
  function schedulePreview(items) {
    clearTimeout(prevTimer);
    prevTimer = setTimeout(() => {
      const fr = $('preview');
      $('prevEmpty').classList.toggle('hidden', items > 0);
      fr.classList.toggle('hidden', items === 0);
      if (items === 0) return;
      const paras = HwpFilter.extractText(state.parsed, sel());
      fr.srcdoc = buildPrintHtml(paras, 'preview');
    }, 150);
  }

  let rowEls = [];
  function renderRows() {
    const tb = $('blockRows');
    tb.textContent = '';
    rowEls = [];
    const frag = document.createDocumentFragment();
    for (const b of state.parsed.blocks) {
      const tr = document.createElement('tr');
      const tag = b.label ? b.label : b.nums.length > 1 ? b.nums[0] + '~' + b.nums[b.nums.length - 1] + '번' : b.nums[0] + '번';
      tr.innerHTML = '<td class="st"></td><td class="n">' + esc(tag + (b.variant ? ' 변형' : '')) + '</td><td class="n">' + b.items + '</td><td>' + esc(b.title) + '</td>';
      frag.appendChild(tr);
      rowEls.push([tr, b]);
    }
    tb.appendChild(frag);
  }
  function updateRows() {
    const s = sel();
    for (const [tr, b] of rowEls) {
      const keep = HwpFilter.blockKept(b, s);
      tr.classList.toggle('drop-row', !keep);
      const td = tr.firstChild;
      td.textContent = keep ? '남김' : '삭제';
      td.className = 'st ' + (keep ? 'tag-keep' : 'tag-del');
    }
  }

  /* ---------- PDF (인쇄 창) ---------- */
  function buildPrintHtml(paras, title) {
    const body = paras
      .filter((p) => !p.heading) // 원본의 "정답" 제목은 아래 정답 구역(새 쪽)에서 대신 표시
      .map((p) => {
        const t = esc(p.text);
        const obj = p.obj ? '<span class="obj">[그림/표 생략]</span> ' : '';
        if (!t && !p.obj) return '<div class="gap"></div>';
        return '<p class="' + (p.start ? 'tag ' : '') + (p.stem ? 'stem' : '') + '">' + obj + t + '</p>';
      })
      .join('\n');
    // 맨 뒤 정답 목록 (HWP 의 미주와 동일한 번호/내용)
    const answers = paras.filter((p) => p.no && p.answer);
    // 정답은 항상 새 쪽에서 시작 (문제와 같은 쪽에 놓이지 않도록)
    const ansHtml = answers.length
      ? '<section class="answers"><p class="tag stem" style="margin-top:0">정답</p><div class="ans">' +
        answers.map((p) => '<span class="a' + (p.answer.length > 6 ? ' long' : '') + '"><b>' + p.no + ')</b> ' + esc(p.answer) + '</span>').join('') +
        '</div></section>'
      : '';
    return (
      '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
      '.ans{margin-top:3pt}.ans .a{display:inline-block;margin:0 10pt 2pt 0;white-space:nowrap}.ans .a.long{display:block;white-space:normal}' +
      '@page{size:A4;margin:14mm 12mm}' +
      'body{font:9.5pt/1.5 "Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:#000;margin:0}' +
      '.cols{column-count:2;column-gap:10mm;column-rule:1px solid #bbb}' +
      'p{margin:0 0 1pt;white-space:pre-wrap;word-break:break-word;orphans:2;widows:2}' +
      'p.stem{font-weight:700;margin-top:9pt;break-after:avoid}' +
      'p.tag:not(.stem){font-weight:700;margin-top:9pt}' +
      '.gap{height:4pt}.obj{color:#666;font-style:italic;font-weight:400}' +
      '.answers{break-before:page;page-break-before:always}' +
      '@media screen{.answers{margin-top:16pt;padding:10pt;border-top:2px dashed #888;background:#f6f6f6}' +
      '.answers:before{content:"▼ 정답은 다음 쪽에서 시작합니다 (인쇄/PDF 시 새 페이지)";display:block;font-size:8pt;color:#777;margin-bottom:6pt}}' +
      '</style></head><body><div class="cols">' + body + '</div>' + ansHtml + '</body></html>'
    );
  }

  $('runPdf').addEventListener('click', () => {
    const st = $('status');
    const paras = HwpFilter.extractText(state.parsed, sel());
    const base = state.fileName.replace(/\.hwp$/i, '');
    const old = document.getElementById('printFrame');
    if (old) old.remove();
    const fr = document.createElement('iframe');
    fr.id = 'printFrame';
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    fr.srcdoc = buildPrintHtml(paras, base + '_추출');
    fr.onload = () => {
      try {
        fr.contentWindow.focus();
        fr.contentWindow.print();
      } catch (e) {
        st.className = 'status err';
        st.textContent = '인쇄 창을 열지 못했습니다: ' + e.message;
      }
    };
    document.body.appendChild(fr);
    st.className = 'status';
    st.textContent = '인쇄 창에서 대상을 “PDF로 저장”으로 선택해 저장하세요. (파일 이름: ' + base + '_추출)';
  });

  /* ---------- 실행 ---------- */
  $('run').addEventListener('click', async () => {
    const st = $('status');
    const btn = $('run');
    btn.disabled = true;
    st.className = 'status';
    st.textContent = '처리 중… (큰 파일은 몇 초 걸릴 수 있습니다)';
    try {
      await new Promise((r) => setTimeout(r, 30));
      const r = await HwpFilter.buildHwp(state.parsed, sel());
      const blob = new Blob([r.bytes], { type: 'application/x-hwp' });
      const url = URL.createObjectURL(blob);
      const base = state.fileName.replace(/\.hwp$/i, '');
      const a = document.createElement('a');
      a.href = url;
      a.download = base + '_추출.hwp';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      st.className = 'status ok';
      st.textContent = '완료: ' + r.stats.items + '문항을 남기고 ' + (state.parsed.totalItems - r.stats.items) + '문항을 삭제했습니다. (' + fmtSize(r.bytes.length) + ') → ' + base + '_추출.hwp';
    } catch (e) {
      st.className = 'status err';
      st.textContent = '저장 중 오류: ' + (e.message || e);
    } finally {
      btn.disabled = false;
      refresh();
    }
  });
})();
