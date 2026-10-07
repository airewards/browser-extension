type DisabledDebugState = {
  provider: unknown;
};

export function diagnosticsEnabled(): false {
  return false;
}

export function getDebugState(): null {
  return null;
}

export function setDebugState(_update: Record<string, unknown>): void {}

export function recordLifecycleEvent(
  _name: string,
  _provider: DisabledDebugState['provider'],
  _details?: Record<string, unknown>,
): void {}

export function recordCommandLifecycleEvents(_events: readonly Record<string, unknown>[]): void {}

export function recordMessageEvent(
  _name: string,
  _provider: DisabledDebugState['provider'],
  _details?: Record<string, unknown>,
): void {}

export function recordContentMessage(
  _messageType: string,
  _provider: DisabledDebugState['provider'],
  _details?: Record<string, unknown>,
): void {}

export function recordBackgroundMessage(
  _messageType: string,
  _provider: DisabledDebugState['provider'],
  _details?: Record<string, unknown>,
): void {}

export function recordPageLifecycleEvent(_name: string, _details?: Record<string, unknown>): void {}

export function recordClickEvent(_name: string, _input: Record<string, unknown>): void {}

export function replaceActiveTimer(_timerName: string, _active: boolean): void {}

export function incrementDebugCounter(_field: string): void {}
