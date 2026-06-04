/**
 * The shared result envelope every source returns.
 *
 * A tool never returns a bare value. It returns DATA plus:
 *  - bronregels: where the data came from — provenance the chat model can cite.
 *  - datagaten:  honest "this is missing / stale" markers instead of a guess.
 *
 * See docs/adr/0004-tools-return-data-primitives.md.
 */

export type DataStatus = "measured" | "stale" | "unknown";

/** A source-attribution line: what was read, from where, when. */
export interface Bronregel {
  source: string; // e.g. "EuRIS"
  subject: string; // e.g. "Waterstand Kaub"
  value: string; // compact, human-readable result
  observedAt?: string; // ISO timestamp of the reading
  note?: string; // which API / family produced it
}

/** An explicit data-gap: better an honest gap than an invented number. */
export interface Datagat {
  code: string; // stable machine code, e.g. "euris-waterstand-no-candidates"
  message: string; // human-readable (Dutch, the skipper's language)
  severity: "info" | "caution" | "blocking";
}

export interface SourceResult<T> {
  data?: T; // absent when there's nothing to return
  bronregels: Bronregel[];
  datagaten: Datagat[];
}
