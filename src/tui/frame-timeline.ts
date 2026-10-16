/**
 * Renderer-owned motion clock. OpenTUI's Timeline engine calls requestLive
 * while a timeline is playing, so animation frames are not a setInterval.
 */
import {
  createTimeline,
  getTimelineEngine,
  type CliRenderer,
} from "@opentui/core";

/** Start a looping timeline. `onFrame` receives the frame delta in ms. */
export function startFrameTimeline(
  renderer: CliRenderer,
  onFrame: (deltaMs: number) => void,
): () => void {
  const target = { cycle: 0 };
  let stopped = false;
  const timeline = createTimeline(
    { duration: 1_000, loop: true, autoplay: true },
    renderer,
  );
  timeline.add(target, {
    cycle: 1,
    duration: 1_000,
    ease: "linear",
    loop: true,
    onUpdate: (animation) => {
      if (stopped) return;
      const deltaMs = animation.deltaTime;
      if (!(deltaMs > 0)) return;
      onFrame(deltaMs);
    },
  });
  return () => {
    if (stopped) return;
    stopped = true;
    timeline.pause();
    try {
      getTimelineEngine(renderer).unregister(timeline);
    } catch {
      // Renderer already destroyed or the engine detached with it.
    }
  };
}
