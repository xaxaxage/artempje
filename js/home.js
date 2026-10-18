import * as db from './db.js?v=1792357451862';
import { esc, uid, fmt, toast, dialog, confirmDlg, promptDlg, download, pickFile, safeFileName, store, plural, LOGO_SVG } from './util.js?v=1792357451862';
import { newBoard, mediaRefs, stats, normalize, finalReady, allClues } from './board.js?v=1792357451862';
import { toPortable, fromPortable, copyRef, dropRef } from './media.js?v=1792357451862';
import { exampleBoard } from './examples.js?v=1792357451862';
import { listHistory, removeGame, clearHistory } from './history.js?v=1792357451862';

const MODE_NAMES = { simple: 'Простой режим', buzzer: 'С кнопками' };

export async function renderHome(root) {
  root.className = 'page-home';
  if (!store.get('plyukh-seeded')) {
    store.set('plyukh-seeded', true);
    if (!(await db.listBoards()).length) await db.putBoard(exampleBoard());
  }

  root.innerHTML = `
    <header class="site-head">
      <a class="logo" href="#/">${LOGO_SVG}<span>artempje</span></a>
      <nav class="site-nav">
        <button class="nav-link" data-a="goto" data-sec="boards">Мои игры</button>
        <button class="nav-link" data-a="goto" data-sec="gallery">Готовые игры</button>
        <button class="nav-link" data-a="goto" data-sec="history">История</button>
        <a class="nav-link" href="test/" title="Ведущий и игроки на одном экране — проверить игру одному">🧪 Тест-стенд</a>
        <a class="btn small" href="join/">Войти в игру по коду</a>
      </nav>
    </header>
    <section class="hero">
      <h1>Своя игра с друзьями</h1>
      <p class="lead">Собери доску с вопросами, картинками и музыкой, выведи её на телевизор — а друзья жмут кнопку со своих телефонов. Бесплатно, без регистрации и рекламы.</p>
      <div class="hero-actions">
        <button class="btn primary big" data-a="new">+ Новая игра</button>
        <button class="btn big" data-a="import">Загрузить из файла</button>
      </div>
    </section>
    <section class="boards">
      <div class="sec-head"><h2>Мои игры</h2><button class="btn small" data-a="exportAll">⬇ Скачать все</button></div>
      <div class="board-list"></div>
      <p class="muted small note">Игры и картинки хранятся в этом браузере на этом устройстве. Чтобы перенести их на другой компьютер или отдать другу — «⬇ Скачать», а там «Загрузить из файла».</p>
    </section>
    <section class="gallery">
      <h2>Готовые игры</h2>
      <p class="muted small">Возьми себе — и можно сразу играть или переделать под свою компанию.</p>
      <div class="gallery-list"><div class="muted small">Загружаем…</div></div>
    </section>
    <section class="history">
      <div class="sec-head"><h2>История игр</h2><button class="btn small ghost" data-a="clearHist" hidden>Очистить</button></div>
      <div class="hist-list"></div>
    </section>
    <section class="how">
      <h2>Как играть</h2>
      <div class="steps">
        <div class="step"><span class="step-n">01</span><b>Собери доску</b><p>Темы, вопросы, ответы, стоимость. Перетащи картинку, вставь скриншот через Ctrl+V или дай ссылку на YouTube.</p></div>
        <div class="step"><span class="step-n">02</span><b>Выведи на большой экран</b><p>Подключи ноутбук к телевизору по HDMI, Chromecast или AirPlay, или покажи экран в Discord.</p></div>
        <div class="step"><span class="step-n">03</span><b>Играйте!</b><p>Друзья сканируют QR-код и жмут кнопку на телефонах. Кто первый — тот отвечает. Есть вопросы-ставки и финал.</p></div>
      </div>
    </section>
    <footer class="site-foot muted small">artempje — бесплатная «Своя игра». Работает прямо в браузере, ничего не нужно устанавливать.</footer>`;

  const list = root.querySelector('.board-list');
  let gallery = [];

  async function drawBoards() {
    const boards = await db.listBoards();
    list.innerHTML = boards.length ? boards.map(cardHTML).join('') : `<div class="empty-card muted">Пока нет ни одной игры. Нажми «Новая игра» или возьми готовую ниже.</div>`;
    root.querySelector('[data-a=exportAll]').hidden = !boards.length;
    drawGallery(boards);
  }

  function drawGallery(boards) {
    if (!gallery.length) return;
    const have = new Set(boards.map((b) => b.template).filter(Boolean));
    root.querySelector('.gallery-list').innerHTML = gallery.map((g) => `
      <div class="gcard">
        <b>${esc(g.title)}</b>
        <p class="muted small">${esc(g.about)}</p>
        <button class="btn ${have.has(g.file) ? '' : 'primary'} small" data-a="take" data-file="${esc(g.file)}">${have.has(g.file) ? 'Взять ещё копию' : 'Взять себе'}</button>
      </div>`).join('');
  }

  async function drawHistory() {
    const h = await listHistory().catch(() => []);
    root.querySelector('[data-a=clearHist]').hidden = !h.length;
    root.querySelector('.hist-list').innerHTML = h.length
      ? h.map(histHTML).join('')
      : `<div class="empty-card muted">Здесь появятся сыгранные игры: кто играл, все вопросы и ответы — можно будет пролистать игру заново.</div>`;
  }

  await drawBoards();
  drawHistory();
  fetch('boards/index.json')
    .then((r) => r.json())
    .then(async (g) => { gallery = g; drawGallery(await db.listBoards()); })
    .catch(() => { root.querySelector('.gallery').hidden = true; });

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-a]');
    if (!btn) return;
    const id = btn.closest('[data-id]')?.dataset.id;
    switch (btn.dataset.a) {
      case 'goto':
        root.querySelector(`.${btn.dataset.sec}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      case 'new': {
        const title = await promptDlg('Как назовём игру?', '', { placeholder: 'Например: Днюха Димы', ok: 'Создать' });
        if (title == null) return;
        const b = newBoard(title.trim() || 'Новая игра');
        await db.putBoard(b);
        location.hash = `#/edit/${b.id}`;
        return;
      }
      case 'import': {
        const f = await pickFile('.json,application/json');
        if (!f) return;
        try {
          let data;
          try { data = JSON.parse(await f.text()); } catch { throw new Error('Это не файл игры'); }
          const added = await importData(data);
          toast(added.length === 1 ? `Загружено: ${added[0].title}` : `Загружено игр: ${added.length}`);
          drawBoards();
        } catch (err) {
          toast(err.message || 'Не получилось прочитать файл', 'err');
        }
        return;
      }
      case 'take': {
        btn.disabled = true;
        try {
          const data = await (await fetch(`boards/${btn.dataset.file}`)).json();
          const [b] = await importData(data, btn.dataset.file);
          toast(`«${b.title}» теперь в «Моих играх»`);
          await drawBoards();
          root.querySelector('.boards').scrollIntoView({ behavior: 'smooth' });
        } catch {
          toast('Не получилось загрузить игру', 'err');
          btn.disabled = false;
        }
        return;
      }
      case 'exportAll': {
        toast('Готовим файл…');
        const boards = await db.listBoards();
        const data = { app: 'plyukh', v: 1, boards: await Promise.all(boards.map(portable)) };
        download(`artempje-vse-igry-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
        return;
      }
      case 'clearHist':
        if (await confirmDlg('Стереть всю историю игр?', 'Стереть', true)) { await clearHistory(); drawHistory(); }
        return;
      case 'delHist':
        e.stopPropagation();
        if (!(await confirmDlg('Убрать эту игру из истории?', 'Убрать', true))) return;
        await removeGame(btn.closest('[data-hid]').dataset.hid);
        drawHistory();
        return;
      case 'openHist':
        location.hash = `#/history/${btn.closest('[data-hid]').dataset.hid}`;
        return;
      case 'play': location.hash = `#/play/${id}`; return;
      case 'edit': location.hash = `#/edit/${id}`; return;
      case 'export': {
        const b = await db.getBoard(id);
        if (b) { toast('Готовим файл…'); await exportBoard(b); }
        return;
      }
      case 'more': return more(id);
    }
  });

  async function more(id) {
    const b = await db.getBoard(id);
    if (!b) return;
    const r = await dialog({
      title: b.title,
      cls: 'menu-dlg',
      buttons: [
        { label: 'Сделать копию', value: 'dup' },
        { label: 'Удалить', value: 'del', cls: 'danger' },
        { label: 'Закрыть', value: null, cls: 'ghost' },
      ],
    });
    if (r === 'dup') {
      const copy = structuredClone(b);
      copy.id = uid('b');
      copy.title = b.title + ' (копия)';
      copy.createdAt = copy.updatedAt = Date.now();
      delete copy.template;
      for (const { clue } of allClues(copy)) {
        clue.media = await copyRef(clue.media);
        clue.aMedia = await copyRef(clue.aMedia);
      }
      await db.putBoard(copy);
      drawBoards();
    }
    if (r === 'del' && (await confirmDlg(`Удалить «${b.title}»? Это нельзя отменить.`, 'Удалить', true))) {
      mediaRefs(b).forEach(dropRef);
      await db.deleteBoardRecord(b.id);
      drawBoards();
    }
  }
}

function cardHTML(b) {
  const s = stats(b);
  const cats = b.rounds.flatMap((r) => r.categories.map((c) => c.name).filter(Boolean));
  const parts = [`${s.done} из ${s.total} вопросов`];
  if (b.rounds.length > 1) parts.push(`${b.rounds.length} ${plural(b.rounds.length, 'раунд', 'раунда', 'раундов')}`);
  if (finalReady(b)) parts.push('финал');
  if (s.media) parts.push(`${s.media} медиа`);
  return `<div class="bcard" data-id="${esc(b.id)}">
    <div class="bcard-main">
      <h3>${esc(b.title)}</h3>
      <p class="muted cats">${cats.length ? esc(cats.slice(0, 8).join(' · ')) + (cats.length > 8 ? ' …' : '') : 'Темы ещё не заполнены'}</p>
      <p class="meta">${parts.join(' · ')}</p>
    </div>
    <div class="bcard-actions">
      <button class="btn primary" data-a="play" ${s.done ? '' : 'disabled title="Сначала добавь вопросы"'}>Играть</button>
      <button class="btn" data-a="edit">Изменить</button>
      <button class="btn" data-a="export" title="Скачать файл с игрой">⬇ Скачать</button>
      <button class="btn icon" data-a="more" title="Ещё">⋯</button>
    </div>
  </div>`;
}

function histHTML(h) {
  const when = new Date(h.at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const mins = h.startedAt ? Math.max(1, Math.round((h.at - h.startedAt) / 60000)) : 0;
  const played = (h.events || []).filter((e) => e.k === 'pick').length;
  const meta = [when, mins ? `${mins} мин` : '', MODE_NAMES[h.mode] || '', played ? `${played} ${plural(played, 'вопрос', 'вопроса', 'вопросов')}` : ''].filter(Boolean).join(' · ');
  const rows = h.v === 2 && h.teams
    ? [...h.teams].sort((a, b) => b.score - a.score).map((t, i) => `<span class="hp ${i === 0 ? 'win' : ''}">${i === 0 ? '🏆 ' : ''}<i class="hp-dot" style="background:${esc(t.color)}"></i>${esc(t.name)}${t.members?.length && h.teamMode !== 'solo' ? ` <span class="muted">(${esc(t.members.join(', '))})</span>` : ''} <b class="${t.score < 0 ? 'neg' : ''}">${fmt(t.score)}</b></span>`).join('')
    : (h.players || []).map((p, i) => `<span class="hp ${i === 0 ? 'win' : ''}">${i === 0 ? '🏆 ' : ''}${esc(p.name)} <b class="${p.score < 0 ? 'neg' : ''}">${fmt(p.score)}</b></span>`).join('');
  return `<div class="hist" data-hid="${esc(h.id)}" data-a="openHist" role="link" tabindex="0" title="Открыть игру">
    <div class="hist-top"><b>${esc(h.board)}</b>${h.test ? '<span class="hv-tag">🧪 тест</span>' : ''}${h.v === 2 && !h.finished ? '<span class="hv-tag">не доиграна</span>' : ''}<span class="muted small">${meta}</span><button class="icon-btn small-x" data-a="delHist" title="Убрать из истории">×</button></div>
    <div class="hist-players">${rows || '<span class="muted small">без игроков</span>'}</div>
    ${h.v === 2 ? '<div class="hist-more">Открыть и пролистать игру →</div>' : ''}
  </div>`;
}

async function portable(b) {
  const copy = structuredClone(b);
  for (const { clue } of allClues(copy)) {
    clue.media = await toPortable(clue.media);
    clue.aMedia = await toPortable(clue.aMedia);
  }
  return copy;
}

export async function exportBoard(b) {
  const data = { app: 'plyukh', v: 1, board: await portable(b) };
  download(`${safeFileName(b.title)}.artempje.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
}

// Accepts a single-board file ({board}) or a backup of several ({boards}). Returns the added boards.
async function importData(data, template) {
  if (data?.app !== 'plyukh' || !(data.board || Array.isArray(data.boards))) throw new Error('Это не файл игры artempje');
  const added = [];
  for (const raw of data.board ? [data.board] : data.boards) {
    const b = normalize(raw);
    b.id = uid('b');
    if (template) b.template = template;
    for (const { clue } of allClues(b)) {
      clue.media = await fromPortable(clue.media);
      clue.aMedia = await fromPortable(clue.aMedia);
    }
    await db.putBoard(b);
    added.push(b);
  }
  if (!added.length) throw new Error('В файле нет игр');
  return added;
}
