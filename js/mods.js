// Modifiers ("модернизаторы"): surprise cells that do something to the score when a team opens them.
// The author puts them on the board in the editor, or the game scatters a few at random.
//   target:   the team that hit it picks another team
//   many:     makes sense only with two or more teams
//   question: changes how the question is played, so the cell needs a question
//   chance:   share of a random roll, in percent; the secret question is never rolled, it has its own setting
//   retired:  no longer dealt out; kept so boards and game history from before still read right
export const BOMB = 300;
export const GIFT = 1000;
export const ROBIN = 1000;

export const MODS = {
  flip: { icon: '🔄', name: 'Наоборот', chance: 45, desc: () => 'Очки меняют знак: плюс становится минусом, минус — плюсом' },
  bomb: { icon: '💣', name: 'Бомба', chance: 25, desc: () => `Сразу −${BOMB} очков` },
  gift: { icon: '🎁', name: 'Подарок', chance: 15, desc: () => `Сразу +${GIFT} очков, просто так` },
  swap: { icon: '🔀', name: 'Обмен', chance: 10, desc: () => 'Меняетесь очками с командой, которую выберете', target: true, many: true, ask: 'С кем меняетесь очками?' },
  robin: { icon: '🏹', name: 'Робин Гуд', chance: 5, desc: () => `Лидер отдаёт ${ROBIN} очков тем, кто на последнем месте`, many: true },
  // The secret question ("кот в мешке"): the id stays 'cat' so boards made earlier keep working.
  cat: { icon: '🤫', name: 'Секретный вопрос', chance: 0, head: 'Сюрприз!', desc: () => 'Себе оставить нельзя: не глядя отдаёте его другой команде. Очки получает или теряет только та, что ответит', target: true, many: true, question: true, ask: 'Кому отдаёте секретный вопрос?' },
  steal: { icon: '🦝', name: 'Вор', retired: true, desc: (v) => `Забираете ${v} очков у команды, которую выберете` },
  double: { icon: '✖️', name: 'Двойной вопрос', retired: true, desc: (v) => `Вопрос стоит ${v * 2}` },
  shuffle: { icon: '🌀', name: 'Перемешка', retired: true, desc: () => 'Очки всех команд случайно перемешиваются' },
};
export const MOD_IDS = Object.keys(MODS).filter((k) => !MODS[k].retired);
export const RANDOM = { icon: '🎲', name: 'Случайный' };
export const isMod = (id) => id === 'random' || id in MODS;
export const modIcon = (id) => (MODS[id] || RANDOM).icon;
export const modName = (id) => (MODS[id] || RANDOM).name;
// What the banner says at the top: most cells are "Модернизатор!", the secret question is its own thing.
export const modHead = (id) => MODS[id]?.head || 'Модернизатор!';
// "Наоборот 45%, Бомба 25%, …" — what a random modifier can turn out to be.
export const chancesText = () => MOD_IDS.filter((k) => MODS[k].chance).map((k) => `${MODS[k].name} ${MODS[k].chance}%`).join(', ');

// Picks the modifier that will really happen. 'random' (or a retired one) is rolled by the chances
// above; one that can't work here (one team, or a cell without a question) is rolled again among
// those that can, keeping their proportions. `skip` keeps some out of the roll.
export function resolveMod(id, teams, hasQuestion, skip = []) {
  const ok = (k) => !MODS[k].retired && (teams > 1 || !MODS[k].many) && (hasQuestion || !MODS[k].question) && !skip.includes(k);
  if (MODS[id] && ok(id)) return id;
  const pool = MOD_IDS.filter((k) => ok(k) && MODS[k].chance > 0);
  let roll = Math.random() * pool.reduce((sum, k) => sum + MODS[k].chance, 0);
  return pool.find((k) => (roll -= MODS[k].chance) < 0) || pool[pool.length - 1];
}
