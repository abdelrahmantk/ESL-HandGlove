"use client";
import React, { useState, useEffect, useRef, useMemo, useCallback,memo } from 'react';
import { Canvas } from '@react-three/fiber';
import { ArmModel, DEFAULT_WRIST_LIMITS, DEFAULT_ARM_LIMITS, BIOMECHANICAL_LIMITS } from "../components/ArmModel";
import Image from "next/image";
import logo from "../assets/logo.png";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";
import * as THREE from 'three';

// ─── Dev/Production toggle ───────────────────────────────────────────────────
// Set to false before deploying to production to hide all developer UI.
const DEV_MODE = true;

// ─── IMU Axis Mapping (Mutable Global) ──────────────────────────────────────
let __imuAxisConfig = {
  right: { order: 'zxy', sX: -1, sY: -1, sZ: 1, sW: 1 },
  left: { order: 'zxy', sX: -1, sY: -1, sZ: 1, sW: 1 }
};

// ─── Sensor readings panel ───────────────────────────────────────────────────

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


const UNIFIED_PACKET_HEADER = 0x45534C47; // "ESLG"

const DEG2RAD = Math.PI / 180;
const CAL_ALL_FINGERS = 0b00011111; // 0x1F — all 5 fingers calibrated

const CMD = {
  TARE_IMU: 0x01,
  START_BOOT_CAL: 0x02,
  START_MAG_CAL: 0x03,
  END_MAG_CAL: 0x04,
  START_STATIC_ALIGN: 0x05,
  RECORD_STATIC_POSE: 0x06,
  ENTER_RUNNING: 0x07,
  SET_MAG_USAGE: 0x08,
  SET_KNOTS: 0x10,
  SET_COUPLING: 0x11,
  SAVE_CAL: 0x12,
  LOAD_CAL: 0x13,
  SET_IMU_CAL: 0x14,
  SWITCH_TO_WIFI: 0x20,
  SWITCH_TO_BLE: 0x21,
  REQUEST_RAW: 0x30,
  REQ_IMU_CAL: 0x31,
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
const COUPLING_LABELS_STANDARD = ['p2→p1', 'yaw→p1', 'yaw→p2', 'p1→p2'];
const COUPLING_LABELS_THUMB = ['p2→p1', 'yaw→p1', 'yaw→p2', 'p1→p2', 'ip→p1', 'yaw→ip'];

const HAND_CHANNEL_MAPS = {
  right: {
    labels: [
      'Middle / Yaw',    // ch0
      'Index / Yaw',    // ch1
      'Index / P1',     // ch2
      'Index / P2',     // ch3
      'Thumb / IP',     // ch4
      'Thumb / P2',     // ch5
      'Thumb / P1',     // ch6
      'Thumb / Yaw',    // ch7
      'Pinky / Yaw',    // ch8
      'Pinky / P1',     // ch9
      'Pinky / P2',     // ch10
      'Ring / Yaw',     // ch11
      'Ring / P1',      // ch12
      'Ring / P2',      // ch13
      'Middle / P2',    // ch14
      'Middle / P1',    // ch15
    ],
    fingerDefaults: [
      [8, 9, 10, -1],   // Pinky:  yaw=ch8,  p1=ch9,  p2=ch10
      [11, 12, 13, -1], // Ring:   yaw=ch11, p1=ch12, p2=ch13
      [0, 15, 14, -1],  // Middle: yaw=ch0,  p1=ch15, p2=ch14
      [1, 2, 3, -1],    // Index:  yaw=ch1,  p1=ch2,  p2=ch3
      [7, 6, 5, 4],     // Thumb:  yaw=ch7,  p1=ch6,  p2=ch5,  ip=ch4
    ],
  },
  left: {
    labels: [
      'Pinky / P1',    // ch0
      'Pinky / Yaw',    // ch1
      'Ring / P2',     // ch2
      'Pinky / P2',     // ch3
      'Ring / P1',     // ch4
      'Ring / Yaw',     // ch5
      'Middle / P2',     // ch6
      'Middle / P1',    // ch7
      'Thumb / Yaw',    // ch8
      'Thumb / P1',     // ch9
      'Thumb / P2',     // ch10
      'Thumb / IP',     // ch11
      'Middle / Yaw',      // ch12
      'Index / Yaw',      // ch13
      'Index / P2',    // ch14
      'Index / P1',    // ch15
    ],
    fingerDefaults: [
      [1, 0, 3, -1],   // Pinky:  yaw=ch8,  p1=ch9,  p2=ch10
      [5, 4, 2, -1], // Ring:   yaw=ch11, p1=ch12, p2=ch13
      [12, 7, 6, -1],  // Middle: yaw=ch0,  p1=ch15, p2=ch14
      [13, 15, 14, -1],    // Index:  yaw=ch1,  p1=ch2,  p2=ch3
      [8, 9, 10, 11],     // Thumb:  yaw=ch7,  p1=ch6,  p2=ch5,  ip=ch4
    ],
  },
};

const getHandChannelMap = (hand) => HAND_CHANNEL_MAPS[hand] || HAND_CHANNEL_MAPS.right;

const DEFAULT_SAMPLE_COUNT = 10;
const DEFAULT_SAMPLE_DELAY_MS = 0;

// ADS1115 GAIN_TWO: SS49E sensor valid range and expected span
const VOLTAGE_MIN_VALID = 0.3;   // below = sensor disconnected
const VOLTAGE_MAX_VALID = 2.1;   // above = out of ADS range
const VOLTAGE_NEUTRAL = 1.5;   // ~0mT, neutral position
const VOLTAGE_FULL_SCALE = 2.5;   // used for bar fill (%)
const SENSOR_MIN_SPAN = 0.2;   // warn if range < 0.2V
const SENSOR_DEAD_THRESH = 0.1;   // flag dead if var < 0.1V over 30s

const EMPTY_FINGER = { yaw: 0, pitch1: 0, pitch2: 0 };
const DEFAULT_FINGER_LIMITS = { pitchMin: 0, pitchMax: 100, yawMin: -20, yawMax: 20 };

const toRad = (deg) => (Number.isFinite(deg) ? deg : 0) * DEG2RAD;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildCommandBuffer(cmdId, payload, isLeft = false) {
  const prefixSize = isLeft ? 1 : 0;
  const payloadSize = payload ? payload.length : 0;
  const buf = new Uint8Array(prefixSize + 1 + payloadSize);
  let offset = 0;
  if (isLeft) {
    buf[offset++] = 0xA0;
  }
  buf[offset++] = cmdId;
  if (payload && payloadSize > 0) {
    buf.set(payload, offset);
  }
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
  const len = coeffs.length;
  const buf = new ArrayBuffer(1 + (len * 4));
  const view = new DataView(buf);
  view.setUint8(0, fingerIdx);
  for (let i = 0; i < len; i += 1) {
    view.setFloat32(1 + (i * 4), coeffs[i] ?? 0, true);
  }
  return new Uint8Array(buf);
}

function quatFromEuler(x, y, z) {
  const q = new THREE.Quaternion();
  q.setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
  return [q.x, q.y, q.z, q.w];
}

function ConvertToThreeSpace(q, hand = 'right') {
  const conf = __imuAxisConfig[hand] || __imuAxisConfig.right;
  let mappedX = q.x, mappedY = q.y, mappedZ = q.z;

  // 1. Map components based on user selection
  if (conf.order === 'xyz') { mappedX = q.x; mappedY = q.y; mappedZ = q.z; }
  else if (conf.order === 'xzy') { mappedX = q.x; mappedY = q.z; mappedZ = q.y; }
  else if (conf.order === 'yxz') { mappedX = q.y; mappedY = q.x; mappedZ = q.z; }
  else if (conf.order === 'yzx') { mappedX = q.y; mappedY = q.z; mappedZ = q.x; }
  else if (conf.order === 'zxy') { mappedX = q.z; mappedY = q.x; mappedZ = q.y; }
  else if (conf.order === 'zyx') { mappedX = q.z; mappedY = q.y; mappedZ = q.x; }

  mappedX *= conf.sX;
  mappedY *= conf.sY;
  mappedZ *= conf.sZ;
  let mappedW = q.w * conf.sW;

  // 2. Parity Check: Ensure the mapping is a valid Right-Handed rotation
  const isSwapped = (conf.order === 'xzy' || conf.order === 'yxz' || conf.order === 'zyx');
  const signFlips = (conf.sX < 0 ? 1 : 0) + (conf.sY < 0 ? 1 : 0) + (conf.sZ < 0 ? 1 : 0);

  // If we swapped axes (Det = -1) or flipped an odd number of signs (Det = -1)
  const det = (isSwapped ? -1 : 1) * (signFlips % 2 !== 0 ? -1 : 1);

  // If Det == -1, the mapping turned the rotation inside-out (left-handed).
  // Invert W to correct the rotation parity back to Right-Handed for Three.js.
  if (det < 0) {
    mappedW = -mappedW;
  }

  return new THREE.Quaternion(mappedX, mappedY, mappedZ, mappedW).normalize();
}

function AxisMappingWidget({ hand }) {
  const [, forceRender] = useState(0);
  const conf = __imuAxisConfig[hand] || __imuAxisConfig.right;

  const toggleSign = (axis) => {
    conf[axis] *= -1;
    forceRender(x => x + 1);
  };

  return (
    <div style={{ background: 'rgba(10,12,28,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#a0aec0', marginBottom: 12, letterSpacing: '0.8px', textTransform: 'uppercase' }}>
        🔀 Axis Swizzle Tester ({hand === 'left' ? 'LEFT' : 'RIGHT'})
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: '#e2e8f0' }}>Order:</span>
        <select
          value={conf.order}
          onChange={(e) => { conf.order = e.target.value; forceRender(x => x + 1); }}
          style={{ background: '#1a202c', color: '#e2e8f0', border: '1px solid #4a5568', padding: '4px 8px', borderRadius: 4, fontSize: 11 }}
        >
          <option value="xyz">XYZ</option>
          <option value="xzy">XZY</option>
          <option value="yxz">YXZ</option>
          <option value="yzx">YZX</option>
          <option value="zxy">ZXY</option>
          <option value="zyx">ZYX</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {['sX', 'sY', 'sZ', 'sW'].map(axis => (
          <button key={axis} onClick={() => toggleSign(axis)} style={{
            flex: 1, padding: '4px 0', background: conf[axis] === 1 ? 'rgba(52,211,153,0.15)' : 'rgba(239,68,68,0.15)',
            border: `1px solid ${conf[axis] === 1 ? 'rgba(52,211,153,0.3)' : 'rgba(239,68,68,0.3)'}`,
            color: conf[axis] === 1 ? '#34d399' : '#ef4444', borderRadius: 4, fontSize: 11, fontWeight: 'bold'
          }}>
            {axis}: {conf[axis] === 1 ? '+' : '-'}
          </button>
        ))}
      </div>
    </div>
  );
}
function AlignmentPanel({ modelAlign, setModelAlign, onCalibrate, onTare }) {
  const cycleAlign = (part, axis) => {
    setModelAlign(prev => {
      const newPart = [...prev[part]];
      let val = parseFloat(newPart[axis]) || 0;
      val = ((val % 360) + 360) % 360;
      val = (val + 90) % 360;
      newPart[axis] = val;
      return { ...prev, [part]: newPart };
    });
  };

  const renderAxisButton = (label, part, axis) => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <span style={{ fontSize: 9, color: '#718096', marginBottom: 2 }}>{label}</span>
      <button
        onClick={() => cycleAlign(part, axis)}
        style={{
          width: 44,
          background: 'rgba(255,255,255,0.1)',
          color: '#e2b96f',
          border: '1px solid #4a5568',
          borderRadius: 4,
          padding: '4px 0',
          fontSize: 11,
          cursor: 'pointer',
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        {parseFloat(modelAlign[part][axis]) || 0}°
      </button>
    </div>
  );

  return (
    <div style={{ background: 'rgba(10,12,28,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', backdropFilter: 'blur(12px)', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#a0aec0', letterSpacing: '0.8px', textTransform: 'uppercase' }}>🔧 Proxy Alignment</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={onTare} style={{ background: '#60a5fa', color: '#000', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 10, fontWeight: 'bold', cursor: 'pointer' }}>Tare (Space)</button>
          <button onClick={onCalibrate} style={{ background: '#34d399', color: '#000', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 10, fontWeight: 'bold', cursor: 'pointer' }}>Calibrate Mount (C)</button>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#e2e8f0', width: 60 }}>Upper Arm</span>
          {renderAxisButton("X", "upper", 0)}
          {renderAxisButton("Y", "upper", 1)}
          {renderAxisButton("Z", "upper", 2)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#e2e8f0', width: 60 }}>Forearm</span>
          {renderAxisButton("X", "forearm", 0)}
          {renderAxisButton("Y", "forearm", 1)}
          {renderAxisButton("Z", "forearm", 2)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#e2e8f0', width: 60 }}>Hand</span>
          {renderAxisButton("X", "hand", 0)}
          {renderAxisButton("Y", "hand", 1)}
          {renderAxisButton("Z", "hand", 2)}
        </div>
      </div>
    </div>
  );
}

// Returns true if the finger at fingerIdx (0=Pinky…4=Thumb) is calibrated
function isFingerCalibrated(calStatus, fingerIdx) {
  return !!(calStatus & (1 << fingerIdx));
}

/**
 * Build the 16-element finger bone quaternion array for ArmModel.
 * calStatus bitmask: bit0=Pinky, bit1=Ring, bit2=Middle, bit3=Index, bit4=Thumb.
 * Uncalibrated fingers stay in rest pose (null slots → ArmModel uses getSpreadRotation).
 */
function buildFingerEulers(fingers, thumbExtra, calStatus = 0xFF, isLeft = false) {
  if (!Array.isArray(fingers) || fingers.length < 5) return null;
  // Packet order: [Pinky=0, Ring=1, Middle=2, Index=3, Thumb=4]
  const pinky = fingers[0] ?? EMPTY_FINGER;
  const ring = fingers[1] ?? EMPTY_FINGER;
  const middle = fingers[2] ?? EMPTY_FINGER;
  const index = fingers[3] ?? EMPTY_FINGER;
  const thumb = fingers[4] ?? EMPTY_FINGER;

  // Unity script New_Magnets.cs mapping:
  // Thumb: X=0, Y=Yaw, Z=Pitch (Positive Z curls inward)
  // Others: X=Pitch, Y=0, Z=Yaw (Negative X curls inward in Three.js right-handed system)
  const thumbMcpEuler = (f) => [toRad(f.yaw), 0, isLeft ? -toRad(f.pitch1) : toRad(f.pitch1)];
  const thumbPipEuler = (f) => [0, 0, isLeft ? -toRad(f.pitch2) : toRad(f.pitch2)];
  const thumbIpEuler = [0, 0, isLeft ? -toRad(thumbExtra) : toRad(thumbExtra)];

  const fingerMcpEuler = (f) => [-toRad(f.pitch1), 0, isLeft ? -toRad(f.yaw) : toRad(f.yaw)];
  const fingerPipEuler = (f) => [-toRad(f.pitch2), 0, 0];

  // Only apply eulers for calibrated fingers; null → ArmModel falls back to rest spread
  const thumbE = isFingerCalibrated(calStatus, 4) ? { mcp: thumbMcpEuler(thumb), pip: thumbPipEuler(thumb), ip: thumbIpEuler } : null;
  const indexE = isFingerCalibrated(calStatus, 3) ? { mcp: fingerMcpEuler(index), pip: fingerPipEuler(index) } : null;
  const middleE = isFingerCalibrated(calStatus, 2) ? { mcp: fingerMcpEuler(middle), pip: fingerPipEuler(middle) } : null;
  const ringE = isFingerCalibrated(calStatus, 1) ? { mcp: fingerMcpEuler(ring), pip: fingerPipEuler(ring) } : null;
  const pinkyE = isFingerCalibrated(calStatus, 0) ? { mcp: fingerMcpEuler(pinky), pip: fingerPipEuler(pinky) } : null;

  return [
    /* [0]  thumb01 MCP  */ thumbE?.mcp ?? null,
    /* [1]  thumb02 PIP  */ thumbE?.pip ?? null,
    /* [2]  thumb03 IP   */ thumbE?.ip ?? null,
    /* [3]  index01 MCP  */ indexE?.mcp ?? null,
    /* [4]  index02 PIP  */ indexE?.pip ?? null,
    /* [5]  index03 DIP  */ indexE?.pip ?? null,   // DIP mirrors PIP
    /* [6]  middle01 MCP */ middleE?.mcp ?? null,
    /* [7]  middle02 PIP */ middleE?.pip ?? null,
    /* [8]  middle03 DIP */ middleE?.pip ?? null,
    /* [9]  ring01 MCP   */ ringE?.mcp ?? null,
    /* [10] ring02 PIP   */ ringE?.pip ?? null,
    /* [11] ring03 DIP   */ ringE?.pip ?? null,
    /* [12] pinky01 MCP  */ pinkyE?.mcp ?? null,
    /* [13] pinky02 PIP  */ pinkyE?.pip ?? null,
    /* [14] pinky03 DIP  */ pinkyE?.pip ?? null,
    /* [15] pinky03 end  */ pinkyE?.pip ?? null,
  ];
}

function buildRigData(frame) {
  if (!frame) return null;
  const rightFingers = buildFingerEulers(frame.fingerAngles, frame.thumbExtra ?? 0, frame.calStatus ?? 0xFF, false);
  const leftFingers = buildFingerEulers(frame.leftFingerAngles, frame.leftThumbExtra ?? 0, frame.leftCalStatus ?? 0xFF, true);

  return {
    right: {
      palm: frame.imuQuat ?? undefined,
      fingers: rightFingers ?? undefined,
    },
    left: {
      palm: frame.leftImuQuat ?? undefined,
      fingers: leftFingers ?? undefined,
    }
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
    calStatus: 0,       // bitmask — 0 = no fingers calibrated
    leftFingerAngles: null,
    leftFingerAnglesFlat: null,
    leftThumbExtra: 0,
    leftCalStatus: 0,
    leftConnected: false,
    leftImuQuat: null,
    imuTimestamp: null,
    fingerTimestamp: null,
    imuDiag: null,
    consoleLogs: { right: [], left: [] },
    imuPoseIdx: 0,
    imuPoseIdxL: 0,
  });
  const imuQuatRef = useRef(null);
  const leftImuQuatRef = useRef(null);
  const fingerAnglesRef = useRef(null);
  const fingerAnglesFlatRef = useRef(null);
  const thumbExtraRef = useRef(0);
  const wsRef = useRef(null);
  // Exposes latest raw voltages synchronously (no render cycle needed)
  const rawVoltagesRef = useRef(Array(16).fill(null));

  const reconnect = useCallback(() => {
    setConnectionId(id => id + 1);
  }, []);

  useEffect(() => {
    if (!ipAddress) return undefined;

    const socket = new WebSocket(`ws://${ipAddress}:81`);
    socket.binaryType = 'arraybuffer';
    wsRef.current = socket;

    socket.onopen = () => {
      console.log('[Glove] Connected');
      setGloveState(prev => ({ ...prev, connected: true }));
    };
    socket.onclose = () => {
      console.log('[Glove] Disconnected');
      setGloveState(prev => ({ ...prev, connected: false }));
      wsRef.current = null;
    };
    socket.onerror = (e) => console.warn('\[Glove\] Error:', e);

    socket.onmessage = async (event) => {
      try {
        //console.log('[Glove] Received:', event);
        // console.log("Here is the received data:", event.data);
        if (typeof event.data === 'string') {
          const logMsg = event.data;
          console.log('[Glove] Received string:', logMsg);
          setGloveState(prev => {
            const isLeft = logMsg.includes("[LEFT]") || logMsg.includes("[SLAVE]");
            const target = isLeft ? 'left' : 'right';
            const currentLogs = prev.consoleLogs || { right: [], left: [] };
            const newLogs = { ...currentLogs };
            newLogs[target] = [...(currentLogs[target] || []), logMsg].slice(-50); // Keep last 50 logs per hand

            let newPoseIdx = prev.imuPoseIdx;
            let newPoseIdxL = prev.imuPoseIdxL;
            const match = logMsg.match(/Recorded Pose (\d+)\/[36] successfully/);
            if (match) {
              if (isLeft) newPoseIdxL = parseInt(match[1], 10);
              else newPoseIdx = parseInt(match[1], 10);
            }
            if (logMsg.includes("6-poses calibration") || logMsg.includes("3-poses calibration") || logMsg.includes("Restarting calibration")) {
              if (isLeft) newPoseIdxL = 0;
              else newPoseIdx = 0;
            }

            return { ...prev, consoleLogs: newLogs, imuPoseIdx: newPoseIdx, imuPoseIdxL: newPoseIdxL };
          });
          return;
        }

        const buffer = event.data instanceof ArrayBuffer
          ? event.data
          : await event.data.arrayBuffer();

        const view = new DataView(buffer);

        if (buffer.byteLength < 4) return;
        const header = view.getUint32(0, true);

        if (header === 0x494D5543) { // "IMUC"
          if (view.byteLength < 54) return;
          const role = view.getUint8(4);
          const imuIdx = view.getUint8(5);
          const bias = [view.getFloat32(6, true), view.getFloat32(10, true), view.getFloat32(14, true)];
          const W = [];
          for (let i = 0; i < 9; i++) {
            W.push(view.getFloat32(18 + (i * 4), true));
          }

          setGloveState(prev => {
            const next = { ...prev };
            if (!next.imuCalibrations) next.imuCalibrations = { right: [], left: [] };
            const target = role === 0 ? 'right' : 'left';
            const calList = [...(next.imuCalibrations[target] || [])];
            calList[imuIdx] = { bias, W };
            return { ...next, imuCalibrations: { ...next.imuCalibrations, [target]: calList } };
          });
          return;
        }

        if (header === UNIFIED_PACKET_HEADER) {
          //console.log("Unified packet received");
          if (view.byteLength < 154) return;
          const timestamp = view.getUint32(4, true);
          //console.log("Unified packet received, here are the contents:  ", view);
          console
          const parseHand = (offset) => {
            const unpackQuat = (off) => {
              const w = view.getInt16(off + 0, true) / 32767.0;
              const x = view.getInt16(off + 2, true) / 32767.0;
              const y = view.getInt16(off + 4, true) / 32767.0;
              const z = view.getInt16(off + 6, true) / 32767.0;

              if (w === 0 && x === 0 && y === 0 && z === 0) {
                return { x: NaN, y: NaN, z: NaN, w: NaN, isZero: true };
              }
              const result = new THREE.Quaternion(x, y, z, w).normalize();
              result.isZero = false;
              return result;
            };

            const rQ_U = unpackQuat(offset + 0);
            const rQ_F = unpackQuat(offset + 8);
            const rQ_H = unpackQuat(offset + 16);

            const fingers = [];
            for (let f = 0; f < 5; f++) {
              fingers.push({
                yaw: view.getInt8(offset + 24 + f * 3 + 0),
                pitch1: view.getInt8(offset + 24 + f * 3 + 1),
                pitch2: view.getInt8(offset + 24 + f * 3 + 2),
              });
            }
            const thumbExtra = view.getInt8(offset + 39);

            const voltages = new Array(16);
            for (let i = 0; i < 16; i++) {
              voltages[i] = view.getUint16(offset + 40 + i * 2, true) / 10000.0;
            }

            const status = view.getUint8(offset + 72);
            const calStatus = status & 0x1F;
            const connected = ((status >>> 5) & 0x1) === 1;

            return { rQ_U, rQ_F, rQ_H, fingers, thumbExtra, voltages, calStatus, connected };
          };

          const right = parseHand(8);
          const left = parseHand(81);

          let imuQuat;
          if (!isNaN(right.rQ_U.x) && !right.rQ_H.isZero) {
            imuQuat = {
              upperArm: [right.rQ_U.x, right.rQ_U.y, right.rQ_U.z, right.rQ_U.w],
              forearm: [right.rQ_F.x, right.rQ_F.y, right.rQ_F.z, right.rQ_F.w],
              hand: [right.rQ_H.x, right.rQ_H.y, right.rQ_H.z, right.rQ_H.w]
            };
          }

          let leftImuQuat;
          if (!isNaN(left.rQ_U.x) && !left.rQ_H.isZero) {
            leftImuQuat = {
              upperArm: [left.rQ_U.x, left.rQ_U.y, left.rQ_U.z, left.rQ_U.w],
              forearm: [left.rQ_F.x, left.rQ_F.y, left.rQ_F.z, left.rQ_F.w],
              hand: [left.rQ_H.x, left.rQ_H.y, left.rQ_H.z, left.rQ_H.w]
            };
          }

          // if (imuQuat) {
          //   console.log(`[IMU R] U[${imuQuat.upperArm.map(v => v.toFixed(2)).join(',')}] F[${imuQuat.forearm.map(v => v.toFixed(2)).join(',')}] H[${imuQuat.hand.map(v => v.toFixed(2)).join(',')}]`);
          // }
          // if (leftImuQuat) {
          //   console.log(`[IMU L] U[${leftImuQuat.upperArm.map(v => v.toFixed(2)).join(',')}] F[${leftImuQuat.forearm.map(v => v.toFixed(2)).join(',')}] H[${leftImuQuat.hand.map(v => v.toFixed(2)).join(',')}]`);
          // }

          const rightFloats = [...right.fingers.flatMap(f => [f.yaw, f.pitch1, f.pitch2]), right.thumbExtra];
          const leftFloats = [...left.fingers.flatMap(f => [f.yaw, f.pitch1, f.pitch2]), left.thumbExtra];

          fingerAnglesRef.current = right.fingers;
          fingerAnglesFlatRef.current = rightFloats;
          thumbExtraRef.current = right.thumbExtra;
          if (imuQuat) imuQuatRef.current = imuQuat;
          if (leftImuQuat) leftImuQuatRef.current = leftImuQuat;
          rawVoltagesRef.current = right.voltages;

          const getWXYZ = (qArr) => {
            if (!qArr || qArr.length !== 4 || qArr.some(isNaN)) return [1.0, 0.0, 0.0, 0.0];
            return [qArr[3], qArr[0], qArr[1], qArr[2]]; // Convert [x,y,z,w] to [w,x,y,z]
          };
          const iqR = imuQuat ?? imuQuatRef.current;
          const iqL = leftImuQuat ?? leftImuQuatRef.current;

          const flat56 = [
            ...rightFloats,
            ...getWXYZ(iqR?.hand),
            ...getWXYZ(iqR?.forearm),
            ...getWXYZ(iqR?.upperArm),
            ...leftFloats,
            ...getWXYZ(iqL?.hand),
            ...getWXYZ(iqL?.forearm),
            ...getWXYZ(iqL?.upperArm),
          ];

          setGloveState(prev => ({
            ...prev,
            ...(imuQuat ? { imuQuat } : {}),
            ...(leftImuQuat ? { leftImuQuat } : {}),
            fingerAngles: right.fingers,
            fingerAnglesFlat: rightFloats,
            thumbExtra: right.thumbExtra,
            calStatus: right.calStatus,
            leftFingerAngles: left.fingers,
            leftFingerAnglesFlat: leftFloats,
            leftThumbExtra: left.thumbExtra,
            leftCalStatus: left.calStatus,
            leftConnected: left.connected,
            connected: right.connected,
            fingerTimestamp: timestamp,
            imuTimestamp: timestamp,
          }));

          if (onFrame) {
            onFrame({
              source: 'unified',
              fingers: rightFloats,
              fingerAngles: right.fingers,
              thumbExtra: right.thumbExtra,
              calStatus: right.calStatus,
              leftFingerAnglesFlat: leftFloats,
              leftFingerAngles: left.fingers,
              leftThumbExtra: left.thumbExtra,
              leftCalStatus: left.calStatus,
              imuQuat: imuQuat ?? imuQuatRef.current,
              leftImuQuat,
              flex: {},
              pads: [],
              rightVoltages: right.voltages,
              leftVoltages: left.voltages,
              timestamp,
              flat56,
              leftConnected: left.connected,
              connected: right.connected
            });
          }
          return;
        }

      } catch (err) {
        console.error('Glove packet parse error:', err);
      }
    };

    return () => socket.close();
  }, [ipAddress, onFrame, connectionId]);

  const sendCommand = useCallback((cmdId, payload, isLeft = false) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(buildCommandBuffer(cmdId, payload, isLeft));
    }
  }, []);

  return { ...gloveState, sendCommand, rawVoltagesRef, reconnect };
}

// Interpolate voltage to a colour: 0V=red, 1.5V=green, 2.5V=blue
function voltageToColor(v) {
  if (!Number.isFinite(v)) return '#4a5568';
  const c = Math.max(0, Math.min(VOLTAGE_FULL_SCALE, v));
  if (c <= VOLTAGE_NEUTRAL) {
    const t = c / VOLTAGE_NEUTRAL;
    return `hsl(${Math.round(t * 120)}, 75%, 48%)`;
  }
  const t = (c - VOLTAGE_NEUTRAL) / (VOLTAGE_FULL_SCALE - VOLTAGE_NEUTRAL);
  return `hsl(${Math.round(120 + t * 100)}, 70%, 52%)`;
}

function percentToColor(pct) {
  const t = Math.max(0, Math.min(1, pct / 100));
  return `hsl(${Math.round(t * 120)}, 75%, 45%)`;
}

function percentFromKnots(voltage, knots) {
  if (!Number.isFinite(voltage) || !Array.isArray(knots) || knots.length < 2) return null;
  if (!knots.every(Number.isFinite)) return null;

  const steps = [0, 25, 50, 75, 100];
  const lastIdx = knots.length - 1;
  const first = knots[0];
  const last = knots[lastIdx];

  for (let i = 0; i < lastIdx; i += 1) {
    const a = knots[i];
    const b = knots[i + 1];
    const span = b - a;
    if (Math.abs(span) < 1e-6) continue;
    const inRange = (voltage - a) * (voltage - b) <= 0;
    if (!inRange) continue;
    const t = (voltage - a) / span;
    const pct = steps[i] + t * (steps[i + 1] - steps[i]);
    return Math.max(0, Math.min(1, pct / 100));
  }

  const span = last - first;
  if (Math.abs(span) < 1e-6) return null;
  const t = (voltage - first) / span;
  return Math.max(0, Math.min(1, t));
}

function buildChannelKnots(knotsByAxis, fingerDefaults = HAND_CHANNEL_MAPS.right.fingerDefaults) {
  const channelKnots = Array.from({ length: 16 }, () => null);
  if (!Array.isArray(knotsByAxis)) return channelKnots;
  for (let finger = 0; finger < fingerDefaults.length; finger += 1) {
    for (let axis = 0; axis < fingerDefaults[finger].length; axis += 1) {
      const ch = fingerDefaults[finger][axis];
      if (ch === -1) continue;
      const knots = knotsByAxis?.[finger]?.[axis];
      if (Array.isArray(knots) && knots.every(Number.isFinite)) channelKnots[ch] = knots;
    }
  }
  return channelKnots;
}

// Finger index (0=Pinky…4=Thumb) for each sensor channel
const CH_FINGER_IDX = [2, 3, 3, 3, 4, 4, 4, 4, 0, 0, 0, 1, 1, 1, 2, 2];

function FingerAnglesPanel({ frame, calStatus = 0 }) {
  const f = Array.isArray(frame?.fingers) ? frame.fingers : null;
  // Finger order in flat array: Pinky(0-2), Ring(3-5), Middle(6-8), Index(9-11), Thumb(12-14), ThumbIP(15)
  // calStatus bits: 0=Pinky,1=Ring,2=Middle,3=Index,4=Thumb
  ////console.log(frame.fingers)
  const fingerBitMap = [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4];

  const fp = {
    wrap: { background: 'rgba(10,12,28,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', backdropFilter: 'blur(12px)' },
    header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' },
    title: { fontSize: 12, fontWeight: 600, color: '#a0aec0', letterSpacing: '0.8px', textTransform: 'uppercase' },
    body: { padding: '10px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
    item: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.05)' },
    label: { fontSize: 11, color: '#718096' },
    value: (cal) => ({ fontSize: 11.5, color: cal ? '#e2b96f' : '#60a5fa', fontVariantNumeric: 'tabular-nums', opacity: cal ? 1 : 0.8 }),
    empty: { padding: '12px 14px', fontSize: 12, color: '#4a5568' },
  };

  return (
    <div style={fp.wrap}>
      <div style={fp.header}>
        <span style={fp.title}>🧮 Finger Angles</span>
        <span style={{ fontSize: 10, color: '#4a5568' }}>° = calibrated · V = raw voltage</span>
      </div>
      {!f ? (
        <div style={fp.empty}>No glove data yet.</div>
      ) : (
        <div style={fp.body}>
          {FINGER_LABELS.map(({ label, idx }) => {
            const fingerBit = fingerBitMap[idx];
            const isCal = !!(calStatus & (1 << fingerBit));
            const val = f[idx];
            const display = Number.isFinite(val)
              ? `${val.toFixed(1)}${isCal ? '°' : 'V'}`
              : '—';
            return (
              <div key={label} style={fp.item}>
                <span style={fp.label}>{label}</span>
                <span style={fp.value(isCal)}>{display}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── IMU Diagnostics HUD ──────────────────────────────────────────────────────
function IMUDiagnosticsPanel({ diag, imuQuat, leftImuQuat, dualImuStatus }) {
  if (!diag && !imuQuat && !leftImuQuat) return null;

  const magPct = diag ? Math.round((diag.magStability ?? 0) * 100) : null;
  const drift = diag ? (diag.driftExposure ?? 0).toFixed(1) : null;
  const tAccel = diag ? (diag.timeSinceGoodAccel ?? 0).toFixed(1) : null;
  const tMag = diag ? (diag.timeSinceGoodMag ?? 0).toFixed(1) : null;
  const useMag = diag ? diag.useMag : null;

  // colour-code mag stability bar
  const magColor = !diag ? '#4a5568'
    : magPct >= 70 ? '#34d399'
      : magPct >= 40 ? '#f59e0b'
        : '#ef4444';

  const d = {
    wrap: { background: 'rgba(10,12,28,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', backdropFilter: 'blur(12px)' },
    header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' },
    title: { fontSize: 12, fontWeight: 600, color: '#a0aec0', letterSpacing: '0.8px', textTransform: 'uppercase' },
    badge: { fontSize: 10, padding: '2px 8px', borderRadius: 100, background: (imuQuat || leftImuQuat) ? 'rgba(52,211,153,0.12)' : 'rgba(74,85,104,0.3)', color: (imuQuat || leftImuQuat) ? '#34d399' : '#4a5568', border: `1px solid ${(imuQuat || leftImuQuat) ? 'rgba(52,211,153,0.25)' : 'rgba(255,255,255,0.06)'}` },
    body: { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
    row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    key: { fontSize: 11, color: '#718096' },
    val: { fontSize: 11.5, color: '#e2b96f', fontVariantNumeric: 'tabular-nums' },
    barBg: { flex: 1, height: 4, background: '#1a1f35', borderRadius: 4, overflow: 'hidden', margin: '0 10px' },
    barFill: (pct, color) => ({ width: `${pct}%`, height: '100%', borderRadius: 4, background: color, transition: 'width 0.5s' }),
    pill: (on) => ({ fontSize: 10, padding: '2px 7px', borderRadius: 100, background: on ? 'rgba(96,165,250,0.12)' : 'rgba(74,85,104,0.2)', color: on ? '#60a5fa' : '#4a5568', border: `1px solid ${on ? 'rgba(96,165,250,0.25)' : 'rgba(255,255,255,0.06)'}` }),
    grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, padding: 14 },
    card: { background: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 12, border: '1px solid rgba(255,255,255,0.05)' },
    cardTitle: { fontSize: 12, fontWeight: 600, color: '#e2b96f', marginBottom: 8, display: 'flex', justifyContent: 'space-between' },
  };

  const rightImus = [
    { key: 'r_upperArm', label: 'R Upper Arm IMU', data: imuQuat?.upperArm, diag: diag?.perImu?.upperArm, magActive: dualImuStatus?.right?.[0] === 1 },
    { key: 'r_forearm', label: 'R Forearm IMU', data: imuQuat?.forearm, diag: diag?.perImu?.forearm, magActive: dualImuStatus?.right?.[1] === 1 },
    { key: 'r_hand', label: 'R Hand IMU', data: imuQuat?.hand || imuQuat, diag: diag?.perImu?.hand, magActive: dualImuStatus?.right?.[2] === 1 }
  ];

  const leftImus = [
    { key: 'l_upperArm', label: 'L Upper Arm IMU', data: leftImuQuat?.upperArm, diag: null, magActive: dualImuStatus?.left?.[0] === 1 },
    { key: 'l_forearm', label: 'L Forearm IMU', data: leftImuQuat?.forearm, diag: null, magActive: dualImuStatus?.left?.[1] === 1 },
    { key: 'l_hand', label: 'L Hand IMU', data: leftImuQuat?.hand || leftImuQuat, diag: null, magActive: dualImuStatus?.left?.[2] === 1 }
  ];

  const imus = [...rightImus, ...(leftImuQuat || dualImuStatus?.leftConnected ? leftImus : [])];

  const STATE_LABELS = ['IDLE', 'BOOT CAL', 'STATIC ALIGN WAIT', 'STATIC ALIGN RECORDING', 'RUNNING', 'MAG CAL'];

  return (
    <div style={d.wrap}>
      <div style={d.header}>
        <span style={d.title}>📡 IMU Diagnostics & Telemetry</span>
        <span style={d.badge}>{(imuQuat || leftImuQuat) ? 'LIVE' : 'NO SIGNAL'}</span>
      </div>

      <div style={d.grid}>
        {imus.map((imu) => {
          if (!imu.data || !Array.isArray(imu.data)) return null;
          return (
            <div key={imu.key} style={d.card}>
              <div style={d.cardTitle}>
                <span>{imu.label}</span>
                <span style={{ color: imu.magActive ? '#34d399' : '#a0aec0', fontSize: 10 }}>● {imu.magActive ? 'Mag Active' : 'Mag Off'}</span>
              </div>

              {(() => {
                // Convert raw IMU quaternion to Euler angles for visualization
                const q = new THREE.Quaternion(imu.data[0], imu.data[1], imu.data[2], imu.data[3]);
                const e = new THREE.Euler().setFromQuaternion(q, 'YXZ');
                return (
                  <div style={{ ...d.row, marginBottom: 8, paddingBottom: 8, borderBottom: '1px dashed rgba(255,255,255,0.05)' }}>
                    <span style={d.key}>Euler (X, Y, Z)</span>
                    <span style={d.val}>
                      {Math.round(e.x * 180 / Math.PI)}° , {Math.round(e.y * 180 / Math.PI)}° , {Math.round(e.z * 180 / Math.PI)}°
                    </span>
                  </div>
                );
              })()}

              {imu.diag ? (
                <div>
                  <div style={d.row}>
                    <span style={d.key}>Drift Exposure</span>
                    <span style={{ ...d.val, color: imu.diag.drift > 0.035 ? '#f59e0b' : '#34d399' }}>{imu.diag.drift.toFixed(3)} rad</span>
                  </div>
                  <div style={d.row}>
                    <span style={d.key}>Accel Magnitude</span>
                    <span style={d.val}>{imu.diag.accelMag.toFixed(3)} g</span>
                  </div>
                  <div style={d.row}>
                    <span style={d.key}>Mag Norm</span>
                    <span style={d.val}>{imu.diag.magNorm.toFixed(1)} µT</span>
                  </div>
                  <div style={d.row}>
                    <span style={d.key}>Stale Accel</span>
                    <span style={{ ...d.val, color: imu.diag.timeAccel > 1 ? '#ef4444' : '#e2b96f' }}>{imu.diag.timeAccel.toFixed(1)}s</span>
                  </div>
                  <div style={d.row}>
                    <span style={d.key}>Magnetometer</span>
                    <span style={d.pill(imu.diag.magClean)}>{imu.diag.magClean ? 'CLEAN' : 'CORRUPT'}</span>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 11, color: '#718096', fontStyle: 'italic', padding: '10px 0' }}>
                  No per-IMU telemetry available.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {diag && (
        <div style={{ ...d.card, marginTop: 4 }}>
          <div style={d.cardTitle}>Global State</div>
          {diag.currentState !== undefined ? (
            <>
              <div style={d.row}>
                <span style={d.key}>System State</span>
                <span style={{ ...d.val, color: '#60a5fa', fontWeight: 'bold' }}>
                  {STATE_LABELS[diag.currentState] || `UNKNOWN (${diag.currentState})`}
                </span>
              </div>
              <div style={d.row}>
                <span style={d.key}>Phone Yaw Anchor</span>
                <span style={d.val}>{diag.phoneYawCorrection ? (diag.phoneYawCorrection * 180 / Math.PI).toFixed(1) + '°' : 'Not Set'}</span>
              </div>
            </>
          ) : (
            <>
              {/* Fallback for old 90-byte packet diagnostics */}
              <div style={d.row}>
                <span style={d.key}>Mag Stability</span>
                <span style={d.val}>{diag.magStability ? Math.round(diag.magStability * 100) + '%' : '—'}</span>
              </div>
              <div style={d.row}>
                <span style={d.key}>Drift Exposure</span>
                <span style={{ ...d.val, color: diag.driftExposure > 5 ? '#f59e0b' : '#e2b96f' }}>{diag.driftExposure ? diag.driftExposure.toFixed(1) + 's' : '—'}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Calibration Status Strip ─────────────────────────────────────────────────
// 3-state: grey=not cal, yellow=knots sent (UI), green=firmware confirms calibrated
const CAL_FINGER_ORDER = [
  { label: 'Pinky', bit: 0 },
  { label: 'Ring', bit: 1 },
  { label: 'Mid', bit: 2 },
  { label: 'Index', bit: 3 },
  { label: 'Thumb', bit: 4 },
];

function getFingerCalState(fingerIdx, calStatus, knotsByAxis, fingerDefaults = HAND_CHANNEL_MAPS.right.fingerDefaults) {
  if (calStatus & (1 << fingerIdx)) return 'green';
  const axes = knotsByAxis?.[fingerIdx];
  if (axes) {
    const hasAnyAxis = axes.some((axKnots, ai) =>
      fingerDefaults[fingerIdx][ai] !== -1 && axKnots.every(k => Number.isFinite(k))
    );
    if (hasAnyAxis) return 'yellow';
  }
  return 'grey';
}

function CalStatusStrip({ calStatus, knotsByAxis, fingerDefaults }) {
  const stateColor = { green: '#34d399', yellow: '#f59e0b', grey: '#4a5568' };
  const stateBg = { green: 'rgba(52,211,153,0.12)', yellow: 'rgba(245,158,11,0.12)', grey: 'rgba(74,85,104,0.15)' };
  const stateBorder = { green: 'rgba(52,211,153,0.30)', yellow: 'rgba(245,158,11,0.30)', grey: 'rgba(255,255,255,0.06)' };
  const stateLabel = { green: '✓', yellow: '~', grey: '○' };

  const calCount = [0, 1, 2, 3, 4].filter(b => calStatus & (1 << b)).length;

  return (
    <div style={{ background: 'rgba(10,12,28,0.95)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', backdropFilter: 'blur(12px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#a0aec0', letterSpacing: '0.8px', textTransform: 'uppercase' }}>Calibration Status</span>
        <span style={{ fontSize: 10, color: calCount === 5 ? '#34d399' : '#718096' }}>
          {calCount === 5 ? '✓ All calibrated' : `${calCount}/5 firmware-confirmed`}
        </span>
      </div>
      <div style={{ padding: '10px 14px', display: 'flex', gap: 6 }}>
        {CAL_FINGER_ORDER.map(({ label, bit }) => {
          const state = getFingerCalState(bit, calStatus, knotsByAxis, fingerDefaults);
          return (
            <div key={label} style={{
              flex: 1, padding: '8px 4px', borderRadius: 10, textAlign: 'center',
              fontSize: 10, fontWeight: 600, letterSpacing: '0.3px',
              background: stateBg[state], color: stateColor[state],
              border: `1px solid ${stateBorder[state]}`, transition: 'all 0.3s',
            }}>
              <div style={{ fontSize: 14, marginBottom: 2 }}>{stateLabel[state]}</div>
              {label}
            </div>
          );
        })}
      </div>
      <div style={{ padding: '4px 14px 10px', display: 'flex', gap: 16 }}>
        {[{ c: 'green', t: 'Firmware cal' }, { c: 'yellow', t: 'Knots pending' }, { c: 'grey', t: 'Not set' }].map(({ c, t }) => (
          <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: stateColor[c] }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: stateColor[c], display: 'inline-block' }} />
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Live Voltage Monitor ─────────────────────────────────────────────────────
function LiveVoltageMonitor({ voltages, sensorHealth, labels }) {
  const channelLabels = Array.isArray(labels) && labels.length === 16
    ? labels
    : HAND_CHANNEL_MAPS.right.labels;
  return (
    <div style={{ background: 'rgba(10,12,28,0.98)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', backdropFilter: 'blur(12px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#a0aec0', letterSpacing: '0.8px', textTransform: 'uppercase' }}>Hall Sensor Voltages</span>
        <span style={{ fontSize: 10, color: '#4a5568' }}>raw volts</span>
      </div>
      <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {channelLabels.map((label, idx) => {
          const v = voltages?.[idx];
          const valid = Number.isFinite(v);
          const outOfRange = valid && (v < VOLTAGE_MIN_VALID || v > VOLTAGE_MAX_VALID);
          const dead = sensorHealth?.[idx]?.dead;
          const fill = valid ? Math.min(100, (v / VOLTAGE_FULL_SCALE) * 100) : 0;
          const color = voltageToColor(v);
          const displayColor = outOfRange ? '#ef4444' : dead ? '#f59e0b' : color;
          const statusLabel = outOfRange ? 'out' : dead ? 'flat' : '';
          return (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 9, color: '#4a5568', width: 22, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>ch{idx}</span>
              <span style={{ fontSize: 10, color: '#718096', width: 108, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
              <div style={{ flex: 1, height: 6, background: '#1a1f35', borderRadius: 3, overflow: 'visible', position: 'relative' }}>
                <div style={{ height: '100%', width: `${fill}%`, background: color, borderRadius: 3, transition: 'width 0.15s, background 0.3s' }} />
              </div>
              <span style={{ fontSize: 10, width: 60, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: displayColor, flexShrink: 0 }}>
                {valid ? `${v.toFixed(4)}V` : '---'}
                {statusLabel ? ` ${statusLabel}` : ''}
              </span>
            </div>
          );
        })}
        <div style={{ marginTop: 6, display: 'flex', gap: 16, fontSize: 10 }}>
          {[{ color: '#ef4444', text: 'out = voltage out of range (0.3–2.1V)' }, { color: '#f59e0b', text: 'flat = no variation in 30s' }].map(({ color, text }) => (
            <span key={text} style={{ color }}>{text}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function CouplingCalibrationUI({
  couplingByFinger, setCouplingByFinger,
  couplingFinger, setCouplingFinger,
  onApply, isConnected,
  takeMedianSamples, setCalError,
  fingerDefaults
}) {
  const [step, setStep] = useState('idle'); // idle, baseline, pose1, pose2, pose3
  const [baselines, setBaselines] = useState(null);
  const [isCapturing, setIsCapturing] = useState(false);

  useEffect(() => {
    setStep('idle');
    setBaselines(null);
  }, [couplingFinger, fingerDefaults]);

  const defaults = fingerDefaults ?? HAND_CHANNEL_MAPS.right.fingerDefaults;
  const [chYaw, chP1, chP2, chIP] = defaults[couplingFinger];

  const captureBaseline = async () => {
    if (chP1 === -1 || chP2 === -1) { setCalError('Sensors not available'); return; }
    setIsCapturing(true);
    try {
      const medians = await takeMedianSamples(800);
      setBaselines({
        yaw: medians[chYaw] ?? 0,
        p1: medians[chP1],
        p2: medians[chP2],
        ip: chIP !== -1 ? medians[chIP] : 0
      });
      setStep('pose1');
    } catch (e) {
      setCalError(e.message);
    } finally {
      setIsCapturing(false);
    }
  };

  const capturePose = async (poseName) => {
    setIsCapturing(true);
    try {
      const medians = await takeMedianSamples(800);
      const vP1 = medians[chP1];
      const vP2 = medians[chP2];
      const vIP = chIP !== -1 ? medians[chIP] : 0;

      setCouplingByFinger(prev => {
        const next = prev.map(f => [...f]);
        const coeffs = next[couplingFinger];

        if (poseName === 'pose1') {
          coeffs[0] = vP1 - baselines.p1;
          setStep('pose2');
        } else if (poseName === 'pose2') {
          coeffs[1] = vP1 - baselines.p1;
          coeffs[2] = vP2 - baselines.p2;
          if (chIP !== -1) coeffs[5] = vIP - baselines.ip;
          setStep('pose3');
        } else if (poseName === 'pose3') {
          coeffs[3] = vP2 - baselines.p2;
          if (chIP !== -1) {
            setStep('pose4');
          } else {
            setStep('done');
          }
        } else if (poseName === 'pose4') {
          coeffs[4] = vP1 - baselines.p1;
          setStep('done');
        }
        return next;
      });
    } catch (e) {
      setCalError(e.message);
    } finally {
      setIsCapturing(false);
    }
  };

  const setCoeff = (i, val) => {
    setCouplingByFinger(prev => {
      const n = prev.map(f => [...f]);
      n[couplingFinger][i] = val;
      return n;
    });
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {CAL_FINGER_NAMES.map((name, fi) => (
          <button key={name} onClick={() => setCouplingFinger(fi)}
            style={{
              flex: 1, padding: '6px 4px', borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
              background: fi === couplingFinger ? 'rgba(226,185,111,0.15)' : 'rgba(255,255,255,0.04)',
              color: fi === couplingFinger ? '#e2b96f' : '#718096',
              border: `1px solid ${fi === couplingFinger ? 'rgba(226,185,111,0.35)' : 'rgba(255,255,255,0.08)'}`,
            }}>{name}</button>
        ))}
      </div>

      <div style={{ marginBottom: 16, padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.08)' }}>
        <h4 style={{ fontSize: 12, color: '#e2b96f', marginBottom: 8, marginTop: 0 }}>3-Pose Capture</h4>
        {step === 'idle' && (
          <div>
            <p style={{ fontSize: 11, color: '#a0aec0', marginTop: 0 }}>Step 1: Relax hand completely (all joints straight).</p>
            <button onClick={captureBaseline} disabled={isCapturing} style={{ padding: '6px 12px', borderRadius: 6, background: '#34d399', color: '#000', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}>
              {isCapturing ? 'Capturing...' : 'Capture Baseline'}
            </button>
          </div>
        )}
        {step === 'pose1' && (
          <div>
            <p style={{ fontSize: 11, color: '#a0aec0', marginTop: 0 }}>Step 2: <b>Bend ONLY the Tip (P2)</b> fully. Keep knuckle (P1) and Yaw relaxed.</p>
            <button onClick={() => capturePose('pose1')} disabled={isCapturing} style={{ padding: '6px 12px', borderRadius: 6, background: '#60a5fa', color: '#000', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}>
              {isCapturing ? 'Capturing...' : 'Capture Pose 1'}
            </button>
          </div>
        )}
        {step === 'pose2' && (
          <div>
            <p style={{ fontSize: 11, color: '#a0aec0', marginTop: 0 }}>Step 3: <b>Move ONLY Yaw</b> to max spread. Keep P1 and P2 straight.</p>
            <button onClick={() => capturePose('pose2')} disabled={isCapturing} style={{ padding: '6px 12px', borderRadius: 6, background: '#60a5fa', color: '#000', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}>
              {isCapturing ? 'Capturing...' : 'Capture Pose 2'}
            </button>
          </div>
        )}
        {step === 'pose3' && (
          <div>
            <p style={{ fontSize: 11, color: '#a0aec0', marginTop: 0 }}>Step 4: <b>Bend ONLY the Knuckle (P1)</b> fully. Keep Tip (P2) and Yaw relaxed.</p>
            <button onClick={() => capturePose('pose3')} disabled={isCapturing} style={{ padding: '6px 12px', borderRadius: 6, background: '#60a5fa', color: '#000', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}>
              {isCapturing ? 'Capturing...' : 'Capture Pose 3'}
            </button>
          </div>
        )}
        {step === 'pose4' && (
          <div>
            <p style={{ fontSize: 11, color: '#a0aec0', marginTop: 0 }}>Step 5 (Thumb Only): <b>Bend ONLY the IP Joint</b> fully. Keep Yaw, P1, and P2 relaxed.</p>
            <button onClick={() => capturePose('pose4')} disabled={isCapturing} style={{ padding: '6px 12px', borderRadius: 6, background: '#60a5fa', color: '#000', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 'bold' }}>
              {isCapturing ? 'Capturing...' : 'Capture Pose 4'}
            </button>
          </div>
        )}
        {step === 'done' && (
          <div>
            <p style={{ fontSize: 11, color: '#34d399', marginTop: 0 }}>Capture complete! Review coefficients below and click Apply.</p>
            <button onClick={() => setStep('idle')} style={{ padding: '6px 12px', borderRadius: 6, background: 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11 }}>
              Restart Sequence
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
        {(couplingFinger === 4 ? COUPLING_LABELS_THUMB : COUPLING_LABELS_STANDARD).map((lbl, i) => (
          <div key={lbl}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: '#a0aec0' }}>{lbl}</span>
              <span style={{ fontSize: 11, color: '#e2b96f', fontVariantNumeric: 'tabular-nums' }}>{couplingByFinger[couplingFinger][i].toFixed(4)}</span>
            </div>
            <input type="range" min="-1" max="1" step="0.0001"
              value={couplingByFinger[couplingFinger][i]}
              onChange={e => setCoeff(i, parseFloat(e.target.value))}
              style={{ width: '100%' }}
            />
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => onApply(couplingFinger)} disabled={!isConnected}
          style={{
            flex: 1, padding: '9px', borderRadius: 10, fontSize: 12, cursor: isConnected ? 'pointer' : 'not-allowed', fontFamily: "'DM Sans', sans-serif",
            background: 'rgba(226,185,111,0.12)', color: '#e2b96f', border: '1px solid rgba(226,185,111,0.30)', opacity: isConnected ? 1 : 0.5
          }}>
          ✓ Apply Coupling
        </button>
      </div>
    </div>
  );
}


// ─── Tiny reusable 3-D scene wrapper ─────────────────────────────────────────
const Scene = memo(function Scene({ rigDataRef, restRotationR, restRotationL, wristLimits, armLimits, fingerLimits, onRestPosesLoaded }) {
  return (
    <Canvas camera={{ position: [0, 0.4, 1.9], fov: 40 }} style={{ width: '100%', height: '100%' }}>
      <ambientLight intensity={1.8} />
      <directionalLight position={[5, 10, 5]} intensity={2.5} />
      <pointLight position={[-5, 5, -3]} intensity={0.6} />
      <ArmModel
        rigDataRef={rigDataRef}
        restRotationR={restRotationR}
        restRotationL={restRotationL}
        wristLimits={wristLimits}
        armLimits={armLimits}
        fingerLimits={fingerLimits}
        onRestPosesLoaded={onRestPosesLoaded}
      />
    </Canvas>
  );
});
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
  restRotationR,
  restRotationL,
  wristLimits,
  armLimits,
  fingerLimits,
  restPosesRef,
  computeRigFromFrame,
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
  const displayRigData = computeRigFromFrame(displayFrame);
  const displayRigDataRef = useRef(null);
  displayRigDataRef.current = displayRigData;
  const handleRestPosesLoaded = useCallback((poses)=>{
    if(restPosesRef){
      restPosesRef.current = poses;
    }
  },[restPosesRef]);

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
          <Scene
            rigDataRef={displayRigDataRef}
            restRotationR={restRotationR}
            restRotationL={restRotationL}
            wristLimits={wristLimits}
            armLimits={armLimits}
            fingerLimits={fingerLimits}
            //onRestPosesLoaded={(poses) => { restPosesRef.current = poses; }}
            onRestPosesLoaded={handleRestPosesLoaded}
          />
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
export default function GloveCapture() {
  const router = useRouter();

  const [espIp, setEspIp] = useState("192.168.1.8");
  const [ipInput, setIpInput] = useState("192.168.1.8");

  useEffect(() => {
    const saved = localStorage.getItem('espIp');
    const defaultIp = saved || process.env.NEXT_PUBLIC_ESP_IP || '192.168.1.8';
    setEspIp(defaultIp);
    setIpInput(defaultIp);
  }, []);

  const handleApplyIp = () => {
    setEspIp(ipInput);
    localStorage.setItem('espIp', ipInput);
  };

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordedFrames, setRecordedFrames] = useState([]);
  const isRecordingRef = useRef(false); // mirrors state for use inside WS closure

  // WebSocket & live frame
  // Sensor-health tracking: rolling 30-second min/max per channel
  const sensorHistoryRef = useRef(Array.from({ length: 16 }, () => ({ min: Infinity, max: -Infinity, samples: [] })));
  const [sensorHealth, setSensorHealth] = useState(() => Array(16).fill({ dead: false }));
  const sensorHealthTimerRef = useRef(null);
  const rawVoltagesByHandRef = useRef({
    right: Array(16).fill(null),
    left: Array(16).fill(null)
  });
  const latestRigDataRef = useRef(null);
  const handleFrame = useCallback((frame) => {
    if (frame?.source === 'config_knots') {
      setKnotsByAxis(prev => {
        const next = [...prev];
        next[frame.fingerIdx] = [...next[frame.fingerIdx]];
        next[frame.fingerIdx][frame.axis] = frame.newKnots;
        return next;
      });
      return;
    }

    if (frame?.source === 'config_coupling') {
      setCouplingByFinger(prev => {
        const next = [...prev];
        next[frame.fingerIdx] = frame.newCoeffs;
        return next;
      });
      return;
    }

    if (frame?.source === 'raw' || frame?.source === 'raw_dual' || frame?.source === 'unified') {
      if (frame?.source === 'unified') {
        if (Array.isArray(frame.rightVoltages)) rawVoltagesByHandRef.current.right = frame.rightVoltages;
        if (Array.isArray(frame.leftVoltages)) rawVoltagesByHandRef.current.left = frame.leftVoltages;
      }
      let voltages = frame.voltages;
      if (frame?.source === 'raw_dual' || frame?.source === 'unified') {
        voltages = calHandRef.current === 'left' ? frame.leftVoltages : frame.rightVoltages;
      }

      setRawVoltages(voltages);
      // Track per-channel variance for 30s dead-sensor detection
      const now = Date.now();
      const hist = sensorHistoryRef.current;
      let changed = false;
      voltages.forEach((v, ch) => {
        if (!Number.isFinite(v)) return;
        const h = hist[ch];
        h.samples.push({ t: now, v });
        // Trim samples older than 30s
        h.samples = h.samples.filter(s => now - s.t < 30000);
        const newMin = Math.min(...h.samples.map(s => s.v));
        const newMax = Math.max(...h.samples.map(s => s.v));
        if (newMin !== h.min || newMax !== h.max) { h.min = newMin; h.max = newMax; changed = true; }
      });
      if (changed) {
        clearTimeout(sensorHealthTimerRef.current);
        sensorHealthTimerRef.current = setTimeout(() => {
          setSensorHealth(hist.map(h => ({ dead: (h.max - h.min) < SENSOR_DEAD_THRESH && h.samples.length > 30 })));
        }, 500);
      }
      if (rawWaiterRef.current) {
        const waiter = rawWaiterRef.current;
        rawWaiterRef.current = null;
        clearTimeout(waiter.timer);
        waiter.resolve(voltages);
      }
      if (frame?.source !== 'unified') return;
    }

    if (!isRecordingRef.current) return;
    if (frame?.source !== 'finger' && frame?.source !== 'unified') return;
    if (!frame?.fingers) return;
    setRecordedFrames(prev => [...prev, frame]);
  }, []);

  const gloveFrame = useGloveWebSocket(espIp, handleFrame);

  const currentFrame = useMemo(() => {
    if (!gloveFrame?.imuQuat && !gloveFrame?.fingerAnglesFlat) return null;
    return {
      fingers: gloveFrame.fingerAnglesFlat,
      fingerAngles: gloveFrame.fingerAngles,
      thumbExtra: gloveFrame.thumbExtra,
      calStatus: gloveFrame.calStatus ?? 0,

      leftFingers: gloveFrame.leftFingerAnglesFlat,
      leftFingerAngles: gloveFrame.leftFingerAngles,
      leftThumbExtra: gloveFrame.leftThumbExtra,
      leftCalStatus: gloveFrame.leftCalStatus ?? 0,

      imuQuat: gloveFrame.imuQuat,
      leftImuQuat: gloveFrame.leftImuQuat,
      dualImuStatus: gloveFrame.dualImuStatus,
      imuDiag: gloveFrame.imuDiag ?? null,
      flex: {},
      pads: [],
    };
  }, [gloveFrame]);

  const [modelAlignRight, setModelAlignRight] = useState({
    upper: [0, 0, 0],
    forearm: [0, 0, 0],
    hand: [0, 0, 0]
  });
  const [modelAlignLeft, setModelAlignLeft] = useState({
    upper: [0, 0, 0],
    forearm: [0, 0, 0],
    hand: [0, 0, 0]
  });

  const mountCorrRef = useRef({
    upperR: new THREE.Quaternion(),
    forearmRL: new THREE.Quaternion(),
    forearmRR: new THREE.Quaternion(),
    handRL: new THREE.Quaternion(),
    handRR: new THREE.Quaternion(),
    upperL: new THREE.Quaternion(),
    forearmLL: new THREE.Quaternion(),
    forearmLR: new THREE.Quaternion(),
    handLL: new THREE.Quaternion(),
    handLR: new THREE.Quaternion()
  });

  const restPosesRef = useRef(null);
  const handleRestPosesLoaded = useCallback((poses)=>{restPosesRef.current = poses;},[]);
  const tareUpperRRef = useRef(new THREE.Quaternion());
  const tareUpperLRef = useRef(new THREE.Quaternion());
  const modelAlignRightRef = useRef(modelAlignRight);
  const modelAlignLeftRef = useRef(modelAlignLeft);
  useEffect(() => { modelAlignRightRef.current = modelAlignRight; }, [modelAlignRight]);
  useEffect(() => { modelAlignLeftRef.current = modelAlignLeft; }, [modelAlignLeft]);

  const currentFrameRef = useRef(currentFrame);
  useEffect(() => { currentFrameRef.current = currentFrame; }, [currentFrame]);

  const [isCalibrated, setIsCalibrated] = useState(false);

  const calibrateMountOffsets = useCallback(() => {
    const frame = currentFrameRef.current;
    const isLeft = calHandRef.current === 'left';

    const imuQuat = isLeft ? frame?.leftImuQuat : frame?.imuQuat;
    const restPosesObj = isLeft ? restPosesRef.current?.left : restPosesRef.current?.right;

    if (!imuQuat?.upperArm || !restPosesObj) return;

    const handSide = isLeft ? 'left' : 'right';
    const hwUpperWorld = ConvertToThreeSpace(new THREE.Quaternion().fromArray(imuQuat.upperArm), handSide);
    const hwForearmLocal = ConvertToThreeSpace(new THREE.Quaternion().fromArray(imuQuat.forearm), handSide);
    const hwHandLocal = ConvertToThreeSpace(new THREE.Quaternion().fromArray(imuQuat.hand), handSide);

    const mAlign = isLeft ? modelAlignLeftRef.current : modelAlignRightRef.current;
    const mAlignUp = new THREE.Quaternion().setFromEuler(new THREE.Euler((parseFloat(mAlign.upper[0]) || 0) * DEG2RAD, (parseFloat(mAlign.upper[1]) || 0) * DEG2RAD, (parseFloat(mAlign.upper[2]) || 0) * DEG2RAD, 'XYZ'));
    const mAlignFo = new THREE.Quaternion().setFromEuler(new THREE.Euler((parseFloat(mAlign.forearm[0]) || 0) * DEG2RAD, (parseFloat(mAlign.forearm[1]) || 0) * DEG2RAD, (parseFloat(mAlign.forearm[2]) || 0) * DEG2RAD, 'XYZ'));
    const mAlignHa = new THREE.Quaternion().setFromEuler(new THREE.Euler((parseFloat(mAlign.hand[0]) || 0) * DEG2RAD, (parseFloat(mAlign.hand[1]) || 0) * DEG2RAD, (parseFloat(mAlign.hand[2]) || 0) * DEG2RAD, 'XYZ'));

    const { upper: upperRestPose, upperWorld: upperRestWorld, forearm: forearmRestPose, hand: handRestPose } = restPosesObj;

    // 1. Calculate World Tare (Body Facing Direction) via Swing-Twist
    const hwUpAligned = hwUpperWorld.clone().multiply(mAlignUp);
    const delta = hwUpAligned.clone().multiply(upperRestPose.clone().invert());

    // Extract pure Y-axis rotation, ignoring strap roll
    let tareQ = new THREE.Quaternion(0, delta.y, 0, delta.w).normalize();
    if (tareQ.lengthSq() < 0.0001) tareQ = new THREE.Quaternion(0, 1, 0, 0);

    if (isLeft) tareUpperLRef.current = tareQ;
    else tareUpperRRef.current = tareQ;

    // 2. Calculate Local Mount Offset
    // This perfectly absorbs the physical strap crookedness
    const upperMountCorr = hwUpperWorld.clone().invert()
      .multiply(tareQ)
      .multiply(upperRestWorld || upperRestPose)
      .multiply(mAlignUp.clone().invert());

    const forearmMountL = upperMountCorr.clone().invert();
    const forearmMountR = hwForearmLocal.clone().invert()
      .multiply(upperMountCorr).multiply(mAlignUp)
      .multiply(forearmRestPose)
      .multiply(mAlignFo.clone().invert());

    const handMountL = forearmMountR.clone().invert();
    const handMountR = hwHandLocal.clone().invert()
      .multiply(forearmMountR).multiply(mAlignFo)
      .multiply(handRestPose)
      .multiply(mAlignHa.clone().invert());

    if (isLeft) {
      mountCorrRef.current.upperL = upperMountCorr;
      mountCorrRef.current.forearmLL = forearmMountL;
      mountCorrRef.current.forearmLR = forearmMountR;
      mountCorrRef.current.handLL = handMountL;
      mountCorrRef.current.handLR = handMountR;
    } else {
      mountCorrRef.current.upperR = upperMountCorr;
      mountCorrRef.current.forearmRL = forearmMountL;
      mountCorrRef.current.forearmRR = forearmMountR;
      mountCorrRef.current.handRL = handMountL;
      mountCorrRef.current.handRR = handMountR;
    }

    setIsCalibrated(true);
  }, []);

  const tareHeading = useCallback(() => {
    const frame = currentFrameRef.current;
    const isLeft = calHandRef.current === 'left';
    const imuQuat = isLeft ? frame?.leftImuQuat : frame?.imuQuat;
    const restPosesObj = isLeft ? restPosesRef.current?.left : restPosesRef.current?.right;

    if (!imuQuat?.upperArm || !restPosesObj) return;

    const handSide = isLeft ? 'left' : 'right';
    const hwUpperWorld = ConvertToThreeSpace(new THREE.Quaternion().fromArray(imuQuat.upperArm), handSide);
    const { upper: upperRestPose } = restPosesObj;

    const mAlign = isLeft ? modelAlignLeftRef.current : modelAlignRightRef.current;
    const mAlignUp = new THREE.Quaternion().setFromEuler(new THREE.Euler((parseFloat(mAlign.upper[0]) || 0) * DEG2RAD, (parseFloat(mAlign.upper[1]) || 0) * DEG2RAD, (parseFloat(mAlign.upper[2]) || 0) * DEG2RAD, 'XYZ'));
    const mCorrR = isLeft ? mountCorrRef.current.upperL : mountCorrRef.current.upperR;

    // Find where the arm is currently pointing natively
    const currentUntared = hwUpperWorld.clone().multiply(mCorrR).multiply(mAlignUp);

    // Extract the new pure Y-axis difference
    const delta = currentUntared.clone().multiply(upperRestPose.clone().invert());
    let newTareQ = new THREE.Quaternion(0, delta.y, 0, delta.w).normalize();
    if (newTareQ.lengthSq() < 0.0001) newTareQ = new THREE.Quaternion(0, 1, 0, 0);

    if (isLeft) tareUpperLRef.current = newTareQ;
    else tareUpperRRef.current = newTareQ;
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.matches('input, textarea')) return;
      if (e.key.toLowerCase() === 'c') {
        calibrateMountOffsets();
      } else if (e.code === 'Space') {
        e.preventDefault();
        tareHeading();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [calibrateMountOffsets, tareHeading]);

  // ─── Manual pose states (Must be before rigFrame) ───
  const [manualFingersEnable, setManualFingersEnable] = useState(false);
  const [manualArmsEnable, setManualArmsEnable] = useState({
    right: { upperArm: false, forearm: false, hand: false },
    left: { upperArm: false, forearm: false, hand: false }
  });
  const [manualFingers, setManualFingers] = useState(() => (
    Array.from({ length: 5 }, () => ({ yaw: 0, pitch1: 0, pitch2: 0 }))
  )); // order: [Pinky, Ring, Middle, Index, Thumb]
  const [manualThumbExtra, setManualThumbExtra] = useState(0);
  // Arm joints manual sliders in degrees [X, Y, Z]
  const [manualRightArm, setManualRightArm] = useState({
    upperArm: [-3, 0, 2],
    forearm: [92, -70, -1],
    hand: [0, 0, 0]
  });
  const [manualLeftArm, setManualLeftArm] = useState({
    upperArm: [1, -5, -4],
    forearm: [90, 73, 0],
    hand: [17, 0, 0]
  });

  const computeRigFromFrame = useCallback((frameDataInput) => {
    if (!frameDataInput) return null;
    const frameData = { ...frameDataInput };
    if (manualFingersEnable) {
      frameData.fingerAngles = manualFingers;
      frameData.thumbExtra = manualThumbExtra;
      frameData.calStatus = CAL_ALL_FINGERS;
      frameData.leftFingerAngles = manualFingers;
      frameData.leftThumbExtra = manualThumbExtra;
      frameData.leftCalStatus = CAL_ALL_FINGERS;
    }

    const rig = buildRigData(frameData);
    if (!rig) return null;

    const defaultPalmR = {
      upperArm: quatFromEuler(...manualRightArm.upperArm.map(d => (Number.isFinite(d) ? d * DEG2RAD : 0))),
      forearm: quatFromEuler(...manualRightArm.forearm.map(d => (Number.isFinite(d) ? d * DEG2RAD : 0))),
      hand: quatFromEuler(...manualRightArm.hand.map(d => (Number.isFinite(d) ? d * DEG2RAD : 0)))
    };
    const defaultPalmL = {
      upperArm: quatFromEuler(...manualLeftArm.upperArm.map(d => (Number.isFinite(d) ? d * DEG2RAD : 0))),
      forearm: quatFromEuler(...manualLeftArm.forearm.map(d => (Number.isFinite(d) ? d * DEG2RAD : 0))),
      hand: quatFromEuler(...manualLeftArm.hand.map(d => (Number.isFinite(d) ? d * DEG2RAD : 0)))
    };

    const fallbackPalmR = { forceZeroPose: true, ...defaultPalmR };
    const fallbackPalmL = { forceZeroPose: true, ...defaultPalmL };

    const mc = mountCorrRef.current;

    const processArm = (imuQuat, mAlign, mCorrR, tareRef, handSide) => {
      if (!imuQuat?.upperArm) return null;
      const hwUp = ConvertToThreeSpace(new THREE.Quaternion().fromArray(imuQuat.upperArm), handSide);
      const hwFo = ConvertToThreeSpace(new THREE.Quaternion().fromArray(imuQuat.forearm), handSide);
      const hwHa = ConvertToThreeSpace(new THREE.Quaternion().fromArray(imuQuat.hand), handSide);

      const mUp = new THREE.Quaternion().setFromEuler(new THREE.Euler((parseFloat(mAlign.upper[0]) || 0) * DEG2RAD, (parseFloat(mAlign.upper[1]) || 0) * DEG2RAD, (parseFloat(mAlign.upper[2]) || 0) * DEG2RAD, 'XYZ'));
      const mFo = new THREE.Quaternion().setFromEuler(new THREE.Euler((parseFloat(mAlign.forearm[0]) || 0) * DEG2RAD, (parseFloat(mAlign.forearm[1]) || 0) * DEG2RAD, (parseFloat(mAlign.forearm[2]) || 0) * DEG2RAD, 'XYZ'));
      const mHa = new THREE.Quaternion().setFromEuler(new THREE.Euler((parseFloat(mAlign.hand[0]) || 0) * DEG2RAD, (parseFloat(mAlign.hand[1]) || 0) * DEG2RAD, (parseFloat(mAlign.hand[2]) || 0) * DEG2RAD, 'XYZ'));

      // 1. Upper Arm: Inverse Tare (World Space) * Raw IMU * Mount Offset (Local Space) * Proxy
      const tareQ = tareRef.current || new THREE.Quaternion();
      const tareInverse = tareQ.clone().invert();
      const alUp = tareInverse.multiply(hwUp).multiply(mCorrR.upper).multiply(mUp);

      // 2. Forearm & Hand: (Relative IMUs don't need Tare)
      const mUpInv = mUp.clone().invert();
      const mFoInv = mFo.clone().invert();

      const alFo = mUpInv.multiply(mCorrR.forearmL).multiply(hwFo).multiply(mCorrR.forearmR).multiply(mFo);
      const alHa = mFoInv.multiply(mCorrR.handL).multiply(hwHa).multiply(mCorrR.handR).multiply(mHa);

      return {
        isAligned: true,
        upperArm: [alUp.x, alUp.y, alUp.z, alUp.w],
        forearm: [alFo.x, alFo.y, alFo.z, alFo.w],
        hand: [alHa.x, alHa.y, alHa.z, alHa.w]
      };
    };

    const processedRight = processArm(frameData?.imuQuat, modelAlignRight, {
      upper: mc.upperR, forearmL: mc.forearmRL, forearmR: mc.forearmRR, handL: mc.handRL, handR: mc.handRR
    }, tareUpperRRef, 'right') || { ...fallbackPalmR };

    const processedLeft = processArm(frameData?.leftImuQuat, modelAlignLeft, {
      upper: mc.upperL, forearmL: mc.forearmLL, forearmR: mc.forearmLR, handL: mc.handLL, handR: mc.handLR
    }, tareUpperLRef, 'left') || { ...fallbackPalmL };

    processedRight.manualOverrides = manualArmsEnable.right;
    processedRight.manualValues = defaultPalmR;
    processedLeft.manualOverrides = manualArmsEnable.left;
    processedLeft.manualValues = defaultPalmL;

    rig.right.palm = processedRight;
    rig.left.palm = processedLeft;

    return rig;
  }, [modelAlignRight, modelAlignLeft, isCalibrated, manualFingersEnable, manualArmsEnable, manualFingers, manualThumbExtra, manualRightArm, manualLeftArm]);

  const rigFrame = useMemo(() => computeRigFromFrame(currentFrame), [computeRigFromFrame, currentFrame]);
  latestRigDataRef.current = rigFrame;
  const [user, setUser] = useState(null);
  const [userId, setUserId] = useState(null);
  const [userEmail, setUserEmail] = useState(null);
  const [loading, setLoading] = useState(false);
  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001/api';
  // Calibration ref – set to true to trigger reset inside HandModel
  const calibrateRef = useRef(false);

  // Main Tab State
  const [mainTab, setMainTab] = useState('exo');

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [signLabel, setSignLabel] = useState('');
  const [signInput, setSignInput] = useState('');
  const [trimRange, setTrimRange] = useState([0, 100]);

  const [restRotationR, setRestRotationR] = useState([-0.96, -3.15, -3.15]);
  const [restRotationL, setRestRotationL] = useState([-0.99, -3.15, -3.15]);
  const [tunerOpen, setTunerOpen] = useState(true);



  // Biomechanical constraint limits
  const [wristLimits, setWristLimits] = useState({ ...DEFAULT_WRIST_LIMITS });
  const [armLimits, setArmLimits] = useState({
    upper: { ...DEFAULT_ARM_LIMITS.upper },
    forearm: { ...DEFAULT_ARM_LIMITS.forearm }
  });
  const [fingerLimits, setFingerLimits] = useState(() => JSON.parse(JSON.stringify(BIOMECHANICAL_LIMITS)));
  const [bioFingerTab, setBioFingerTab] = useState('index');
  const [bioOpen, setBioOpen] = useState(false);

  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [calError, setCalError] = useState(null);
  const [couplingByFinger, setCouplingByFinger] = useState(() =>
    Array.from({ length: 5 }, (_, fi) => fi === 4 ? [0, 0, 0, 0, 0, 0] : [0, 0, 0, 0])
  );
  const [couplingInput, setCouplingInput] = useState('0,0,0,0');
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
  const [calHand, setCalHand] = useState('right');
  const calHandRef = useRef('right');
  useEffect(() => { calHandRef.current = calHand; }, [calHand]);
  const activeChannelMap = useMemo(() => getHandChannelMap(calHand), [calHand]);
  const activeFingerDefaults = activeChannelMap.fingerDefaults;
  const activeChannelLabels = activeChannelMap.labels;

  // Load offline arm pose from local storage
  useEffect(() => {
    try {
      const savedRight = localStorage.getItem('esl_glove_offline_right');
      const savedLeft = localStorage.getItem('esl_glove_offline_left');
      if (savedRight) setManualRightArm(JSON.parse(savedRight));
      if (savedLeft) setManualLeftArm(JSON.parse(savedLeft));
    } catch (e) {
      console.warn('Could not parse offline arm pose from localStorage');
    }
  }, []);

  // New: knot sanity warnings
  const [sanityWarnings, setSanityWarnings] = useState([]);
  // New: NVS load banner
  const [nvsBannerVisible, setNvsBannerVisible] = useState(false);
  // New: selected finger for coupling panel
  const [couplingFinger, setCouplingFinger] = useState(0);
  // New: calibration panel active tab
  const [calTab, setCalTab] = useState('voltages'); // 'voltages' | 'knots' | 'coupling' | 'manage'
  const [calMainTab, setCalMainTab] = useState('exo'); // 'exo' | 'imu'

  // Dynamic calibration state
  const [dynCalRecording, setDynCalRecording] = useState(false);
  const [dynCalCountdown, setDynCalCountdown] = useState(0);
  const [dynCalDuration, setDynCalDuration] = useState(8); // seconds to record
  const dynCalSamplesRef = useRef([]); // [{ch0, ch1, ...ch15}]

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
  const axisAvailable = activeFingerDefaults[calFinger][calAxis] !== -1;
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

  const takeMedianSamples = useCallback(async (durationMs = 800) => {
    const samples = [];
    const endTime = Date.now() + durationMs;
    while (Date.now() < endTime) {
      const handKey = calHandRef.current === 'left' ? 'left' : 'right';
      const v = rawVoltagesByHandRef.current?.[handKey] ?? gloveFrame.rawVoltagesRef?.current;
      if (Array.isArray(v) && v.every(val => val !== null)) {
        samples.push([...v]);
      }
      await sleep(20);
    }
    if (samples.length === 0) throw new Error('No raw voltage samples received.');

    const medians = new Array(16);
    for (let ch = 0; ch < 16; ch++) {
      const chValues = samples.map(s => s[ch]).filter(Number.isFinite).sort((a, b) => a - b);
      if (chValues.length === 0) {
        medians[ch] = null;
      } else {
        const mid = Math.floor(chValues.length / 2);
        const midVal = chValues.length % 2 !== 0 ? chValues[mid] : (chValues[mid - 1] + chValues[mid]) / 2;
        medians[ch] = midVal;
      }
    }
    return medians;
  }, [gloveFrame.rawVoltagesRef]);

  const sendCommandWsRef = useRef(gloveFrame?.sendCommand);
  useEffect(() => { sendCommandWsRef.current = gloveFrame?.sendCommand; }, [gloveFrame?.sendCommand]);

  const sendCommandUnified = useCallback(async (cmdId, payload) => {
    if (sendCommandWsRef.current) sendCommandWsRef.current(cmdId, payload, calHandRef.current === 'left');
  }, []);

  const runCommand = useCallback(async (cmdId, payload) => {
    try {
      setCalError(null);
      await sendCommandUnified(cmdId, payload);
    } catch (err) {
      setCalError(err?.message || 'Command failed');
    }
  }, [sendCommandUnified]);

  const [magEnabled, setMagEnabled] = useState(true);

  const toggleMagUsage = useCallback(async () => {
    const newState = !magEnabled;
    setMagEnabled(newState);
    await runCommand(CMD.SET_MAG_USAGE, new Uint8Array([newState ? 1 : 0]));
  }, [magEnabled, runCommand]);

  const requestRawVoltages = useCallback(async () => {
    await sendCommandUnified(CMD.REQUEST_RAW);
    return waitForRawVoltages(500);
  }, [sendCommandUnified, waitForRawVoltages]);

  // Sanity-check 5 captured knots; returns array of warning strings
  const checkKnotSanity = (knots) => {
    const warnings = [];
    const valid = knots.filter(k => Number.isFinite(k));
    if (valid.length < 5) return warnings;
    if (valid.some(v => v < VOLTAGE_MIN_VALID || v > VOLTAGE_MAX_VALID)) {
      warnings.push(`⚠ Voltage outside valid range (${VOLTAGE_MIN_VALID}–${VOLTAGE_MAX_VALID}V). Sensor may be disconnected or out of ADS range.`);
    }
    const span = Math.max(...valid) - Math.min(...valid);
    if (span < SENSOR_MIN_SPAN) {
      warnings.push(`⚠ Total voltage span is only ${span.toFixed(3)}V (expected ≥ ${SENSOR_MIN_SPAN}V). Sensor may have no usable range.`);
    }
    let inc = 0, dec = 0;
    for (let i = 1; i < knots.length; i++) {
      if (knots[i] > knots[i - 1]) inc++;
      if (knots[i] < knots[i - 1]) dec++;
    }
    if (inc > 0 && dec > 0) {
      warnings.push('⚠ Knots are not monotonically ordered — some positions may be out of sequence. Consider re-capturing.');
    } else if (dec === 4) {
      warnings.push('ℹ Sensor reads in reverse direction (high voltage = straight). This is fine — firmware handles inverted sensors.');
    }
    return warnings;
  };

  // Capture current live-stream voltage using median over 800ms
  const captureStep = useCallback(async () => {
    if (captureBusy || !axisAvailable) return;
    const stepIdx = axisKnots.findIndex((val) => !Number.isFinite(val));
    if (stepIdx === -1) return;
    const sensorIdx = activeFingerDefaults[calFinger][calAxis];
    if (sensorIdx === -1) { setCalError('Selected axis is not available for this finger.'); return; }

    setCaptureBusy(true);
    try {
      setCalError(null);
      const medians = await takeMedianSamples(800);
      const voltage = medians[sensorIdx];

      if (!Number.isFinite(voltage)) {
        setCalError('No live voltage reading yet — ensure glove is connected and streaming.');
        return;
      }

      setKnotsByAxis(prev => {
        const next = prev.map(fa => fa.map(ax => [...ax]));
        next[calFinger][calAxis][stepIdx] = voltage;
        if (stepIdx === 4) {
          const finalKnots = [...next[calFinger][calAxis]];
          finalKnots[4] = voltage;
          setSanityWarnings(checkKnotSanity(finalKnots));
        }
        return next;
      });
    } catch (err) {
      setCalError(err.message);
    } finally {
      setCaptureBusy(false);
    }
  }, [captureBusy, axisAvailable, axisKnots, calFinger, calAxis, takeMedianSamples, activeFingerDefaults]);

  const resetAxis = useCallback(() => {
    setKnotsByAxis(prev => {
      const next = prev.map(fingerAxes => fingerAxes.map(axis => [...axis]));
      next[calFinger][calAxis] = Array(5).fill(null);
      return next;
    });
    setSanityWarnings([]);
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

  // Send coupling coefficients from slider state
  const sendCouplingSliders = useCallback(async (fingerIdx) => {
    try {
      setCalError(null);
      const payload = buildCouplingPayload(fingerIdx, couplingByFinger[fingerIdx]);
      await sendCommandUnified(CMD.SET_COUPLING, payload);
    } catch (err) {
      setCalError(err?.message || 'Failed to send coupling');
    }
  }, [couplingByFinger, sendCommandUnified]);

  // Legacy text-input coupling send (kept for DEV backward compat)
  const sendCoupling = useCallback(async () => {
    const parts = couplingInput.split(',').map(val => parseFloat(val.trim())).filter(val => Number.isFinite(val));
    const expectedLen = calFinger === 4 ? 6 : 4;
    if (parts.length < expectedLen) { setCalError(`Provide ${expectedLen} comma-separated coupling values.`); return; }
    try {
      setCalError(null);
      const payload = buildCouplingPayload(calFinger, parts.slice(0, expectedLen));
      await sendCommandUnified(CMD.SET_COUPLING, payload);
    } catch (err) {
      setCalError(err?.message || 'Failed to send coupling');
    }
  }, [calFinger, couplingInput, sendCommandUnified]);



  // Export calibration JSON
  const handleExportCal = useCallback(() => {
    const cal = {
      version: 1,
      exportedAt: new Date().toISOString(),
      fingers: CAL_FINGER_NAMES.map((name, fi) => ({
        name,
        knots: {
          yaw: knotsByAxis[fi][0].map(v => Number.isFinite(v) ? v : null),
          pitch1: knotsByAxis[fi][1].map(v => Number.isFinite(v) ? v : null),
          pitch2: knotsByAxis[fi][2].map(v => Number.isFinite(v) ? v : null),
          ...(fi === 4 ? { thumbIP: knotsByAxis[fi][3].map(v => Number.isFinite(v) ? v : null) } : {}),
        },
        coupling: couplingByFinger[fi],
      })),
    };
    const blob = new Blob([JSON.stringify(cal, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `glove-cal-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [knotsByAxis, couplingByFinger]);

  // Import calibration JSON: load state + send all CMD 0x10 / 0x11 to device
  const importInputRef = useRef(null);
  const handleImportCal = useCallback(async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const cal = JSON.parse(text);
      if (!cal.version || !Array.isArray(cal.fingers)) throw new Error('Invalid calibration file.');
      const newKnots = Array.from({ length: 5 }, (_, fi) =>
        Array.from({ length: 4 }, (_, ai) => {
          const key = ['yaw', 'pitch1', 'pitch2', 'thumbIP'][ai];
          const k = cal.fingers[fi]?.knots?.[key];
          return Array.isArray(k) ? k.map(v => (typeof v === 'number' ? v : null)) : Array(5).fill(null);
        })
      );
      const newCoupling = Array.from({ length: 5 }, (_, fi) => cal.fingers[fi]?.coupling ?? (fi === 4 ? [0, 0, 0, 0, 0, 0] : [0, 0, 0, 0]));
      setKnotsByAxis(newKnots);
      setCouplingByFinger(newCoupling);
      // Send to device
      for (let fi = 0; fi < 5; fi++) {
        for (let ai = 0; ai < 4; ai++) {
          if (activeFingerDefaults[fi][ai] === -1) continue;
          if (!newKnots[fi][ai].every(v => Number.isFinite(v))) continue;
          await sendCommandUnified(CMD.SET_KNOTS, buildKnotsPayload(fi, ai, newKnots[fi][ai]));
          await sleep(20);
        }
        await sendCommandUnified(CMD.SET_COUPLING, buildCouplingPayload(fi, newCoupling[fi]));
        await sleep(20);
      }
      setCalError(null);
    } catch (err) {
      setCalError(`Import failed: ${err.message}`);
    }
    e.target.value = '';
  }, [sendCommandUnified, activeFingerDefaults]);

  // Load cal from NVS with banner + raw refresh
  const handleLoadCalNVS = useCallback(async () => {
    await runCommand(CMD.LOAD_CAL);
    setNvsBannerVisible(true);
    // Trigger raw voltages refresh after device reloads cal
    setTimeout(async () => { await sendCommandUnified(CMD.REQUEST_RAW); }, 600);
    setTimeout(() => setNvsBannerVisible(false), 10000);
  }, [runCommand, sendCommandUnified]);




  /**
   * Dynamic Global Calibration
   * Polls raw voltages for `dynCalDuration` seconds, then derives 5 knot-points
   * for every sensor channel by linearly spacing between observed min and max.
   * Sends SET_KNOTS for all 16 axes (finger×axis combos) in one batch.
   */
  const startDynamicCal = useCallback(async () => {
    if (dynCalRecording || captureBusy) return;
    setDynCalRecording(true);
    setCalError(null);
    dynCalSamplesRef.current = [];
    const durationMs = dynCalDuration * 1000;
    const pollIntervalMs = 80; // ~12 Hz polling
    const endTime = Date.now() + durationMs;

    // Countdown timer display
    const countdownInterval = setInterval(() => {
      const remaining = Math.ceil((endTime - Date.now()) / 1000);
      setDynCalCountdown(Math.max(0, remaining));
    }, 200);

    try {
      while (Date.now() < endTime) {
        try {
          await sendCommandUnified(CMD.REQUEST_RAW);
          const voltages = await waitForRawVoltages(300);
          if (Array.isArray(voltages) && voltages.length === 16) {
            dynCalSamplesRef.current.push(voltages);
          }
        } catch {
          // tolerate individual timeouts — keep polling
        }
        await sleep(pollIntervalMs);
      }

      const samples = dynCalSamplesRef.current;
      if (samples.length < 5) {
        setCalError(`Only ${samples.length} samples captured — check glove connection.`);
        return;
      }

      // Compute per-channel min/max across all samples
      const mins = Array(16).fill(Infinity);
      const maxs = Array(16).fill(-Infinity);
      for (const reading of samples) {
        for (let ch = 0; ch < 16; ch++) {
          if (Number.isFinite(reading[ch])) {
            if (reading[ch] < mins[ch]) mins[ch] = reading[ch];
            if (reading[ch] > maxs[ch]) maxs[ch] = reading[ch];
          }
        }
      }

      // Build 5 knots for each channel: interpolate min→max at 0%,25%,50%,75%,100%
      const channelKnots = Array.from({ length: 16 }, (_, ch) => {
        const lo = mins[ch];
        const hi = maxs[ch];
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return null;
        return [0, 0.25, 0.5, 0.75, 1].map(t => lo + t * (hi - lo));
      });

      // activeFingerDefaults[finger][axis] = channel index (-1 = N/A)
      let sentCount = 0;
      for (let finger = 0; finger < 5; finger++) {
        for (let axis = 0; axis < 4; axis++) {
          const ch = activeFingerDefaults[finger][axis];
          if (ch === -1) continue;
          const knots = channelKnots[ch];
          if (!knots) continue;
          const payload = buildKnotsPayload(finger, axis, knots);
          await sendCommandUnified(CMD.SET_KNOTS, payload);
          await sleep(20); // brief gap between WS sends
          sentCount++;
        }
      }

      // Persist to NVS
      await sendCommandUnified(CMD.SAVE_CAL);
      setCalError(null);
      // Surface computed knots into UI state for visual confirmation
      setKnotsByAxis(prev => {
        const next = prev.map(fa => fa.map(ax => [...ax]));
        for (let f = 0; f < 5; f++) {
          for (let a = 0; a < 4; a++) {
            const ch = activeFingerDefaults[f][a];
            if (ch === -1) continue;
            const k = channelKnots[ch];
            if (k) next[f][a] = k;
          }
        }
        return next;
      });
    } catch (err) {
      setCalError(err?.message || 'Dynamic calibration failed');
    } finally {
      clearInterval(countdownInterval);
      setDynCalRecording(false);
      setDynCalCountdown(0);
    }
  }, [dynCalRecording, captureBusy, dynCalDuration, sendCommandUnified, waitForRawVoltages, activeFingerDefaults]);

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
    if (activeFingerDefaults[calFinger][calAxis] === -1) {
      setCalAxis(0);
    }
  }, [calFinger, calAxis, activeFingerDefaults]);

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
      frames: trimmedFrames.map(f => {
        // Recompute the visual rig data for this frame
        const rig = computeRigFromFrame(f);

        const getWXYZ = (qArr) => {
          if (!qArr || qArr.length !== 4 || qArr.some(isNaN)) return [1.0, 0.0, 0.0, 0.0];
          return [qArr[3], qArr[0], qArr[1], qArr[2]]; // Convert [x,y,z,w] to [w,x,y,z]
        };

        const rPalm = rig?.right?.palm || {};
        const lPalm = rig?.left?.palm || {};

        const flat56_calibrated = [
          ...(f.fingers || Array(16).fill(0)),
          ...getWXYZ(rPalm.hand),
          ...getWXYZ(rPalm.forearm),
          ...getWXYZ(rPalm.upperArm),
          ...(f.leftFingerAnglesFlat || Array(16).fill(0)),
          ...getWXYZ(lPalm.hand),
          ...getWXYZ(lPalm.forearm),
          ...getWXYZ(lPalm.upperArm),
        ];

        return [f.timestamp, ...flat56_calibrated];
      }),
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
        .calib-btn { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
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
              <h1 style={s.title}>Glove Data Studio</h1>
              <p style={s.subtitle}>Capture hand gesture sequences for your submission</p>
            </div>
          </div>

          {/* Live 3-D preview */}
          <div style={s.viewport}>
            <div style={s.viewportLabel}>LIVE PREVIEW</div>
            <Scene
              //rigData={rigFrame}
              rigDataRef = {latestRigDataRef}
              restRotationR={restRotationR}
              restRotationL={restRotationL}
              wristLimits={wristLimits}
              armLimits={armLimits}
              fingerLimits={fingerLimits}
              //onRestPosesLoaded={(poses) => { restPosesRef.current = poses; }}
              onRestPosesLoaded={handleRestPosesLoaded}
            />
            {!currentFrame && (
              <div style={s.viewportOverlay}>
                <p style={s.viewportHint}>Waiting for glove connection…</p>
              </div>
            )}
          </div>

          {/* Control row: always-visible buttons */}
          <div style={s.controlRow}>
            {/* Tare IMU — always visible, primary action */}
            <button
              className="calib-btn"
              style={{ ...s.calibBtn, background: 'rgba(96,165,250,0.08)', color: '#60a5fa', borderColor: 'rgba(96,165,250,0.25)' }}
              onClick={() => runCommand(CMD.TARE_IMU)}
              disabled={!isConnected}
              title="Put your hand flat, then click to set the zero orientation."
            >
              Set Zero Point
            </button>
            {/* Calibrate toggle */}
            <button
              className="calib-btn"
              style={s.calibBtn}
              onClick={() => setCalibrationOpen(o => !o)}
            >
              Calibrate
            </button>
            {/* Reconnect button */}
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

          {/* Main Tab Switcher */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
            <button
              onClick={() => setMainTab('exo')}
              style={{
                flex: 1, padding: '12px', borderRadius: 12, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                background: mainTab === 'exo' ? 'rgba(226,185,111,0.15)' : 'rgba(255,255,255,0.04)',
                color: mainTab === 'exo' ? '#e2b96f' : '#718096',
                border: `1px solid ${mainTab === 'exo' ? 'rgba(226,185,111,0.35)' : 'rgba(255,255,255,0.08)'}`,
                transition: 'all 0.2s'
              }}
            >
              🦾 Exoskeleton Data
            </button>
            <button
              onClick={() => setMainTab('imu')}
              style={{
                flex: 1, padding: '12px', borderRadius: 12, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                background: mainTab === 'imu' ? 'rgba(96,165,250,0.15)' : 'rgba(255,255,255,0.04)',
                color: mainTab === 'imu' ? '#60a5fa' : '#718096',
                border: `1px solid ${mainTab === 'imu' ? 'rgba(96,165,250,0.35)' : 'rgba(255,255,255,0.08)'}`,
                transition: 'all 0.2s'
              }}
            >
              📡 IMU Data
            </button>
            <button
              onClick={() => setMainTab('cal')}
              style={{
                flex: 1, padding: '12px', borderRadius: 12, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans', sans-serif",
                background: mainTab === 'cal' ? 'rgba(52,211,153,0.15)' : 'rgba(255,255,255,0.04)',
                color: mainTab === 'cal' ? '#34d399' : '#718096',
                border: `1px solid ${mainTab === 'cal' ? 'rgba(52,211,153,0.35)' : 'rgba(255,255,255,0.08)'}`,
                transition: 'all 0.2s'
              }}
            >
              ⚙ Calibration
            </button>
          </div>

          {mainTab === 'exo' && (
            <>
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
            </>
          )}

          {mainTab === 'cal' && (
            <>
              {/* Cal Main Tabs */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
                <button
                  onClick={() => setCalMainTab('exo')}
                  style={{
                    flex: 1, padding: '10px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
                    background: calMainTab === 'exo' ? 'rgba(226,185,111,0.15)' : 'rgba(255,255,255,0.04)',
                    color: calMainTab === 'exo' ? '#e2b96f' : '#718096',
                  }}
                >🦾 Exoskeleton Calibration</button>
                <button
                  onClick={() => setCalMainTab('imu')}
                  style={{
                    flex: 1, padding: '10px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
                    background: calMainTab === 'imu' ? 'rgba(96,165,250,0.15)' : 'rgba(255,255,255,0.04)',
                    color: calMainTab === 'imu' ? '#60a5fa' : '#718096',
                  }}
                >📡 IMU Calibration</button>
              </div>

              {/* Hand Toggle */}
              <div style={{ display: 'flex', gap: 8, marginTop: 0, marginBottom: 16, background: 'rgba(0,0,0,0.2)', padding: '6px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                {['right', 'left'].map(hand => (
                  <button
                    key={hand}
                    onClick={() => setCalHand(hand)}
                    style={{
                      flex: 1, padding: '6px 0', fontSize: 11, fontWeight: 'bold', borderRadius: '6px', border: 'none', cursor: 'pointer',
                      background: calHand === hand ? '#60a5fa' : 'transparent',
                      color: calHand === hand ? '#000' : '#a0aec0',
                      textTransform: 'uppercase',
                    }}
                  >
                    {hand} Hand
                  </button>
                ))}
              </div>

              {calMainTab === 'exo' && (
                <div style={s.panel}>
                  <div style={s.panelHeader}>
                    <h3 style={s.panelTitle}>⚙ Exoskeleton Calibration</h3>
                    <p style={s.panelSub}>Guide the glove through its full calibration workflow</p>
                  </div>

                  {calError && <div style={s.calError}>{calError}</div>}

                  {/* NVS load banner */}
                  {nvsBannerVisible && (
                    <div style={{ padding: '10px 12px', marginBottom: 12, background: 'rgba(96,165,250,0.10)', border: '1px solid rgba(96,165,250,0.30)', borderRadius: 10, fontSize: 11, color: '#60a5fa' }}>
                      ℹ Calibration loaded from device — voltage knots are not shown here (firmware does not send readback). Angle outputs will be correct.
                    </div>
                  )}

                  {/* Cal Status inline */}
                  <CalStatusStrip calStatus={calHand === 'left' ? (currentFrame?.leftCalStatus ?? 0) : (currentFrame?.calStatus ?? 0)} knotsByAxis={knotsByAxis} fingerDefaults={activeFingerDefaults} />


                  {/* Tab navigation */}
                  <div style={{ display: 'flex', gap: 4, marginTop: 14, marginBottom: 2, borderBottom: '1px solid rgba(255,255,255,0.07)', paddingBottom: 0 }}>
                    {[['voltages', 'Voltages'], ['knots', 'Knot Wizard'], ['coupling', 'Coupling'], ['manage', 'Manage']].map(([tab, label]) => (
                      <button key={tab} onClick={() => setCalTab(tab)}
                        style={{
                          padding: '7px 12px', fontSize: 11, fontWeight: 600, borderRadius: '8px 8px 0 0', cursor: 'pointer', border: 'none', fontFamily: "'DM Sans', sans-serif",
                          background: calTab === tab ? 'rgba(226,185,111,0.12)' : 'transparent',
                          color: calTab === tab ? '#e2b96f' : '#718096',
                          borderBottom: calTab === tab ? '2px solid #e2b96f' : '2px solid transparent',
                        }}>{label}</button>
                    ))}
                  </div>

                  {/* ── TAB: VOLTAGES ── */}
                  {calTab === 'voltages' && (
                    <div style={{ marginTop: 12 }}>
                      <LiveVoltageMonitor voltages={rawVoltages} sensorHealth={sensorHealth} labels={activeChannelLabels} />
                    </div>
                  )}

                  {/* ── TAB: KNOT WIZARD ── */}
                  {calTab === 'knots' && (
                    <div style={{ marginTop: 12 }}>
                      {/* Dynamic Global Cal */}
                      <div style={s.calSection}>
                        <div style={s.calSectionTitle}>⚡ Dynamic Calibration (all fingers at once)</div>
                        <p style={s.calHint}>Open and close your hand slowly — spread and curl all fingers. System records all 16 sensors simultaneously.</p>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                          <label style={s.calLabel}>Duration (s)</label>
                          <input type="number" min="3" max="30" step="1"
                            style={{ ...s.calInput, width: 60 }} value={dynCalDuration}
                            onChange={e => setDynCalDuration(Math.max(3, parseInt(e.target.value, 10) || 8))}
                            disabled={dynCalRecording} />
                        </div>
                        <button style={{
                          ...s.calBtn, width: '100%', padding: '10px', fontSize: 13,
                          background: dynCalRecording ? 'rgba(239,68,68,0.15)' : 'rgba(52,211,153,0.12)',
                          color: dynCalRecording ? '#ef4444' : '#34d399',
                          borderColor: dynCalRecording ? 'rgba(239,68,68,0.30)' : 'rgba(52,211,153,0.30)'
                        }}
                          onClick={startDynamicCal} disabled={!isConnected || dynCalRecording || captureBusy}>
                          {dynCalRecording ? `Recording… ${dynCalCountdown}s remaining` : 'Start Dynamic Calibration'}
                        </button>
                      </div>

                      {/* Step-by-step Wizard */}
                      <div style={s.calSection}>
                        <div style={s.calSectionTitle}>Step-by-Step Axis Wizard</div>
                        <div style={s.calRow}>
                          <label style={s.calLabel}>Finger</label>
                          <select style={s.calSelect} value={calFinger} onChange={e => { setCalFinger(parseInt(e.target.value, 10)); setSanityWarnings([]); }}>
                            {CAL_FINGER_NAMES.map((name, idx) => <option key={name} value={idx}>{name}</option>)}
                          </select>
                          <label style={s.calLabel}>Axis</label>
                          <select style={s.calSelect} value={calAxis} onChange={e => { setCalAxis(parseInt(e.target.value, 10)); setSanityWarnings([]); }}>
                            {CAL_AXIS_NAMES.map((name, idx) => (
                              <option key={name} value={idx} disabled={activeFingerDefaults[calFinger][idx] === -1}>{name}</option>
                            ))}
                          </select>
                        </div>
                        {/* Live voltage for this axis */}
                        {axisAvailable && (() => {
                          const sensorIdx = activeFingerDefaults[calFinger][calAxis];
                          const liveV = rawVoltages[sensorIdx];
                          return (
                            <div style={{ marginBottom: 8, padding: '6px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, fontSize: 11, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ color: '#718096' }}>ch{sensorIdx} live voltage:</span>
                              <span style={{ color: voltageToColor(liveV), fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                                {Number.isFinite(liveV) ? `${liveV.toFixed(3)} V` : '---'}
                              </span>
                            </div>
                          );
                        })()}
                        {/* Sanity warnings */}
                        {sanityWarnings.length > 0 && (
                          <div style={{ marginBottom: 10, padding: '10px 12px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.30)', borderRadius: 10 }}>
                            {sanityWarnings.map((w, i) => <div key={i} style={{ fontSize: 11, color: w.startsWith('ℹ') ? '#60a5fa' : '#ef4444', marginBottom: i < sanityWarnings.length - 1 ? 4 : 0 }}>{w}</div>)}
                          </div>
                        )}
                        {/* Steps */}
                        <div style={s.calSteps}>
                          {CALIBRATION_STEPS.map((step, idx) => {
                            const value = axisKnots[idx];
                            const done = Number.isFinite(value);
                            const active = idx === nextStepIdx;
                            return (
                              <div key={step.pct} style={{ ...s.calStep, ...(done ? s.calStepDone : null), ...(active ? s.calStepActive : null) }}>
                                <span>{step.label}</span>
                                <span>{done ? `${value.toFixed(3)}V` : (active ? '← next' : '---')}</span>
                              </div>
                            );
                          })}
                        </div>
                        {nextStepIdx !== -1 && <p style={s.calHint}>Hold <strong>{CAL_FINGER_NAMES[calFinger]} {CAL_AXIS_NAMES[calAxis]}</strong> at <strong>{CALIBRATION_STEPS[nextStepIdx]?.pct}%</strong> then press Capture.</p>}
                        <div style={s.calRow}>
                          <button style={s.calBtn} onClick={captureStep}
                            disabled={!isConnected || !axisAvailable || nextStepIdx === -1}>
                            Capture
                          </button>
                          <button style={s.calBtnSecondary} onClick={resetAxis}>Reset</button>
                          <button style={{ ...s.calBtn, opacity: axisComplete ? 1 : 0.5 }} onClick={sendKnots} disabled={!isConnected || !axisComplete}>
                            Send Knots
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── TAB: COUPLING ── */}
                  {calTab === 'coupling' && (
                    <div style={{ marginTop: 12 }}>
                      <div style={s.calSection}>
                        <div style={s.calSectionTitle}>🔗 Cross-Axis Coupling Compensation</div>
                        <p style={s.calHint}>Compensates for magnetic interference between adjacent sensors. Set all 4 coefficients per finger then Apply.</p>
                        <CouplingCalibrationUI
                          couplingByFinger={couplingByFinger}
                          setCouplingByFinger={setCouplingByFinger}
                          couplingFinger={couplingFinger}
                          setCouplingFinger={setCouplingFinger}
                          onApply={sendCouplingSliders}
                          isConnected={isConnected}
                          takeMedianSamples={takeMedianSamples}
                          setCalError={setCalError}
                          fingerDefaults={activeFingerDefaults}
                        />
                      </div>
                    </div>
                  )}

                  {/* ── TAB: MANAGE ── */}
                  {calTab === 'manage' && (
                    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {/* IMU Commands */}
                      <div style={s.calSection}>
                        <div style={s.calSectionTitle}>🧭 IMU Commands</div>
                        <div style={s.calRow}>
                          <button style={s.calBtnSecondary} onClick={() => runCommand(CMD.START_BOOT_CAL)} disabled={!isConnected}>Boot Cal</button>
                          <button style={s.calBtnSecondary} onClick={() => runCommand(CMD.START_MAG_CAL)} disabled={!isConnected}>Mag Cal</button>
                          <button style={s.calBtnSecondary} onClick={() => runCommand(CMD.END_MAG_CAL)} disabled={!isConnected}>End Mag</button>
                        </div>
                      </div>
                      {/* NVS Save/Load */}
                      <div style={s.calSection}>
                        <div style={s.calSectionTitle}>NVS Flash</div>
                        <div style={s.calRow}>
                          <button style={{ ...s.calBtn, flex: 1 }} onClick={() => runCommand(CMD.SAVE_CAL)} disabled={!isConnected}>Save to Flash</button>
                          <button style={{ ...s.calBtnSecondary, flex: 1 }} onClick={handleLoadCalNVS} disabled={!isConnected}>Load from Flash</button>
                        </div>
                      </div>
                      {/* Export / Import */}
                      <div style={s.calSection}>
                        <div style={s.calSectionTitle}>Export / Import JSON</div>
                        <div style={s.calRow}>
                          <button style={{ ...s.calBtn, flex: 1 }} onClick={handleExportCal}>Export Cal JSON</button>
                          <button style={{ ...s.calBtnSecondary, flex: 1 }} onClick={() => importInputRef.current?.click()}>Import Cal JSON</button>
                          <input ref={importInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleImportCal} />
                        </div>
                        <p style={s.calHint}>JSON includes all knots and coupling coefficients. Import sends CMD 0x10 and 0x11 for all axes automatically.</p>
                      </div>
                      {/* Connection Settings */}
                      <div style={s.calSection}>
                        <div style={s.calSectionTitle}>🌐 Connection Settings</div>
                        <p style={s.calHint}>Set the WebSocket IP address of the Master ESP32.</p>
                        <div style={s.calRow}>
                          <label style={s.calLabel}>IP Address</label>
                          <input
                            type="text"
                            style={{ ...s.calInput, flex: 1 }}
                            value={ipInput}
                            onChange={e => setIpInput(e.target.value)}
                            placeholder="e.g. 192.168.1.8"
                          />
                          <button style={s.calBtn} onClick={handleApplyIp}>
                            Connect
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}


              {calMainTab === 'imu' && (
                <div style={s.panel}>
                  <div style={s.panelHeader}>
                    <h3 style={s.panelTitle}>🧭 IMU Pipeline</h3>
                    <p style={s.panelSub}>Step-by-step Mahony filter initialization</p>
                  </div>
                  {calError && <div style={s.calError}>{calError}</div>}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 12 }}>

                    <AxisMappingWidget hand={calHand} />
                    <AlignmentPanel modelAlign={calHand === 'left' ? modelAlignLeft : modelAlignRight} setModelAlign={calHand === 'left' ? setModelAlignLeft : setModelAlignRight} onCalibrate={calibrateMountOffsets} onTare={tareHeading} />

                    <div style={s.calSection}>
                      <div style={s.calSectionTitle}>1. Boot Calibration</div>
                      <p style={s.calHint}>Resets the filters and captures resting gyro biases. Keep arm still for 2 seconds.</p>
                      <button style={{ ...s.calBtnSecondary, width: '100%' }} onClick={() => runCommand(CMD.START_BOOT_CAL)} disabled={!isConnected}>
                        Start Boot Calibration
                      </button>
                    </div>

                    <div style={s.calSection}>
                      <div style={s.calSectionTitle}>2. Magnetometer Calibration</div>
                      <p style={s.calHint}>Wave the arm in an aggressive figure-8 pattern to map the local magnetic hard-iron offsets.</p>
                      <div style={s.calRow}>
                        <button style={{ ...s.calBtnSecondary, flex: 1 }} onClick={() => runCommand(CMD.START_MAG_CAL)} disabled={!isConnected}>Start Sweep</button>
                        <button style={{ ...s.calBtnSecondary, flex: 1 }} onClick={() => runCommand(CMD.END_MAG_CAL)} disabled={!isConnected}>Finish & Save</button>
                      </div>
                    </div>

                    <div style={s.calSection}>
                      <div style={s.calSectionTitle}>3. 3-Pose Static Alignment</div>
                      <p style={s.calHint}>Align the coordinate frames by holding 3 distinct poses:<br />
                        Pose 1: Arm straight down at your side, palm facing inward.<br />
                        Pose 2: Arm straight out to the side, palm facing down.<br />
                        Pose 3: Arm straight forward, palm faces inward (to the side).<br />
                        Click Record for each.
                      </p>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <button style={{ ...s.calBtnSecondary, flex: 1 }} onClick={() => runCommand(CMD.START_STATIC_ALIGN)} disabled={!isConnected}>
                          Start Alignment
                        </button>
                        <button style={{ ...s.calBtn, flex: 2, background: (calHand === 'right' ? gloveFrame.imuPoseIdx : gloveFrame.imuPoseIdxL) < 3 ? 'rgba(52,211,153,0.15)' : 'rgba(255,255,255,0.05)' }}
                          onClick={() => {
                            if ((calHand === 'right' ? gloveFrame.imuPoseIdx : gloveFrame.imuPoseIdxL) < 3) {
                              runCommand(CMD.RECORD_STATIC_POSE);
                            }
                          }}
                          disabled={!isConnected || (calHand === 'right' ? gloveFrame.imuPoseIdx : gloveFrame.imuPoseIdxL) >= 3}>
                          Record Pose {(calHand === 'right' ? gloveFrame.imuPoseIdx : gloveFrame.imuPoseIdxL) < 3 ? (calHand === 'right' ? gloveFrame.imuPoseIdx : gloveFrame.imuPoseIdxL) + 1 : 'Complete'}
                        </button>
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <button style={{ ...s.calBtn, flex: 1, borderColor: magEnabled ? '#34d399' : '#ef4444', color: magEnabled ? '#34d399' : '#ef4444' }} onClick={toggleMagUsage} disabled={!isConnected}>
                          Magnetometer Usage: {magEnabled ? 'ENABLED' : 'DISABLED'}
                        </button>
                      </div>
                      <button style={{ ...s.calBtn, width: '100%', borderColor: '#60a5fa', color: '#60a5fa' }} onClick={() => runCommand(CMD.ENTER_RUNNING)} disabled={!isConnected}>
                        Skip to RUNNING State (Quick Test)
                      </button>
                    </div>

                    <div style={{ ...s.calSection, background: '#000', padding: '8px', border: '1px solid #333', overflow: 'hidden' }}>
                      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', marginBottom: 4, letterSpacing: '1px', fontWeight: 'bold' }}>Firmware Logs</div>
                      <div style={{ height: '140px', overflowY: 'auto', display: 'flex', flexDirection: 'column-reverse', fontFamily: 'monospace', fontSize: 11, color: '#a0aec0' }}>
                        {[...(gloveFrame.consoleLogs?.[calHand] || [])].reverse().map((log, idx) => (
                          <div key={idx} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{log.trim()}</div>
                        ))}
                      </div>
                    </div>

                  </div>
                </div>
              )}
            </>
          )}

          {mainTab === 'exo' && (
            <>
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

              {/* DEV-only live sensor panels */}
              {DEV_MODE && <FingerAnglesPanel frame={currentFrame} calStatus={currentFrame?.calStatus ?? 0} />}
              {DEV_MODE && <CalStatusStrip calStatus={currentFrame?.calStatus ?? 0} knotsByAxis={knotsByAxis} fingerDefaults={HAND_CHANNEL_MAPS.right.fingerDefaults} />}
            </>
          )}

          {mainTab === 'imu' && (
            <>
              <IMUDiagnosticsPanel
                diag={currentFrame?.imuDiag ?? null}
                imuQuat={currentFrame?.imuQuat ?? null}
                leftImuQuat={currentFrame?.leftImuQuat ?? null}
                dualImuStatus={currentFrame?.dualImuStatus ?? null}
              />
            </>
          )}

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
          restRotationR={restRotationR}
          restRotationL={restRotationL}
          wristLimits={wristLimits}
          armLimits={armLimits}
          fingerLimits={fingerLimits}
          restPosesRef={restPosesRef}
          computeRigFromFrame={computeRigFromFrame}
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

  body: { flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(340px, 35vw)', gap: '2.5vw', padding: '2.5vw', maxWidth: '96vw', margin: '0 auto', width: '100%' },
  leftCol: { display: 'flex', flexDirection: 'column', gap: '2vw', minWidth: 0 },
  rightCol: { display: 'flex', flexDirection: 'column', gap: '1.6vw', minWidth: 0 },

  titleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  title: { fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 600, color: '#ffffff', marginBottom: 4 },
  subtitle: { fontSize: 13, color: '#718096', fontWeight: 300 },

  viewport: { flex: 1, minHeight: '55vh', height: '60vh', maxHeight: '72vh', background: 'linear-gradient(145deg, #0a0c18, #111827)', borderRadius: 20, border: '1px solid rgba(255,255,255,0.06)', boxShadow: 'inset 0 0 60px rgba(0,0,0,0.4)' },
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

  calSection: { marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)' },
  calSectionTitle: { fontSize: 12, fontWeight: 600, color: '#a0aec0', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.5px' },

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
  trimFill: { position: 'absolute', height: '1%', background: 'linear-gradient(90deg, #0f3460, #e2b96f)', borderRadius: 6 },

  actionRow: { display: 'flex', gap: 12, justifyContent: 'flex-end' },
  discardBtn: { padding: '11px 22px', background: 'rgba(239,68,68,0.06)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.20)', borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background 0.15s, color 0.15s', fontFamily: "'DM Sans', sans-serif" },
  saveSignBtn: { padding: '11px 28px', background: '#059669', color: '#fff', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background 0.2s, transform 0.15s', fontFamily: "'DM Sans', sans-serif" },
};
