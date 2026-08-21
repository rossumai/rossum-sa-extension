import { h, render } from 'preact';
import App from './components/App.jsx';

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  render(<App tab={tab} />, document.getElementById('app')!);
})();
