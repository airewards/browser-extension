export interface VisibilityTracker {
  disconnect(): void;
}

export interface VisibilityTrackerOptions {
  readonly element: Element;
  readonly durationMs: number;
  readonly idleTimeoutMs?: number;
  readonly onVisible: () => void;
}

const MIN_VISIBLE_RATIO = 0.5;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'] as const;

export function createVisibilityTracker({
  element,
  durationMs,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  onVisible,
}: VisibilityTrackerOptions): VisibilityTracker {
  let visibleEnough = false;
  let completed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idle = false;

  function pageCanCount(): boolean {
    return (
      !idle && !document.hidden && document.visibilityState === 'visible' && document.hasFocus()
    );
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleTimer(): void {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idle = true;
      evaluate();
    }, idleTimeoutMs);
  }

  function markActivity(): void {
    idle = false;
    armIdleTimer();
    evaluate();
  }

  function evaluate(): void {
    if (completed) {
      clearTimer();
      return;
    }

    if (!visibleEnough || !pageCanCount()) {
      clearTimer();
      return;
    }

    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        if (!completed && visibleEnough && pageCanCount()) {
          completed = true;
          onVisible();
        }
      }, durationMs);
    }
  }

  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[entries.length - 1];
      visibleEnough =
        Boolean(entry?.isIntersecting) && (entry?.intersectionRatio ?? 0) >= MIN_VISIBLE_RATIO;
      evaluate();
    },
    { threshold: [MIN_VISIBLE_RATIO] },
  );

  observer.observe(element);

  document.addEventListener('visibilitychange', evaluate);
  window.addEventListener('focus', evaluate);
  window.addEventListener('blur', evaluate);
  for (const eventType of ACTIVITY_EVENTS) {
    window.addEventListener(eventType, markActivity, { passive: true });
  }

  armIdleTimer();

  return {
    disconnect(): void {
      clearTimer();
      clearIdleTimer();
      observer.disconnect();
      document.removeEventListener('visibilitychange', evaluate);
      window.removeEventListener('focus', evaluate);
      window.removeEventListener('blur', evaluate);
      for (const eventType of ACTIVITY_EVENTS) {
        window.removeEventListener(eventType, markActivity);
      }
    },
  };
}
