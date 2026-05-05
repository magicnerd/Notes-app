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
let pc;
let room;
let localStream;
let reconnectTimer;
let assistantOnline = false;
let lastNote = localStorage.getItem('lastNote') || prefillInput.value;
let offerTimer = null;

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

function getIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
  ];
}

function connectSocket() {
  clearTimeout(reconnectTimer);
  ws = new WebSocket(wsUrl());

  ws.addEventListener('open', () => {
    sendWs({ type: 'join', role: 'performer', room });
    sendWs({ type: 'prefill-note', note: getFullNote() });
    sendWs({ type: 'call-status', text: 'Performer joined. Microphone is armed.' });
    setStatus('Connected. Microphone armed.');
  });

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'joined') {
      assistantOnline = msg.assistantOnline;
      if (msg.note) updateNote(msg.note);
      if (assistantOnline) scheduleCallOffers();
    }

    if (msg.type === 'presence') {
      const wasOffline = !assistantOnline;
      assistantOnline = msg.assistantOnline;
      if (assistantOnline && wasOffline) scheduleCallOffers();
    }

    if (msg.type === 'note-update') updateNote(msg.note);

    if (msg.type === 'call-answer' && pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
      } catch {}
    }

    if (msg.type === 'call-candidate' && pc && msg.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch {}
    }
  });

  ws.addEventListener('close', () => {
    setStatus('Connection lost. Reconnecting...');
    closePeer();
    if (offerTimer) { clearInterval(offerTimer); offerTimer = null; }
    reconnectTimer = setTimeout(connectSocket, 1000);
  });
}


function scheduleCallOffers() {
  if (!assistantOnline || !localStream || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (offerTimer) return;
  startOneWayCall();
  offerTimer = setInterval(() => {
    if (!assistantOnline || !localStream || !ws || ws.readyState !== WebSocket.OPEN) {
      clearInterval(offerTimer);
      offerTimer = null;
      return;
    }
    if (!pc || ['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      startOneWayCall();
    }
  }, 2500);
}

async function startOneWayCall() {
  if (!localStream || !ws || ws.readyState !== WebSocket.OPEN) return;
  closePeer();

  pc = new RTCPeerConnection({ iceServers: getIceServers() });

  for (const track of localStream.getAudioTracks()) {
    pc.addTrack(track, localStream);
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) sendWs({ type: 'call-candidate', candidate: event.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    sendWs({ type: 'call-status', text: 'Call state: ' + pc.connectionState });
    if (['failed', 'disconnected'].includes(pc.connectionState) && assistantOnline) {
      setTimeout(startOneWayCall, 1000);
    }
  };

  try {
    const offer = await pc.createOffer({ offerToReceiveAudio: false, offerToReceiveVideo: false });
    await pc.setLocalDescription(offer);
    sendWs({ type: 'call-offer', offer });
    sendWs({ type: 'call-status', text: 'Call offer sent. Waiting for helper to answer.' });
  } catch {
    sendWs({ type: 'call-status', text: 'Call failed to start. Refresh both devices.' });
  }
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
  closePeer();
  if (localStream) localStream.getTracks().forEach(track => track.stop());
});
