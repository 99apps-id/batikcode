import fse from '@zokugun/fs-extra-plus/sync';
import { describe, expect, it } from 'vitest';

const readScript = (name: string): string => fse.readFile(`./src/scripts/${name}`, 'utf8').value!;
const readServerSetup = (): string => fse.readFile('./src/serverSetup.ts', 'utf8').value!;

describe('remote Agent Host server setup', () => {
  it('starts Unix servers with a collision-safe Agent Host socket', () => {
    const script = readScript('server-setup.sh');

    expect(script).toContain('AGENT_HOST_SOCKET="$TMP_DIR/batikcode-agent-host-$UID-${DISTRO_COMMIT:0:12}.sock"');
    expect(script).toContain('--agent-host-path="$AGENT_HOST_SOCKET"');
    expect(script).toContain('grep -Fq -- "--agent-host-path=$AGENT_HOST_SOCKET"');
    expect(script).toContain('rm -f "$AGENT_HOST_SOCKET"');
    expect(script).toContain('[[ -n $LISTENING_ON && -S $AGENT_HOST_SOCKET ]]');
    expect(script).toContain('chmod +x "$SERVER_SCRIPT" "$SERVER_DIR/node"');
    expect(script).toContain('find "$SERVER_DIR/bin" -type f -exec chmod +x {} \\;');
    expect(script).toContain('$SERVER_DIR/node_modules/@vscode/ripgrep-universal/bin');
    expect(script).toContain('github.copilot-chat/node_modules/@vscode/ripgrep-universal/bin');
    expect(script).toContain('$HOME/batikcode-provider-hub.tar.gz');
    expect(script).toContain('Updating BatikCode Provider Hub');
  });

  it('starts Windows servers with a named-pipe Agent Host endpoint', () => {
    const script = readScript('server-setup.ps1');

    expect(script).toContain('$AGENT_HOST_PIPE="\\\\.\\pipe\\batikcode-agent-host-');
    expect(script).toContain('--agent-host-path=$AGENT_HOST_PIPE');
    expect(script).toContain('$SERVER_PROCESS.CommandLine -NotLike "*--agent-host-path=$AGENT_HOST_PIPE*"');
    expect(script).toContain('$env:USERPROFILE\\batikcode-provider-hub.tar.gz');
  });

  it('reuses a matching server build already installed on the remote host', () => {
    const source = readServerSetup();

    expect(source).toContain('[ -f "${escapedRemoteServerScript}" ] && echo "exists"');
    expect(source).toContain('Matching local server build is already installed');
    expect(source).toContain('skipping upload');
  });
});
