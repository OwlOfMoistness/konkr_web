export interface AdminSession { identity: { id: string; role: 'admin' | 'curator' }; csrfToken: string }
export interface AdminClient { request(path: string, init?: RequestInit): Promise<any>; signOut(): Promise<void> }

/** Credentials remain in memory. Public players never pass through this screen. */
export function mountAdmin(root: HTMLElement, onReady: (client: AdminClient, session: AdminSession) => void): void {
  root.replaceChildren(); root.className = 'community-admin';
  const heading = document.createElement('h1'); heading.textContent = 'Map curator access';
  const form = document.createElement('form');
  const label = document.createElement('label'); label.textContent = 'Curator access key';
  const input = document.createElement('input'); input.type = 'password'; input.required = true; input.autocomplete = 'current-password'; label.append(input);
  const button = document.createElement('button'); button.textContent = 'Sign in';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  form.append(label, button); root.append(heading, form, status);
  form.onsubmit = event => {
    event.preventDefault(); button.disabled = true;
    void (async () => {
      const response = await fetch('/api/admin/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: input.value }) });
      input.value = '';
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? 'Sign-in failed');
      const session = data as AdminSession;
      const client: AdminClient = {
        async request(path, init = {}) {
          if (!path.startsWith('/api/admin/')) throw new Error('Invalid curator endpoint');
          const result = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken, ...init.headers } });
          const body = await result.json(); if (!result.ok) throw new Error(body.error ?? 'Request failed'); return body;
        },
        async signOut() { await this.request('/api/admin/session', { method: 'DELETE' }); mountAdmin(root, onReady); },
      };
      onReady(client, session);
    })().catch(error => { input.value = ''; status.textContent = error.message ?? 'Sign-in unavailable'; }).finally(() => { button.disabled = false; });
  };
}
