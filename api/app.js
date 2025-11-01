import { Elysia, sse } from 'elysia'
import { ScrapingExecution } from "../src/scrape.js"

const defaultOpt = { context_usage: 'single-context', concurrency: 2 } // fix concurrency wont work

let execution = new ScrapingExecution(defaultOpt)
// const resetExecution = () => execution = new ScrapingExecution(defaultOpt)

function createAsyncQueue() {
  const buf = []
  let waiter = null
  let closed = false

  return {
    push(item) {
      if (!waiter) return buf.push(item)
      waiter({ value: item, done: false })
      waiter = null
    },
    close() {
      closed = true
      if (!waiter) return
      waiter({ value: undefined, done: true })
      waiter = null
    },
    async next() {
      if (buf.length) return { value: buf.shift(), done: false }
      if (closed) return { value: undefined, done: true }
      return await new Promise(res => waiter = res)
    },
    [Symbol.asyncIterator]() { return this }
  }
}

new Elysia()
    .get('/search/:title', async function* (ctx) {
        const { title } = ctx.params
        const { query } = ctx
        if (!title) {
          ctx.status = 400
          return { success: false, error: 'Please define a title.' }
        }

        let { driver = '*', stream = '1', sequential = 'false' } = query
        const isStream = stream === '1' || stream === 'true'

        if (!isStream) {
          // Get directly the result
          const res = await execution.search(title, driver, { sequential: sequential !== 'false' })
          return res
        }

        // Streaming path
        const queue = createAsyncQueue()
        const ac = new AbortController()
        const signal = ac.signal

        if (ctx.request?.signal) {
          ctx.request.signal.addEventListener('abort', () => ac.abort())
        }

        // Search in background, push results into queue via onProgress
        ;(async () => {
        try {
            await execution.search(title, driver, {
              sequential: sequential !== 'false',
              browser: 'chromium',
              signal,
              onProgress: payload => queue.push({ event: 'result', data: payload })
            })
            queue.push({ event: 'end', data: {} })
        } catch (err) {
          if (err?.name !== 'AbortError')
            queue.push({ event: 'error', data: { message: err.message } })
        } finally {
            queue.close()
        }
        })()

        // yield SSE chunks as they arrive
        for await (const item of queue) {
          if (!item) continue
          const { event = 'message', data = {} } = item
          yield sse({ event, data })
          if (event === 'end') break
        }
    })

    // .post('/scrape/:method/:mode', async ({ params: { method, mode }, body }) => {
    //     const { target } = body
    //     if (!target) return { success: false, error: 'Please define a target' }

    //     const { drivers } = body
    //     if (!drivers.length) return { success: false, error: 'Please define drivers e.g. [ [ "mangaworld", "chromium" ] ]' }

    //     resetExecution()
    //     execution = execution.withDrivers(drivers)
    //     return await execution.process(method, mode, body)
    // })

    .get('/scrape/:method/:mode/:title', async ({ params: { method, mode, title } }) => {
        let results = await execution.search(title, '*', { sequential: false })
        if (!results.length) return { success: false, error: `Did not found anything related to ${title}` }
        
        const tempFilterPreference = results.filter(result => result.connector === 'mangaworld')
        if (tempFilterPreference.length) results = tempFilterPreference[0]
        else results = results[0]
        
        const result = results.results?.[0]
        const driver = results.connector
        const browser = "chromium"
        const target = result?.link
        
        await execution.withDrivers([[ driver, browser ]])
        
        return await execution.process(method, mode, { target, title: result.title })
    })
    .listen(3001, () => console.log('API Started at http://localhost:3001'))
