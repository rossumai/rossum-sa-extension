import { h } from 'preact';
import * as store from '../store.js';
import { downloadFile } from '../chat.js';

function fmtBytes(n: number) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FilesStrip() {
  const files = store.files.value;
  if (!files.length) return null;
  return (
    <div class="fabry-files">
      {files.map((f) => (
        <span class="fabry-file">
          <span class="fabry-file-name" title={f.filename}>{f.filename}</span>
          <span class="fabry-file-size">{fmtBytes(f.size)}</span>
          <button type="button" class="fabry-file-dl" title="Download" onClick={() => downloadFile(f.filename)}>{'⤓'}</button>
        </span>
      ))}
    </div>
  );
}
