"use client";
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { HandModel } from "../components/HandModel";
import Image from "next/image";
import logo from "../assets/logo.png";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";
import * as THREE from 'three';

// ─── Sensor readings panel ───────────────────────────────────────────────────
// All pad channel metadata mirrored from the ESP firmware padDefs array.
const FLEX_META = [
  { key: 'idx_mcp', label: 'Index MCP', color: '#60a5fa' },
  { key: 'idx_pcp', label: 'Index PIP', color: '#93c5fd' },
  { key: 'mid_mcp', label: 'Middle MCP', color: '#4ade80' },
  { key: 'mid_pcp', label: 'Middle PIP', color: '#86efac' },
  { key: 'rng_mcp', label: 'Ring MCP', color: '#f472b6' },
  { key: 'rng_pcp', label: 'Ring PIP', color: '#f9a8d4' },
  { key: 'pky_mcp', label: 'Pinky MCP', color: '#a78bfa' },
  { key: 'pky_pcp', label: 'Pinky PIP', color: '#c4b5fd' },
];
const FRONT_ZONE_NAMES = ['Bottom (10Ω)', 'Lower-Mid (330Ω)', 'Upper-Mid (470Ω)', 'Tip (1kΩ)', 'Touch (5kΩ)'];
const SIDE_ZONE_NAMES = ['Side-High', 'Side-Mid', 'Two-Fingers'];
const TOP_ZONE_NAMES = ['Index', 'Middle', 'Ring', 'Pinky'];
const PAD_META = [
  { key: 'PAD_FRONT0', label: 'Front: Index', color: '#60a5fa', zones: FRONT_ZONE_NAMES },
  { key: 'PAD_FRONT1', label: 'Front: Middle', color: '#4ade80', zones: FRONT_ZONE_NAMES },
  { key: 'PAD_FRONT2', label: 'Front: Ring', color: '#f472b6', zones: FRONT_ZONE_NAMES },
  { key: 'PAD_FRONT3', label: 'Front: Pinky', color: '#a78bfa', zones: FRONT_ZONE_NAMES },
  { key: 'PAD_TOP', label: 'Top Palm', color: '#e2b96f', zones: TOP_ZONE_NAMES },
  { key: 'PAD_UNUSED5', label: 'Unused 5', color: '#4a5568', zones: [] },
  { key: 'PAD_SIDE6', label: 'Side: Middle', color: '#4ade80', zones: SIDE_ZONE_NAMES },
  { key: 'PAD_SIDE7', label: 'Side: Ring', color: '#f472b6', zones: SIDE_ZONE_NAMES },
  { key: 'PAD_SIDE8', label: 'Side: Pinky', color: '#a78bfa', zones: SIDE_ZONE_NAMES },
  { key: 'PAD_SIDE9', label: 'Side: Index', color: '#60a5fa', zones: SIDE_ZONE_NAMES },
  { key: 'PAD_TEST10', label: 'Test 10', color: '#4a5568', zones: [] },
  { key: 'PAD_TEST11', label: 'Test 11', color: '#4a5568', zones: [] },
  { key: 'PAD_TEST12', label: 'Test 12', color: '#4a5568', zones: [] },
  { key: 'PAD_TEST13', label: 'Test 13', color: '#4a5568', zones: [] },
  { key: 'PAD_TEST14', label: 'Test 14', color: '#4a5568', zones: [] },
  { key: 'PAD_TEST15', label: 'Test 15', color: '#4a5568', zones: [] },
];

const FINGER_LABELS = [
  { label: 'Pinky Yaw', idx: 0 },
  { label: 'Pinky MCP', idx: 1 },
  { label: 'Pinky PIP', idx: 2 },
  { label: 'Ring Yaw', idx: 3 },
  { label: 'Ring MCP', idx: 4 },
  { label: 'Ring PIP', idx: 5 },
  { label: 'Middle Yaw', idx: 6 },
  { label: 'Middle MCP', idx: 7 },
  { label: 'Middle PIP', idx: 8 },
  { label: 'Index Yaw', idx: 9 },
  { label: 'Index MCP', idx: 10 },
  { label: 'Index PIP', idx: 11 },
  { label: 'Thumb Yaw', idx: 12 },
  { label: 'Thumb MCP', idx: 13 },
  { label: 'Thumb PIP', idx: 14 },
  { label: 'Thumb DIP', idx: 15 },
];

const IMU_PACKET_HEADER = 0xAABBCCDD;
const FINGER_PACKET_HEADER = 0xF1F2F3F4;
const RAW_VOLTAGES_PACKET_HEADER = 0xC0DEC0DE;
const FINGER_PACKET_OFFSET = 8;
const FINGER_PACKET_FLOATS = 16;
const DEG2RAD = Math.PI / 180;

const CMD = {
  TARE_IMU: 0x01,
  START_BOOT_CAL: 0x02,
  START_MAG_CAL: 0x03,
  END_MAG_CAL: 0x04,
  SET_KNOTS: 0x10,
  SET_COUPLING: 0x11,
  SAVE_CAL: 0x12,
  LOAD_CAL: 0x13,
  SWITCH_TO_WIFI: 0x20,
  SWITCH_TO_BLE: 0x21,
  REQUEST_RAW: 0x30,
  DEVICE_RESET: 0xFF,
};

const CALIBRATION_STEPS = [
  { pct: 0, label: '0% - flat / relaxed / furthest left' },
  { pct: 25, label: '25% - slight curl' },
  { pct: 50, label: '50% - mid curl / centered' },
  { pct: 75, label: '75% - strong curl' },
  { pct: 100, label: '100% - fully curled / furthest right' },
];

const CAL_FINGER_NAMES = ['Pinky', 'Ring', 'Middle', 'Index', 'Thumb'];
const CAL_AXIS_NAMES = ['Yaw', 'Pitch 1', 'Pitch 2', 'Thumb IP'];

const CAL_FINGER_DEFAULTS = [
  [8, 9, 10, -1],
  [11, 12, 13, -1],
  [0, 15, 14, -1],
  [1, 2, 3, -1],
  [7, 6, 5, 4],
];

const DEFAULT_SAMPLE_COUNT = 35;
const DEFAULT_SAMPLE_DELAY_MS = 50;

const EMPTY_FINGER = { yaw: 0, pitch1: 0, pitch2: 0 };

const toRad = (deg) => (Number.isFinite(deg) ? deg : 0) * DEG2RAD;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildCommandBuffer(cmdId, payload) {
  if (!payload || payload.length === 0) {
    return new Uint8Array([cmdId]);
  }
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = cmdId;
  buf.set(payload, 1);
  return buf;
}

function buildKnotsPayload(fingerIdx, axisIdx, knots) {
  const buf = new ArrayBuffer(2 + (5 * 4));
  const view = new DataView(buf);
  view.setUint8(0, fingerIdx);
  view.setUint8(1, axisIdx);
  for (let i = 0; i < 5; i += 1) {
    view.setFloat32(2 + (i * 4), knots[i] ?? 0, true);
  }
  return new Uint8Array(buf);
}

function buildCouplingPayload(fingerIdx, coeffs) {
  const buf = new ArrayBuffer(1 + (4 * 4));
  const view = new DataView(buf);
  view.setUint8(0, fingerIdx);
  for (let i = 0; i < 4; i += 1) {
    view.setFloat32(1 + (i * 4), coeffs[i] ?? 0, true);
  }
  return new Uint8Array(buf);
}

function quatFromEuler(x, y, z) {
  const q = new THREE.Quaternion();
  q.setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
  return [q.x, q.y, q.z, q.w];
}

function buildFingerQuats(fingers, thumbExtra) {
  if (!Array.isArray(fingers) || fingers.length < 5) return null;

  const pinky = fingers[0] ?? EMPTY_FINGER;
  const ring = fingers[1] ?? EMPTY_FINGER;
  const middle = fingers[2] ?? EMPTY_FINGER;
  const index = fingers[3] ?? EMPTY_FINGER;
  const thumb = fingers[4] ?? EMPTY_FINGER;

  const mcpQuat = (f) => quatFromEuler(toRad(f.pitch1), toRad(f.yaw), 0);
  const pipQuat = (f) => quatFromEuler(toRad(f.pitch2), 0, 0);
  const thumbIp = quatFromEuler(toRad(thumbExtra), 0, 0);

  const indexMcp = mcpQuat(index);
  const indexPip = pipQuat(index);
  const middleMcp = mcpQuat(middle);
  const middlePip = pipQuat(middle);
  const ringMcp = mcpQuat(ring);
  const ringPip = pipQuat(ring);
  const pinkyMcp = mcpQuat(pinky);
  const pinkyPip = pipQuat(pinky);

  return [
    mcpQuat(thumb),
    pipQuat(thumb),
    thumbIp,
    indexMcp,
    indexPip,
    indexPip,
    middleMcp,
    middlePip,
    middlePip,
    ringMcp,
    ringPip,
    ringPip,
    pinkyMcp,
    pinkyPip,
    pinkyPip,
    pinkyPip,
  ];
}

function buildRigData(frame) {
  if (!frame) return null;
  const fingers = buildFingerQuats(frame.fingerAngles, frame.thumbExtra);

  return {
    palm: frame.imuQuat ?? undefined,
    fingers: fingers ?? undefined,
  };
}

function useGloveWebSocket(ipAddress, onFrame) {
  const [connectionId, setConnectionId] = useState(0);
  const [gloveState, setGloveState] = useState({
    connected: false,
    imuQuat: null,
    fingerAngles: null,
    fingerAnglesFlat: null,
    thumbExtra: 0,
    imuTimestamp: null,
    fingerTimestamp: null,
  });
  const imuQuatRef = useRef(null);
  const fingerAnglesRef = useRef(null);
  const fingerAnglesFlatRef = useRef(null);
  const thumbExtraRef = useRef(0);
  const wsRef = useRef(null);

  const reconnect = useCallback(() => {
    setConnectionId(id => id + 1);
  }, []);

  useEffect(() => {
    if (!ipAddress) return undefined;

    const socket = new WebSocket(`ws://${ipAddress}:81`);
    socket.binaryType = 'arraybuffer';
    wsRef.current = socket;

    socket.onopen = () => {
      //console.log('[Glove] Connected');
      setGloveState(prev => ({ ...prev, connected: true }));
    };
    socket.onclose = () => {
      //console.log('[Glove] Disconnected');
      setGloveState(prev => ({ ...prev, connected: false }));
      wsRef.current = null;
    };
    socket.onerror = (e) => console.error('[Glove] Error:', e);

    socket.onmessage = async (event) => {
      try {
        const buffer = event.data instanceof ArrayBuffer
          ? event.data
          : await event.data.arrayBuffer();

        const view = new DataView(buffer);
        const header = view.getUint32(0, true);

        if (header === IMU_PACKET_HEADER) {
          if (view.byteLength < 24) return;
          const timestamp = view.getUint32(4, true);
          const qw = view.getFloat32(8, true);
          const qx = view.getFloat32(12, true);
          const qy = view.getFloat32(16, true);
          const qz = view.getFloat32(20, true);
          const q = new THREE.Quaternion(qx, qy, qz, qw).normalize();
          const imuQuat = [q.x, q.y, q.z, q.w];
          imuQuatRef.current = imuQuat;

          setGloveState(prev => ({
            ...prev,
            imuQuat,
            imuTimestamp: timestamp,
          }));

          if (onFrame) {
            onFrame({
              source: 'imu',
              fingers: fingerAnglesFlatRef.current,
              fingerAngles: fingerAnglesRef.current,
              imuQuat,
              flex: {},
              pads: [],
            });
          }
          return;
        }

        if (header === RAW_VOLTAGES_PACKET_HEADER) {
          if (view.byteLength < 72) return;
          const timestamp = view.getUint32(4, true);
          const voltages = new Array(16);
          for (let i = 0; i < 16; i += 1) {
            voltages[i] = view.getFloat32(8 + i * 4, true);
          }
          if (onFrame) {
            onFrame({ source: 'raw', voltages, timestamp });
          }
          return;
        }

        if (header !== FINGER_PACKET_HEADER) return;
        if (view.byteLength < FINGER_PACKET_OFFSET + (FINGER_PACKET_FLOATS * 4)) return;

        const timestamp = view.getUint32(4, true);
        const floats = new Array(FINGER_PACKET_FLOATS);
        let offset = FINGER_PACKET_OFFSET;
        for (let i = 0; i < FINGER_PACKET_FLOATS; i += 1) {
          floats[i] = view.getFloat32(offset, true);
          offset += 4;
        }

        const fingers = [];
        for (let f = 0; f < 5; f += 1) {
          const base = f * 3;
          fingers.push({
            yaw: floats[base],
            pitch1: floats[base + 1],
            pitch2: floats[base + 2],
          });
        }

        const thumbExtra = floats[15] ?? 0;
        fingerAnglesRef.current = fingers;
        fingerAnglesFlatRef.current = floats;
        thumbExtraRef.current = thumbExtra;

        setGloveState(prev => ({
          ...prev,
          fingerAngles: fingers,
          fingerAnglesFlat: floats,
          thumbExtra,
          fingerTimestamp: timestamp,
        }));

        if (onFrame) {
          onFrame({
            source: 'finger',
            fingers: floats,
            fingerAngles: fingers,
            thumbExtra,
            imuQuat: imuQuatRef.current,
            flex: {},
            pads: [],
          });
        }
      } catch (err) {
        console.error('Glove packet parse error:', err);
      }
    };

    return () => socket.close();
  }, [ipAddress, onFrame, connectionId]);

  const sendCommand = useCallback((cmdId, payload) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(buildCommandBuffer(cmdId, payload));
    }
  }, []);

  return { ...gloveState, sendCommand, reconnect };
}

function SensorReadingsPanel({ frame }) {
  const [open, setOpen] = useState(true);
  const flex = frame?.flex ?? {};
  const pads = frame?.pads ?? [];
  // Build a lookup map from pad name → pad object
  const padMap = {};
  pads.forEach(p => { padMap[p.n] = p; });

  const sp = {
    wrap: { background: 'rgba(10,12,28,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', backdropFilter: 'blur(12px)' },
    header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: open ? '1px solid rgba(255,255,255,0.06)' : 'none', cursor: 'pointer', userSelect: 'none' },
    title: { fontSize: 12, fontWeight: 600, color: '#a0aec0', letterSpacing: '0.8px', textTransform: 'uppercase' },
    toggle: { fontSize: 11, color: '#4a5568', padding: '2px 8px', background: 'rgba(255,255,255,0.04)', borderRadius: 6, border: '1px solid rgba(255,255,255,0.07)', cursor: 'pointer' },
    body: { maxHeight: 420, overflowY: 'auto', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 14 },
    section: { display: 'flex', flexDirection: 'column', gap: 4 },
    sectionTitle: { fontSize: 10, fontWeight: 600, color: '#4a5568', letterSpacing: '1px', textTransform: 'uppercase', marginBottom: 4, paddingBottom: 3, borderBottom: '1px solid rgba(255,255,255,0.04)' },
    row: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 22 },
    dot: (color) => ({ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }),
    lbl: { fontSize: 11, color: '#718096', width: 90, flexShrink: 0 },
    barBg: { flex: 1, height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' },
    barFill: (color, pct) => ({ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.15s' }),
    val: { fontSize: 10.5, color: '#e2b96f', width: 36, textAlign: 'right', flexShrink: 0 },
    zone: (active) => ({ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: active ? 'rgba(226,185,111,0.18)' : 'rgba(255,255,255,0.03)', color: active ? '#e2b96f' : '#4a5568', border: `1px solid ${active ? 'rgba(226,185,111,0.35)' : 'rgba(255,255,255,0.05)'}`, transition: 'all 0.15s' }),
    rawVal: { fontSize: 10, color: '#4a5568', width: 36, textAlign: 'right', flexShrink: 0 },
  };

  return (
    <div style={sp.wrap}>
      <div style={sp.header} onClick={() => setOpen(o => !o)}>
        <span style={sp.title}>📡 Sensor Readings</span>
        <span style={sp.toggle}>{open ? '▲ Hide' : '▼ Show'}</span>
      </div>
      {open && (
        <div style={sp.body}>
          {/* ── Flex sensors ── */}
          <div style={sp.section}>
            <div style={sp.sectionTitle}>Flex Sensors</div>
            {FLEX_META.map(({ key, label, color }) => {
              const curl = flex[key]?.curl ?? 0;
              const raw = flex[key]?.raw ?? 0;
              return (
                <div key={key} style={sp.row}>
                  <div style={sp.dot(color)} />
                  <span style={sp.lbl}>{label}</span>
                  <div style={sp.barBg}>
                    <div style={sp.barFill(color, Math.round(curl * 100))} />
                  </div>
                  <span style={sp.val}>{(curl * 100).toFixed(0)}%</span>
                  <span style={sp.rawVal}>{raw}</span>
                </div>
              );
            })}
          </div>

          {/* ── Contact pads ── */}
          <div style={sp.section}>
            <div style={sp.sectionTitle}>Contact Pads</div>
            {PAD_META.map(({ key, label, color, zones }) => {
              const pad = padMap[key];
              const z = pad?.z ?? -1;
              const r = pad?.r ?? 0;
              const active = z !== -1;
              return (
                <div key={key} style={{ ...sp.row, flexWrap: 'wrap', rowGap: 3, alignItems: 'flex-start', paddingBottom: zones.length ? 4 : 0 }}>
                  <div style={{ ...sp.row, width: '100%', flexWrap: 'nowrap' }}>
                    <div style={sp.dot(active ? color : '#2d3748')} />
                    <span style={{ ...sp.lbl, color: active ? '#a0aec0' : '#4a5568' }}>{label}</span>
                    <div style={sp.barBg}>
                      <div style={sp.barFill(color, active ? Math.min(100, (r / 4095) * 100) : 0)} />
                    </div>
                    <span style={sp.val}>{active ? `z${z}` : '—'}</span>
                    <span style={sp.rawVal}>{active ? r : '—'}</span>
                  </div>
                  {zones.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, paddingLeft: 15, flexWrap: 'wrap' }}>
                      {zones.map((zn, zi) => (
                        <span key={zi} style={sp.zone(active && z === zi)}>{zn}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function FingerAnglesPanel({ frame }) {
  const f = Array.isArray(frame?.fingers) ? frame.fingers : null;

  const fp = {
    wrap: { background: 'rgba(10,12,28,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', backdropFilter: 'blur(12px)' },
    header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' },
    title: { fontSize: 12, fontWeight: 600, color: '#a0aec0', letterSpacing: '0.8px', textTransform: 'uppercase' },
    body: { padding: '10px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
    item: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)' },
    label: { fontSize: 11, color: '#718096' },
    value: { fontSize: 11.5, color: '#e2b96f', fontVariantNumeric: 'tabular-nums' },
    empty: { padding: '12px 14px', fontSize: 12, color: '#4a5568' },
  };

  return (
    <div style={fp.wrap}>
      <div style={fp.header}>
        <span style={fp.title}>🧮 Finger Angles (deg)</span>
      </div>
      {!f ? (
        <div style={fp.empty}>No glove data yet.</div>
      ) : (
        <div style={fp.body}>
          {FINGER_LABELS.map(({ label, idx }) => (
            <div key={label} style={fp.item}>
              <span style={fp.label}>{label}</span>
              <span style={fp.value}>{Number.isFinite(f[idx]) ? f[idx].toFixed(1) : '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Tiny reusable 3-D scene wrapper ─────────────────────────────────────────
// Update the Scene component to accept and forward the props:
function Scene({ rigData }) {
  return (
    <Canvas camera={{ position: [0, 0, 1], fov: 65 }} style={{ width: '100%', height: '100%' }}>
      <ambientLight intensity={1.8} />
      <directionalLight position={[5, 10, 5]} intensity={2.5} />
      <pointLight position={[-5, 5, -3]} intensity={0.6} />
      <HandModel sensorData={rigData} />
    </Canvas>
  );
}
// ─── Recording modal ──────────────────────────────────────────────────────────
function RecordingModal({
  signLabel,
  isRecording,
  frames,
  trimRange,
  setTrimRange,
  onStop,
  onDiscard,
  onSave,
  currentFrame,
  calibrate,
}) {
  const frameCount = frames.length;
  const duration = (frameCount / 60).toFixed(1);
  const trimStart = trimRange[0];
  const trimEnd = trimRange[1];
  const trimmedCount = Math.max(0, Math.floor(((trimEnd - trimStart) / 100) * frameCount));

  // Playback of recorded frames when stopped
  const [playbackFrame, setPlaybackFrame] = useState(null);
  const playbackRef = useRef(null);

  useEffect(() => {
    if (!isRecording && frames.length > 0) {
      // Loop playback over trimmed range
      let idx = Math.floor((trimStart / 100) * frames.length);
      const endIdx = Math.floor((trimEnd / 100) * frames.length);
      playbackRef.current = setInterval(() => {
        setPlaybackFrame(frames[idx]);
        idx++;
        if (idx >= endIdx) idx = Math.floor((trimStart / 100) * frames.length);
      }, 1000 / 30); // 30fps playback
    }
    return () => clearInterval(playbackRef.current);
  }, [isRecording, frames, trimStart, trimEnd]);

  const displayFrame = isRecording ? currentFrame : playbackFrame;
  const displayRigData = buildRigData(displayFrame);

  return (
    <div style={rm.overlay}>
      <style>
        {`.close-btn:hover { background: #2e2e51 !important; }`}
      </style>
      <div style={rm.modal}>
        {/* Header */}
        <div style={rm.header}>
          <div style={rm.headerLeft}>
            <div style={rm.signChip}>
              <span style={rm.signChipIcon}>✋</span>
              <span style={rm.signChipText}>{signLabel}</span>
            </div>
            {isRecording
              ? <div style={rm.recBadge}><span className="rec-dot" style={rm.recDot} /> REC · {frameCount} frames</div>
              : <div style={rm.playBadge}>Playback loop · {frameCount} frames captured</div>
            }
          </div>
          <div style={rm.headerRight}>
            <span style={rm.durationLabel}>{duration}s</span>
            <button
              className="close-btn"
              style={s.closeBtn}
              onClick={onDiscard}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Viewport */}
        <div style={rm.viewport}>
          <div style={rm.vpLabel}>
            {isRecording ? 'LIVE CAPTURE' : 'PLAYBACK PREVIEW'}
          </div>
          <Scene rigData={displayRigData} />
          {!displayFrame && (
            <div style={rm.vpOverlay}>
              <p style={{ fontSize: 13, color: '#4a5568' }}>Waiting for glove connection…</p>
            </div>
          )}
        </div>

        {/* Bottom controls — changes depending on state */}
        {isRecording ? (
          <div style={rm.controls}>
            <div style={rm.controlHint}>Perform the sign now — recording in progress</div>
            <button className="stop-modal-btn" style={rm.stopBtn} onClick={onStop}>
              Stop Recording
            </button>
          </div>
        ) : (
          <div style={rm.trimSection}>
            {/* Trim sliders */}
            <div style={rm.trimHeader}>
              <h3 style={rm.trimTitle}>Trim Sign</h3>
              <span style={rm.trimMeta}>{trimmedCount} frames selected</span>
            </div>

            <div style={rm.sliders}>
              <div style={rm.sliderGroup}>
                <div style={rm.sliderRow}>
                  <label style={rm.sliderLabel}>Start</label>
                  <span style={rm.sliderVal}>{trimStart}%</span>
                </div>
                <input type="range" min="0" max="100" value={trimStart} style={{ width: '100%' }}
                  onChange={e => setTrimRange([parseInt(e.target.value), trimEnd])} />
              </div>
              <div style={rm.sliderGroup}>
                <div style={rm.sliderRow}>
                  <label style={rm.sliderLabel}>End</label>
                  <span style={rm.sliderVal}>{trimEnd}%</span>
                </div>
                <input type="range" min="0" max="100" value={trimEnd} style={{ width: '100%' }}
                  onChange={e => setTrimRange([trimStart, parseInt(e.target.value)])} />
              </div>

              {/* Visual trim bar */}
              <div style={rm.trimBar}>
                <div style={{ ...rm.trimFill, left: `${trimStart}%`, width: `${trimEnd - trimStart}%` }} />
              </div>
            </div>

            <div style={rm.actionRow}>
              <button className="discard-btn" style={rm.discardBtn} onClick={onDiscard}>
                ✕ Discard
              </button>
              <button className="save-sign-btn" style={rm.saveSignBtn} onClick={onSave}>
                ✓ Save Sign
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function LegacyGloveCapture() {
  const router = useRouter();

  const ESP_IP = "192.168.1.8";

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordedFrames, setRecordedFrames] = useState([]);
  const isRecordingRef = useRef(false); // mirrors state for use inside WS closure

  // WebSocket & live frame
  const handleFrame = useCallback((frame) => {
    if (frame?.source === 'raw') {
      setRawVoltages(frame.voltages);
      if (rawWaiterRef.current) {
        const waiter = rawWaiterRef.current;
        rawWaiterRef.current = null;
        clearTimeout(waiter.timer);
        waiter.resolve(frame.voltages);
      }
      return;
    }

    if (!isRecordingRef.current) return;
    if (frame?.source !== 'finger') return;
    if (!frame?.fingers) return;
    setRecordedFrames(prev => [...prev, frame]);
  }, []);

  const gloveFrame = useGloveWebSocket(ESP_IP, handleFrame);

  const currentFrame = useMemo(() => {
    if (!gloveFrame?.imuQuat && !gloveFrame?.fingerAnglesFlat) return null;
    return {
      fingers: gloveFrame.fingerAnglesFlat,
      fingerAngles: gloveFrame.fingerAngles,
      thumbExtra: gloveFrame.thumbExtra,
      imuQuat: gloveFrame.imuQuat,
      flex: {},
      pads: [],
    };
  }, [gloveFrame]);

  const rigFrame = useMemo(() => buildRigData(currentFrame), [currentFrame]);

  const [user, setUser] = useState(null);
  const [userId, setUserId] = useState(null);
  const [userEmail, setUserEmail] = useState(null);
  const [loading, setLoading] = useState(false);
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001/api';
  // Calibration ref – set to true to trigger reset inside HandModel
  const calibrateRef = useRef(false);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [signLabel, setSignLabel] = useState('');
  const [signInput, setSignInput] = useState('');
  const [trimRange, setTrimRange] = useState([0, 100]);

  const [restRotationR, setRestRotationR] = useState([-3.15, 2.29, 3.15]);
  const [restRotationL, setRestRotationL] = useState([-3.15, -2.29, 3.15]);
  const [tunerOpen, setTunerOpen] = useState(true);

  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [calError, setCalError] = useState(null);
  const [rawVoltages, setRawVoltages] = useState(() => Array(16).fill(null));
  const [sampleCount, setSampleCount] = useState(DEFAULT_SAMPLE_COUNT);
  const [sampleDelayMs, setSampleDelayMs] = useState(DEFAULT_SAMPLE_DELAY_MS);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureProgress, setCaptureProgress] = useState(0);
  const [calFinger, setCalFinger] = useState(0);
  const [calAxis, setCalAxis] = useState(0);
  const [knotsByAxis, setKnotsByAxis] = useState(() => (
    Array.from({ length: 5 }, () => Array.from({ length: 4 }, () => Array(5).fill(null)))
  ));
  const [couplingInput, setCouplingInput] = useState('0,0,0,0');

  const rawWaiterRef = useRef(null);

  // Helper to update a single axis
  const setR = (axis, val) => setRestRotationR(prev => { const n = [...prev]; n[axis] = val; return n; });
  const setL = (axis, val) => setRestRotationL(prev => { const n = [...prev]; n[axis] = val; return n; });

  // Saved signs (one submission = many signs)
  const [signs, setSigns] = useState([]); // [{label, frames, trimStart, trimEnd}]
  const [downloadStatus, setDownloadStatus] = useState(null);

  // Nav dropdown
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  // Stats
  const frameCount = recordedFrames.length;
  const duration = (frameCount / 60).toFixed(1);

  const axisKnots = knotsByAxis[calFinger][calAxis];
  const nextStepIdx = axisKnots.findIndex((val) => !Number.isFinite(val));
  const axisComplete = axisKnots.every((val) => Number.isFinite(val));
  const axisAvailable = CAL_FINGER_DEFAULTS[calFinger][calAxis] !== -1;
  const isConnected = !!gloveFrame?.connected;

  const waitForRawVoltages = useCallback((timeoutMs = 2000) => new Promise((resolve, reject) => {
    if (rawWaiterRef.current) {
      clearTimeout(rawWaiterRef.current.timer);
      rawWaiterRef.current.reject(new Error('Superseded raw request'));
    }

    const timer = setTimeout(() => {
      rawWaiterRef.current = null;
      reject(new Error('Raw voltages timeout'));
    }, timeoutMs);

    rawWaiterRef.current = { resolve, reject, timer };
  }), []);

  const sendCommandWsRef = useRef(gloveFrame?.sendCommand);
  useEffect(() => { sendCommandWsRef.current = gloveFrame?.sendCommand; }, [gloveFrame?.sendCommand]);

  const sendCommandUnified = useCallback(async (cmdId, payload) => {
    if (sendCommandWsRef.current) sendCommandWsRef.current(cmdId, payload);
  }, []);

  const runCommand = useCallback(async (cmdId, payload) => {
    try {
      setCalError(null);
      await sendCommandUnified(cmdId, payload);
    } catch (err) {
      setCalError(err?.message || 'Command failed');
    }
  }, [sendCommandUnified]);

  const requestRawVoltages = useCallback(async () => {
    await sendCommandUnified(CMD.REQUEST_RAW);
    return waitForRawVoltages();
  }, [sendCommandUnified, waitForRawVoltages]);

  const getAveragedVoltage = useCallback(async (sensorIdx, samples, delayMs) => {
    let total = 0;
    let count = 0;

    for (let i = 0; i < samples; i += 1) {
      setCaptureProgress(Math.round(((i + 1) / samples) * 100));
      try {
        const values = await requestRawVoltages();
        const val = values?.[sensorIdx];
        if (Number.isFinite(val)) {
          total += val;
          count += 1;
        }
      } catch (err) {
        // Ignore timeouts and keep sampling
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }

    if (count === 0) {
      throw new Error('No raw voltage samples captured');
    }

    return total / count;
  }, [requestRawVoltages]);

  const captureStep = useCallback(async () => {
    if (captureBusy || !axisAvailable) return;

    const stepIdx = axisKnots.findIndex((val) => !Number.isFinite(val));
    if (stepIdx === -1) return;

    const sensorIdx = CAL_FINGER_DEFAULTS[calFinger][calAxis];
    if (sensorIdx === -1) {
      setCalError('Selected axis is not available for this finger.');
      return;
    }

    setCaptureBusy(true);
    setCaptureProgress(0);
    setCalError(null);

    try {
      const samples = Math.max(1, parseInt(sampleCount, 10) || DEFAULT_SAMPLE_COUNT);
      const delayMs = Math.max(0, parseInt(sampleDelayMs, 10) || DEFAULT_SAMPLE_DELAY_MS);
      const avg = await getAveragedVoltage(sensorIdx, samples, delayMs);

      setKnotsByAxis(prev => {
        const next = prev.map(fingerAxes => fingerAxes.map(axis => [...axis]));
        next[calFinger][calAxis][stepIdx] = avg;
        return next;
      });
    } catch (err) {
      setCalError(err?.message || 'Capture failed');
    } finally {
      setCaptureBusy(false);
      setCaptureProgress(0);
    }
  }, [captureBusy, axisAvailable, axisKnots, calFinger, calAxis, sampleCount, sampleDelayMs, getAveragedVoltage]);

  const resetAxis = useCallback(() => {
    setKnotsByAxis(prev => {
      const next = prev.map(fingerAxes => fingerAxes.map(axis => [...axis]));
      next[calFinger][calAxis] = Array(5).fill(null);
      return next;
    });
  }, [calFinger, calAxis]);

  const sendKnots = useCallback(async () => {
    if (!axisComplete) return;
    try {
      setCalError(null);
      const payload = buildKnotsPayload(calFinger, calAxis, axisKnots);
      await sendCommandUnified(CMD.SET_KNOTS, payload);
    } catch (err) {
      setCalError(err?.message || 'Failed to send knots');
    }
  }, [axisComplete, calFinger, calAxis, axisKnots, sendCommandUnified]);

  const sendCoupling = useCallback(async () => {
    const parts = couplingInput.split(',').map(val => parseFloat(val.trim())).filter(val => Number.isFinite(val));
    if (parts.length < 4) {
      setCalError('Provide 4 comma-separated coupling values.');
      return;
    }
    try {
      setCalError(null);
      const payload = buildCouplingPayload(calFinger, parts.slice(0, 4));
      await sendCommandUnified(CMD.SET_COUPLING, payload);
    } catch (err) {
      setCalError(err?.message || 'Failed to send coupling');
    }
  }, [calFinger, couplingInput, sendCommandUnified]);

  // ── Dropdown outside click ─────────────────────────────────────────────────
  useEffect(() => {
    function handler(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target))
        setDropdownOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    async function init() {
      setLoading(true);

      // Get user
      const { data: { user } } = await supabase.auth.getUser();
      setUserEmail(user.email);
      setUserId(user.id);
      //console.log("Authenticated user:", user);
      const userRes = await fetch(`${backendUrl}/profile/info?userId=${user.id}`);
      const userData = await userRes.json();
      setUser(userData[0]);
      //console.log("Profile info:", userData);

      setLoading(false);
    }

    init();
  }, [backendUrl]);

  useEffect(() => {
    if (CAL_FINGER_DEFAULTS[calFinger][calAxis] === -1) {
      setCalAxis(0);
    }
  }, [calFinger, calAxis]);

  // ── Recording flow ─────────────────────────────────────────────────────────
  const handleStartRecording = () => {
    if (!signInput.trim()) return;
    setSignLabel(signInput.trim());
    setRecordedFrames([]);
    setTrimRange([0, 100]);
    setIsRecording(true);
    isRecordingRef.current = true;
    setModalOpen(true);
  };

  const handleStopRecording = () => {
    setIsRecording(false);
    isRecordingRef.current = false;
    // Modal stays open for trim/review
  };

  const handleDiscardSign = () => {
    setModalOpen(false);
    setIsRecording(false);
    isRecordingRef.current = false;
    setRecordedFrames([]);
    setSignInput('');
  };

  const handleSaveSign = () => {
    const startIdx = Math.floor((trimRange[0] / 100) * recordedFrames.length);
    const endIdx = Math.floor((trimRange[1] / 100) * recordedFrames.length);
    const trimmedFrames = recordedFrames.slice(startIdx, endIdx);

    setSigns(prev => [...prev, {
      label: signLabel,
      frames: trimmedFrames,
      trimStart: trimRange[0],
      trimEnd: trimRange[1],
    }]);

    setModalOpen(false);
    setIsRecording(false);
    isRecordingRef.current = false;
    setRecordedFrames([]);
    setSignInput('');
  };
  const handleDownload = () => {
    if (signs.length === 0) return;

    try {
      // 1. Convert the signs object/array to a JSON string
      // The arguments (null, 2) add pretty-printing (indentation)
      const jsonString = JSON.stringify(signs, null, 2);

      // 2. Create a Blob with the JSON data
      const blob = new Blob([jsonString], { type: 'application/json' });

      // 3. Create an object URL for the Blob
      const url = URL.createObjectURL(blob);

      // 4. Create a temporary anchor element
      const link = document.createElement('a');
      link.href = url;
      link.download = 'signs-data.json'; // The filename for the user

      // 5. Append to body, click it, and remove it
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // 6. Clean up the URL object to free up memory
      URL.revokeObjectURL(url);

      // Update your existing UI states
      //console.log("download submission:", signs);
      setDownloadStatus('success');
      setTimeout(() => setDownloadStatus(null), 3000);
      setSigns([]);

    } catch (error) {
      console.error("Download failed:", error);
      setDownloadStatus('error');
    }
  };

  const handleRemoveSign = (idx) => {
    setSigns(prev => prev.filter((_, i) => i !== idx));
  };
  if (loading) return (<div style={s.page}>
    <style>{`        
                          .loader-overlay {
                            position: fixed;
                            top: 0;
                            left: 0;
                            width: 100vw;
                            height: 100vh;
                            display: flex;
                            justify-content: center;
                            align-items: center;
                            background: linear-gradient(135deg, #1a1a2e, #0f3460); /* Color1 */
                            z-index: 9999; /* Ensures it stays on top */
                          }

                          .main-spinner {
                            width: 50px;
                            height: 50px;
                            border: 5px solid rgba(226, 185, 111, 0.2); /* Faded Color2 */
                            border-radius: 50%;
                            border-top-color: #e2b96f; /* Solid Color2 */
                            animation: spin 1s linear infinite;
                          }

                          @keyframes spin { 
                            to { transform: rotate(360deg); } 
                          }
                        `}
    </style>
    <div className="loader-overlay">
      <div className="main-spinner"></div>
    </div>
  </div>);

  return (
    <div style={s.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600&family=DM+Sans:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'DM Sans', sans-serif; }
        @keyframes fadeIn  { from { opacity:0 } to { opacity:1 } }
        @keyframes fadeUp  { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:translateY(0) } }
        @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes slideDown { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes slideUp   { from{opacity:0;transform:translateY(20px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
        .rec-dot { animation: pulse 1.2s ease-in-out infinite; }
        .start-btn:hover     { background:#b91c1c !important; transform:translateY(-1px); }
        .calib-btn:hover     { background:rgba(226,185,111,0.15) !important; transform:translateY(-1px); }
        .upload-btn:hover    { background:#0f3460 !important; transform:translateY(-1px); }
        .stop-modal-btn:hover{ background:#991b1b !important; transform:translateY(-1px); }
        .save-sign-btn:hover { background:#047857 !important; transform:translateY(-1px); }
        .discard-btn:hover   { background:rgba(239,68,68,0.15) !important; color:#ef4444 !important; }
        .logout-item:hover   { background:rgba(220,38,38,0.08) !important; color:#ef4444 !important; }
        .dd-item:hover       { background:rgba(255,255,255,0.05) !important; }
        .sign-tag:hover .remove-sign { opacity:1 !important; }
        input[type=range] { -webkit-appearance:none; appearance:none; height:4px; border-radius:4px; background:#2d3748; outline:none; cursor:pointer; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; appearance:none; width:18px; height:18px; border-radius:50%; background:#e2b96f; border:2px solid #1a1a2e; cursor:pointer; transition:transform 0.15s; }
        input[type=range]::-webkit-slider-thumb:hover { transform:scale(1.2); }
        input[type=range]::-moz-range-thumb { width:18px; height:18px; border-radius:50%; background:#e2b96f; border:2px solid #1a1a2e; cursor:pointer; }
      `}</style>

      {/* ── NAV ── */}
      <nav style={s.nav}>
        <div style={s.navBrand}>
          <Image src={logo} alt="Logo" width={44} height={44} style={{ borderRadius: 8 }} />
          <span style={s.navName}>صوتك</span>
          <span style={s.navDivider}>|</span>
          <span style={s.navSub}>Glove Studio</span>
        </div>
        <div style={s.navRight} ref={dropdownRef}>
          <button style={s.userPill} onClick={() => setDropdownOpen(o => !o)}>
            <div style={s.avatar}>{user?.initials}</div>
            <span style={s.userName}>{user?.username}</span>
            <span style={s.chevron}>{dropdownOpen ? '▲' : '▼'}</span>
          </button>
          {dropdownOpen && (
            <div style={s.dropdown}>
              <div style={s.ddHeader}>
                <div style={{ ...s.avatar, width: 36, height: 36, fontSize: 13 }}>{user?.initials}</div>
                <div>
                  <div style={s.ddName}>{user?.username}</div>
                  <div style={s.ddEmail}>{userEmail}</div>
                </div>
              </div>
              <div style={s.ddDivider} />
              <button onClick={() => router.push("/")} className="dd-item" style={s.ddItem}>Home</button>
              <button onClick={() => router.push("/recording")} className="dd-item" style={s.ddItem}>Recording</button>
              <button onClick={() => router.push("/legacy")} className="dd-item" style={s.ddItem}>Legacy System</button>
              <button onClick={() => router.push("/models")} className="dd-item" style={s.ddItem}>Models</button>
              <div style={s.ddDivider} />
              <button onClick={() => router.push("/login")} className="logout-item" style={{ ...s.ddItem, color: '#ef4444' }}>Sign out →</button>
            </div>
          )}
        </div>
      </nav>

      {/* ── BODY ── */}
      <div style={s.body}>

        {/* ── LEFT COL ── */}
        <div style={s.leftCol}>
          <div style={s.titleRow}>
            <div>
              <h1 style={s.title}>Legacy Data Studio</h1>
              <p style={s.subtitle}>Capture hand gesture sequences for your submission</p>
            </div>
          </div>

          {/* Live 3-D preview */}
          <div style={s.viewport}>
            <div style={s.viewportLabel}>LIVE PREVIEW</div>
            <Scene rigData={rigFrame} />
            {!currentFrame && (
              <div style={s.viewportOverlay}>
                <p style={s.viewportHint}>Waiting for glove connection…</p>
              </div>
            )}
          </div>

          {/* Calibrate button */}
          <div style={s.controlRow}>
            <button
              className="calib-btn"
              style={s.calibBtn}
              onClick={() => setCalibrationOpen(o => !o)}
            >
              Calibrate
            </button>
            <button
              className="calib-btn"
              style={{ ...s.calibBtn, background: 'rgba(239,68,68,0.08)', color: '#ef4444', borderColor: 'rgba(239,68,68,0.25)' }}
              onClick={() => gloveFrame?.reconnect?.()}
              title="Force reconnect to the glove"
            >
              Reconnect
            </button>
            {currentFrame && (
              <div style={s.connectedBadge}>
                <span style={s.connDot} /> Connected
              </div>
            )}
          </div>
        </div>

        {/* ── RIGHT COL ── */}
        <div style={s.rightCol}>

          {/* Sign recorder panel */}
          <div style={s.panel}>
            <div style={s.panelHeader}>
              <h3 style={s.panelTitle}>Record a Sign</h3>
              <p style={s.panelSub}>Type the label, then start recording</p>
            </div>

            <div style={s.fieldGroup}>
              <label style={s.label}>Sign label</label>
              <input
                type="text"
                placeholder='e.g. "hello"'
                value={signInput}
                onChange={e => setSignInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleStartRecording()}
                style={s.input}
                onFocus={e => Object.assign(e.target.style, s.inputFocus)}
                onBlur={e => Object.assign(e.target.style, { borderColor: 'rgba(255,255,255,0.10)', boxShadow: 'none' })}
              />
            </div>

            <button
              className="start-btn"
              style={{ ...s.startBtn, opacity: signInput.trim() ? 1 : 0.45 }}
              onClick={handleStartRecording}
              disabled={!signInput.trim()}
            >
              <span style={{ fontSize: 10 }}>●</span> Start Recording
            </button>
          </div>

          {calibrationOpen && (
            <div style={s.panel}>
              <div style={s.panelHeader}>
                <h3 style={s.panelTitle}>Calibration Wizard</h3>
                <p style={s.panelSub}>WiFi mode</p>
              </div>

              {calError && <div style={s.calError}>{calError}</div>}

              <div style={s.calRow}>
                <button
                  style={s.calBtnSecondary}
                  onClick={() => runCommand(CMD.TARE_IMU)}
                  disabled={!isConnected}
                >
                  Tare IMU
                </button>
                <button
                  style={s.calBtnSecondary}
                  onClick={() => runCommand(CMD.START_BOOT_CAL)}
                  disabled={!isConnected}
                >
                  Boot Cal
                </button>
                <button
                  style={s.calBtnSecondary}
                  onClick={() => runCommand(CMD.START_MAG_CAL)}
                  disabled={!isConnected}
                >
                  Mag Cal
                </button>
                <button
                  style={s.calBtnSecondary}
                  onClick={() => runCommand(CMD.END_MAG_CAL)}
                  disabled={!isConnected}
                >
                  End Mag
                </button>
              </div>

              <div style={s.calRow}>
                <label style={s.calLabel}>Finger</label>
                <select
                  style={s.calSelect}
                  value={calFinger}
                  onChange={(e) => setCalFinger(parseInt(e.target.value, 10))}
                >
                  {CAL_FINGER_NAMES.map((name, idx) => (
                    <option key={name} value={idx}>{name}</option>
                  ))}
                </select>
                <label style={s.calLabel}>Axis</label>
                <select
                  style={s.calSelect}
                  value={calAxis}
                  onChange={(e) => setCalAxis(parseInt(e.target.value, 10))}
                >
                  {CAL_AXIS_NAMES.map((name, idx) => (
                    <option key={name} value={idx} disabled={CAL_FINGER_DEFAULTS[calFinger][idx] === -1}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>

              <div style={s.calSteps}>
                {CALIBRATION_STEPS.map((step, idx) => {
                  const value = axisKnots[idx];
                  const done = Number.isFinite(value);
                  const active = idx === nextStepIdx;
                  return (
                    <div
                      key={step.pct}
                      style={{
                        ...s.calStep,
                        ...(done ? s.calStepDone : null),
                        ...(active ? s.calStepActive : null),
                      }}
                    >
                      <span>{step.label}</span>
                      <span>{done ? value.toFixed(3) : '---'}</span>
                    </div>
                  );
                })}
              </div>

              <div style={s.calRow}>
                <button
                  style={s.calBtn}
                  onClick={captureStep}
                  disabled={!isConnected || captureBusy || !axisAvailable || nextStepIdx === -1}
                >
                  {captureBusy ? `Capturing ${captureProgress}%` : 'Capture Step'}
                </button>
                <button
                  style={s.calBtnSecondary}
                  onClick={resetAxis}
                  disabled={captureBusy}
                >
                  Reset Axis
                </button>
              </div>

              <div style={s.calRow}>
                <button
                  style={s.calBtn}
                  onClick={sendKnots}
                  disabled={!isConnected || captureBusy || !axisComplete}
                >
                  Send Knots
                </button>
                <button
                  style={s.calBtnSecondary}
                  onClick={() => runCommand(CMD.SAVE_CAL)}
                  disabled={!isConnected}
                >
                  Save Cal
                </button>
                <button
                  style={s.calBtnSecondary}
                  onClick={() => runCommand(CMD.LOAD_CAL)}
                  disabled={!isConnected}
                >
                  Load Cal
                </button>
              </div>

              <div style={s.calRow}>
                <label style={s.calLabel}>Samples</label>
                <input
                  type="number"
                  min="1"
                  style={s.calInput}
                  value={sampleCount}
                  onChange={(e) => setSampleCount(e.target.value)}
                />
                <label style={s.calLabel}>Delay (ms)</label>
                <input
                  type="number"
                  min="0"
                  style={s.calInput}
                  value={sampleDelayMs}
                  onChange={(e) => setSampleDelayMs(e.target.value)}
                />
              </div>

              <div style={s.calRow}>
                <label style={s.calLabel}>Coupling</label>
                <input
                  type="text"
                  style={s.calInputWide}
                  value={couplingInput}
                  onChange={(e) => setCouplingInput(e.target.value)}
                  placeholder="c0,c1,c2,c3"
                />
                <button
                  style={s.calBtnSecondary}
                  onClick={sendCoupling}
                  disabled={!isConnected}
                >
                  Send
                </button>
              </div>

              <div style={s.calRawGrid}>
                {rawVoltages.map((val, idx) => (
                  <div key={`raw-${idx}`} style={s.calRawCell}>
                    <span>#{idx}</span>
                    <span>{Number.isFinite(val) ? val.toFixed(3) : '---'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Signs collected */}
          <div style={s.panel}>
            <div style={s.panelHeader}>
              <h3 style={s.panelTitle}>Recorded Signs</h3>
              <p style={s.panelSub}>{signs.length} sign{signs.length !== 1 ? 's' : ''} in this submission</p>
            </div>

            {signs.length === 0 ? (
              <div style={s.emptySignsBox}>
                <span style={s.emptySignsIcon}>✋</span>
                <p style={s.emptySignsText}>No signs yet — record your first one</p>
              </div>
            ) : (
              <div style={s.signsList}>
                {signs.map((sign, idx) => (
                  <div key={idx} className="sign-tag" style={s.signTag}>
                    <div style={s.signTagLeft}>
                      <span style={s.signTagIndex}>{idx + 1}</span>
                      <div>
                        <div style={s.signTagLabel}>{sign.label}</div>
                        <div style={s.signTagMeta}>
                          {sign.frames.length} frames · {(sign.frames.length / 60).toFixed(1)}s
                        </div>
                      </div>
                    </div>
                    <button
                      className="remove-sign"
                      style={s.removeSign}
                      onClick={() => handleRemoveSign(idx)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Download submission */}
          <div style={s.panel}>
            <div style={s.panelHeader}>
              <h3 style={s.panelTitle}>Download Submission</h3>
              <p style={s.panelSub}>Download all recorded signs as a JSON file</p>
            </div>

            <button
              className="upload-btn"
              style={{ ...s.uploadBtn, opacity: signs.length > 0 ? 1 : 0.4 }}
              onClick={handleDownload}
              disabled={signs.length === 0}
            >
              {downloadStatus === 'success' ? '✓ Downloaded!' : `Download ${signs.length} Sign${signs.length !== 1 ? 's' : ''} →`}
            </button>

            {downloadStatus === 'success' && (
              <div style={s.successBanner}>
                Submission downloaded successfully.
              </div>
            )}
            {signs.length === 0 && (
              <p style={s.disabledNote}>Add at least one sign before downloading.</p>
            )}
          </div>

          {/* Live sensor readings panel */}
          <SensorReadingsPanel frame={currentFrame} />
        </div>
      </div>

      {/* ── RECORDING MODAL ── */}
      {modalOpen && (
        <RecordingModal
          signLabel={signLabel}
          isRecording={isRecording}
          frames={recordedFrames}
          trimRange={trimRange}
          setTrimRange={setTrimRange}
          onStop={handleStopRecording}
          onDiscard={handleDiscardSign}
          onSave={handleSaveSign}
          currentFrame={currentFrame}
          calibrate={calibrateRef}
        />
      )}
    </div>
  );
}

// ─── Page styles ─────────────────────────────────────────────────────────────
const s = {
  page: { minHeight: '100vh', background: '#0d0f1a', fontFamily: "'DM Sans', sans-serif", color: '#e2e8f0', display: 'flex', flexDirection: 'column' },

  nav: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 28px', height: 60, background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.07)', backdropFilter: 'blur(12px)', position: 'sticky', top: 0, zIndex: 20 },
  navBrand: { display: 'flex', alignItems: 'center', gap: 10 },
  navName: { fontFamily: "'Playfair Display', serif", fontSize: 18, fontWeight: 600, color: '#ffffff', letterSpacing: '0.5px' },
  navDivider: { color: 'rgba(255,255,255,0.15)', fontSize: 16 },
  navSub: { fontSize: 13, color: '#a0aec0', fontWeight: 300 },
  navRight: { position: 'relative' },
  userPill: { display: 'flex', alignItems: 'center', gap: 9, padding: '5px 12px 5px 5px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 100, cursor: 'pointer' },
  avatar: { width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(135deg, #0f3460, #e2b96f)', color: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', flexShrink: 0 },
  userName: { fontSize: 13, fontWeight: 500, color: '#e2e8f0' },
  chevron: { fontSize: 10, color: '#a0aec0' },
  dropdown: { position: 'absolute', top: 'calc(100% + 8px)', right: 0, background: '#1a1f35', borderRadius: 16, boxShadow: '0 16px 48px rgba(0,0,0,0.5)', border: '1px solid rgba(255,255,255,0.08)', minWidth: 200, overflow: 'hidden', animation: 'slideDown 0.15s ease', zIndex: 100 },
  ddHeader: { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: 'rgba(255,255,255,0.03)' },
  ddName: { fontSize: 13, fontWeight: 500, color: '#e2e8f0' },
  ddEmail: { fontSize: 11, color: '#718096' },
  ddDivider: { height: 1, background: 'rgba(255,255,255,0.06)' },
  ddItem: { display: 'block', width: '100%', padding: '10px 16px', background: 'transparent', border: 'none', textAlign: 'left', fontSize: 13, color: '#a0aec0', cursor: 'pointer', transition: 'background 0.15s', fontFamily: "'DM Sans', sans-serif" },

  body: { flex: 1, display: 'flex', gap: 24, padding: 28, maxWidth: 1400, margin: '0 auto', width: '100%' },
  leftCol: { flex: 1, display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 },
  rightCol: { width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 16 },

  titleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  title: { fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 600, color: '#ffffff', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#718096', fontWeight: 300 },

  viewport: { flex: 1, minHeight: 400, background: 'linear-gradient(145deg, #0a0c18, #111827)', borderRadius: 20, border: '1px solid rgba(255,255,255,0.06)', boxShadow: 'inset 0 0 60px rgba(0,0,0,0.4)' },
  viewportLabel: { position: 'absolute', top: 14, left: 18, zIndex: 2, fontSize: 11, fontWeight: 500, color: '#4a5568', letterSpacing: '1px', textTransform: 'uppercase' },
  viewportOverlay: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
  viewportIcon: { fontSize: 40, marginBottom: 12, opacity: 0.3 },
  viewportHint: { fontSize: 13, color: '#4a5568' },

  controlRow: { display: 'flex', gap: 12, alignItems: 'center' },
  calibBtn: { display: 'flex', alignItems: 'center', gap: 8, padding: '11px 20px', background: 'rgba(226,185,111,0.08)', color: '#e2b96f', border: '1px solid rgba(226,185,111,0.25)', borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background 0.2s, transform 0.15s', fontFamily: "'DM Sans', sans-serif" },
  connectedBadge: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#34d399' },
  connDot: { width: 8, height: 8, borderRadius: '50%', background: '#34d399', display: 'inline-block' },

  panel: { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 18, padding: 20 },
  panelHeader: { marginBottom: 16 },
  panelTitle: { fontSize: 14, fontWeight: 500, color: '#e2e8f0', marginBottom: 3 },
  panelSub: { fontSize: 12, color: '#718096', fontWeight: 300 },

  calRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  calBtn: { padding: '8px 12px', background: '#1a1a2e', color: '#e2b96f', border: '1px solid rgba(226,185,111,0.25)', borderRadius: 10, fontSize: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  calBtnSecondary: { padding: '8px 10px', background: 'rgba(255,255,255,0.04)', color: '#a0aec0', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 10, fontSize: 12, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" },
  calLabel: { fontSize: 11, color: '#a0aec0' },
  calSelect: { padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: '#e2e8f0', fontSize: 11 },
  calInput: { width: 70, padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: '#e2e8f0', fontSize: 11 },
  calInputWide: { flex: 1, minWidth: 140, padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: '#e2e8f0', fontSize: 11 },
  calStatus: { fontSize: 11, color: '#60a5fa' },
  calHint: { fontSize: 11, color: '#718096', marginBottom: 8 },
  calError: { fontSize: 11, color: '#ef4444', marginBottom: 8 },
  calSteps: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 },
  calStep: { display: 'flex', justifyContent: 'space-between', padding: '6px 8px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', fontSize: 11, color: '#a0aec0' },
  calStepActive: { border: '1px solid rgba(226,185,111,0.35)', color: '#e2b96f' },
  calStepDone: { border: '1px solid rgba(52,211,153,0.35)', color: '#34d399' },
  calRawGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6, marginTop: 8 },
  calRawCell: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)', fontSize: 10, color: '#a0aec0' },

  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 },
  label: { fontSize: 12, color: '#a0aec0', fontWeight: 500 },
  input: { padding: '11px 14px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.04)', color: '#e2e8f0', fontSize: 14, fontFamily: "'DM Sans', sans-serif", transition: 'border-color 0.2s, box-shadow 0.2s' },
  inputFocus: { borderColor: 'rgba(226,185,111,0.5)', boxShadow: '0 0 0 3px rgba(226,185,111,0.08)' },
  startBtn: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background 0.2s, transform 0.15s', fontFamily: "'DM Sans', sans-serif" },

  emptySignsBox: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 12px', background: 'rgba(255,255,255,0.02)', borderRadius: 12, border: '1px dashed rgba(255,255,255,0.08)' },
  emptySignsIcon: { fontSize: 28, opacity: 0.3, marginBottom: 8 },
  emptySignsText: { fontSize: 12, color: '#4a5568', textAlign: 'center' },

  signsList: { display: 'flex', flexDirection: 'column', gap: 8 },
  signTag: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.07)', transition: 'border-color 0.2s' },
  signTagLeft: { display: 'flex', alignItems: 'center', gap: 10 },
  signTagIndex: { width: 22, height: 22, borderRadius: '50%', background: 'rgba(226,185,111,0.15)', color: '#e2b96f', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 },
  signTagLabel: { fontSize: 13.5, fontWeight: 500, color: '#e2e8f0' },
  signTagMeta: { fontSize: 11, color: '#718096', marginTop: 1 },
  removeSign: { padding: '4px 8px', background: 'transparent', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 12, opacity: 0, transition: 'opacity 0.2s', borderRadius: 6 },

  uploadBtn: { width: '100%', padding: 13, background: '#1a1a2e', color: '#e2b96f', border: '1px solid rgba(226,185,111,0.25)', borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background 0.2s, transform 0.15s', fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.3px' },
  successBanner: { marginTop: 12, padding: '10px 14px', background: 'rgba(5,150,105,0.12)', border: '1px solid rgba(5,150,105,0.25)', borderRadius: 10, fontSize: 12.5, color: '#34d399' },
  disabledNote: { marginTop: 10, fontSize: 11.5, color: '#4a5568' },
  closeBtn: {
    width: 34, height: 34, borderRadius: '50%',
    border: 'none', background: 'transparent',
    cursor: 'pointer', fontSize: '13px', color: '#7a8499',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background 0.2s', flexShrink: 0,
  },
  sensorGrid: { display: 'flex', flexDirection: 'column', gap: 6 },
  sensorRow: { display: 'flex', alignItems: 'center', gap: 10 },
  sensorKey: { fontSize: 11.5, color: '#718096', width: 50 },
  sensorBarBg: { flex: 1, height: 4, background: '#1a1f35', borderRadius: 4, overflow: 'hidden' },
  sensorBarFill: { height: '100%', background: 'linear-gradient(90deg, #0f3460, #e2b96f)', borderRadius: 4, transition: 'width 0.2s' },
  sensorVal: { fontSize: 11, color: '#e2b96f', width: 34, textAlign: 'right' },
};

// ─── Modal styles ─────────────────────────────────────────────────────────────
const rm = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(5,7,18,0.85)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, animation: 'fadeIn 0.2s ease', padding: 24 },
  modal: { background: '#0d1020', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 24, width: '100%', maxWidth: 900, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 32px 80px rgba(0,0,0,0.7)', animation: 'slideUp 0.3s ease' },

  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 24px', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 14 },
  headerRight: { display: 'flex' },
  signChip: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', background: 'rgba(226,185,111,0.10)', border: '1px solid rgba(226,185,111,0.25)', borderRadius: 100 },
  signChipIcon: { fontSize: 16 },
  signChipText: { fontSize: 14, fontWeight: 600, color: '#e2b96f' },
  recBadge: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderRadius: 100, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', color: '#ef4444', fontSize: 12, fontWeight: 500 },
  recDot: { width: 8, height: 8, borderRadius: '50%', background: '#ef4444', display: 'inline-block' },
  playBadge: { fontSize: 12, color: '#34d399', padding: '5px 12px', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.20)', borderRadius: 100 },
  durationLabel: { fontSize: 13, color: '#718096', display: 'flex', alignItems: 'center', marginRight: '10px' },

  viewport: { position: 'relative', width: '100%', height: '380px', background: 'linear-gradient(145deg, #0a0c18, #111827)', borderRadius: 20, border: '1px solid rgba(255,255,255,0.06)', boxShadow: 'inset 0 0 60px rgba(0,0,0,0.4)', overflow: 'hidden', display: 'flex', flexDirection: 'column' },
  vpLabel: { position: 'absolute', top: 12, left: 16, zIndex: 2, fontSize: 10, color: '#4a5568', letterSpacing: '1.5px', textTransform: 'uppercase' },
  vpOverlay: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },

  controls: { padding: '18px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.02)', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 },
  controlHint: { fontSize: 13, color: '#4a5568' },
  stopBtn: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 28px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background 0.2s, transform 0.15s', fontFamily: "'DM Sans', sans-serif" },

  trimSection: { padding: '18px 24px', background: 'rgba(255,255,255,0.02)', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 },
  trimHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  trimTitle: { fontSize: 14, fontWeight: 500, color: '#e2e8f0' },
  trimMeta: { fontSize: 12, color: '#718096' },
  sliders: { marginBottom: 16 },
  sliderGroup: { marginBottom: 12 },
  sliderRow: { display: 'flex', justifyContent: 'space-between', marginBottom: 6 },
  sliderLabel: { fontSize: 12, color: '#a0aec0' },
  sliderVal: { fontSize: 12, color: '#e2b96f', fontWeight: 500 },
  trimBar: { height: 6, background: '#1a1f35', borderRadius: 6, overflow: 'hidden', marginTop: 4 },
  trimFill: { position: 'absolute', height: '100%', background: 'linear-gradient(90deg, #0f3460, #e2b96f)', borderRadius: 6 },

  actionRow: { display: 'flex', gap: 12, justifyContent: 'flex-end' },
  discardBtn: { padding: '11px 22px', background: 'rgba(239,68,68,0.06)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.20)', borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background 0.15s, color 0.15s', fontFamily: "'DM Sans', sans-serif" },
  saveSignBtn: { padding: '11px 28px', background: '#059669', color: '#fff', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background 0.2s, transform 0.15s', fontFamily: "'DM Sans', sans-serif" },
};
