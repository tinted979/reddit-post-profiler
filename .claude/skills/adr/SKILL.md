---
name: adr
description: Write an architecture decision record in docs/adr/. Use when a change makes a lasting decision that future changes must respect.
---
File: docs/adr/NNNN-kebab-title.md, numbered one above the highest existing file (0001 if
there are none). One page at most. Sections:

- **Status**: Proposed, Accepted, or Superseded by NNNN, with the date. A partial supersession
  names the part, on both ADRs.
- **Context**: the forces at play, including what was tried or measured.
- **Decision**: what we do, in one short paragraph.
- **Consequences**: what gets easier, what gets harder, and what would make us revisit it.

Never delete or rewrite an accepted ADR. Supersede it with a new one and update the old one's
Status. Link the ADR from the CLAUDE.md or .claude/rules/ line it justifies. Agents in CI draft
ADRs in a PR body or comment; ADRs land only in the owner's own PRs (an interactive session may
write them there), since docs/adr/ records the owner's decisions.
