// "Open to Quick Play": the host's switch in every room game's lobby. The server owns the flag
// (it only accepts a change from the host, in the lobby) and sends it as `public` in every view.
// Host markup: <input id="public-toggle"> and <p id="public-note">. Guests get a read-only line.

const HOST_ON = 'Anyone who taps Quick Play can join this room, strangers included.';
const HOST_OFF = 'Private room: only people you send the code or invite link to can join.';

/** Call once. `send` is the game's own way of messaging the host/server. */
export function wirePublic(send) {
  const box = document.getElementById('public-toggle');
  if (box) box.addEventListener('change', () => send({ t: 'public', on: box.checked }));
}

/** Host side: tick the box and explain what the current state means. */
export function paintPublic(view) {
  const box = document.getElementById('public-toggle');
  const note = document.getElementById('public-note');
  const on = Boolean(view && view.public);
  if (box) box.checked = on;
  if (note) note.textContent = on ? HOST_ON : HOST_OFF;
}

/** Guest side: one plain line, as text (callers put it in a list item or a paragraph). */
export function publicLine(view) {
  return view && view.public
    ? '<b>Open to Quick Play</b>: strangers can join'
    : '<b>Private room</b>: only people with the code or link';
}
