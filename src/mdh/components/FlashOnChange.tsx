import { h, type ComponentChildren } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';

// Renders `value` and briefly highlights it when it changes between renders.
// First mount never flashes, so static initial values stay visually quiet.
export default function FlashOnChange({ value }: { value: ComponentChildren }) {
  const firstRef = useRef(true);
  const prevRef = useRef(value);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      prevRef.current = value;
      return;
    }
    if (prevRef.current !== value) {
      prevRef.current = value;
      setTick((t) => t + 1);
    }
  }, [value]);
  if (tick === 0) return <span>{value}</span>;
  return (
    <span key={tick} class="flash-value">
      {value}
    </span>
  );
}
