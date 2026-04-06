/**
 * LiteMeet – WebRTC Client Module
 *
 * Responsibilities:
 *  1. Connect to the signalling socket server
 *  2. Join the room and authenticate (PIN)
 *  3. Create RTCPeerConnections for each remote peer (full-mesh)
 *  4. Add local media tracks, handle ICE negotiation
 *  5. Emit "peer-stream" when remote video/audio arrives
 *  6. Relay lightweight data (whiteboard, chat, polls, etc.) via socket
 *  7. Adapt video/audio bitrate for 4G / 3G / 2G network profiles
 */

'use strict';

(function (global) {

  // ── ICE servers ─────────────────────────────────────────────────────────────
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // Public TURN (fallback for symmetric NAT)
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ];

  // ── Bitrate caps per network profile ────────────────────────────────────────
  // videoBps=1 for 'bad' because maxBitrate=0 is treated as "no limit" in some
  // browsers. Setting active=false + track.enabled=false reliably disables video.
  const NET_PROFILES = {
    good: { videoBps: 2_500_000, audioBps: 128_000, videoEnabled: true,  label:'4G' },  // 4G / WiFi — max quality
    mid:  { videoBps:    48_000, audioBps:  16_000, videoEnabled: true,  label:'3G' },  // 3G compressed
    bad:  { videoBps:         1, audioBps:   6_000, videoEnabled: false, label:'2G' },  // 2G – Opus voice 6kbps
  };

  // ── Main class ──────────────────────────────────────────────────────────────
  class LiteMeetClient {
    /**
     * @param {object} options
     * @param {string} options.serverUrl
     * @param {string} options.roomId
     * @param {string} options.name
     * @param {string} options.role   'host' | 'student'
     * @param {string} [options.pin]
     */
    constructor(options) {
      this._opts       = options;
      this._handlers   = {};      // event → callback
      this._peers      = new Map(); // peerId → { pc, name, role }
      this._localStream = null;
      this._netProfile  = 'good';
      this._socket      = null;
      this._myId        = null;    // own socket.id (set after connection)
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Connect to socket, join room, set up WebRTC for all existing peers.
     * @param {MediaStream|null} localStream
     */
    connect(localStream) {
      this._localStream = localStream;
      this._initSocket();
    }

    /**
     * Send a lightweight data packet to all peers via server relay.
     * @param {string} type
     * @param {object} payload
     */
    send(type, payload = {}) {
      if (this._socket && this._socket.connected) {
        this._socket.emit('relay', { type, payload });
      }
    }

    /**
     * Change network profile – adapts bitrate on all active peer connections.
     * @param {'good'|'mid'|'bad'} profileName
     */
    setNetworkProfile(profileName) {
      if (!NET_PROFILES[profileName]) return;
      this._netProfile = profileName;
      for (const [, entry] of this._peers) {
        this._applyBitrate(entry.pc, profileName);
      }
    }

    /** Tear everything down (called on explicit leave or page unload). */
    disconnect() {
      this._manualDisconnect = true;
      for (const [peerId] of this._peers) this._closePeer(peerId);
      if (this._socket) this._socket.disconnect();
    }

    /** Subscribe to a client event. */
    on(event, callback)  { this._handlers[event] = callback; }
    /** Emit a client event. */
    _emit(event, data)   { if (this._handlers[event]) this._handlers[event](data); }

    // ── Socket initialisation ─────────────────────────────────────────────────
    _initSocket() {
      const { serverUrl, roomId, name, role, pin = '' } = this._opts;

      // io() is loaded from /socket.io/socket.io.js by the HTML
      // reconnection: true is the default; we keep it and handle the re-join ourselves.
      const socket = io(serverUrl, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity,
      });
      this._socket = socket;
      this._manualDisconnect = false;

      // ── Lifecycle ──────────────────────────────────────────────────────────
      socket.on('connect', () => {
        this._myId = socket.id;
        this._emit('connected', {});
        // Join (or re-join after reconnect)
        socket.emit('join-room', { roomId, name, role, pin });
      });

      socket.on('disconnect', reason => {
        // Tear down all peer connections immediately so stale ICE state
        // doesn't block fresh negotiation after reconnect.
        // Do NOT emit 'peer-left' here — the server will do that for others;
        // we just clean up our local PC objects silently.
        for (const [peerId] of this._peers) this._closePeer(peerId);
        this._emit('disconnected', { reason });
      });

      socket.on('connect_error', err => {
        this._emit('error', { msg: 'Connection failed: ' + (err.message || err) });
      });

      // ── Room events ────────────────────────────────────────────────────────
      socket.on('error', ({ msg }) => this._emit('error', { msg }));

      socket.on('waiting-room', ({ msg }) => {
        this._emit('error', { msg }); // surface to the UI as a toast
      });

      socket.on('joined', ({ role: myRole, participants, polls = [] }) => {
        // Clean up any lingering PCs before rebuilding (handles reconnect case
        // where disconnect handler may not have run yet)
        for (const [peerId] of this._peers) this._closePeer(peerId);

        this._emit('joined', { role: myRole, participants });

        // Restore any open polls
        polls.forEach(poll => this._emit('poll-launched', poll));

        // For every existing peer, WE initiate the offer (we are the newcomer)
        participants.forEach(({ peerId, name: pName, role: pRole }) => {
          this._createPc(peerId, pName, pRole, true /* isInitiator */);
        });
      });

      socket.on('peer-joined-pending', ({ peerId, name: pName, role: pRole }) => {
        this._emit('peer-joined-pending', { peerId, name: pName, role: pRole });
        // The NEW peer will initiate offers TO us, so we just create the PC
        this._createPc(peerId, pName, pRole, false /* wait for their offer */);
      });

      socket.on('peer-left', ({ peerId, name: pName }) => {
        this._closePeer(peerId);
        this._emit('peer-left', { peerId, name: pName });
      });

      socket.on('host-changed', info => this._emit('host-changed', info));
      socket.on('role-changed', ({ role: newRole }) => {
        // Server promoted us to host
        this._emit('joined', { role: newRole, participants: [] });
      });

      // ── WebRTC signal forwarding ───────────────────────────────────────────
      socket.on('webrtc-signal', async ({ fromId, type, data }) => {
        if (type === 'offer')         await this._handleOffer(fromId, data);
        else if (type === 'answer')   await this._handleAnswer(fromId, data);
        else if (type === 'ice')      await this._handleIce(fromId, data);
      });

      // ── Relayed data events ────────────────────────────────────────────────
      const RELAY_EVENTS = [
        'wb-stroke', 'wb-clear', 'wb-undo',
        'chat-msg',
        'doc-share',   // host broadcasts full file (base64) to students
        'doc-page',    // host page-change coordinate packet
        'doc-annot',   // host annotation coordinate packet
        'poll-launched', 'poll-update', 'poll-closed',
        'peer-media-state', 'peer-hand', 'peer-knock',
        'mute-all',
        'focus-sync',
        'host-only-view',
        'knock-admit', 'knock-deny',
      ];
      RELAY_EVENTS.forEach(ev => {
        socket.on(ev, payload => this._emit(ev, payload));
      });
    }

    // ── RTCPeerConnection management ──────────────────────────────────────────

    _createPc(peerId, peerName, peerRole, isInitiator) {
      if (this._peers.has(peerId)) return; // already exists

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      this._peers.set(peerId, { pc, name: peerName, role: peerRole });

      // Add our local tracks
      if (this._localStream) {
        this._localStream.getTracks().forEach(track => {
          try { pc.addTrack(track, this._localStream); } catch (e) {}
        });
      }

      // ICE candidate → forward to peer
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) {
          this._signal(peerId, 'ice', candidate.toJSON());
        }
      };

      // Connection state changes
      pc.oniceconnectionstatechange = () => {
        this._emit('ice-state', { peerId, state: pc.iceConnectionState });
      };

      // Remote tracks
      pc.ontrack = ({ streams: [stream] }) => {
        if (stream) this._emit('peer-stream', { peerId, stream });
      };

      // Negotiation needed (Chrome fires this automatically on addTrack)
      pc.onnegotiationneeded = async () => {
        if (!isInitiator) return; // only the initiator creates offers
        try { await this._createOffer(peerId, pc); }
        catch (e) { console.warn('[WebRTC] negotiationneeded error', e); }
      };

      // Apply current network profile
      this._applyBitrateWhenReady(pc);

      if (isInitiator) {
        this._createOffer(peerId, pc).catch(e =>
          console.warn('[WebRTC] offer error', e)
        );
      }
    }

    async _createOffer(peerId, pc) {
      const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      this._signal(peerId, 'offer', pc.localDescription.toJSON());
    }

    async _handleOffer(fromId, sdp) {
      let entry = this._peers.get(fromId);
      if (!entry) {
        // Peer joined before we processed peer-joined-pending; create PC now
        this._createPc(fromId, 'Peer', 'student', false);
        entry = this._peers.get(fromId);
      }
      const { pc } = entry;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._signal(fromId, 'answer', pc.localDescription.toJSON());
    }

    async _handleAnswer(fromId, sdp) {
      const entry = this._peers.get(fromId);
      if (!entry || entry.pc.signalingState === 'stable') return;
      try {
        await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (e) { console.warn('[WebRTC] setRemoteDescription(answer)', e); }
    }

    async _handleIce(fromId, candidate) {
      const entry = this._peers.get(fromId);
      if (!entry) return;
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) { /* ignore late candidates */ }
    }

    _closePeer(peerId) {
      const entry = this._peers.get(peerId);
      if (!entry) return;
      try { entry.pc.close(); } catch (e) {}
      this._peers.delete(peerId);
    }

    _signal(targetId, type, data) {
      this._socket.emit('webrtc-signal', { targetId, type, data });
    }

    // ── Bitrate adaptation ────────────────────────────────────────────────────

    /** Apply bitrate as soon as senders are available. */
    _applyBitrateWhenReady(pc) {
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected') {
          this._applyBitrate(pc, this._netProfile);
        }
      });
    }

    async _applyBitrate(pc, profileName) {
      const profile = NET_PROFILES[profileName] || NET_PROFILES.good;
      const senders = pc.getSenders();
      for (const sender of senders) {
        if (!sender.track) continue;
        try {
          const params = sender.getParameters();
          if (!params.encodings || !params.encodings.length) {
            params.encodings = [{}];
          }
          const enc = params.encodings[0];

          if (sender.track.kind === 'video') {
            // For 2G: set 1 bps (minimum non-zero) and deactivate encoding
            enc.maxBitrate = profile.videoEnabled ? profile.videoBps : 1;
            enc.active     = profile.videoEnabled;
            // Disable local video track so no frames are captured/encoded at all
            sender.track.enabled = profile.videoEnabled;

            if (profileName === 'mid') {
              // 3G: heavy resolution downscale — quarter res (180p from 720p).
              // Low data = no packet drops = no stutter. Looks pixelated, plays smoothly.
              enc.scaleResolutionDownBy = 4;
              enc.maxFramerate = 24;      // stable 24fps, not choppy
            } else if (profile.videoEnabled) {
              // 4G / WiFi: full resolution, no artificial frame-rate cap
              delete enc.scaleResolutionDownBy;
              delete enc.maxFramerate;
            }
          } else if (sender.track.kind === 'audio') {
            enc.maxBitrate = profile.audioBps;
            // In 2G mode, keep audio active but at minimum bitrate for voice
            enc.active = true;
          }

          await sender.setParameters(params);
        } catch (e) {
          // setParameters not supported in all browsers — try track.enabled fallback
          if (sender.track.kind === 'video') {
            sender.track.enabled = profile.videoEnabled;
          }
        }
      }
    }

    /**
     * Replace the local video track for all connected peers
     * @param {MediaStreamTrack|null} newTrack
     */
    async replaceVideoTrack(newTrack) {
      if (!this._peers) return;
      const promises = [];
      for (const [, entry] of this._peers) {
        if (!entry.pc) continue;
        const senders = entry.pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender) {
          promises.push(videoSender.replaceTrack(newTrack).catch(e => {}));
        } else if (newTrack) {
          try {
            entry.pc.addTrack(newTrack, this._localStream || new MediaStream([newTrack]));
          } catch(e) {}
        }
      }
      await Promise.all(promises);
    }
  }

  // Expose globally so the HTML can use: new LiteMeetClient({ ... })
  global.LiteMeetClient = LiteMeetClient;

})(window);