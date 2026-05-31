# ESL Glove - Frontend Integration Guide

This document outlines the required changes and updates for the Frontend to correctly interface with the newly unified Master-Slave ESP32 firmware architecture.

## 1. WebSocket Protocol & Connection

In **WiFi Mode**, the ESP32 **Master (Right Hand)** hosts a WebSocket server on `ws://[esp_ip]:81`.

### 🌐 Connecting from the React Frontend (Browser limitations)
Because the React frontend runs in a standard web browser (Chrome/Edge), it is subject to strict DNS and security rules:
- **Do NOT rely on `eslglove.local` in the browser**. Modern browsers with "Secure DNS" (DoH) enabled will completely block `.local` resolution. 
- You must use the direct, raw IP address of the ESP32 (e.g., `ws://192.168.1.8:81`).
- We highly recommend storing this in your `.env` file as `NEXT_PUBLIC_ESP_IP` rather than hardcoding it into `page.jsx`.

### ⏱️ Dynamic Telemetry Rate
- The ESP32 attempts to broadcast packets at **100Hz (10ms)** if only 1 client is connected (e.g., just your React app).
- **CRITICAL:** If a 2nd device connects (like the Mobile App), the ESP32 will instantly downshift the broadcast rate to **50Hz (20ms)** to prevent the internal TCP stack from suffocating and crashing. Your frontend rig must be capable of rendering smoothly at 50Hz.

### 📥 Data Handling
- The Master aggregates data from the Left Hand via ESP-NOW and sends unified dual-hand packets.
- The ESP now sends logs as `Text` frames (e.g. `"[MOBILE] CMD: Tare IMU"`), so your `onmessage` handler MUST check if `event.data` is a `String` or an `ArrayBuffer`!

## 2. Updated Data Structures & Parsing

> [!WARNING]
> Several legacy packets are now strictly **DEPRECATED** and will no longer be sent. Ensure your parsing logic is updated to handle the new packet headers.

### DEPRECATED Packets (Do Not Use)
- `IMUPacket` (Header `0xAABBCCDD`) - 16 bytes format is deprecated.
- `UnifiedPacket` (Header `0xDEADBEEF`) - Replaced by Dual packets.
- Single `FingerPacket` (Header `0xF1F2F3F4`) - Replaced by Dual packets.

### 🆕 ArmTrackerPacket (Header `0xAABBCCDD`)
This packet retains the old IMUPacket header, but the structure is completely revamped to support 3 IMUs (Arm Tracker).
**Size:** 136 bytes
**Structure:**
- `uint32_t header` (0xAABBCCDD)
- `uint32_t timestamp`
- `float q_up_w, q_up_x, q_up_y, q_up_z` (Upper arm quaternion)
- `float q_fo_w, q_fo_x, q_fo_y, q_fo_z` (Forearm quaternion)
- `float q_ha_w, q_ha_x, q_ha_y, q_ha_z` (Hand quaternion)
- `uint8_t current_state`
- `float accel_mag[3]`
- `float mag_norm[3]`
- `float drift_exposure[3]`
- `uint8_t mag_clean[3]`
- `float ref_accel_mag[3]`
- `float time_since_good_accel[3]`
- `float safe_upper_yaw`
- `float safe_elbow_pitch`
- `float safe_forearm_roll`
- `float phone_yaw_correction`

### 🆕 DualFingerPacket (Header `0xF1F2F3F5`)
This packet contains the finger tracking data for **both hands**.
**Size:** 139 bytes
**Structure:**
- `uint32_t header` (0xF1F2F3F5)
- `uint32_t timestamp`
- **Right Hand:**
  - `float right_angles[5][3]` (Yaw, Pitch1, Pitch2 for Pinky, Ring, Middle, Index, Thumb)
  - `float right_thumb_extra`
  - `uint8_t right_cal_status`
- **Left Hand:**
  - `float left_angles[5][3]`
  - `float left_thumb_extra`
  - `uint8_t left_cal_status`
- `uint8_t left_connected` (1 = left hand online, 0 = offline)

### 🆕 DualRawVoltagesPacket (Header `0xC0DEC0DF`)
This packet is used during the calibration wizard.
**Size:** 137 bytes
**Structure:**
- `uint32_t header` (0xC0DEC0DF)
- `uint32_t timestamp`
- `float right_voltages[16]`
- `float left_voltages[16]`
- `uint8_t left_connected`

## 3. Left Hand Command Forwarding

If the frontend needs to trigger calibration or send a command specifically to the **Left Hand**, it MUST prefix the binary command payload with `0xA0`.
The master ESP32 will strip the `0xA0` and forward the rest of the command to the left hand over ESP-NOW.

Example to Tare the left hand:
Send `[0xA0, 0x01]` to the WebSocket.
