// Ported from localpages@4d43f26 `src/client/code-copy.js` (sha1 b27cfbac…).
//
// Copy-to-clipboard buttons on every fenced code block in the rendered doc.
// Scoped to .markdown-body so the source-viewer modal's <pre> is left alone.
//
// Only the query root changes (upstream reads `document`); the flash timings, the
// secure-context fallback and the markup are untouched.
export function initCodeCopy(root) {
  var doc = root.ownerDocument || document;
  var pres = root.querySelectorAll('.markdown-body pre');
  pres.forEach(function(pre) {
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy-btn';
    btn.textContent = 'Copy';
    btn.setAttribute('aria-label', 'Copy code to clipboard');
    var resetTimer = null;
    function flash(state, label) {
      btn.classList.remove('copied', 'failed');
      btn.classList.add(state);
      btn.textContent = label;
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = setTimeout(function() {
        btn.classList.remove('copied', 'failed');
        btn.textContent = 'Copy';
      }, 1500);
    }
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      var code = pre.querySelector('code');
      var text = (code || pre).textContent || '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(function() { flash('copied', 'Copied!'); })
          .catch(function() { fallbackCopy(text); });
      } else {
        fallbackCopy(text);
      }
    });
    function fallbackCopy(text) {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      doc.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = doc.execCommand('copy'); } catch (err) { ok = false; }
      doc.body.removeChild(ta);
      flash(ok ? 'copied' : 'failed', ok ? 'Copied!' : 'Failed');
    }
    pre.appendChild(btn);
  });
  // The buttons live inside the rendered tree, so they are discarded with it on the
  // next render; nothing to unwind.
  return function destroy() {};
}
