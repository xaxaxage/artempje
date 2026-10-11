import * as db from './db.js';
import { esc, uid, toast, dialog, confirmDlg, promptDlg, download, pickFile, safeFileName, store, plural, LOGO_SVG } from './util.js';
import { newBoard, mediaRefs, stats, normalize, finalReady, allClues } from './board.js';
import { toPortable, fromPortable, copyRef, dropRef } from './media.js';
import { exampleBoard } from './examples.js';

export async function renderHome(root) {
  root.className = 'page-home';
  if (!store.get('plyukh-seeded')) {
    store.set('plyukh-seeded', true);
    if (!(await db.listBoards()).length) await db.putBoard(exampleBoard());
  }

  root.innerHTML = `
    <header class="site-head">
      <a class="logo" href="#/">${LOGO_SVG}<span>Плюх</span></a>
      <nav><a class="btn small" href="join/">Войти в игру по коду</a></nav>
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
      <h2>Мои игры</h2>
      <div class="board-list"></div>
      <p class="muted small note">Игры и картинки хранятся в этом браузере на этом устройстве. Чтобы перенести игру на другой компьютер или отдать другу — «⋯ → Скачать файл», а там «Загрузить из файла».</p>
    </section>
    <section class="how">
      <h2>Как играть</h2>
      <div class="steps">
        <div class="step"><span class="step-n">01</span><b>Собери доску</b><p>Темы, вопросы, ответы, стоимость. Перетащи картинку, вставь скриншот через Ctrl+V или дай ссылку на YouTube.</p></div>
        <div class="step"><span class="step-n">02</span><b>Выведи на большой экран</b><p>Подключи ноутбук к телевизору по HDMI, Chromecast или AirPlay, или покажи экран в Discord.</p></div>
        <div class="step"><span class="step-n">03</span><b>Играйте!</b><p>Друзья сканируют QR-код и жмут «Плюх!» на телефонах. Кто первый — тот отвечает. Есть вопросы-ставки и финал.</p></div>
      </div>
    </section>
    <footer class="site-foot muted small">Плюх — бесплатная «Своя игра». Работает прямо в браузере, ничего не нужно устанавливать.</footer>`;

  const list = root.querySelector('.board-list');
  async function draw() {
    const boards = await db.listBoards();
    list.innerHTML = boards.length ? boards.map(cardHTML).join('') : `<div class="empty-card muted">Пока нет ни одной игры. Нажми «Новая игра»!</div>`;
  }
  await draw();

  root.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-a]');
    if (!btn) return;
    const id = btn.closest('[data-id]')?.dataset.id;
    switch (btn.dataset.a) {
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
          const b = await importBoard(f);
          toast(`Загружено: ${b.title}`);
          draw();
        } catch (err) {
          toast(err.message || 'Не получилось прочитать файл', 'err');
        }
        return;
      }
      case 'play': location.hash = `#/play/${id}`; return;
      case 'edit': location.hash = `#/edit/${id}`; return;
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
        { label: 'Скачать файл', value: 'export' },
        { label: 'Сделать копию', value: 'dup' },
        { label: 'Удалить', value: 'del', cls: 'danger' },
        { label: 'Закрыть', value: null, cls: 'ghost' },
      ],
    });
    if (r === 'export') {
      toast('Готовим файл…');
      await exportBoard(b);
    }
    if (r === 'dup') {
      const copy = structuredClone(b);
      copy.id = uid('b');
      copy.title = b.title + ' (копия)';
      copy.createdAt = copy.updatedAt = Date.now();
      for (const { clue } of allClues(copy)) {
        clue.media = await copyRef(clue.media);
        clue.aMedia = await copyRef(clue.aMedia);
      }
      await db.putBoard(copy);
      draw();
    }
    if (r === 'del' && (await confirmDlg(`Удалить «${b.title}»? Это нельзя отменить.`, 'Удалить', true))) {
      mediaRefs(b).forEach(dropRef);
      await db.deleteBoardRecord(b.id);
      draw();
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
      <button class="btn icon" data-a="more" title="Ещё">⋯</button>
    </div>
  </div>`;
}

export async function exportBoard(b) {
  const copy = structuredClone(b);
  for (const { clue } of allClues(copy)) {
    clue.media = await toPortable(clue.media);
    clue.aMedia = await toPortable(clue.aMedia);
  }
  const data = { app: 'plyukh', v: 1, board: copy };
  download(`${safeFileName(b.title)}.plyukh.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
}

async function importBoard(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw new Error('Это не файл игры'); }
  if (data?.app !== 'plyukh' || !data.board) throw new Error('Это не файл игры Плюх');
  const b = normalize(data.board);
  b.id = uid('b');
  for (const { clue } of allClues(b)) {
    clue.media = await fromPortable(clue.media);
    clue.aMedia = await fromPortable(clue.aMedia);
  }
  await db.putBoard(b);
  return b;
}
