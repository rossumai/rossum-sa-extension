import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { formatBytes } from './contentMeta.js';

export default function PreviewPane({ preview }) {
  const [url, setUrl] = useState(null);
  const blob = preview && preview.blob;
  useEffect(() => {
    if (!blob) { setUrl(null); return undefined; }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);

  if (!preview) return null;
  const ct = preview.contentType || '';
  const isImage = /^image\//i.test(ct);
  const isPdf = /\bpdf\b/i.test(ct);

  return (
    <div class="rawjson-preview">
      {url ? (
        <div class="rawjson-preview-actions">
          <a class="rawjson-preview-btn" href={url} download={preview.filename}>Download</a>
          <a class="rawjson-preview-btn" href={url} target="_blank" rel="noopener">Open in browser tab</a>
        </div>
      ) : null}
      {url && isImage ? <img class="rawjson-preview-img" src={url} alt={preview.filename} /> : null}
      {url && isPdf ? <iframe class="rawjson-preview-pdf" src={url} title={preview.filename} /> : null}
      {!isImage && !isPdf ? (
        <div class="rawjson-preview-card">
          <div class="rawjson-preview-name">{preview.filename}</div>
          <div class="rawjson-preview-meta">{ct || 'unknown type'} · {formatBytes(preview.size)}</div>
        </div>
      ) : null}
    </div>
  );
}
