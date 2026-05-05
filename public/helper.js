const login = document.getElementById('login');
const assistantPanel = document.getElementById('assistantPanel');
const roomInput = document.getElementById('roomInput');
const keyInput = document.getElementById('keyInput');
const connectBtn = document.getElementById('connectBtn');
const loginStatus = document.getElementById('loginStatus');
const statusEl = document.getElementById('status');
const callStatus = document.getElementById('callStatus');
const noteEditor = document.getElementById('noteEditor');
const remoteAudio = document.getElementById('remoteAudio');
const reconnectAudioBtn = document.getElementById('reconnectAudioBtn');

let ws;
let pc;
let room;
let key;
let sendTimer;
let reconnectTimer;
let ignoreEditorEvent = false;
let userClickedJoin = false;

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

function setCallStatus(text) {
  callStatus.textContent = text;
}

function sendWs(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function getIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ];
}

// Keep this intentionally lightweight. The user's click on Join is the browser gesture
// that unlocks audio. Do not block the WebSocket join on audio APIs.
function unlockAudioOutputSoon() {
  try {
    remoteAudio.muted = false;
    remoteAudio.volume = 1;
    remoteAudio.playsInline = true;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      const ctx = new AudioContextClass();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
  } catch {}
}

connectBtn.addEventListener('click', () => {
  userClickedJoin = true;
  room = roomInput.value.trim() || 'default';
  key = keyInput.value.trim();
  localStorage.setItem('helperRoom', room);
  localStorage.setItem('helperKey', key);

  connectBtn.disabled = true;
  login.classList.add('hidden');
  assistantPanel.classList.remove('hidden');
  setStatus('Joining...', false);
  setCallStatus('Joining room. Waiting for server response...');

  unlockAudioOutputSoon();
  connectSocket();
});

function connectSocket() {
  clearTimeout(reconnectTimer);
  if (ws) {
    try { ws.close(); } catch {}
  }

  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    setCallStatus('Socket open. Sending helper join request...');
    sendWs({ type: 'join', role: 'assistant', room, key });
  });

  ws.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'auth-error') {
      setStatus('Wrong secret key.', false);
      setCallStatus('Access denied. Check your Render ASSISTANT_KEY.');
      connectBtn.disabled = false;
      return;
    }

    if (msg.type === 'joined') {
      setEditor(msg.note || '');
      setStatus(msg.performerOnline ? 'Connected. Performer online.' : 'Connected. Performer offline.', true);
      setCallStatus(msg.performerOnline ? 'Joined. Waiting for performer call offer...' : 'Joined. Open performer device and arm mic.');
      return;
    }

    if (msg.type === 'presence') {
      setStatus(msg.performerOnline ? 'Connected. Performer online.' : 'Connected. Performer offline.', true);
      if (!msg.performerOnline) setCallStatus('Performer offline. Waiting.');
      return;
    }

    if (msg.type === 'note-update') {
      setEditor(msg.note || '');
      return;
    }

    if (msg.type === 'call-status') {
      setCallStatus(msg.text || 'Call status updated.');
      return;
    }

    if (msg.type === 'call-offer') {
      await answerCall(msg.offer);
      return;
    }

    if (msg.type === 'call-candidate' && pc && msg.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
    }
  });

  ws.addEventListener('error', () => {
    setStatus('Socket error.', false);
    setCallStatus('Could not open WebSocket. Refresh the page.');
  });

  ws.addEventListener('close', () => {
    closePeer();
    if (!userClickedJoin) return;
    setStatus('Disconnected. Reconnecting...', false);
    setCallStatus('Socket closed. Reconnecting...');
    reconnectTimer = setTimeout(connectSocket, 1000);
  });
}

async function answerCall(offer) {
  closePeer();
  unlockAudioOutputSoon();
  setCallStatus('Call offer received. Answering...');

  pc = new RTCPeerConnection({ iceServers: getIceServers() });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = async (event) => {
    const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
    remoteAudio.srcObject = stream;
    remoteAudio.muted = false;
    remoteAudio.volume = 1;
    setCallStatus('Audio track received. Starting playback...');
    try {
      await remoteAudio.play();
      setCallStatus('Call live. You should hear performer audio now.');
    } catch {
      setCallStatus('Audio track received. Press play on the audio bar if sound is blocked.');
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) sendWs({ type: 'call-candidate', candidate: event.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const state = pc.connectionState;
    if (state === 'connecting') setCallStatus('Call connecting...');
    if (state === 'connected') setCallStatus('Call connected. Listening.');
    if (state === 'failed') setCallStatus('Call failed. Press Reconnect Call, then refresh performer.');
    if (state === 'disconnected') setCallStatus('Call disconnected. Waiting to recover.');
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWs({ type: 'call-answer', answer });
    setCallStatus('Call answer sent. Connecting audio...');
  } catch (err) {
    setCallStatus('Could not answer call: ' + err.message);
  }
}

function closePeer() {
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  remoteAudio.srcObject = null;
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
    sendWs({ type: 'note-update', note: noteEditor.value });
  }, 60);
});

reconnectAudioBtn.addEventListener('click', () => {
  unlockAudioOutputSoon();
  closePeer();
  setCallStatus('Call reset. Refresh performer or wait for a new offer.');
});
