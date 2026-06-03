# Unified Glove Packet Specification (`0x45534C47`)

This document provides a byte-by-byte breakdown of the highly compressed 130-byte `UnifiedGlovePacket` transmitted by the ESL-Glove over WebSockets. It includes the exact decoding logic required for frontend and mobile clients to invert the compression and reconstruct 3D tracking data.

## 1. Packet Layout (130 Bytes Total)

The packet is strictly packed (`__attribute__((packed))`) with **Little-Endian** byte order.

| Offset | Size (Bytes) | Data Type | Field Name | Description |
| :--- | :--- | :--- | :--- | :--- |
| **0** | 4 | `uint32_t` | `header` | Magic identifier. Always `0x45534C47` ("ESLG" in ASCII). |
| **4** | 4 | `uint32_t` | `timestamp` | ESP32 microsecond timestamp (`micros()`). |
| **8** | 61 | `struct` | `right_hand` | Compressed telemetry for the Right Hand (Master). |
| **69** | 61 | `struct` | `left_hand` | Compressed telemetry for the Left Hand (Slave). |

---

## 2. Hand Telemetry Structure (61 Bytes)

Both `right_hand` (starts at offset `8`) and `left_hand` (starts at offset `69`) follow this exact memory layout. All offsets below are **relative to the start of the hand structure**.

| Relative Offset | Size | Type | Field Name | Description |
| :--- | :--- | :--- | :--- | :--- |
| **+0** | 4 | `uint32_t` | `q_up` | Upper Arm Quaternion (Smallest-Three Compressed) |
| **+4** | 4 | `uint32_t` | `q_fo` | Forearm Quaternion (Smallest-Three Compressed) |
| **+8** | 4 | `uint32_t` | `q_ha` | Hand/Wrist Quaternion (Smallest-Three Compressed) |
| **+12** | 15 | `int8_t[5][3]`| `fingers` | Finger angles (Pinky, Ring, Middle, Index, Thumb). Array order: `[Yaw, Pitch1, Pitch2]` per finger. |
| **+27** | 1 | `int8_t` | `thumb_extra` | Extra thumb axis angle (Thumb IP joint). |
| **+28** | 32 | `uint16_t[16]`| `voltages` | Raw ADC Hall-effect voltages. Scaled by `10000`. |
| **+60** | 1 | `uint8_t` | `status` | Bitfield containing calibration progress and connection state. |

---

## 3. Data Decompression Algorithms

To extract real-world values from the binary payload, receivers must apply the following transformations.

### A. Smallest-Three Quaternion Decompression (`uint32_t` → 4 `floats`)
Because a quaternion is a normalized vector ($x^2 + y^2 + z^2 + w^2 = 1$), the largest component can be safely dropped and mathematically reconstructed to save bandwidth.

**Packing Format:**
*   **Bits 30-31:** `max_idx` (0 to 3) representing which component (w, x, y, z) was dropped.
*   **Bits 20-29:** 10-bit value for the 1st remaining component.
*   **Bits 10-19:** 10-bit value for the 2nd remaining component.
*   **Bits 0-9:** 10-bit value for the 3rd remaining component.

**Decompression Logic (JavaScript Example):**
```javascript
function unpackQuaternion(packedUint32) {
    // 1. Extract the index of the missing largest component (top 2 bits)
    const max_idx = (packedUint32 >>> 30) & 0x03;

    // 2. Extract the three 10-bit components
    const c1 = (packedUint32 >>> 20) & 0x3FF;
    const c2 = (packedUint32 >>> 10) & 0x3FF;
    const c3 = packedUint32 & 0x3FF;

    // 3. Map values from [0, 1023] back to floats in the range [-0.707106, +0.707106]
    // The constant 0.707106 is 1.0 / sqrt(2), the maximum possible value for the smallest 3 components.
    const mapToFloat = (val) => (val - 511.5) * (0.707106781 / 511.5);
    const v1 = mapToFloat(c1);
    const v2 = mapToFloat(c2);
    const v3 = mapToFloat(c3);

    // 4. Reconstruct the missing largest component using Pythagoras theorem
    const sum_sq = (v1 * v1) + (v2 * v2) + (v3 * v3);
    const missing = Math.sqrt(Math.max(0, 1.0 - sum_sq));

    // 5. Reassemble the quaternion array [W, X, Y, Z]
    const q = [0, 0, 0, 0];
    let idx = 0;
    for (let i = 0; i < 4; i++) {
        if (i === max_idx) {
            q[i] = missing;
        } else {
            if (idx === 0) q[i] = v1;
            else if (idx === 1) q[i] = v2;
            else if (idx === 2) q[i] = v3;
            idx++;
        }
    }
    
    // Output array is [W, X, Y, Z]. 
    // NOTE: Three.js uses [X, Y, Z, W] order!
    return { w: q[0], x: q[1], y: q[2], z: q[3] };
}
```

### B. Finger Angles (`int8_t` → `float`)
Angles are clamped and cast to an 8-bit signed integer. This limits angles to whole numbers between `-128°` and `+127°`, which is perfectly acceptable for human finger biomechanics.
**Decompression:**
Read the byte as a standard Signed 8-bit Integer. No mathematical multiplier is needed.
```javascript
// Reading Yaw for the Pinky Finger (Right Hand)
const pinkyYaw = dataView.getInt8(8 + 12); // relative offset +12
```

### C. ADC Voltages (`uint16_t` → `float`)
Floating-point voltages (e.g., `1.854V`) were multiplied by `10000` to be sent as unsigned 16-bit integers (e.g., `18540`).
**Decompression:**
Divide the parsed integer by `10000.0`.
```javascript
// Reading the 1st Hall-Effect sensor voltage
const rawInt = dataView.getUint16(8 + 28 + (0 * 2), true); // true = Little-Endian
const voltageFloat = rawInt / 10000.0;
```

### D. Status Bitfield (`uint8_t` → booleans)
The single `status` byte holds flags for the state of the Hall-effect calibration profile and whether the glove's telemetry stream is actively connected.
*   **Bits 0-4:** `cal_status` (A bitmask representing which fingers have been calibrated: Pinky, Ring, Middle, Index, Thumb).
*   **Bit 5:** `connected` (1 if the hand is actively streaming data, 0 if it has dropped offline).

**Decompression:**
```javascript
const statusByte = dataView.getUint8(8 + 60);

// Extract lower 5 bits for Calibration Status
const calStatus = statusByte & 0x1F; 

// Shift right 5 times and extract the 1 bit for Connection Status
const isConnected = ((statusByte >>> 5) & 0x1) === 1;
```

---

## 4. Total JavaScript Parsing Example

```javascript
// Assuming `buffer` is the ArrayBuffer received from the WebSocket
const view = new DataView(buffer);
const header = view.getUint32(0, true);

if (header === 0x45534C47 && view.byteLength >= 130) {
    const timestamp = view.getUint32(4, true);

    const parseHand = (offset) => {
        return {
            qUpper: unpackQuaternion(view.getUint32(offset + 0, true)),
            qFore: unpackQuaternion(view.getUint32(offset + 4, true)),
            qHand: unpackQuaternion(view.getUint32(offset + 8, true)),
            
            // Example getting Index Finger Pitch 1
            indexPitch1: view.getInt8(offset + 12 + (3 * 3) + 1), // (3rd finger * 3 joints) + Pitch1 idx

            // Statuses
            calStatus: view.getUint8(offset + 60) & 0x1F,
            connected: ((view.getUint8(offset + 60) >>> 5) & 0x1) === 1
        };
    };

    const rightHandData = parseHand(8);
    const leftHandData = parseHand(69);
}
```
