// The built-in keyboard for phones: keeps the device keyboard from covering the table,
// and shows which letters you've already used towards the bonus life.
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

export function createKeyboard(host, input, { onEnter, onType }) {
  host.innerHTML = ROWS.map((row, i) => `<div class="kbd-row">${i === 2 ? '<button type="button" class="key wide" data-k="enter">Send</button>' : ''}${
    [...row].map((c) => `<button type="button" class="key" data-k="${c}">${c}</button>`).join('')}${
    i === 2 ? '<button type="button" class="key wide" data-k="back" aria-label="Delete"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11v12H9l-6-6z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/></svg></button>' : ''}</div>`).join('');
  let on = false;

  function press(k) {
    if (input.disabled) return;
    if (k === 'enter') { onEnter(); return; }
    if (k === 'back') input.value = input.value.slice(0, -1);
    else if (input.value.length < input.maxLength) input.value += k;
    onType();
  }
  // pointerdown so fast typing doesn't wait for click, and the input never loses its look
  host.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.key');
    if (!b) return;
    e.preventDefault();
    press(b.dataset.k);
  });
  host.addEventListener('click', (e) => {
    // Keyboard users (Enter/Space on a focused key) arrive as a click without a pointerdown
    if (e.detail === 0) { const b = e.target.closest('.key'); if (b) press(b.dataset.k); }
  });
  // A physical keyboard still works while the built-in one is showing
  document.addEventListener('keydown', (e) => {
    if (!on || host.closest('[hidden]') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.activeElement && document.activeElement !== input && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    if (/^[a-z]$/i.test(e.key)) { e.preventDefault(); press(e.key.toLowerCase()); }
    else if (e.key === 'Backspace') { e.preventDefault(); press('back'); }
    else if (e.key === 'Enter' && document.activeElement !== input) { e.preventDefault(); press('enter'); }
  });

  return {
    // Turn the built-in keyboard on or off (off = the device keyboard)
    setOn(value) {
      on = value;
      host.hidden = !value;
      input.readOnly = value;
      input.inputMode = value ? 'none' : 'text';
    },
    get on() { return on; },
    // Letters already collected towards the bonus life, and those that don't count
    mark(have = '', skip = '') {
      host.querySelectorAll('.key[data-k]').forEach((b) => {
        const k = b.dataset.k;
        if (k.length !== 1) return;
        b.classList.toggle('have', have.includes(k));
        b.classList.toggle('skip', skip.includes(k));
      });
    },
    setEnabled(value) { host.classList.toggle('disabled', !value); },
  };
}
