/**
 * Unit tests for AgentController Phase 8 (trust + multi-root folder) logic.
 *
 * Covers:
 *  - setTrustDecision → the --approve / --no-approve flag passed to the transport.
 *  - initActiveFolderPath / setActiveFolderPath / activeFolderPath self-heal.
 *  - forceRestart guards (not-found / disposed).
 *  - _serializedStart: concurrent starts/restarts never spawn two transports at once.
 *  - The active-folder watcher: folder removal triggers switch / restart / teardown.
 *
 * RpcTransport is replaced with an instrumented fake so no real pi process spawns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Fake transport (instrumented) ──────────────────────────────────────────

const { FakeTransport } = vi.hoisted(() => {
  class FakeTransport {
    static instances: FakeTransport[] = [];
    static concurrentStarts = 0;
    static maxConcurrentStarts = 0;
    static startDelayMs = 0;

    piPath: string;
    cwd: string;
    extraArgs: string[];
    outputChannel: unknown = undefined;
    isRunning = false;
    disposed = false;

    constructor(piPath: string, cwd: string, extraArgs: string[] = []) {
      this.piPath = piPath;
      this.cwd = cwd;
      this.extraArgs = extraArgs;
      FakeTransport.instances.push(this);
    }

    async start(): Promise<void> {
      FakeTransport.concurrentStarts++;
      FakeTransport.maxConcurrentStarts = Math.max(
        FakeTransport.maxConcurrentStarts,
        FakeTransport.concurrentStarts,
      );
      if (FakeTransport.startDelayMs > 0) {
        await new Promise((r) => setTimeout(r, FakeTransport.startDelayMs));
      } else {
        await Promise.resolve();
      }
      FakeTransport.concurrentStarts--;
      this.isRunning = true;
    }

    onEvent(_cb: unknown) { return { dispose() {} }; }
    onClose(_cb: unknown) { return { dispose() {} }; }
    async send() { return { type: 'response', success: true, data: {} }; }
    dispose() { this.disposed = true; this.isRunning = false; }

    static reset(): void {
      FakeTransport.instances = [];
      FakeTransport.concurrentStarts = 0;
      FakeTransport.maxConcurrentStarts = 0;
      FakeTransport.startDelayMs = 0;
    }
  }
  return { FakeTransport };
});

vi.mock('./rpc-transport', () => ({ RpcTransport: FakeTransport }));
vi.mock('vscode', async () => import('../__mocks__/vscode'));

import * as vscode from 'vscode';
import { AgentController } from './controller';
import type { WingmanViewProvider } from '../webview/provider';
import type { PiStatus } from '../shared/messages';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FOUND: PiStatus = { kind: 'found', path: '/usr/bin/pi' } as unknown as PiStatus;

function setFolders(paths: string[]): void {
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = paths.map((p) => ({
    uri: { fsPath: p },
    name: p,
  }));
}

function fireFoldersChanged(removedPaths: string[]): void {
  (vscode as unknown as {
    __fireWorkspaceFoldersChanged: (e: { removed: unknown[] }) => void;
  }).__fireWorkspaceFoldersChanged({
    removed: removedPaths.map((p) => ({ uri: { fsPath: p }, name: p })),
  });
}

function makeProvider() {
  return {
    postCommandsList: vi.fn(),
    postSessionStats: vi.fn(),
    postAgentEvent: vi.fn(),
    postAgentStatus: vi.fn(),
    postSessionReset: vi.fn(),
    postSessionMessages: vi.fn(),
  };
}

function makeController() {
  const controller = new AgentController();
  const provider = makeProvider();
  controller.setProvider(provider as unknown as WingmanViewProvider);
  return { controller, provider };
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  FakeTransport.reset();
  (vscode as unknown as { __resetWorkspace: () => void }).__resetWorkspace();
});

// ─── setTrustDecision → transport flag ──────────────────────────────────────

describe('AgentController.setTrustDecision → spawn flag', () => {
  it('passes no flag when there are no project resources', async () => {
    const { controller } = makeController();
    controller.setTrustDecision({ kind: 'no-resources' });
    setFolders(['/a']);
    await controller.start(FOUND);
    expect(FakeTransport.instances[0].extraArgs).toEqual([]);
  });

  it('passes --approve for a saved trusted decision', async () => {
    const { controller } = makeController();
    controller.setTrustDecision({ kind: 'saved', trusted: true });
    setFolders(['/a']);
    await controller.start(FOUND);
    expect(FakeTransport.instances[0].extraArgs).toEqual(['--approve']);
  });

  it('passes --no-approve for a saved untrusted decision', async () => {
    const { controller } = makeController();
    controller.setTrustDecision({ kind: 'saved', trusted: false });
    setFolders(['/a']);
    await controller.start(FOUND);
    expect(FakeTransport.instances[0].extraArgs).toEqual(['--no-approve']);
  });

  it('passes --approve / --no-approve for temporary decisions', async () => {
    const { controller } = makeController();
    controller.setTrustDecision({ kind: 'temporary', trusted: true });
    setFolders(['/a']);
    await controller.start(FOUND);
    expect(FakeTransport.instances[0].extraArgs).toEqual(['--approve']);
  });

  it('clears a stale flag when a later decision needs a prompt', async () => {
    const { controller } = makeController();
    controller.setTrustDecision({ kind: 'saved', trusted: true });
    controller.setTrustDecision({ kind: 'needs-prompt' });
    setFolders(['/a']);
    await controller.start(FOUND);
    expect(FakeTransport.instances[0].extraArgs).toEqual([]);
  });
});

// ─── initActiveFolderPath / setActiveFolderPath / activeFolderPath ──────────

describe('AgentController active folder', () => {
  it('initActiveFolderPath sets the folder and fires the change event (no restart)', () => {
    const { controller } = makeController();
    setFolders(['/a', '/b']);
    const fired: string[] = [];
    controller.onActiveFolderChanged((p) => fired.push(p));

    controller.initActiveFolderPath('/b');

    expect(controller.activeFolderPath).toBe('/b');
    expect(fired).toEqual(['/b']);
    expect(FakeTransport.instances).toHaveLength(0); // no transport started
  });

  it('initActiveFolderPath ignores a folder not in the workspace', () => {
    const { controller } = makeController();
    setFolders(['/a', '/b']);
    const fired: string[] = [];
    controller.onActiveFolderChanged((p) => fired.push(p));

    controller.initActiveFolderPath('/nope');

    expect(fired).toEqual([]);
    expect(controller.activeFolderPath).toBe('/a'); // falls back to first folder
  });

  it('setActiveFolderPath ignores an unknown folder', async () => {
    const { controller } = makeController();
    setFolders(['/a', '/b']);
    const fired: string[] = [];
    controller.onActiveFolderChanged((p) => fired.push(p));

    await controller.setActiveFolderPath('/zzz');

    expect(fired).toEqual([]);
  });

  it('setActiveFolderPath is a no-op when the folder is unchanged', async () => {
    const { controller } = makeController();
    setFolders(['/a', '/b']);
    controller.initActiveFolderPath('/b');
    const fired: string[] = [];
    controller.onActiveFolderChanged((p) => fired.push(p));

    await controller.setActiveFolderPath('/b');

    expect(fired).toEqual([]); // already active — no event
  });

  it('setActiveFolderPath fires the change event without a runnable pi status', async () => {
    const { controller } = makeController();
    setFolders(['/a', '/b']);
    const fired: string[] = [];
    controller.onActiveFolderChanged((p) => fired.push(p));

    await controller.setActiveFolderPath('/b'); // no piStatus → no restart

    expect(fired).toEqual(['/b']);
    expect(FakeTransport.instances).toHaveLength(0);
  });

  it('activeFolderPath self-heals when the active folder is removed from the workspace', () => {
    const { controller } = makeController();
    setFolders(['/a', '/b']);
    controller.initActiveFolderPath('/b');
    expect(controller.activeFolderPath).toBe('/b');

    setFolders(['/a']); // /b gone
    expect(controller.activeFolderPath).toBe('/a'); // falls back to first folder
  });
});

// ─── forceRestart guards ────────────────────────────────────────────────────

describe('AgentController.forceRestart', () => {
  it('does not spawn when pi is not found', async () => {
    const { controller } = makeController();
    setFolders(['/a']);
    await controller.forceRestart({ kind: 'not-found' } as unknown as PiStatus);
    expect(FakeTransport.instances).toHaveLength(0);
  });

  it('does nothing once the controller is disposed', async () => {
    const { controller } = makeController();
    setFolders(['/a']);
    controller.dispose();
    await controller.forceRestart(FOUND);
    expect(FakeTransport.instances).toHaveLength(0);
  });

  it('tears down the old transport and spawns a fresh one', async () => {
    const { controller } = makeController();
    setFolders(['/a']);
    await controller.start(FOUND);
    const first = FakeTransport.instances[0];

    await controller.forceRestart(FOUND);

    expect(first.disposed).toBe(true);
    expect(FakeTransport.instances).toHaveLength(2);
    expect(FakeTransport.instances[1].isRunning).toBe(true);
  });
});

// ─── _serializedStart serialization ─────────────────────────────────────────

describe('AgentController start serialization', () => {
  it('never runs two transport starts concurrently', async () => {
    const { controller } = makeController();
    FakeTransport.startDelayMs = 10; // make starts overlap in wall-clock time
    setFolders(['/a', '/b']);

    // Fire three start/restart operations without awaiting between them.
    const p1 = controller.start(FOUND);
    const p2 = controller.setActiveFolderPath('/b', FOUND);
    const p3 = controller.setActiveFolderPath('/a', FOUND);
    await Promise.all([p1, p2, p3]);

    // Serialized: at no point were two starts in flight at once.
    expect(FakeTransport.maxConcurrentStarts).toBe(1);
    // Each restart constructed its own transport; only the last stays running.
    expect(FakeTransport.instances.length).toBeGreaterThanOrEqual(2);
    const running = FakeTransport.instances.filter((t) => t.isRunning && !t.disposed);
    expect(running).toHaveLength(1);
  });
});

// ─── active-folder watcher ──────────────────────────────────────────────────

describe('AgentController active-folder watcher', () => {
  it('restarts pi in the next folder when the active folder is removed', async () => {
    const { controller } = makeController();
    setFolders(['/a', '/b']);
    controller.initActiveFolderPath('/b');
    await controller.start(FOUND);
    expect(FakeTransport.instances[0].cwd).toBe('/b');

    const fired: string[] = [];
    controller.onActiveFolderChanged((p) => fired.push(p));

    // Remove /b — workspace now only has /a.
    setFolders(['/a']);
    fireFoldersChanged(['/b']);
    await tick();

    expect(fired).toEqual(['/a']);
    expect(FakeTransport.instances).toHaveLength(2);
    expect(FakeTransport.instances[1].cwd).toBe('/a');
    expect(FakeTransport.instances[1].isRunning).toBe(true);
  });

  it('does not restart when an unrelated folder is removed', async () => {
    const { controller } = makeController();
    setFolders(['/a', '/b', '/c']); // active = first folder (/a) by default
    await controller.start(FOUND);
    expect(FakeTransport.instances).toHaveLength(1);

    setFolders(['/a', '/b']); // remove /c (not the active cwd)
    fireFoldersChanged(['/c']);
    await tick();

    expect(FakeTransport.instances).toHaveLength(1); // no restart
  });

  it('tears down pi and reports no workspace when the last folder is removed', async () => {
    const { controller, provider } = makeController();
    setFolders(['/a']);
    await controller.start(FOUND);
    const transport = FakeTransport.instances[0];

    setFolders([]); // all folders gone
    fireFoldersChanged(['/a']);
    await tick();

    expect(transport.disposed).toBe(true);
    expect(provider.postAgentStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ running: false }),
    );
  });
});
