# Tagging policy

This contract applies to links, uploaded images (including images without OCR),
PDFs and text notes. Content analysis must precede label selection. Instagram
analysis includes the saved gallery and caption; related bookmarks supply
context, not labels to copy blindly.

- A completed ordinary tagging result contains at least five distinct topical
  concepts after spelling normalization and semantic reconciliation. Retain up to
  eight useful concepts. Synonyms and abbreviations count as one concept.
- Prefer existing user tags with their exact names and IDs. Compare exact,
  normalized and semantic matches before creating a new tag. Create a new label
  only when no existing label adequately represents that concept. Keep related
  but distinct concepts separate.
- Never pad the count with unrelated hints, page chrome, synonyms or invented
  subjects. A short initial result gets at most one additional content-aware
  completion pass, within the remaining inference deadline. Additional proposals
  undergo the same existing-vocabulary checks.
- Persist verified partial tags without removing saved AI or human links. If the
  final result still has fewer than five concepts, mark bookmark tagging as failed
  rather than successful. End that queue attempt without blindly restarting the
  entire inference sequence. Explicit re-tagging can be requested later.
- Respect curated selections. Do not create labels outside the allowed set to
  meet the minimum; an insufficient curated selection remains incomplete.
- Empty/invalid responses, semantic-comparison failures, timeouts and unavailable
  vectors must not erase saved tags or allow unchecked duplicates. Cancellation
  must propagate. Missing optional vectors must not block content-based analysis.
- Generate concise factual titles from the saved content. Preserve manual titles
  and human tag assignments.

Changes to these rules require an explicit product decision. Regression tests
must cover completion to five, failure status for incomplete output, vocabulary
reuse, synonym collapse, partial-result preservation and images without OCR.
