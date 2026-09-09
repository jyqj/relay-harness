// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { ContextInspectorAction } from '../src/client/ContextInspectorAction.tsx'

afterEach(() => {
  cleanup()
})

const projection={ omittedTraces:0,traces:[{ seq:9,turn:2,step:1,admittedContributions:1,rejectedContributions:1,evidenceCount:1,contributions:[{ contributorId:'code-context',messageId:'m1',admitted:true,messageEventSeqs:[8],linkedMessages:[{ seq:8,messageId:'m1',sourceKind:'context',preview:'hydrated source' }],evidence:[{ evidenceId:'ev1',resource:{ sourceId:'code-index',key:'src/a.ts',revision:'h1' },truncated:false,freshness:'current',verification:'verified',whyUsed:['semantic recall'] }],coverage:{ searched:['src'],notSearched:['vendor'],rationale:'bounded',completeness:'bounded' } },{ contributorId:'memory',messageId:'m2',admitted:false,messageEventSeqs:[],linkedMessages:[],evidence:[] }] }] }
const labels:Record<string,string>={ open:'Inspect',title:'Context Inspector',empty:'empty',omitted:'omitted {count}',step:'Turn {turn} / Step {step}',summary:'{contributors} contributions · {evidence} evidence · {rejected} rejected',admitted:'Model-admitted',rejected:'Rejected or rewritten',evidence:'Evidence',noEvidence:'No evidence records',coverage:'Retrieval coverage',searched:'Searched',notSearched:'Not searched',linked:'Linked user/message',noLink:'No linked user/message',why:'Why used',close:'Close',badge:'Context {count}',tracePrepared:'context/prepared #{seq}',truncated:'truncated' }
const view=()=>{
  const props={ useProjection:()=>projection, t:(key:string)=>labels[key]??key } as unknown as Parameters<typeof ContextInspectorAction>[0]
  render(<ContextInspectorAction {...props}/>)
}
describe('ContextInspectorAction',()=>{it('renders durable links, rejected contribution, provenance and coverage',()=>{view();fireEvent.click(screen.getByRole('button',{ name:'Inspect' }));expect(screen.getByText('Turn 2 / Step 1')).toBeTruthy();expect(screen.getByText(/hydrated source/)).toBeTruthy();expect(screen.getByText('src/a.ts @ h1')).toBeTruthy();expect(screen.getByText(/semantic recall/)).toBeTruthy();expect(screen.getByText('Rejected or rewritten')).toBeTruthy();expect(screen.getByText(/vendor/)).toBeTruthy()})
  it('routes the badge and trace label through the dictionary',()=>{view();expect(screen.getByText('Context 1')).toBeTruthy();fireEvent.click(screen.getByRole('button',{ name:'Inspect' }));expect(screen.getByText('context/prepared #9')).toBeTruthy()})
  it('renders the truncated evidence pill from the dictionary',()=>{const trace=projection.traces[0]!;const baseContribution=trace.contributions[0]!;const truncated={ omittedTraces:0,traces:[{ ...trace,contributions:[{ ...baseContribution,evidence:[{ ...baseContribution.evidence[0]!,truncated:true }] }] }] };render(<ContextInspectorAction {...({ useProjection:()=>truncated,t:(key:string)=>labels[key]??key } as unknown as Parameters<typeof ContextInspectorAction>[0])}/>);fireEvent.click(screen.getByRole('button',{ name:'Inspect' }));expect(screen.getByText(labels.truncated!)).toBeTruthy()})})
