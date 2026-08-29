import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import CodeIndex from '@relay-harness/rlh-code-index'
import type { CodeIndexManagementStatus, GraphExploreResult, HydrateChunksResult, RefreshOptions, RefreshSummary, SearchRequest, SearchResult } from '@relay-harness/rlh-code-index'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import { CodeIndexCenterGateway } from '../src/index.ts'

const epochs={ indexEpoch:1,evidenceEpoch:0,embeddingEpoch:2 }
class FakeIndex extends CodeIndex {
  refreshes:RefreshOptions[]=[]
  override forWorkspace(workspaceRoot:string) {
    return Promise.resolve({
      workspaceRoot,
      status:()=>this.status(),
      managementStatus:()=>this.managementStatus(),
      reconcile:()=>this.reconcile(),
      refresh:(options?:RefreshOptions)=>this.refresh(options),
      search:(request:SearchRequest)=>this.search(request),
      hydrateChunks:()=>this.hydrateChunks(),
      exploreGraph:()=>this.exploreGraph(),
    })
  }
  async status(){return { indexedFileCount:2,tier:'tiny' as const,epochs,degraded:false }}
  override async managementStatus():Promise<CodeIndexManagementStatus>{return { ...await this.status(),chunkCount:3,generations:[] }}
  async refresh(options?:RefreshOptions):Promise<RefreshSummary>{this.refreshes.push(options??{});return { reason:options?.reason??'manual',changedFiles:0,removedFiles:0,chunksWritten:0,durationMs:1,epochsAfter:epochs }}
  override async reconcile(){return this.managementStatus()}
  async search(request:SearchRequest):Promise<SearchResult>{return { query:request.query,tier:'tiny',hits:[],candidateCount:0,epochs,truncated:false,degraded:false,readErrors:[] }}
  async hydrateChunks():Promise<HydrateChunksResult>{return { chunks:[],rejected:[],epochs }}
  async exploreGraph():Promise<GraphExploreResult>{throw new Error('unused')}
}

describe('CodeIndexCenterGateway',()=>{
  it('resolves the Host-owned Session workspace, enforces confirmation, and bounds search debug',async()=>{
    const ctx=new Context();await ctx.plugin(SessionStore);const index=new FakeIndex(ctx);const gateway=new CodeIndexCenterGateway(ctx)
    ctx.sessions.create(SessionId('a'),{ meta:{ cwd:'/workspace/a' } })
    await expect(gateway.rebuild({ sessionId:'a',confirmation:'no' })).rejects.toThrow(/REBUILD/)
    await gateway.rebuild({ sessionId:'a',confirmation:'REBUILD' });expect(index.refreshes.at(-1)).toMatchObject({ forceRebuild:true })
    expect(await gateway.status({ sessionId:'a' })).toMatchObject({ workspaceRoot:'/workspace/a',chunkCount:3 })
    expect((await gateway.search({ sessionId:'a',query:'needle',topK:20 })).executedTopK).toBe(20)
    await expect(gateway.search({ sessionId:'a',query:'x',topK:21 })).rejects.toThrow(/1\.\.20/)
    await expect(gateway.status({ sessionId:'missing' })).rejects.toThrow(/lookup policy rejected/)
  })
})
