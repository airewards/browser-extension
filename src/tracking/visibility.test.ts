import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisibilityTracker } from './visibility';

interface ObserverInstance {
  callback: IntersectionObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

const observers: ObserverInstance[] = [];
const listeners = new Map<string, EventListener>();

class TestIntersectionObserver {
  callback: IntersectionObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
}

function emitIntersection(ratio: number): void {
  const observer = observers[0];
  if (!observer) throw new Error('observer missing');
  observer.callback(
    [{ intersectionRatio: ratio, isIntersecting: ratio > 0 }] as IntersectionObserverEntry[],
    observer as unknown as IntersectionObserver,
  );
}

describe('createVisibilityTracker', () => {
  const onVisible = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    observers.length = 0;
    listeners.clear();
    onVisible.mockReset();
    vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
    vi.stubGlobal('window', {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string) => {
        listeners.delete(type);
      }),
    });
    vi.stubGlobal('document', {
      hidden: false,
      visibilityState: 'visible',
      hasFocus: vi.fn(() => true),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  it('waits for 50% visible, visible document, focused window, and 5 continuous seconds', () => {
    const tracker = createVisibilityTracker({
      element: {} as Element,
      durationMs: 5_000,
      onVisible,
    });

    expect(observers[0]?.observe).toHaveBeenCalledTimes(1);

    emitIntersection(0.49);
    vi.advanceTimersByTime(5_000);
    expect(onVisible).not.toHaveBeenCalled();

    emitIntersection(0.5);
    vi.advanceTimersByTime(4_999);
    expect(onVisible).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onVisible).toHaveBeenCalledTimes(1);

    tracker.disconnect();
    expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('restarts the timer when visibility is interrupted before 5 seconds', () => {
    createVisibilityTracker({
      element: {} as Element,
      durationMs: 5_000,
      onVisible,
    });

    emitIntersection(0.75);
    vi.advanceTimersByTime(3_000);
    emitIntersection(0.25);
    vi.advanceTimersByTime(5_000);
    expect(onVisible).not.toHaveBeenCalled();

    emitIntersection(0.75);
    vi.advanceTimersByTime(5_000);
    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it('restarts the timer when the window loses focus', () => {
    let focused = true;
    vi.stubGlobal('document', {
      hidden: false,
      visibilityState: 'visible',
      hasFocus: vi.fn(() => focused),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    createVisibilityTracker({
      element: {} as Element,
      durationMs: 5_000,
      onVisible,
    });

    emitIntersection(0.75);
    vi.advanceTimersByTime(3_000);
    focused = false;
    listeners.get('blur')?.(new Event('blur'));
    vi.advanceTimersByTime(5_000);
    expect(onVisible).not.toHaveBeenCalled();

    focused = true;
    listeners.get('focus')?.(new Event('focus'));
    vi.advanceTimersByTime(5_000);
    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it('discards accumulated qualification time when the user becomes idle', () => {
    createVisibilityTracker({
      element: {} as Element,
      durationMs: 5_000,
      idleTimeoutMs: 2_000,
      onVisible,
    });

    emitIntersection(0.75);
    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(5_000);
    expect(onVisible).not.toHaveBeenCalled();

    listeners.get('mousemove')?.(new Event('mousemove'));
    vi.advanceTimersByTime(1_999);
    listeners.get('keydown')?.(new Event('keydown'));
    vi.advanceTimersByTime(1_999);
    listeners.get('wheel')?.(new Event('wheel'));
    vi.advanceTimersByTime(1_001);
    expect(onVisible).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it('fires at most once after a valid impression is observed', () => {
    createVisibilityTracker({
      element: {} as Element,
      durationMs: 5_000,
      onVisible,
    });

    emitIntersection(1);
    vi.advanceTimersByTime(5_000);
    emitIntersection(0);
    emitIntersection(1);
    vi.advanceTimersByTime(5_000);

    expect(onVisible).toHaveBeenCalledTimes(1);
  });
});
