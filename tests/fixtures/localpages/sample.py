"""A tiny Python file used by the source-viewer modal demo.

Click the `sample.py` link in `index.md` or `architecture.md` and this file's
contents render in a syntax-highlighted modal. In static export mode the same
content is embedded as a hidden <template> element, so the modal works offline.
"""

from dataclasses import dataclass
from typing import Iterable


@dataclass(frozen=True)
class Page:
    name: str
    body: str

    def word_count(self) -> int:
        return len(self.body.split())


def total_words(pages: Iterable[Page]) -> int:
    return sum(p.word_count() for p in pages)


if __name__ == "__main__":
    docs = [
        Page("index", "welcome to localpages a small markdown preview tool"),
        Page("architecture", "pipeline modules wide tables anchors"),
    ]
    print(f"{len(docs)} pages, {total_words(docs)} words")
