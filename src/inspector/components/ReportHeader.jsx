import { h } from 'preact';
import Overview from './Overview.jsx';
import Timeline from './Timeline.jsx';

// One header card: identity/overview + the status timeline (spec §5.1).
export default function ReportHeader() {
  return (
    <div class="inspector-rephead">
      <Overview />
      <Timeline />
    </div>
  );
}
