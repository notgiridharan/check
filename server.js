/**
 * LiteMeet – Signalling Server
 * Node.js + Express + Socket.io
 *
 * Responsibilities:
 *  1. Serve static files (lite-meet.html, webrtc-client.js, socket.io)
 *  2. Manage rooms: participants, PIN auth, waiting-room knock flow
 *  3. Relay WebRTC signals: offer / answer / ice-candidate
 *  4. Relay lightweight data: whiteboard, chat, polls, docs, hand-raise, mute
 *  5. Aggregate poll votes server-side and broadcast updates
 *  6. Promote a new host when the current host disconnects
 */

'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

// ─── App setup ────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Increase buffer to support PDF relay (base64 of 30MB PDF = ~40MB)
  maxHttpBufferSize: 50 * 1024 * 1024,  // 50 MB
  // Helpful on slow networks – bigger ping timeout
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Serve all static files from the project root (html, js, etc.)
app.use(express.static(path.join(__dirname)));

// Root → main UI
app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'lite-meet.html'))
);

// ─── In-memory room store ─────────────────────────────────────────────────────
/**
 * rooms: Map<roomId, {
 *   pin        : string,          // '' means open room
 *   hostId     : string,          // socket.id of the current host
 *   participants: Map<socketId, { name: string, role: string }>,
 *   polls      : Map<pollId,   { q, opts, votes[], total }>,
 *   knockQueue : Map<socketId, string>  // waiting-room queue { socketId → name }
 *   sharedDocs : Map<docId, payload>    // cached doc-share payloads for late joiners
 *   docPages   : Map<docId, number>     // current page per doc
 *   docAnnots  : Map<docId, [pkt]>      // annotations per doc, keyed by page too
 * }>
 */
const rooms = new Map();

// ─── Global LMS State ─────────────────────────────────────────────────────────
const lmsState = {
  sessions: [],
  assignments: []
};

function getRoomOrCreate(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      pin: '',
      hostId: null,
      participants: new Map(),
      polls: new Map(),
      knockQueue: new Map(),
    });
  }
  return rooms.get(roomId);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.participants.size === 0) {
    // Free memory from cached doc b64 data
    if (room.sharedDocs) room.sharedDocs.clear();
    rooms.delete(roomId);
  }
}

// ─── Socket.io connection handler ────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[connect]', socket.id);

  // ── JOIN ─────────────────────────────────────────────────────────────────
  socket.on('join-room', ({ roomId, name, role, pin = '' }) => {
    if (!roomId || !name) { socket.emit('error', { msg: 'Invalid room or name.' }); return; }
    roomId = roomId.toUpperCase();

    const room = getRoomOrCreate(roomId);

    // ── PIN check ──────────────────────────────────────────────────────────
    if (room.pin && role !== 'host') {
      if (pin !== room.pin) {
        // Wrong PIN → put in waiting room (knock) if no PIN at all; else deny
        if (!pin) {
          // Student has no PIN → they need to knock
          room.knockQueue.set(socket.id, name);
          socket.emit('waiting-room', { msg: 'Waiting for host to admit you…' });
          if (room.hostId) {
            io.to(room.hostId).emit('peer-knock', { peerId: socket.id, name });
          }
          return;
        }
        socket.emit('error', { msg: 'Incorrect room PIN.' });
        return;
      }
    }

    // ── Set PIN when host joins ────────────────────────────────────────────
    if (role === 'host' && pin) {
      room.pin = pin;
    }

    _completeJoin(socket, room, roomId, name, role);
  });

  // ── LMS Sync ─────────────────────────────────────────────────────────────
  socket.on('lms-get-state', () => {
    socket.emit('lms-sync-state', lmsState);
  });

  socket.on('lms-update-state', (payload) => {
    lmsState.sessions = payload.sessions || lmsState.sessions;
    lmsState.assignments = payload.assignments || lmsState.assignments;
    // Broadcast to everyone else
    socket.broadcast.emit('lms-sync-state', lmsState);
  });

  // ── Host admits knock ─────────────────────────────────────────────────────
  socket.on('relay', ({ type, payload }) => {
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    // Inject sender info into every relayed packet
    const enriched = { ...payload, fromPeerId: socket.id, sender: socket.userName };

    if (type === 'knock-admit') {
      const { peerId } = payload;
      if (room.knockQueue.has(peerId)) {
        const name = room.knockQueue.get(peerId);
        room.knockQueue.delete(peerId);
        // Tell that waiting socket that they can now complete the join
        const waitingSocket = io.sockets.sockets.get(peerId);
        if (waitingSocket) {
          _completeJoin(waitingSocket, room, roomId, name, 'student');
        }
      }
      return;
    }

    if (type === 'knock-deny') {
      const { peerId } = payload;
      room.knockQueue.delete(peerId);
      const waitingSocket = io.sockets.sockets.get(peerId);
      if (waitingSocket) {
        waitingSocket.emit('error', { msg: 'Host denied your entry.' });
      }
      return;
    }

    // ── Poll vote aggregation ──────────────────────────────────────────────
    if (type === 'poll-launch') {
      const poll = {
        id: payload.id || Date.now().toString(),
        q: payload.q,
        opts: payload.opts,
        votes: new Array(payload.opts.length).fill(0),
        total: 0,
        open: true,
      };
      room.polls.set(poll.id, poll);
      // Broadcast to everyone including sender
      io.to(roomId).emit('poll-launched', poll);
      return;
    }

    if (type === 'poll-vote') {
      const poll = room.polls.get(payload.pollId);
      if (poll && poll.open) {
        poll.votes[payload.optIdx]++;
        poll.total++;
        io.to(roomId).emit('poll-update', { pollId: poll.id, votes: poll.votes, total: poll.total });
      }
      return;
    }

    if (type === 'poll-close') {
      const poll = room.polls.get(payload.pollId);
      if (poll) poll.open = false;
      socket.to(roomId).emit('poll-closed', { pollId: payload.pollId });
      return;
    }

    // ── Generic relay (whiteboard, chat, docs, hand-raise, media-state…) ──
    // Special: store doc-share in room so late-joiners can receive it
    if (type === 'doc-share') {
      if (!room.sharedDocs) room.sharedDocs = new Map();
      room.sharedDocs.set(payload.id, payload); // cache by docId
    }
    // Special: track current page per doc for late-joiners
    if (type === 'doc-page') {
      if (!room.docPages) room.docPages = new Map();
      room.docPages.set(payload.docId, payload.page);
    }
    // Special: accumulate annotations per doc for late-joiners
    if (type === 'doc-annot') {
      if (!room.docAnnots) room.docAnnots = new Map();
      const docId = payload.docId;
      if (docId) {
        if (payload.tool === 'clear-all') {
          // Remove annotations for that page
          const arr = room.docAnnots.get(docId) || [];
          room.docAnnots.set(docId, arr.filter(a => a.page !== payload.page));
        } else {
          const arr = room.docAnnots.get(docId) || [];
          arr.push(payload);
          // Cap at 200 annotations per doc to avoid memory leak
          if (arr.length > 200) arr.splice(0, arr.length - 200);
          room.docAnnots.set(docId, arr);
        }
      }
    }
    socket.to(roomId).emit(type, enriched);
  });

  // ── WebRTC signalling ──────────────────────────────────────────────────────
  socket.on('webrtc-signal', ({ targetId, type, data }) => {
    if (!targetId) return;
    io.to(targetId).emit('webrtc-signal', { fromId: socket.id, type, data });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', reason => {
    console.log('[disconnect]', socket.id, reason);
    const roomId = socket.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const info = room.participants.get(socket.id);
    room.participants.delete(socket.id);
    room.knockQueue.delete(socket.id);

    // Tell remaining peers
    io.to(roomId).emit('peer-left', { peerId: socket.id, name: info ? info.name : '' });

    // ── Host transfer ──────────────────────────────────────────────────────
    if (room.hostId === socket.id && room.participants.size > 0) {
      // Promote the participant who joined earliest (first in Map insertion order)
      const [newHostId, newHostInfo] = room.participants.entries().next().value;
      room.hostId = newHostId;
      newHostInfo.role = 'host';
      io.to(roomId).emit('host-changed', { peerId: newHostId, name: newHostInfo.name });
      // Tell the newly promoted host their role changed
      io.to(newHostId).emit('role-changed', { role: 'host' });
    }

    cleanupRoom(roomId);
    socket.leave(roomId);
  });
});

// ─── Helper: complete the join sequence ───────────────────────────────────────
function _completeJoin(socket, room, roomId, name, role) {
  socket.join(roomId);
  socket.roomId  = roomId;
  socket.userName = name;

  // First joiner is always host if none yet
  if (!room.hostId || role === 'host') {
    room.hostId = socket.id;
    role = 'host';
  }

  room.participants.set(socket.id, { name, role });

  // List of existing participants to send back to the joiner
  const existingParticipants = [];
  for (const [id, info] of room.participants) {
    if (id !== socket.id) existingParticipants.push({ peerId: id, name: info.name, role: info.role });
  }

  // Tell the joiner about the room state
  socket.emit('joined', {
    role,
    participants: existingParticipants,
    polls: Array.from(room.polls.values()),
  });

  // Send any docs the host already shared (late-joiner catch-up)
  if (room.sharedDocs && room.sharedDocs.size > 0) {
    for (const [, docPayload] of room.sharedDocs) {
      // Small delay so client has time to set up doc listeners
      setTimeout(() => {
        socket.emit('doc-share', { ...docPayload, fromPeerId: room.hostId, sender: 'host' });
        // Also send current page if host has navigated
        if (room.docPages && room.docPages.has(docPayload.id)) {
          socket.emit('doc-page', {
            page:  room.docPages.get(docPayload.id),
            docId: docPayload.id,
            fromPeerId: room.hostId,
          });
        }
        // Replay saved annotations for this doc
        if (room.docAnnots && room.docAnnots.has(docPayload.id)) {
          const annots = room.docAnnots.get(docPayload.id);
          for (const a of annots) {
            socket.emit('doc-annot', { ...a, fromPeerId: room.hostId });
          }
        }
      }, 1800);
    }
  }

  // Tell existing peers about the new arrival
  socket.to(roomId).emit('peer-joined-pending', { peerId: socket.id, name, role });

  console.log(`[join] ${name} (${role}) → ${roomId}  participants: ${room.participants.size}`);
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🟢  LiteMeet server ready → http://localhost:${PORT}\n`));