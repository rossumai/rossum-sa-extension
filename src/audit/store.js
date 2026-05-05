import { signal } from '@preact/signals';

export const domain = signal('');
export const token = signal('');

export const results = signal([]);
export const total = signal(null);
export const page = signal(1);
export const pageSize = signal(50);

// object_type is required by the API; default to annotation as the most common
// audit subject. Only the filters documented by the audit log API reference
// (object_type + action) are supported here — any other narrowing happens
// client-side via `quickSearch`.
export const filters = signal({
  object_type: 'annotation',
  action: '',
});

export const loading = signal(false);
export const error = signal(null);

// Feature availability for this tenant. The audit-log endpoint may be
// disabled either because the caller lacks a required role or because
// the feature isn't included in the org's subscription. Detected from
// 403/404 responses on the first call.
//   'unknown'      — not yet probed
//   'available'    — at least one successful fetch
//   'unavailable'  — endpoint refused with 403/404
export const availability = signal('unknown');
export const availabilityMessage = signal(null);
export const availabilityStatus = signal(null);

export const expandedRow = signal(null);

// Substring search applied client-side over the currently loaded page only.
// Distinct from the server-side filters because the audit log API restricts
// which fields/values are filterable; this lets users narrow visible rows
// by anything they see in the table.
export const quickSearch = signal('');

// Filter values the API has confirmed as valid via "Available options: [...]"
// in error responses. Keyed coarsely:
//   constraints.value.action[<object_type>] = ['update-status', ...]
//   constraints.value.object_type = ['annotation', 'document', 'user']
// This is authoritative — the docs may be outdated, but the running API isn't.
export const constraints = signal({
  object_type: null,
  action: {},
});
