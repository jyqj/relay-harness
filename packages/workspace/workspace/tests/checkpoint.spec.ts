import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceCheckpointId, WorkspaceId } from '../src/index.ts'
import {
  createWorkspaceCheckpoint,
  rewindWorkspaceCheckpoint,
} from '../src/checkpoint.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace(): { root: string; id: ReturnType<typeof WorkspaceId> } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-workspace-checkpoint-'))
  roots.push(root)
  return { root, id: WorkspaceId('workspace-1') }
}

function checkpointPath(root: string, workspaceId: string, checkpointId: string): string {
  const workspaceDir = createHash('sha256').update(workspaceId).digest('hex').slice(0, 32)
  const checkpointFile = createHash('sha256').update(checkpointId).digest('hex') + '.json'
  return join(root, '.dsh', 'rewind-checkpoints', workspaceDir, checkpointFile)
}

describe('workspace checkpoints', () => {
  it('restores present bytes and confirmed absence, then truncates the checkpoint timeline', async () => {
    const { root, id } = workspace()
    writeFileSync(join(root, 'present.bin'), Buffer.from([0, 1, 2, 255]), { mode: 0o640 })
    const first = await createWorkspaceCheckpoint(root, id, ['new.txt', 'present.bin', 'present.bin'])
    expect(first.paths).toEqual(['new.txt', 'present.bin'])
    expect(first.bytes).toBe(4)
    expect(readFileSync(join(root, '.dsh', 'rewind-checkpoints', '.gitignore'), 'utf8')).toBe('*\n')

    writeFileSync(join(root, 'present.bin'), 'changed')
    writeFileSync(join(root, 'new.txt'), 'created later')
    const second = await createWorkspaceCheckpoint(root, id, ['present.bin'])
    writeFileSync(join(root, 'present.bin'), 'changed again')

    await rewindWorkspaceCheckpoint(root, id, first.id)
    expect([...readFileSync(join(root, 'present.bin'))]).toEqual([0, 1, 2, 255])
    expect(lstatSync(join(root, 'present.bin')).mode & 0o777).toBe(0o640)
    expect(() => lstatSync(join(root, 'new.txt'))).toThrow(expect.objectContaining({ code: 'ENOENT' }))
    await expect(rewindWorkspaceCheckpoint(root, id, first.id)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(rewindWorkspaceCheckpoint(root, id, second.id)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects escapes, directories, symlink components, empty sets, and configured hard caps', async () => {
    const { root, id } = workspace()
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(root, 'target'), 'x')
    symlinkSync(join(root, 'target'), join(root, 'link'))
    await expect(createWorkspaceCheckpoint(root, id, [])).rejects.toThrow(/at least one path/)
    await expect(createWorkspaceCheckpoint(root, id, ['../escape'])).rejects.toThrow(/escapes/)
    await expect(createWorkspaceCheckpoint(root, id, [join(root, 'target')])).rejects.toThrow(/must be relative/)
    await expect(createWorkspaceCheckpoint(root, id, ['dir'])).rejects.toThrow(/not a regular file/)
    await expect(createWorkspaceCheckpoint(root, id, ['link'])).rejects.toThrow(/symlink path component/)
    await expect(createWorkspaceCheckpoint(
      root,
      id,
      Array.from({ length: 4097 }, (_, index) => `missing-${index}`),
    )).rejects.toThrow(/at most 4096 paths/)
    const huge = join(root, 'huge')
    writeFileSync(huge, '')
    truncateSync(huge, 64 * 1024 * 1024 + 1)
    await expect(createWorkspaceCheckpoint(root, id, ['huge'])).rejects.toThrow(/exceeds 67108864 bytes/)

    const firstLarge = join(root, 'large-a')
    const secondLarge = join(root, 'large-b')
    writeFileSync(firstLarge, Buffer.alloc(33 * 1024 * 1024))
    writeFileSync(secondLarge, Buffer.alloc(33 * 1024 * 1024))
    await expect(createWorkspaceCheckpoint(root, id, ['large-a', 'large-b']))
      .rejects.toThrow(/checkpoint exceeds 67108864 bytes/)

    mkdirSync(join(root, 'denied'))
    writeFileSync(join(root, 'denied', 'file'), 'x')
    chmodSync(join(root, 'denied'), 0o000)
    try {
      await expect(createWorkspaceCheckpoint(root, id, ['denied/file'])).rejects.toThrow()
    } finally {
      chmodSync(join(root, 'denied'), 0o700)
    }
  })

  it('rejects a path that becomes a symlink before rewind without changing siblings', async () => {
    const { root, id } = workspace()
    writeFileSync(join(root, 'a.txt'), 'a1')
    writeFileSync(join(root, 'b.txt'), 'b1')
    const checkpoint = await createWorkspaceCheckpoint(root, id, ['a.txt', 'b.txt'])
    writeFileSync(join(root, 'a.txt'), 'a2')
    rmSync(join(root, 'b.txt'))
    symlinkSync(join(root, 'a.txt'), join(root, 'b.txt'))

    await expect(rewindWorkspaceCheckpoint(root, id, checkpoint.id)).rejects.toThrow(/symlink path component/)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a2')
  })

  it('rolls back earlier applied paths when a later atomic write fails', async () => {
    const { root, id } = workspace()
    mkdirSync(join(root, 'locked'))
    writeFileSync(join(root, 'a.txt'), 'a1')
    writeFileSync(join(root, 'locked', 'b.txt'), 'b1')
    const checkpoint = await createWorkspaceCheckpoint(root, id, ['a.txt', 'locked/b.txt'])
    writeFileSync(join(root, 'a.txt'), 'a2')
    writeFileSync(join(root, 'locked', 'b.txt'), 'b2')
    chmodSync(join(root, 'locked'), 0o500)
    try {
      await expect(rewindWorkspaceCheckpoint(root, id, checkpoint.id)).rejects.toThrow()
    } finally {
      chmodSync(join(root, 'locked'), 0o700)
    }
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('a2')
    expect(readFileSync(join(root, 'locked', 'b.txt'), 'utf8')).toBe('b2')
  })

  it('fails closed on malformed, foreign, mismatched, and byte-inconsistent records', async () => {
    const { root, id } = workspace()
    writeFileSync(join(root, 'file'), 'value')
    const checkpoint = await createWorkspaceCheckpoint(root, id, ['file'])
    const path = checkpointPath(root, id, checkpoint.id)
    const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

    writeFileSync(path, 'not json')
    await expect(rewindWorkspaceCheckpoint(root, id, checkpoint.id)).rejects.toThrow(/not valid JSON/)
    writeFileSync(path, JSON.stringify({ ...original, workspaceId: 'foreign' }))
    await expect(rewindWorkspaceCheckpoint(root, id, checkpoint.id)).rejects.toThrow(/another workspace/)
    writeFileSync(path, JSON.stringify({ ...original, id: 'other' }))
    await expect(rewindWorkspaceCheckpoint(root, id, checkpoint.id)).rejects.toThrow(/id does not match/)
    const files = original.files as Array<Record<string, unknown>>
    writeFileSync(path, JSON.stringify({
      ...original,
      bytes: 999,
      files,
    }))
    await expect(rewindWorkspaceCheckpoint(root, id, checkpoint.id)).rejects.toThrow(/byte total is invalid/)
    await expect(rewindWorkspaceCheckpoint(root, id, WorkspaceCheckpointId('absent')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('strictly validates every record and snapshot field', async () => {
    const { root, id } = workspace()
    writeFileSync(join(root, 'file'), 'value')
    const checkpoint = await createWorkspaceCheckpoint(root, id, ['file'])
    const path = checkpointPath(root, id, checkpoint.id)
    const original = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const invalidRecords: Array<[unknown, RegExp]> = [
      [null, /record must be an object/],
      [{ ...original, files: Array.from({ length: 4097 }, () => ({ path: 'a', kind: 'absent' })) }, /file-count limit/],
      [{ ...original, files: [null] }, /invalid or duplicate path/],
      [{ ...original, files: [{ path: 'a', kind: 'absent' }, { path: 'a', kind: 'absent' }] }, /invalid or duplicate path/],
      [{ ...original, files: [{ path: '../escape', kind: 'absent' }] }, /invalid or duplicate path/],
      [{ ...original, files: [{ path: 'a', kind: 'file', content: 7, mode: 420, bytes: 1 }] }, /malformed file snapshot/],
      [{ ...original, files: [{ path: 'a', kind: 'file', content: '***', mode: 420, bytes: 1 }], bytes: 1 }, /do not match/],
    ]
    for (const [record, message] of invalidRecords) {
      writeFileSync(path, JSON.stringify(record))
      await expect(rewindWorkspaceCheckpoint(root, id, checkpoint.id)).rejects.toThrow(message)
    }
  })

  it('rejects deleting a directory for an absent snapshot', async () => {
    const { root, id } = workspace()
    const checkpoint = await createWorkspaceCheckpoint(root, id, ['later'])
    mkdirSync(join(root, 'later'))
    await expect(rewindWorkspaceCheckpoint(root, id, checkpoint.id)).rejects.toThrow(/not a regular file/)
  })

  it('rejects a non-file checkpoint-store ignore marker', async () => {
    const { root, id } = workspace()
    const marker = join(root, '.dsh', 'rewind-checkpoints', '.gitignore')
    mkdirSync(marker, { recursive: true })
    await expect(createWorkspaceCheckpoint(root, id, ['missing']))
      .rejects.toThrow(/\.gitignore is not a regular file/)
    rmSync(marker, { recursive: true })
    const target = join(root, 'ignore-target')
    writeFileSync(target, '*\n')
    symlinkSync(target, marker)
    await expect(createWorkspaceCheckpoint(root, id, ['missing']))
      .rejects.toThrow(/\.gitignore is not a regular file/)
    rmSync(marker)
    const storeRoot = join(root, '.dsh', 'rewind-checkpoints')
    chmodSync(storeRoot, 0o500)
    try {
      await expect(createWorkspaceCheckpoint(root, id, ['missing'])).rejects.toThrow()
    } finally {
      chmodSync(storeRoot, 0o700)
    }
  })

  it('retains older checkpoints and ignores unrelated or corrupt store entries', async () => {
    const { root, id } = workspace()
    writeFileSync(join(root, 'file'), 'v1')
    const first = await createWorkspaceCheckpoint(root, id, ['file'])
    await new Promise(resolve => setTimeout(resolve, 2))
    writeFileSync(join(root, 'file'), 'v2')
    const second = await createWorkspaceCheckpoint(root, id, ['file'])
    writeFileSync(join(root, 'file'), 'v3')
    const directory = join(root, '.dsh', 'rewind-checkpoints', createHash('sha256').update(id).digest('hex').slice(0, 32))
    mkdirSync(join(directory, 'nested'))
    writeFileSync(join(directory, 'note.txt'), 'ignore')
    writeFileSync(join(directory, 'corrupt.json'), 'not-json')

    await rewindWorkspaceCheckpoint(root, id, second.id)
    expect(readFileSync(join(root, 'file'), 'utf8')).toBe('v2')
    expect(readFileSync(checkpointPath(root, id, first.id), 'utf8')).toContain(first.id)
    expect(() => lstatSync(checkpointPath(root, id, second.id))).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  })
})
