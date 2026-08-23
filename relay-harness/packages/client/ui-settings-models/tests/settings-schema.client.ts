import { Context } from '@relay-harness/cordis'
import { SettingsSchemaService } from '@relay-harness/rlh-client-ui-settings/src/client/schema.ts'
import { createSettingsSchemaOperations } from '../src/client/schema-operations.ts'

/** Stateless schema operations used by settings-model component fixtures. */
export const settingsSchema = createSettingsSchemaOperations(new SettingsSchemaService(new Context()))
