export function compileTimeline(scenes) {
  let cursorMs = 0;
  const compiled = scenes.map((scene, index) => {
    if (!Number.isFinite(scene.durationMs) || scene.durationMs <= 0) {
      throw new Error(`Scene "${scene.id ?? index}" must have a positive durationMs`);
    }

    const item = {
      ...scene,
      index,
      startMs: cursorMs,
      endMs: cursorMs + scene.durationMs,
    };
    cursorMs = item.endMs;
    return item;
  });

  return {
    scenes: compiled,
    durationMs: cursorMs,
  };
}

export function sceneAt(timeline, timeMs) {
  const bounded = Math.max(0, Math.min(timeMs, Math.max(0, timeline.durationMs - 0.001)));
  return timeline.scenes.find(scene => bounded >= scene.startMs && bounded < scene.endMs)
    ?? timeline.scenes.at(-1);
}

export function frameToMilliseconds(frame, fps) {
  return (frame * 1000) / fps;
}

export function totalFrames(durationMs, fps) {
  return Math.ceil((durationMs * fps) / 1000);
}

export function formatTimestamp(milliseconds, includeMilliseconds = true) {
  const totalMs = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  const base = [hours, minutes, seconds]
    .map(value => String(value).padStart(2, '0'))
    .join(':');
  return includeMilliseconds ? `${base}.${String(millis).padStart(3, '0')}` : base;
}
