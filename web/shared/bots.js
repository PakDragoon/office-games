// Computer players in a room, the same in every game that has them (Flipchip, Rotten, Thulla).
// The host adds a bot in the lobby, picks Easy or Normal, and can remove it. The server does the rest.

const LEVELS = [['easy', 'Easy'], ['normal', 'Normal']];
export const levelName = (level) => (level === 'easy' ? 'Easy' : 'Normal');

/** A small "BOT" label next to a computer player's name. */
export const botTag = (p) => (p && (p.bot || p.isBot) ? '<span class="bot-tag" title="Computer player">BOT</span>' : '');

/** Easy / Normal switch and a Remove link for one bot; only the host sees them. */
export function botControls(p) {
  const lvl = p.botLevel || 'normal';
  return `<span class="bot-ctl"><span class="bot-lvl" role="group" aria-label="Bot level">${LEVELS.map(([v, label]) =>
    `<button type="button" data-bot-level="${v}" data-bot-id="${p.id}" aria-pressed="${v === lvl}">${label}</button>`).join('')}</span>
    <button type="button" class="bot-rm" data-bot-remove="${p.id}">Remove</button></span>`;
}

/** The "Add a bot" button (host, lobby, when there is room). */
export const addBotButton = (cls = 'btn ghost') => `<button type="button" class="${cls} add-bot" data-add-bot>🤖 Add a bot</button>`;

/** One listener for every bot button inside `container`; `send` is the game's toHost. */
export function wireBots(container, send, isHost) {
  container.addEventListener('click', (e) => {
    if (!isHost()) return;
    const add = e.target.closest('[data-add-bot]');
    if (add) return send({ t: 'addBot', level: 'normal' });
    const lvl = e.target.closest('[data-bot-level]');
    if (lvl) return send({ t: 'botLevel', id: lvl.dataset.botId, level: lvl.dataset.botLevel });
    const rm = e.target.closest('[data-bot-remove]');
    if (rm) send({ t: 'removeBot', id: rm.dataset.botRemove });
  });
}

/** Styles every game appends to its own style.css (kept here as the reference copy). */
export const BOT_CSS = `
.bot-tag { margin-left: 0.4rem; padding: 0.05rem 0.35rem; border: 1px solid var(--line); border-radius: 6px; font-size: 0.62rem; font-weight: 800; letter-spacing: 0.07em; color: var(--muted); vertical-align: middle; }
.bot-ctl { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; }
.bot-lvl { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }
.bot-lvl button { border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 0.8rem; font-weight: 700; padding: 0.3rem 0.65rem; min-height: 32px; cursor: pointer; }
.bot-lvl button[aria-pressed="true"] { background: var(--ink); color: var(--bg); }
.bot-rm { border: 0; background: none; color: var(--muted); font: inherit; font-size: 0.82rem; text-decoration: underline; text-underline-offset: 3px; padding: 0.3rem 0.2rem; min-height: 32px; cursor: pointer; }
`;
