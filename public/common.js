// Shared by both pages (index.html and game.html): the toast and the
// create-game flow, so the hostKey storage convention lives in one place.
'use strict';

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

/** Create a game, remember the host key, and go there. Re-enables the button on failure. */
async function createGameAndGo(button) {
  button.disabled = true;
  try {
    const res = await fetch('/api/games', { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Could not create the game.');
    localStorage.setItem(`ng:${body.code}:hostKey`, body.hostKey);
    location.href = `/${body.code}`;
  } catch (err) {
    toast(err.message);
    button.disabled = false;
  }
}
