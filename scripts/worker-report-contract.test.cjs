const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = path.join(root, '.claude/commands/ccbook');
const bundle = path.join(root, 'src-tauri/resources/claude-bundle');

for (const name of ['plantocodex', 'plantocc', 'planreview', 'parallel', 'launch-task']) {
  test(`${name}: packaged command matches the copy-hook source`, () => {
    assert.equal(fs.readFileSync(path.join(source, `${name}.md`), 'utf8'),
      fs.readFileSync(path.join(bundle, '.claude/commands/ccbook', `${name}.md`), 'utf8'));
  });
}

for (const [directory, names] of [
  [source, ['plantocodex', 'plantocc', 'planreview', 'parallel', 'launch-task']],
  [path.join(bundle, 'default-skills'), ['plantocodex', 'plantocc', 'planreview', 'guided-team', 'parallel-advanced', 'dispatch-task', 'launch-task', 'dsh-orchestrate-worker']],
]) {
  for (const name of names) {
    test(`${path.relative(root, directory)}/${name}: completion persists once and manual report is recovery only`, () => {
      const text = fs.readFileSync(path.join(directory, `${name}.md`), 'utf8');
      assert.match(text, /update_task_binding/);
      assert.match(text, /自动(?:向 leader )?上报|自动上报/);
      assert.match(text, /确认投递失败|明确投递失败/);
      assert.doesNotMatch(text, /2\. 再 PTY 上报 leader|后 report_to_leader\(|2\. report_to_leader\(/);
      assert.doesNotMatch(text, /Idle\/WaitingInput/);
    });
  }
}
