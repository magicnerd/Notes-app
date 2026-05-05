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
let audioUnlocked = false;

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

async function unlockAudioOutput() {
  audioUnlocked = true;
  remoteAudio.muted = false;
  remoteAudio.volume = 1;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      const ctx = new AudioContextClass();
      if (ctx.state === 'suspended') await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.00001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.02);
    }
  } catch {}

  try { await remoteAudio.play(); } catch {}
}

connectBtn.addEventListener('click', async () => {
  room = roomInput.value.trim() || 'default';
  key = keyInput.value.trim();
  localStorage.setItem('helperRoom', room);
  localStorage.setItem('helperKey', key);

  connectBtn.disabled = true;
  setStatus('Joining...', false);
  await unlockAudioOutput();

  login.classList.add('hidden');
  assistantPanel.classList.remove('hidden');
  connectSocket();
});

function connectSocket() {
  clearTimeout(reconnectTimer);
  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    sendWs({ type: 'join', role: 'assistant', room, key });
    setStatus('Connected. Waiting for performer...', true);
    setCallStatus('Audio output unlocked. Waiting for call offer.');
  });

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'auth-error') {
      setStatus('Wrong secret key.', false);
      setCallStatus('Access denied. Check your key.');
      connectBtn.disabled = false;
      return;
    }

    if (msg.type === 'joined') {
      setEditor(msg.note || '');
      setStatus(msg.performerOnline ? 'Connected. Performer online.' : 'Connected. Performer offline.', true);
    }

    if (msg.type === 'presence') {
      setStatus(msg.performerOnline ? 'Connected. Performer online.' : 'Connected. Performer offline.', true);
      if (!msg.performerOnline) setCallStatus('Performer offline. Waiting.');
    }

    if (msg.type === 'note-update') setEditor(msg.note || '');

    if (msg.type === 'call-status') setCallStatus(msg.text || 'Call status updated.');

    if (msg.type === 'call-offer') await answerCall(msg.offer);

    if (msg.type === 'call-candidate' && pc && msg.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
    }
  });

  ws.addEventListener('close', () => {
    setStatus('Disconnected. Reconnecting...', false);
    setCallStatus('Socket disconnected. Reconnecting...');
    reconnectTimer = setTimeout(connectSocket, 1000);
  });
}

async function answerCall(offer) {
  await unlockAudioOutput();
  closePeer();

  pc = new RTCPeerConnection({ iceServers: getIceServers() });

  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = async (event) => {
    const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
    remoteAudio.srcObject = stream;
    remoteAudio.muted = false;
    remoteAudio.volume = 1;
    setCallStatus('Audio track received. Trying to play.');
    try {
      await remoteAudio.play();
      setCallStatus('Call live. You should hear performer audio now.');
    } catch {
      setCallStatus('Audio track received, but browser blocked playback. Press play on the audio bar.');
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) sendWs({ type: 'call-candidate', candidate: event.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const state = pc.connectionState;
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
  } catch {
    setCallStatus('Could not answer call. Refresh both devices.');
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

reconnectAudioBtn.addEventListener('click', async () => {
  await unlockAudioOutput();
  closePeer();
  setCallStatus('Call reset. Refresh performer or wait for a new offer.');
});
