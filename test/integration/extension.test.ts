/**
 * VS Code integration tests (run in a real Extension Development Host).
 *
 * These verify the things unit tests can't: that the extension is discoverable,
 * activates cleanly, and contributes the commands / views / configuration the
 * manifest declares. They are intentionally hermetic — they do NOT drive a live
 * `pi` session (the locator simply reports pi missing on a clean CI runner), so
 * they stay stable without pi installed. The agent/diff/prompt paths are covered
 * by the host vitest suites.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'sqowe.wingman';

suite('Sqowe Wingman — activation & contributions', () => {
  test('extension is discoverable in the host', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} should be installed in the test host`);
  });

  test('extension activates without throwing', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test('registers every sqoweWingman command', async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    await ext.activate();

    const all = await vscode.commands.getCommands(true);
    const expected = [
      'sqoweWingman.focusChat',
      'sqoweWingman.newSession',
      'sqoweWingman.switchSession',
      'sqoweWingman.refreshSessions',
      'sqoweWingman.setModel',
      'sqoweWingman.cycleModel',
      'sqoweWingman.compactSession',
      'sqoweWingman.forkSession',
      'sqoweWingman.cloneSession',
      'sqoweWingman.exportHtml',
      'sqoweWingman.setThinkingLevel',
      'sqoweWingman.cycleThinkingLevel',
      'sqoweWingman.showStats',
      'sqoweWingman.selectFolder',
      'sqoweWingman.trustProject',
    ];
    for (const cmd of expected) {
      assert.ok(all.includes(cmd), `command not registered: ${cmd}`);
    }
  });

  test('contributes the chat + sessions views', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const views = ext.packageJSON.contributes?.views?.['sqowe-wingman'] ?? [];
    const ids = views.map((v: { id: string }) => v.id);
    assert.ok(ids.includes('sqoweWingman.chat'), 'chat view not contributed');
    assert.ok(ids.includes('sqoweWingman.sessions'), 'sessions view not contributed');
  });

  test('contributes the piExecutablePath setting', () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext);
    const props = ext.packageJSON.contributes?.configuration?.properties ?? {};
    assert.ok(
      Object.prototype.hasOwnProperty.call(props, 'sqoweWingman.piExecutablePath'),
      'sqoweWingman.piExecutablePath setting not contributed',
    );
  });
});
