// Modifiers ("модернизаторы"): surprise cells that do something to the score when a team opens them.
// The author puts them on the board in the editor, or the game scatters a few at random.
//   target:   the team that hit it picks another team
//   many:     makes sense only with two or more teams
//   question: changes how the question is played, so the cell needs a question
export const MODS = {
  flip: { icon: '🔄', name: 'Наоборот', desc: () => 'Очки меняют знак: плюс становится минусом, минус — плюсом' },
  swap: { icon: '🔀', name: 'Обмен', desc: () => 'Меняетесь очками с командой, которую выберете', target: true, many: true, ask: 'С кем меняетесь очками?' },
  steal: { icon: '🦝', name: 'Вор', desc: (v) => `Забираете ${v} очков у команды, которую выберете`, target: true, many: true, ask: 'У кого забираете очки?' },
  // The secret question ("кот в мешке"): the id stays 'cat' so boards made earlier keep working.
  cat: { icon: '🤫', name: 'Секретный вопрос', head: 'Сюрприз!', desc: () => 'Себе оставить нельзя: не глядя отдаёте его другой команде. Очки получает или теряет только та, что ответит', target: true, many: true, question: true, ask: 'Кому отдаёте секретный вопрос?' },
  double: { icon: '✖️', name: 'Двойной вопрос', desc: (v) => `Вопрос стоит ${v * 2} — и за верный ответ, и за ошибку`, question: true },
  gift: { icon: '🎁', name: 'Подарок', desc: (v) => `Сразу +${v} очков, просто так` },
  bomb: { icon: '💣', name: 'Бомба', desc: (v) => `Сразу −${v} очков` },
  robin: { icon: '🏹', name: 'Робин Гуд', desc: (v) => `Лидер отдаёт ${v} очков тем, кто на последнем месте`, many: true },
  shuffle: { icon: '🌀', name: 'Перемешка', desc: () => 'Очки всех команд случайно перемешиваются', many: true },
};
export const MOD_IDS = Object.keys(MODS);
export const RANDOM = { icon: '🎲', name: 'Случайный' };
export const isMod = (id) => id === 'random' || id in MODS;
export const modIcon = (id) => (MODS[id] || RANDOM).icon;
export const modName = (id) => (MODS[id] || RANDOM).name;
// What the banner says at the top: most cells are "Модернизатор!", the secret question is its own thing.
export const modHead = (id) => MODS[id]?.head || 'Модернизатор!';

// Picks the modifier that will really happen: 'random' gets rolled, and one that can't work
// here (one team, or a cell without a question) is swapped for one that can. `skip` keeps some
// out of the roll: the game's own random cells never turn into secret questions, those have their own count.
export function resolveMod(id, teams, hasQuestion, skip = []) {
  const ok = (k) => (teams > 1 || !MODS[k].many) && (hasQuestion || !MODS[k].question) && !skip.includes(k);
  if (MODS[id] && ok(id)) return id;
  const pool = MOD_IDS.filter(ok);
  return pool[Math.floor(Math.random() * pool.length)];
}
