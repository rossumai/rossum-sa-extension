import { auditLogs } from './auditLogs.jsx';

// One entry today; the shape exists to host more sources, so the registry is keyed by
// string rather than by the single literal key — which is also what lets the shell's
// components index it with a signal value.
export const SOURCES: Record<string, any> = { audit: auditLogs };
export const SOURCE_ORDER = ['audit'] as const;
