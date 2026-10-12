// Stand-in for the Electron preload so the panel can be previewed in a browser.
window.nodeKiller = {
  ready() { setTimeout(() => this._cb && this._cb({ ...window.__SNAPSHOT__, t: Date.now() }), 0); },
  onSnapshot(cb) { this._cb = cb; },
  killGroup: async (pid) => console.log('kill', pid),
  reveal: async (f) => console.log('reveal', f),
  copy: async (t) => console.log('copy', t),
  openMenu: () => console.log('menu'),
};
