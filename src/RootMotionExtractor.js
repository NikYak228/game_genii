import * as THREE from 'three';

const ROOT_MOTION_THRESHOLD = 0.1;

/**
 * Utility to inspect the AnimationClips and report root-motion heavy clips.
 * @param {THREE.AnimationClip[]} animationClips
 * @param {string} rootBoneName
 * @param {number} [threshold]
 * @returns {Array<{ name: string, distance: number }>}
 */
export function diagnoseAnimationClips(animationClips, rootBoneName, threshold = ROOT_MOTION_THRESHOLD) {
  if (!Array.isArray(animationClips) || !rootBoneName) {
    console.warn('[RootMotion] diagnoseAnimationClips: invalid arguments');
    return [];
  }

  const flagged = [];
  for (const clip of animationClips) {
    if (!clip || !Array.isArray(clip.tracks)) continue;
    const track = findRootTrack(clip.tracks, rootBoneName);
    if (!track) continue;
    const delta = getTrackDelta(track);
    const distance = delta.length();
    if (distance > threshold) {
      flagged.push({ name: clip.name, distance });
      console.warn(`[RootMotion] Clip "${clip.name}" contains ${distance.toFixed(3)} units of root motion.`);
    }
  }
  return flagged;
}

export class RootMotionExtractor {
  static extract(model, clip, rootBoneName, threshold = ROOT_MOTION_THRESHOLD) {
    if (!clip) throw new Error('RootMotionExtractor.extract requires an AnimationClip.');
    const tracks = clip.tracks || [];
    const rootBone = model?.getObjectByName?.(rootBoneName) ?? null;
    const trackIndex = tracks.findIndex((track) => isTrackForBone(track, rootBoneName, rootBone));

    if (trackIndex === -1) {
      return {
        inPlaceClip: clip,
        rootMotionVelocity: new THREE.Vector3(),
        hasRootMotion: false,
      };
    }

    const track = tracks[trackIndex];
    const deltaPosition = getTrackDelta(track);
    const hasRootMotion = deltaPosition.length() > threshold;

    if (!hasRootMotion) {
      return {
        inPlaceClip: clip,
        rootMotionVelocity: new THREE.Vector3(),
        hasRootMotion: false,
      };
    }

    const inPlaceClip = clip.clone();
    const clonedTrack = inPlaceClip.tracks[trackIndex];

    const horizontalDelta = deltaPosition.clone();
    horizontalDelta.y = 0;
    const velocity = horizontalDelta.clone().divideScalar(Math.max(clip.duration, Number.EPSILON));

    bakeOutRootMotion(clonedTrack, horizontalDelta, clip.duration);

    return {
      inPlaceClip,
      rootMotionVelocity: velocity,
      hasRootMotion: true,
    };
  }
}

function findRootTrack(tracks, rootBoneName, rootBone = null) {
  return tracks.find((track) => isTrackForBone(track, rootBoneName, rootBone));
}

function isTrackForBone(track, rootBoneName, rootBone) {
  if (!track?.name || !rootBoneName) return false;
  if (!track.name.endsWith('.position')) return false;
  const token = extractNodeToken(track.name);
  const normalizedToken = normalizeName(token);
  const normalizedRoot = normalizeName(rootBoneName);
  if (normalizedToken === normalizedRoot) return true;
  if (rootBone) {
    const normalizedUuid = normalizeName(rootBone.uuid);
    if (normalizedToken === normalizedUuid) return true;
  }
  return false;
}

function normalizeName(value) {
  return (value || '').replace(/\s+/g, '').toLowerCase();
}

function extractNodeToken(trackName) {
  const withoutSuffix = trackName.replace(/\.position$/, '');
  const segments = withoutSuffix.split(/[/.]/).filter(Boolean);
  return segments[segments.length - 1] || withoutSuffix;
}

function getTrackDelta(track) {
  const values = track?.values;
  if (!values || values.length < 3) return new THREE.Vector3();
  const start = new THREE.Vector3(values[0], values[1], values[2]);
  const lastIndex = values.length - 3;
  const end = new THREE.Vector3(values[lastIndex], values[lastIndex + 1], values[lastIndex + 2]);
  return end.sub(start);
}

function bakeOutRootMotion(track, deltaPosition, duration) {
  if (!track || !track.values || !track.times || duration <= 0) return;
  const values = track.values;
  const times = track.times;
  for (let i = 0; i < times.length; i++) {
    const alpha = THREE.MathUtils.clamp(times[i] / duration, 0, 1);
    const offset = deltaPosition.clone().multiplyScalar(alpha);
    const vIndex = i * 3;
    values[vIndex] -= offset.x;
    values[vIndex + 1] -= offset.y;
    values[vIndex + 2] -= offset.z;
  }
}
