"use client";
import React, { useRef, useMemo, useEffect } from 'react';
import { useGraph, useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { SkeletonUtils } from 'three-stdlib';
import * as THREE from 'three';
const LERP_SPEED = 1;

function createCustomAxes(size = 15) {
  const group = new THREE.Group();
  // X - Red
  const matX = new THREE.LineBasicMaterial({ color: 0xff4444, depthTest: false, depthWrite: false });
  const geomX = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(size, 0, 0)]);
  const lineX = new THREE.Line(geomX, matX);
  lineX.renderOrder = 999;
  group.add(lineX);

  // Y - Green
  const matY = new THREE.LineBasicMaterial({ color: 0x44ff44, depthTest: false, depthWrite: false });
  const geomY = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, size, 0)]);
  const lineY = new THREE.Line(geomY, matY);
  lineY.renderOrder = 999;
  group.add(lineY);

  // Z - Blue
  const matZ = new THREE.LineBasicMaterial({ color: 0x4444ff, depthTest: false, depthWrite: false });
  const geomZ = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, size)]);
  const lineZ = new THREE.Line(geomZ, matZ);
  lineZ.renderOrder = 999;
  group.add(lineZ);

  return group;
}

const RIGHT_FINGER_BONES = [
  "B-thumb01R", "B-thumb02R", "B-thumb03R",
  "B-indexFinger01R", "B-indexFinger02R", "B-indexFinger03R",
  "B-middleFinger01R", "B-middleFinger02R", "B-middleFinger03R",
  "B-ringFinger01R", "B-ringFinger02R", "B-ringFinger03R",
  "B-pinky01R", "B-pinky02R", "B-pinky03R",
  "dummyR"
];
const LEFT_FINGER_BONES = [
  "B-thumb01L", "B-thumb02L", "B-thumb03L",
  "B-indexFinger01L", "B-indexFinger02L", "B-indexFinger03L",
  "B-middleFinger01L", "B-middleFinger02L", "B-middleFinger03L",
  "B-ringFinger01L", "B-ringFinger02L", "B-ringFinger03L",
  "B-pinky01L", "B-pinky02L", "B-pinky03L",
  "dummyL"
];

// Default human biomechanical wrist limits (degrees)
export const DEFAULT_WRIST_LIMITS = {
  flexion: 80,   // max forward bend (+X)
  extension: 70,   // max backward bend (-X)
  radial: 20,   // max radial deviation (-Y, toward thumb)
  ulnar: 30,   // max ulnar deviation (+Y, toward pinky)
  pronation: 90,   // max rotation one way (+Z)
  supination: 90,   // max rotation other way (-Z)
};

export const DEFAULT_ARM_LIMITS = {
  upper: {
    flexion: 180, extension: 60,
    abduction: 180, adduction: 45,
    internal: 90, external: 90
  },
  forearm: {
    flexion: 150, extension: 0,
    radial: 0, ulnar: 0,
    pronation: 90, supination: 90
  }
};

export const BIOMECHANICAL_LIMITS = {
  pinky: { yaw: [-20, 20], mcp: [-10, 90], pip: [0, 100] },
  ring: { yaw: [-15, 15], mcp: [-10, 90], pip: [0, 100] },
  middle: { yaw: [-10, 10], mcp: [-10, 90], pip: [0, 100] },
  index: { yaw: [-20, 20], mcp: [-10, 90], pip: [0, 100] },
  thumb: { yaw: [-60, 15], mcp: [-50, 50], ip: [0, 60], thumbExtra: [0, 80] }
};

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

const DEG2RAD = Math.PI / 180;

/**
 * Apply biomechanical clamps to a wrist quaternion.
 * Converts to Euler XYZ, clamps each axis, converts back.
 */
function clampWristQuat(quatArray, limits) {
  if (!limits) return quatArray;
  const [x, y, z, w] = quatArray;
  const q = new THREE.Quaternion(x, y, z, w).normalize();
  const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ');

  euler.x = clamp(euler.x, -(limits.extension * DEG2RAD), limits.flexion * DEG2RAD);
  euler.y = clamp(euler.y, -(limits.radial * DEG2RAD), limits.ulnar * DEG2RAD);
  euler.z = clamp(euler.z, -(limits.supination * DEG2RAD), limits.pronation * DEG2RAD);

  const clamped = new THREE.Quaternion().setFromEuler(euler);
  return [clamped.x, clamped.y, clamped.z, clamped.w];
}

function clampArmQuat(quatArray, limits) {
  if (!limits) return quatArray;
  const [x, y, z, w] = quatArray;
  const q = new THREE.Quaternion(x, y, z, w).normalize();
  const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ');

  euler.x = clamp(euler.x, -(limits.extension * DEG2RAD), limits.flexion * DEG2RAD);
  if (limits.abduction !== undefined) {
    euler.y = clamp(euler.y, -(limits.abduction * DEG2RAD), limits.adduction * DEG2RAD);
  } else if (limits.radial !== undefined) {
    euler.y = clamp(euler.y, -(limits.radial * DEG2RAD), limits.ulnar * DEG2RAD);
  }
  
  if (limits.internal !== undefined) {
    euler.z = clamp(euler.z, -(limits.external * DEG2RAD), limits.internal * DEG2RAD);
  } else if (limits.pronation !== undefined) {
    euler.z = clamp(euler.z, -(limits.supination * DEG2RAD), limits.pronation * DEG2RAD);
  }

  const clamped = new THREE.Quaternion().setFromEuler(euler);
  return [clamped.x, clamped.y, clamped.z, clamped.w];
}

function getFingerJointLimits(boneName, allLimits) {
  if (!allLimits) return null;
  let fingerKey = null;
  if (boneName.includes("thumb")) fingerKey = "thumb";
  else if (boneName.includes("index")) fingerKey = "index";
  else if (boneName.includes("middle")) fingerKey = "middle";
  else if (boneName.includes("ring")) fingerKey = "ring";
  else if (boneName.includes("pinky")) fingerKey = "pinky";

  if (!fingerKey) return null;
  const fLimits = allLimits[fingerKey];
  if (!fLimits) return null;

  let yawMin = 0, yawMax = 0, pitchMin = 0, pitchMax = 0;

  if (boneName.includes("01")) {
    // MCP
    yawMin = fLimits.yaw[0];
    yawMax = fLimits.yaw[1];
    pitchMin = fLimits.mcp[0];
    pitchMax = fLimits.mcp[1];
  } else if (boneName.includes("02")) {
    // PIP
    if (fingerKey === "thumb") {
      pitchMin = fLimits.ip[0];
      pitchMax = fLimits.ip[1];
    } else {
      pitchMin = fLimits.pip[0];
      pitchMax = fLimits.pip[1];
    }
  } else if (boneName.includes("03") || boneName.includes("end")) {
    // DIP / IP
    if (fingerKey === "thumb") {
      pitchMin = fLimits.thumbExtra ? fLimits.thumbExtra[0] : fLimits.ip[0];
      pitchMax = fLimits.thumbExtra ? fLimits.thumbExtra[1] : fLimits.ip[1];
    } else {
      pitchMin = fLimits.pip[0];
      pitchMax = fLimits.pip[1];
    }
  } else {
    return null;
  }



  return { yawMin, yawMax, pitchMin, pitchMax };
}

function clampFingerEuler(eulerArray, boneName, allLimits, isLeft = false) {
  let [x, y, z] = eulerArray;

  const limits = getFingerJointLimits(boneName, allLimits);
  if (limits) {
    let { yawMin, yawMax, pitchMin, pitchMax } = limits;

    // Mirror asymmetric yaw limits for the left hand
    if (isLeft) {
      const tempMin = yawMin;
      yawMin = -yawMax;
      yawMax = -tempMin;
    }

    if (boneName.includes("thumb")) {
      x = clamp(x, yawMin * DEG2RAD, yawMax * DEG2RAD);
      z = clamp(z, pitchMin * DEG2RAD, pitchMax * DEG2RAD);
    } else {
      // Non-thumb fingers curl inward on negative X, but limits are positive (0 to 90).
      // We negate x for clamping against the positive range, then restore the sign.
      x = -clamp(-x, pitchMin * DEG2RAD, pitchMax * DEG2RAD);
      z = clamp(z, yawMin * DEG2RAD, yawMax * DEG2RAD);
    }
  }

  return [x, y, z];
}

function getSpreadEuler(boneName, isLeft) {
  const s = isLeft ? -1 : 1;
  let x = 0, y = 0, z = 0;

  if (boneName.includes("thumb")) {
    z = -0.2 * s;
  } else if (boneName.includes("index")) {
    z = 0.15 * s;
  } else if (boneName.includes("middle")) {
    z = 0;
  } else if (boneName.includes("ring")) {
    z = -0.15 * s;
  } else if (boneName.includes("pinky")) {
    z = -0.3 * s;
  }

  return [x, y, z];
}

function applyBoneQuaternion(node, quaternionArray, isAligned = false, forceZeroPose = false, isUpperArm = false) {
  if (forceZeroPose) {
    node.quaternion.slerp(node.userData.restQuat || new THREE.Quaternion(), LERP_SPEED);
    return;
  }
  if (!node || !quaternionArray || quaternionArray.length < 4) return;
  const [x, y, z, w] = quaternionArray;
  const imuQ = new THREE.Quaternion(x, y, z, w).normalize();

  // 1. Upper Arm (Absolute World Space)
  // Even if calibrated (isAligned=true), the imuQ for the upper arm is a WORLD rotation.
  // We must convert it into the local space of its parent (the Clavicle/Spine) because 
  // the rigged model's parent bones have complex non-identity world rotations.
  if (isUpperArm && node.userData.worldRestQuat && node.parent) {
    const parentWorldInv = node.userData.parentWorldRestQuat.clone().invert();
    const newLocalQ = parentWorldInv.multiply(imuQ);
    node.quaternion.slerp(newLocalQ, LERP_SPEED);
    return;
  } 

  // 2. Fully Calibrated Forearm / Hand (Mount offsets handled everything)
  if (isAligned) {
    node.quaternion.slerp(imuQ, LERP_SPEED);
    return;
  }
  
  // 3. Pre-Calibration: Forearm / Hand (Relative Local Space)
  if (!isUpperArm && node.userData.restQuat) {
    // Treat imuQ as a Local Delta
    const targetQ = node.userData.restQuat.clone().multiply(imuQ);
    node.quaternion.slerp(targetQ, LERP_SPEED);
    return;
  }

  // Final fallback
  node.quaternion.slerp(imuQ, LERP_SPEED);
}

function applyBoneEuler(node, eulerArray) {
  if (!node || !eulerArray || eulerArray.length < 3) return;
  const [x, y, z] = eulerArray;
  const targetQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-x, y, z, 'XYZ'));

  if (LERP_SPEED >= 1) {
    node.quaternion.copy(targetQ);
  } else {
    node.quaternion.slerp(targetQ, LERP_SPEED);
  }
}

export function CombinedArmRig({
  //leftHandSensorData,
  //rightHandSensorData,
  rigDataRef,
  restRotationR = [3.15, 2.29, 3.15],
  restRotationL = [3.15, -2.29, 3.15],
  // Biomechanical constraints — pass null/undefined to disable clamping
  wristLimits = DEFAULT_WRIST_LIMITS,
  armLimits = DEFAULT_ARM_LIMITS,
  fingerLimits = BIOMECHANICAL_LIMITS,
  onRestPosesLoaded,
  ...props
}) {
  const group = useRef();
  const { scene } = useGLTF('/HumanCharacterDummy_M.glb');
  const clone = useMemo(() => {
    const c = SkeletonUtils.clone(scene);
    c.updateMatrixWorld(true);
    c.traverse(node => {
      if (node.isBone) {
        node.userData.restQuat = node.quaternion.clone();
        
        // Save world rest orientation to properly apply world-space IMU rotations
        const worldQuat = new THREE.Quaternion();
        node.getWorldQuaternion(worldQuat);
        node.userData.worldRestQuat = worldQuat;
        
        if (node.parent) {
          const parentWorldQuat = new THREE.Quaternion();
          node.parent.getWorldQuaternion(parentWorldQuat);
          node.userData.parentWorldRestQuat = parentWorldQuat;
        }
      }
    });
    return c;
  }, [scene]);
  const { nodes } = useGraph(clone);

  // Robustly find the correct main bones (ignoring twist bones like .001)
  /*   useEffect(() => {
      if (rightHandSensorData?.palm) {
         //console.log("ArmModel recv data, isAligned:", rightHandSensorData.palm.isAligned, "forceZero:", rightHandSensorData.palm.forceZeroPose);
      }
    }, [rightHandSensorData?.palm]); */

  const armBones = useMemo(() => {
    if (!nodes) return {};
    const all = Object.values(nodes);
    // Updated regex to catch '.R', 'R', and 'R$' suffixes used by HumanCharacterDummy_M
    const isR = (n) => /\.R_|_R_|R_|\.R|R$/i.test(n.name);
    const isL = (n) => /\.L_|_L_|L_|\.L|L$/i.test(n.name);
    const isMain = (n) => !n.name.includes('001') && !n.name.includes('end');

    const bones = {
      rUpper: all.find(n => n.name.toLowerCase().includes('upper') && isR(n)),
      rForearm: all.find(n => n.name.toLowerCase().includes('forearm') && isR(n) && isMain(n)),
      rHand: all.find(n => n.name.toLowerCase().includes('hand') && !n.name.toLowerCase().includes('prop') && isR(n)),
      lUpper: all.find(n => n.name.toLowerCase().includes('upper') && isL(n)),
      lForearm: all.find(n => n.name.toLowerCase().includes('forearm') && isL(n) && isMain(n)),
      lHand: all.find(n => n.name.toLowerCase().includes('hand') && !n.name.toLowerCase().includes('prop') && isL(n)),
    };
    /* //console.log("ArmModel extracted bones:", {
      rUpper: bones.rUpper?.name + " (isBone: " + bones.rUpper?.isBone + ")",
      rForearm: bones.rForearm?.name + " (isBone: " + bones.rForearm?.isBone + ")",
      rHand: bones.rHand?.name + " (isBone: " + bones.rHand?.isBone + ")"
    });
    //console.log("Available upper nodes:", Object.keys(nodes).filter(k => k.toLowerCase().includes("upper")));
    //console.log("Direct lookup:", !!nodes['B-upperArm.R']);
     */return bones;
  }, [nodes]);

  const axesHelpersRef = useRef([]);

  // Capture the absolute rest pose of every bone from the GLTF before any rotations are applied
  useEffect(() => {
    if (!nodes) return;
    axesHelpersRef.current = [];

    // Create World-Space Axes Helpers for the main arm bones to avoid skeletal scale/shear distortions
    [armBones.rUpper, armBones.rForearm, armBones.rHand, armBones.lUpper, armBones.lForearm, armBones.lHand].forEach(bone => {
      if (bone) {
        const axesHelper = createCustomAxes(15);
        if (group.current) group.current.add(axesHelper);
        axesHelpersRef.current.push({ helper: axesHelper, bone });
      }
    });

    if (onRestPosesLoaded && armBones.rUpper) {
      onRestPosesLoaded({
        right: {
          upper: armBones.rUpper?.userData?.restQuat?.clone() || new THREE.Quaternion(),
          upperWorld: armBones.rUpper?.userData?.worldRestQuat?.clone() || new THREE.Quaternion(),
          forearm: armBones.rForearm?.userData?.restQuat?.clone() || new THREE.Quaternion(),
          hand: armBones.rHand?.userData?.restQuat?.clone() || new THREE.Quaternion(),
        },
        left: {
          upper: armBones.lUpper?.userData?.restQuat?.clone() || new THREE.Quaternion(),
          upperWorld: armBones.lUpper?.userData?.worldRestQuat?.clone() || new THREE.Quaternion(),
          forearm: armBones.lForearm?.userData?.restQuat?.clone() || new THREE.Quaternion(),
          hand: armBones.lHand?.userData?.restQuat?.clone() || new THREE.Quaternion(),
        }
      });
    }

    return () => {
      // Cleanup axes helpers on unmount
      axesHelpersRef.current.forEach(({ helper }) => {
        if (helper.parent) helper.parent.remove(helper);
      });
    };
  }, [nodes, onRestPosesLoaded, armBones, clone]);

  useFrame(() => {
    if (!nodes) return;
    const rightHandSensorData = rigDataRef?.current?.right;
    const leftHandSensorData = rigDataRef?.current?.left;
    // ── RIGHT ARM BONES ──────────────────────────────────────
    const forceZero = rightHandSensorData?.palm?.forceZeroPose || false;

    const rUpper = armBones.rUpper;
    if (rUpper) {
      const isManual = rightHandSensorData?.palm?.manualOverrides?.upperArm;
      const uQuat = isManual ? rightHandSensorData?.palm?.manualValues?.upperArm : rightHandSensorData?.palm?.upperArm;
      if (uQuat && Array.isArray(uQuat) || forceZero) {
        const isAligned = isManual ? false : rightHandSensorData?.palm?.isAligned;
        const uQ = armLimits && !isAligned && !forceZero
          ? clampArmQuat(uQuat, armLimits.upper)
          : uQuat;
        applyBoneQuaternion(rUpper, uQ, isAligned, forceZero, true);
      } else {
        rUpper.quaternion.slerp(rUpper.userData.restQuat || new THREE.Quaternion(), LERP_SPEED);
      }
    }

    const rForearm = armBones.rForearm;
    if (rForearm) {
      const isManual = rightHandSensorData?.palm?.manualOverrides?.forearm;
      const fQuat = isManual ? rightHandSensorData?.palm?.manualValues?.forearm : rightHandSensorData?.palm?.forearm;
      if (fQuat && Array.isArray(fQuat) || forceZero) {
        const isAligned = isManual ? false : rightHandSensorData?.palm?.isAligned;
        const fQ = armLimits && !isAligned && !forceZero
          ? clampArmQuat(fQuat, armLimits.forearm)
          : fQuat;
        applyBoneQuaternion(rForearm, fQ, isAligned, forceZero, false);
      } else {
        rForearm.quaternion.slerp(rForearm.userData.restQuat || new THREE.Quaternion(), LERP_SPEED);
      }
    }

    const rHand = armBones.rHand;
    if (rHand) {
      const isManual = rightHandSensorData?.palm?.manualOverrides?.hand;
      const hQuat = isManual ? rightHandSensorData?.palm?.manualValues?.hand : (rightHandSensorData?.palm?.hand || rightHandSensorData?.palm);
      if (hQuat && Array.isArray(hQuat) || forceZero) {
        const isAligned = isManual ? false : rightHandSensorData?.palm?.isAligned;
        const palmQ = wristLimits && !isAligned && !forceZero
          ? clampWristQuat(hQuat, wristLimits)
          : hQuat;
        applyBoneQuaternion(rHand, palmQ, isAligned, forceZero, false);
      } else {
        rHand.quaternion.slerp(rHand.userData.restQuat || new THREE.Quaternion(), LERP_SPEED);
      }
    }

    // ── RIGHT FINGER BONES ────────────────────────────────────
    const hasRF = Array.isArray(rightHandSensorData?.fingers) && rightHandSensorData.fingers.length > 0;
    RIGHT_FINGER_BONES.forEach((name, i) => {
      const bone = nodes[name];
      if (!bone) return;
      if (hasRF && rightHandSensorData.fingers[i]) {
        const fe = fingerLimits
          ? clampFingerEuler(rightHandSensorData.fingers[i], name, fingerLimits)
          : rightHandSensorData.fingers[i];
        applyBoneEuler(bone, fe);
      } else {
        applyBoneEuler(bone, getSpreadEuler(name, false));

      }
    });

    // ── LEFT ARM BONES ───────────────────────────────────────
    const forceZeroL = leftHandSensorData?.palm?.forceZeroPose || false;

    const lUpper = armBones.lUpper;
    if (lUpper) {
      const isManual = leftHandSensorData?.palm?.manualOverrides?.upperArm;
      const uQuat = isManual ? leftHandSensorData?.palm?.manualValues?.upperArm : leftHandSensorData?.palm?.upperArm;
      if (uQuat && Array.isArray(uQuat) || forceZeroL) {
        const isAligned = isManual ? false : leftHandSensorData?.palm?.isAligned;
        const uQ = armLimits && !isAligned && !forceZeroL
          ? clampArmQuat(uQuat, armLimits.upper)
          : uQuat;
        applyBoneQuaternion(lUpper, uQ, isAligned, forceZeroL, true);
      } else {
        lUpper.quaternion.slerp(lUpper.userData.restQuat || new THREE.Quaternion(), LERP_SPEED);
      }
    }

    const lForearm = armBones.lForearm;
    if (lForearm) {
      const isManual = leftHandSensorData?.palm?.manualOverrides?.forearm;
      const fQuat = isManual ? leftHandSensorData?.palm?.manualValues?.forearm : leftHandSensorData?.palm?.forearm;
      if (fQuat && Array.isArray(fQuat) || forceZeroL) {
        const isAligned = isManual ? false : leftHandSensorData?.palm?.isAligned;
        const fQ = armLimits && !isAligned && !forceZeroL
          ? clampArmQuat(fQuat, armLimits.forearm)
          : fQuat;
        applyBoneQuaternion(lForearm, fQ, isAligned, forceZeroL, false);
      } else {
        lForearm.quaternion.slerp(lForearm.userData.restQuat || new THREE.Quaternion(), LERP_SPEED);
      }
    }

    const lHand = armBones.lHand;
    if (lHand) {
      const isManual = leftHandSensorData?.palm?.manualOverrides?.hand;
      const hQuat = isManual ? leftHandSensorData?.palm?.manualValues?.hand : (leftHandSensorData?.palm?.hand || leftHandSensorData?.palm);
      if (hQuat && Array.isArray(hQuat) || forceZeroL) {
        const isAligned = isManual ? false : leftHandSensorData?.palm?.isAligned;
        const palmQ = wristLimits && !isAligned && !forceZeroL
          ? clampWristQuat(hQuat, wristLimits)
          : hQuat;
        applyBoneQuaternion(lHand, palmQ, isAligned, forceZeroL, false);
      } else {
        lHand.quaternion.slerp(lHand.userData.restQuat || new THREE.Quaternion(), LERP_SPEED);
      }
    }

    // Update global axes helpers
    axesHelpersRef.current.forEach(({ helper, bone }) => {
      // Extract the absolute world position and rotation of the bone, ignoring its scale completely
      const pos = new THREE.Vector3();
      const rot = new THREE.Quaternion();
      bone.matrixWorld.decompose(pos, rot, new THREE.Vector3());

      if (group.current) {
        group.current.worldToLocal(pos);
        const groupRot = new THREE.Quaternion();
        group.current.getWorldQuaternion(groupRot);
        rot.premultiply(groupRot.invert());
      }

      helper.position.copy(pos);
      helper.quaternion.copy(rot);
    });

    // ── LEFT FINGER BONES ─────────────────────────────────────
    const hasLF = Array.isArray(leftHandSensorData?.fingers) && leftHandSensorData.fingers.length > 0;
    LEFT_FINGER_BONES.forEach((name, i) => {
      const bone = nodes[name];
      if (!bone) return;
      if (hasLF && leftHandSensorData.fingers[i]) {
        const fe = fingerLimits
          ? clampFingerEuler(leftHandSensorData.fingers[i], name, fingerLimits, true)
          : leftHandSensorData.fingers[i];
        applyBoneEuler(bone, fe);
      } else {
        applyBoneEuler(bone, getSpreadEuler(name, true));
      }
    });
  });

  return (
    <group ref={group} {...props} dispose={null}>
      <primitive object={nodes.RootNode || clone} />
    </group>
  );
}

export function ArmModel({
  //leftHandSensorData,
  //rightHandSensorData,
  rigDataRef,
  restRotationR,
  restRotationL,
  wristLimits,
  fingerLimits,
  onRestPosesLoaded,
}) {
  return (
    <group>
      <CombinedArmRig
        //leftHandSensorData={leftHandSensorData}
        //rightHandSensorData={rightHandSensorData}
        rigDataRef={rigDataRef}
        restRotationR={restRotationR}
        restRotationL={restRotationL}
        wristLimits={wristLimits}
        fingerLimits={fingerLimits}
        onRestPosesLoaded={onRestPosesLoaded}
        position={[0, -1.4, 0]}
        scale={[1, 1, 1]}
      />
    </group>
  );
}

useGLTF.preload('/HumanCharacterDummy_M.glb');