// Arriving from an invite link (?room=ABCD): the Join card is the one thing to press. It moves
// first, gets an outline and a note, and Join room becomes the main button instead of Quick Play.
// Every game's home has the same ids: #name-input, #code-input, #quick-btn, #join-btn.

const CSS = `
.choice.invited { outline: 2px solid var(--ink); outline-offset: 3px; }
.invite-note { margin: 0 0 0.6rem; font-weight: 600; }
.btn.invite-pulse { animation: invite-pulse 1.8s ease-out infinite; }
@keyframes invite-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ink) 40%, transparent); }
  70%, 100% { box-shadow: 0 0 0 10px color-mix(in srgb, var(--ink) 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) { .btn.invite-pulse { animation: none; } }
`;

/**
 * Call once at start-up after the code box is filled from the link.
 * `enterJoins`: Enter in the name box presses Join room (off for a game that already does that).
 */
export function markInvite(code, { enterJoins = true } = {}) {
  const join = document.getElementById('join-btn');
  const quick = document.getElementById('quick-btn');
  const name = document.getElementById('name-input');
  if (!join) return;
  const card = join.closest('.choice') || join.parentElement;

  if (!document.getElementById('invite-css')) {
    const style = document.createElement('style');
    style.id = 'invite-css';
    style.textContent = CSS;
    document.head.append(style);
  }
  join.classList.add('primary', 'invite-pulse');
  if (quick) quick.classList.remove('primary');
  if (card) {
    card.classList.add('invited');
    const note = document.createElement('p');
    note.className = 'invite-note';
    note.textContent = `You're invited to room ${code}. Type your name, then press Join room.`;
    const heading = card.querySelector('h2');
    if (heading) heading.after(note);
    else card.prepend(note);
    // First in the list, so on a phone it sits right under the name box
    const list = card.parentElement;
    if (list && list.firstElementChild !== card) list.insertBefore(card, list.firstElementChild);
  }
  if (enterJoins && name) {
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !join.disabled && /^[A-Za-z]{4}$/.test(document.getElementById('code-input')?.value.trim() || '')) join.click();
    });
  }
}
