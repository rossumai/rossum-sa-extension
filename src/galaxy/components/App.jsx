import { h } from 'preact';
import { useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { graph, loading, loadedCount, error, selectedNodeId, hoveredNodeId, visibleTypes } from '../store.js';
import { createScene } from '../scene.js';
import Legend from './Legend.jsx';
import NavGuide from './NavGuide.jsx';
import DetailCard from './DetailCard.jsx';

export default function App({ connected }) {
  const hostRef = useRef(null);
  const sceneRef = useRef(null);

  // Mount the imperative scene once, on connect; tear it down on unmount/disconnect.
  useLayoutEffect(() => {
    if (!connected || !hostRef.current) return undefined;
    const scene = createScene(hostRef.current);
    sceneRef.current = scene;
    scene.onHover((id) => { hoveredNodeId.value = id; });
    scene.onClick((id) => { selectedNodeId.value = id; });
    scene.setData(graph.value);
    scene.setVisibleTypes(visibleTypes.value);
    return () => { scene.destroy(); sceneRef.current = null; };
  }, [connected]);

  // Push graph updates into the live scene.
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.setData(graph.value);
  }, [graph.value]);

  // Push visibility changes into the live scene.
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.setVisibleTypes(visibleTypes.value);
  }, [visibleTypes.value]);

  if (!connected) {
    return (
      <div class="app-root">
        <div class="empty-state">Not connected — open a Rossum page and click Galaxy in the extension popup.</div>
      </div>
    );
  }

  return (
    <div class="app-root">
      <div class="galaxy-stage">
        <div class="galaxy-canvas" ref={hostRef}></div>
        <Legend />
        <NavGuide />
        <DetailCard />
        {loading.value && (
          <div class="galaxy-loading">
            <span class="galaxy-spinner" aria-hidden="true"></span>
            <span>Loading your organization{'…'}</span>
            {loadedCount.value > 0 && (
              <span class="galaxy-loading-count">{loadedCount.value} objects loaded</span>
            )}
          </div>
        )}
        {error.value && <div class="galaxy-error">{error.value}</div>}
      </div>
    </div>
  );
}
