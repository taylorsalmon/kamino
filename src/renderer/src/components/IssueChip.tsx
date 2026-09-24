import type { IssueLink } from '../../../shared/types'
import { LinearMark } from './LinearMark'

/**
 * The Linear issue a clone is tracking its work under, as a chip. The FIRST
 * issue is the one shown: it is the tracking issue the clone raised or picked
 * up; anything after it is a sub-issue for follow-ups. Click opens Linear.
 */
export function IssueChip(props: { issues: IssueLink[]; variant: 'pane' | 'card' }): React.JSX.Element | null {
  const issues = props.issues
  if (issues.length === 0) return null
  const main = issues[0]
  const all = issues.map((i) => (i.title ? `${i.key} — ${i.title}` : i.key)).join('\n')
  if (props.variant === 'card') {
    return (
      <span className="issue-chip" title={all}>
        <LinearMark /> {main.key}
        {issues.length > 1 && ` +${issues.length - 1}`}
      </span>
    )
  }
  return (
    <button
      className="pane-chip linear"
      title={`${all}\nclick to open in Linear`}
      onClick={() => window.fleet.openExternal(main.url)}
    >
      <LinearMark /> {main.key}
      {issues.length > 1 && ` +${issues.length - 1}`}
    </button>
  )
}
