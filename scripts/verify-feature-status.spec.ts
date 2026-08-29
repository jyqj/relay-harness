import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { markdownLinkTargets } from './verify-feature-status.mjs'

describe('feature-status Markdown link projection', () => {
  it('matches prose links, images, and definitions while excluding code and HTML examples', () => {
    const source = [
      '[real](docs/real.md)',
      '![image](assets/image.png)',
      '[guide]: docs/guide.md "Guide"',
      '`[inline](phantom.md)`',
      '``[wide inline](phantom-wide.md)``',
      '```markdown',
      '[fenced](phantom-fenced.md)',
      '```',
      '~~~md',
      '[tilde fenced](phantom-tilde.md)',
      '~~~',
      '    [indented](phantom-indent.md)',
      '<!-- [commented](phantom-comment.md) -->',
      '<pre>',
      '[preformatted](phantom-pre.md)',
      '</pre>',
      '',
      '<div>',
      '[html block](phantom-html.md)',
      '</div>',
      '',
      '<span>[inline html prose](docs/inline-html.md)</span>',
      '<code>[inline html code](phantom-code.md)</code>',
    ].join('\n')

    expect(markdownLinkTargets(source)).toEqual([
      'docs/real.md',
      'assets/image.png',
      'docs/inline-html.md',
      'docs/guide.md',
    ])
  })

  it('does not promote the translation guide pair-shape examples into repository links', async () => {
    const source = await readFile('docs/i18n/README.md', 'utf8')
    expect(markdownLinkTargets(source)).not.toContain('foo.md')
    expect(markdownLinkTargets(source)).not.toContain('foo.zh.md')
  })
})
