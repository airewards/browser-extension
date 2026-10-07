/**
 * Platform adapter layer.
 *
 * Each supported AI website is described by one {@link PlatformAdapter}. The
 * adapters are pure, isolated from business logic, and read-only: they identify
 * a platform from URL information and report page readiness from required root
 * elements. They never read business content, never inject elements, never
 * mutate the DOM, and never change styles.
 *
 * New platforms (Gemini, Grok, Perplexity, DeepSeek, Copilot, Cursor, Kiro,
 * Windsurf, ...) are added by registering another adapter, with no change to the
 * shared logic.
 */

/** Stable, typed identifier for every supported platform plus the fallback. */
export const Platform = {
  CHATGPT: 'CHATGPT',
  CLAUDE: 'CLAUDE',
  GEMINI: 'GEMINI',
  GROK: 'GROK',
  UNKNOWN: 'UNKNOWN',
} as const;

export type Platform = (typeof Platform)[keyof typeof Platform];

/** A supported platform; excludes the `UNKNOWN` fallback. */
export type SupportedPlatform = Exclude<Platform, typeof Platform.UNKNOWN>;

/** The subset of `Location` an adapter is allowed to inspect: URL only. */
export type PageLocation = Pick<Location, 'hostname'>;

/**
 * The subset of `Document` adapters and anchor providers may read for readiness
 * and anchor discovery. Constrained to structural queries; consumers must not
 * read business content from these nodes, attach listeners, create observers, or
 * mutate anything.
 */
export type PageDocument = Pick<Document, 'readyState' | 'querySelector' | 'querySelectorAll'>;

export type AnchorPosition = 'above_input' | 'below_input' | 'end_of_thread';

/**
 * Result of validating a candidate anchor. Only `valid` anchors are eligible for
 * later use; everything else is rejected with a reason for diagnostics.
 */
export type AnchorValidationStatus = 'valid' | 'rejected';

/**
 * A candidate location where an advertisement may *eventually* be placed.
 *
 * This is a description only: discovery reads the DOM but never inserts elements,
 * mutates styles, attaches listeners, or renders anything.
 */
export interface Anchor {
  /** Stable identifier for the anchor within its platform. */
  readonly id: string;
  /** The platform the anchor belongs to. */
  readonly platform: SupportedPlatform;
  /** Where, relative to the conversation, the anchor sits. */
  readonly position: AnchorPosition;
  /** Detection confidence in the range [0, 1]; used for ranking. */
  readonly confidence: number;
  /** Whether the candidate passed validation. */
  readonly status: AnchorValidationStatus;
}

export interface PlatformAdapter {
  /** The platform this adapter identifies. Never `UNKNOWN`. */
  readonly platform: SupportedPlatform;

  /**
   * Returns true when the location belongs to this platform. Relies on
   * URL/host information only and must not read page contents.
   */
  detect(location: PageLocation): boolean;

  /**
   * Returns true when the page has finished initializing enough that anchor
   * discovery could run later. Reads only structural readiness (document state
   * and required root elements) using stable selectors; never inspects business
   * content and never mutates the DOM.
   */
  isReady(document: PageDocument): boolean;
}
