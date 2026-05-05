const login = document.getElementById('login');
const assistantPanel = document.getElementById('assistantPanel');
const roomInput = document.getElementById('roomInput');
const keyInput = document.getElementById('keyInput');
const connectBtn = document.getElementById('connectBtn');
const loginStatus = document.getElementById('loginStatus');
const statusEl = document.getElementById('status');
const noteEditor = document.getElementById('noteEditor');
const remoteAudio = document.getElementById('remoteAudio');
const reconnectAudioBtn = document.getElementById('reconnectAudioBtn');

let ws;
let room;
let key;
let pc;
let sendTimer;
let reconnectTimer;
let ignoreEditorEvent = false;

const params = new URLSearchParams(location.search);
roomInput.value = params.get('room') || localStorage.getItem('helperRoom') || 'default';
keyInput.value = params.get('key') || localStorage.getItem('helperKey') || '';

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function setStatus(text, connected = false) {
  statusEl.textContent = text;
  statusEl.className = `status ${connected ? 'connected' : 'disconnected'}`;
  loginStatus.textContent = text;
}

connectBtn.addEventListener('click', () => {
  room = roomInput.value.trim() || 'default';
  key = keyInput.value.trim();
  localStorage.setItem('helperRoom', room);
  localStorage.setItem('helperKey', key);
  login.classList.add('hidden');
  assistantPanel.classList.remove('hidden');
  connectSocket();
});

function connectSocket() {
  clearTimeout(reconnectTimer);
  setStatus('Connecting...', false);
  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', role: 'assistant', room, key }));
    setStatus('Connected. Waiting for performer audio...', true);
  });

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'auth-error') {
      setStatus('Wrong secret key.', false);
      return;
    }

    if (msg.type === 'joined') {
      setEditor(msg.note || '');
      setStatus(msg.performerOnline ? 'Connected. Performer online.' : 'Connected. Performer offline.', true);
    }

    if (msg.type === 'presence') {
      setStatus(msg.performerOnline ? 'Connected. Performer online.' : 'Connected. Performer offline.', true);
    }

    if (msg.type === 'note-update') setEditor(msg.note || '');

    if (msg.type === 'webrtc-offer') await acceptOffer(msg.offer);

    if (msg.type === 'webrtc-candidate' && pc && msg.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
    }
  });

  ws.addEventListener('close', () => {
    setStatus('Disconnected. Reconnecting...', false);
    reconnectTimer = setTimeout(connectSocket, 1000);
  });
}

async function acceptOffer(offer) {
  closePeer();

  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  pc.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
    remoteAudio.play().catch(() => {
      setStatus('Audio received. Tap play if browser blocks autoplay.', true);
    });
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'webrtc-candidate', candidate: event.candidate }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus('Audio connected.', true);
    if (['failed', 'disconnected'].includes(pc.connectionState)) setStatus('Audio interrupted. Waiting to reconnect...', true);
  };

  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'webrtc-answer', answer }));
}

function closePeer() {
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
}

function setEditor(text) {
  ignoreEditorEvent = true;
  noteEditor.value = text;
  ignoreEditorEvent = false;
}

noteEditor.addEventListener('input', () => {
  if (ignoreEditorEvent || !ws || ws.readyState !== WebSocket.OPEN) return;
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    ws.send(JSON.stringify({ type: 'note-update', note: noteEditor.value }));
  }, 60);
});

reconnectAudioBtn.addEventListener('click', () => {
  closePeer();
  setStatus('Waiting for performer to renegotiate audio...', true);
});
