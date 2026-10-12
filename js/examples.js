// A ready-to-play example board so a new visitor can try the game right away.
import { newBoard, newClue } from './board.js?v=1791831883056';

const svg = (body, vb) => {
  const [, , w, h] = vb.split(' ').map(Number);
  const size = `width="900" height="${Math.round((900 * h) / w)}"`;
  return { kind: 'url', mime: 'image/svg+xml', url: 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" ${size}>${body}</svg>`) };
};

const FLAGS = {
  japan: svg('<rect width="900" height="600" fill="#fff"/><circle cx="450" cy="300" r="180" fill="#bc002d"/>', '0 0 900 600'),
  sweden: svg('<rect width="16" height="10" fill="#006aa7"/><rect x="5" width="2" height="10" fill="#fecc00"/><rect y="4" width="16" height="2" fill="#fecc00"/>', '0 0 16 10'),
  swiss: svg('<rect width="32" height="32" fill="#da291c"/><rect x="13" y="6" width="6" height="20" fill="#fff"/><rect x="6" y="13" width="20" height="6" fill="#fff"/>', '0 0 32 32'),
  greece: svg(
    Array.from({ length: 9 }, (_, i) => `<rect y="${i * 2}" width="27" height="2" fill="${i % 2 ? '#fff' : '#0d5eaf'}"/>`).join('') +
      '<rect width="10" height="10" fill="#0d5eaf"/><rect x="4" width="2" height="10" fill="#fff"/><rect y="4" width="10" height="2" fill="#fff"/>',
    '0 0 27 18'),
  bangladesh: svg('<rect width="10" height="6" fill="#006a4e"/><circle cx="4.5" cy="3" r="2" fill="#f42a41"/>', '0 0 10 6'),
};

const c = (q, a, media = null) => ({ ...newClue(), q, a, media });

export function exampleBoard() {
  const b = newBoard('Пример: обо всём понемногу');
  b.rounds[0].categories = [
    { name: 'Флаги', clues: [
      c('Флаг какой страны?', 'Япония', FLAGS.japan),
      c('Флаг какой страны?', 'Швеция', FLAGS.sweden),
      c('Флаг какой страны?', 'Швейцария', FLAGS.swiss),
      c('Флаг какой страны?', 'Греция', FLAGS.greece),
      c('Флаг какой страны?', 'Бангладеш', FLAGS.bangladesh),
    ] },
    { name: 'Столицы', clues: [
      c('Столица Франции', 'Париж'),
      c('Столица Австралии — и это не Сидней', 'Канберра'),
      c('Столица Канады', 'Оттава'),
      c('Столица Турции', 'Анкара'),
      c('Город, где заседает правительство Боливии, — самая высокогорная «столица» мира', 'Ла-Пас'),
    ] },
    { name: 'Кино', clues: [
      c('Мальчик-волшебник со шрамом в виде молнии', 'Гарри Поттер'),
      c('Режиссёр «Титаника» и «Аватара»', 'Джеймс Кэмерон'),
      c('Фильм, где герою предлагают выбрать красную или синюю таблетку', '«Матрица»'),
      c('Робот-уборщик из мультфильма Pixar 2008 года', 'ВАЛЛ-И'),
      c('Комедия Гайдая, в которой звучит «Песенка о медведях»', '«Кавказская пленница»'),
    ] },
    { name: 'Наука', clues: [
      c('Химическая формула воды', 'H₂O'),
      c('Планета, ближайшая к Солнцу', 'Меркурий'),
      c('Учёный, сформулировавший три закона движения', 'Исаак Ньютон'),
      c('Сколько хромосом в клетках человека в норме?', '46'),
      c('Какой химический элемент обозначается символом Au?', 'Золото'),
    ] },
    { name: 'Еда', clues: [
      c('Итальянская лепёшка с томатами и сыром', 'Пицца'),
      c('Главный ингредиент гуакамоле', 'Авокадо'),
      c('Японское блюдо из риса и сырой рыбы', 'Суши'),
      c('Французский сыр с голубой плесенью, созревающий в пещерах', 'Рокфор'),
      c('Самая дорогая пряность в мире на вес', 'Шафран'),
    ] },
    { name: 'Игры', clues: [
      c('Усатый водопроводчик — талисман Nintendo', 'Марио'),
      c('Головоломка с падающими фигурами, придуманная в СССР в 1984 году', 'Тетрис'),
      c('Игра, где строят из кубиков и прячутся от криперов', 'Minecraft'),
      c('Игра про экипаж подводной лодки во льдах Европы — спутника Юпитера', 'Barotrauma'),
      c('Сколько клеток на шахматной доске?', '64'),
    ] },
  ];
  b.final = { enabled: true, category: 'Реки', ...newClue(), q: 'Самая длинная река Европы', a: 'Волга' };
  return b;
}
