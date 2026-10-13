// The household. Fixed here (not editable by agents). Helpers such as a nanny are NOT people:
// agents name them as plain text ({ name: "Kristin" }) wherever a "who" is accepted.
// Colours match the person colours the frame already uses (js/data.js).
export const PEOPLE = Object.freeze([
  Object.freeze({ id: 'nate', name: 'Nate', role: 'adult', color: '#578EE5' }),
  Object.freeze({ id: 'hayley', name: 'Hayley', role: 'adult', color: '#E97F80' }),
  Object.freeze({ id: 'lilly', name: 'Lilly', role: 'kid', color: '#75BBBF' }),
  Object.freeze({ id: 'daisy', name: 'Daisy', role: 'kid', color: '#FED615' }),
]);

export const PERSON_IDS = PEOPLE.map((p) => p.id);

export function isPerson(id) {
  return typeof id === 'string' && PERSON_IDS.includes(id);
}

export function personByName(name) {
  const n = String(name || '').trim().toLowerCase();
  return PEOPLE.find((p) => p.name.toLowerCase() === n) || null;
}

export function peopleList() {
  return PEOPLE.map((p) => ({ ...p }));
}
