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
let blobQueue = [];
let blobPlaying = false;
let mediaSource;
let sourceBuffer;
let mseQueue = [];
let mseReady = false;
let mseMimeType = '';
let fallbackChunkCount = 0;

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
  setAudioDebug('Audio output enabled. Waiting for performer chunks...');
  playNextBlobChunk();
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

    if (msg.type === 'audio-status') {
      setAudioDebug(msg.text || 'Performer audio status received.');
    }

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
      setAudioDebug('WebRTC audio playing. WebSocket fallback is also available below.');
    } catch {
      setAudioDebug('WebRTC audio received, but playback was blocked. Press Enable Audio.');
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

function trySetupMediaSource(mimeType) {
  if (mediaSource || !window.MediaSource) return false;
  if (!mimeType || !MediaSource.isTypeSupported(mimeType)) return false;

  try {
    mseMimeType = mimeType;
    mediaSource = new MediaSource();
    fallbackAudio.src = URL.createObjectURL(mediaSource);
    mediaSource.addEventListener('sourceopen', () => {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mseMimeType);
        sourceBuffer.mode = 'sequence';
        sourceBuffer.addEventListener('updateend', appendMseQueue);
        mseReady = true;
        appendMseQueue();
        if (audioUnlocked) fallbackAudio.play().catch(() => {});
      } catch {
        mseReady = false;
      }
    }, { once: true });
    return true;
  } catch {
    return false;
  }
}

function appendMseQueue() {
  if (!mseReady || !sourceBuffer || sourceBuffer.updating || mseQueue.length === 0) return;
  try {
    sourceBuffer.appendBuffer(mseQueue.shift());
    if (audioUnlocked) fallbackAudio.play().catch(() => {});
  } catch {
    mseQueue.shift();
  }
}

function handleFallbackAudioChunk(msg) {
  try {
    const byteString = atob(msg.data);
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) bytes[i] = byteString.charCodeAt(i);
    fallbackChunkCount++;

    const mimeType = msg.mimeType || 'audio/mp4';

    // Prefer MediaSource, because MediaRecorder chunks are often fragments of one stream
    // rather than standalone audio files.
    const usingMse = mediaSource || trySetupMediaSource(mimeType);
    if (usingMse) {
      mseQueue.push(bytes.buffer);
      appendMseQueue();
      setAudioDebug(`Fallback stream receiving. Chunks: ${fallbackChunkCount}. Type: ${mimeType}`);
      return;
    }

    // Backup path for browsers without MediaSource support for the recorder format.
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    blobQueue.push(url);
    setAudioDebug(`Fallback blob received. Queue: ${blobQueue.length}. Type: ${mimeType}`);
    playNextBlobChunk();
  } catch (err) {
    setAudioDebug('Fallback audio chunk failed to decode.');
  }
}

async function playNextBlobChunk() {
  if (!audioUnlocked || blobPlaying || blobQueue.length === 0) return;
  blobPlaying = true;
  const url = blobQueue.shift();
  fallbackAudio.src = url;
  fallbackAudio.onended = () => {
    URL.revokeObjectURL(url);
    blobPlaying = false;
    playNextBlobChunk();
  };
  fallbackAudio.onerror = () => {
    URL.revokeObjectURL(url);
    blobPlaying = false;
    playNextBlobChunk();
  };
  try {
    await fallbackAudio.play();
    setAudioDebug(`Playing fallback blob audio. Remaining queue: ${blobQueue.length}`);
  } catch {
    blobPlaying = false;
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
  blobQueue = [];
  blobPlaying = false;
  mseQueue = [];
  mediaSource = null;
  sourceBuffer = null;
  mseReady = false;
  setStatus('Waiting for performer to renegotiate audio...', true);
  setAudioDebug('Audio reset. Refresh performer if needed.');
});
