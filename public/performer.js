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

function connectSocket() {
  clearTimeout(reconnectTimer);
  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', role: 'performer', room }));
    ws.send(JSON.stringify({ type: 'prefill-note', note: getFullNote() }));
    setStatus('Connected. Audio armed.');
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
    reconnectTimer = setTimeout(connectSocket, 1000);
  });
}

async function createOffer() {
  if (!localStream || !ws || ws.readyState !== WebSocket.OPEN) return;
  closePeer();

  pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
  });

  for (const track of localStream.getAudioTracks()) {
    pc.addTrack(track, localStream);
  }

  pc.onicecandidate = (event) => {
    if (event.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'webrtc-candidate', candidate: event.candidate }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected'].includes(pc.connectionState) && assistantOnline) {
      setTimeout(createOffer, 800);
    }
  };

  const offer = await pc.createOffer({ offerToReceiveAudio: false });
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'webrtc-offer', offer }));
}

function startFallbackAudioStream() {
  if (!window.MediaRecorder || !localStream || mediaRecorder) return;

  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/aac'
  ];

  fallbackMimeType = candidates.find(type => {
    try { return MediaRecorder.isTypeSupported(type); } catch { return false; }
  }) || '';

  try {
    mediaRecorder = fallbackMimeType
      ? new MediaRecorder(localStream, { mimeType: fallbackMimeType })
      : new MediaRecorder(localStream);

    mediaRecorder.addEventListener('dataavailable', async (event) => {
      if (!event.data || event.data.size === 0) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const buffer = await event.data.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);

      ws.send(JSON.stringify({
        type: 'audio-chunk',
        mimeType: event.data.type || fallbackMimeType || 'audio/mp4',
        data: btoa(binary)
      }));
    });

    // 1200ms keeps latency reasonable without hammering the server.
    mediaRecorder.start(1200);
  } catch (err) {
    mediaRecorder = null;
  }
}

function stopFallbackAudioStream() {
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

    connectSocket();
    startFallbackAudioStream();
    consent.classList.add('hidden');
    notesApp.classList.remove('hidden');

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    }
  } catch (err) {
    armBtn.disabled = false;
    setStatus('Microphone permission failed or was denied. Reopen and try again.');
  }
});

hiddenLockZone.addEventListener('click', () => enterBlackout());

let tapCount = 0;
notesApp.addEventListener('touchstart', (e) => {
  // Backup gesture: triple tap near bottom-right.
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
  stopFallbackAudioStream();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});
