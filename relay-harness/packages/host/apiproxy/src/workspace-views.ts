/**
 * Workspace wire projections and the creation/mutation conflict vocabulary the
 * workspace.* rows narrow at the boundary.
 * @module @relay-harness/rlh-host-apiproxy/workspace-views
 */

import type { SessionId } from '@relay-harness/rlh-session'
import { workspaceRecord } from '@relay-harness/rlh-workspace'
import type { Workspace, WorkspaceRecord } from '@relay-harness/rlh-workspace'
import {
  InvalidPresetIdError, PresetExistsError, PresetNotWritableError, UnknownPresetError,
} from '@relay-harness/rlh-agent-presets'
import type { WorkspaceId, WorkspaceView } from './api/index.ts'
import type { RpcError, RpcRequest, RpcResponse } from './api/rpc.ts'
import { err } from './rpc-envelope.ts'

/**
 * Map one authoring/roster failure onto its wire code.
 * @param agentPreset - the preset the failing operation targeted.
 * @param error - the thrown authoring/roster failure.
 * @returns the wire error with its code and preset details.
 */
export function presetError(agentPreset: string, error: unknown): RpcError {
  if (error instanceof UnknownPresetError) {
    return {
      code: 'agent-preset-not-found',
      message: error.message,
      details: { agentPreset: error.presetId, available: [...error.available] },
    }
  }
  if (error instanceof PresetNotWritableError) {
    return { code: 'agent-preset-read-only', message: error.message, details: { agentPreset, reason: error.message } }
  }
  if (error instanceof InvalidPresetIdError || error instanceof PresetExistsError) {
    return { code: 'agent-preset-invalid', message: error.message, details: { agentPreset, reason: error.message } }
  }
  return { code: 'internal', message: `agent preset "${agentPreset}": ${String(error)}`, details: {} }
}

/** A session cannot be adopted under a preset that differs from its fixed creation-time preset. */
export class AgentPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
    readonly existingPreset: string | undefined,
  ) {
    super(
      existingPreset === undefined
        ? `session "${sessionId}" records no agent preset, so it cannot be adopted under one; `
        + 'a deployment composing no roster records none on any session — '
        : `session "${sessionId}" already runs agent preset ${JSON.stringify(existingPreset)}; `
      + `requested ${JSON.stringify(requestedPreset)}. A session's preset is fixed at creation.`,
    )
  }
}

/** Requested identity already belongs to a session with another project cwd. */
export class SessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      `session "${sessionId}" already exists with cwd ${JSON.stringify(existingCwd)}; `
      + `requested ${JSON.stringify(requestedCwd)}`,
    )
  }
}

/** An explicit Host naming operation would duplicate another Workspace title. */
export class WorkspaceNameConflictError extends Error {
  constructor(readonly workspaceName: string) {
    super(`workspace name '${workspaceName}' is already in use`)
    this.name = 'WorkspaceNameConflictError'
  }
}

/**
 * Shared workspace-not-found error response of the workspace.* mutation rows.
 * @param request - the request whose rpcId the response echoes.
 * @param workspaceId - the unresolved workspace id, named in the message.
 * @returns the workspace-not-found error response.
 */
export function workspaceNotFound<T>(request: RpcRequest<unknown>, workspaceId: string): RpcResponse<T> {
  return err(request, {
    code: 'workspace-not-found',
    message: `workspace "${workspaceId}" not found`,
    details: { workspaceId },
  })
}

/**
 * Wire projection of one workspace entity (the workspace.* value row).
 * @param workspace - the workspace entity to project.
 * @returns the wire row, with the session-id list copied.
 */
export function workspaceView(workspace: Workspace): WorkspaceView {
  return {
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: [...workspace.sessionIds],
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  }
}

/**
 * Wire projection of the durable record carried by `domain/changed`.
 * @param workspaceId - the id of the changed workspace.
 * @param value - the durable record payload carried by the event.
 * @returns the wire projection of the parsed record.
 */
export function changedWorkspaceView(workspaceId: string, value: unknown): WorkspaceView {
  const record: WorkspaceRecord = workspaceRecord.parse(value)
  return {
    workspaceId: workspaceId as WorkspaceId,
    path: record.path,
    title: record.title,
    sessionIds: [...record.sessionIds],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}
