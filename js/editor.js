import * as db from './db.js';
import { $, $$, esc, fmt, toast, dialog, confirmDlg, promptDlg, debounce, pickFile } from './util.js';
import { newClue, newRound, filled } from './board.js';
import { storeFile, dropRef, parseLink, mediaEl, kindOf, KIND_LABEL, KIND_ICON } from './media.js';

export async function renderEditor(root, id) {
  const board = await db.getBoard(id);
  if (!board) {
    root.innerHTML = `<div class="page center"><h1>Игра не найдена</h1><a class="btn primary" href="#/">На главную</a></div>`;
    return;
  }
  let tab = 0; // round index, or 'final'
  let closed = false;

  root.className = 'page-editor';
  root.innerHTML = `
    <header class="ed-head">
      <a class="icon-btn" href="#/" title="Мои игры">←</a>
      <input class="ed-title" maxlength="80" placeholder="Название игры">
      <span class="saved muted small"></span>
      <a class="btn primary" href="#/play/${esc(board.id)}">Играть ▶</a>
    </header>
    <nav class="tabs"></nav>
    <div class="ed-body"></div>
    <p class="ed-hint muted small">Кликни по клетке, чтобы написать вопрос. Картинку можно перетащить, вставить через Ctrl+V или выбрать файл. Пустые клетки в игре просто не показываются.</p>`;

  const savedEl = $('.saved', root);
  const save = debounce(async () => {
    board.updatedAt = Date.now();
    try {
      await db.putBoard(board);
      if (!closed) savedEl.textContent = 'Сохранено ✓';
    } catch (e) {
      toast(e.message || 'Не удалось сохранить', 'err');
    }
  }, 400);
  const touch = () => { savedEl.textContent = 'Сохраняю…'; save(); };

  const title = $('.ed-title', root);
  title.value = board.title;
  title.addEventListener('input', () => { board.title = title.value; touch(); });

  // ---------- tabs ----------
  function renderTabs() {
    $('.tabs', root).innerHTML =
      board.rounds.map((r, i) => `<button class="tab ${tab === i ? 'on' : ''}" data-tab="${i}">${esc(r.name)}</button>`).join('') +
      `<button class="tab ${tab === 'final' ? 'on' : ''}" data-tab="final">Финал${board.final.enabled ? '' : ' (выкл)'}</button>` +
      `<button class="tab add" data-tab="add" title="Добавить раунд">+ Раунд</button>`;
  }
  $('.tabs', root).addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    const v = t.dataset.tab;
    if (v === 'add') {
      const prev = board.rounds[board.rounds.length - 1];
      const r = newRound(`Раунд ${board.rounds.length + 1}`, prev.values.map((x) => x * 2), prev.categories.length);
      board.rounds.push(r);
      tab = board.rounds.length - 1;
      touch();
    } else tab = v === 'final' ? 'final' : +v;
    renderTabs();
    renderBody();
  });

  // ---------- body ----------
  function renderBody() {
    const body = $('.ed-body', root);
    if (tab === 'final') return renderFinal(body);
    const r = board.rounds[tab];
    body.innerHTML = `
      <div class="ed-tools">
        <div class="tool-group">
          <button class="btn small" data-a="renameRound">✎ Переименовать раунд</button>
          ${board.rounds.length > 1 ? '<button class="btn small ghost danger-text" data-a="delRound">Удалить раунд</button>' : ''}
        </div>
        <div class="tool-group values">
          <span class="muted small">Стоимость:</span>
          ${r.values.map((v, i) => `<input class="input tiny" type="number" inputmode="numeric" step="100" data-val="${i}" value="${v}">`).join('')}
          <button class="btn small" data-a="addRow" title="Добавить строку">+ строка</button>
          ${r.values.length > 1 ? '<button class="btn small ghost" data-a="delRow" title="Убрать последнюю строку">− строка</button>' : ''}
        </div>
        <div class="tool-group">
          <button class="btn small" data-a="addCat">+ тема</button>
        </div>
      </div>
      <div class="ed-grid-wrap"><div class="ed-grid" style="--cols:${r.categories.length}"></div></div>`;
    renderGrid();
  }

  function renderGrid() {
    const r = board.rounds[tab];
    const grid = $('.ed-grid', root);
    if (!grid) return;
    grid.style.setProperty('--cols', r.categories.length);
    grid.innerHTML =
      r.categories.map((c, ci) => `<div class="ed-cat"><textarea rows="2" maxlength="60" data-cat="${ci}" placeholder="Тема ${ci + 1}">${esc(c.name)}</textarea><button class="cat-menu" data-catmenu="${ci}" title="Действия с темой">⋯</button></div>`).join('') +
      r.values.map((v, qi) => r.categories.map((c, ci) => cellHTML(c.clues[qi], v, ci, qi)).join('')).join('');
  }

  function cellHTML(cl, v, ci, qi) {
    const hidden = cl.media?.phone === false || cl.aMedia?.phone === false;
    const icons = [cl.media && KIND_ICON[kindOf(cl.media)], cl.aMedia && '💡', hidden && '📵'].filter(Boolean).join(' ');
    const has = filled(cl);
    return `<button class="ed-cell ${has ? '' : 'empty'} ${has && !cl.a.trim() ? 'warn' : ''}" data-clue="${ci},${qi}">
      <span class="v">${fmt(v)}</span>
      <span class="q">${has ? esc(cl.q || '(только медиа)') : '+ вопрос'}</span>
      ${icons ? `<span class="icons">${icons}</span>` : ''}
    </button>`;
  }

  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.cat != null) {
      board.rounds[tab].categories[+t.dataset.cat].name = t.value;
      touch();
    } else if (t.dataset.val != null) {
      const r = board.rounds[tab];
      r.values[+t.dataset.val] = Math.round(+t.value || 0);
      $$('.ed-cell', root).forEach((cell) => {
        const [, qi] = cell.dataset.clue.split(',').map(Number);
        cell.querySelector('.v').textContent = fmt(r.values[qi]);
      });
      touch();
    }
  });

  root.addEventListener('click', async (e) => {
    const cell = e.target.closest('[data-clue]');
    if (cell) {
      const [ci, qi] = cell.dataset.clue.split(',').map(Number);
      return openClue(ci, qi);
    }
    const cm = e.target.closest('[data-catmenu]');
    if (cm) return catMenu(+cm.dataset.catmenu);
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a || tab === 'final') return;
    const r = board.rounds[tab];
    if (a === 'renameRound') {
      const n = await promptDlg('Название раунда', r.name);
      if (n && n.trim()) { r.name = n.trim().slice(0, 40); touch(); renderTabs(); }
    }
    if (a === 'delRound') {
      if (!(await confirmDlg(`Удалить «${r.name}» со всеми вопросами?`, 'Удалить', true))) return;
      r.categories.forEach((c) => c.clues.forEach(dropClueMedia));
      board.rounds.splice(tab, 1);
      tab = 0;
      touch(); renderTabs(); renderBody();
    }
    if (a === 'addRow') {
      const last = r.values[r.values.length - 1] || 0;
      const step = r.values.length > 1 ? last - r.values[r.values.length - 2] : last || 100;
      r.values.push(last + step);
      r.categories.forEach((c) => c.clues.push(newClue()));
      touch(); renderBody();
    }
    if (a === 'delRow') {
      const qi = r.values.length - 1;
      if (r.categories.some((c) => filled(c.clues[qi])) && !(await confirmDlg('В последней строке есть вопросы. Удалить их?', 'Удалить', true))) return;
      r.values.pop();
      r.categories.forEach((c) => dropClueMedia(c.clues.pop()));
      touch(); renderBody();
    }
    if (a === 'addCat') {
      if (r.categories.length >= 10) return toast('Максимум 10 тем');
      r.categories.push({ name: '', clues: r.values.map(() => newClue()) });
      touch(); renderBody();
      $$('.ed-cat textarea', root).pop()?.focus();
    }
  });

  function dropClueMedia(cl) {
    if (!cl) return;
    dropRef(cl.media);
    dropRef(cl.aMedia);
  }

  async function catMenu(ci) {
    const r = board.rounds[tab];
    const c = r.categories[ci];
    const v = await dialog({
      title: c.name || `Тема ${ci + 1}`,
      cls: 'menu-dlg',
      buttons: [
        ...(ci > 0 ? [{ label: '← Подвинуть влево', value: 'left' }] : []),
        ...(ci < r.categories.length - 1 ? [{ label: 'Подвинуть вправо →', value: 'right' }] : []),
        { label: 'Очистить вопросы', value: 'clear' },
        ...(r.categories.length > 1 ? [{ label: 'Удалить тему', value: 'del', cls: 'danger' }] : []),
        { label: 'Закрыть', value: null, cls: 'ghost' },
      ],
    });
    if (v === 'left' || v === 'right') {
      const j = v === 'left' ? ci - 1 : ci + 1;
      [r.categories[ci], r.categories[j]] = [r.categories[j], r.categories[ci]];
    }
    if (v === 'clear') {
      if (!(await confirmDlg('Стереть все вопросы этой темы?', 'Стереть', true))) return;
      c.clues.forEach(dropClueMedia);
      c.clues = r.values.map(() => newClue());
    }
    if (v === 'del') {
      if (c.clues.some(filled) && !(await confirmDlg('Удалить тему со всеми вопросами?', 'Удалить', true))) return;
      c.clues.forEach(dropClueMedia);
      r.categories.splice(ci, 1);
    }
    if (v) { touch(); renderBody(); }
  }

  // ---------- media drop zone ----------
  function mediaZone(el, get, set, onChange) {
    async function draw() {
      const ref = get();
      if (!ref) {
        el.innerHTML = `
          <div class="mz-empty">
            <div class="mz-drop"><b>Перетащи сюда картинку, аудио или видео</b><span class="muted small">или вставь из буфера обмена (Ctrl+V)</span></div>
            <div class="mz-row">
              <button type="button" class="btn small" data-mz="file">Выбрать файл</button>
              <input class="input small" data-mz="url" placeholder="…или ссылка на картинку / YouTube">
              <button type="button" class="btn small" data-mz="addurl">Добавить</button>
            </div>
          </div>`;
        return;
      }
      const k = kindOf(ref);
      el.innerHTML = `
        <div class="mz-full">
          <div class="mz-prev"></div>
          <div class="mz-side">
            <b>${KIND_ICON[k]} ${KIND_LABEL[k]}</b>
            ${k === 'youtube' ? `<label class="small">Начать с секунды <input class="input tiny" type="number" min="0" data-mz="start" value="${ref.start || 0}"></label>` : ''}
            <label class="mz-phone"><input type="checkbox" data-mz="phone" ${ref.phone !== false ? 'checked' : ''}> Показывать у игроков на телефонах</label>
            <button type="button" class="btn small" data-mz="file">Заменить</button>
            <button type="button" class="btn small ghost danger-text" data-mz="del">Убрать</button>
          </div>
        </div>`;
      const node = await mediaEl(ref, { thumb: true });
      if (get() === ref) $('.mz-prev', el)?.append(node);
    }
    async function put(ref) {
      const old = get();
      set(ref);
      if (old && old !== ref) dropRef(old);
      onChange();
      await draw();
    }
    async function handleFile(file) {
      el.classList.add('busy');
      try { await put(await storeFile(file)); }
      catch (e) { toast(e.message || 'Не получилось добавить файл', 'err'); }
      finally { el.classList.remove('busy'); }
    }
    function handleUrl(s) {
      const ref = parseLink(s);
      if (!ref) return toast('Не похоже на ссылку', 'err');
      put(ref);
    }
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-mz]');
      if (!b) return;
      if (b.dataset.mz === 'file') { const f = await pickFile('image/*,audio/*,video/*'); if (f) handleFile(f); }
      if (b.dataset.mz === 'addurl') handleUrl($('[data-mz=url]', el).value);
      if (b.dataset.mz === 'del') put(null);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.dataset.mz === 'url') { e.preventDefault(); e.stopPropagation(); handleUrl(e.target.value); }
    });
    el.addEventListener('change', (e) => {
      if (e.target.dataset.mz === 'start') { const ref = get(); ref.start = Math.max(0, Math.round(+e.target.value || 0)); onChange(); }
      if (e.target.dataset.mz === 'phone') {
        // Only "off" is stored: files are shown on phones unless the author says otherwise.
        const ref = get();
        if (e.target.checked) delete ref.phone;
        else ref.phone = false;
        onChange();
      }
    });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag');
      const f = e.dataTransfer.files?.[0];
      if (f) return handleFile(f);
      const u = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (u) handleUrl(u.split('\n')[0]);
    });
    el.addEventListener('mouseenter', () => { activeZone = zoneApi; });
    el.addEventListener('focusin', () => { activeZone = zoneApi; });
    const zoneApi = { handleFile, el };
    draw();
    return zoneApi;
  }
  let activeZone = null;

  // ---------- clue editor modal ----------
  function openClue(ci, qi) {
    const r = board.rounds[tab];
    let cur = { ci, qi };
    const order = [];
    r.values.forEach((_, q) => r.categories.forEach((_, c) => order.push({ ci: c, qi: q })));
    // Walk the board column by column: that's how people usually fill it in.
    order.sort((a, b) => a.ci - b.ci || a.qi - b.qi);

    dialog({
      cls: 'clue-ed wide',
      buttons: [],
      html: `
        <div class="ce-head"><div class="ce-where"></div><button type="button" class="icon-btn" data-ce="close" title="Закрыть (Esc)">×</button></div>
        <label class="lbl">Вопрос</label>
        <textarea class="input" rows="3" data-f="q" placeholder="Текст вопроса (можно оставить пустым, если вопрос — это картинка или звук)"></textarea>
        <div class="media-zone" data-slot="media"></div>
        <label class="lbl">Ответ</label>
        <input class="input" data-f="a" placeholder="Правильный ответ">
        <details class="amedia"><summary>Картинка к ответу <span class="muted small">(необязательно — покажется, когда откроется ответ)</span></summary><div class="media-zone" data-slot="aMedia"></div></details>
        <div class="ce-foot">
          <button type="button" class="btn" data-ce="prev">← Назад</button>
          <button type="button" class="btn ghost danger-text" data-ce="clear">Очистить</button>
          <span class="tb-spacer"></span>
          <button type="button" class="btn" data-ce="done">Готово</button>
          <button type="button" class="btn primary" data-ce="next">Дальше → <kbd>Ctrl+Enter</kbd></button>
        </div>`,
      onMount: (w, close) => {
        const q = $('[data-f=q]', w);
        const a = $('[data-f=a]', w);
        const clue = () => board.rounds[tab].categories[cur.ci].clues[cur.qi];
        const refreshCell = () => {
          const cell = $(`[data-clue="${cur.ci},${cur.qi}"]`, root);
          if (cell) cell.outerHTML = cellHTML(clue(), r.values[cur.qi], cur.ci, cur.qi);
        };
        const zones = {};
        const load = () => {
          const cl = clue();
          const cat = r.categories[cur.ci].name || `Тема ${cur.ci + 1}`;
          $('.ce-where', w).innerHTML = `<b>${esc(cat)}</b> · ${fmt(r.values[cur.qi])}`;
          q.value = cl.q;
          a.value = cl.a;
          zones.media = mediaZone($('[data-slot=media]', w), () => clue().media, (v) => { clue().media = v; }, () => { touch(); refreshCell(); });
          zones.aMedia = mediaZone($('[data-slot=aMedia]', w), () => clue().aMedia, (v) => { clue().aMedia = v; }, () => { touch(); refreshCell(); });
          $('.amedia', w).open = !!cl.aMedia;
          activeZone = null;
          q.focus();
          q.setSelectionRange(q.value.length, q.value.length);
        };
        // Zones are rebuilt on every load; fresh nodes drop the old listeners.
        const resetZones = () => $$('.media-zone', w).forEach((z) => z.replaceWith(z.cloneNode(false)));
        q.addEventListener('input', () => { clue().q = q.value; touch(); refreshCell(); });
        a.addEventListener('input', () => { clue().a = a.value; touch(); refreshCell(); });
        const go = (d) => {
          const i = order.findIndex((o) => o.ci === cur.ci && o.qi === cur.qi);
          const n = order[i + d];
          if (!n) { if (d > 0) close(true); return; }
          cur = { ...n };
          resetZones();
          load();
        };
        w.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-ce]');
          if (!b) return;
          const v = b.dataset.ce;
          if (v === 'close' || v === 'done') close(true);
          if (v === 'next') go(1);
          if (v === 'prev') go(-1);
          if (v === 'clear') {
            const cl = clue();
            dropClueMedia(cl);
            Object.assign(cl, newClue());
            touch(); refreshCell(); resetZones(); load();
          }
        });
        w.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); go(1); }
        });
        w.addEventListener('paste', (e) => {
          const f = [...(e.clipboardData?.files || [])][0];
          if (!f) return;
          e.preventDefault();
          (activeZone && w.contains(activeZone.el) ? activeZone : zones.media).handleFile(f);
        });
        load();
      },
    }).then(() => { activeZone = null; });
  }

  // ---------- final ----------
  function renderFinal(body) {
    const f = board.final;
    body.innerHTML = `
      <div class="final-ed card">
        <label class="set-row"><span><b>Финальный вопрос</b><br><span class="muted small">После всех раундов каждый игрок делает ставку и пишет ответ.</span></span><input type="checkbox" data-ff="enabled" ${f.enabled ? 'checked' : ''}></label>
        <label class="lbl">Тема финала <span class="muted small">(её покажут до вопроса, чтобы сделать ставки)</span></label>
        <input class="input" data-ff="category" maxlength="60" placeholder="Например: История" value="${esc(f.category)}">
        <label class="lbl">Вопрос</label>
        <textarea class="input" rows="3" data-ff="q" placeholder="Текст финального вопроса">${esc(f.q)}</textarea>
        <div class="media-zone" data-slot="media"></div>
        <label class="lbl">Ответ</label>
        <input class="input" data-ff="a" placeholder="Правильный ответ" value="${esc(f.a)}">
        <details class="amedia" ${f.aMedia ? 'open' : ''}><summary>Картинка к ответу <span class="muted small">(необязательно)</span></summary><div class="media-zone" data-slot="aMedia"></div></details>
      </div>`;
    body.querySelectorAll('[data-ff]').forEach((i) => i.addEventListener(i.type === 'checkbox' ? 'change' : 'input', () => {
      f[i.dataset.ff] = i.type === 'checkbox' ? i.checked : i.value;
      touch();
      if (i.type === 'checkbox') renderTabs();
    }));
    const zq = mediaZone($('[data-slot=media]', body), () => f.media, (v) => { f.media = v; }, touch);
    mediaZone($('[data-slot=aMedia]', body), () => f.aMedia, (v) => { f.aMedia = v; }, touch);
    body.onpaste = (e) => {
      const file = [...(e.clipboardData?.files || [])][0];
      if (!file) return;
      e.preventDefault();
      (activeZone && body.contains(activeZone.el) ? activeZone : zq).handleFile(file);
    };
  }

  renderTabs();
  renderBody();

  return () => {
    closed = true;
    save.flush();
  };
}
