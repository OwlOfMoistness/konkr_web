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

/** The server separately enforces administrator rights for every read and mutation. */
export function mountCuratorAccess(root: HTMLElement, client: AdminClient): void {
  const heading = document.createElement('h2'); heading.textContent = 'Curator access';
  const note = document.createElement('p'); note.textContent = 'Grant access to an identity from the configured private access provider.';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const list = document.createElement('ul');
  const form = document.createElement('form');
  const identityLabel = document.createElement('label'); identityLabel.textContent = 'Curator identity';
  const identity = document.createElement('input'); identity.required = true; identity.maxLength = 128; identity.pattern = '[A-Za-z0-9_-]+'; identityLabel.append(identity);
  const roleLabel = document.createElement('label'); roleLabel.textContent = 'Access role';
  const role = document.createElement('select');
  for (const value of ['curator', 'admin']) { const option = document.createElement('option'); option.value = value; option.textContent = value; role.append(option); }
  roleLabel.append(role);
  const enabledLabel = document.createElement('label'); const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = true;
  enabledLabel.append(enabled, document.createTextNode(' Access enabled'));
  const save = document.createElement('button'); save.textContent = 'Update curator access';
  form.append(identityLabel, roleLabel, enabledLabel, save); root.replaceChildren(heading, note, list, form, status);
  const refresh = async () => {
    const data = await client.request('/api/admin/curators'); list.replaceChildren();
    for (const curator of data.curators) {
      const item = document.createElement('li'); const button = document.createElement('button'); button.type = 'button';
      button.textContent = `${curator.id} · ${curator.role} · ${curator.enabled ? 'enabled' : 'disabled'}`;
      button.onclick = () => { identity.value = curator.id; role.value = curator.role; enabled.checked = curator.enabled; identity.focus(); };
      item.append(button); list.append(item);
    }
  };
  form.onsubmit = event => {
    event.preventDefault(); save.disabled = true;
    void client.request('/api/admin/curators', { method: 'PUT', body: JSON.stringify({ id: identity.value, role: role.value, enabled: enabled.checked }) })
      .then(refresh).then(() => { status.textContent = 'Curator access updated.'; }).catch(error => { status.textContent = error.message; }).finally(() => { save.disabled = false; });
  };
  void refresh().catch(error => { status.textContent = error.message; });
}
