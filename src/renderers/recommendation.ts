import type { RenderRequest } from '../layout';
// Import the presentation constants from the leaf module rather than the
// `../sponsored` barrel: the barrel also re-exports the SDK-backed Sponsored
// Provider, and pulling it into the content-script value graph would bundle the
// SDK into the (classic MV3) content script. The content script must never
// contain SDK code.
import { MAX_MESSAGE_LENGTH, SPONSORED_LABEL } from '../sponsored/types';
import type { Renderer } from './types';

/**
 * Sponsored Recommendation Line renderer.
 *
 * The canonical AIRewards UI: a single, lightweight, text-only line that reads
 * like a native footer note. Per ADR 0015 it is never a large promotional block,
 * image ad, or floating/overlay element:
 *
 *   Sponsored · Brand — Short value proposition
 *
 * It is generic and advertiser-agnostic: only the resolved presentation text
 * changes between sponsors; the layout is identical. The renderer contains no
 * business logic, no advertiser assumptions, and no layout/selection decisions
 * — those arrive in the {@link RenderRequest}.
 *
 * Chrome Web Store / trust contract:
 * - Never impersonates the host site; the `Sponsored` label and isolated styling
 *   keep it obviously separate.
 * - Additive only: inserts one host node, never removes/hides/replaces/modifies
 *   any website node or first-party disclaimer.
 * - Text only: no images, thumbnails, shadows, or large containers.
 * - Constrained to a ~20–24px line; never covers responses or blocks typing.
 * - No dismissal required, no continuous animation, no blinking/flashing. A
 *   single subtle fade-in only, and that is skipped under reduced-motion.
 */

/** Marks the renderer's host node so it is always identifiable and removable. */
const HOST_ATTRIBUTE = 'data-airewards-recommendation';

/** Em dash separating the sponsor from its value proposition. */
const SEPARATOR = '\u2014';

/** Middle dot separating the `Sponsored` label from the sponsor name. */
const LABEL_DELIMITER = '\u00B7';

/** Truncate to the value-proposition limit, preserving whole text when short. */
function clampMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length <= MAX_MESSAGE_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_MESSAGE_LENGTH - 1)}\u2026`;
}

function buildHost(request: RenderRequest): HTMLElement {
  const { content, tracking } = request;
  const host = document.createElement('div');
  host.setAttribute(HOST_ATTRIBUTE, '');

  // Closed Shadow DOM isolates styles from the host page and vice versa, so the
  // line cannot inherit or leak styling and cannot be reached into by the page.
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  // Text-only, single line, max ~22px. No background, border, shadow, image, or
  // enclosing box that would read as a promotional block. `currentColor` at
  // reduced opacity keeps it native and obviously secondary. One fade-in,
  // disabled under reduced-motion.
  style.textContent = `
    :host { all: initial; color: inherit; }
    .line {
      display: flex;
      align-items: center;
      gap: 0.4em;
      box-sizing: border-box;
      max-height: 22px;
      margin: 4px 0;
      padding: 0 4px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font: 12px/22px system-ui, -apple-system, sans-serif;
      color: currentColor;
      text-decoration: none;
      cursor: pointer;
      opacity: 0.6;
      animation: airewards-fade-in 200ms ease-out 1;
    }
    .label {
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 10px;
      opacity: 0.85;
    }
    .sponsor { font-weight: 600; }
    .message { overflow: hidden; text-overflow: ellipsis; }
    @keyframes airewards-fade-in {
      from { opacity: 0; }
      to { opacity: 0.6; }
    }
    @media (prefers-reduced-motion: reduce) {
      .line { animation: none; }
    }
  `;

  const line = document.createElement('a');
  line.className = 'line';
  line.setAttribute('href', tracking.href);
  // Open the advertiser in a new tab so the user never loses their AI
  // conversation. `rel="noopener noreferrer"` severs the opener reference,
  // preventing the destination from reaching back into this page (reverse
  // tabnabbing) or leaking the referrer.
  line.setAttribute('target', '_blank');
  line.setAttribute('rel', 'noopener noreferrer');

  // Typography creates the hierarchy: a small uppercase "Sponsored" label, an
  // optional sponsor name in medium weight, then the value proposition.
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = `${SPONSORED_LABEL} ${LABEL_DELIMITER}`;

  const message = document.createElement('span');
  message.className = 'message';

  // When the backend supplies a distinct sponsor name it is shown before the
  // value proposition (`Sponsored · Brand — message`). When the sponsor is the
  // generic disclosure label (no branded sponsor field in the payload yet), the
  // sponsor span is omitted so the line reads `Sponsored · message` rather than
  // duplicating the word. The renderer infers nothing — it only reflects the
  // structurally-provided content.
  if (content.sponsor && content.sponsor !== SPONSORED_LABEL) {
    const sponsor = document.createElement('span');
    sponsor.className = 'sponsor';
    sponsor.textContent = content.sponsor;
    message.textContent = `${SEPARATOR} ${clampMessage(content.message)}`;
    line.append(label, sponsor, message);
  } else {
    message.textContent = clampMessage(content.message);
    line.append(label, message);
  }

  shadow.append(style, line);
  return host;
}

function existingHosts(): HTMLElement[] {
  if (typeof document.querySelectorAll !== 'function') {
    return [];
  }

  return [...document.querySelectorAll<HTMLElement>(`[${HOST_ATTRIBUTE}]`)];
}

function removeExistingHosts(except?: HTMLElement): void {
  for (const existing of existingHosts()) {
    if (existing !== except) {
      existing.remove();
    }
  }
}

export function createRecommendationRenderer(): Renderer {
  // The single inserted host node, or null when nothing is rendered. This is the
  // entire reversibility mechanism: destroy removes exactly this node.
  let host: HTMLElement | null = null;

  function destroy(): void {
    host?.remove();
    host = null;
    removeExistingHosts();
  }

  function render(request: RenderRequest): boolean {
    if (host) {
      if (host.isConnected) {
        removeExistingHosts(host);
        // Already rendered and still in the live DOM — idempotent no-op.
        return true;
      }
      // Host was detached externally (platform cleared the area). Reset so a
      // fresh render can proceed rather than holding a stale reference.
      host = null;
    }

    removeExistingHosts();

    const { layout, content } = request;
    const landmark = document.querySelector(layout.landmarkSelector);

    if (!landmark) {
      // The footer landmark is absent (unsupported layout / not yet mounted).
      // Render nothing rather than guessing a location.
      return false;
    }

    const node = buildHost(request);
    // Additive insertion in the resolved footer space; the landmark and any
    // adjacent first-party disclaimer are left untouched.
    const inserted = landmark.insertAdjacentElement(layout.insertion, node);

    if (!inserted) {
      // Insertion failed (e.g. invalid position relative to a root element).
      // Report failure so no downstream event is emitted.
      return false;
    }

    host = node;
    return true;
  }

  function rerender(request: RenderRequest): boolean {
    destroy();
    return render(request);
  }

  return {
    render,
    destroy,
    rerender,
    isRendered: () => host?.isConnected ?? false,
    getHost: () => (host?.isConnected ? host : null),
  };
}
