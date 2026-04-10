import { h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export default function SidebarResizer() {
  const resizerRef = useRef(null);

  useEffect(() => {
    const resizer = resizerRef.current;
    const sidebar = document.getElementById('sidebar');
    if (!resizer || !sidebar) return;

    chrome.storage.local.get(['mdhSidebarWidth'], ({ mdhSidebarWidth }) => {
      if (mdhSidebarWidth) {
        sidebar.style.width = mdhSidebarWidth + 'px';
        sidebar.style.minWidth = mdhSidebarWidth + 'px';
      }
    });

    function onMouseDown(e) {
      const startX = e.clientX;
      const startWidth = sidebar.getBoundingClientRect().width;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        const newWidth = Math.max(160, Math.min(600, startWidth + e.clientX - startX));
        sidebar.style.width = newWidth + 'px';
        sidebar.style.minWidth = newWidth + 'px';
      }

      function onUp() {
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        chrome.storage.local.set({ mdhSidebarWidth: sidebar.getBoundingClientRect().width });
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    resizer.addEventListener('mousedown', onMouseDown);
    return () => resizer.removeEventListener('mousedown', onMouseDown);
  }, []);

  return <div ref={resizerRef} class="sidebar-resizer"></div>;
}
