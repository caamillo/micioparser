import { Elysia, sse } from 'elysia'
import { ScrapingExecution } from "../src/scrape.js"
import log from '../src/log.js'

const defaultOpt = { 
    context_usage: 'multi-context',
    concurrency: 1 
}

let execution = ScrapingExecution.withOptions(defaultOpt) 

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
    .get('/setup/:connector/:concurrency', async ({ params: { connector, concurrency } }) => {
        const conc = parseInt(concurrency)
        if (isNaN(conc) || conc < 1) {
            return { success: false, error: "Invalid concurrency value." }
        }

        try {
            await execution.dispose() 
            
            const drivers = Array(conc).fill(null).map(() => [connector, 'chromium'])
            await execution.withDrivers(drivers)
            execution.addOption({ concurrency: conc })
            
            return { 
                success: true, 
                message: `${conc} driver(s) built for ${connector}. Concurrency: ${conc}.`
            }
        } catch (error) {
            return { 
                success: false, 
                error: `Setup failed: ${error.message}` 
            }
        }
    })

    .get('/search/:title', async function* (ctx) {
        const { title } = ctx.params
        const { query } = ctx
        
        if (!title) {
          ctx.status = 400
          return { success: false, error: 'Please define a title.' }
        }

        const queue = createAsyncQueue()
        const jobExecution = execution.copy()

        // Set callback to stream results
        jobExecution.opt.onItem = item => queue.push(item)
        
        // Start search in background
        ;(async () => {
            try {
                console.log(`[SEARCH] Starting search for: ${title}`)
                
                const results = await jobExecution.search(
                    title, 
                    query.connector || '*', 
                    { sequential: query.sequential === 'true' }
                )
                
                console.log(`[SEARCH] Completed. Found ${results.length} result sets`)
                queue.push({ event: 'end', data: { success: true, resultCount: results.length } })
                
            } catch (error) {
                console.error(`[SEARCH] Error:`, error.message)
                queue.push({ 
                    event: 'error', 
                    data: { 
                        success: false, 
                        error: error.message 
                    } 
                })
            } finally {
                queue.close()
            }
        })()

        // Stream results via SSE
        try {
            for await (const item of queue) {
                if (!item) continue
                
                const { event = 'message', data = {} } = item
                
                // Only send actual data or status messages
                if (data.item || event === 'end' || event === 'error') {
                    yield sse({ event, data })
                }
                
                if (event === 'end' || event === 'error') break
            }
        } catch (streamError) {
            console.error('[SEARCH] Stream error:', streamError)
            yield sse({ 
                event: 'error', 
                data: { 
                    success: false, 
                    error: 'Stream interrupted: ' + streamError.message 
                } 
            })
        }
    })

    .get('/scrape/:method/:mode/:title', async function* ({ params, query }) { 
        const { method, mode, title } = params
        
        console.log(`[SCRAPE] Starting: ${title} (${method}/${mode})`)
        
        // Search for the title first
        let searchResults
        try {
            searchResults = await execution.search(title, query.connector || '*', { sequential: true })
        } catch (error) {
            yield sse({ 
                event: 'error', 
                data: { 
                    success: false, 
                    error: `Search failed: ${error.message}` 
                } 
            })
            return
        }

        const validResults = searchResults.filter(r => r.results && r.results.length > 0)

        if (!validResults.length) {
            yield sse({ 
                event: 'error', 
                data: { 
                    success: false, 
                    error: `No results found for "${title}"` 
                } 
            })
            return
        }
        
        const results = validResults.find(r => r.connector === 'mangaworld') || validResults[0]
        const result = results.results?.[0]
        const driver = results.connector
        const target = result?.link
        
        if (!target) {
            yield sse({ 
                event: 'error', 
                data: { 
                    success: false, 
                    error: 'No valid link found in search results' 
                } 
            })
            return
        }
        
        // Initialize driver for scraping
        try {
            await execution.withDrivers([[driver, 'chromium']])
        } catch (error) {
            yield sse({ 
                event: 'error', 
                data: { 
                    success: false, 
                    error: `Driver initialization failed: ${error.message}` 
                } 
            })
            return
        }
        
        const queue = createAsyncQueue()
        const jobExecution = execution.copy()
        jobExecution.opt.onItem = item => queue.push(item)

        // Start scraping
        (async () => {
            try {
                console.log(`[SCRAPE] Processing: ${result.title}`)
                
                await jobExecution.process(method, mode, { 
                    target, 
                    title: result.title 
                })
                
                console.log(`[SCRAPE] Completed: ${result.title}`)
                queue.push({ event: 'end', data: { success: true } })
                
            } catch (error) {
                console.error(`[SCRAPE] Error:`, error.message)
                queue.push({ 
                    event: 'error', 
                    data: { 
                        success: false, 
                        error: error.message 
                    } 
                })
            } finally {
                queue.close()
            }
        })()

        // Stream results
        for await (const item of queue) {
            if (!item) continue
            
            const { event = 'message', data = {} } = item
            
            if (data.item || event === 'end' || event === 'error') {
                yield sse({ event, data })
            }
            
            if (event === 'end' || event === 'error') break
        }
    })
    
    .listen(3001, ({ hostname, port }) => {
        log.info(`API running at http://${hostname}:${port}`)
    })