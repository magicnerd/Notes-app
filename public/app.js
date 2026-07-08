let token = localStorage.getItem('notes_token') || '';
const $ = s => document.querySelector(s);

const api = async (path, opts = {}) => {
  const r = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
};

async function init() {
  if (token) {
    try {
      await loadDashboard();
      showAuth(true);
      return;
    } catch (e) {
      token = '';
      localStorage.removeItem('notes_token');
    }
  }
  showAuth(false);
}

function showAuth(loggedIn) {
  $('#auth').classList.toggle('hidden', loggedIn);
  $('#dash').classList.toggle('hidden', !loggedIn);
}

async function signup() {
  try {
    setMsg('Creating account...');
    const email = $('#email').value.trim();
    const password = $('#password').value;
    const code = $('#code').value.trim();
    const data = await api('/api/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, code })
    });
    token = data.access_token;
    localStorage.setItem('notes_token', token);
    showAuth(true);
    await loadDashboard();
  } catch (e) {
    setMsg(e.message, true);
  }
}

async function login() {
  try {
    setMsg('Logging in...');
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#email').value.trim(), password: $('#password').value })
    });
    token = data.access_token;
    localStorage.setItem('notes_token', token);
    showAuth(true);
    await loadDashboard();
  } catch (e) {
    setMsg(e.message, true);
  }
}

async function logout() {
  token = '';
  localStorage.removeItem('notes_token');
  location.reload();
}

function setMsg(t, bad = false) {
  $('#msg').textContent = t;
  $('#msg').className = bad ? 'status bad' : 'status';
}

async function activate() {
  try {
    $('#activateMsg').textContent = 'Activating...';
    await api('/api/activate', { method: 'POST', body: JSON.stringify({ code: $('#activateCode').value.trim() }) });
    await loadDashboard();
  } catch (e) {
    $('#activateMsg').textContent = e.message;
  }
}

async function createRoom() {
  const name = prompt('Room name', 'Performance Room');
  if (name === null) return;
  await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) });
  loadDashboard();
}

async function resetCodes(id) {
  if (!confirm('Reset performer/helper links for this room? Old links will stop working.')) return;
  await api(`/api/rooms/${id}/reset-codes`, { method: 'POST' });
  loadDashboard();
}

async function deleteRoom(id) {
  if (!confirm('Disable this room?')) return;
  await api(`/api/rooms/${id}`, { method: 'DELETE' });
  loadDashboard();
}

function copy(t) {
  navigator.clipboard.writeText(t);
}

async function loadDashboard() {
  const me = await api('/api/me');
  $('#userEmail').textContent = me.user.email;
  const activated = !!me.profile?.activated;
  $('#activation').classList.toggle('hidden', activated);
  $('#roomsBlock').classList.toggle('hidden', !activated);
  $('#rooms').innerHTML = (me.rooms || []).map(r => `<div class="card"><h3>${escapeHtml(r.name)}</h3><div class="small">Performer link</div><div class="copyBox">${r.performer_url}</div><button onclick="copy('${r.performer_url}')">Copy performer</button><div style="height:10px"></div><div class="small">Helper link</div><div class="copyBox">${r.helper_url}</div><button onclick="copy('${r.helper_url}')">Copy helper</button><button class="ghost" onclick="resetCodes('${r.id}')">Reset links</button><button class="danger" onclick="deleteRoom('${r.id}')">Disable</button></div>`).join('') || '<p>No rooms yet.</p>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

window.signup = signup;
window.login = login;
window.logout = logout;
window.activate = activate;
window.createRoom = createRoom;
window.resetCodes = resetCodes;
window.deleteRoom = deleteRoom;
window.copy = copy;
init();
