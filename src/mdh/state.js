const listeners = {};

const state = {
  domain: '',
  token: '',
  collections: [],
  selectedCollection: null,
  records: [],
  skip: 0,
  limit: 30,
  activePanel: 'data',
  loading: false,
  error: null,
};

export function get(key) {
  return state[key];
}

export function set(updates) {
  const changed = [];
  for (const [key, value] of Object.entries(updates)) {
    if (state[key] !== value) {
      state[key] = value;
      changed.push(key);
    }
  }
  for (const key of changed) {
    const eventName = key + 'Changed';
    if (listeners[eventName]) {
      for (const fn of listeners[eventName]) {
        fn(state[key]);
      }
    }
  }
}

export function on(eventName, fn) {
  if (!listeners[eventName]) listeners[eventName] = [];
  listeners[eventName].push(fn);
}

export function off(eventName, fn) {
  if (!listeners[eventName]) return;
  listeners[eventName] = listeners[eventName].filter((f) => f !== fn);
}
