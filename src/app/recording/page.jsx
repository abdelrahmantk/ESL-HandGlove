"use client";
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Canvas } from '@react-three/fiber';
import { ArmModel, DEFAULT_WRIST_LIMITS, BIOMECHANICAL_LIMITS } from "../components/ArmModel";
import Image from "next/image";
import logo from "../assets/logo.png";
import { supabase } from "@/lib/supabaseClient";
import { useRouter } from "next/navigation";
import * as THREE from 'three';

// ─── Dev/Production toggle ───────────────────────────────────────────────────
// Set to false before deploying to production to hide all developer UI.
const DEV_MODE = true;

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

const IMU_PACKET_HEADER = 0xAABBCCDD;
const FINGER_PACKET_HEADER = 0xF1F2F3F4;
const DUAL_FINGER_PACKET_HEADER = 0xF1F2F3F5;
const RAW_VOLTAGES_PACKET_HEADER = 0xC0DEC0DE;
const DUAL_RAW_VOLTAGES_PACKET_HEADER = 0xC0DEC0DF;
// Finger packet layout per spec: 4 header + 4 ts + 60 angles + 4 thumbExtra + 1 calStatus = 73
const FINGER_PACKET_MIN_SIZE = 73;
const FINGER_PACKET_OFFSET = 8;   // first angle byte
const FINGER_PACKET_ANGLES = 15;  // 5 fingers × 3 floats
const IMU_PACKET_MIN_SIZE = 90;  // full diagnostic packet
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
const COUPLING_LABELS_STANDARD = ['p2→p1', 'yaw→p1', 'yaw→p2', 'p1→p2'];
const COUPLING_LABELS_THUMB = ['p2→p1', 'yaw→p1', 'yaw→p2', 'p1→p2', 'ip→p1', 'yaw→ip'];

// ch0-15 → finger/axis label (from firmware config.h FINGER_DEFAULTS)
const CH_LABELS = [
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
  'Middle / P1',// ch15
];

const CAL_FINGER_DEFAULTS = [
  [8, 9, 10, -1],   // Pinky:  yaw=ch8,  p1=ch9,  p2=ch10
  [11, 12, 13, -1], // Ring:   yaw=ch11, p1=ch12, p2=ch13
  [0, 15, 14, -1],  // Middle: yaw=ch0,  p1=ch15, p2=ch14
  [1, 2, 3, -1],    // Index:  yaw=ch1,  p1=ch2,  p2=ch3
  [7, 6, 5, 4],     // Thumb:  yaw=ch7,  p1=ch6,  p2=ch5,  ip=ch4
];

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

function ConvertToThreeSpace(q) {
  // Direct pass-through (X=X, Y=Y, Z=Z). If X was right but Y/Z were swapped, this swaps them back!
  return new THREE.Quaternion(q.x, q.y, q.z, q.w).normalize();
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
    imuTimestamp: null,
    fingerTimestamp: null,
    imuDiag: null,
    consoleLogs: [],
    imuPoseIdx: 0,
  });
  const imuQuatRef = useRef(null);
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
        if (typeof event.data === 'string') {
          const logMsg = event.data;
          setGloveState(prev => {
            const newLogs = [...prev.consoleLogs, logMsg].slice(-50); // Keep last 50 logs

            let newPoseIdx = prev.imuPoseIdx;
            const match = logMsg.match(/Recorded Pose (\d+)\/6 successfully/);
            if (match) {
              newPoseIdx = parseInt(match[1], 10);
            }
            if (logMsg.includes("Static 6-poses calibration initialized") || logMsg.includes("Restarting calibration")) {
              newPoseIdx = 0;
            }

            return { ...prev, consoleLogs: newLogs, imuPoseIdx: newPoseIdx };
          });
          return;
        }

        const buffer = event.data instanceof ArrayBuffer
          ? event.data
          : await event.data.arrayBuffer();

        const view = new DataView(buffer);

        if (buffer.byteLength > 0) {
          const cmdByte = view.getUint8(0);
          if (cmdByte === 0x10 && buffer.byteLength >= 23) {
            const fingerIdx = view.getUint8(1);
            const axis = view.getUint8(2);
            const newKnots = new Array(5);
            for (let i = 0; i < 5; i++) {
              newKnots[i] = view.getFloat32(3 + i * 4, true);
            }
            if (onFrame) onFrame({ source: 'config_knots', fingerIdx, axis, newKnots });
            return;
          }
          if (cmdByte === 0x11 && buffer.byteLength >= 18) {
            const fingerIdx = view.getUint8(1);
            const newCoeffs = new Array(4);
            for (let i = 0; i < 4; i++) {
              newCoeffs[i] = view.getFloat32(2 + i * 4, true);
            }
            if (onFrame) onFrame({ source: 'config_coupling', fingerIdx, newCoeffs });
            return;
          }
        }

        const header = view.getUint32(0, true);

        if (header === IMU_PACKET_HEADER) {
          // Minimum: 24 bytes for quaternion; full packet is 90 bytes with diagnostics
          if (view.byteLength < 24) return;
          const timestamp = view.getUint32(4, true);

          // Firmware sends [w, x, y, z] — map to Three.js [x, y, z, w]
          let imuQuat;
          if (view.byteLength >= 56) {
            // New 3-IMU format
            const u_qw = view.getFloat32(8, true);
            const u_qx = view.getFloat32(12, true);
            const u_qy = view.getFloat32(16, true);
            const u_qz = view.getFloat32(20, true);

            const f_qw = view.getFloat32(24, true);
            const f_qx = view.getFloat32(28, true);
            const f_qy = view.getFloat32(32, true);
            const f_qz = view.getFloat32(36, true);

            const h_qw = view.getFloat32(40, true);
            const h_qx = view.getFloat32(44, true);
            const h_qy = view.getFloat32(48, true);
            const h_qz = view.getFloat32(52, true);

            const qU = new THREE.Quaternion(u_qx, u_qy, u_qz, u_qw).normalize();
            const qF = new THREE.Quaternion(f_qx, f_qy, f_qz, f_qw).normalize();
            const qH = new THREE.Quaternion(h_qx, h_qy, h_qz, h_qw).normalize();

            // NaN safety check to prevent 3D model from stretching if filter diverges
            if (isNaN(qU.x) || isNaN(qF.x) || isNaN(qH.x)) return;

            imuQuat = {
              upperArm: [qU.x, qU.y, qU.z, qU.w],
              forearm: [qF.x, qF.y, qF.z, qF.w],
              hand: [qH.x, qH.y, qH.z, qH.w]
            };
          } else {
            // Old 1-IMU format (Hand only)
            const qw = view.getFloat32(8, true);
            const qx = view.getFloat32(12, true);
            const qy = view.getFloat32(16, true);
            const qz = view.getFloat32(20, true);

            const qH = new THREE.Quaternion(qx, qy, qz, qw).normalize();
            imuQuat = { hand: [qH.x, qH.y, qH.z, qH.w] };
          }
          imuQuatRef.current = imuQuat;

          // ── Diagnostic fields ──────────
          let imuDiag = null;
          if (view.byteLength >= 136) {
            // New 136-byte ArmTrackerPacket
            const current_state = view.getUint8(56);
            const accel_mag = [view.getFloat32(57, true), view.getFloat32(61, true), view.getFloat32(65, true)];
            const mag_norm = [view.getFloat32(69, true), view.getFloat32(73, true), view.getFloat32(77, true)];
            const drift_exposure = [view.getFloat32(81, true), view.getFloat32(85, true), view.getFloat32(89, true)];
            const mag_clean = [view.getUint8(93), view.getUint8(94), view.getUint8(95)];
            const ref_accel_mag = [view.getFloat32(96, true), view.getFloat32(100, true), view.getFloat32(104, true)];
            const time_since_good_accel = [view.getFloat32(108, true), view.getFloat32(112, true), view.getFloat32(116, true)];
            const safe_upper_yaw = view.getFloat32(120, true);
            const safe_elbow_pitch = view.getFloat32(124, true);
            const safe_forearm_roll = view.getFloat32(128, true);
            const phone_yaw_correction = view.getFloat32(132, true);

            imuDiag = {
              perImu: {
                upperArm: { accelMag: accel_mag[0], magNorm: mag_norm[0], drift: drift_exposure[0], magClean: mag_clean[0], timeAccel: time_since_good_accel[0] },
                forearm: { accelMag: accel_mag[1], magNorm: mag_norm[1], drift: drift_exposure[1], magClean: mag_clean[1], timeAccel: time_since_good_accel[1] },
                hand: { accelMag: accel_mag[2], magNorm: mag_norm[2], drift: drift_exposure[2], magClean: mag_clean[2], timeAccel: time_since_good_accel[2] }
              },
              currentState: current_state,
              phoneYawCorrection: phone_yaw_correction
            };
          } else if (view.byteLength === 90) {
            // Old 90-byte packet
            imuDiag = {
              timeSinceGoodAccel: view.getFloat32(32, true),  // seconds
              driftExposure: view.getFloat32(36, true),  // seconds of low-accel
              timeSinceGoodMag: view.getFloat32(48, true),  // seconds
              magStability: view.getFloat32(80, true),  // 0.0–1.0 (1.0 = stable)
              useMag: view.getUint8(86) === 1,    // magnetometer active
            };
          }

          setGloveState(prev => ({
            ...prev,
            imuQuat,
            imuTimestamp: timestamp,
            ...(imuDiag ? { imuDiag } : {}),
          }));

          if (onFrame) {
            onFrame({
              source: 'imu',
              fingers: fingerAnglesFlatRef.current,
              fingerAngles: fingerAnglesRef.current,
              imuQuat,
              imuDiag,
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
          // Update sync ref so captureStep can read without polling
          rawVoltagesRef.current = voltages;
          if (onFrame) {
            onFrame({ source: 'raw', voltages, timestamp });
          }
          return;
        }

        if (header === DUAL_RAW_VOLTAGES_PACKET_HEADER) {
          if (view.byteLength < 137) return;
          const timestamp = view.getUint32(4, true);
          const rightVoltages = new Array(16);
          for (let i = 0; i < 16; i += 1) {
            rightVoltages[i] = view.getFloat32(8 + i * 4, true);
          }
          const leftVoltages = new Array(16);
          for (let i = 0; i < 16; i += 1) {
            leftVoltages[i] = view.getFloat32(72 + i * 4, true);
          }
          const leftConnected = view.getUint8(136) === 1;

          if (onFrame) {
            onFrame({ source: 'raw_dual', rightVoltages, leftVoltages, timestamp, leftConnected });
          }
          return;
        }

        if (header === DUAL_FINGER_PACKET_HEADER) {
          if (view.byteLength < 139) return;
          const timestamp = view.getUint32(4, true);

          const rightFingers = [];
          for (let f = 0; f < 5; f += 1) {
            const base = 8 + f * 12;
            rightFingers.push({
              yaw: view.getFloat32(base + 0, true),
              pitch1: view.getFloat32(base + 4, true),
              pitch2: view.getFloat32(base + 8, true),
            });
          }
          const thumbExtra = view.getFloat32(68, true);
          const calStatus = view.getUint8(72);

          const leftFingers = [];
          for (let f = 0; f < 5; f += 1) {
            const base = 73 + f * 12;
            leftFingers.push({
              yaw: view.getFloat32(base + 0, true),
              pitch1: view.getFloat32(base + 4, true),
              pitch2: view.getFloat32(base + 8, true),
            });
          }
          const leftThumbExtra = view.getFloat32(133, true);
          const leftCalStatus = view.getUint8(137);
          const leftConnected = view.getUint8(138) === 1;

          const floats = [...rightFingers.flatMap(f => [f.yaw, f.pitch1, f.pitch2]), thumbExtra];
          const leftFloats = [...leftFingers.flatMap(f => [f.yaw, f.pitch1, f.pitch2]), leftThumbExtra];

          fingerAnglesRef.current = rightFingers;
          fingerAnglesFlatRef.current = floats;
          thumbExtraRef.current = thumbExtra;

          setGloveState(prev => ({
            ...prev,
            fingerAngles: rightFingers,
            fingerAnglesFlat: floats,
            thumbExtra,
            calStatus,
            leftFingerAngles: leftFingers,
            leftFingerAnglesFlat: leftFloats,
            leftThumbExtra,
            leftCalStatus,
            leftConnected,
            fingerTimestamp: timestamp,
          }));

          if (onFrame) {
            onFrame({
              source: 'finger',
              fingers: floats,
              fingerAngles: rightFingers,
              thumbExtra,
              calStatus,
              leftFingerAnglesFlat: leftFloats,
              leftFingerAngles: leftFingers,
              leftThumbExtra,
              leftCalStatus,
              imuQuat: imuQuatRef.current,
              flex: {},
              pads: [],
            });
          }
          return;
        }

        if (header !== FINGER_PACKET_HEADER) return;
        // Spec: 4 header + 4 ts + 60 angles + 4 thumbExtra + 1 calStatus = 73 bytes
        if (view.byteLength < FINGER_PACKET_MIN_SIZE) return;

        const timestamp = view.getUint32(4, true);

        // Read 5 fingers × 3 floats = 15 angle floats starting at byte 8
        const fingers = [];
        for (let f = 0; f < 5; f += 1) {
          const base = FINGER_PACKET_OFFSET + f * 12;  // 3 floats × 4 bytes = 12
          fingers.push({
            yaw: view.getFloat32(base + 0, true),
            pitch1: view.getFloat32(base + 4, true),
            pitch2: view.getFloat32(base + 8, true),
          });
        }

        // thumbExtra at explicit offset 68 (after 5×3 floats = 60 bytes + 8 header)
        const thumbExtra = view.getFloat32(68, true);
        // calStatus bitmask at byte 72: bit0=Pinky, bit1=Ring, bit2=Middle, bit3=Index, bit4=Thumb
        const calStatus = view.getUint8(72);

        // Build flat array [5×3 angles + thumbExtra] for recording
        const floats = [
          ...fingers.flatMap(f => [f.yaw, f.pitch1, f.pitch2]),
          thumbExtra,
        ];

        fingerAnglesRef.current = fingers;
        fingerAnglesFlatRef.current = floats;
        thumbExtraRef.current = thumbExtra;

        setGloveState(prev => ({
          ...prev,
          fingerAngles: fingers,
          fingerAnglesFlat: floats,
          thumbExtra,
          calStatus,
          fingerTimestamp: timestamp,
        }));

        if (onFrame) {
          onFrame({
            source: 'finger',
            fingers: floats,
            fingerAngles: fingers,
            thumbExtra,
            calStatus,
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

function buildChannelKnots(knotsByAxis) {
  const channelKnots = Array.from({ length: 16 }, () => null);
  if (!Array.isArray(knotsByAxis)) return channelKnots;
  for (let finger = 0; finger < CAL_FINGER_DEFAULTS.length; finger += 1) {
    for (let axis = 0; axis < CAL_FINGER_DEFAULTS[finger].length; axis += 1) {
      const ch = CAL_FINGER_DEFAULTS[finger][axis];
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
  //console.log(frame.fingers)
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
function IMUDiagnosticsPanel({ diag, imuQuat }) {
  if (!diag && !imuQuat) return null;

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
    badge: { fontSize: 10, padding: '2px 8px', borderRadius: 100, background: imuQuat ? 'rgba(52,211,153,0.12)' : 'rgba(74,85,104,0.3)', color: imuQuat ? '#34d399' : '#4a5568', border: `1px solid ${imuQuat ? 'rgba(52,211,153,0.25)' : 'rgba(255,255,255,0.06)'}` },
    body: { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
    row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    key: { fontSize: 11, color: '#718096' },
    val: { fontSize: 11.5, color: '#e2b96f', fontVariantNumeric: 'tabular-nums' },
    barBg: { flex: 1, height: 4, background: '#1a1f35', borderRadius: 4, overflow: 'hidden', margin: '0 10px' },
    barFill: (pct, color) => ({ width: `${pct}%`, height: '100%', borderRadius: 4, background: color, transition: 'width 0.5s' }),
    pill: (on) => ({ fontSize: 10, padding: '2px 7px', borderRadius: 100, background: on ? 'rgba(96,165,250,0.12)' : 'rgba(74,85,104,0.2)', color: on ? '#60a5fa' : '#4a5568', border: `1px solid ${on ? 'rgba(96,165,250,0.25)' : 'rgba(255,255,255,0.06)'}` }),
  };

  const imus = [
    { key: 'upperArm', label: 'Upper Arm IMU', data: imuQuat?.upperArm, diag: diag?.perImu?.upperArm },
    { key: 'forearm', label: 'Forearm IMU', data: imuQuat?.forearm, diag: diag?.perImu?.forearm },
    { key: 'hand', label: 'Hand IMU', data: imuQuat?.hand || imuQuat, diag: diag?.perImu?.hand }
  ];

  const STATE_LABELS = ['IDLE', 'BOOT CAL', 'STATIC ALIGN WAIT', 'STATIC ALIGN RECORDING', 'RUNNING', 'MAG CAL'];

  return (
    <div style={d.wrap}>
      <div style={d.header}>
        <span style={d.title}>📡 IMU Diagnostics & Telemetry</span>
        <span style={d.badge}>{imuQuat ? 'LIVE' : 'NO SIGNAL'}</span>
      </div>

      <div style={d.grid}>
        {imus.map((imu) => {
          if (!imu.data || !Array.isArray(imu.data)) return null;
          return (
            <div key={imu.key} style={d.card}>
              <div style={d.cardTitle}>
                <span>{imu.label}</span>
                <span style={{ color: '#34d399', fontSize: 10 }}>● Active</span>
              </div>

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

function getFingerCalState(fingerIdx, calStatus, knotsByAxis) {
  if (calStatus & (1 << fingerIdx)) return 'green';
  const axes = knotsByAxis?.[fingerIdx];
  if (axes) {
    const hasAnyAxis = axes.some((axKnots, ai) =>
      CAL_FINGER_DEFAULTS[fingerIdx][ai] !== -1 && axKnots.every(k => Number.isFinite(k))
    );
    if (hasAnyAxis) return 'yellow';
  }
  return 'grey';
}

function CalStatusStrip({ calStatus, knotsByAxis }) {
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
          const state = getFingerCalState(bit, calStatus, knotsByAxis);
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
function LiveVoltageMonitor({ voltages, sensorHealth }) {
  return (
    <div style={{ background: 'rgba(10,12,28,0.98)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', backdropFilter: 'blur(12px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#a0aec0', letterSpacing: '0.8px', textTransform: 'uppercase' }}>Hall Sensor Voltages</span>
        <span style={{ fontSize: 10, color: '#4a5568' }}>raw volts</span>
      </div>
      <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {CH_LABELS.map((label, idx) => {
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
  takeMedianSamples, setCalError
}) {
  const [step, setStep] = useState('idle'); // idle, baseline, pose1, pose2, pose3
  const [baselines, setBaselines] = useState(null);
  const [isCapturing, setIsCapturing] = useState(false);

  useEffect(() => {
    setStep('idle');
    setBaselines(null);
  }, [couplingFinger]);

  const [chYaw, chP1, chP2, chIP] = CAL_FINGER_DEFAULTS[couplingFinger];

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
function Scene({ rigData, restRotationR, restRotationL, wristLimits, fingerLimits, onRestPosesLoaded }) {
  return (
    <Canvas camera={{ position: [0, 0.4, 1.9], fov: 40 }} style={{ width: '100%', height: '100%' }}>
      <ambientLight intensity={1.8} />
      <directionalLight position={[5, 10, 5]} intensity={2.5} />
      <pointLight position={[-5, 5, -3]} intensity={0.6} />
      <ArmModel
        rightHandSensorData={rigData?.right}
        leftHandSensorData={rigData?.left}
        restRotationR={restRotationR}
        restRotationL={restRotationL}
        wristLimits={wristLimits}
        fingerLimits={fingerLimits}
        onRestPosesLoaded={onRestPosesLoaded}
      />
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

    if (frame?.source === 'raw' || frame?.source === 'raw_dual') {
      let voltages = frame.voltages;
      if (frame?.source === 'raw_dual') {
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
      return;
    }

    if (!isRecordingRef.current) return;
    if (frame?.source !== 'finger') return;
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
      imuDiag: gloveFrame.imuDiag ?? null,
      flex: {},
      pads: [],
    };
  }, [gloveFrame]);

  const [modelAlign, setModelAlign] = useState({
    upper: [0, 0, 0],
    forearm: [0, 0, 0],
    hand: [0, 0, 0]
  });

  const mountCorrRef = useRef({
    upper: new THREE.Quaternion(),
    forearmL: new THREE.Quaternion(),
    forearmR: new THREE.Quaternion(),
    handL: new THREE.Quaternion(),
    handR: new THREE.Quaternion()
  });

  const restPosesRef = useRef(null);
  const tareUpperRef = useRef(new THREE.Quaternion());
  const modelAlignRef = useRef(modelAlign);
  useEffect(() => { modelAlignRef.current = modelAlign; }, [modelAlign]);

  const currentFrameRef = useRef(currentFrame);
  useEffect(() => { currentFrameRef.current = currentFrame; }, [currentFrame]);

  const [isCalibrated, setIsCalibrated] = useState(false);

  const calibrateMountOffsets = useCallback(() => {
    const frame = currentFrameRef.current;
    if (!frame?.imuQuat?.upperArm || !restPosesRef.current || !restPosesRef.current.right) {
      console.warn("Cannot calibrate: missing IMU data or rest poses");
      return;
    }
    const { upperArm, forearm, hand } = frame.imuQuat;

    const hwUpperWorld = ConvertToThreeSpace(new THREE.Quaternion().fromArray(upperArm));
    const hwForearmLocal = ConvertToThreeSpace(new THREE.Quaternion().fromArray(forearm));
    const hwHandLocal = ConvertToThreeSpace(new THREE.Quaternion().fromArray(hand));

    const mAlignUp = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      (parseFloat(modelAlignRef.current.upper[0]) || 0) * DEG2RAD,
      (parseFloat(modelAlignRef.current.upper[1]) || 0) * DEG2RAD,
      (parseFloat(modelAlignRef.current.upper[2]) || 0) * DEG2RAD, 'XYZ'));
    const mAlignFo = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      (parseFloat(modelAlignRef.current.forearm[0]) || 0) * DEG2RAD,
      (parseFloat(modelAlignRef.current.forearm[1]) || 0) * DEG2RAD,
      (parseFloat(modelAlignRef.current.forearm[2]) || 0) * DEG2RAD, 'XYZ'));
    const mAlignHa = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      (parseFloat(modelAlignRef.current.hand[0]) || 0) * DEG2RAD,
      (parseFloat(modelAlignRef.current.hand[1]) || 0) * DEG2RAD,
      (parseFloat(modelAlignRef.current.hand[2]) || 0) * DEG2RAD, 'XYZ'));

    const { upper: upperRestPose, forearm: forearmRestPose, hand: handRestPose } = restPosesRef.current.right;

    // 1. Upper Arm
    const alignedUpper_old = hwUpperWorld.clone().multiply(mAlignUp);
    const delta = alignedUpper_old.clone().multiply(upperRestPose.clone().invert());

    const deltaEuler = new THREE.Euler().setFromQuaternion(delta, 'YXZ');
    const headingYaw = deltaEuler.y;

    const qHeading = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, headingYaw, 0, 'XYZ'));
    const Q_bone_ideal = qHeading.clone().multiply(upperRestPose);

    const upperMountCorr = hwUpperWorld.clone().invert().multiply(Q_bone_ideal).multiply(mAlignUp.clone().invert());

    // 2. Forearm
    const forearmMountL = upperMountCorr.clone().invert();

    const forearmMountR = hwForearmLocal.clone().invert()
      .multiply(upperMountCorr).multiply(mAlignUp)
      .multiply(forearmRestPose)
      .multiply(mAlignFo.clone().invert());

    // 3. Hand
    const handMountL = forearmMountR.clone().invert();

    const handMountR = hwHandLocal.clone().invert()
      .multiply(forearmMountR).multiply(mAlignFo)
      .multiply(handRestPose)
      .multiply(mAlignHa.clone().invert());

    mountCorrRef.current = {
      upper: upperMountCorr,
      forearmL: forearmMountL,
      forearmR: forearmMountR,
      handL: handMountL,
      handR: handMountR
    };

    // Auto-tare heading after calibration
    const calAlignedUpper = hwUpperWorld.clone().multiply(upperMountCorr).multiply(mAlignUp);
    const calAlignedEuler = new THREE.Euler().setFromQuaternion(calAlignedUpper, 'YXZ');
    tareUpperRef.current = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, calAlignedEuler.y, 0, 'XYZ'));

    setIsCalibrated(true);
    console.log("Mount calibration complete!");
  }, []);

  const tareHeading = useCallback(() => {
    const frame = currentFrameRef.current;
    if (!frame?.imuQuat?.upperArm) return;

    const { upperArm } = frame.imuQuat;
    const hwUp = ConvertToThreeSpace(new THREE.Quaternion().fromArray(upperArm));
    const mUp = new THREE.Quaternion().setFromEuler(new THREE.Euler((parseFloat(modelAlignRef.current.upper[0]) || 0) * DEG2RAD, (parseFloat(modelAlignRef.current.upper[1]) || 0) * DEG2RAD, (parseFloat(modelAlignRef.current.upper[2]) || 0) * DEG2RAD, 'XYZ'));

    const alUp = hwUp.clone().multiply(mountCorrRef.current.upper).multiply(mUp);
    const euler = new THREE.Euler().setFromQuaternion(alUp, 'YXZ');
    tareUpperRef.current = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, euler.y, 0, 'XYZ'));
    console.log("Heading tared.");
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
  const [manualArmsEnable, setManualArmsEnable] = useState(false);
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

  const rigFrame = useMemo(() => {
    const frameData = { ...currentFrame };
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

    if (manualArmsEnable) {
      rig.right.palm = defaultPalmR;
      rig.left.palm = defaultPalmL;
      return rig;
    }

    if (!isCalibrated || !currentFrame?.imuQuat?.upperArm) {
      rig.right.palm = defaultPalmR;
      rig.left.palm = defaultPalmL;
      return rig;
    }

    const { upperArm, forearm, hand } = currentFrame.imuQuat;
    const hwUp = ConvertToThreeSpace(new THREE.Quaternion().fromArray(upperArm));
    const hwFo = ConvertToThreeSpace(new THREE.Quaternion().fromArray(forearm));
    const hwHa = ConvertToThreeSpace(new THREE.Quaternion().fromArray(hand));

    const mUp = new THREE.Quaternion().setFromEuler(new THREE.Euler((parseFloat(modelAlign.upper[0]) || 0) * DEG2RAD, (parseFloat(modelAlign.upper[1]) || 0) * DEG2RAD, (parseFloat(modelAlign.upper[2]) || 0) * DEG2RAD, 'XYZ'));
    const mFo = new THREE.Quaternion().setFromEuler(new THREE.Euler((parseFloat(modelAlign.forearm[0]) || 0) * DEG2RAD, (parseFloat(modelAlign.forearm[1]) || 0) * DEG2RAD, (parseFloat(modelAlign.forearm[2]) || 0) * DEG2RAD, 'XYZ'));
    const mHa = new THREE.Quaternion().setFromEuler(new THREE.Euler((parseFloat(modelAlign.hand[0]) || 0) * DEG2RAD, (parseFloat(modelAlign.hand[1]) || 0) * DEG2RAD, (parseFloat(modelAlign.hand[2]) || 0) * DEG2RAD, 'XYZ'));

    const mc = mountCorrRef.current;

    const upInv = mUp.clone().invert();
    const foInv = mFo.clone().invert();

    const alUp = hwUp.clone().multiply(mc.upper).multiply(mUp);
    const alFo = upInv.clone().multiply(mc.forearmL).multiply(hwFo).multiply(mc.forearmR).multiply(mFo);
    const alHa = foInv.clone().multiply(mc.handL).multiply(hwHa).multiply(mc.handR).multiply(mHa);

    const finalUp = tareUpperRef.current.clone().invert().multiply(alUp);

    rig.right.palm = {
      isAligned: true,
      upperArm: [finalUp.x, finalUp.y, finalUp.z, finalUp.w],
      forearm: [alFo.x, alFo.y, alFo.z, alFo.w],
      hand: [alHa.x, alHa.y, alHa.z, alHa.w]
    };
    rig.left.palm = defaultPalmL;
    return rig;
  }, [currentFrame, modelAlign, isCalibrated, manualFingersEnable, manualArmsEnable, manualFingers, manualThumbExtra, manualRightArm, manualLeftArm]);

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

  const takeMedianSamples = useCallback(async (durationMs = 800) => {
    const samples = [];
    const endTime = Date.now() + durationMs;
    while (Date.now() < endTime) {
      const v = gloveFrame.rawVoltagesRef?.current;
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
    const sensorIdx = CAL_FINGER_DEFAULTS[calFinger][calAxis];
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
  }, [captureBusy, axisAvailable, axisKnots, calFinger, calAxis, takeMedianSamples]);

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
          if (CAL_FINGER_DEFAULTS[fi][ai] === -1) continue;
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
  }, [sendCommandUnified]);

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

      // CAL_FINGER_DEFAULTS[finger][axis] = channel index (-1 = N/A)
      let sentCount = 0;
      for (let finger = 0; finger < 5; finger++) {
        for (let axis = 0; axis < 4; axis++) {
          const ch = CAL_FINGER_DEFAULTS[finger][axis];
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
            const ch = CAL_FINGER_DEFAULTS[f][a];
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
  }, [dynCalRecording, captureBusy, dynCalDuration, sendCommandUnified, waitForRawVoltages]);

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
      console.log("Authenticated user:", user);
      const userRes = await fetch(`${backendUrl}/profile/info?userId=${user.id}`);
      const userData = await userRes.json();
      setUser(userData[0]);
      console.log("Profile info:", userData);

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
      console.log("download submission:", signs);
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
              rigData={rigFrame}
              restRotationR={restRotationR}
              restRotationL={restRotationL}
              wristLimits={wristLimits}
              fingerLimits={fingerLimits}
              onRestPosesLoaded={(poses) => { restPosesRef.current = poses; }}
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
                  <CalStatusStrip calStatus={calHand === 'left' ? (currentFrame?.leftCalStatus ?? 0) : (currentFrame?.calStatus ?? 0)} knotsByAxis={knotsByAxis} />

                  {/* Hand Toggle */}
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, marginBottom: 8, background: 'rgba(0,0,0,0.2)', padding: '6px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
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
                      <LiveVoltageMonitor voltages={rawVoltages} sensorHealth={sensorHealth} />
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
                              <option key={name} value={idx} disabled={CAL_FINGER_DEFAULTS[calFinger][idx] === -1}>{name}</option>
                            ))}
                          </select>
                        </div>
                        {/* Live voltage for this axis */}
                        {axisAvailable && (() => {
                          const sensorIdx = CAL_FINGER_DEFAULTS[calFinger][calAxis];
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

                    <AlignmentPanel modelAlign={modelAlign} setModelAlign={setModelAlign} onCalibrate={calibrateMountOffsets} onTare={tareHeading} />

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
                      <div style={s.calSectionTitle}>3. 6-Pose Static Alignment</div>
                      <p style={s.calHint}>Align the coordinate frames by holding 6 distinct poses (T-pose, N-pose, etc). Click Record for each.</p>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <button style={{ ...s.calBtnSecondary, flex: 1 }} onClick={() => runCommand(CMD.START_STATIC_ALIGN)} disabled={!isConnected}>
                          Start Alignment
                        </button>
                        <button style={{ ...s.calBtn, flex: 2, background: gloveFrame.imuPoseIdx < 6 ? 'rgba(52,211,153,0.15)' : 'rgba(255,255,255,0.05)' }}
                          onClick={() => {
                            if (gloveFrame.imuPoseIdx < 6) {
                              runCommand(CMD.RECORD_STATIC_POSE);
                            }
                          }}
                          disabled={!isConnected || gloveFrame.imuPoseIdx >= 6}>
                          Record Pose {gloveFrame.imuPoseIdx < 6 ? gloveFrame.imuPoseIdx + 1 : 'Complete'}
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
                        {[...(gloveFrame.consoleLogs || [])].reverse().map((log, idx) => (
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
              {DEV_MODE && <CalStatusStrip calStatus={currentFrame?.calStatus ?? 0} knotsByAxis={knotsByAxis} />}
            </>
          )}

          {mainTab === 'imu' && (
            <>
              <IMUDiagnosticsPanel
                diag={currentFrame?.imuDiag ?? null}
                imuQuat={currentFrame?.imuQuat ?? null}
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
        />
      )}
      {/* ── DEV TOOLS PANEL (hidden in production) ── */}
      {DEV_MODE && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 100,
          background: 'rgba(10,12,28,0.97)', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 16, overflow: 'hidden', backdropFilter: 'blur(12px)',
          width: 400, boxShadow: '0 16px 48px rgba(0,0,0,0.6)',
          maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
        }}>
          {/* ── Section: Rest Pose Tuner ── */}
          <div
            onClick={() => setTunerOpen(o => !o)}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 16px', cursor: 'pointer',
              borderBottom: '1px solid rgba(255,255,255,0.07)', userSelect: 'none'
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 600, color: '#a0aec0', letterSpacing: '0.8px', textTransform: 'uppercase' }}>
              🎛 Rest Pose Tuner
            </span>
            <span style={{ fontSize: 11, color: '#4a5568' }}>{tunerOpen ? '▲' : '▼'}</span>
          </div>
          {tunerOpen && (
            <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <button
                onClick={() => {
                  const txt = `restRotationR={[${restRotationR.map(v => v.toFixed(3)).join(', ')}]}\nrestRotationL={[${restRotationL.map(v => v.toFixed(3)).join(', ')}]}`;
                  navigator.clipboard.writeText(txt);
                }}
                style={{
                  fontSize: 11, padding: '6px 12px', background: 'rgba(226,185,111,0.10)',
                  color: '#e2b96f', border: '1px solid rgba(226,185,111,0.25)', borderRadius: 8, cursor: 'pointer'
                }}
              >
                📋 Copy values to clipboard
              </button>
              <div style={{ fontSize: 11, color: '#e2b96f', fontWeight: 600, marginTop: 4 }}>Right hand</div>
              {['X', 'Y', 'Z'].map((axis, i) => (
                <div key={`r${axis}`} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 11, color: '#718096', width: 14 }}>{axis}</span>
                  <input type="range" min="-3.15" max="3.15" step="0.01"
                    value={restRotationR[i]} onChange={e => setR(i, parseFloat(e.target.value))} style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: '#e2b96f', width: 42, textAlign: 'right' }}>{restRotationR[i].toFixed(2)}</span>
                </div>
              ))}
              <div style={{ fontSize: 11, color: '#60a5fa', fontWeight: 600, marginTop: 4 }}>Left hand</div>
              {['X', 'Y', 'Z'].map((axis, i) => (
                <div key={`l${axis}`} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 11, color: '#718096', width: 14 }}>{axis}</span>
                  <input type="range" min="-3.15" max="3.15" step="0.01"
                    value={restRotationL[i]} onChange={e => setL(i, parseFloat(e.target.value))} style={{ flex: 1 }} />
                  <span style={{ fontSize: 11, color: '#60a5fa', width: 42, textAlign: 'right' }}>{restRotationL[i].toFixed(2)}</span>
                </div>
              ))}

              {/* ARMS SECTION (Moved here so it collapses with Rest Pose Tuner) */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, marginTop: 16, borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#a0aec0' }}>🧪 Manual Arms / Offline Pose</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      localStorage.setItem('esl_glove_offline_right', JSON.stringify(manualRightArm));
                      localStorage.setItem('esl_glove_offline_left', JSON.stringify(manualLeftArm));
                      alert('Offline default pose saved to local storage!');
                    }}
                    style={{ fontSize: 10, padding: '3px 8px', background: 'rgba(52,211,153,0.15)', border: '1px solid rgba(52,211,153,0.3)', borderRadius: 6, color: '#34d399', cursor: 'pointer' }}
                  >Save Default</button>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={manualArmsEnable} onChange={e => setManualArmsEnable(e.target.checked)} />
                  <span style={{ fontSize: 11, color: '#718096' }}>Enable Live Override</span>
                </label>
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { label: 'Right Arm', state: manualRightArm, setter: setManualRightArm, color: '#e2b96f' },
                  { label: 'Left Arm', state: manualLeftArm, setter: setManualLeftArm, color: '#60a5fa' }
                ].map(({ label, state, setter, color }) => (
                  <div key={label} style={{ marginTop: 4, padding: '8px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: `1px solid ${color}33` }}>
                    <div style={{ fontSize: 12, fontWeight: 'bold', color: color, marginBottom: 8 }}>{label}</div>
                    {['upperArm', 'forearm', 'hand'].map((joint) => (
                      <div key={joint} style={{ marginBottom: 12 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ fontSize: 11, color: '#a0aec0', textTransform: 'capitalize' }}>{joint} Euler (Deg) X Y Z</span>
                          <span style={{ fontSize: 11, color: color }}>{state[joint].map(v => Math.round(v)).join(' , ')}</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                          <input type="range" min="-180" max="180" step="1" value={state[joint][0]} title={`${joint} X`}
                            onChange={e => { const v = Number(e.target.value); setter(p => ({ ...p, [joint]: [v, p[joint][1], p[joint][2]] })); }} />
                          <input type="range" min="-180" max="180" step="1" value={state[joint][1]} title={`${joint} Y`}
                            onChange={e => { const v = Number(e.target.value); setter(p => ({ ...p, [joint]: [p[joint][0], v, p[joint][2]] })); }} />
                          <input type="range" min="-180" max="180" step="1" value={state[joint][2]} title={`${joint} Z`}
                            onChange={e => { const v = Number(e.target.value); setter(p => ({ ...p, [joint]: [p[joint][0], p[joint][1], v] })); }} />
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Section: Biomechanical Limits ── */}
          <div
            onClick={() => setBioOpen(o => !o)}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 16px', cursor: 'pointer',
              borderBottom: bioOpen ? '1px solid rgba(255,255,255,0.07)' : 'none', userSelect: 'none'
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 600, color: '#a0aec0', letterSpacing: '0.8px', textTransform: 'uppercase' }}>
              🦴 Biomechanical Limits
            </span>
            <span style={{ fontSize: 11, color: '#4a5568' }}>{bioOpen ? '▲' : '▼'}</span>
          </div>
          {bioOpen && (
            <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                onClick={() => { setWristLimits({ ...DEFAULT_WRIST_LIMITS }); setFingerLimits(JSON.parse(JSON.stringify(BIOMECHANICAL_LIMITS))); }}
                style={{
                  fontSize: 11, padding: '5px 10px', background: 'rgba(255,255,255,0.05)',
                  color: '#a0aec0', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, cursor: 'pointer'
                }}
              >
                Reset to anatomical defaults
              </button>

              {/* Wrist limits */}
              <div style={{ fontSize: 11, color: '#e2b96f', fontWeight: 600, marginTop: 4 }}>Wrist (degrees)</div>
              {[
                { key: 'flexion', label: 'Flexion', min: 0, max: 120 },
                { key: 'extension', label: 'Extension', min: 0, max: 90 },
                { key: 'radial', label: 'Radial Dev', min: 0, max: 40 },
                { key: 'ulnar', label: 'Ulnar Dev', min: 0, max: 50 },
                { key: 'pronation', label: 'Pronation', min: 0, max: 180 },
                { key: 'supination', label: 'Supination', min: 0, max: 180 },
              ].map(({ key, label, min, max }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 10, color: '#718096', width: 72, flexShrink: 0 }}>{label}</span>
                  <input type="range" min={min} max={max} step="1"
                    value={wristLimits[key]}
                    onChange={e => setWristLimits(prev => ({ ...prev, [key]: Number(e.target.value) }))}
                    style={{ flex: 1 }} />
                  <span style={{ fontSize: 10, color: '#e2b96f', width: 32, textAlign: 'right' }}>{wristLimits[key]}°</span>
                </div>
              ))}

              {/* Finger limits */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: '#60a5fa', fontWeight: 600 }}>Fingers (degrees)</span>
                <select
                  value={bioFingerTab}
                  onChange={e => setBioFingerTab(e.target.value)}
                  style={{ fontSize: 10, background: 'rgba(0,0,0,0.5)', color: '#fff', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4, padding: '2px 4px' }}
                >
                  {['thumb', 'index', 'middle', 'ring', 'pinky'].map(f => (
                    <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>
                  ))}
                </select>
              </div>

              {Object.entries(fingerLimits[bioFingerTab] || {}).map(([joint, range]) => (
                <div key={joint} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
                  <span style={{ fontSize: 10, color: '#718096', textTransform: 'uppercase' }}>{joint}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 9, color: '#4a5568', width: 20 }}>Min</span>
                    <input type="range" min="-90" max="150" step="1"
                      value={range[0]}
                      onChange={e => {
                        const val = Number(e.target.value);
                        setFingerLimits(prev => {
                          const next = { ...prev };
                          next[bioFingerTab] = { ...next[bioFingerTab] };
                          next[bioFingerTab][joint] = [val, Math.max(val, next[bioFingerTab][joint][1])];
                          return next;
                        });
                      }}
                      style={{ flex: 1 }} />
                    <span style={{ fontSize: 10, color: '#60a5fa', width: 28, textAlign: 'right' }}>{range[0]}°</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 9, color: '#4a5568', width: 20 }}>Max</span>
                    <input type="range" min="-90" max="150" step="1"
                      value={range[1]}
                      onChange={e => {
                        const val = Number(e.target.value);
                        setFingerLimits(prev => {
                          const next = { ...prev };
                          next[bioFingerTab] = { ...next[bioFingerTab] };
                          next[bioFingerTab][joint] = [Math.min(val, next[bioFingerTab][joint][0]), val];
                          return next;
                        });
                      }}
                      style={{ flex: 1 }} />
                    <span style={{ fontSize: 10, color: '#60a5fa', width: 28, textAlign: 'right' }}>{range[1]}°</span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* ── Manual Pose Tester (DEV only) ── */}
          <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            
            {/* FINGERS SECTION */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#a0aec0' }}>🧪 Manual Fingers</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={manualFingersEnable} onChange={e => setManualFingersEnable(e.target.checked)} />
                <span style={{ fontSize: 11, color: '#718096' }}>Enable Override</span>
              </label>
            </div>
            {manualFingersEnable && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {['Pinky', 'Ring', 'Middle', 'Index', 'Thumb'].map((name, fi) => {
                  const isThumb = name === 'Thumb';
                  const yawAxis = isThumb ? 'Y' : 'Z';
                  const pitchAxis = isThumb ? 'Z' : '-X';
                  return (
                    <div key={name} style={{ padding: '6px 0' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ fontSize: 11, color: '#a0aec0' }}>{name}</span>
                        <span style={{ fontSize: 11, color: '#e2b96f' }}>{`Yaw(${yawAxis}) ${Math.round(manualFingers[fi].yaw)}° • P1(${pitchAxis}) ${Math.round(manualFingers[fi].pitch1)}° • P2(${pitchAxis}) ${Math.round(manualFingers[fi].pitch2)}°`}</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                        <input type="range" min="-90" max="90" step="1" value={manualFingers[fi].yaw} title={`Yaw (${yawAxis})`}
                          onChange={e => setManualFingers(prev => { const n = prev.map(f => ({ ...f })); n[fi].yaw = Number(e.target.value); return n; })} />
                        <input type="range" min="-90" max="90" step="1" value={manualFingers[fi].pitch1} title={`Pitch 1 (${pitchAxis})`}
                          onChange={e => setManualFingers(prev => { const n = prev.map(f => ({ ...f })); n[fi].pitch1 = Number(e.target.value); return n; })} />
                        <input type="range" min="-90" max="90" step="1" value={manualFingers[fi].pitch2} title={`Pitch 2 (${pitchAxis})`}
                          onChange={e => setManualFingers(prev => { const n = prev.map(f => ({ ...f })); n[fi].pitch2 = Number(e.target.value); return n; })} />
                      </div>
                    </div>
                  );
                })}

                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: '#a0aec0' }}>Thumb Extra (IP) [Z-axis]</span>
                    <span style={{ fontSize: 11, color: '#e2b96f' }}>{Math.round(manualThumbExtra)}°</span>
                  </div>
                  <input type="range" min="-90" max="90" step="1" value={manualThumbExtra} title="Thumb IP (Z)"
                    onChange={e => setManualThumbExtra(Number(e.target.value))} />
                </div>
              </div>
            )}
          </div>
        </div>
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
  trimFill: { position: 'absolute', height: '100%', background: 'linear-gradient(90deg, #0f3460, #e2b96f)', borderRadius: 6 },

  actionRow: { display: 'flex', gap: 12, justifyContent: 'flex-end' },
  discardBtn: { padding: '11px 22px', background: 'rgba(239,68,68,0.06)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.20)', borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background 0.15s, color 0.15s', fontFamily: "'DM Sans', sans-serif" },
  saveSignBtn: { padding: '11px 28px', background: '#059669', color: '#fff', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background 0.2s, transform 0.15s', fontFamily: "'DM Sans', sans-serif" },
};
