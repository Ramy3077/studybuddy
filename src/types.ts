// Shared domain types for StudyBuddy.

export type SourceType = 'slides' | 'notes' | 'transcript';

// How a source is used by the *concept* pipeline. Lectures (a/b) are the
// primary teaching material; tutorials/revision/assessment-support are still
// ingested + retrievable but de-prioritised during concept extraction.
export type LectureKind =
  | 'lecture'
  | 'notes'
  | 'tutorial'
  | 'revision'
  | 'assessment_support';

export interface DiscoveredFile {
  /** Absolute path on disk. */
  vaultPath: string;
  /** Path relative to the vault root (for the discovery report). */
  relPath: string;
  sourceType: SourceType;
  module: string;
  title: string;
  /** Lecture code like "2a", "7a", or null when undeterminable. */
  code: string | null;
  /** Lecture letter normalised to a/b/c, or null. */
  lecture: string | null;
  week: number | null;
  kind: LectureKind;
  /** lecture a/b (or notes) = primary; tutorials/revision/etc = false. */
  isPrimary: boolean;
  /** For combined recordings like "9a _ 9b", the list of covered codes. */
  coveredCodes: string[];
  /** Human-readable note for the discovery report. */
  note: string;
}

export type SlideLocator = { kind: 'slides'; start_page: number; end_page: number };
export type TextLocator = {
  kind: 'text';
  chunk_index: number;
  char_start: number;
  char_end: number;
  heading?: string;
};
export type Locator = SlideLocator | TextLocator;

export interface PreparedChunk {
  chunkIndex: number;
  text: string;
  locator: Locator;
}

// ---- Persisted-row shapes (subset of columns the app reads) ----------------

export interface SourceRow {
  id: string;
  source_type: SourceType;
  module: string;
  title: string;
  code: string | null;
  week: number | null;
  vault_path: string;
  metadata: Record<string, unknown>;
}

export interface ChunkRow {
  id: string;
  source_id: string;
  chunk_index: number;
  text: string;
  locator: Locator;
}

export interface RetrievedChunk extends ChunkRow {
  /** cosine distance (0 = identical). Lower is closer. */
  distance: number;
  source_title: string;
  source_type: SourceType;
  source_code: string | null;
  week: number | null;
}

export interface ConceptDraft {
  name: string;
  description: string;
  key_facts: string[];
  difficulty: number; // 1-5
  week: number | null;
  source_chunk_ids: string[]; // must be real chunk ids
}

export type QuestionType = 'mcq' | 'free_form';

export interface GeneratedQuestion {
  type: QuestionType;
  question: string;
  /** For MCQ: 4 option strings. For free_form: null. */
  options: string[] | null;
  /** For MCQ: full option text. For free_form: the model/ideal answer. */
  correct_answer: string;
  explanation: string;
  /** Verbatim 5-30 word substring copied from one of the source chunks. */
  evidence_quote: string;
  source_chunk_ids: string[];
}
