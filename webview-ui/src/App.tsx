/**
 * Phase 0 — empty scaffold.
 *
 * Responsibilities:
 *  - Send `ready` to the host on mount so pending messages are flushed.
 *  - Display the pi status received from the host.
 *  - Provide a placeholder that will be replaced by the real chat UI in Phase 2.
 */
import React, { useEffect, useState } from 'react';
import type { HostMessage, PiStatus } from '@shared/messages';
import { vscode } from './vscodeApi';
import './App.css';

export default function App() {
  const [piStatus, setPiStatus] = useState<PiStatus | null>(null);

  useEffect(() => {
    // Notify the host that the webview has mounted and is ready to receive messages.
    vscode.postMessage({ type: 'ready' });

    const handler = (event: MessageEvent<HostMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'piStatus':
          setPiStatus(msg.status);
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  return (
    <div className="app">
      <PiStatusBanner status={piStatus} />
      <p className="placeholder-hint">Sqowe Wingman — chat coming soon</p>
    </div>
  );
}

function PiStatusBanner({ status }: { status: PiStatus | null }) {
  if (status === null) {
    return <div className="status-banner status-banner--idle">Locating pi…</div>;
  }

  if (status.kind === 'not-found') {
    return (
      <div className="status-banner status-banner--error">
        <strong>pi not found.</strong>
        <br />
        Install with: <code>npm install -g @earendil-works/pi-coding-agent</code>
      </div>
    );
  }

  if (status.kind === 'version-warning') {
    return (
      <div className="status-banner status-banner--warning">
        <strong>pi {status.version}</strong> — below tested minimum ({status.minimum}).
        Consider updating.
      </div>
    );
  }

  return (
    <div className="status-banner status-banner--ok">
      <strong>pi {status.version}</strong> ready
    </div>
  );
}
