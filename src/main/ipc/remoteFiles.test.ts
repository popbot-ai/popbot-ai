import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, shell: { showItemInFolder: () => undefined } }));
vi.mock('../persistence/hosts', () => ({ getHost: () => null }));
vi.mock('../diagLog', () => ({ dlog: () => undefined }));

const { hostPathFor } = await import('./remoteFiles');

describe('host file links', () => {
  it('resolves a relative path against the chat folder on a Windows host', () => {
    expect(hostPathFor('src/app.ts:42', 'C:\\work\\repo')).toEqual({ path: 'C:\\work\\repo\\src\\app.ts' });
    expect(hostPathFor('./out/build.log', 'C:\\work\\repo\\')).toEqual({ path: 'C:\\work\\repo\\out\\build.log' });
  });

  it('resolves against a POSIX host folder, dropping #L anchors', () => {
    expect(hostPathFor('src/app.ts#L10-L20', '/home/ben/repo')).toEqual({ path: '/home/ben/repo/src/app.ts' });
  });

  it('keeps absolute paths and file:// URLs as the host wrote them', () => {
    expect(hostPathFor('C:\\Users\\ben\\out.zip', 'C:\\work')).toEqual({ path: 'C:\\Users\\ben\\out.zip' });
    expect(hostPathFor('file:///C:/Users/ben/my%20file.txt', null)).toEqual({ path: 'C:/Users/ben/my file.txt' });
    expect(hostPathFor('/var/log/x.log:3', null)).toEqual({ path: '/var/log/x.log' });
  });

  it('needs the chat to have started for a relative path', () => {
    expect(hostPathFor('a.txt', null)).toHaveProperty('error');
  });
});
