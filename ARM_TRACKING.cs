using UnityEngine;
using System.IO.Ports;
using System.Threading;
using System;
using System.Collections.Concurrent;
#if UNITY_EDITOR
using UnityEditor;
using System.Collections.Generic;
using System.IO;
#endif

public class ArmTracker : MonoBehaviour
{
    [Header("Serial Settings")]
    public string portName = "COM3";
    public int baudRate = 2000000; // Updated to match v1 firmware

    [Header("Arm Transforms (Must be parented: Upper -> Forearm -> Hand)")]
    public Transform upperArmTransform;
    public Transform forearmTransform;
    public Transform handTransform;

    [Header("3D Model Axis Alignments (Rotate in 90 deg steps)")]
    public Vector3 upperModelAlignment   = Vector3.zero;
    public Vector3 forearmModelAlignment = Vector3.zero;
    public Vector3 handModelAlignment    = Vector3.zero;

    // Mount corrections (identity until press-C calibration)
    // These sit BETWEEN the raw sensor quaternion and the model alignment,
    // so model alignment is always active and user-editable.
    //
    // Upper arm (absolute): aligned = hw * upperMountCorr * modelAlignUpper
    //   upperMountCorr = Inv(R_mount), post-multiply works because in the delta
    //   (hw_now * mountCorr) * Inv(hw_cal * mountCorr), R_mount cancels.
    //
    // Forearm (relative): aligned = parentAlignInv * forearmMountL * hw * forearmMountR * forearmModelAlign
    //   Two-sided needed because q_rel = Inv(R_mount_parent) * q_bone * R_mount_child,
    //   and a single-sided multiply leaves one mount conjugating the motion delta.
    private Quaternion upperMountCorr  = Quaternion.identity;
    private Quaternion forearmMountL   = Quaternion.identity; // R_mount_upper
    private Quaternion forearmMountR   = Quaternion.identity; // Inv(R_mount_forearm)
    private Quaternion handMountL      = Quaternion.identity; // R_mount_forearm
    private Quaternion handMountR      = Quaternion.identity; // Inv(R_mount_hand)

    // Captured at Start from the model's T-pose
    private Quaternion upperRestPose;
    private Quaternion forearmRestPose;
    private Quaternion handRestPose;

    [Header("Tare Settings")]
    public bool useFull3DTare = false;

    [Header("Live Telemetry (Read Only)")]
    public float[] accelMag = new float[3];
    public float[] magNorm = new float[3];
    public float[] driftExposure = new float[3];
    public bool[] magClean = new bool[3];

    [Header("Kinematic Offsets")]
    public float safeUpperYaw;
    public float safeElbowPitch;
    public float safeForearmRoll;
    public float phoneYawCorrection;

    private SerialPort serialPort;
    private Thread readThread;
    private volatile bool isRunning = false;

    private enum SystemState {
        IDLE = 0,
        BOOT_CALIBRATION = 1,
        STATIC_CALIBRATION = 2,  // Matches C++ STATIC_ALIGN_WAIT
        STATIC_RECORDING = 3,    // Matches C++ STATIC_ALIGN_RECORDING
        RUNNING = 4,             // Matches C++ RUNNING
        MAG_CALIBRATING = 5,     // Matches C++ MAG_CALIBRATION
        WAIT_CONNECTION = 99
    }

    private SystemState currentState = SystemState.WAIT_CONNECTION;
    private string onScreenMessage = "Connecting to ESP32...";

    private ConcurrentQueue<SensorData> dataQueue    = new ConcurrentQueue<SensorData>();
    private ConcurrentQueue<string>     commandQueue = new ConcurrentQueue<string>();
    
    // TARE QUATERNIONS
    private Quaternion tareUpper   = Quaternion.identity;
    private Quaternion tareForearm = Quaternion.identity;
    private Quaternion tareHand    = Quaternion.identity;

#if UNITY_EDITOR
    private bool isRecording = false;
    private float recordingStartTime = 0f;
    
    struct KeyframeData {
        public float time;
        public Quaternion rotUp, rotFo, rotHa;
    }
    private List<KeyframeData> animationKeyframes = new List<KeyframeData>();
#endif

    struct SensorData {
        public uint timestamp;
        public Quaternion qUpper, qForearm, qHand;
        public byte currentState;
        public float[] accelMag, magNorm, driftExposure;
        public bool[] magClean;
        public float safeUpperYaw, safeElbowPitch, safeForearmRoll, phoneYawCorr;
    }

    void Start()
    {
        currentState    = SystemState.WAIT_CONNECTION;
        onScreenMessage = "Connecting to ESP32...";
        tareUpper       = Quaternion.identity;

        if (upperArmTransform != null) upperRestPose = upperArmTransform.localRotation;
        if (forearmTransform != null)  forearmRestPose = forearmTransform.localRotation;
        if (handTransform != null)     handRestPose = handTransform.localRotation;
        
        while (dataQueue.TryDequeue(out _))    {}
        while (commandQueue.TryDequeue(out _)) {}

        try {
            serialPort = new SerialPort(portName, baudRate);
            serialPort.ReadTimeout  = 1;
            serialPort.WriteTimeout = 200;
            serialPort.DtrEnable = true;
            serialPort.RtsEnable = true;
            
            serialPort.Open();
            isRunning = true;
            
            serialPort.DiscardInBuffer(); 
            
            readThread = new Thread(ReadSerial);
            readThread.IsBackground = true;
            readThread.Start();
            
            // Trigger idle state
            serialPort.Write("q"); 
            Debug.Log($"<color=green>Connected to {portName} at {baudRate} baud.</color>");
        } catch (Exception e) {
            Debug.LogError("Failed to open port: " + e.Message);
        }
    }

    void Update()
    {
        bool doTare = false;
        
        // ---- KEYBOARD CONTROLS ----
        // Boot and Tare controls
        if (Input.GetKeyDown(KeyCode.Space) || Input.GetKeyDown(KeyCode.Return)) {
            if (currentState == SystemState.IDLE || currentState == SystemState.WAIT_CONNECTION) {
                onScreenMessage =  "Booting... Keep sensors perfectly STILL (2 seconds). ";
                commandQueue.Enqueue("b");
            } else if (currentState == SystemState.RUNNING) {
                doTare = true;
            }
        }

        // Force the Pose command regardless of what state Unity thinks it is in
        if (Input.GetKeyDown(KeyCode.P)) {
            onScreenMessage =  "Recording Pose... Hold Still! ";
            commandQueue.Enqueue("p"); 
        }

        if (Input.GetKeyDown(KeyCode.M)) {
            if (currentState == SystemState.RUNNING) {
                commandQueue.Enqueue("m");
            } else if (currentState == SystemState.MAG_CALIBRATING) {
                commandQueue.Enqueue("r"); // Resume running
            }
        }

#if UNITY_EDITOR
        if (currentState == SystemState.RUNNING && Input.GetKeyDown(KeyCode.R)) {
            if (!isRecording) {
                isRecording = true;
                recordingStartTime = Time.time;
                animationKeyframes.Clear();
                Debug.Log("<color=red>● RECORDING STARTED</color>");
            }
        }
        if (isRecording && Input.GetKeyDown(KeyCode.T)) {
            isRecording = false;
            Debug.Log("<color=yellow>■ RECORDING STOPPED. Saving...</color>");
            SaveAnimation();
        }
#endif

        // ---- DATA APPLICATION ----
        SensorData latestData = new SensorData();
        bool hasNewData = false;
        while (dataQueue.TryDequeue(out SensorData d)) { latestData = d; hasNewData = true; }

        if (hasNewData)
        {
            // --- NEW: Safely Update State Machine on Main Thread ---
            SystemState incomingState = (SystemState)latestData.currentState;
            if (incomingState != currentState) {
                currentState = incomingState;
                
                // Update the UI message safely
                switch (currentState) {
                    case SystemState.IDLE:
                        onScreenMessage =  "ESP32 Ready. Press SPACE to Boot Calibrate. ";
                        break;
                    case SystemState.BOOT_CALIBRATION:
                        onScreenMessage =  "Booting... Keep sensors perfectly STILL (2 seconds). ";
                        break;
                    case SystemState.STATIC_CALIBRATION: 
                        onScreenMessage =  "Move to Pose and press SPACE / P to record. ";
                        break;
                    case SystemState.STATIC_RECORDING:
                        onScreenMessage =  "Recording Pose... Hold Still! ";
                        break;
                    case SystemState.MAG_CALIBRATING:
                        onScreenMessage =  "MAG CALIBRATION\nRotate arm through all angles. Press M when done. ";
                        break;
                    case SystemState.RUNNING:
                        onScreenMessage =  "RUNNING (Full Arm Tracker)\nSPACE = Tare Root | M = Mag Cal ";
                        break;
                }
            }
            
            // Only update transforms if we are actually running
            if (currentState == SystemState.RUNNING) 
            {

                // Update Telemetry
                accelMag = latestData.accelMag;
                magNorm = latestData.magNorm;
                driftExposure = latestData.driftExposure;
                magClean = latestData.magClean;
                safeUpperYaw = latestData.safeUpperYaw;
                safeElbowPitch = latestData.safeElbowPitch;
                safeForearmRoll = latestData.safeForearmRoll;
                phoneYawCorrection = latestData.phoneYawCorr;

                // 1. Convert NED to Unity Left-Handed Space
                Quaternion hwUpperWorld   = ConvertToUnitySpace(latestData.qUpper);
                Quaternion hwForearmLocal = ConvertToUnitySpace(latestData.qForearm);
                Quaternion hwHandLocal    = ConvertToUnitySpace(latestData.qHand);

                Quaternion alignedUpper;
                Quaternion alignedForearm;
                Quaternion alignedHand;

                // ---- AUTONOMOUS MOUNT CALIBRATION (Press C in T-Pose) ----
                if (Input.GetKeyDown(KeyCode.C))
                {
                    Debug.Log("<color=magenta>Auto-Calibrating Mount Offsets...</color>");

                    Quaternion mAlignUp = Quaternion.Euler(upperModelAlignment);
                    Quaternion mAlignFo = Quaternion.Euler(forearmModelAlignment);
                    Quaternion mAlignHa = Quaternion.Euler(handModelAlignment);

                    // 1. Upper Arm (Absolute)
                    // The raw sensor includes the user's magnetic heading. We extract it by 
                    // comparing the uncalibrated aligned orientation with the rest pose.
                    Quaternion alignedUpper_old = hwUpperWorld * mAlignUp;
                    Quaternion delta = alignedUpper_old * Quaternion.Inverse(upperRestPose);
                    float headingYaw = delta.eulerAngles.y;
                    
                    // The ideal bone orientation in the magnetic world (rest pose + magnetic heading)
                    Quaternion Q_bone_ideal = Quaternion.Euler(0, headingYaw, 0) * upperRestPose;
                    
                    // The mount correction is now purely the local physical strap error!
                    upperMountCorr = Quaternion.Inverse(hwUpperWorld) * Q_bone_ideal * Quaternion.Inverse(mAlignUp);

                    // 2. Forearm (Relative)
                    // We chain locally using the parent's strap error, NOT absolute world quaternions
                    forearmMountL = Quaternion.Inverse(upperMountCorr);
                    forearmMountR = Quaternion.Inverse(hwForearmLocal)
                                  * upperMountCorr * mAlignUp
                                  * forearmRestPose
                                  * Quaternion.Inverse(mAlignFo);

                    // 3. Hand (Relative)
                    handMountL = Quaternion.Inverse(forearmMountR);
                    handMountR = Quaternion.Inverse(hwHandLocal)
                               * forearmMountR * mAlignFo
                               * handRestPose
                               * Quaternion.Inverse(mAlignHa);

                    // CRITICAL: Reset tare to match the new calibrated frame.
                    // Without this, the old tare (from a previous space press) is in the
                    // pre-calibration coordinate frame, causing a yaw mismatch that can
                    // reach 180° — making rotations appear completely reversed.
                    Quaternion calAlignedUpper = hwUpperWorld * upperMountCorr * mAlignUp;
                    // calAlignedUpper = upperRestPose at this instant (by construction)
                    tareUpper = Quaternion.Euler(0, calAlignedUpper.eulerAngles.y, 0);

                    Debug.Log($"<color=magenta>Mount calibration done.\n" +
                              $"  Upper: mountCorr={upperMountCorr.eulerAngles} rest={upperRestPose.eulerAngles}\n" +
                              $"  Forearm: mountL={forearmMountL.eulerAngles} mountR={forearmMountR.eulerAngles} rest={forearmRestPose.eulerAngles}\n" +
                              $"  Hand: mountL={handMountL.eulerAngles} mountR={handMountR.eulerAngles} rest={handRestPose.eulerAngles}\n" +
                              $"  newTareYaw: {tareUpper.eulerAngles.y:F1}°</color>");
                    onScreenMessage = "Mount offsets calibrated + tare reset.";
                }

                // 2. Unified pipeline (model alignment always active, mount corrections sandwiched inside)
                //    Before C: mount corrections are identity → same as original pipeline
                //    After  C: mount corrections absorb sensor strap misalignment
                Quaternion upperAlignInv  = Quaternion.Inverse(Quaternion.Euler(upperModelAlignment));
                Quaternion forearmAlignInv = Quaternion.Inverse(Quaternion.Euler(forearmModelAlignment));

                alignedUpper   = hwUpperWorld * upperMountCorr * Quaternion.Euler(upperModelAlignment);
                alignedForearm = upperAlignInv * forearmMountL * hwForearmLocal * forearmMountR * Quaternion.Euler(forearmModelAlignment);
                alignedHand    = forearmAlignInv * handMountL * hwHandLocal * handMountR * Quaternion.Euler(handModelAlignment);

                // 3. Taring
                if (doTare) {
                    if (useFull3DTare) {
                        Debug.Log("<color=cyan>Full 3D Tare — all joints captured.</color>");
                        tareUpper   = alignedUpper;
                        tareForearm = alignedForearm;
                        tareHand    = alignedHand;
                    } else {
                        Debug.Log("<color=cyan>Taring Global Heading (Yaw Only).</color>");
                        tareUpper = Quaternion.Euler(0, alignedUpper.eulerAngles.y, 0);
                        // No need to clear tareForearm/tareHand, they are ignored below
                    }
                }
                
                Quaternion finalUpper = Quaternion.Inverse(tareUpper) * alignedUpper;
                Quaternion finalForearm;
                Quaternion finalHand;

                if (useFull3DTare) {
                    finalForearm = Quaternion.Inverse(tareForearm) * alignedForearm;
                    finalHand    = Quaternion.Inverse(tareHand) * alignedHand;
                } else {
                    finalForearm = alignedForearm;
                    finalHand    = alignedHand;
                }

                // 4. Apply to Transforms
                if (upperArmTransform != null) upperArmTransform.localRotation = finalUpper;
                if (forearmTransform != null)  forearmTransform.localRotation  = finalForearm;
                if (handTransform != null)     handTransform.localRotation     = finalHand;

#if UNITY_EDITOR
                if (isRecording && upperArmTransform != null) {
                    animationKeyframes.Add(new KeyframeData { 
                        time = Time.time - recordingStartTime, 
                        rotUp = finalUpper, rotFo = finalForearm, rotHa = finalHand 
                    });
                }
#endif
            }
        }
    }

    private Quaternion ConvertToUnitySpace(Quaternion q) {
        return new Quaternion(-q.y, q.z, -q.x, q.w);
    }



    void OnGUI()
    {
        GUIStyle style = new GUIStyle();
        style.fontSize = 28;
        style.fontStyle = FontStyle.Bold;
        style.alignment = TextAnchor.MiddleCenter;
        style.normal.textColor = (currentState == SystemState.RUNNING) ? Color.green : Color.yellow;

        GUIStyle shadow = new GUIStyle(style) { normal = { textColor = Color.black } };
        Rect rect = new Rect(0, Screen.height - 180, Screen.width, 140);
        Rect shadowRect = new Rect(2, Screen.height - 178, Screen.width, 140);

        string displayMsg = onScreenMessage;
        if (currentState == SystemState.RUNNING) {
            displayMsg = "RUNNING (Full Arm Tracker)\nSPACE = Tare Root | M = Mag Cal";
#if UNITY_EDITOR
            displayMsg += isRecording ? "\n<color=red>● RECORDING (T to Stop)</color>" : "\nR = Record Animation";
#endif
        } else if (currentState == SystemState.MAG_CALIBRATING) {
            displayMsg = "MAG CALIBRATION\nRotate arm through all angles. Press M when done.";
        }

        GUI.Label(shadowRect, displayMsg, shadow);
        GUI.Label(rect, displayMsg, style);
    }

    void ReadSerial()
    {
        System.Text.StringBuilder lineBuffer = new System.Text.StringBuilder(256);
        byte[] payload = new byte[132];

        while (isRunning && serialPort != null && serialPort.IsOpen)
        {
            try {
                while (commandQueue.TryDequeue(out string cmd)) serialPort.Write(cmd);

                if (serialPort.BytesToRead == 0) { Thread.Sleep(1); continue; }

                int b1 = serialPort.ReadByte();

                // BINARY PACKET PARSER (0xAABBCCDD)
                if (b1 == 0xDD)
                {
                    if (!WaitForBytes(3, 100)) continue;
                    int b2 = serialPort.ReadByte(), b3 = serialPort.ReadByte(), b4 = serialPort.ReadByte();
                    
                    if (b2 == 0xCC && b3 == 0xBB && b4 == 0xAA)
                    {
                        if (ReadFully(payload, 132, 200) == 132)
                        {
                            SensorData d = new SensorData();
                            d.accelMag = new float[3];
                            d.magNorm = new float[3];
                            d.driftExposure = new float[3];
                            d.magClean = new bool[3];

                            // Offset shifts by 4 because header was stripped
                            d.timestamp = BitConverter.ToUInt32(payload, 0);
                            
                            d.qUpper = new Quaternion(
                                BitConverter.ToSingle(payload, 8), BitConverter.ToSingle(payload, 12),
                                BitConverter.ToSingle(payload, 16), BitConverter.ToSingle(payload, 4));
                                
                            d.qForearm = new Quaternion(
                                BitConverter.ToSingle(payload, 24), BitConverter.ToSingle(payload, 28),
                                BitConverter.ToSingle(payload, 32), BitConverter.ToSingle(payload, 20));
                                
                            d.qHand = new Quaternion(
                                BitConverter.ToSingle(payload, 40), BitConverter.ToSingle(payload, 44),
                                BitConverter.ToSingle(payload, 48), BitConverter.ToSingle(payload, 36));

                            d.currentState = payload[52];
        
                            for(int i=0; i<3; i++) d.accelMag[i]      = BitConverter.ToSingle(payload, 53 + (i*4));
                            for(int i=0; i<3; i++) d.magNorm[i]       = BitConverter.ToSingle(payload, 65 + (i*4));
                            for(int i=0; i<3; i++) d.driftExposure[i] = BitConverter.ToSingle(payload, 77 + (i*4));
                            
                            d.magClean[0] = payload[89] == 1;
                            d.magClean[1] = payload[90] == 1;
                            d.magClean[2] = payload[91] == 1;

                            // CHANGED OFFSETS: Skips the 24 bytes of ref_accel_mag and time_since_good_accel
                            d.safeUpperYaw    = BitConverter.ToSingle(payload, 116);
                            d.safeElbowPitch  = BitConverter.ToSingle(payload, 120);
                            d.safeForearmRoll = BitConverter.ToSingle(payload, 124);
                            d.phoneYawCorr    = BitConverter.ToSingle(payload, 128);

                            dataQueue.Enqueue(d);
                            while (dataQueue.Count > 5) dataQueue.TryDequeue(out _);
                        }
                    }
                }
                else if (b1 >= 0x20 && b1 < 0x7F) {
                    lineBuffer.Append((char)b1);
                }
                else if (b1 == '\n' || b1 == '\r') {
                    if (lineBuffer.Length > 0) {
                        Debug.Log("[ESP32] " + lineBuffer.ToString());
                        lineBuffer.Clear();
                    }
                }
            } catch (TimeoutException) { }
            catch (Exception e) {
                if (isRunning) Debug.LogError("Serial error: " + e.Message);
            }
        }
    }

    private void HandleTextLine(string line) { Debug.Log("[ESP32] " + line); }

    private bool WaitForBytes(int count, int timeoutMs) {
        int elapsed = 0;
        while (serialPort.BytesToRead < count && isRunning) {
            Thread.Sleep(1); elapsed++;
            if (elapsed >= timeoutMs) return false;
        }
        return isRunning;
    }

    private int ReadFully(byte[] buffer, int count, int timeoutMs) {
        int read=0, elapsed=0;
        while (read < count && isRunning) {
            if (serialPort.BytesToRead > 0) {
                int chunk = serialPort.Read(buffer, read, count-read);
                if (chunk > 0) { read+=chunk; elapsed=0; }
            } else {
                Thread.Sleep(1); elapsed++;
                if (elapsed >= timeoutMs) break;
            }
        }
        return read;
    }

    void OnDisable() { CleanupSerial(); }
    void OnApplicationQuit() { CleanupSerial(); }

    private void CleanupSerial() {
        if (!isRunning && serialPort == null) return;
        isRunning = false;
        if (readThread != null && readThread.IsAlive) {
            readThread.Join(1000);
            if (readThread.IsAlive) readThread.Abort();
        }
        readThread = null;
        if (serialPort != null && serialPort.IsOpen) {
            try { serialPort.Write("q"); serialPort.Close(); } catch {}
        }
        serialPort = null;
    }

#if UNITY_EDITOR
    private void SaveAnimation() {
        if (animationKeyframes.Count == 0 || upperArmTransform == null) return;
        string dir = "Assets/Recordings";
        if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
        string path = $"{dir}/ArmTracking_{DateTime.Now:yyyyMMdd_HHmmss}.anim";
        
        AnimationClip clip = new AnimationClip { frameRate = 60 };
        SetTransformCurves(clip, "", animationKeyframes, 0); // Upper
        SetTransformCurves(clip, "Forearm", animationKeyframes, 1); // Replace "Forearm" with actual hierarchy path if needed
        SetTransformCurves(clip, "Forearm/Hand", animationKeyframes, 2); 
        
        clip.EnsureQuaternionContinuity();
        AssetDatabase.CreateAsset(clip, path);
        AssetDatabase.SaveAssets();
    }

    private void SetTransformCurves(AnimationClip clip, string relativePath, List<KeyframeData> frames, int joint) {
        AnimationCurve cX = new AnimationCurve(), cY = new AnimationCurve(), cZ = new AnimationCurve(), cW = new AnimationCurve();
        foreach (var kf in frames) {
            Quaternion q = joint == 0 ? kf.rotUp : (joint == 1 ? kf.rotFo : kf.rotHa);
            cX.AddKey(kf.time, q.x); cY.AddKey(kf.time, q.y); cZ.AddKey(kf.time, q.z); cW.AddKey(kf.time, q.w);
        }
        clip.SetCurve(relativePath, typeof(Transform), "localRotation.x", cX);
        clip.SetCurve(relativePath, typeof(Transform), "localRotation.y", cY);
        clip.SetCurve(relativePath, typeof(Transform), "localRotation.z", cZ);
        clip.SetCurve(relativePath, typeof(Transform), "localRotation.w", cW);
    }
#endif
}