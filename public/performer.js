const consent = document.getElementById('consent');
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
let pc;
let reconnectTimer;
let lastNote = localStorage.getItem('lastNote') || prefillInput.value;
let isBlack = false;
let assistantOnline = false;
let mediaRecorder;
let fallbackMimeType = '';
let fallbackStarted = false;

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
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
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
    setStatus('Connected. Audio armed.');
    audioStatus('Performer connected. Mic stream exists: ' + Boolean(localStream));

    // Start WebSocket fallback after the socket is definitely open.
    // This is intentionally always on because it is more reliable than WebRTC across strict networks.
    startFallbackAudioStream();
  });

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'joined') {
      assistantOnline = msg.assistantOnline;
      if (msg.note) updateNote(msg.note);
      if (assistantOnline) await createOffer();
    }

    if (msg.type === 'presence') {
      const wasOffline = !assistantOnline;
      assistantOnline = msg.assistantOnline;
      if (assistantOnline && wasOffline && localStream) await createOffer();
    }

    if (msg.type === 'note-update') updateNote(msg.note);

    if (msg.type === 'webrtc-answer' && pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
    }

    if (msg.type === 'webrtc-candidate' && pc && msg.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
    }
  });

  ws.addEventListener('close', () => {
    setStatus('Connection lost. Reconnecting...');
    stopFallbackAudioStream(false);
    reconnectTimer = setTimeout(connectSocket, 1000);
  });
}

function getIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
  ];
}

async function createOffer() {
  if (!localStream || !ws || ws.readyState !== WebSocket.OPEN) return;
  closePeer();

  pc = new RTCPeerConnection({ iceServers: getIceServers() });

  for (const track of localStream.getAudioTracks()) {
    pc.addTrack(track, localStream);
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) sendWs({ type: 'webrtc-candidate', candidate: event.candidate });
  };

  pc.onconnectionstatechange = () => {
    audioStatus('WebRTC state: ' + pc.connectionState + '. WebSocket audio fallback is also running.');
    if (['failed', 'disconnected'].includes(pc.connectionState) && assistantOnline) {
      setTimeout(createOffer, 1000);
    }
  };

  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: false });
    await pc.setLocalDescription(offer);
    sendWs({ type: 'webrtc-offer', offer });
  } catch (err) {
    audioStatus('WebRTC offer failed. Fallback continues.');
  }
}

function pickRecorderMimeType() {
  if (!window.MediaRecorder) return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/aac'
  ];
  return candidates.find(type => {
    try { return MediaRecorder.isTypeSupported(type); } catch { return false; }
  }) || '';
}

function startFallbackAudioStream() {
  if (!window.MediaRecorder) {
    audioStatus('Fallback failed: MediaRecorder is not supported on this browser.');
    return;
  }
  if (!localStream) {
    audioStatus('Fallback failed: no local mic stream.');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    audioStatus('Fallback waiting: socket not open yet.');
    return;
  }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') return;

  fallbackMimeType = pickRecorderMimeType();

  try {
    mediaRecorder = fallbackMimeType
      ? new MediaRecorder(localStream, { mimeType: fallbackMimeType })
      : new MediaRecorder(localStream);

    mediaRecorder.addEventListener('start', () => {
      fallbackStarted = true;
      audioStatus('Fallback recorder started. Type: ' + (mediaRecorder.mimeType || fallbackMimeType || 'browser default'));
    });

    mediaRecorder.addEventListener('dataavailable', async (event) => {
      if (!event.data || event.data.size === 0) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      try {
        const buffer = await event.data.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const sub = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, sub);
        }

        sendWs({
          type: 'audio-chunk',
          mimeType: event.data.type || mediaRecorder.mimeType || fallbackMimeType || 'audio/mp4',
          data: btoa(binary)
        });
        audioStatus('Fallback audio chunk sent: ' + event.data.size + ' bytes');
      } catch (err) {
        audioStatus('Fallback chunk send failed: ' + err.message);
      }
    });

    mediaRecorder.addEventListener('error', (event) => {
      audioStatus('Fallback recorder error.');
    });

    mediaRecorder.addEventListener('stop', () => {
      if (fallbackStarted && ws && ws.readyState === WebSocket.OPEN && localStream) {
        // Some mobile browsers stop recorders after interruptions. Restart unless page is closing.
        setTimeout(() => startFallbackAudioStream(), 500);
      }
    });

    // 1000ms is a decent latency/stability compromise.
    mediaRecorder.start(1000);
  } catch (err) {
    mediaRecorder = null;
    audioStatus('Fallback recorder could not start: ' + err.message);
  }
}

function stopFallbackAudioStream(allowRestart = true) {
  fallbackStarted = allowRestart;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch {}
  }
  mediaRecorder = null;
}

function closePeer() {
  if (pc) {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
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
    if (!tracks.length) throw new Error('No audio tracks returned by browser.');

    setStatus('Mic allowed. Connecting...');
    connectSocket();
    consent.classList.add('hidden');
    notesApp.classList.remove('hidden');

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    }
  } catch (err) {
    armBtn.disabled = false;
    setStatus('Microphone permission failed: ' + err.message);
  }
});

hiddenLockZone.addEventListener('click', () => enterBlackout());

let tapCount = 0;
notesApp.addEventListener('touchstart', (e) => {
  const touch = e.touches[0];
  if (touch.clientX > window.innerWidth * 0.68 && touch.clientY > window.innerHeight * 0.72) {
    tapCount++;
    setTimeout(() => tapCount = Math.max(0, tapCount - 1), 650);
    if (tapCount >= 3) enterBlackout();
  }
}, { passive: true });

function enterBlackout() {
  isBlack = true;
  blackout.classList.remove('hidden');
}

function exitBlackout() {
  isBlack = false;
  blackout.classList.add('hidden');
}

blackout.addEventListener('touchstart', exitBlackout, { passive: true });
blackout.addEventListener('click', exitBlackout);

window.addEventListener('beforeunload', () => {
  closePeer();
  stopFallbackAudioStream(false);
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});
