# Section state labels

A long-lived document rots unevenly. Some sections were checked against the code
this morning; others were written from notes months ago and nobody has looked
since. A state label records which is which, per section.

## 1. Overview

<state-label state="verified" date="2026-08-17" />

Put the element on the first line below a heading:

```markdown
## 1. Overview

<state-label state="verified" date="2026-08-17" />
```

`localpages` lifts it onto the heading row as a badge, counts it in the tally
under the document title, and mirrors it as a dot in the sidebar.

The fenced example above is *not* turned into a badge. Detection runs on the
parsed document, where a fence is never an HTML block.

## 2. The five states

<state-label state="ready" date="2026-08-14" />

| `state` | Meaning |
|---|---|
| `rough-draft` | Written from notes, or still a stub. Checked against nothing. |
| `in-progress` | Being written or reworked right now. |
| `ready` | Complete and self-consistent, but not yet checked against the code. |
| `verified` | Every claim traced to a file, command output, or API response, on the date shown. |
| `stale` | Was true; the implementation has since moved. Warns the reader off without deleting the content. |

`ready` and `verified` are both green. They are told apart by icon shape and
fill weight, not by hue alone, so they survive greyscale printing and
colour-blindness.

## 3. Attributes

<state-label state="in-progress" date="2026-08-16" />

| Attribute | Required | Notes |
|---|---|---|
| `state` | yes | One of the five above. Anything else is an error. |
| `date` | no | Rendered verbatim — `localpages` never reformats it. Omit it and no date shows. |
| `label` | no | Overrides the display text, for custom wording or another language. |

The date is the day the state **last changed** — not the day the text was last
edited. Write `date="—"` when that day cannot be established.

## 4. Implementation reference

<state-label state="stale" date="2026-08-02" />

`stale` does not mean delete. Behaviour that still runs somewhere stays
documented — the label warns the reader off without removing the content.

## 5. Operations

<state-label state="rough-draft" date="—" />

Labels are optional. A section with no label is legal and simply means "state
not assessed", so the convention can be adopted one section at a time.

## 6. When something is wrong

<state-label state="in-progress" label="Being rewritten" />

A browser renders an unknown element as nothing at all, so mistakes are reported
rather than swallowed. Each of these prints a warning naming the file and line,
and marks the spot in the page:

- a `state` that isn't one of the five, or no `state` at all
- the paired form `<state-label …></state-label>`, or attributes wrapped across
  several lines — neither parses as an HTML block
- an element that doesn't directly follow a heading

## 7. Unlabelled section

This heading carries no label, and renders exactly as it always has — no badge,
no dot in the sidebar, no change to its anchor.
