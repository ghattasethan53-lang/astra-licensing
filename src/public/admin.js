/**
 * Admin console for the Astra licensing service.
 *
 * The token is held in memory for the life of the tab and sent as a Bearer header. It is
 * deliberately not written to localStorage, so closing the tab ends the session.
 */

let token = '';

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? `Request failed (${response.status})`);
  }
  return response.json();
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function statusPill(row) {
  if (row.revoked) return '<span class="pill pill-revoked">revoked</span>';
  if (row.device_hash) return '<span class="pill pill-claimed">claimed</span>';
  return '<span class="pill pill-free">available</span>';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function refresh() {
  const data = await api('/api/v1/admin/keys');
  $('stat-total').textContent = data.stats.total;
  $('stat-claimed').textContent = data.stats.claimed;
  $('stat-revoked').textContent = data.stats.revoked;

  const rows = data.keys.map((row) => `
    <tr>
      <td class="mono">${row.id}</td>
      <td class="mono">${escapeHtml(row.key_masked)}</td>
      <td>${statusPill(row)}</td>
      <td class="mono hide-sm">${row.device_hash ? escapeHtml(row.device_hash.slice(0, 12)) + '…' : '—'}</td>
      <td class="hide-sm">${formatDate(row.claimed_at)}</td>
      <td class="hide-sm">${escapeHtml(row.note ?? '')}</td>
      <td class="actions">
        <button class="btn btn-ghost" data-reset="${row.id}" ${row.device_hash ? '' : 'disabled'}>Reset device</button>
        <button class="btn btn-ghost" data-revoke="${row.id}" data-to="${row.revoked ? 'false' : 'true'}">
          ${row.revoked ? 'Restore' : 'Revoke'}
        </button>
        <button class="btn btn-ghost btn-danger" data-delete="${row.id}">Delete</button>
      </td>
    </tr>`).join('');

  $('rows').innerHTML = rows;
  $('empty').classList.toggle('hidden', data.keys.length > 0);
}

$('signin').addEventListener('click', async () => {
  token = $('token').value.trim();
  const error = $('login-error');
  error.classList.add('hidden');
  try {
    await refresh();
    $('login').classList.add('hidden');
    $('console').classList.remove('hidden');
  } catch (e) {
    error.textContent = e.message;
    error.classList.remove('hidden');
  }
});

$('token').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('signin').click();
});

$('generate').addEventListener('click', async () => {
  const button = $('generate');
  button.disabled = true;
  try {
    const data = await api('/api/v1/admin/keys', {
      method: 'POST',
      body: JSON.stringify({
        count: Number($('count').value) || 1,
        note: $('note').value.trim() || null,
      }),
    });
    $('generated-keys').textContent = data.keys.join('\n');
    $('generated').classList.remove('hidden');
    await refresh();
  } catch (e) {
    alert(e.message);
  } finally {
    button.disabled = false;
  }
});

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('generated-keys').textContent);
    $('copy').textContent = 'Copied';
    setTimeout(() => { $('copy').textContent = 'Copy all'; }, 1500);
  } catch {
    // Clipboard access can be blocked; the keys are on screen to select manually either way.
    alert('Could not copy automatically — select the keys and copy them manually.');
  }
});

$('reset-all').addEventListener('click', async () => {
  if (!confirm('Unbind every key from its device?

The keys survive and can be claimed again, but '
    + 'everyone currently playing will be booted back to the main menu and asked to activate.')) return;
  const button = $('reset-all');
  button.disabled = true;
  try {
    const data = await api('/api/v1/admin/reset-all', { method: 'POST' });
    alert(`${data.reset} key(s) unbound.`);
    await refresh();
  } catch (e) {
    alert(e.message);
  } finally {
    button.disabled = false;
  }
});

// Row actions are delegated, so re-rendering the table does not need listeners reattached.
$('rows').addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.dataset.reset) {
      if (!confirm('Unbind this key from its device? The customer can then activate on a new machine.')) return;
      await api(`/api/v1/admin/keys/${target.dataset.reset}/reset`, { method: 'POST' });
    } else if (target.dataset.delete) {
      if (!confirm('Delete this key permanently?

It cannot be recovered, and whoever is using it '
        + 'will be booted back to the main menu and asked for a new key.')) return;
      await api(`/api/v1/admin/keys/${target.dataset.delete}/delete`, { method: 'POST' });
    } else if (target.dataset.revoke) {
      const revoked = target.dataset.to === 'true';
      if (revoked && !confirm('Revoke this key? It will stop working on the next activation.')) return;
      await api(`/api/v1/admin/keys/${target.dataset.revoke}/revoke`, {
        method: 'POST',
        body: JSON.stringify({ revoked }),
      });
    }
    await refresh();
  } catch (e) {
    alert(e.message);
  }
});
