import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import type { GenerateRequest } from '../llm/types.ts'
import { defaultSessionRoot, SessionStore } from '../session/store.ts'
import { SessionService } from '../session/service.ts'
import type { TitleAnswer } from '../session/title.ts'

export const name = 'session'

/** The model service as the title call reads it: looked up when a call starts, so a profile without one has none. */
interface TitleModel {
  generate?(request: GenerateRequest, signal?: AbortSignal): Promise<TitleAnswer>
}

/** The session plugin: the service class plus its own config schema. */
export default class SessionPlugin extends SessionService {
  static readonly Config = Schema.object({
    /** Where sessions live. Defaults to `$HEDDLE_HOME/sessions`. */
    root: Schema.string().default(defaultSessionRoot()),
  })

  constructor(ctx: Context, config: { root?: string } = {}) {
    /**
     * Every append is re-emitted on the context.
     *
     * This is the seam the Web UI listens on, and it is a Cordis event rather than a
     * callback the server registers, so a consumer is owned by its own fiber and is
     * released with it. DSH carries the equivalent as `session/event`.
     */
    super(ctx, config, {
      onEvent: (handle, event) => {
        ctx.emit('session/event', { session: handle.id, event })
      },
      /** Every title the store writes, through the same seam: the Web UI pushes it as `session/renamed` (#33). */
      onRenamed: (id, title) => {
        ctx.emit('session/renamed', { session: id, title })
      },
    })

    /**
     * DSH's automatic title (`dsh-session-title` with its first-prompt model provider, mounted in `dsh-base`): the store's
     * title coordinator asks the model service for a session's title on its first prompt, on the endpoint and model the
     * turn's own request used (`../session/title.ts`). The service is read **when a call starts** rather than injected,
     * so the session plugin still loads in a profile without a model, and such a profile keeps the plain first-message
     * name. Unloading this plugin abandons any call still running, as DSH's service teardown does.
     */
    const detach = this.store.titles.attach(
      (request, signal) => {
        const model = ctx.get('model') as TitleModel | undefined
        if (typeof model?.generate !== 'function') return Promise.reject(new Error('no model service is loaded'))
        return model.generate(request, signal)
      },
      { log: (message) => ctx.logger.debug(message) },
    )
    ctx.effect(() => detach)
  }
}

export { SessionStore }
