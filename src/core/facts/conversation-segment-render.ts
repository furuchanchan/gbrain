/**
 * Conversation-segment rendering for the extract-conversation-facts
 * pipeline: the message/segment shapes plus the bounded-input renderers.
 *
 * Lives in `src/core/facts/` (not `src/commands/`) on the
 * `conversation-types.ts` precedent: consumers that only need the render
 * contract don't pull in the command's CLI flag surface.
 * `src/commands/extract-conversation-facts.ts` re-exports every name
 * verbatim so its existing importers keep working unchanged.
 */

export interface ConversationMessage {
  speaker: string;
  /** ISO 8601 timestamp parsed from the rendered message line. */
  timestamp: string;
  text: string;
}

export interface ConversationSegment {
  messages: ConversationMessage[];
  startIso: string;
  endIso: string;
  participants: string[];
}

/**
 * Bound on a single provider input rendered from one segment. Not a loss
 * cap: a segment that renders over the limit goes through
 * `renderSegmentsForExtraction`, which splits it into inputs that each stay
 * under this bound.
 */
export const SEGMENT_TEXT_CHAR_LIMIT = 6500;

export function renderSegmentForExtraction(
  pageTitle: string,
  segment: ConversationSegment,
): string {
  const header = [
    `Page: ${pageTitle}`,
    `Conversation between ${segment.participants.join(' and ')} from ${segment.startIso} to ${segment.endIso}`,
    '---',
  ].join('\n');
  const body = segment.messages
    .map((m) => `${m.speaker} (${m.timestamp}): ${m.text}`)
    .join('\n');
  return `${header}\n${body}`;
}

/**
 * #6508 — the segment rendered for extraction, split into bounded inputs so
 * no tail is silently dropped. Messages stay in source order; a message that
 * alone exceeds the body budget is cut at a char boundary and its
 * continuation carries the same `Speaker (timestamp):` prefix plus a `…`
 * marker, so attribution and quote grounding survive the split.
 */
export function renderSegmentsForExtraction(
  pageTitle: string,
  segment: ConversationSegment,
): string[] {
  const header = [
    `Page: ${pageTitle}`,
    `Conversation between ${segment.participants.join(' and ')} from ${segment.startIso} to ${segment.endIso}`,
  ].join('\n');
  const body = segment.messages
    .map((m) => `${m.speaker} (${m.timestamp}): ${m.text}`)
    .join('\n');
  if (`${header}\n---\n${body}`.length <= SEGMENT_TEXT_CHAR_LIMIT) return [`${header}\n---\n${body}`];
  // Reserve room for the `Segment part k/N` line present only when split.
  const budget = Math.max(64, SEGMENT_TEXT_CHAR_LIMIT - header.length - 34);
  const parts: string[] = [];
  let cur = '';
  for (const m of segment.messages) {
    const prefix = `${m.speaker} (${m.timestamp}): `;
    let rest = `${prefix}${m.text}`;
    while (rest.length > 0) {
      const room = budget - (cur ? cur.length + 1 : 0);
      if (rest.length <= room) {
        cur = cur ? `${cur}\n${rest}` : rest;
        break;
      }
      if (room <= 0) {
        parts.push(cur);
        cur = '';
        continue;
      }
      cur = cur ? `${cur}\n${rest.slice(0, room)}` : rest.slice(0, room);
      rest = `${prefix}…${rest.slice(room)}`;
    }
  }
  if (cur) parts.push(cur);
  return parts.map((partBody, i) => `${header}\nSegment part ${i + 1} of ${parts.length}\n---\n${partBody}`);
}
