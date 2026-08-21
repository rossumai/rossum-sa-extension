import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { loading } from '../store.js';

const SHOW_DELAY = 300;

export default function LoadingOverlay() {
  const isLoading = loading.value;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isLoading) {
      const timer = setTimeout(() => setVisible(true), SHOW_DELAY);
      return () => clearTimeout(timer);
    }
    setVisible(false);
  }, [isLoading]);

  return (
    <div class={'loading-overlay' + (visible ? ' loading-overlay-visible' : '')}>
      <div class="spinner"></div>
    </div>
  );
}
