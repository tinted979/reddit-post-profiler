---
name: adr
description: Write an architecture decision record in docs/adr/. Use when a change makes a lasting decision that future changes must respect.
---
File: docs/adr/NNNN-kebab-title.md, numbered one above the highest existing file (0001 if
there are none). One page at most. Sections:

- **Status**: Proposed, Accepted, or Superseded by NNNN.
- **Context**: the forces at play, including what was tried or measured.
- **Decision**: what we do, in one short paragraph.
- **Consequences**: what gets easier, what gets harder, and what would make us revisit it.

Never delete or rewrite an accepted ADR. Supersede it with a new one and update the old one's
Status. Link the ADR from the CLAUDE.md line it justifies. Agents draft ADRs in a PR body or
comment; the owner commits them, since docs/adr/ records the owner's decisions.
