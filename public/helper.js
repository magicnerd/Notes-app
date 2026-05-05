const login = document.getElementById('login');
const assistantPanel = document.getElementById('assistantPanel');
const roomInput = document.getElementById('roomInput');
const keyInput = document.getElementById('keyInput');
const connectBtn = document.getElementById('connectBtn');
const loginStatus = document.getElementById('loginStatus');
const statusEl = document.getElementById('status');
const audioDebug = document.getElementById('audioDebug');
const noteEditor = document.getElementById('noteEditor');
const remoteAudio = document.getElementById('remoteAudio');
const fallbackAudio = document.getElementById('fallbackAudio');
const enableAudioBtn = document.getElementById('enableAudioBtn');
const reconnectAudioBtn = document.getElementById('reconnectAudioBtn');

let ws;
let room;
let key;
let pc;
let sendTimer;
let reconnectTimer;
let ignoreEditorEvent = false;
let audioUnlocked = false;
let fallbackQueue = [];
let fallbackPlaying = false;

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

function setAudioDebug(text) {
  audioDebug.textContent = text;
}

async function unlockAudio() {
  audioUnlocked = true;
  remoteAudio.muted = false;
  fallbackAudio.muted = false;
  remoteAudio.volume = 1;
  fallbackAudio.volume = 1;

  // This tiny silent clip unlocks browser audio output after a user click.
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.03);
    if (ctx.state === 'suspended') await ctx.resume();
  } catch {}

  try { await remoteAudio.play(); } catch {}
  try { await fallbackAudio.play(); } catch {}
  setAudioDebug('Audio output enabled. Waiting for stream...');
  playNextFallbackChunk();
}

enableAudioBtn.addEventListener('click', unlockAudio);

connectBtn.addEventListener('click', () => {
  room = roomInput.value.trim() || 'default';
  key = keyInput.value.trim();
  localStorage.setItem('helperRoom', room);
  localStorage.setItem('helperKey', key);
  login.classList.add('hidden');
  assistantPanel.classList.remove('hidden');
  unlockAudio();
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

    if (msg.type === 'audio-chunk') {
      handleFallbackAudioChunk(msg);
    }
  });

  ws.addEventListener('close', () => {
    setStatus('Disconnected. Reconnecting...', false);
    reconnectTimer = setTimeout(connectSocket, 1000);
  });
}

function getIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
  ];
}

async function acceptOffer(offer) {
  closePeer();

  pc = new RTCPeerConnection({ iceServers: getIceServers() });

  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = async (event) => {
    const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
    remoteAudio.srcObject = stream;
    remoteAudio.muted = false;
    remoteAudio.volume = 1;
    setAudioDebug(`WebRTC audio track received: ${event.track.kind}, state ${event.track.readyState}`);
    try {
      await remoteAudio.play();
      setAudioDebug('WebRTC audio playing. If silent, use the second audio player fallback.');
    } catch (err) {
      setAudioDebug('WebRTC audio received, but browser blocked playback. Press Enable Audio.');
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'webrtc-candidate', candidate: event.candidate }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus('Audio connected.', true);
    if (['failed', 'disconnected'].includes(pc.connectionState)) setStatus('Audio interrupted. Fallback audio may continue.', true);
  };

  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'webrtc-answer', answer }));
}

function handleFallbackAudioChunk(msg) {
  try {
    const byteString = atob(msg.data);
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
    const blob = new Blob([bytes], { type: msg.mimeType || 'audio/mp4' });
    const url = URL.createObjectURL(blob);
    fallbackQueue.push(url);
    setAudioDebug(`Fallback audio received. Queue: ${fallbackQueue.length}`);
    playNextFallbackChunk();
  } catch (err) {
    setAudioDebug('Fallback audio chunk failed to decode.');
  }
}

async function playNextFallbackChunk() {
  if (!audioUnlocked || fallbackPlaying || fallbackQueue.length === 0) return;
  fallbackPlaying = true;
  const url = fallbackQueue.shift();
  fallbackAudio.src = url;
  fallbackAudio.onended = () => {
    URL.revokeObjectURL(url);
    fallbackPlaying = false;
    playNextFallbackChunk();
  };
  fallbackAudio.onerror = () => {
    URL.revokeObjectURL(url);
    fallbackPlaying = false;
    playNextFallbackChunk();
  };
  try {
    await fallbackAudio.play();
    setAudioDebug(`Playing fallback audio. Remaining queue: ${fallbackQueue.length}`);
  } catch {
    fallbackPlaying = false;
    setAudioDebug('Fallback audio ready. Press Enable Audio/play.');
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
  fallbackQueue = [];
  fallbackPlaying = false;
  setStatus('Waiting for performer to renegotiate audio...', true);
});
