const setup = document.getElementById('setup');
const notesApp = document.getElementById('notesApp');
const blackout = document.getElementById('blackout');
const armBtn = document.getElementById('armBtn');
const setupStatus = document.getElementById('setupStatus');
const roomInput = document.getElementById('roomInput');
const prefillInput = document.getElementById('prefillInput');
const noteTitle = document.getElementById('noteTitle');
const noteBody = document.getElementById('noteBody');
const hiddenLockZone = document.getElementById('hiddenLockZone');

let ws;
let room;
let localStream;
let reconnectTimer;
let assistantOnline = false;
let lastNote = localStorage.getItem('lastNote') || prefillInput.value;
let audioCtx;
let processor;
let sourceNode;
let pcmStarted = false;
let pcmChunkCounter = 0;

const TARGET_SAMPLE_RATE = 16000;

roomInput.value = localStorage.getItem('room') || Math.random().toString(36).slice(2, 8);
prefillInput.value = lastNote;
renderNote(lastNote);

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function setStatus(text) {
  setupStatus.textContent = text;
}

function sendWs(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function audioStatus(text) {
  sendWs({ type: 'audio-status', text });
}

function connectSocket() {
  clearTimeout(reconnectTimer);
  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    sendWs({ type: 'join', role: 'performer', room });
    sendWs({ type: 'prefill-note', note: getFullNote() });
    setStatus('Connected. Microphone armed.');
    startPcmAudioStream();
  });

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'joined') {
      assistantOnline = msg.assistantOnline;
      if (msg.note) updateNote(msg.note);
      audioStatus('Performer joined. Mic active. PCM audio stream starting.');
      startPcmAudioStream();
    }

    if (msg.type === 'presence') {
      assistantOnline = msg.assistantOnline;
      if (assistantOnline) {
        audioStatus('Assistant online. Sending microphone audio over WebSocket.');
        startPcmAudioStream();
      }
    }

    if (msg.type === 'note-update') updateNote(msg.note);
  });

  ws.addEventListener('close', () => {
    setStatus('Connection lost. Reconnecting...');
    stopPcmAudioStream();
    reconnectTimer = setTimeout(connectSocket, 1000);
  });

  ws.addEventListener('error', () => {
    setStatus('Connection error. Reconnecting...');
  });
}

function startPcmAudioStream() {
  if (pcmStarted || !localStream || !ws || ws.readyState !== WebSocket.OPEN) return;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      audioStatus('Audio streaming failed: AudioContext is not supported.');
      return;
    }

    audioCtx = audioCtx || new AudioContextClass();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

    sourceNode = audioCtx.createMediaStreamSource(localStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleBuffer(input, audioCtx.sampleRate, TARGET_SAMPLE_RATE);
      const pcm16 = floatTo16BitPCM(downsampled);
      sendWs({
        type: 'audio-pcm',
        sampleRate: TARGET_SAMPLE_RATE,
        data: int16ToBase64(pcm16)
      });
      pcmChunkCounter++;
      if (pcmChunkCounter % 20 === 0) {
        audioStatus('Sending microphone audio. Chunks sent: ' + pcmChunkCounter);
      }
    };

    sourceNode.connect(processor);
    // Some browsers need processor connected to destination to keep it alive.
    processor.connect(audioCtx.destination);
    pcmStarted = true;
    audioStatus('PCM microphone stream started.');
  } catch (err) {
    audioStatus('Audio stream start failed: ' + err.message);
  }
}

function stopPcmAudioStream() {
  pcmStarted = false;
  try { if (processor) processor.disconnect(); } catch {}
  try { if (sourceNode) sourceNode.disconnect(); } catch {}
  processor = null;
  sourceNode = null;
}

function downsampleBuffer(buffer, inputRate, outputRate) {
  if (outputRate === inputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function getFullNote() {
  const title = noteTitle.value.trim();
  const body = noteBody.value.trim();
  return title && body ? `${title}\n\n${body}` : title || body;
}

function renderNote(text) {
  const parts = String(text || '').split(/\n\s*\n/);
  noteTitle.value = parts.shift() || '';
  noteBody.value = parts.join('\n\n');
}

function updateNote(text) {
  lastNote = String(text || '');
  localStorage.setItem('lastNote', lastNote);
  renderNote(lastNote);
}

armBtn.addEventListener('click', async () => {
  try {
    armBtn.disabled = true;
    setStatus('Requesting microphone permission...');

    room = roomInput.value.trim() || 'default';
    localStorage.setItem('room', room);
    updateNote(prefillInput.value);

    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    const tracks = localStream.getAudioTracks();
    if (!tracks.length) throw new Error('No microphone audio track was returned.');

    connectSocket();
    setup.classList.add('hidden');
    notesApp.classList.remove('hidden');

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    }
  } catch (err) {
    armBtn.disabled = false;
    setStatus('Microphone setup failed: ' + err.message);
  }
});

hiddenLockZone.addEventListener('click', enterBlackout);

let tapCount = 0;
notesApp.addEventListener('touchstart', (event) => {
  const touch = event.touches[0];
  if (touch.clientX > window.innerWidth * 0.68 && touch.clientY > window.innerHeight * 0.72) {
    tapCount++;
    setTimeout(() => tapCount = Math.max(0, tapCount - 1), 650);
    if (tapCount >= 3) enterBlackout();
  }
}, { passive: true });

function enterBlackout() {
  blackout.classList.remove('hidden');
}

function exitBlackout() {
  blackout.classList.add('hidden');
}

blackout.addEventListener('touchstart', exitBlackout, { passive: true });
blackout.addEventListener('click', exitBlackout);

window.addEventListener('beforeunload', () => {
  stopPcmAudioStream();
  if (localStream) localStream.getTracks().forEach(track => track.stop());
});
