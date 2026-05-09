const login = document.getElementById('login');
const assistantPanel = document.getElementById('assistantPanel');
const roomInput = document.getElementById('roomInput');
const keyInput = document.getElementById('keyInput');
const connectBtn = document.getElementById('connectBtn');
const loginStatus = document.getElementById('loginStatus');
const statusEl = document.getElementById('status');
const audioStatus = document.getElementById('audioStatus');
const noteEditor = document.getElementById('noteEditor');
const resetAudioBtn = document.getElementById('resetAudioBtn');

let ws;
let room;
let key;
let sendTimer;
let reconnectTimer;
let ignoreEditorEvent = false;
let audioCtx;
let nextPlayTime = 0;
let chunkCount = 0;
let lastChunkAt = 0;
let lastNoteUpdatedAt = 0;

const AUDIO_SAMPLE_RATE = 16000;
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

function setAudioStatus(text) {
  audioStatus.textContent = text;
}

function sendWs(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

async function unlockAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    setAudioStatus('AudioContext not supported in this browser.');
    return false;
  }
  if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AudioContextClass({ sampleRate: AUDIO_SAMPLE_RATE });
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.start();
  nextPlayTime = audioCtx.currentTime + 0.08;
  return true;
}

connectBtn.addEventListener('click', async () => {
  room = roomInput.value.trim() || 'default';
  key = keyInput.value.trim();
  localStorage.setItem('helperRoom', room);
  localStorage.setItem('helperKey', key);

  connectBtn.disabled = true;
  setStatus('Joining...', false);
  login.classList.add('hidden');
  assistantPanel.classList.remove('hidden');
  await unlockAudio();
  connectSocket();
});

function connectSocket() {
  clearTimeout(reconnectTimer);
  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    sendWs({ type: 'join', role: 'assistant', room, key });
    setStatus('Connected. Waiting for performer...', true);
    setAudioStatus('Audio output ready. Waiting for performer mic stream.');
  });

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'auth-error') {
      setStatus('Wrong secret key.', false);
      setAudioStatus('Access denied. Check your key.');
      return;
    }

    if (msg.type === 'joined') {
      lastNoteUpdatedAt = Number(msg.noteUpdatedAt || 0);
      setEditor(msg.note || '');
      setStatus(msg.performerOnline ? 'Connected. Performer online.' : 'Connected. Performer offline.', true);
    }

    if (msg.type === 'presence') {
      setStatus(msg.performerOnline ? 'Connected. Performer online.' : 'Connected. Performer offline.', true);
      if (!msg.performerOnline) setAudioStatus('Performer offline. Waiting.');
    }

    if (msg.type === 'note-update') {
      lastNoteUpdatedAt = Number(msg.noteUpdatedAt || Date.now());
      setEditor(msg.note || '');
    }

    if (msg.type === 'audio-status') setAudioStatus(msg.text || 'Audio status updated.');
    if (msg.type === 'audio-pcm') playPcmChunk(msg);
  });

  ws.addEventListener('close', () => {
    setStatus('Disconnected. Reconnecting...', false);
    setAudioStatus('Socket disconnected. Reconnecting...');
    reconnectTimer = setTimeout(connectSocket, 1000);
  });

  ws.addEventListener('error', () => setStatus('Connection error.', false));
}

function base64ToInt16Array(b64) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

async function playPcmChunk(msg) {
  if (!audioCtx || audioCtx.state === 'closed') await unlockAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const pcm = base64ToInt16Array(msg.data || '');
  if (!pcm.length) return;

  const sampleRate = Number(msg.sampleRate || AUDIO_SAMPLE_RATE);
  const buffer = audioCtx.createBuffer(1, pcm.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) channel[i] = Math.max(-1, Math.min(1, pcm[i] / 32768));

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);

  const now = audioCtx.currentTime;
  if (nextPlayTime < now + 0.04) nextPlayTime = now + 0.04;
  if (nextPlayTime > now + 1.2) nextPlayTime = now + 0.12;

  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;

  chunkCount++;
  lastChunkAt = Date.now();
  setAudioStatus(`Receiving audio. Chunks: ${chunkCount}. Delay about ${Math.round((nextPlayTime - now) * 1000)}ms.`);
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
    lastNoteUpdatedAt = Date.now();
    sendWs({ type: 'note-update', note: noteEditor.value, updatedAt: lastNoteUpdatedAt });
  }, 60);
});

resetAudioBtn.addEventListener('click', async () => {
  chunkCount = 0;
  lastChunkAt = 0;
  await unlockAudio();
  setAudioStatus('Audio reset. Waiting for new chunks.');
});

setInterval(() => {
  if (!lastChunkAt) return;
  if (Date.now() - lastChunkAt > 3000) setAudioStatus(`No audio chunks for ${Math.round((Date.now() - lastChunkAt) / 1000)}s. Bring performer app back to screen or tap Done twice.`);
}, 2000);
